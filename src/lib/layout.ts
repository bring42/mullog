/**
 * Works out how a text file is laid out before it is parsed: which line format fits the body best,
 * and whether there are title/banner lines above it or totals/footer lines below it.
 * The result feeds both the automatic parse and the import setup dialog.
 */
import type { ImportSettings, LayoutAnalysis, LayoutCandidate, ParserMode, TextLayout } from './types';
import { findTimestamp, isJsonObject, parseSingleCsvLine, splitLines } from './parser';
import { mode, round } from './stats';

/** Lines sampled from the top of the file for detection. */
const HEAD_SAMPLE = 2000;
/** Lines sampled from the bottom when looking for footer junk. */
const TAIL_SAMPLE = 200;
/** A run of lines starting here must mostly fit the layout before it counts as the body. */
const STABLE_WINDOW = 8;
const STABLE_SHARE = 0.6;
/** More junk than this is more likely a misdetection than a header. */
const MAX_PREAMBLE = 200;
const MAX_TRAILER = 10;

export const DELIMITERS = [',', ';', '\t', '|'] as const;

export const LAYOUT_LABELS: Record<TextLayout, string> = {
  freeform: 'Plain log lines',
  delimited: 'Delimited columns (CSV/TSV)',
  json: 'JSON document',
  jsonl: 'JSON Lines',
  logfmt: 'key=value (logfmt)',
  access: 'Web access log (Apache/Nginx)',
  w3c: 'W3C / IIS log',
  syslog: 'Syslog'
};

export function delimiterName(delimiter: string | undefined): string {
  if (delimiter === '\t') return 'tab';
  if (delimiter === ',') return 'comma';
  if (delimiter === ';') return 'semicolon';
  if (delimiter === '|') return 'pipe';
  return delimiter ?? '';
}

// ── Line shapes ──────────────────────────────────────────────────────────────

/** Apache/Nginx common and combined log format. */
export const ACCESS_LINE =
  /^(\S+) (\S+) (\S+) \[([^\]]+)\] "((?:[^"\\]|\\.)*)" (\d{3}|-) (\d+|-)(?: "((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)")?(.*)$/;

/** RFC 5424: <PRI>1 TIMESTAMP HOST APP PROCID MSGID [SD] MSG */
export const SYSLOG_5424 = /^<(\d{1,3})>1 (\S+) (\S+) (\S+) (\S+) (\S+) (-|(?:\[(?:[^\]\\]|\\.)*\])+)(?: (.*))?$/;

/** RFC 3164 / classic /var/log/syslog: [<PRI>]Mmm dd hh:mm:ss host tag[pid]: msg (or an ISO time from rsyslog). */
export const SYSLOG_3164 =
  /^(?:<(\d{1,3})>)?([A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?) (\S+) ([^\s:[]+)(?:\[(\d+)\])?: ?(.*)$/;

const LOGFMT_PAIR = /([A-Za-z_][\w.\-/]*)=("(?:[^"\\]|\\.)*"|[^\s"]*)/g;

/** key=value pairs of a logfmt line, or undefined when the line isn't mostly pairs. */
export function logfmtPairs(line: string): Array<[string, string]> | undefined {
  const pairs: Array<[string, string]> = [];
  let covered = 0;
  for (const match of line.matchAll(LOGFMT_PAIR)) {
    const raw = match[2];
    const value = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(["\\])/g, '$1').replace(/\\n/g, '\n') : raw;
    pairs.push([match[1], value]);
    covered += match[0].length;
  }
  const meaningful = line.replace(/\s+/g, '').length;
  if (pairs.length < 2 || meaningful === 0) return undefined;
  // Spaces between pairs don't count against the line.
  return covered / meaningful >= 0.85 ? pairs : undefined;
}

export function isSyslogLine(line: string): boolean {
  return SYSLOG_5424.test(line) || SYSLOG_3164.test(line);
}

/** An odd number of double quotes opens or closes a quoted cell that continues on the next line. */
export function hasOddQuotes(line: string): boolean {
  let count = 0;
  for (let index = line.indexOf('"'); index !== -1; index = line.indexOf('"', index + 1)) count += 1;
  return count % 2 === 1;
}

/** Whether a quoted cell is still open at the start of line `end` (0-based). */
function quoteOpenBefore(lines: string[], end: number): boolean {
  let open = false;
  for (let index = 0; index < end; index += 1) if (hasOddQuotes(lines[index])) open = !open;
  return open;
}

const COMMENT_LINE = /^\s*(?:#|\/\/)/;
export function isCommentLine(line: string): boolean {
  return COMMENT_LINE.test(line);
}

/** Non-empty cells, ignoring empty cells at the end (a sheet's used range pads every row). */
export function filledWidth(cells: string[]): number {
  let end = cells.length;
  while (end > 0 && cells[end - 1].trim() === '') end -= 1;
  return end;
}

// ── Analysis ─────────────────────────────────────────────────────────────────

interface Fit {
  candidate: LayoutCandidate;
  /** 0-based index of the first body line. */
  start: number;
  /** 0-based index one past the last body line (only for layouts that can have footers). */
  end?: number;
  hasHeader?: boolean;
}

export interface AnalyseOptions {
  fileName: string;
  parserMode?: ParserMode;
}

/** Detects layout, header junk and footer junk of a text file. */
export function analyseText(text: string, options: AnalyseOptions): LayoutAnalysis {
  const lines = splitLines(text);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return analyseLines(lines, options);
}

export function analyseLines(lines: string[], options: AnalyseOptions): LayoutAnalysis {
  const lower = options.fileName.toLowerCase().replace(/\.gz$/, '');
  const ext = /\.([a-z0-9]+)$/.exec(lower)?.[1] ?? '';
  const head = lines.slice(0, HEAD_SAMPLE);
  const tailOffset = Math.max(head.length, lines.length - TAIL_SAMPLE);
  const tail = lines.slice(tailOffset);

  const fits: Fit[] = [];

  // W3C/IIS: the #Fields directive says it all.
  if (head.slice(0, 50).some((line) => /^#Fields:\s*\S/.test(line))) {
    fits.push({ candidate: { layout: 'w3c', label: LAYOUT_LABELS.w3c, confidence: 0.99, reason: 'Has a #Fields: directive naming the columns.' }, start: 0 });
  }

  // A whole JSON document, possibly after a few junk lines.
  const sampled = head.filter((line) => line.trim() !== '');
  const jsonStart = head.findIndex((line) => /^\s*[[{]/.test(line));
  if (jsonStart !== -1 && jsonStart <= MAX_PREAMBLE) {
    const body = lines.slice(jsonStart).join('\n');
    if (looksLikeJsonDocument(body)) {
      fits.push({ candidate: { layout: 'json', label: LAYOUT_LABELS.json, confidence: 0.98, reason: 'The file parses as one JSON document.' }, start: jsonStart });
    } else if (ext === 'json') {
      // Named .json but broken: still try it, so the parser can say what is wrong.
      fits.push({ candidate: { layout: 'json', label: LAYOUT_LABELS.json, confidence: 0.75, reason: 'Named .json, but it does not parse as JSON.' }, start: jsonStart });
    }
  }

  const lineFit = (layout: TextLayout, matches: (line: string) => boolean, what: string, footers = false): void => {
    const fit = fitByLines(head, tail, tailOffset, lines.length, matches, footers);
    if (!fit) return;
    fits.push({
      candidate: { layout, label: LAYOUT_LABELS[layout], confidence: round(fit.share * 0.97), reason: `${pct(fit.share)} of lines ${what}.` },
      start: fit.start,
      end: fit.end
    });
  };

  // One object on one line is a JSON document; JSON Lines needs at least two.
  if (sampled.length > 1) lineFit('jsonl', isJsonObject, 'are JSON objects');
  const mostlyJson = sampled.filter(isJsonObject).length >= sampled.length * 0.5;
  lineFit('access', (line) => ACCESS_LINE.test(line), 'match the Apache/Nginx access log format');
  lineFit('syslog', isSyslogLine, 'match the syslog format');
  // JSON objects split neatly on commas and look like pairs; don't offer those readings.
  if (!mostlyJson) {
    lineFit('logfmt', (line) => logfmtPairs(line) !== undefined, 'are key=value pairs');
    const tailStartsInQuote = quoteOpenBefore(lines, tailOffset);
    for (const delimiter of DELIMITERS) {
      const fit = delimitedFit(head, tail, tailOffset, lines.length, delimiter, tailStartsInQuote);
      if (fit) fits.push(fit);
    }
  }

  fits.push(freeformFit(head, ext));

  // File names and an explicit mode are strong hints.
  for (const fit of fits) {
    const { layout } = fit.candidate;
    if ((ext === 'csv' || ext === 'tsv' || ext === 'psv') && layout === 'delimited') fit.candidate.confidence += 0.15;
    if ((ext === 'jsonl' || ext === 'ndjson') && layout === 'jsonl') fit.candidate.confidence += 0.15;
    if (ext === 'json' && (layout === 'json' || layout === 'jsonl')) fit.candidate.confidence += 0.1;
    if (ext === 'tsv' && fit.candidate.delimiter === '\t') fit.candidate.confidence += 0.05;
    fit.candidate.confidence = round(Math.min(0.99, fit.candidate.confidence));
  }

  // Keep the best delimiter only: one "delimited" choice, with the delimiter as an option.
  const bestDelimited = fits.filter((fit) => fit.candidate.layout === 'delimited').sort(byConfidence)[0];
  const ranked = fits.filter((fit) => fit.candidate.layout !== 'delimited' || fit === bestDelimited).sort(byConfidence);

  const forced =
    options.parserMode === 'csv'
      ? ranked.find((fit) => fit.candidate.layout === 'delimited')
      : options.parserMode === 'txt'
        ? ranked.find((fit) => fit.candidate.layout === 'freeform')
        : undefined;
  const best = forced ?? ranked[0];
  const runnerUp = ranked.find((fit) => fit !== best);

  const skipStart = best.start;
  const skipEnd = best.end !== undefined ? lines.length - best.end : 0;
  const suggested: ImportSettings = {
    layout: best.candidate.layout,
    skipStart,
    skipEnd,
    ignoreComments: false,
    ...(best.candidate.delimiter ? { delimiter: best.candidate.delimiter } : {}),
    ...(best.hasHeader !== undefined ? { hasHeader: best.hasHeader } : {})
  };

  const reasons: string[] = [];
  const junkTop = head.slice(0, skipStart).filter((line) => line.trim() !== '').length;
  const junkBottom = skipEnd > 0 ? lines.slice(lines.length - skipEnd).filter((line) => line.trim() !== '').length : 0;
  if (junkTop > 0) reasons.push(junkMessage('first', skipStart, 'line', "don't look like the rest of the file"));
  if (junkBottom > 0) reasons.push(junkMessage('last', skipEnd, 'line', 'look like a footer'));
  if (!forced && runnerUp && runnerUp.candidate.confidence >= best.candidate.confidence - 0.06 && runnerUp.candidate.confidence >= 0.5) {
    reasons.push(`It could be read as ${best.candidate.label.toLowerCase()} or as ${runnerUp.candidate.label.toLowerCase()}.`);
  }
  if (!forced && best.candidate.confidence < 0.5 && lines.length > 1) reasons.push('No layout fits the file well.');

  return {
    totalLines: lines.length,
    candidates: ranked.map((fit) => fit.candidate),
    suggested,
    unclear: reasons.length > 0,
    reasons,
    sampleLine: sampleLine(lines, skipStart, lines.length - skipEnd)
  };
}

/**
 * Spreadsheet rows: always a table, but reports and exports often put a title block above it and
 * totals below it. Row numbers are the sheet's own.
 */
export function analyseSheetRows(rows: string[][], rowNumbers: number[]): LayoutAnalysis {
  const widths = rows.map(filledWidth);
  const modeWidth = mode(widths.filter((width) => width > 1));
  const matches = (index: number) => widths[index] >= Math.max(2, Math.ceil(modeWidth * 0.6));
  const fit = modeWidth > 1 ? fitByIndex(rows.length, matches, true) : undefined;
  const startIndex = fit?.start ?? 0;
  const endIndex = fit?.end ?? rows.length;
  const lastRow = rowNumbers[rowNumbers.length - 1] ?? rows.length;
  const skipStart = startIndex > 0 ? (rowNumbers[startIndex] ?? 1) - 1 : 0;
  const skipEnd = endIndex < rows.length ? lastRow - (rowNumbers[endIndex - 1] ?? lastRow) : 0;
  const reasons: string[] = [];
  if (skipStart > 0) reasons.push(junkMessage('first', skipStart, 'row', 'look like a title block above the table'));
  if (skipEnd > 0) reasons.push(junkMessage('last', skipEnd, 'row', 'look like totals or notes below the table'));
  const middle = Math.floor((startIndex + endIndex) / 2);
  return {
    totalLines: lastRow,
    candidates: [{ layout: 'delimited', label: 'Table', confidence: 0.99, reason: 'Spreadsheet cells.' }],
    suggested: { layout: 'delimited', skipStart, skipEnd, ignoreComments: false },
    unclear: reasons.length > 0,
    reasons,
    sampleLine: rowNumbers[Math.min(Math.max(middle, startIndex + 1), endIndex - 1)]
  };
}

function freeformFit(head: string[], ext: string): Fit {
  const nonEmpty = head.filter((line) => line.trim() !== '');
  const stamped = nonEmpty.map((line) => findTimestamp(line) !== undefined);
  const share = nonEmpty.length ? stamped.filter(Boolean).length / nonEmpty.length : 0;
  // Plain lines always work, so this is the bar the structured layouts have to clear.
  const confidence = ext === 'log' || ext === 'txt' ? 0.82 : 0.72;
  let start = 0;
  // Banner lines above a timestamped log: only when most lines carry a timestamp.
  if (share >= 0.6) {
    const first = head.findIndex((line) => line.trim() !== '' && findTimestamp(line) !== undefined);
    const before = head.slice(0, Math.max(first, 0)).filter((line) => line.trim() !== '');
    if (first > 0 && first <= MAX_PREAMBLE && before.every((line) => !/^\s/.test(line))) start = first;
  }
  const reason = share > 0 ? `Read line by line; ${pct(share)} of lines have a timestamp.` : 'Read line by line; no timestamps found.';
  return { candidate: { layout: 'freeform', label: LAYOUT_LABELS.freeform, confidence, reason }, start };
}

/**
 * Lines inside a quoted cell that spans lines continue the record above. Stand in the record's
 * first line for them, so they are judged like the record they belong to and not as junk.
 */
function joinQuotedContinuations(lines: string[], startsInQuote = false): string[] {
  let inQuote = startsInQuote;
  let recordStart = '';
  return lines.map((line) => {
    const view = inQuote ? recordStart : line;
    if (!inQuote) recordStart = line;
    if (hasOddQuotes(line)) inQuote = !inQuote;
    return view;
  });
}

function delimitedFit(
  rawHead: string[],
  rawTail: string[],
  tailOffset: number,
  total: number,
  delimiter: string,
  tailStartsInQuote: boolean
): Fit | undefined {
  const head = joinQuotedContinuations(rawHead);
  // The tail sample starts mid-file: carry the quote state over, or a cell spanning the cut flips every line after it.
  const tail = joinQuotedContinuations(rawTail, tailStartsInQuote);
  const widthOf = (line: string) => (line.trim() === '' ? 0 : filledWidth(parseSingleCsvLine(line, delimiter)));
  const widths = head.map(widthOf);
  const modeWidth = mode(widths.filter((width) => width > 1));
  if (modeWidth < 2) return undefined;
  const matches = (line: string) => {
    const width = widthOf(line);
    return width >= Math.max(2, Math.ceil(modeWidth * 0.6)) && width <= modeWidth + 1;
  };
  const fit = fitByLines(head, tail, tailOffset, total, matches, true);
  if (!fit) return undefined;
  const body = head.slice(fit.start, fit.end !== undefined ? Math.min(fit.end, head.length) : head.length).filter((line) => line.trim() !== '');
  const exact = body.filter((line) => widthOf(line) === modeWidth).length / Math.max(body.length, 1);
  const confidence = Math.min(0.98, fit.share * 0.55 + exact * 0.35 + Math.min(modeWidth / 12, 0.1));
  return {
    candidate: {
      layout: 'delimited',
      label: LAYOUT_LABELS.delimited,
      confidence: round(confidence),
      delimiter,
      reason: `${pct(exact)} of lines split into ${modeWidth} columns on ${delimiterName(delimiter)}.`
    },
    start: fit.start,
    end: fit.end
  };
}

/**
 * Where the body starts (and, with `footers`, ends): the first line that fits and is followed by
 * mostly fitting lines. Returns the share of body lines that fit.
 */
function fitByLines(
  head: string[],
  tail: string[],
  tailOffset: number,
  total: number,
  matches: (line: string) => boolean,
  footers = false
): { start: number; end?: number; share: number } | undefined {
  const headFit = fitByIndex(head.length, (index) => matches(head[index]), footers && tail.length === 0, (index) => head[index].trim() === '');
  if (!headFit) return undefined;
  let end = headFit.end;
  if (footers && tail.length > 0) {
    const tailFit = fitByIndex(tail.length, (index) => matches(tail[index]), true, (index) => tail[index].trim() === '');
    end = tailFit?.end !== undefined ? tailOffset + tailFit.end : total;
  }
  const bodyEnd = Math.min(end ?? head.length, head.length);
  const body = head.slice(headFit.start, bodyEnd).filter((line) => line.trim() !== '');
  const share = body.filter(matches).length / Math.max(body.length, 1);
  return { start: headFit.start, end: end !== undefined && end < total ? end : undefined, share };
}

function fitByIndex(
  length: number,
  matches: (index: number) => boolean,
  footers: boolean,
  blank: (index: number) => boolean = () => false
): { start: number; end?: number } | undefined {
  const nonEmpty: number[] = [];
  for (let index = 0; index < length; index += 1) if (!blank(index)) nonEmpty.push(index);
  if (nonEmpty.length === 0) return undefined;
  const window = Math.min(STABLE_WINDOW, nonEmpty.length);
  const stableAt = (position: number, direction: 1 | -1): boolean => {
    // Lines past the end of the file count as misses, so a lone match at the very end isn't "stable".
    let hits = 0;
    for (let step = 0; step < window; step += 1) {
      const index = nonEmpty[position + step * direction];
      if (index !== undefined && matches(index)) hits += 1;
    }
    return hits / window >= STABLE_SHARE;
  };

  let startPosition = -1;
  for (let position = 0; position < nonEmpty.length && position <= MAX_PREAMBLE; position += 1) {
    if (matches(nonEmpty[position]) && stableAt(position, 1)) {
      startPosition = position;
      break;
    }
  }
  // Junk is a few lines around the data, never most of the file.
  if (startPosition === -1 || startPosition > nonEmpty.length / 2) return undefined;
  // Keep blank lines just above the body out of the skipped range only if junk precedes them.
  const start = startPosition === 0 ? 0 : nonEmpty[startPosition];

  if (!footers) return { start };
  let endPosition = nonEmpty.length - 1;
  for (let position = nonEmpty.length - 1; position > startPosition && nonEmpty.length - 1 - position <= MAX_TRAILER; position -= 1) {
    if (matches(nonEmpty[position]) && stableAt(position, -1)) {
      endPosition = position;
      break;
    }
    endPosition = position - 1;
  }
  const trailing = nonEmpty.length - 1 - endPosition;
  if (trailing === 0 || trailing > MAX_TRAILER) return { start };
  return { start, end: nonEmpty[endPosition] + 1 };
}

function looksLikeJsonDocument(text: string): boolean {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed) || !/[\]}]$/.test(trimmed)) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function sampleLine(lines: string[], start: number, end: number): number | undefined {
  if (end <= start) return undefined;
  // Prefer a line a little way into the body: past any header row, but within the head sample.
  const from = Math.min(start + Math.min(40, Math.max(2, Math.floor((Math.min(end, HEAD_SAMPLE) - start) / 3))), end - 1);
  for (let index = from; index < end; index += 1) if (lines[index]?.trim()) return index + 1;
  for (let index = from - 1; index >= start; index -= 1) if (lines[index]?.trim()) return index + 1;
  return undefined;
}

function byConfidence(a: Fit, b: Fit): number {
  return b.candidate.confidence - a.candidate.confidence;
}


function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** "The first 3 lines look like …, so they are skipped." with singular forms for one. */
function junkMessage(edge: 'first' | 'last', count: number, word: string, looks: string): string {
  if (count > 1) return `The ${edge} ${count} ${word}s ${looks}, so they are skipped.`;
  const singular = looks.replace("don't look", "doesn't look").replace(/^look /, 'looks ');
  return `The ${edge} ${word} ${singular}, so it is skipped.`;
}

