import type { LogRow } from './types';
import { escapeCsv, rowsToTable, type TableView } from './filters';

export type ExportFormatId = 'csv' | 'csv-excel' | 'tsv' | 'xlsx' | 'ods' | 'json' | 'jsonl' | 'md' | 'log';

export interface ExportFormat {
  id: ExportFormatId;
  label: string;
  extension: string;
  group: 'Spreadsheet' | 'Data' | 'Text';
  /** One line shown under the label in the menu. */
  hint: string;
}

export interface ExportResult {
  blob: Blob;
  /** Things the user should know about the file, e.g. truncated cells. */
  notes: string[];
}

export const EXPORT_FORMATS: ExportFormat[] = [
  { id: 'xlsx', label: 'Excel', extension: 'xlsx', group: 'Spreadsheet', hint: 'Microsoft Excel workbook' },
  { id: 'ods', label: 'OpenDocument', extension: 'ods', group: 'Spreadsheet', hint: 'LibreOffice / Numbers / Google Sheets' },
  { id: 'csv', label: 'CSV', extension: 'csv', group: 'Spreadsheet', hint: 'Comma-separated, opens anywhere' },
  {
    id: 'csv-excel',
    label: 'CSV with semicolons',
    extension: 'csv',
    group: 'Spreadsheet',
    hint: 'For Excel in Swedish, German and other languages that write 1,5'
  },
  { id: 'tsv', label: 'TSV', extension: 'tsv', group: 'Spreadsheet', hint: 'Tab-separated' },
  { id: 'json', label: 'JSON', extension: 'json', group: 'Data', hint: 'Array of objects' },
  { id: 'jsonl', label: 'JSON Lines', extension: 'jsonl', group: 'Data', hint: 'One object per line' },
  { id: 'md', label: 'Markdown table', extension: 'md', group: 'Text', hint: 'For tickets, wikis and chat' },
  { id: 'log', label: 'Original lines', extension: 'log', group: 'Text', hint: 'The matching lines as they were in the file' }
];

const MIME: Record<ExportFormatId, string> = {
  csv: 'text/csv;charset=utf-8',
  'csv-excel': 'text/csv;charset=utf-8',
  tsv: 'text/tab-separated-values;charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  json: 'application/json;charset=utf-8',
  jsonl: 'application/x-ndjson;charset=utf-8',
  md: 'text/markdown;charset=utf-8',
  log: 'text/plain;charset=utf-8'
};

/** Excel reads CSV as the system code page (å ä ö turn into mojibake) unless the file starts with a BOM. */
const BOM = '﻿';

/**
 * Builds the export file. With a view, the columns match what the table shows; "Original lines"
 * always writes the raw lines.
 */
export async function buildExport(format: ExportFormatId, rows: LogRow[], view?: TableView): Promise<ExportResult> {
  const text = (value: string): ExportResult => ({ blob: new Blob([value], { type: MIME[format] }), notes: [] });
  const table = () => rowsToTable(rows, view);
  switch (format) {
    case 'csv':
      return text(BOM + delimitedText(table(), ','));
    case 'csv-excel':
      return text(BOM + delimitedText(table(), ';'));
    case 'tsv':
      return text(delimitedText(table(), '\t'));
    case 'json':
      return text(JSON.stringify(tableToObjects(table()), null, 2));
    case 'jsonl':
      return text(tableToObjects(table()).map((row) => JSON.stringify(row)).join('\n') + '\n');
    case 'md':
      return text(rowsToMarkdown(table()));
    case 'log':
      return text(rows.map((row) => row.rawLine).join('\n') + '\n');
    case 'xlsx':
    case 'ods': {
      const { tableToWorkbook } = await import('./spreadsheet');
      const result = await tableToWorkbook(table(), format);
      const notes: string[] = [];
      if (result.sheetCount > 1) notes.push(`split across ${result.sheetCount} sheets (row limit per sheet)`);
      if (result.truncatedCells > 0) {
        notes.push(
          `${result.truncatedCells.toLocaleString()} long cell${result.truncatedCells === 1 ? '' : 's'} cut to the 32,767-character cell limit; use CSV for full text`
        );
      }
      return { blob: new Blob([result.bytes as BlobPart], { type: MIME[format] }), notes };
    }
  }
}

export function delimitedText(table: string[][], delimiter: string): string {
  return table.map((row) => row.map((cell) => escapeCsv(cell, delimiter)).join(delimiter)).join('\n');
}

/** One object per row, keyed by the export column names. Values stay strings, exactly as shown. */
export function rowsToObjects(rows: LogRow[], view?: TableView): Array<Record<string, string>> {
  return tableToObjects(rowsToTable(rows, view));
}

function tableToObjects(table: string[][]): Array<Record<string, string>> {
  const [headers = [], ...body] = table;
  return body.map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (cells[index] !== '') record[header] = cells[index];
    });
    return record;
  });
}

export function rowsToMarkdown(table: string[][]): string {
  const [headers = [], ...body] = table;
  // Pipes would end the cell and newlines the row.
  const cell = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replace(/\r?\n/g, '<br>');
  const line = (cells: string[]) => `| ${cells.map(cell).join(' | ')} |`;
  return [line(headers), `| ${headers.map(() => '---').join(' | ')} |`, ...body.map(line)].join('\n') + '\n';
}
