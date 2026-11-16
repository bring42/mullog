/** gzip files (.gz, or anything starting with the gzip magic bytes 1F 8B). */
export function isGzip(name: string, buffer: ArrayBuffer): boolean {
  if (/\.gz$/i.test(name)) return true;
  const head = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
  return head.length === 2 && head[0] === 0x1f && head[1] === 0x8b;
}

/** The name of the file inside: app.log.gz → app.log, logs.tgz is not supported (it's a tar archive). */
export function gunzippedName(name: string): string {
  return name.replace(/\.gz$/i, '') || 'decompressed.log';
}

/** Decompresses in the browser (DecompressionStream), so nothing is uploaded. */
export async function gunzip(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot decompress gzip files.');
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}
