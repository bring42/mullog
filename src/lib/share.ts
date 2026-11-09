// Helpers for receiving files from the OS (share sheet, "Open with", iOS Shortcut URLs).
// Everything here runs on-device: the service worker stashes shared files in Cache Storage,
// and URL payloads live in the fragment, which browsers never send to the server.

/** Cache Storage bucket that holds a file handed over by the share-target service worker. */
export const SHARE_CACHE = 'mullog-share';
/** Fixed key for the single pending shared file. */
export const PENDING_SHARE_KEY = '/__pending-share';
/** Header carrying the URI-encoded original file name on the cached response. */
export const SHARE_NAME_HEADER = 'x-mullog-file-name';

export interface IncomingFile {
  name: string;
  buffer: ArrayBuffer;
}

/** Reads and removes the file the service worker stored for `/?shared=1`. */
export async function takePendingShare(): Promise<IncomingFile | null> {
  if (!('caches' in window)) return null;
  const cache = await caches.open(SHARE_CACHE);
  const response = await cache.match(PENDING_SHARE_KEY);
  if (!response) return null;
  const buffer = await response.arrayBuffer();
  await cache.delete(PENDING_SHARE_KEY);
  const rawName = response.headers.get(SHARE_NAME_HEADER) ?? '';
  return { name: safeDecode(rawName) || 'shared.log', buffer };
}

/** True when the fragment looks like a `#gz=` / `#b64=` payload. */
export function hasHashPayload(hash: string): boolean {
  return /^#(gz|b64)=/.test(hash);
}

/**
 * Decodes `#gz=<base64 gzip>&name=<file name>` or `#b64=<base64>&name=<file name>`.
 * Tolerates percent-encoding, base64url, missing padding, line breaks, and `+` turned into spaces.
 */
export async function decodeHashPayload(hash: string): Promise<IncomingFile> {
  const params = parseFragment(hash.replace(/^#/, ''));
  const mode = params.has('gz') ? 'gz' : 'b64';
  const encoded = params.get(mode) ?? '';
  if (!encoded) throw new Error('The link did not contain any file data.');

  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64ToBytes(encoded);
  } catch {
    throw new Error('The link data is not valid base64. In the Shortcut, make sure "Base64 Encode" has line breaks set to None.');
  }

  let name = (params.get('name') ?? '').trim();
  let buffer: ArrayBuffer = bytes.buffer;

  if (isZip(bytes)) {
    throw new Error('That looks like a .zip archive. In the Shortcut, set "Make Archive" to the gzip format instead.');
  }

  // Decompress whenever the data is gzip, whichever key was used; `#gz=` with plain data is also accepted.
  if (isGzip(bytes)) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser cannot unpack gzip data. Use #b64= without compression, or paste the text instead.');
    }
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      buffer = await new Response(stream).arrayBuffer();
    } catch {
      throw new Error('The gzip data in the link is incomplete or corrupt. The file may be too large to pass through a URL.');
    }
    name = name.replace(/\.gz$/i, '');
  }

  return { name: name || 'shared.log', buffer };
}

function parseFragment(fragment: string): Map<string, string> {
  // Not URLSearchParams: it would turn base64 `+` into spaces.
  const params = new Map<string, string>();
  for (const part of fragment.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    params.set(part.slice(0, eq), safeDecode(part.slice(eq + 1)));
  }
  return params;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function base64ToBytes(input: string): Uint8Array<ArrayBuffer> {
  let clean = input
    .replace(/[\r\n\t]/g, '')
    .replace(/ /g, '+')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(clean)) throw new Error('invalid base64');
  clean += '='.repeat((4 - (clean.length % 4)) % 4);
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}
