import { readFileSync } from 'node:fs';
import { decodeBuffer, detectEncoding } from '../encoding';
import { parseLogText } from '../parser';
import type { ParseResult } from '../types';

/** Raw bytes of a fixture file. */
export function fixtureBytes(name: string): ArrayBuffer {
  const buffer = readFileSync(new URL(`./${name}`, import.meta.url));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

/** Decode and parse a fixture the same way the app does after a file drop. */
export function parseFixture(name: string): ParseResult {
  const bytes = fixtureBytes(name);
  const encoding = detectEncoding(bytes);
  return parseText(decodeBuffer(bytes, encoding.encoding), name);
}

export function parseText(text: string, fileName = 'app.log'): ParseResult {
  return parseLogText(text, {
    fileName,
    fileSize: text.length,
    encoding: 'utf-8',
    encodingConfidence: 0.9,
    encodingNotes: [],
    parserMode: 'auto'
  });
}

/**
 * The TXT parser keeps the empty string after a file's final newline as an (empty) row.
 * Most assertions don't care about it, so drop it here; one test pins the behaviour.
 */
export function withoutEofRow<T extends { rawLine: string }>(rows: T[]): T[] {
  return rows.length > 0 && rows[rows.length - 1].rawLine === '' ? rows.slice(0, -1) : rows;
}
