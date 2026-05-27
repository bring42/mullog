import type { EncodingName, ParseWarning } from './types';

export interface EncodingDetection {
  encoding: EncodingName;
  confidence: number;
  notes: string[];
  warnings: ParseWarning[];
}

const SUPPORTED_ENCODINGS: EncodingName[] = ['utf-8', 'windows-1252', 'iso-8859-1'];

export function supportedEncodings(): EncodingName[] {
  return [...SUPPORTED_ENCODINGS];
}

export function decodeBuffer(buffer: ArrayBuffer, encoding: EncodingName): string {
  // Strip a UTF-8 BOM at the byte level so it never gets re-decoded as
  // "ï»¿" when the file is read as Windows-1252 / ISO-8859-1.
  const bytes = new Uint8Array(buffer);
  const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return new TextDecoder(encoding, { fatal: false }).decode(bytes.subarray(start));
}

export function detectEncoding(buffer: ArrayBuffer): EncodingDetection {
  const bytes = new Uint8Array(buffer);
  const notes: string[] = [];
  const warnings: ParseWarning[] = [];

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    notes.push('UTF-8 byte order mark found at file start.');
    return { encoding: 'utf-8', confidence: 0.99, notes, warnings };
  }

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    notes.push('Byte stream decoded cleanly as UTF-8 without replacement characters.');
    return { encoding: 'utf-8', confidence: 0.92, notes, warnings };
  } catch {
    notes.push('Strict UTF-8 decode failed; testing single-byte encodings.');
  }

  const sample = bytes.slice(0, Math.min(bytes.length, 64_000));
  const controlBytes = sample.filter((byte) => byte >= 0x80 && byte <= 0x9f).length;
  const highBytes = sample.filter((byte) => byte >= 0x80).length;

  if (controlBytes > 0) {
    notes.push(`${controlBytes} byte(s) in the 0x80-0x9F range suggest Windows-1252 smart punctuation or symbols.`);
    return { encoding: 'windows-1252', confidence: 0.78, notes, warnings };
  }

  if (highBytes > 0) {
    notes.push('High-bit bytes found, but no Windows-1252-specific control range. ISO-8859-1 selected with low confidence.');
    warnings.push({
      id: 'encoding-low-confidence',
      type: 'unknown-encoding-confidence',
      level: 'warning',
      message: 'Encoding could not be distinguished confidently between ISO-8859-1 and Windows-1252.'
    });
    return { encoding: 'iso-8859-1', confidence: 0.58, notes, warnings };
  }

  notes.push('ASCII-compatible byte stream; UTF-8 selected because all bytes are below 0x80.');
  return { encoding: 'utf-8', confidence: 0.84, notes, warnings };
}

export function stripUtf8Bom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
