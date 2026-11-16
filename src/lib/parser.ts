import type {
  ColumnMeta,
  DetectedType,
  DetectionAssumption,
  DetectionState,
  EncodingName,
  LogRow,
  ParseResult,
  ParseWarning,
  ParserMode,
  Severity,
  SpreadsheetType,
  ImportSettings,
  TextLayout
} from './types';
import { stripUtf8Bom } from './encoding';
import { ACCESS_LINE, analyseSheetRows, analyseText, DELIMITERS, delimiterName, hasOddQuotes, isCommentLine, logfmtPairs, SYSLOG_3164, SYSLOG_5424 } from './layout';
import { mode, round } from './stats';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
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
    // Apache/Nginx access logs: 10/Oct/2000:13:55:36 -0700
    name: 'Common Log Format time',
    pattern: /\b\d{2}\/[A-Z][a-z]{2}\/\d{4}:\d{2}:\d{2}:\d{2}(?: [+-]\d{4})?/,
    normalise: (value) => {
      const match = /^(\d{2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}:\d{2}:\d{2})(?: ([+-]\d{2})(\d{2}))?$/.exec(value);
      const month = match ? MONTHS.indexOf(match[2]) + 1 : 0;
      if (!match || month === 0) return value;
      return `${match[3]}-${String(month).padStart(2, '0')}-${match[1]}T${match[4]}${match[5] ? `${match[5]}:${match[6]}` : ''}`;
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
  /** How to read the file. Left out, the layout is detected (see `analyseText`). */
  settings?: ImportSettings;
}

export function parseLogText(input: string, options: ParseOptions): ParseResult {
  const text = stripUtf8Bom(input);
  const settings = options.settings ?? analyseText(text, { fileName: options.fileName, parserMode: options.parserMode }).suggested;
  const kept = keepLines(text, settings);
  const warnings = [...(options.encodingWarnings ?? [])];
  const result = parseLayout(kept.text, settings, options, warnings);
  return finishResult(result, settings, kept.isRemoved, kept.removedCount);
}

function parseLayout(text: string, settings: ImportSettings, options: ParseOptions, warnings: ParseWarning[]): ParseResult {
  switch (settings.layout) {
    case 'delimited':
      return parseCsv(text, options, warnings, settings);
    case 'json':
    case 'jsonl': {
      const json = parseJson(text, settings.layout, options, warnings);
      if (json) return json;
      warnings.push({
        id: 'json-fallback',
        type: 'assumption',
        level: 'warning',
        message: 'The file looked like JSON but could not be read as JSON objects, so it is shown as plain text.'
      });
      return parseTxt(text, options, warnings, 'txt');
    }
    case 'logfmt':
      return parseLogfmt(text, options, warnings);
    case 'access':
      return parseAccessLog(text, options, warnings);
    case 'w3c':
      return parseW3c(text, options, warnings);
    case 'syslog':
      return parseSyslog(text, options, warnings);
    default:
      return parseTxt(text, options, warnings, 'txt');
  }
}

/**
 * Blanks out the lines the settings leave out, so every parser still counts lines from the top
 * of the original file. Rows and warnings on those lines are dropped afterwards.
 */
function keepLines(text: string, settings: ImportSettings): { text: string; isRemoved: (line: number) => boolean; removedCount: number } {
  if (settings.skipStart <= 0 && settings.skipEnd <= 0 && !settings.ignoreComments) {
    return { text, isRemoved: () => false, removedCount: 0 };
  }
  const lines = splitLines(text);
  const total = lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  const lastKept = total - Math.max(0, settings.skipEnd);
  const removed = new Set<number>();
  // In delimited files a line inside a quoted multi-line cell is cell text, never a comment.
  const tracksQuotes = settings.layout === 'delimited';
  let inQuote = false;
  for (let index = 0; index < total; index += 1) {
    const line = index + 1;
    const original = lines[index];
    const comment = settings.ignoreComments && settings.layout !== 'w3c' && !inQuote && isCommentLine(original);
    if (line <= settings.skipStart || line > lastKept || comment) {
      removed.add(line);
      lines[index] = '';
    }
    if (tracksQuotes && !removed.has(line) && hasOddQuotes(original)) inQuote = !inQuote;
  }
  return { text: lines.join('\n'), isRemoved: (line) => removed.has(line), removedCount: removed.size };
}

function finishResult(result: ParseResult, settings: ImportSettings, isRemoved: (line: number) => boolean, removedCount: number): ParseResult {
  if (removedCount > 0) {
    // A blanked line in the middle of a stack trace is folded into its entry; only drop rows that start on one.
    result.rows = result.rows.filter((row) => !(isRemoved(row.lineNumber) && row.rawLine.trim() === ''));
    result.detection.warnings = result.detection.warnings.filter(
      (warning) => warning.lineNumber === undefined || !isRemoved(warning.lineNumber) || warning.type !== 'empty-line'
    );
    result.detection.rowCount = result.rows.length;
  }
  result.detection.settings = settings;
  result.detection.skippedLines = removedCount;
  return result;
}

function parseCsv(text: string, options: ParseOptions, inheritedWarnings: ParseWarning[], settings?: ImportSettings): ParseResult {
  const detected = detectDelimiter(text);
  const delimiterInfo = settings?.delimiter && settings.delimiter !== detected.delimiter ? { delimiter: settings.delimiter, confidence: 1 } : detected;
  const delimiter = delimiterInfo.delimiter;
  const parsed = parseCsvRecords(text, delimiter);
  const warnings = [...inheritedWarnings, ...parsed.warnings];
  const headerInfo = settings?.hasHeader !== undefined ? { hasHeader: settings.hasHeader, confidence: 1 } : detectHeader(parsed.records);
  const headers = headerInfo.hasHeader
    ? parsed.records[0]?.fields.map((field, index) => sanitiseHeader(field, index)) ?? []
    : Array.from({ length: maxFieldCount(parsed.records) }, (_, index) => `column_${index + 1}`);
  const dataRecords = headerInfo.hasHeader ? parsed.records.slice(1) : parsed.records;

  return buildTable(headers, dataRecords, options, warnings, {
    detectedType: 'csv',
    rowLabel: 'CSV row',
    delimiter: delimiterName(delimiter),
    delimiterConfidence: delimiterInfo.confidence,
    hasHeader: headerInfo.hasHeader,
    headerConfidence: headerInfo.confidence
  });
}

export interface SpreadsheetSheet {
  name: string;
  /** Cell text, row by row, as the workbook reader formatted it. Blank rows are left out. */
  rows: string[][];
  /** The spreadsheet's own 1-based row number for each entry in `rows`. */
  rowNumbers?: number[];
}

/** Turns one worksheet's cell text into rows, with the same column detection as CSV. */
export function parseSpreadsheet(
  sheet: SpreadsheetSheet,
  sheetNames: string[],
  format: SpreadsheetType,
  options: ParseOptions
): ParseResult {
  const warnings = [...(options.encodingWarnings ?? [])];
  const allNumbers = sheet.rows.map((_, index) => sheet.rowNumbers?.[index] ?? index + 1);
  const settings = options.settings ?? analyseSheetRows(sheet.rows, allNumbers).suggested;
  const lastRow = allNumbers[allNumbers.length - 1] ?? 0;
  const keep = (rowNumber: number) => rowNumber > settings.skipStart && rowNumber <= lastRow - settings.skipEnd;
  const keptRows = sheet.rows.filter((_, index) => keep(allNumbers[index]));
  const keptNumbers = allNumbers.filter(keep);
  // Width from the kept rows only, so a wide title block doesn't add empty columns.
  const width = keptRows.reduce((max, row) => Math.max(max, trimTrailingEmpty(row).length), 1);
  const records: CsvRecord[] = keptRows.map((cells, index) => {
    const fields = Array.from({ length: width }, (_, column) => cells[column] ?? '');
    const rowNumber = keptNumbers[index];
    return { fields, startLine: rowNumber, endLine: rowNumber, raw: trimTrailingEmpty(fields).join('\t'), notes: [] };
  });
  const headerInfo = settings.hasHeader !== undefined ? { hasHeader: settings.hasHeader, confidence: 1 } : detectHeader(records);
  const headers = headerInfo.hasHeader
    ? uniqueHeaders(records[0]?.fields.map((field, index) => sanitiseHeader(field, index)) ?? [])
    : Array.from({ length: width }, (_, index) => spreadsheetColumnName(index));
  const dataRecords = headerInfo.hasHeader ? records.slice(1) : records;

  const result = buildTable(headers, dataRecords, options, warnings, {
    detectedType: format,
    rowLabel: 'Sheet row',
    hasHeader: headerInfo.hasHeader,
    headerConfidence: headerInfo.confidence,
    sheetName: sheet.name,
    sheetNames
  });
  return finishResult(result, { ...settings, layout: 'delimited' }, () => false, sheet.rows.length - keptRows.length);
}

interface TableMeta {
  detectedType: DetectedType;
  /** How a row is described in warnings, e.g. "CSV row". */
  rowLabel: string;
  delimiter?: string;
  delimiterConfidence?: number;
  hasHeader?: boolean;
  headerConfidence?: number;
  sheetName?: string;
  sheetNames?: string[];
  /** Map pino/bunyan numeric levels (30 = INFO) in the severity column. */
  numericLevels?: boolean;
}

/** Shared by CSV, spreadsheets and JSON: infer column roles, then build rows. */
function buildTable(headers: string[], dataRecords: CsvRecord[], options: ParseOptions, warnings: ParseWarning[], meta: TableMeta): ParseResult {
  const schema = inferSchema(headers, dataRecords);
  const timestampColumn = pickTimestampColumn(schema, dataRecords);
  const severityColumn = pickSeverityColumn(schema, dataRecords, meta.numericLevels);
  const messageColumn = pickMessageColumn(schema.filter((column) => column !== timestampColumn && column !== severityColumn));
  // Each column gets one role: the category guess must not steal the timestamp or message column
  // (with only a few rows, a time column can look categorical).
  const categoryColumn = pickBestCategoryColumn(
    schema.filter(
      (column) => column !== severityColumn && column !== timestampColumn && column !== messageColumn && column.inferredType !== 'date'
    ),
    ['category', 'module', 'source', 'logger', 'component', 'service', 'rapportgrupper', 'typavlarm']
  );

  schema.forEach((column) => {
    if (timestampColumn && column.name === timestampColumn.name) column.role = 'timestamp';
    if (severityColumn && column.name === severityColumn.name) column.role = 'severity';
    if (categoryColumn && column.name === categoryColumn.name) column.role = 'category';
    if (messageColumn && column.name === messageColumn.name) column.role = 'message';
  });

  const rows: LogRow[] = dataRecords.map((record, index) => {
    const fields: Record<string, string> = {};
    headers.forEach((header, fieldIndex) => {
      fields[header] = record.fields[fieldIndex] ?? '';
    });

    if (meta.detectedType === 'csv' && record.fields.length !== headers.length) {
      warnings.push({
        id: `csv-width-${record.startLine}-${index}`,
        type: 'malformed-row',
        level: 'warning',
        lineNumber: record.startLine,
        message: `${meta.rowLabel} has ${record.fields.length} field(s); expected ${headers.length}.`
      });
    }

    const notes: string[] = [...record.notes];
    let severity: Severity | undefined;
    if (severityColumn) {
      const rawLevel = fields[severityColumn.name];
      severity = normaliseSeverity(rawLevel);
      const numeric = !severity && meta.numericLevels ? numericSeverity(rawLevel) : undefined;
      if (numeric) {
        severity = numeric;
        fields[severityColumn.name] = numeric;
        notes.push(`Numeric level ${rawLevel} read as ${numeric}.`);
      }
    }

    const timestampCandidate = timestampColumn ? fields[timestampColumn.name] : findTimestamp(record.raw)?.raw;
    const timestamp = timestampCandidate ? parseTimestamp(timestampCandidate) : undefined;
    const category = categoryColumn ? fields[categoryColumn.name] || 'uncategorized' : 'uncategorized';

    return {
      id: `${meta.detectedType}-${record.startLine}-${index}`,
      lineNumber: record.startLine,
      rawLine: record.raw,
      fields,
      timestamp: timestamp?.iso,
      timestampRaw: timestamp?.raw,
      timestampMs: timestamp?.ms,
      severity,
      category,
      source: category,
      notes: [
        record.malformed ? 'CSV parser marked this row as malformed.' : '',
        ...notes,
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
    detectedType: meta.detectedType,
    delimiter: meta.delimiter,
    delimiterConfidence: meta.delimiterConfidence,
    hasHeader: meta.hasHeader,
    headerConfidence: meta.headerConfidence,
    timestampFormat: timestampSummary.format,
    timestampConfidence: timestampSummary.confidence,
    schema
  });

  const detection: DetectionState = {
    fileName: options.fileName,
    fileSize: options.fileSize,
    detectedType: meta.detectedType,
    parserMode: options.parserMode,
    encoding: options.encoding,
    encodingConfidence: options.encodingConfidence,
    encodingNotes: options.encodingNotes,
    delimiter: meta.delimiter,
    delimiterConfidence: meta.delimiterConfidence,
    hasHeader: meta.hasHeader,
    sheetName: meta.sheetName,
    sheetNames: meta.sheetNames,
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

// ---------------------------------------------------------------------------
// JSON and JSON Lines

const MAX_JSON_DEPTH = 4;
const MAX_JSON_COLUMNS = 200;

/** "jsonl" when most early lines are JSON objects, "json" for a whole-document array/object. */
function sniffJson(text: string): 'json' | 'jsonl' | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;

  const lines = splitLines(text)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 50);
  const objectLines = lines.filter((line) => line.startsWith('{') && isJsonObject(line)).length;
  if (lines.length > 1 && objectLines / lines.length >= 0.9) return 'jsonl';

  return isJsonDocument(trimmed) ? 'json' : undefined;
}

export function isJsonObject(line: string): boolean {
  try {
    const value = JSON.parse(line);
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  } catch {
    return false;
  }
}

function isJsonDocument(text: string): boolean {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object';
  } catch {
    return false;
  }
}

function parseJson(text: string, kind: 'json' | 'jsonl', options: ParseOptions, warnings: ParseWarning[]): ParseResult | undefined {
  const entries: Array<{ value: Record<string, unknown>; line: number; raw: string }> = [];
  const textRows: Array<{ line: number; raw: string }> = [];

  if (kind === 'jsonl') {
    splitLines(text).forEach((raw, index) => {
      const line = index + 1;
      if (raw.trim() === '') return;
      try {
        const value = JSON.parse(raw);
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          entries.push({ value, line, raw });
          return;
        }
      } catch {
        // fall through
      }
      textRows.push({ line, raw });
      warnings.push({
        id: `jsonl-line-${line}`,
        type: 'malformed-row',
        level: 'warning',
        lineNumber: line,
        message: 'Line is not a JSON object; kept as a raw row.'
      });
    });
  } else {
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch (error) {
      if (sniffJson(text) === 'jsonl') return parseJson(text, 'jsonl', options, warnings);
      warnings.push({
        id: 'json-invalid',
        type: 'parser',
        level: 'error',
        message: `Invalid JSON: ${error instanceof Error ? error.message : 'parse error'}`
      });
      return undefined;
    }
    const items = jsonRecords(document);
    if (!items) return undefined;
    items.forEach((item, index) => {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        entries.push({ value: item as Record<string, unknown>, line: index + 1, raw: JSON.stringify(item) });
      } else {
        textRows.push({ line: index + 1, raw: JSON.stringify(item) });
      }
    });
  }

  if (entries.length === 0) return undefined;

  const flattened = entries.map((entry) => flattenJson(entry.value));
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const record of flattened) {
    for (const key of record.keys()) {
      if (seen.has(key)) continue;
      if (headers.length >= MAX_JSON_COLUMNS) break;
      seen.add(key);
      headers.push(key);
    }
  }
  if (seen.size < new Set(flattened.flatMap((record) => [...record.keys()])).size) {
    warnings.push({
      id: 'json-columns-capped',
      type: 'assumption',
      level: 'info',
      message: `Only the first ${MAX_JSON_COLUMNS} keys are shown as columns; every key is still in the raw text.`
    });
  }

  const records: CsvRecord[] = [
    ...entries.map((entry, index) => ({
      fields: headers.map((header) => flattened[index].get(header) ?? ''),
      startLine: entry.line,
      endLine: entry.line,
      raw: entry.raw,
      notes: []
    })),
    ...textRows.map((row) => ({
      fields: headers.map(() => ''),
      startLine: row.line,
      endLine: row.line,
      raw: row.raw,
      malformed: true,
      notes: ['Not a JSON object.']
    }))
  ].sort((a, b) => a.startLine - b.startLine);

  // Rows that aren't objects still need something to show: put the raw text in the message column.
  const result = buildTable(headers, records, options, warnings, {
    detectedType: kind,
    rowLabel: kind === 'jsonl' ? 'JSON line' : 'JSON item',
    hasHeader: true,
    headerConfidence: 1,
    numericLevels: true
  });
  const message = result.detection.schema.find((column) => column.role === 'message')?.name;
  result.rows.forEach((row) => {
    if (row.malformed && message) row.fields[message] = row.rawLine;
  });
  return result;
}

/** The array of records inside a JSON document: a top-level array, or the first array-of-objects property. */
function jsonRecords(document: unknown): unknown[] | undefined {
  if (Array.isArray(document)) return document;
  if (document === null || typeof document !== 'object') return undefined;
  for (const value of Object.values(document as Record<string, unknown>)) {
    if (Array.isArray(value) && value.some((item) => item !== null && typeof item === 'object' && !Array.isArray(item))) return value;
  }
  return [document];
}

/** Nested objects become dotted keys (`http.status`); arrays and deep values stay as JSON text. */
function flattenJson(value: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (node: unknown, prefix: string, depth: number) => {
    if (node !== null && typeof node === 'object' && !Array.isArray(node) && depth < MAX_JSON_DEPTH) {
      const entries = Object.entries(node as Record<string, unknown>);
      if (entries.length === 0 && prefix) out.set(prefix, '{}');
      for (const [rawKey, child] of entries) {
        const key = rawKey === '__proto__' ? '[__proto__]' : rawKey;
        visit(child, prefix ? `${prefix}.${key}` : key, depth + 1);
      }
      return;
    }
    out.set(prefix || 'value', jsonCellText(node));
  };
  visit(value, '', 0);
  return out;
}

function jsonCellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

// pino / bunyan / winston-numeric conventions.
const NUMERIC_LEVELS: Record<string, Severity> = { '10': 'TRACE', '20': 'DEBUG', '30': 'INFO', '40': 'WARN', '50': 'ERROR', '60': 'FATAL' };

function numericSeverity(value: string | undefined): Severity | undefined {
  return value ? NUMERIC_LEVELS[value.trim()] : undefined;
}

function trimTrailingEmpty(cells: string[]): string[] {
  let end = cells.length;
  while (end > 0 && cells[end - 1] === '') end -= 1;
  return cells.slice(0, end);
}

/** Excel-style column letters: A, B, …, Z, AA. */
function spreadsheetColumnName(index: number): string {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** Spreadsheet headers are often blank or repeated: make every column name unique. */
function uniqueHeaders(headers: string[]): string[] {
  const counts = new Map<string, number>();
  return headers.map((header) => {
    const count = (counts.get(header) ?? 0) + 1;
    counts.set(header, count);
    return count === 1 ? header : `${header}_${count}`;
  });
}

function parseTxt(text: string, options: ParseOptions, inheritedWarnings: ParseWarning[], detectedType: DetectedType): ParseResult {
  const warnings = [...inheritedWarnings];
  const lines = splitLines(text);
  const entries = groupContinuationLines(lines);
  const tokenCounts = new Map<string, number>();

  entries.forEach((entry) => {
    const token = firstMeaningfulToken(entry.lines[0]);
    if (token) tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
  });

  const repeatedTokens = new Set(
    [...tokenCounts.entries()]
      .filter(([, count]) => count >= 3)
      .map(([token]) => token)
  );

  const rows: LogRow[] = entries.map((entry) => {
    const lineNumber = entry.start + 1;
    const lineEnd = entry.start + entry.lines.length;
    const [line, ...continuation] = entry.lines;
    const rawLine = entry.lines.join('\n');
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
    const severity = detectSeverity(line);
    const category = detectCategory(line, repeatedTokens) ?? 'uncategorized';

    if (continuation.length > 0) {
      const count = continuation.length;
      warnings.push({
        id: `continuation-${lineNumber}`,
        type: 'continuation-line',
        level: 'info',
        lineNumber,
        message: `Merged ${count} continuation line${count === 1 ? '' : 's'} into line ${lineNumber}.`
      });
      notes.push(
        `Merged ${count} continuation line${count === 1 ? '' : 's'} (line${count === 1 ? ` ${lineNumber + 1}` : `s ${lineNumber + 1}–${lineEnd}`}): indented or stack-trace lines without a timestamp.`
      );
    }

    if (timestamp?.format) notes.push(`Timestamp matched ${timestamp.format}.`);
    if (severity) notes.push(`Severity inferred as ${severity.value} from "${severity.raw.trim()}".`);
    if (category !== 'uncategorized') notes.push(`Category inferred as ${category}.`);

    const message = stripDetectedPrefix(line, timestamp?.raw, category, severity?.raw);
    const fields: Record<string, string> = {
      line_number: String(lineNumber),
      timestamp: timestamp?.raw ?? '',
      severity: severity?.value ?? '',
      category: category === 'uncategorized' ? '' : category,
      // The table shows the first line; the full text lives in fullMessage and raw.
      message,
      raw: rawLine
    };

    return {
      id: `txt-${lineNumber}`,
      lineNumber,
      ...(continuation.length > 0 ? { lineEnd, fullMessage: [message, ...continuation].join('\n') } : {}),
      rawLine,
      fields,
      timestamp: timestamp?.iso,
      timestampRaw: timestamp?.raw,
      timestampMs: timestamp?.ms,
      severity: severity?.value,
      category,
      source: category,
      notes
    };
  });

  const timestampSummary = summariseTimestamps(rows);
  // Only expose severity/category columns when the file actually has them.
  const txtColumns = ['line_number', 'timestamp', 'severity', 'category', 'message', 'raw'].filter(
    (key) => (key !== 'severity' && key !== 'category') || rows.some((row) => row.fields[key])
  );
  const schema = inferSchema(
    txtColumns,
    rows.map((row) => ({ fields: txtColumns.map((key) => row.fields[key] ?? '') })) as CsvRecord[]
  );
  schema.forEach((column) => {
    if (column.name === 'line_number') column.role = 'lineNumber';
    if (column.name === 'timestamp') column.role = 'timestamp';
    if (column.name === 'severity') column.role = 'severity';
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

// ── Structured line formats ──────────────────────────────────────────────────

interface LineRecord {
  fields: string[];
  line: number;
  raw: string;
  malformed?: boolean;
  note?: string;
}

/** Lines of a text, with 1-based line numbers, skipping blank ones. */
function numberedLines(text: string): Array<{ line: number; raw: string }> {
  return splitLines(text)
    .map((raw, index) => ({ line: index + 1, raw }))
    .filter((entry) => entry.raw.trim() !== '');
}

/** Shared tail of the line-format parsers: drop always-empty columns, then infer roles. */
function lineTable(
  headers: string[],
  lineRecords: LineRecord[],
  options: ParseOptions,
  warnings: ParseWarning[],
  detectedType: DetectedType,
  rowLabel: string,
  numericLevels = false
): ParseResult {
  const used = headers.map((_, column) => lineRecords.some((record) => (record.fields[column] ?? '') !== ''));
  const keptHeaders = headers.filter((_, column) => used[column]);
  const records: CsvRecord[] = lineRecords.map((record) => ({
    fields: record.fields.filter((_, column) => used[column]),
    startLine: record.line,
    endLine: record.line,
    raw: record.raw,
    malformed: record.malformed,
    notes: record.note ? [record.note] : []
  }));
  lineRecords
    .filter((record) => record.malformed)
    .slice(0, 500)
    .forEach((record) =>
      warnings.push({
        id: `${detectedType}-line-${record.line}`,
        type: 'malformed-row',
        level: 'warning',
        lineNumber: record.line,
        message: `Line doesn't match the ${rowLabel} format; kept as a raw row.`
      })
    );
  const result = buildTable(keptHeaders.length ? keptHeaders : ['message'], records, options, warnings, {
    detectedType,
    rowLabel,
    hasHeader: true,
    headerConfidence: 1,
    numericLevels
  });
  // Unmatched lines still need something to show: put the raw text in the message column.
  const message = result.detection.schema.find((column) => column.role === 'message')?.name ?? keptHeaders[keptHeaders.length - 1];
  result.rows.forEach((row) => {
    if (row.malformed && message) row.fields[message] = row.rawLine;
  });
  return result;
}

function unmatched(line: number, raw: string, width: number): LineRecord {
  return { fields: Array.from({ length: width }, () => ''), line, raw, malformed: true };
}

/** HTTP status → level, so access logs can be filtered like other logs. */
function statusLevel(status: string): Severity | '' {
  if (!/^\d{3}$/.test(status)) return '';
  if (status >= '500') return 'ERROR';
  if (status >= '400') return 'WARN';
  return 'INFO';
}

function parseLogfmt(text: string, options: ParseOptions, warnings: ParseWarning[]): ParseResult {
  const headers: string[] = [];
  const seen = new Set<string>();
  let capped = false;
  const parsed = numberedLines(text).map(({ line, raw }) => {
    const pairs = logfmtPairs(raw);
    if (pairs) {
      for (const [key] of pairs) {
        if (seen.has(key)) continue;
        if (headers.length >= MAX_JSON_COLUMNS) {
          capped = true;
          continue;
        }
        seen.add(key);
        headers.push(key);
      }
    }
    return { line, raw, pairs };
  });
  if (capped) {
    warnings.push({
      id: 'logfmt-columns-capped',
      type: 'assumption',
      level: 'info',
      message: `Only the first ${MAX_JSON_COLUMNS} keys are shown as columns; every key is still in the raw text.`
    });
  }
  const records = parsed.map(({ line, raw, pairs }): LineRecord => {
    if (!pairs) return unmatched(line, raw, headers.length);
    const values = new Map(pairs);
    return { fields: headers.map((header) => values.get(header) ?? ''), line, raw };
  });
  return lineTable(headers, records, options, warnings, 'logfmt', 'key=value');
}

const ACCESS_HEADERS = ['client', 'ident', 'user', 'time', 'method', 'path', 'protocol', 'status', 'level', 'bytes', 'referer', 'user_agent', 'extra'];

function parseAccessLog(text: string, options: ParseOptions, warnings: ParseWarning[]): ParseResult {
  const unquote = (value: string | undefined) => (value ?? '').replace(/\\(["\\])/g, '$1');
  const dash = (value: string | undefined) => (value === '-' ? '' : (value ?? ''));
  const records = numberedLines(text).map(({ line, raw }): LineRecord => {
    const match = ACCESS_LINE.exec(raw);
    if (!match) return unmatched(line, raw, ACCESS_HEADERS.length);
    const request = unquote(match[5]);
    const [method = '', path = '', protocol = ''] = /^([A-Z]+) (\S+)(?: (\S+))?$/.test(request) ? request.split(' ') : ['', request, ''];
    const status = dash(match[6]);
    return {
      fields: [
        dash(match[1]),
        dash(match[2]),
        dash(match[3]),
        match[4],
        method,
        path,
        protocol,
        status,
        statusLevel(status),
        dash(match[7]),
        dash(unquote(match[8])),
        dash(unquote(match[9])),
        (match[10] ?? '').trim()
      ],
      line,
      raw,
      note: status ? `Level derived from HTTP status ${status}.` : undefined
    };
  });
  return lineTable(ACCESS_HEADERS, records, options, warnings, 'access', 'access log');
}

/** W3C extended log (IIS and others): #Fields names the space-separated columns, and can change mid-file. */
function parseW3c(text: string, options: ParseOptions, warnings: ParseWarning[]): ParseResult {
  const headers: string[] = [];
  const index = new Map<string, number>();
  const addHeader = (name: string) => {
    if (!index.has(name)) {
      index.set(name, headers.length);
      headers.push(name);
    }
  };
  let fields: string[] = [];
  const pending: Array<{ line: number; raw: string; values: Map<string, string> | undefined }> = [];
  for (const { line, raw } of numberedLines(text)) {
    if (raw.startsWith('#')) {
      const directive = /^#Fields:\s*(.*)$/.exec(raw);
      if (directive) {
        fields = directive[1].trim().split(/\s+/);
        if (fields.includes('date') && fields.includes('time')) addHeader('timestamp');
        fields.forEach(addHeader);
        if (fields.some((name) => /(^|-)status$/.test(name))) addHeader('level');
      }
      continue;
    }
    const cells = raw.trim().split(/\s+/);
    if (fields.length === 0 || cells.length !== fields.length) {
      pending.push({ line, raw, values: undefined });
      continue;
    }
    const values = new Map<string, string>();
    fields.forEach((name, column) => values.set(name, cells[column] === '-' ? '' : cells[column]));
    if (values.has('date') && values.has('time')) values.set('timestamp', `${values.get('date')}T${values.get('time')}Z`);
    const status = values.get('sc-status') ?? values.get('status');
    if (status !== undefined) values.set('level', statusLevel(status));
    pending.push({ line, raw, values });
  }
  const records = pending.map(({ line, raw, values }): LineRecord =>
    values ? { fields: headers.map((header) => values.get(header) ?? ''), line, raw } : unmatched(line, raw, headers.length)
  );
  return lineTable(headers, records, options, warnings, 'w3c', 'W3C log');
}

const SYSLOG_HEADERS = ['timestamp', 'host', 'app', 'pid', 'msgid', 'facility', 'level', 'message', 'structured_data'];
const SYSLOG_FACILITIES = [
  'kern', 'user', 'mail', 'daemon', 'auth', 'syslog', 'lpr', 'news', 'uucp', 'cron', 'authpriv', 'ftp', 'ntp', 'audit', 'alert', 'clock',
  'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7'
];
const SYSLOG_SEVERITIES: Severity[] = ['FATAL', 'FATAL', 'FATAL', 'ERROR', 'WARN', 'INFO', 'INFO', 'DEBUG'];

function parseSyslog(text: string, options: ParseOptions, warnings: ParseWarning[]): ParseResult {
  const dash = (value: string | undefined) => (value === '-' || value === undefined ? '' : value);
  const priority = (value: string | undefined): { facility: string; level: string; note?: string } => {
    if (value === undefined) return { facility: '', level: '' };
    const pri = Number(value);
    const level = SYSLOG_SEVERITIES[pri % 8] ?? '';
    return { facility: SYSLOG_FACILITIES[Math.floor(pri / 8)] ?? '', level, note: `Priority <${value}> read as ${level}.` };
  };
  const records = numberedLines(text).map(({ line, raw }): LineRecord => {
    const modern = SYSLOG_5424.exec(raw);
    if (modern) {
      const pri = priority(modern[1]);
      return {
        fields: [modern[2], dash(modern[3]), dash(modern[4]), dash(modern[5]), dash(modern[6]), pri.facility, pri.level, (modern[8] ?? '').replace(/^\uFEFF/, ''), dash(modern[7])],
        line,
        raw,
        note: pri.note
      };
    }
    const classic = SYSLOG_3164.exec(raw);
    if (classic) {
      const pri = priority(classic[1]);
      const message = classic[6];
      const level = pri.level || detectSeverity(message)?.value || '';
      return { fields: [classic[2], classic[3], classic[4], classic[5] ?? '', '', pri.facility, level, message, ''], line, raw, note: pri.note };
    }
    return unmatched(line, raw, SYSLOG_HEADERS.length);
  });
  return lineTable(SYSLOG_HEADERS, records, options, warnings, 'syslog', 'syslog');
}

interface LineGroup {
  /** Zero-based index of the first line. */
  start: number;
  lines: string[];
}

// Stack-trace shapes that continue the previous entry even without extra indentation.
const JAVA_FRAME = /^\s*at\s+\S/;
const JAVA_CAUSED_BY = /^\s*Caused by:/;
const JAVA_SUPPRESSED = /^\s*Suppressed:/;
const JAVA_MORE = /^\s*\.\.\.\s*\d+\s+(?:more|common frames omitted)/;
const JAVA_EXCEPTION_HEAD = /^(?:Exception in thread "[^"]*"\s+)?(?:[a-z_$][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error|Throwable)\b(?::.*)?$/;
const PY_TRACEBACK = /^\s*Traceback \(most recent call last\):/;
const PY_FRAME = /^\s*File ".*", line \d+/;
const PY_CHAINED = /^\s*(?:During handling of the above exception, another exception occurred:|The above exception was the direct cause of the following exception:)\s*$/;
// Final line of a Python traceback, e.g. "ValueError: bad input" or "KeyboardInterrupt".
const PY_EXCEPTION_LINE = /^[A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt|Warning|Iteration)(?::.*)?$/;

function leadingWhitespace(line: string): number {
  return /^\s*/.exec(line)?.[0].length ?? 0;
}

function isStackTraceLine(line: string): boolean {
  return [JAVA_FRAME, JAVA_CAUSED_BY, JAVA_SUPPRESSED, JAVA_MORE, JAVA_EXCEPTION_HEAD, PY_TRACEBACK, PY_FRAME, PY_CHAINED].some((pattern) =>
    pattern.test(line)
  );
}

/**
 * Group physical lines into log entries. A line without a timestamp continues the entry above when
 * it is indented deeper than that entry's first line, or looks like part of a Java/Python stack
 * trace. Blank lines stay their own rows unless the entry carries on after them, in which case they
 * are kept inside the merged text.
 */
function groupContinuationLines(lines: string[]): LineGroup[] {
  const groups: LineGroup[] = [];
  let current: LineGroup | undefined;
  let inPythonTraceback = false;

  const continues = (line: string, head: string): boolean => {
    if (line.trim() === '' || findTimestamp(line)) return false;
    if (isStackTraceLine(line)) return true;
    if (inPythonTraceback && PY_EXCEPTION_LINE.test(line)) return true;
    return leadingWhitespace(line) > leadingWhitespace(head);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    // Only a non-blank entry can absorb continuation lines.
    const head = current && current.lines[0].trim() !== '' ? current.lines[0] : undefined;

    if (current && head !== undefined && line.trim() === '') {
      // Fold blank lines only when the entry resumes right after them.
      let next = index + 1;
      while (next < lines.length && lines[next].trim() === '') next += 1;
      if (next < lines.length && continues(lines[next], head)) {
        current.lines.push(...lines.slice(index, next));
        index = next - 1;
        continue;
      }
    }

    if (current && head !== undefined && continues(line, head)) {
      current.lines.push(line);
      if (PY_TRACEBACK.test(line)) inPythonTraceback = true;
      else if (inPythonTraceback && leadingWhitespace(line) === 0 && PY_EXCEPTION_LINE.test(line)) inPythonTraceback = false;
      continue;
    }

    current = { start: index, lines: [line] };
    inPythonTraceback = PY_TRACEBACK.test(line);
    groups.push(current);
  }

  return groups;
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

export function parseSingleCsvLine(line: string, delimiter: string): string[] {
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
  const firstFilled = first.filter(Boolean);
  if (firstFilled.length === 0) return { hasHeader: false, confidence: 0.1 };
  const uniqueFirst = new Set(firstFilled).size === firstFilled.length;
  // "Not data": non-empty, not a number, not a timestamp. Tolerant of mojibake
  // and punctuation in real-world column names like "Larmhändelse nr#".
  const firstNotData = first.filter((field) => field !== '' && !looksNumeric(field) && !parseTimestamp(field)).length / first.length;
  const secondLooksData = second.filter((field) => looksNumeric(field) || parseTimestamp(field) || field.length > 20).length / Math.max(second.length, 1);
  const confidence = round((uniqueFirst ? 0.25 : 0) + firstNotData * 0.55 + secondLooksData * 0.2);
  return { hasHeader: confidence >= 0.55, confidence };
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

/** A column whose name says "level" or "severity", or whose values are mostly log levels. */
function pickSeverityColumn(schema: ColumnMeta[], records: CsvRecord[], numericLevels = false): ColumnMeta | undefined {
  const byName = schema.find((column) =>
    /^(log\.)?(level|loglevel|log_level|levelname|level_name|severity|severity_text|lvl|priority|prio)$/i.test(column.name)
  );
  if (byName) return byName;
  return schema.find((column) => {
    if (!column.isCategorical) return false;
    const values = records.map((record) => record.fields[column.index] ?? '').filter((value) => value.trim() !== '');
    if (values.length === 0) return false;
    const known = values.filter((value) => normaliseSeverity(value) || (numericLevels && numericSeverity(value))).length;
    return known / values.length >= 0.9;
  });
}

function normaliseColumnName(name: string): string {
  return name.toLowerCase().replace(/[@\s_.-]/g, '');
}

/**
 * Exact well-known names first (so `responseTime` never beats `time`), then the looser substring match.
 * Either way the values must mostly read as timestamps, so `Uptime (h)` = 412 is not "the year 412".
 */
function pickTimestampColumn(schema: ColumnMeta[], records: CsvRecord[]): ColumnMeta | undefined {
  const exact = ['timestamp', 'time', 'ts', 'datetime', 'date', 'createdat', 'loggedat', 'eventtime', 'tid'];
  const loose = ['timestamp', 'time', 'date', 'datetime', 'tid', 'createdat', 'loggedat'];
  const candidates = [
    ...exact.flatMap((name) => schema.filter((column) => normaliseColumnName(column.name) === name)),
    ...schema.filter((column) => loose.some((name) => normaliseColumnName(column.name).includes(name)))
  ];
  return candidates.find((column) => valuesLookLikeTimestamps(column, records));
}

function valuesLookLikeTimestamps(column: ColumnMeta, records: CsvRecord[]): boolean {
  const values = records
    .map((record) => (record.fields[column.index] ?? '').trim())
    .filter(Boolean)
    .slice(0, 50);
  if (values.length === 0) return false;
  // Plain numbers only count as Unix times; Date.parse would happily read "412" as a year.
  const readable = values.filter((value) => (looksNumeric(value) ? parseEpoch(value) : parseTimestamp(value))).length;
  return readable / values.length >= 0.6;
}

function pickMessageColumn(schema: ColumnMeta[]): ColumnMeta | undefined {
  const exact = ['message', 'msg', 'text', 'log', 'event', 'description'];
  for (const name of exact) {
    const match = schema.find((column) => normaliseColumnName(column.name) === name);
    if (match) return match;
  }
  const loose = schema.filter((column) => /message|msg|description|detail|händelse|kommentar/i.test(column.name));
  return loose.find((column) => !column.name.includes('.')) ?? loose[0];
}

function pickBestCategoryColumn(schema: ColumnMeta[], names: string[]): ColumnMeta | undefined {
  return pickRoleColumn(schema, names) ?? schema.find((column) => column.isCategorical && column.uniqueCount <= 30);
}

export function findTimestamp(line: string): { raw: string; iso: string; ms: number; format: string } | undefined {
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

const EPOCH_MIN_MS = Date.UTC(2000, 0, 1);
const EPOCH_MAX_MS = Date.UTC(2100, 0, 1);

/** Unix time in seconds (10 digits, optional fraction) or milliseconds (13 digits), common in JSON logs. */
function parseEpoch(value: string): { raw: string; iso: string; ms: number; format: string } | undefined {
  let ms: number | undefined;
  let format = '';
  if (/^\d{10}(?:\.\d+)?$/.test(value)) {
    ms = Math.round(Number(value) * 1000);
    format = 'Unix time (seconds)';
  } else if (/^\d{13}$/.test(value)) {
    ms = Number(value);
    format = 'Unix time (milliseconds)';
  }
  if (ms === undefined || ms < EPOCH_MIN_MS || ms >= EPOCH_MAX_MS) return undefined;
  const iso = new Date(ms).toISOString();
  // Show a readable time in the table instead of the raw number.
  return { raw: iso.replace('T', ' ').replace('Z', ' UTC'), iso, ms, format };
}

function parseTimestamp(value: string): { raw: string; iso: string; ms: number; format: string } | undefined {
  const direct = findTimestamp(value);
  if (direct) return direct;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const epoch = parseEpoch(trimmed);
  if (epoch) return epoch;
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

const SEVERITY_ALIASES: Record<string, Severity> = {
  TRACE: 'TRACE',
  VERBOSE: 'TRACE',
  DEBUG: 'DEBUG',
  DBG: 'DEBUG',
  INFO: 'INFO',
  NOTICE: 'INFO',
  WARN: 'WARN',
  WARNING: 'WARN',
  ERROR: 'ERROR',
  ERR: 'ERROR',
  FATAL: 'FATAL',
  CRITICAL: 'FATAL',
  CRIT: 'FATAL',
  SEVERE: 'FATAL',
  EMERG: 'FATAL',
  ALERT: 'FATAL',
  PANIC: 'FATAL'
};
const SEVERITY_WORDS = Object.keys(SEVERITY_ALIASES).join('|');
// [warn] / (Error) in any case; bare uppercase words like ERROR or WARN:; logfmt level=error.
const SEVERITY_BRACKETED = new RegExp(`[\\[(]\\s*(${SEVERITY_WORDS})\\s*[\\])]`, 'i');
const SEVERITY_BARE = new RegExp(`\\b(${SEVERITY_WORDS})\\b:?`);
const SEVERITY_LOGFMT = new RegExp(`\\b(?:level|lvl|severity)=["']?(${SEVERITY_WORDS})\\b["']?`, 'i');

export function normaliseSeverity(value: string | undefined): Severity | undefined {
  if (!value) return undefined;
  return SEVERITY_ALIASES[value.trim().toUpperCase()];
}

function detectSeverity(line: string): { value: Severity; raw: string } | undefined {
  for (const pattern of [SEVERITY_BRACKETED, SEVERITY_LOGFMT, SEVERITY_BARE]) {
    const match = pattern.exec(line);
    const value = normaliseSeverity(match?.[1]);
    if (match && value) return { value, raw: match[0] };
  }
  return undefined;
}

function isSeverityToken(token: string): boolean {
  return normaliseSeverity(token) !== undefined;
}

function detectCategory(line: string, repeatedTokens = new Set<string>()): string | undefined {
  const bracketMatches = [...line.matchAll(/[\[(]([\p{L}][\p{L}\p{N}.-]{1,48})[\])]/gu)]
    .map((match) => match[1])
    .filter((token) => !/^\d+$/.test(token) && !isSeverityToken(token));
  if (bracketMatches[0]) return bracketMatches[0];

  const prefix = /^\s*(?:\S+\s+){0,4}?([\p{L}][\p{L}\p{N}.-]{1,48})\s*:\s+/u.exec(line)?.[1];
  if (prefix && !isSeverityToken(prefix)) return prefix;

  const token = firstMeaningfulToken(line);
  if (token && repeatedTokens.has(token) && !isSeverityToken(token)) return token;

  return undefined;
}

function firstMeaningfulToken(line: string): string | undefined {
  const cleaned = line.replace(TIMESTAMP_PATTERNS[0].pattern, '').trim();
  const match = /^\[?([\p{L}][\p{L}\p{N}.-]{1,48})\]?/u.exec(cleaned);
  return match?.[1];
}

function stripDetectedPrefix(line: string, timestampRaw?: string, category?: string, severityRaw?: string): string {
  let output = line;
  if (timestampRaw) output = output.replace(timestampRaw, '');
  if (severityRaw) output = output.replace(severityRaw, '');
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
  // reduce, not Math.max(...): spreading 100k+ arguments overflows the call stack.
  return records.reduce((max, record) => Math.max(max, record.fields.length), 1);
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

export function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value !== undefined && value !== null).map((value) => String(value).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function looksNumeric(value: string): boolean {
  return /^[-+]?\d+(?:[.,]\d+)?$/.test(value.trim());
}



