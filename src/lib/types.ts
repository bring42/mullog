export type EncodingName = 'utf-8' | 'windows-1252' | 'iso-8859-1';
export type ParserMode = 'auto' | 'csv' | 'txt';
export type SpreadsheetType = 'xlsx' | 'xls' | 'ods';
export type DetectedType = 'csv' | 'txt' | 'json' | 'jsonl' | 'logfmt' | 'access' | 'w3c' | 'syslog' | SpreadsheetType | 'unknown';

/** How the lines of a text file are read. */
export type TextLayout = 'freeform' | 'delimited' | 'json' | 'jsonl' | 'logfmt' | 'access' | 'w3c' | 'syslog';

/**
 * What to read and how: the user can adjust these in the import setup. Line numbers are 1-based
 * and refer to the original file (spreadsheet row numbers for workbooks).
 */
export interface ImportSettings {
  layout: TextLayout;
  /** Lines at the top to ignore (title, banner, report header…). */
  skipStart: number;
  /** Lines at the bottom to ignore (totals, footers…). */
  skipEnd: number;
  /** Drop lines starting with # or // (text files only). */
  ignoreComments: boolean;
  /** Delimited layout only. */
  delimiter?: string;
  /** Delimited layout and spreadsheets: whether the first kept line holds column names. Undefined = detect. */
  hasHeader?: boolean;
}

export interface LayoutCandidate {
  layout: TextLayout;
  label: string;
  /** 0–1: how well the sampled body lines fit this layout. */
  confidence: number;
  delimiter?: string;
  /** Why this layout was or wasn't a good fit, in plain words. */
  reason: string;
}

/** A line (or sheet row) of the file as shown in the import setup's line picker. */
export interface PreviewLine {
  number: number;
  text: string;
}

export interface LayoutAnalysis {
  totalLines: number;
  candidates: LayoutCandidate[];
  suggested: ImportSettings;
  /** True when the user should look at the setup: junk lines found, or no clear winner. */
  unclear: boolean;
  /** Why the setup is worth a look. */
  reasons: string[];
  /** A typical body line (1-based), used to compare layouts on real data. */
  sampleLine?: number;
}
export type Severity = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
export type WarningLevel = 'error' | 'warning' | 'info';

export interface ParseWarning {
  id: string;
  type:
    | 'malformed-row'
    | 'unknown-encoding-confidence'
    | 'empty-line'
    | 'continuation-line'
    | 'assumption'
    | 'parser';
  level: WarningLevel;
  message: string;
  lineNumber?: number;
}

export interface ColumnMeta {
  name: string;
  index: number;
  inferredType: 'string' | 'number' | 'date' | 'boolean' | 'mixed' | 'empty';
  uniqueCount: number;
  emptyCount: number;
  sampleValues: string[];
  isCategorical: boolean;
  role?: 'timestamp' | 'severity' | 'category' | 'message' | 'raw' | 'lineNumber';
}

export interface DetectionAssumption {
  label: string;
  value: string;
  confidence: number;
  locked?: boolean;
}

export interface DetectionState {
  fileName: string;
  fileSize: number;
  detectedType: DetectedType;
  parserMode: ParserMode;
  encoding: EncodingName;
  encodingConfidence: number;
  encodingNotes: string[];
  delimiter?: string;
  delimiterConfidence?: number;
  hasHeader?: boolean;
  /** Workbook sheet currently shown, and all sheet names (spreadsheets only). */
  sheetName?: string;
  sheetNames?: string[];
  schema: ColumnMeta[];
  timestampFormat?: string;
  timestampConfidence?: number;
  categories: string[];
  rowCount: number;
  warnings: ParseWarning[];
  assumptions: DetectionAssumption[];
  /** The import settings this result was parsed with. */
  settings?: ImportSettings;
  /** Lines/rows left out by those settings. */
  skippedLines?: number;
}

export interface LogRow {
  id: string;
  /** First physical line of the entry (1-based). */
  lineNumber: number;
  /** Last physical line when continuation lines were merged into this row. */
  lineEnd?: number;
  /** Every physical line of the entry, joined with \n. */
  rawLine: string;
  fields: Record<string, string>;
  timestamp?: string;
  timestampRaw?: string;
  timestampMs?: number;
  /** Normalised level: TRACE, DEBUG, INFO, WARN, ERROR or FATAL. */
  severity?: Severity;
  /** Full multi-line message (first-line message plus continuation lines); `fields.message` keeps the first line. */
  fullMessage?: string;
  category: string;
  source?: string;
  notes: string[];
  malformed?: boolean;
}

export interface ParseResult {
  detection: DetectionState;
  rows: LogRow[];
}

export interface FilterState {
  search: string;
  categories: string[];
  from: string;
  to: string;
  columnFilters: Record<string, string[]>;
}

export interface FilterFacets {
  categories: Array<{ value: string; count: number }>;
  columns: Array<{ column: string; values: Array<{ value: string; count: number; total: number }> }>;
}
