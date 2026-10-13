// Check-in QR as a PNG, generated in the worker (student kit, owner 2026-10-13).
//
// Why not just forward the `QR` attachment Airtable already makes: it is a GIF,
// and WhatsApp image messages (and IMAGE template headers) take JPEG/PNG only.
// Any valid QR of the same string scans the same at reception, so we encode the
// `QR Code` formula's exact content ourselves and wrap it in a minimal PNG:
// 8-bit grayscale, one IDAT, zlib via the Web CompressionStream("deflate"),
// CRC32 from a table. Zero npm (CLAUDE.md); the encoder is the vendored MIT lib.

import qrcode from "../vendor/qrcode.js";

/** The slice of the vendored library this module uses. */
interface QrLib {
  (typeNumber: number, ecl: "L" | "M" | "Q" | "H"): {
    addData(data: string, mode?: string): void;
    make(): void;
    getModuleCount(): number;
    isDark(row: number, col: number): boolean;
  };
  stringToBytes: (s: string) => number[];
  stringToBytesFuncs: Record<string, (s: string) => number[]>;
}

const lib = qrcode as unknown as QrLib;
// UTF-8 instead of the library's latin-1 default: our strings are ASCII URLs
// today, but a name with an accent in a future payload must not be mangled.
if (lib.stringToBytesFuncs["UTF-8"]) lib.stringToBytes = lib.stringToBytesFuncs["UTF-8"];

/** Pure. Module matrix (true = dark) for `text`, error-correction M, auto version. */
export function qrMatrix(text: string): boolean[][] {
  const qr = lib(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const rows: boolean[][] = [];
  for (let r = 0; r < n; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
    rows.push(row);
  }
  return rows;
}

let CRC_TABLE: Uint32Array | null = null;

/** Pure. CRC-32 (PNG / zlib polynomial 0xEDB88320). */
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Pure. Raw PNG scanlines (filter byte 0 + one gray byte per pixel) for the
 * matrix scaled by `scale` with a `margin`-module quiet zone. Black = 0x00,
 * white = 0xFF. Returns the image side in pixels too.
 */
export function rasterize(
  matrix: boolean[][],
  scale: number,
  margin: number,
): { side: number; raw: Uint8Array } {
  const n = matrix.length;
  const side = (n + 2 * margin) * scale;
  const stride = side + 1;
  const raw = new Uint8Array(stride * side).fill(0xff);
  for (let y = 0; y < side; y++) {
    raw[y * stride] = 0; // filter: None
    const r = Math.floor(y / scale) - margin;
    if (r < 0 || r >= n) continue;
    const row = matrix[r]!;
    for (let x = 0; x < side; x++) {
      const c = Math.floor(x / scale) - margin;
      if (c >= 0 && c < n && row[c]) raw[y * stride + 1 + x] = 0;
    }
  }
  return { side, raw };
}

/** zlib-wrapped deflate (what PNG's IDAT wants) via the Web Streams API. */
export async function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  // Write and read concurrently: awaiting the write first can deadlock on
  // backpressure once the output exceeds the stream's internal buffer.
  const writing = writer.write(data).then(() => writer.close());
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    chunks.push(chunk);
    total += chunk.length;
  }
  await writing;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNG of the QR for `text`. Default 8 px/module + the standard 4-module quiet zone. */
export async function qrPng(
  text: string,
  opts: { scale?: number; margin?: number } = {},
): Promise<Uint8Array> {
  const scale = opts.scale ?? 8;
  const margin = opts.margin ?? 4;
  const { side, raw } = rasterize(qrMatrix(text), scale, margin);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, side);
  dv.setUint32(4, side);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace: none
  const parts = [
    new Uint8Array(PNG_SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", await zlibDeflate(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** The string every check-in QR encodes — identical to Airtable's `QR Code` formula. */
export function checkinUrl(alumnoId: string): string {
  return `https://mdcondesa.com/checkin?Alumno=${alumnoId}`;
}
