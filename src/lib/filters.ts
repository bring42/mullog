import type { FilterFacets, FilterState, LogRow } from './types';

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

export function buildFacets(rows: LogRow[]): FilterFacets {
  const categories = countValues(rows.map((row) => row.category));
  const columnNames = [...new Set(rows.flatMap((row) => Object.keys(row.fields)))];
  const columns = columnNames
    .map((column) => ({
      column,
      values: countValues(rows.map((row) => row.fields[column] ?? '').filter((value) => value !== '')).slice(0, 50)
    }))
    .filter((column) => column.values.length > 1 && column.values.length <= 50);

  return { categories, columns };
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
  const reserved = new Set(['line_number', 'timestamp', 'category', 'raw']);
  const fieldNames = [...new Set(rows.flatMap((row) => Object.keys(row.fields)))].filter((name) => !reserved.has(name));
  const headers = ['line_number', 'timestamp_iso', 'timestamp_raw', 'category', ...fieldNames, 'raw_line'];
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
  if (header === 'category') return row.category;
  if (header === 'raw_line') return row.rawLine;
  return row.fields[header] ?? '';
}

function escapeCsv(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}
