export type EncodingName = 'utf-8' | 'windows-1252' | 'iso-8859-1';
export type ParserMode = 'auto' | 'csv' | 'txt';
export type DetectedType = 'csv' | 'txt' | 'unknown';
export type ViewMode = 'raw' | 'structured' | 'hybrid';
export type Severity = 'FATAL' | 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'TRACE' | 'UNKNOWN';
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
  schema: ColumnMeta[];
  timestampFormat?: string;
  timestampConfidence?: number;
  severityLevels: Severity[];
  categories: string[];
  rowCount: number;
  warnings: ParseWarning[];
  assumptions: DetectionAssumption[];
}

export interface LogRow {
  id: string;
  lineNumber: number;
  rawLine: string;
  fields: Record<string, string>;
  timestamp?: string;
  timestampRaw?: string;
  timestampMs?: number;
  severity: Severity;
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
  severities: Severity[];
  categories: string[];
  from: string;
  to: string;
  columnFilters: Record<string, string[]>;
}

export interface FilterFacets {
  severities: Array<{ value: Severity; count: number }>;
  categories: Array<{ value: string; count: number }>;
  columns: Array<{ column: string; values: Array<{ value: string; count: number }> }>;
}
