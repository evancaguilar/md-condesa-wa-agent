// QR PNG generation for the student kit (src/services/qr-png.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import {
  checkinUrl,
  crc32,
  qrMatrix,
  qrPng,
  zlibDeflate,
} from "../src/services/qr-png.js";

const SAMPLE = checkinUrl("recJGBLgxBbsGqrf0");

function u32(b: Uint8Array, off: number): number {
  return ((b[off]! << 24) | (b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!) >>> 0;
}

/** Walk the PNG chunks: [{type, data}] — and verify every CRC on the way. */
function chunks(png: Uint8Array): { type: string; data: Uint8Array }[] {
  const out: { type: string; data: Uint8Array }[] = [];
  let off = 8;
  while (off < png.length) {
    const len = u32(png, off);
    const type = String.fromCharCode(...png.slice(off + 4, off + 8));
    const data = png.slice(off + 8, off + 8 + len);
    assert.equal(u32(png, off + 8 + len), crc32(png, off + 4, off + 8 + len), `${type} CRC`);
    out.push({ type, data });
    off += 12 + len;
  }
  return out;
}

test("checkinUrl is the exact string Airtable's `QR Code` formula encodes", () => {
  assert.equal(SAMPLE, "https://mdcondesa.com/checkin?Alumno=recJGBLgxBbsGqrf0");
});

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("qrMatrix is square, a legal QR size, and has the three finder patterns", () => {
  const m = qrMatrix(SAMPLE);
  const n = m.length;
  assert.ok(n >= 21 && (n - 17) % 4 === 0, `size ${n}`);
  for (const row of m) assert.equal(row.length, n);
  // 7x7 finder: dark outer ring, light ring, dark 3x3 core.
  const finder = (r0: number, c0: number) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        assert.equal(m[r0 + r]![c0 + c], ring !== 2, `finder @${r0},${c0} (${r},${c})`);
      }
    }
  };
  finder(0, 0);
  finder(0, n - 7);
  finder(n - 7, 0);
  // Deterministic: same input, same matrix.
  assert.deepEqual(qrMatrix(SAMPLE), m);
});

test("zlibDeflate emits a zlib stream (0x78 header) that inflates back", async () => {
  const data = new TextEncoder().encode("hola hola hola hola hola");
  const z = await zlibDeflate(data);
  assert.equal(z[0], 0x78);
  assert.deepEqual([...inflateSync(z)], [...data]);
});

test("qrPng: signature, IHDR = (count + 2*margin) * scale, pixels match the matrix", async () => {
  const m = qrMatrix(SAMPLE);
  const scale = 8;
  const margin = 4;
  const png = await qrPng(SAMPLE, { scale, margin });
  assert.deepEqual([...png.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const cs = chunks(png);
  assert.deepEqual(cs.map((c) => c.type), ["IHDR", "IDAT", "IEND"]);
  const ihdr = cs[0]!.data;
  const side = (m.length + 2 * margin) * scale;
  assert.equal(u32(ihdr, 0), side);
  assert.equal(u32(ihdr, 4), side);
  assert.equal(ihdr[8], 8); // bit depth
  assert.equal(ihdr[9], 0); // grayscale
  const raw = inflateSync(cs[1]!.data);
  const stride = side + 1;
  assert.equal(raw.length, stride * side);
  // Quiet zone: the whole first scanline is white.
  assert.equal(raw[0], 0);
  for (let x = 0; x < side; x++) assert.equal(raw[1 + x], 0xff);
  // First pixel row of module row 0, sampled at every module.
  const y = margin * scale;
  assert.equal(raw[y * stride], 0);
  for (let c = 0; c < m.length; c++) {
    for (let k = 0; k < scale; k++) {
      const px = raw[y * stride + 1 + (margin + c) * scale + k];
      assert.equal(px, m[0]![c] ? 0 : 0xff, `module (0,${c}) px ${k}`);
    }
  }
  // And a mid-image row, so a stride bug can't hide behind the finder rows.
  const r = Math.floor(m.length / 2);
  const ym = (margin + r) * scale + 3;
  for (let c = 0; c < m.length; c++) {
    assert.equal(raw[ym * stride + 1 + (margin + c) * scale], m[r]![c] ? 0 : 0xff);
  }
});
