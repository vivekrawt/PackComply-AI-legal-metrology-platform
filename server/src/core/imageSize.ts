// Minimal PNG/JPEG dimension parser (no native deps). Returns null for
// unsupported formats (HEIC, PDF) — callers must handle the null.
export function imageSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 26) return null;
  // PNG: IHDR width/height at fixed offsets
  if (buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // JPEG: scan for SOFn markers
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
      const len = buf.readUInt16BE(off + 2);
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
      }
      off += 2 + len;
    }
  }
  // BMP
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    return { w: buf.readInt32LE(18), h: Math.abs(buf.readInt32LE(22)) };
  }
  return null;
}
