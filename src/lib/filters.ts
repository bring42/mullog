import { normaliseSeverity } from './parser';
import type { ColumnMeta, FilterFacets, FilterState, LogRow } from './types';

export const emptyFilters: FilterState = {
  search: '',
  categories: [],
  from: '',
  to: '',
  columnFilters: {}
};

// Lower-cased search text per row. Rows are not changed after parsing, so it is built on the first
// search and reused for every later keystroke and facet count (several full passes per keystroke).
const searchTexts = new WeakMap<LogRow, string>();

function searchText(row: LogRow): string {
  let text = searchTexts.get(row);
  if (text === undefined) {
    text = [row.rawLine, row.category, ...Object.values(row.fields)].join('\n').toLowerCase();
    searchTexts.set(row, text);
  }
  return text;
}

export function applyFilters(rows: LogRow[], filters: FilterState): LogRow[] {
  const search = filters.search.trim().toLowerCase();
  const fromMs = filters.from ? Date.parse(filters.from) : undefined;
  const toMs = filters.to ? Date.parse(filters.to) : undefined;

  return rows.filter((row) => {
    if (search && !searchText(row).includes(search)) return false;

    if (filters.categories.length > 0 && !filters.categories.includes(row.category)) return false;

    if (fromMs && (!row.timestampMs || row.timestampMs < fromMs)) return false;
    if (toMs && (!row.timestampMs || row.timestampMs > toMs)) return false;

    for (const [column, selectedValues] of Object.entries(filters.columnFilters)) {
      if (selectedValues.length === 0) continue;
      if (!selectedValues.includes(row.fields[column] ?? '')) return false;
    }

    return true;
  });
}

const SEVERITY_ORDER = ['FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];
const MAX_FACET_VALUES = 30;

/** Columns worth offering as checklists: severity, category, and other low-cardinality columns. */
export function facetColumnsFor(schema: ColumnMeta[]): string[] {
  const rank = (column: ColumnMeta) => (column.role === 'severity' ? 0 : column.role === 'category' ? 1 : 2);
  return schema
    .filter((column) => {
      if (column.role === 'raw' || column.role === 'lineNumber' || column.role === 'message' || column.role === 'timestamp') return false;
      const limit = column.role === 'severity' || column.role === 'category' ? 50 : MAX_FACET_VALUES;
      if (column.uniqueCount < 2 || column.uniqueCount > limit) return false;
      return column.role === 'severity' || column.role === 'category' || column.isCategorical;
    })
    .sort((a, b) => rank(a) - rank(b) || a.index - b.index)
    .map((column) => column.name);
}

/**
 * Facet options come from every row so they never disappear, but each count reflects
 * the other active filters (search, time, other facets) - excluding the facet's own selection.
 */
export function buildFacets(rows: LogRow[], filters: FilterState, facetColumns: string[], severityColumn?: string): FilterFacets {
  const categories = facetTotals(rows, '\u0000category', () => countValues(rows.map((row) => row.category))).map((item) => ({ ...item }));
  // A facet with no selection of its own is counted against the full filter result, which is shared.
  let sharedMatches: LogRow[] | undefined;
  const columns = facetColumns.map((column) => {
    const totals = facetTotals(rows, column, () =>
      countValues(rows.map((row) => row.fields[column] ?? '').filter((value) => value !== ''))
    );
    const ownSelection = (filters.columnFilters[column] ?? []).length > 0;
    const withoutSelf: FilterState = { ...filters, columnFilters: { ...filters.columnFilters, [column]: [] } };
    const matches = ownSelection ? applyFilters(rows, withoutSelf) : (sharedMatches ??= applyFilters(rows, withoutSelf));
    const live = new Map(
      countValues(matches.map((row) => row.fields[column] ?? '').filter((value) => value !== '')).map((item) => [
        item.value,
        item.count
      ])
    );
    const values = totals.map((item) => ({ value: item.value, total: item.count, count: live.get(item.value) ?? 0 }));
    if (column === severityColumn) values.sort((a, b) => severityRank(a.value) - severityRank(b.value));
    return { column, values };
  });

  return { categories, columns };
}

// Facet totals ignore the filters, so they are counted once per rows array rather than on every keystroke.
const totalsCache = new WeakMap<LogRow[], Map<string, Array<{ value: string; count: number }>>>();

function facetTotals(rows: LogRow[], key: string, count: () => Array<{ value: string; count: number }>): Array<{ value: string; count: number }> {
  let byKey = totalsCache.get(rows);
  if (!byKey) {
    byKey = new Map();
    totalsCache.set(rows, byKey);
  }
  let totals = byKey.get(key);
  if (!totals) {
    totals = count();
    byKey.set(key, totals);
  }
  return totals;
}

function severityRank(value: string): number {
  const index = SEVERITY_ORDER.indexOf(normaliseSeverity(value) ?? '');
  return index === -1 ? SEVERITY_ORDER.length : index;
}

export interface TextSegment {
  text: string;
  match: boolean;
}

/**
 * Split a cell value into plain/matched segments for highlighting. When the first match sits
 * far into the text, lead with an ellipsis so the match is visible in a truncated cell.
 */
export function highlightSegments(value: string, query: string, lead = 48, context = 24): TextSegment[] {
  const needle = query.trim().toLowerCase();
  if (!needle || !value) return [{ text: value, match: false }];
  const lower = value.toLowerCase();
  const first = lower.indexOf(needle);
  if (first === -1) return [{ text: value, match: false }];

  let offset = 0;
  const segments: TextSegment[] = [];
  if (first > lead) {
    offset = first - Math.min(context, lead);
    segments.push({ text: '…', match: false });
  }

  let cursor = offset;
  let index = first;
  while (index !== -1) {
    if (index > cursor) segments.push({ text: value.slice(cursor, index), match: false });
    segments.push({ text: value.slice(index, index + needle.length), match: true });
    cursor = index + needle.length;
    index = lower.indexOf(needle, cursor);
  }
  if (cursor < value.length) segments.push({ text: value.slice(cursor), match: false });
  return segments;
}

/** One removable active filter, as shown in the chip bar above the table. */
export type FilterToken =
  | { kind: 'search'; value: string }
  | { kind: 'category'; value: string }
  | { kind: 'from'; value: string }
  | { kind: 'to'; value: string }
  | { kind: 'column'; column: string; value: string };

export function describeActiveFilters(filters: FilterState): FilterToken[] {
  const tokens: FilterToken[] = [];
  const search = filters.search.trim();
  if (search) tokens.push({ kind: 'search', value: search });
  filters.categories.forEach((value) => tokens.push({ kind: 'category', value }));
  if (filters.from) tokens.push({ kind: 'from', value: filters.from });
  if (filters.to) tokens.push({ kind: 'to', value: filters.to });
  Object.entries(filters.columnFilters).forEach(([column, values]) => {
    values.forEach((value) => tokens.push({ kind: 'column', column, value }));
  });
  return tokens;
}

/** Stable key for keyed {#each} blocks. */
export function filterTokenKey(token: FilterToken): string {
  return token.kind === 'column' ? `column\u0000${token.column}\u0000${token.value}` : `${token.kind}\u0000${token.value}`;
}

/**
 * Human-readable chip text, split so the UI can de-emphasise the key:
 * `"timeout"`, `severity: ERROR`, `From 2024-03-05 08:00`.
 */
export function filterTokenLabel(token: FilterToken): { key: string; value: string } {
  switch (token.kind) {
    case 'search':
      return { key: '', value: `“${token.value}”` };
    case 'category':
      return { key: 'category:', value: token.value || '(empty)' };
    case 'from':
      return { key: 'From', value: formatLocalDateTime(token.value) };
    case 'to':
      return { key: 'Until', value: formatLocalDateTime(token.value) };
    case 'column':
      return { key: `${token.column}:`, value: token.value || '(empty)' };
  }
}

/** `2024-03-05T08:00` (a datetime-local value) → `2024-03-05 08:00`. */
function formatLocalDateTime(value: string): string {
  return value.replace('T', ' ');
}

export function clearFilterToken(filters: FilterState, token: FilterToken): FilterState {
  switch (token.kind) {
    case 'search':
      return { ...filters, search: '' };
    case 'category':
      return { ...filters, categories: filters.categories.filter((category) => category !== token.value) };
    case 'from':
      return { ...filters, from: '' };
    case 'to':
      return { ...filters, to: '' };
    case 'column':
      return {
        ...filters,
        columnFilters: {
          ...filters.columnFilters,
          [token.column]: (filters.columnFilters[token.column] ?? []).filter((selected) => selected !== token.value)
        }
      };
  }
}

/** What the table currently shows: its columns in display order and which column plays which role. */
export interface TableView {
  columns: string[];
  timestampColumn?: string;
  severityColumn?: string;
  messageColumn?: string;
}

/** Timestamp, then severity, then everything else, with the message last so it can fill the row. */
export function orderColumns(all: string[], visible: string[], roles: Omit<TableView, 'columns'>): string[] {
  const shown = all.filter((column) => visible.includes(column));
  const lead = [roles.timestampColumn, roles.severityColumn].filter((column): column is string => !!column && shown.includes(column));
  const tail = roles.messageColumn && shown.includes(roles.messageColumn) ? [roles.messageColumn] : [];
  return [...lead, ...shown.filter((column) => !lead.includes(column) && !tail.includes(column)), ...tail];
}

/** A cell as the table shows it: timestamps as written in the file. */
export function cellValue(row: LogRow, column: string, roles: Omit<TableView, 'columns'>): string {
  if (column === roles.timestampColumn && row.timestampRaw) return row.timestampRaw;
  return row.fields[column] ?? '';
}

/**
 * Header row plus one string array per log row; shared by every export.
 * With a view, the columns are the ones the table shows, in the same order, plus the line number.
 * Merged multi-line messages export in full. Without a view, every parsed field and the raw line.
 */
export function rowsToTable(rows: LogRow[], view?: TableView): string[][] {
  if (view) {
    const columns = view.columns.length > 0 ? view.columns : ['raw_line'];
    const value = (row: LogRow, column: string) => {
      if (column === view.messageColumn && row.fullMessage) return row.fullMessage;
      if (column === 'raw_line' && !(column in row.fields)) return row.rawLine;
      return cellValue(row, column, view);
    };
    const lineHeader = columns.includes('line') ? '#' : 'line';
    return [[lineHeader, ...columns], ...rows.map((row) => [String(row.lineNumber), ...columns.map((column) => value(row, column))])];
  }
  const reserved = new Set(['line_number', 'timestamp', 'severity', 'category', 'raw']);
  const fieldNames = [...new Set(rows.flatMap((row) => Object.keys(row.fields)))].filter((name) => !reserved.has(name));
  const headers = ['line_number', 'timestamp_iso', 'timestamp_raw', 'severity', 'category', ...fieldNames, 'raw_line'];
  return [headers, ...rows.map((row) => headers.map((header) => valueForHeader(row, header)))];
}

export function rowsToCsv(rows: LogRow[]): string {
  return rowsToTable(rows)
    .map((row) => row.map((cell) => escapeCsv(cell)).join(','))
    .join('\n');
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function countValues(values: string[]): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  values.forEach((value) => {
    const key = value || 'UNKNOWN';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function valueForHeader(row: LogRow, header: string): string {
  if (header === 'line_number') return String(row.lineNumber);
  if (header === 'timestamp_iso') return row.timestamp ?? '';
  if (header === 'timestamp_raw') return row.timestampRaw ?? '';
  if (header === 'severity') return row.severity ?? row.fields.severity ?? '';
  if (header === 'category') return row.category;
  if (header === 'raw_line') return row.rawLine;
  return row.fields[header] ?? '';
}

/**
 * Quotes a CSV cell and defuses spreadsheet formula injection: a cell starting with
 * = + - @ tab or CR is run as a formula by Excel/LibreOffice, so it gets a leading `'`.
 * Plain numbers such as -5 or +3.2 are left alone.
 */
export function escapeCsv(value: string, delimiter = ','): string {
  const safe = /^[=+\-@\t\r]/.test(value) && !/^[+-]?\d+([.,]\d+)?$/.test(value) ? `'${value}` : value;
  if (/["\n\r]/.test(safe) || safe.includes(delimiter)) return `"${safe.replaceAll('"', '""')}"`;
  return safe;
}
