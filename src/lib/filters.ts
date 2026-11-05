import { normaliseSeverity } from './parser';
import type { ColumnMeta, FilterFacets, FilterState, LogRow } from './types';

export const emptyFilters: FilterState = {
  search: '',
  categories: [],
  from: '',
  to: '',
  columnFilters: {}
};

export function applyFilters(rows: LogRow[], filters: FilterState): LogRow[] {
  const search = filters.search.trim().toLowerCase();
  const fromMs = filters.from ? Date.parse(filters.from) : undefined;
  const toMs = filters.to ? Date.parse(filters.to) : undefined;

  return rows.filter((row) => {
    if (search) {
      const haystack = [row.rawLine, row.category, ...Object.values(row.fields)].join('\n').toLowerCase();
      if (!haystack.includes(search)) return false;
    }

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
  const categories = countValues(rows.map((row) => row.category));
  const columns = facetColumns.map((column) => {
    const totals = countValues(rows.map((row) => row.fields[column] ?? '').filter((value) => value !== ''));
    const withoutSelf: FilterState = { ...filters, columnFilters: { ...filters.columnFilters, [column]: [] } };
    const live = new Map(
      countValues(applyFilters(rows, withoutSelf).map((row) => row.fields[column] ?? '').filter((value) => value !== '')).map((item) => [
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

export function describeActiveFilters(filters: FilterState): string[] {
  const tokens: string[] = [];
  if (filters.search.trim()) tokens.push(`search:${filters.search.trim()}`);
  filters.categories.forEach((category) => tokens.push(`category:${category}`));
  if (filters.from) tokens.push(`from:${filters.from}`);
  if (filters.to) tokens.push(`to:${filters.to}`);
  Object.entries(filters.columnFilters).forEach(([column, values]) => {
    values.forEach((value) => tokens.push(`${column}:${value}`));
  });
  return tokens;
}

export function clearFilterToken(filters: FilterState, token: string): FilterState {
  if (token.startsWith('search:')) return { ...filters, search: '' };
  if (token.startsWith('category:')) {
    const value = token.replace('category:', '');
    return { ...filters, categories: filters.categories.filter((category) => category !== value) };
  }
  if (token.startsWith('from:')) return { ...filters, from: '' };
  if (token.startsWith('to:')) return { ...filters, to: '' };

  const separator = token.indexOf(':');
  if (separator > -1) {
    const column = token.slice(0, separator);
    const value = token.slice(separator + 1);
    return {
      ...filters,
      columnFilters: {
        ...filters.columnFilters,
        [column]: (filters.columnFilters[column] ?? []).filter((selected) => selected !== value)
      }
    };
  }

  return filters;
}

export function rowsToCsv(rows: LogRow[]): string {
  const reserved = new Set(['line_number', 'timestamp', 'severity', 'category', 'raw']);
  const fieldNames = [...new Set(rows.flatMap((row) => Object.keys(row.fields)))].filter((name) => !reserved.has(name));
  const headers = ['line_number', 'timestamp_iso', 'timestamp_raw', 'severity', 'category', ...fieldNames, 'raw_line'];
  const csvRows = [headers, ...rows.map((row) => headers.map((header) => valueForHeader(row, header)))];
  return csvRows.map((row) => row.map(escapeCsv).join(',')).join('\n');
}

export function downloadCsv(rows: LogRow[], fileName = 'filtered-log-export.csv'): void {
  const csv = rowsToCsv(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
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

function escapeCsv(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}
