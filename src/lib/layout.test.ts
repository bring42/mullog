import { describe, expect, it } from 'vitest';
import { analyseSheetRows, analyseText } from './layout';
import { parseLogText, parseSpreadsheet, type ParseOptions } from './parser';
import { parseText } from './__fixtures__/load';
import { buildExport, rowsToMarkdown } from './exporters';
import { gunzip, gunzippedName, isGzip, isTarArchive } from './compression';
import type { ImportSettings } from './types';

const options = (fileName: string, settings?: ImportSettings): ParseOptions => ({
  fileName,
  fileSize: 0,
  encoding: 'utf-8',
  encodingConfidence: 1,
  encodingNotes: [],
  parserMode: 'auto',
  settings
});

function column(result: ReturnType<typeof parseText>, role: string) {
  return result.detection.schema.find((meta) => meta.role === role)?.name;
}

const report = [
  'Alarm report',
  'Generated 2024-11-04 by ops',
  '',
  'time;level;source;message',
  '2024-11-04 08:00:00;INFO;pump-1;started',
  '2024-11-04 08:01:00;WARN;pump-1;pressure high',
  '2024-11-04 08:02:00;ERROR;pump-2;stopped',
  '2024-11-04 08:03:00;INFO;pump-2;restarted',
  '2024-11-04 08:04:00;INFO;pump-1;ok',
  '2024-11-04 08:05:00;INFO;pump-3;ok',
  '2024-11-04 08:06:00;WARN;pump-3;slow',
  '2024-11-04 08:07:00;INFO;pump-1;ok',
  '',
  'Total: 8 events'
].join('\n');

describe('header and footer junk', () => {
  it('finds the table between a title block and a totals line, and says so', () => {
    const analysis = analyseText(report, { fileName: 'report.csv' });
    expect(analysis.suggested).toMatchObject({ layout: 'delimited', delimiter: ';', skipStart: 3, skipEnd: 2 });
    expect(analysis.unclear).toBe(true);
    expect(analysis.reasons.join(' ')).toMatch(/first 3 lines/);
    expect(analysis.reasons.join(' ')).toMatch(/last 2 lines/);
  });

  it('reads the table with the detected settings, keeping original line numbers', () => {
    const result = parseText(report, 'report.csv');
    expect(result.detection.hasHeader).toBe(true);
    expect(result.rows).toHaveLength(8);
    expect(result.rows[0].lineNumber).toBe(5);
    expect(column(result, 'severity')).toBe('level');
    expect(result.rows.map((row) => row.severity)).toContain('ERROR');
    expect(result.detection.skippedLines).toBe(5);
  });

  it('skips a banner above a timestamped log', () => {
    const log = ['=== myapp v2.1 ===', 'Starting up', '2024-11-04 08:00:00 INFO ready', '2024-11-04 08:00:01 WARN slow disk', '2024-11-04 08:00:02 INFO ok'].join('\n');
    const analysis = analyseText(log, { fileName: 'app.log' });
    expect(analysis.suggested).toMatchObject({ layout: 'freeform', skipStart: 2 });
    const result = parseText(log, 'app.log');
    expect(result.rows.map((row) => row.lineNumber)).toEqual([3, 4, 5]);
  });

  it('leaves clean files alone and does not ask', () => {
    const analysis = analyseText('a,b,c\n1,2,3\n4,5,6\n7,8,9', { fileName: 'clean.csv' });
    expect(analysis.suggested).toMatchObject({ skipStart: 0, skipEnd: 0 });
    expect(analysis.unclear).toBe(false);
  });

  it('can ignore comment lines without renumbering the rest', () => {
    const settings: ImportSettings = { layout: 'freeform', skipStart: 0, skipEnd: 0, ignoreComments: true };
    const result = parseLogText('# generated\n2024-11-04 08:00:00 INFO a\n// note\n2024-11-04 08:00:01 INFO b', options('x.log', settings));
    expect(result.rows.map((row) => row.lineNumber)).toEqual([2, 4]);
  });

  it('follows explicit settings over detection', () => {
    const settings: ImportSettings = { layout: 'delimited', delimiter: ',', hasHeader: false, skipStart: 1, skipEnd: 0, ignoreComments: false };
    const result = parseLogText('junk\nx,1\ny,2', options('x.txt', settings));
    expect(result.detection.schema.map((meta) => meta.name)).toEqual(['column_1', 'column_2']);
    expect(result.rows.map((row) => row.fields.column_1)).toEqual(['x', 'y']);
  });

  it('finds a title block above a spreadsheet table', () => {
    const rows = [['Sales export', '', ''], ['', '', ''], ['date', 'region', 'amount'], ['2024-01-01', 'north', '10'], ['2024-01-02', 'south', '12'], ['2024-01-03', 'north', '9'], ['2024-01-04', 'east', '4']];
    const numbers = [1, 2, 3, 4, 5, 6, 7];
    const analysis = analyseSheetRows(rows, numbers);
    expect(analysis.suggested.skipStart).toBe(2);
    const result = parseSpreadsheet({ name: 'Sheet1', rows, rowNumbers: numbers }, ['Sheet1'], 'xlsx', options('sales.xlsx'));
    expect(result.detection.schema.map((meta) => meta.name)).toEqual(['date', 'region', 'amount']);
    expect(result.rows).toHaveLength(4);
  });
});

describe('access logs', () => {
  const log = [
    '127.0.0.1 - frank [10/Oct/2000:13:55:36 -0700] "GET /apache_pb.gif HTTP/1.0" 200 2326 "http://www.example.com/start.html" "Mozilla/4.08"',
    '10.0.0.2 - - [10/Oct/2000:13:56:01 -0700] "POST /api/orders HTTP/1.1" 502 17 "-" "curl/8.0"',
    '10.0.0.3 - - [10/Oct/2000:13:57:12 -0700] "GET /missing HTTP/1.1" 404 0 "-" "curl/8.0"'
  ].join('\n');

  it('splits the request, reads the time and derives a level from the status', () => {
    const result = parseText(log, 'access.log');
    expect(result.detection.detectedType).toBe('access');
    const [ok, bad, missing] = result.rows;
    expect(ok.fields).toMatchObject({ client: '127.0.0.1', user: 'frank', method: 'GET', path: '/apache_pb.gif', status: '200', user_agent: 'Mozilla/4.08' });
    expect(ok.timestamp).toBe('2000-10-10T20:55:36.000Z');
    expect([ok.severity, bad.severity, missing.severity]).toEqual(['INFO', 'ERROR', 'WARN']);
    expect(column(result, 'timestamp')).toBe('time');
  });
});

describe('syslog', () => {
  it('reads classic syslog lines', () => {
    const log = ['Nov  4 08:00:01 web1 sshd[812]: Accepted publickey for deploy', 'Nov  4 08:00:02 web1 CRON[901]: (root) CMD (run-parts)', 'Nov  4 08:00:03 web1 app[3]: ERROR disk full'].join('\n');
    const result = parseText(log, 'syslog');
    expect(result.detection.detectedType).toBe('syslog');
    expect(result.rows[0].fields).toMatchObject({ host: 'web1', app: 'sshd', pid: '812', message: 'Accepted publickey for deploy' });
    expect(result.rows[2].severity).toBe('ERROR');
    expect(result.rows[0].timestampMs).toBeDefined();
  });

  it('reads RFC 5424 with priority', () => {
    const log = ['<34>1 2024-11-04T08:00:01.003Z mymachine su - ID47 - su root failed on /dev/pts/8', '<165>1 2024-11-04T08:00:02Z host app 99 - [meta x="1"] started'].join('\n');
    const result = parseText(log, 'messages.log');
    expect(result.detection.detectedType).toBe('syslog');
    expect(result.rows[0].fields).toMatchObject({ host: 'mymachine', app: 'su', facility: 'auth', msgid: 'ID47', message: 'su root failed on /dev/pts/8' });
    expect(result.rows[0].severity).toBe('FATAL');
    expect(result.rows[1].fields.structured_data).toBe('[meta x="1"]');
    expect(result.rows[1].severity).toBe('INFO');
  });
});

describe('logfmt', () => {
  it('turns key=value pairs into columns', () => {
    const log = ['ts=2024-11-04T08:00:00Z level=info msg="server started" port=8080', 'ts=2024-11-04T08:00:01Z level=error msg="db down" err="dial tcp: refused"', 'ts=2024-11-04T08:00:02Z level=warn msg=slow duration=2.3s'].join('\n');
    const result = parseText(log, 'app.log');
    expect(result.detection.detectedType).toBe('logfmt');
    expect(result.rows.map((row) => row.severity)).toEqual(['INFO', 'ERROR', 'WARN']);
    expect(result.rows[1].fields.err).toBe('dial tcp: refused');
    expect(column(result, 'message')).toBe('msg');
    expect(column(result, 'timestamp')).toBe('ts');
  });
});

describe('W3C / IIS', () => {
  it('uses #Fields, combines date and time, and follows a #Fields change mid-file', () => {
    const log = [
      '#Software: Microsoft Internet Information Services 10.0',
      '#Version: 1.0',
      '#Fields: date time s-ip cs-method cs-uri-stem sc-status time-taken',
      '2024-11-04 08:00:00 10.0.0.1 GET /index.html 200 15',
      '2024-11-04 08:00:01 10.0.0.1 GET /missing 404 3',
      '#Fields: date time cs-method cs-uri-stem sc-status',
      '2024-11-04 09:00:00 POST /api 500'
    ].join('\n');
    const result = parseText(log, 'u_ex241104.log');
    expect(result.detection.detectedType).toBe('w3c');
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0].timestamp).toBe('2024-11-04T08:00:00.000Z');
    expect(result.rows[1].fields['cs-uri-stem']).toBe('/missing');
    expect(result.rows[2].fields['cs-method']).toBe('POST');
    expect(result.rows.map((row) => row.severity)).toEqual(['INFO', 'WARN', 'ERROR']);
    expect(result.rows[2].lineNumber).toBe(7);
  });
});

describe('more export formats', () => {
  // Blob.text() drops a leading BOM; decode by hand so the tests can see it.
  const withBom = async (blob: Blob) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(await blob.arrayBuffer());
  const rows = parseText('time,level,message\n2024-11-04 08:00:00,INFO,"a | b"\n2024-11-04 08:00:01,ERROR,"multi\nline"', 'x.csv').rows;

  it('writes TSV with tabs and quoting', async () => {
    const text = await (await buildExport('tsv', rows)).blob.text();
    expect(text.split('\n')[0]).toBe('line_number\ttimestamp_iso\ttimestamp_raw\tseverity\tcategory\ttime\tlevel\tmessage\traw_line');
    expect(text).toContain('"multi\nline"');
  });

  it('writes JSON and JSON Lines objects without empty keys', async () => {
    const json = JSON.parse(await (await buildExport('json', rows)).blob.text());
    expect(json).toHaveLength(2);
    expect(json[0]).toMatchObject({ level: 'INFO', message: 'a | b', severity: 'INFO' });
    const lines = (await (await buildExport('jsonl', rows)).blob.text()).trim().split('\n');
    expect(JSON.parse(lines[1]).message).toBe('multi\nline');
  });

  it('escapes pipes and line breaks in Markdown', () => {
    expect(rowsToMarkdown([['a', 'b'], ['x | y', 'one\ntwo']])).toBe('| a | b |\n| --- | --- |\n| x \\| y | one<br>two |\n');
  });

  it('exports only the columns the table shows, in its order', async () => {
    const view = { columns: ['time', 'message'], timestampColumn: 'time', messageColumn: 'message' };
    const csv = await withBom((await buildExport('csv', rows.slice(1), view)).blob);
    expect(csv).toBe('﻿line,time,message\n3,2024-11-04 08:00:01,"multi\nline"');
    const sheet = await buildExport('xlsx', rows, view);
    const { readWorkbook } = await import('./spreadsheet');
    const workbook = await readWorkbook(await sheet.blob.arrayBuffer());
    expect(workbook.sheets[0].rows[0]).toEqual(['line', 'time', 'message']);
    expect(workbook.sheets[0].rows[1]).toEqual(['2', '2024-11-04 08:00:00', 'a | b']);
  });

  it('writes semicolon CSV for comma-decimal Excel', async () => {
    const view = { columns: ['level', 'message'] };
    const csv = await withBom((await buildExport('csv-excel', rows.slice(0, 1), view)).blob);
    expect(csv).toBe('﻿line;level;message\n2;INFO;a | b');
  });

  it('falls back to the raw line when no column is shown', async () => {
    const csv = await withBom((await buildExport('csv', rows.slice(0, 1), { columns: [] })).blob);
    expect(csv).toBe('﻿line,raw_line\n2,"2024-11-04 08:00:00,INFO,""a | b"""');
  });

  it('exports the original lines', async () => {
    const text = await (await buildExport('log', rows)).blob.text();
    expect(text).toBe('2024-11-04 08:00:00,INFO,"a | b"\n2024-11-04 08:00:01,ERROR,"multi\nline"\n');
  });
});

describe('gzip', () => {
  it('recognises and decompresses gzip in the browser APIs', async () => {
    const original = '2024-11-04 08:00:00 INFO hello\n';
    const compressed = await new Response(new Blob([original]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    expect(isGzip('app.log.gz', compressed)).toBe(true);
    expect(isGzip('renamed.bin', compressed)).toBe(true);
    expect(isGzip('app.log', new TextEncoder().encode(original).buffer as ArrayBuffer)).toBe(false);
    expect(new TextDecoder().decode(await gunzip(compressed))).toBe(original);
    expect(gunzippedName('app.log.gz')).toBe('app.log');
  });
});

describe('review fixes', () => {
  it('still finds a footer in a long CSV when a multi-line cell spans the tail sample cut', () => {
    // Over 2,000 lines, so the footer search looks at a separate 200-line tail that starts inside a quoted cell.
    const lines = ['time,level,message', '2024-11-04 07:59:00,INFO,single line'];
    for (let index = 0; lines.length < 2300; index += 1) {
      lines.push(`2024-11-04 08:00:00,INFO,"first line ${index}`, `second line ${index}"`);
    }
    lines.push('', 'Total: 1150 events');
    // Shift by one line if needed so the cut falls between the two lines of a cell.
    if (!lines[lines.length - 200].startsWith('second')) lines.splice(lines.length - 2, 0, '2024-11-04 09:00:00,INFO,last single line');
    expect(lines[lines.length - 200].startsWith('second')).toBe(true);
    const analysis = analyseText(lines.join('\n'), { fileName: 'big.csv' });
    expect(analysis.suggested).toMatchObject({ layout: 'delimited', skipStart: 0, skipEnd: 2 });
  });

  it('keeps # lines inside quoted cells when ignoring comments', () => {
    const settings: ImportSettings = { layout: 'delimited', delimiter: ',', hasHeader: true, skipStart: 0, skipEnd: 0, ignoreComments: true };
    const text = ['# exported by tool', 'step,notes', '1,"Steps:', '# restart pump', '# check valve"', '2,done'].join('\n');
    const result = parseLogText(text, options('x.csv', settings));
    expect(result.rows.map((row) => row.fields.notes)).toEqual(['Steps:\n# restart pump\n# check valve', 'done']);
  });

  it('reads sheets and headerless CSVs with more rows than fit in a function call', () => {
    const rows = Array.from({ length: 150_000 }, (_, index) => [String(index), String(index * 2)]);
    const sheet = parseSpreadsheet({ name: 'Big', rows }, ['Big'], 'xlsx', options('big.xlsx'));
    expect(sheet.rows).toHaveLength(150_000);
    const csv = parseLogText(rows.map((row) => row.join(',')).join('\n'), options('big.csv'));
    expect(csv.rows).toHaveLength(150_000);
  });

  it('recognises tar archives', () => {
    const tar = new Uint8Array(512);
    tar.set(new TextEncoder().encode('ustar'), 257);
    expect(isTarArchive('logs.tar.gz-decompressed', tar.buffer)).toBe(true);
    expect(isTarArchive('logs.tgz', new ArrayBuffer(0))).toBe(true);
    expect(isTarArchive('app.log', new TextEncoder().encode('x'.repeat(600)).buffer as ArrayBuffer)).toBe(false);
  });
});
