/** gzip files (.gz, or anything starting with the gzip magic bytes 1F 8B). */
export function isGzip(name: string, buffer: ArrayBuffer): boolean {
  if (/\.gz$/i.test(name)) return true;
  const head = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
  return head.length === 2 && head[0] === 0x1f && head[1] === 0x8b;
}

/** The name of the file inside: app.log.gz → app.log. */
export function gunzippedName(name: string): string {
  return name.replace(/\.gz$/i, '') || 'decompressed.log';
}

/**
 * Tar archives (logs.tar, logs.tgz, logs.tar.gz once decompressed) bundle many files and can't be
 * shown as one log. Tar headers carry "ustar" at byte 257.
 */
export function isTarArchive(name: string, buffer: ArrayBuffer): boolean {
  if (/\.(tar|tgz)$/i.test(name)) return true;
  if (buffer.byteLength < 262) return false;
  return new TextDecoder('ascii').decode(new Uint8Array(buffer, 257, 5)) === 'ustar';
}

/** Decompresses in the browser (DecompressionStream), so nothing is uploaded. */
export async function gunzip(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot decompress gzip files.');
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}
