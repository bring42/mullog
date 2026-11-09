import { describe, expect, it } from 'vitest';
import { decodeBuffer, detectEncoding, stripUtf8Bom } from './encoding';
import { fixtureBytes, parseFixture, parseText, withoutEofRow } from './__fixtures__/load';

describe('continuation lines', () => {
  it('folds a Java stack trace into the log line above it', () => {
    const parsed = parseFixture('java-stacktrace.log');
    const { detection } = parsed;
    const rows = withoutEofRow(parsed.rows);

    expect(rows.map((row) => [row.lineNumber, row.lineEnd])).toEqual([
      [1, undefined],
      [2, 8],
      [9, undefined]
    ]);

    const failed = rows[1];
    // Severity words are not stripped from the message on this base, so only pin the tail.
    expect(failed.fields.message).toMatch(/Request failed for order 991$/);
    expect(failed.category).toBe('orders');
    expect(failed.rawLine.split('\n')).toHaveLength(7);
    expect(failed.fields.raw).toBe(failed.rawLine);
    expect(failed.rawLine).toContain('    at com.example.orders.OrderService.submit(OrderService.java:42)');
    expect(failed.fullMessage?.split('\n')[0]).toBe(failed.fields.message);
    expect(failed.fullMessage).toContain('Caused by: java.lang.NullPointerException: lines is null');
    expect(failed.fullMessage).toContain('... 2 more');

    const continuationWarnings = detection.warnings.filter((warning) => warning.type === 'continuation-line');
    expect(continuationWarnings).toEqual([
      expect.objectContaining({ lineNumber: 2, message: 'Merged 6 continuation lines into line 2.' })
    ]);
    expect(rows.some((row) => row.category === 'uncategorized')).toBe(false);
  });

  it('no longer turns a lone indented frame into its own uncategorized row', () => {
    const { rows, detection } = parseText(
      ['2024-03-05 10:00:00 ERROR [api] boom', '    at com.example.Foo.bar(Foo.java:42)'].join('\n')
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lineNumber: 1, lineEnd: 2, category: 'api' });
    expect(detection.warnings.find((warning) => warning.type === 'continuation-line')?.message).toBe(
      'Merged 1 continuation line into line 1.'
    );
  });

  it('folds a chained Python traceback and keeps blank lines inside it', () => {
    const rows = withoutEofRow(parseFixture('python-traceback.log').rows);

    expect(rows.map((row) => [row.lineNumber, row.lineEnd ?? row.lineNumber])).toEqual([
      [1, 1],
      [2, 15],
      [16, 16],
      [17, 17]
    ]);

    const crashed = rows[1];
    expect(crashed.fields.message).toMatch(/Job 17 crashed$/);
    expect(crashed.fields.message).not.toContain('\n');
    expect(crashed.rawLine).toContain("KeyError: 'id'\n\nDuring handling of the above exception, another exception occurred:\n\nTraceback");
    expect(crashed.rawLine.endsWith('worker.JobFailedError: job 17')).toBe(true);
    expect(crashed.fullMessage).toContain('    raise JobFailed(17)');
  });

  it('keeps a blank line between two entries as its own row', () => {
    const { rows, detection } = parseFixture('python-traceback.log');
    expect(rows[2]).toMatchObject({ lineNumber: 16, rawLine: '' });
    expect(rows[2].lineEnd).toBeUndefined();
    expect(detection.warnings.some((warning) => warning.type === 'empty-line' && warning.lineNumber === 16)).toBe(true);
  });

  it('keeps the empty string after a final newline as its own row (existing behaviour)', () => {
    const { rows } = parseFixture('java-stacktrace.log');
    expect(rows[rows.length - 1]).toMatchObject({ lineNumber: 10, rawLine: '' });
  });

  it('does not merge timestamped lines, even when indented', () => {
    const { rows } = parseText(['2024-03-05 10:00:00 start', '  2024-03-05 10:00:01 indented but timestamped'].join('\n'));
    expect(rows).toHaveLength(2);
  });

  it('does not merge lines that share the same indentation as the entry above', () => {
    const { rows } = parseFixture('indented-only.log');
    expect(rows.filter((row) => row.rawLine.trim() !== '')).toHaveLength(3);
    expect(rows.every((row) => row.lineEnd === undefined)).toBe(true);
  });

  it('does not let an indented first line absorb anything before it', () => {
    const { rows } = parseText(['', '    at orphan.Frame(Frame.java:1)', '2024-03-05 10:00:00 next'].join('\n'));
    expect(rows.map((row) => row.lineNumber)).toEqual([1, 2, 3]);
  });
});

describe('category extraction', () => {
  it('takes a bracketed category and strips it from the message', () => {
    const { rows } = parseText('2024-03-05 10:00:00 [auth] user alice logged in');
    expect(rows[0].category).toBe('auth');
    expect(rows[0].fields.message).toBe('user alice logged in');
  });

  it('takes a "name:" prefix as the category', () => {
    const { rows } = parseText('2024-03-05 10:00:00 db: connection lost');
    expect(rows[0].category).toBe('db');
    expect(rows[0].fields.message).toBe('connection lost');
  });

  it('ignores purely numeric bracket tokens such as PIDs', () => {
    const { rows } = parseText('2024-03-05 10:00:00 [1234] [scheduler] tick');
    expect(rows[0].category).toBe('scheduler');
  });

  it('falls back to uncategorized', () => {
    const { rows } = parseText('just some words');
    expect(rows[0].category).toBe('uncategorized');
  });
});

describe('CSV header and BOM handling', () => {
  it('drops the BOM, detects the semicolon delimiter and keeps real-world header names', () => {
    const { detection, rows } = parseFixture('bom-semicolon.csv');
    expect(detection.detectedType).toBe('csv');
    expect(detection.delimiter).toBe('semicolon');
    expect(detection.hasHeader).toBe(true);
    expect(detection.schema.map((column) => column.name)).toEqual(['Timestamp', 'Larmhändelse_nr#', 'Rapportgrupper', 'Message']);
    expect(detection.schema.find((column) => column.role === 'timestamp')?.name).toBe('Timestamp');
    expect(detection.schema.find((column) => column.role === 'category')?.name).toBe('Rapportgrupper');
    expect(rows).toHaveLength(3);
    expect(rows[0].category).toBe('Fire');
  });

  it('does not decode a UTF-8 BOM as mojibake when the file is read as Windows-1252', () => {
    const bytes = fixtureBytes('bom-semicolon.csv');
    expect(detectEncoding(bytes).encoding).toBe('utf-8');
    const asCp1252 = decodeBuffer(bytes, 'windows-1252');
    expect(asCp1252.startsWith('Timestamp;')).toBe(true);
    expect(asCp1252).not.toContain('ï»¿');
  });

  it('strips a BOM character left in decoded text', () => {
    expect(stripUtf8Bom('﻿a,b')).toBe('a,b');
    expect(stripUtf8Bom('a,b')).toBe('a,b');
  });

  it('names columns column_N when the first row is data', () => {
    const { detection, rows } = parseFixture('headerless.csv');
    expect(detection.hasHeader).toBe(false);
    expect(detection.schema.map((column) => column.name)).toEqual(['column_1', 'column_2', 'column_3']);
    expect(rows).toHaveLength(3);
  });
});
