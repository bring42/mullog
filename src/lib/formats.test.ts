import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseText } from './__fixtures__/load';
import { parseSpreadsheet, type ParseOptions } from './parser';
import { firstUsefulSheet, readWorkbook, spreadsheetType, tableToXlsx, XLSX_MAX_CELL_CHARS } from './spreadsheet';

const pino = [
  '{"level":30,"time":1730707200000,"pid":42,"hostname":"api-1","msg":"server started","http":{"port":8080}}',
  '{"level":50,"time":1730707201500,"pid":42,"hostname":"api-1","msg":"request failed","err":{"type":"Error","message":"boom"},"tags":["a","b"]}',
  '{"level":40,"time":1730707202000,"pid":42,"hostname":"api-1","msg":"slow response","responseTime":2312}'
].join('\n');

function column(result: ReturnType<typeof parseText>, role: string) {
  return result.detection.schema.find((meta) => meta.role === role)?.name;
}

describe('JSON Lines', () => {
  it('reads pino-style logs: numeric levels, epoch times, msg and nested keys', () => {
    const result = parseText(pino, 'app.jsonl');
    expect(result.detection.detectedType).toBe('jsonl');
    expect(result.rows).toHaveLength(3);

    expect(column(result, 'severity')).toBe('level');
    expect(column(result, 'timestamp')).toBe('time');
    expect(column(result, 'message')).toBe('msg');

    const [started, failed, slow] = result.rows;
    expect([started.severity, failed.severity, slow.severity]).toEqual(['INFO', 'ERROR', 'WARN']);
    expect(failed.fields.level).toBe('ERROR');
    expect(failed.notes).toContain('Numeric level 50 read as ERROR.');

    expect(started.timestamp).toBe('2024-11-04T08:00:00.000Z');
    expect(started.timestampRaw).toBe('2024-11-04 08:00:00.000 UTC');
    expect(failed.timestampMs).toBe(1730707201500);

    expect(started.fields['http.port']).toBe('8080');
    expect(failed.fields['err.message']).toBe('boom');
    expect(failed.fields.tags).toBe('["a","b"]');
    expect(failed.rawLine).toBe(pino.split('\n')[1]);
    expect(failed.lineNumber).toBe(2);
  });

  it('prefers an exact "time" column over responseTime', () => {
    const result = parseText('{"responseTime":12,"time":"2024-11-04T08:00:00Z","msg":"a"}\n{"responseTime":15,"time":"2024-11-04T08:00:01Z","msg":"b"}', 'x.jsonl');
    expect(column(result, 'timestamp')).toBe('time');
  });

  it('is sniffed from content even when saved as .log', () => {
    const result = parseText(pino, 'service.log');
    expect(result.detection.detectedType).toBe('jsonl');
  });

  it('keeps lines that are not JSON objects as raw rows with a warning', () => {
    const text = [pino.split('\n')[0], 'plain text in the middle', pino.split('\n')[1]].join('\n');
    const result = parseText(text, 'mixed.jsonl');
    expect(result.rows).toHaveLength(3);
    const odd = result.rows[1];
    expect(odd.lineNumber).toBe(2);
    expect(odd.malformed).toBe(true);
    expect(odd.fields.msg).toBe('plain text in the middle');
    expect(result.detection.warnings.some((warning) => warning.lineNumber === 2)).toBe(true);
  });

  it('maps string levels such as "warning" and ECS log.level', () => {
    const result = parseText('{"@timestamp":"2024-11-04T08:00:00Z","log":{"level":"warning"},"message":"disk 91%"}\n{"@timestamp":"2024-11-04T08:00:01Z","log":{"level":"error"},"message":"disk full"}', 'ecs.json');
    expect(column(result, 'severity')).toBe('log.level');
    expect(column(result, 'timestamp')).toBe('@timestamp');
    expect(result.rows.map((row) => row.severity)).toEqual(['WARN', 'ERROR']);
  });

  it('does not let a __proto__ key touch object prototypes', () => {
    const result = parseText('{"__proto__":{"polluted":"yes"},"msg":"a"}\n{"msg":"b"}', 'evil.jsonl');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(result.rows[0].fields['[__proto__].polluted']).toBe('yes');
  });
});

describe('JSON documents', () => {
  it('reads a top-level array of objects', () => {
    const result = parseText(JSON.stringify([{ ts: '2024-11-04 08:00:00', severity: 'INFO', message: 'a' }, { ts: '2024-11-04 08:00:05', severity: 'ERROR', message: 'b' }]), 'events.json');
    expect(result.detection.detectedType).toBe('json');
    expect(result.rows.map((row) => row.severity)).toEqual(['INFO', 'ERROR']);
    expect(column(result, 'timestamp')).toBe('ts');
    expect(result.rows[1].lineNumber).toBe(2);
  });

  it('finds the records array inside a wrapper object', () => {
    const result = parseText(JSON.stringify({ count: 2, items: [{ id: 1, message: 'x' }, { id: 2, message: 'y' }] }), 'export.json');
    expect(result.rows).toHaveLength(2);
    expect(result.rows[1].fields.message).toBe('y');
  });

  it('falls back to plain text when a .json file is not valid JSON', () => {
    const result = parseText('{"broken": ', 'bad.json');
    expect(result.detection.detectedType).toBe('txt');
    expect(result.detection.warnings.some((warning) => warning.message.startsWith('Invalid JSON'))).toBe(true);
  });

  it('leaves ordinary text logs alone', () => {
    const result = parseText('2024-11-04 08:00:00 [INFO] [http] up\n2024-11-04 08:00:01 [ERROR] [db] down', 'app.log');
    expect(result.detection.detectedType).toBe('txt');
  });
});

const options: ParseOptions = {
  fileName: 'book.xlsx',
  fileSize: 0,
  encoding: 'utf-8',
  encodingConfidence: 1,
  encodingNotes: [],
  parserMode: 'auto'
};

function workbookBytes(bookType: 'xlsx' | 'xls' | 'ods'): ArrayBuffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([]), 'Empty');
  const events = XLSX.utils.aoa_to_sheet(
    [
      ['Time', 'Level', 'Service', 'Message', 'Duration (ms)'],
      [new Date(2024, 10, 4, 8, 0, 0), 'info', 'api', 'started', 12],
      [new Date(2024, 10, 4, 8, 0, 5), 'error', 'db', 'connection refused', 3000]
    ],
    { cellDates: true }
  );
  XLSX.utils.book_append_sheet(book, events, 'Events');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['a', 'b'], [1, 2]]), 'Other');
  const out = XLSX.write(book, { type: 'array', bookType }) as ArrayBuffer;
  return out;
}

describe('spreadsheets', () => {
  it('detects formats by extension and legacy .xls by magic bytes', () => {
    expect(spreadsheetType('report.XLSX', new ArrayBuffer(0))).toBe('xlsx');
    expect(spreadsheetType('report.ods', new ArrayBuffer(0))).toBe('ods');
    expect(spreadsheetType('shared.log', workbookBytes('xls'))).toBe('xls');
    expect(spreadsheetType('app.log', new TextEncoder().encode('hello').buffer as ArrayBuffer)).toBeUndefined();
    // A zip is only a spreadsheet when the name says so.
    expect(spreadsheetType('archive.zip', workbookBytes('xlsx'))).toBeUndefined();
  });

  for (const bookType of ['xlsx', 'xls', 'ods'] as const) {
    it(`reads every sheet of an .${bookType} workbook and parses the first non-empty one`, async () => {
      const book = await readWorkbook(workbookBytes(bookType));
      expect(book.sheets.map((sheet) => sheet.name)).toEqual(['Empty', 'Events', 'Other']);

      const index = firstUsefulSheet(book);
      expect(index).toBe(1);

      const result = parseSpreadsheet(book.sheets[index], book.sheets.map((sheet) => sheet.name), bookType, options);
      expect(result.detection.detectedType).toBe(bookType);
      expect(result.detection.sheetName).toBe('Events');
      expect(result.detection.sheetNames).toHaveLength(3);
      expect(result.detection.hasHeader).toBe(true);
      expect(result.rows).toHaveLength(2);

      const [started, refused] = result.rows;
      expect(started.lineNumber).toBe(2);
      expect(refused.severity).toBe('ERROR');
      expect(refused.fields.Message).toBe('connection refused');
      const duration = result.detection.schema.find((meta) => meta.name.startsWith('Duration'))?.name ?? '';
      expect(refused.fields[duration]).toBe('3000');
      expect(started.fields.Time).toBe('2024-11-04 08:00:00');
      expect(refused.fields.Time).toBe('2024-11-04 08:00:05');
      expect(started.timestampMs).toBeTypeOf('number');
      expect(result.detection.schema.find((meta) => meta.role === 'message')?.name).toBe('Message');
    });
  }

  it('does not treat a numeric "Uptime (h)" column as timestamps', () => {
    const result = parseSpreadsheet({ name: 'Hosts', rows: [['Host', 'Uptime (h)'], ['api-1', '412'], ['api-2', '9']] }, ['Hosts'], 'xlsx', options);
    expect(result.detection.schema.find((meta) => meta.role === 'timestamp')).toBeUndefined();
    expect(result.rows[0].timestampMs).toBeUndefined();
  });

  it('names columns A, B, C… when the sheet has no header row', () => {
    const result = parseSpreadsheet({ name: 'Data', rows: [['1', '2'], ['3', '4']] }, ['Data'], 'xlsx', options);
    expect(result.detection.hasHeader).toBe(false);
    expect(result.detection.schema.map((meta) => meta.name)).toEqual(['A', 'B']);
  });

  it('makes repeated or blank header names unique', () => {
    const result = parseSpreadsheet({ name: 'S', rows: [['name', 'name', ''], ['x', 'y', 'z'], ['p', 'q', 'r']] }, ['S'], 'xlsx', options);
    const names = result.detection.schema.map((meta) => meta.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('Excel export', () => {
  const toBuffer = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

  it('round-trips text cells, keeping leading zeros and formula-looking text as text', async () => {
    const table = [
      ['line_number', 'message'],
      ['1', '007, leading zeros'],
      ['2', 'multi\nline "quoted"'],
      ['3', '=1+1']
    ];
    const result = await tableToXlsx(table);
    expect(result).toMatchObject({ sheetCount: 1, truncatedCells: 0 });
    const workbook = await readWorkbook(toBuffer(result.bytes));
    expect(workbook.sheets[0].rows).toEqual(table);
  });

  it('cuts over-long cells to the Excel limit with a visible marker and counts them', async () => {
    const result = await tableToXlsx([['raw_line'], ['x'.repeat(XLSX_MAX_CELL_CHARS + 10)]]);
    expect(result.truncatedCells).toBe(1);
    const cell = (await readWorkbook(toBuffer(result.bytes))).sheets[0].rows[1][0];
    expect(cell).toHaveLength(XLSX_MAX_CELL_CHARS);
    expect(cell.endsWith('[truncated]')).toBe(true);
  });

  it('continues past the per-sheet row limit on further sheets, each with the header', async () => {
    const rows = Array.from({ length: 1048576 + 5 }, (_, index) => [String(index)]);
    const result = await tableToXlsx([['n'], ...rows]);
    expect(result.sheetCount).toBe(2);
    const workbook = await readWorkbook(toBuffer(result.bytes));
    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(['Filtered rows 1', 'Filtered rows 2']);
    expect(workbook.sheets[0].rows).toHaveLength(1048576);
    expect(workbook.sheets[1].rows).toEqual([['n'], ['1048575'], ['1048576'], ['1048577'], ['1048578'], ['1048579'], ['1048580']]);
  }, 120_000);
});
