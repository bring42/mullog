import type { SpreadsheetSheet } from './parser';
import type { SpreadsheetType } from './types';

const EXTENSIONS: Record<string, SpreadsheetType> = {
  xlsx: 'xlsx',
  xlsm: 'xlsx',
  xlsb: 'xlsx',
  xls: 'xls',
  ods: 'ods'
};

/**
 * Spreadsheet format for a file, from its extension or (for misnamed/shared files) its magic bytes.
 * Zip files only count when the extension says spreadsheet: many other formats are zips too.
 */
export function spreadsheetType(name: string, buffer: ArrayBuffer): SpreadsheetType | undefined {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (extension && EXTENSIONS[extension]) return EXTENSIONS[extension];

  const head = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
  // Legacy .xls (OLE compound document): D0 CF 11 E0 A1 B1 1A E1
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (head.length === 8 && ole.every((byte, index) => head[index] === byte)) return 'xls';
  return undefined;
}

export interface Workbook {
  sheets: SpreadsheetSheet[];
}

/**
 * Reads every sheet's cells as display text. SheetJS is loaded on demand so plain log
 * users never download it. Formulas are not evaluated; the cached results are used.
 */
export async function readWorkbook(buffer: ArrayBuffer): Promise<Workbook> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(new Uint8Array(buffer), {
    type: 'array',
    cellDates: true,
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    dense: true
  });

  const sheets = workbook.SheetNames.map((name): SpreadsheetSheet => {
    const sheet = workbook.Sheets[name];
    const rows: string[][] = [];
    const rowNumbers: number[] = [];
    if (!sheet?.['!ref']) return { name, rows, rowNumbers };

    const range = XLSX.utils.decode_range(sheet['!ref']);
    const dense = sheet['!data'] as Array<Array<CellLike | undefined> | undefined> | undefined;
    const cellAt = (r: number, c: number): CellLike | undefined =>
      dense ? dense[r]?.[c] : (sheet[XLSX.utils.encode_cell({ r, c })] as CellLike | undefined);

    for (let r = range.s.r; r <= range.e.r; r += 1) {
      const cells: string[] = [];
      for (let c = range.s.c; c <= range.e.c; c += 1) cells.push(cellText(cellAt(r, c)));
      if (cells.every((cell) => cell === '')) continue;
      rows.push(cells);
      rowNumbers.push(r + 1);
    }
    return { name, rows, rowNumbers };
  });

  return { sheets };
}

interface CellLike {
  t?: string;
  v?: unknown;
  w?: string;
}

/**
 * Display text for a cell. Dates get an unambiguous `YYYY-MM-DD HH:MM:SS` instead of the
 * sheet's own format (often date-only, like 11/4/24), so time filtering keeps working.
 */
function cellText(cell: CellLike | undefined): string {
  if (!cell || cell.v === undefined || cell.v === null) return cell?.w ?? '';
  if (cell.t === 'd') {
    const date = cell.v instanceof Date ? cell.v : new Date(String(cell.v));
    if (!Number.isNaN(date.getTime())) return formatWallClock(date);
  }
  if (cell.w !== undefined) return cell.w;
  return String(cell.v);
}

/** SheetJS stores the sheet's wall-clock time in the Date's UTC fields. */
function formatWallClock(date: Date): string {
  // Excel serials carry float noise (08:00:04.999): snap to the nearest second when that close.
  let ms = date.getTime();
  const nearestSecond = Math.round(ms / 1000) * 1000;
  if (Math.abs(ms - nearestSecond) <= 2) ms = nearestSecond;
  const iso = new Date(ms).toISOString(); // YYYY-MM-DDTHH:MM:SS.mmmZ
  const day = iso.slice(0, 10);
  const time = iso.slice(11, 19);
  const fraction = iso.slice(19, 23);
  if (time === '00:00:00' && fraction === '.000') return day;
  return `${day} ${time}${fraction === '.000' ? '' : fraction}`;
}

/** The sheet to show first: the first one that has any rows. */
export function firstUsefulSheet(workbook: Workbook): number {
  const index = workbook.sheets.findIndex((sheet) => sheet.rows.length > 0);
  return index === -1 ? 0 : index;
}
