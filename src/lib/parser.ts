import type {
  ColumnMeta,
  DetectedType,
  DetectionAssumption,
  DetectionState,
  EncodingName,
  LogRow,
  ParseResult,
  ParseWarning,
  ParserMode
} from './types';
import { stripUtf8Bom } from './encoding';

const DELIMITERS = [',', ';', '\t', '|'];
const TIMESTAMP_PATTERNS: Array<{ name: string; pattern: RegExp; normalise: (value: string) => string }> = [
  {
    name: 'ISO-8601 or ISO-like datetime',
    pattern: /\b\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?\b/,
    normalise: (value) => value.replace(' ', 'T').replace(',', '.')
  },
  {
    name: 'Slash date datetime',
    pattern: /\b\d{4}\/\d{2}\/\d{2}[\sT]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?\b/,
    normalise: (value) => value.replaceAll('/', '-').replace(' ', 'T').replace(',', '.')
  },
  {
    name: 'European date datetime',
    pattern: /\b\d{2}\.\d{2}\.\d{4}[\sT]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?\b/,
    normalise: (value) => {
      const match = /^(\d{2})\.(\d{2})\.(\d{4})(.*)$/.exec(value);
      return match ? `${match[3]}-${match[2]}-${match[1]}${match[4].replace(' ', 'T').replace(',', '.')}` : value;
    }
  },
  {
    name: 'Unix syslog timestamp',
    pattern: /^\s*[A-Z][a-z]{2}\s+\d{1,2}\s\d{2}:\d{2}:\d{2}/,
    normalise: (value) => `${new Date().getFullYear()} ${value.trim()}`
  }
];

interface CsvRecord {
  fields: string[];
  startLine: number;
  endLine: number;
  raw: string;
  malformed?: boolean;
  notes: string[];
}

interface CsvParseInternal {
  records: CsvRecord[];
  warnings: ParseWarning[];
}

export interface ParseOptions {
  fileName: string;
  fileSize: number;
  encoding: EncodingName;
  encodingConfidence: number;
  encodingNotes: string[];
  encodingWarnings?: ParseWarning[];
  parserMode: ParserMode;
}

export function parseLogText(input: string, options: ParseOptions): ParseResult {
  const text = stripUtf8Bom(input);
  const warnings = [...(options.encodingWarnings ?? [])];
  const detectedType = detectFileType(text, options.fileName, options.parserMode);

  if (detectedType === 'csv') {
    return parseCsv(text, options, warnings);
  }

  return parseTxt(text, options, warnings, detectedType);
}

function detectFileType(text: string, fileName: string, parserMode: ParserMode): DetectedType {
  if (parserMode === 'csv') return 'csv';
  if (parserMode === 'txt') return 'txt';

  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.txt') || lower.endsWith('.log')) {
    const delimiter = detectDelimiter(text);
    if (delimiter.confidence > 0.82) return 'csv';
    return 'txt';
  }

  const delimiter = detectDelimiter(text);
  return delimiter.confidence > 0.72 ? 'csv' : 'txt';
}

function parseCsv(text: string, options: ParseOptions, inheritedWarnings: ParseWarning[]): ParseResult {
  const delimiterInfo = detectDelimiter(text);
  const delimiter = delimiterInfo.delimiter;
  const parsed = parseCsvRecords(text, delimiter);
  const warnings = [...inheritedWarnings, ...parsed.warnings];
  const headerInfo = detectHeader(parsed.records);
  const headers = headerInfo.hasHeader
    ? parsed.records[0]?.fields.map((field, index) => sanitiseHeader(field, index)) ?? []
    : Array.from({ length: maxFieldCount(parsed.records) }, (_, index) => `column_${index + 1}`);
  const dataRecords = headerInfo.hasHeader ? parsed.records.slice(1) : parsed.records;
  const schema = inferSchema(headers, dataRecords);
  const timestampColumn = pickRoleColumn(schema, ['timestamp', 'time', 'date', 'datetime', 'tid', 'createdat', 'loggedat']);
  const categoryColumn = pickBestCategoryColumn(schema, ['category', 'module', 'source', 'logger', 'component', 'service', 'rapportgrupper', 'typavlarm']);

  schema.forEach((column) => {
    if (timestampColumn && column.name === timestampColumn.name) column.role = 'timestamp';
    if (categoryColumn && column.name === categoryColumn.name) column.role = 'category';
    if (/message|msg|description|detail|händelse|kommentar/i.test(column.name)) column.role = 'message';
  });

  const rows: LogRow[] = dataRecords.map((record, index) => {
    const fields: Record<string, string> = {};
    headers.forEach((header, fieldIndex) => {
      fields[header] = record.fields[fieldIndex] ?? '';
    });

    if (record.fields.length !== headers.length) {
      warnings.push({
        id: `csv-width-${record.startLine}-${index}`,
        type: 'malformed-row',
        level: 'warning',
        lineNumber: record.startLine,
        message: `CSV row has ${record.fields.length} field(s); expected ${headers.length}.`
      });
    }

    const timestampCandidate = timestampColumn ? fields[timestampColumn.name] : findTimestamp(record.raw)?.raw;
    const timestamp = timestampCandidate ? parseTimestamp(timestampCandidate) : undefined;
    const category = categoryColumn ? fields[categoryColumn.name] || 'uncategorized' : 'uncategorized';

    return {
      id: `csv-${record.startLine}-${index}`,
      lineNumber: record.startLine,
      rawLine: record.raw,
      fields,
      timestamp: timestamp?.iso,
      timestampRaw: timestamp?.raw,
      timestampMs: timestamp?.ms,
      category,
      source: category,
      notes: [
        record.malformed ? 'CSV parser marked this row as malformed.' : '',
        timestampColumn ? `Timestamp inferred from column ${timestampColumn.name}.` : '',
        categoryColumn ? `Category inferred from column ${categoryColumn.name}.` : ''
      ].filter(Boolean),
      malformed: record.malformed
    };
  });

  const timestampSummary = summariseTimestamps(rows);
  const categories = sortedUnique(rows.map((row) => row.category).filter(Boolean));
  const assumptions = buildAssumptions({
    options,
    detectedType: 'csv',
    delimiter: printableDelimiter(delimiter),
    delimiterConfidence: delimiterInfo.confidence,
    hasHeader: headerInfo.hasHeader,
    headerConfidence: headerInfo.confidence,
    timestampFormat: timestampSummary.format,
    timestampConfidence: timestampSummary.confidence,
    schema
  });

  const detection: DetectionState = {
    fileName: options.fileName,
    fileSize: options.fileSize,
    detectedType: 'csv',
    parserMode: options.parserMode,
    encoding: options.encoding,
    encodingConfidence: options.encodingConfidence,
    encodingNotes: options.encodingNotes,
    delimiter: printableDelimiter(delimiter),
    delimiterConfidence: delimiterInfo.confidence,
    hasHeader: headerInfo.hasHeader,
    schema,
    timestampFormat: timestampSummary.format,
    timestampConfidence: timestampSummary.confidence,
    categories,
    rowCount: rows.length,
    warnings,
    assumptions
  };

  return { detection, rows };
}

function parseTxt(text: string, options: ParseOptions, inheritedWarnings: ParseWarning[], detectedType: DetectedType): ParseResult {
  const warnings = [...inheritedWarnings];
  const lines = splitLines(text);
  const tokenCounts = new Map<string, number>();

  lines.forEach((line) => {
    const token = firstMeaningfulToken(line);
    if (token) tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
  });

  const repeatedTokens = new Set(
    [...tokenCounts.entries()]
      .filter(([, count]) => count >= 3)
      .map(([token]) => token)
  );

  const rows: LogRow[] = lines.map((line, index) => {
    const lineNumber = index + 1;
    const notes: string[] = [];
    if (line.trim() === '') {
      warnings.push({
        id: `empty-${lineNumber}`,
        type: 'empty-line',
        level: 'info',
        lineNumber,
        message: 'Empty line preserved as an inspectable row.'
      });
      notes.push('Empty line preserved.');
    }

    const timestamp = findTimestamp(line);
    const category = detectCategory(line, repeatedTokens) ?? 'uncategorized';
    const continuation = index > 0 && line.trim() !== '' && !timestamp && /^\s+/.test(line);

    if (continuation) {
      warnings.push({
        id: `continuation-${lineNumber}`,
        type: 'continuation-line',
        level: 'info',
        lineNumber,
        message: 'Indented line without timestamp treated as a continuation line.'
      });
      notes.push('Continuation line: no timestamp found and line starts with whitespace.');
    }

    if (timestamp?.format) notes.push(`Timestamp matched ${timestamp.format}.`);
    if (category !== 'uncategorized') notes.push(`Category inferred as ${category}.`);

    const fields: Record<string, string> = {
      line_number: String(lineNumber),
      timestamp: timestamp?.raw ?? '',
      category,
      message: stripDetectedPrefix(line, timestamp?.raw, category),
      raw: line
    };

    return {
      id: `txt-${lineNumber}`,
      lineNumber,
      rawLine: line,
      fields,
      timestamp: timestamp?.iso,
      timestampRaw: timestamp?.raw,
      timestampMs: timestamp?.ms,
      category,
      source: category,
      notes
    };
  });

  const timestampSummary = summariseTimestamps(rows);
  const schema = inferSchema(
    ['line_number', 'timestamp', 'category', 'message', 'raw'],
    rows.map((row) => ({ fields: ['line_number', 'timestamp', 'category', 'message', 'raw'].map((key) => row.fields[key] ?? '') })) as CsvRecord[]
  );
  schema.forEach((column) => {
    if (column.name === 'line_number') column.role = 'lineNumber';
    if (column.name === 'timestamp') column.role = 'timestamp';
    if (column.name === 'category') column.role = 'category';
    if (column.name === 'raw') column.role = 'raw';
    if (column.name === 'message') column.role = 'message';
  });

  const categories = sortedUnique(rows.map((row) => row.category).filter(Boolean));
  const assumptions = buildAssumptions({
    options,
    detectedType,
    timestampFormat: timestampSummary.format,
    timestampConfidence: timestampSummary.confidence,
    schema
  });

  const detection: DetectionState = {
    fileName: options.fileName,
    fileSize: options.fileSize,
    detectedType,
    parserMode: options.parserMode,
    encoding: options.encoding,
    encodingConfidence: options.encodingConfidence,
    encodingNotes: options.encodingNotes,
    schema,
    timestampFormat: timestampSummary.format,
    timestampConfidence: timestampSummary.confidence,
    categories,
    rowCount: rows.length,
    warnings,
    assumptions
  };

  return { detection, rows };
}

function detectDelimiter(text: string): { delimiter: string; confidence: number } {
  const sampleLines = splitLines(text)
    .filter((line) => line.trim() !== '')
    .slice(0, 80);

  if (sampleLines.length === 0) return { delimiter: ',', confidence: 0.1 };

  const scored = DELIMITERS.map((delimiter) => {
    const widths = sampleLines.map((line) => parseSingleCsvLine(line, delimiter).length);
    const multiColumn = widths.filter((width) => width > 1).length;
    const modeWidth = mode(widths);
    const consistent = widths.filter((width) => width === modeWidth).length;
    const averageWidth = widths.reduce((sum, width) => sum + width, 0) / widths.length;
    const confidence = Math.min(
      0.98,
      (multiColumn / sampleLines.length) * 0.55 + (consistent / sampleLines.length) * 0.35 + Math.min(averageWidth / 12, 0.1)
    );
    return { delimiter, confidence, modeWidth };
  })
    .filter((candidate) => candidate.modeWidth > 1)
    .sort((a, b) => b.confidence - a.confidence);

  return scored[0] ? { delimiter: scored[0].delimiter, confidence: round(scored[0].confidence) } : { delimiter: ',', confidence: 0.2 };
}

function parseCsvRecords(text: string, delimiter: string): CsvParseInternal {
  const records: CsvRecord[] = [];
  const warnings: ParseWarning[] = [];
  let field = '';
  let fields: string[] = [];
  let inQuotes = false;
  let malformed = false;
  let rowStart = 0;
  let lineNumber = 1;
  let recordStartLine = 1;
  let notes: string[] = [];

  function finishField() {
    fields.push(field);
    field = '';
  }

  function finishRecord(endIndex: number, currentLine: number) {
    finishField();
    const raw = text.slice(rowStart, endIndex).replace(/\r?\n$/, '');
    if (raw.trim() === '') {
      warnings.push({
        id: `csv-empty-${recordStartLine}`,
        type: 'empty-line',
        level: 'info',
        lineNumber: recordStartLine,
        message: 'Empty CSV line ignored during row construction.'
      });
    }
    records.push({
      fields,
      startLine: recordStartLine,
      endLine: currentLine,
      raw,
      malformed,
      notes: [...notes]
    });
    fields = [];
    malformed = false;
    notes = [];
    rowStart = endIndex + 1;
    recordStartLine = currentLine + 1;
  }

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      finishField();
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      const isCrLf = char === '\r' && next === '\n';
      finishRecord(index, lineNumber);
      if (isCrLf) index += 1;
      lineNumber += 1;
      rowStart = index + 1;
      recordStartLine = lineNumber;
      continue;
    }

    if ((char === '\n' || char === '\r') && inQuotes) {
      notes.push('Quoted field contains a line break.');
      lineNumber += char === '\n' ? 1 : 0;
    }

    field += char;
  }

  if (inQuotes) {
    malformed = true;
    warnings.push({
      id: `csv-unclosed-quote-${recordStartLine}`,
      type: 'malformed-row',
      level: 'error',
      lineNumber: recordStartLine,
      message: 'CSV parser reached end of file inside a quoted field.'
    });
  }

  if (field.length > 0 || fields.length > 0 || text.length === 0 || text.endsWith('\n') === false) {
    finishRecord(text.length, lineNumber);
  }

  return { records: records.filter((record) => !(record.fields.length === 1 && record.fields[0] === '' && record.raw === '')), warnings };
}

function parseSingleCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      result.push(field);
      field = '';
    } else {
      field += char;
    }
  }

  result.push(field);
  return result;
}

function detectHeader(records: CsvRecord[]): { hasHeader: boolean; confidence: number } {
  if (records.length < 2) return { hasHeader: false, confidence: 0.2 };
  const first = records[0].fields.map((field) => field.trim());
  const second = records[1].fields.map((field) => field.trim());
  const uniqueFirst = new Set(first.filter(Boolean)).size === first.filter(Boolean).length;
  const firstLooksNamed = first.filter((field) => /^[\p{L}_][\p{L}\p{N}_ .:/#-]{0,80}$/u.test(field) && !looksNumeric(field)).length / Math.max(first.length, 1);
  const secondDataLike = second.filter((field) => looksNumeric(field) || parseTimestamp(field) || field.length > 20).length / Math.max(second.length, 1);
  const confidence = round((uniqueFirst ? 0.25 : 0) + firstLooksNamed * 0.45 + secondDataLike * 0.3);
  return { hasHeader: confidence >= 0.58, confidence };
}

function inferSchema(headers: string[], records: CsvRecord[]): ColumnMeta[] {
  return headers.map((name, index) => {
    const values = records.map((record) => record.fields[index] ?? '');
    const nonEmpty = values.filter((value) => value.trim() !== '');
    const unique = sortedUnique(nonEmpty).slice(0, 8);
    const types = nonEmpty.map(inferValueType);
    const inferredType = inferColumnType(types, nonEmpty.length);
    const uniqueCount = new Set(nonEmpty).size;
    const emptyCount = values.length - nonEmpty.length;
    const lowerName = name.toLowerCase();
    const isIdentifierLike = /id|uuid|guid|hash|message|raw|description|detail|händelse|kommentar|nr#?$/.test(lowerName);
    const isCategorical =
      nonEmpty.length > 0 &&
      !isIdentifierLike &&
      inferredType !== 'number' &&
      uniqueCount > 1 &&
      uniqueCount <= Math.max(20, Math.ceil(nonEmpty.length * 0.35));

    return {
      name,
      index,
      inferredType,
      uniqueCount,
      emptyCount,
      sampleValues: unique,
      isCategorical
    } satisfies ColumnMeta;
  });
}

function inferValueType(value: string): ColumnMeta['inferredType'] {
  const trimmed = value.trim();
  if (trimmed === '') return 'empty';
  if (/^(true|false|yes|no)$/i.test(trimmed)) return 'boolean';
  if (looksNumeric(trimmed)) return 'number';
  if (parseTimestamp(trimmed)) return 'date';
  return 'string';
}

function inferColumnType(types: Array<ColumnMeta['inferredType']>, count: number): ColumnMeta['inferredType'] {
  if (count === 0) return 'empty';
  const nonEmpty = types.filter((type) => type !== 'empty');
  const counts = new Map<ColumnMeta['inferredType'], number>();
  nonEmpty.forEach((type) => counts.set(type, (counts.get(type) ?? 0) + 1));
  const [best, bestCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['mixed', 0];
  return bestCount / Math.max(nonEmpty.length, 1) >= 0.82 ? best : 'mixed';
}

function pickRoleColumn(schema: ColumnMeta[], names: string[]): ColumnMeta | undefined {
  return schema.find((column) => names.some((name) => column.name.toLowerCase().replace(/[\s_-]/g, '').includes(name.replace(/[\s_-]/g, ''))));
}

function pickBestCategoryColumn(schema: ColumnMeta[], names: string[]): ColumnMeta | undefined {
  return pickRoleColumn(schema, names) ?? schema.find((column) => column.isCategorical && column.uniqueCount <= 30);
}

function findTimestamp(line: string): { raw: string; iso: string; ms: number; format: string } | undefined {
  for (const candidate of TIMESTAMP_PATTERNS) {
    const match = candidate.pattern.exec(line);
    if (!match?.[0]) continue;
    const raw = match[0].trim();
    const normalised = candidate.normalise(raw);
    const ms = Date.parse(normalised);
    if (Number.isFinite(ms)) {
      return { raw, iso: new Date(ms).toISOString(), ms, format: candidate.name };
    }
  }
  return undefined;
}

function parseTimestamp(value: string): { raw: string; iso: string; ms: number; format: string } | undefined {
  const direct = findTimestamp(value);
  if (direct) return direct;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return undefined;
  return { raw: trimmed, iso: new Date(ms).toISOString(), ms, format: 'Browser Date.parse-compatible value' };
}

function summariseTimestamps(rows: LogRow[]): { format?: string; confidence: number } {
  const withTimestamp = rows.filter((row) => typeof row.timestampMs === 'number');
  if (withTimestamp.length === 0) return { confidence: 0 };
  const formats = new Map<string, number>();
  withTimestamp.forEach((row) => {
    const found = row.timestampRaw ? parseTimestamp(row.timestampRaw) : undefined;
    const format = found?.format ?? 'Browser Date.parse-compatible value';
    formats.set(format, (formats.get(format) ?? 0) + 1);
  });
  const [format, count] = [...formats.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['Unknown', 0];
  return { format, confidence: round(count / Math.max(rows.length, 1)) };
}

function detectCategory(line: string, repeatedTokens = new Set<string>()): string | undefined {
  const bracketMatches = [...line.matchAll(/[\[(]([\p{L}][\p{L}\p{N}.-]{1,48})[\])]/gu)]
    .map((match) => match[1])
    .filter((token) => !/^\d+$/.test(token));
  if (bracketMatches[0]) return bracketMatches[0];

  const prefix = /^\s*(?:\S+\s+){0,4}?([\p{L}][\p{L}\p{N}.-]{1,48})\s*:\s+/u.exec(line)?.[1];
  if (prefix) return prefix;

  const token = firstMeaningfulToken(line);
  if (token && repeatedTokens.has(token)) return token;

  return undefined;
}

function firstMeaningfulToken(line: string): string | undefined {
  const cleaned = line.replace(TIMESTAMP_PATTERNS[0].pattern, '').trim();
  const match = /^\[?([\p{L}][\p{L}\p{N}.-]{1,48})\]?/u.exec(cleaned);
  return match?.[1];
}

function stripDetectedPrefix(line: string, timestampRaw?: string, category?: string): string {
  let output = line;
  if (timestampRaw) output = output.replace(timestampRaw, '');
  if (category && category !== 'uncategorized') {
    output = output.replace(`[${category}]`, '').replace(`${category}:`, '');
  }
  return output.trim();
}

function buildAssumptions(input: {
  options: ParseOptions;
  detectedType: DetectedType;
  delimiter?: string;
  delimiterConfidence?: number;
  hasHeader?: boolean;
  headerConfidence?: number;
  timestampFormat?: string;
  timestampConfidence: number;
  schema: ColumnMeta[];
}): DetectionAssumption[] {
  const categorical = input.schema.filter((column) => column.isCategorical).map((column) => column.name).join(', ') || 'none';
  return [
    { label: 'file type', value: input.detectedType.toUpperCase(), confidence: input.detectedType === 'unknown' ? 0.2 : 0.86 },
    { label: 'encoding', value: input.options.encoding, confidence: input.options.encodingConfidence, locked: input.options.parserMode !== 'auto' },
    ...(input.delimiter
      ? [{ label: 'delimiter', value: input.delimiter, confidence: input.delimiterConfidence ?? 0.5 } satisfies DetectionAssumption]
      : []),
    ...(typeof input.hasHeader === 'boolean'
      ? [{ label: 'header row', value: input.hasHeader ? 'present' : 'not detected', confidence: input.headerConfidence ?? 0.5 } satisfies DetectionAssumption]
      : []),
    {
      label: 'timestamp format',
      value: input.timestampFormat ?? 'not detected',
      confidence: input.timestampConfidence
    },
    {
      label: 'categorical columns',
      value: categorical,
      confidence: categorical === 'none' ? 0.15 : 0.72
    }
  ];
}

function maxFieldCount(records: CsvRecord[]): number {
  return Math.max(1, ...records.map((record) => record.fields.length));
}

function sanitiseHeader(value: string, index: number): string {
  const cleaned = value
    .trim()
    .replace(/^﻿/, '')
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_.:#-]/gu, '')
    .replace(/^_+|_+$/g, '');
  return cleaned || `column_${index + 1}`;
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value !== undefined && value !== null).map((value) => String(value).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function looksNumeric(value: string): boolean {
  return /^[-+]?\d+(?:[.,]\d+)?$/.test(value.trim());
}

function mode(values: number[]): number {
  const counts = new Map<number, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 1;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function printableDelimiter(delimiter: string): string {
  if (delimiter === '\t') return 'tab';
  if (delimiter === ',') return 'comma';
  if (delimiter === ';') return 'semicolon';
  if (delimiter === '|') return 'pipe';
  return delimiter;
}
