import { test } from "node:test";
import assert from "node:assert/strict";

import {
  envelopeToOgg,
  muxOggOpus,
  oggCrc32,
  opusPacketSamples,
  OpusEnvelopeError,
  packetsFromEnvelope,
  readVint,
  webmOpusToOgg,
  WebmRemuxError,
} from "../src/services/ogg-opus.js";

// ---------- byte helpers ----------

function bytes(...parts: (number[] | Uint8Array)[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function ascii(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
function asciiAt(b: Uint8Array, off: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[off + i]!);
  return s;
}
function idBytes(id: number): number[] {
  const out: number[] = [];
  let v = id;
  while (v > 0) {
    out.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return out;
}
/** EBML size as an 8-byte vint (always valid, keeps the helper simple). */
function vint8(n: number): number[] {
  const out = [0x01, 0, 0, 0, 0, 0, 0, 0];
  let v = n;
  for (let i = 7; i >= 1; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return out;
}
function el(id: number, payload: Uint8Array | number[]): Uint8Array {
  return bytes(idBytes(id), vint8(payload.length), payload);
}
function unknownSize(id: number): Uint8Array {
  return bytes(idBytes(id), [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
}
function opusHead(channels: number, preSkip: number): Uint8Array {
  return bytes(ascii("OpusHead"), [1, channels, preSkip & 0xff, preSkip >> 8, 0x80, 0xbb, 0, 0, 0, 0, 0]);
}
function packet(len: number, toc: number, fill: number): Uint8Array {
  const p = new Uint8Array(len);
  p.fill(fill);
  p[0] = toc;
  return p;
}
function simpleBlock(track: number, frame: Uint8Array, flags = 0x80): Uint8Array {
  return el(0xa3, bytes([0x80 | track, 0x00, 0x00, flags], frame));
}

// INDEPENDENT bitwise CRC (no table) to cross-check the module's table CRC.
function bitwiseCrc(b: Uint8Array): number {
  let crc = 0;
  for (const byte of b) {
    crc ^= byte << 24;
    for (let k = 0; k < 8; k++) {
      crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    }
  }
  return crc >>> 0;
}

interface Page {
  headerType: number;
  granule: number;
  serial: number;
  seq: number;
  crc: number;
  segs: number[];
  data: Uint8Array;
  raw: Uint8Array;
}
function u32(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}
function parsePages(ogg: Uint8Array): Page[] {
  const pages: Page[] = [];
  let pos = 0;
  while (pos < ogg.length) {
    assert.equal(asciiAt(ogg, pos, 4), "OggS", `page at ${pos} starts OggS`);
    const nseg = ogg[pos + 26]!;
    const segs = Array.from(ogg.subarray(pos + 27, pos + 27 + nseg));
    const dataLen = segs.reduce((a, b) => a + b, 0);
    const total = 27 + nseg + dataLen;
    const raw = ogg.slice(pos, pos + total);
    pages.push({
      headerType: raw[5]!,
      granule: u32(raw, 6) + u32(raw, 10) * 0x100000000,
      serial: u32(raw, 14),
      seq: u32(raw, 18),
      crc: u32(raw, 22),
      segs,
      data: raw.subarray(27 + nseg),
      raw,
    });
    pos += total;
  }
  return pages;
}
/** Reassembles packets from lacing values across pages. */
function reassemble(pages: Page[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let cur: number[] = [];
  for (const p of pages) {
    let off = 0;
    for (const s of p.segs) {
      for (let i = 0; i < s; i++) cur.push(p.data[off + i]!);
      off += s;
      if (s < 255) {
        out.push(Uint8Array.from(cur));
        cur = [];
      }
    }
  }
  return out;
}
function verifyCrc(p: Page): void {
  const copy = p.raw.slice();
  copy[22] = copy[23] = copy[24] = copy[25] = 0;
  assert.equal(bitwiseCrc(copy), p.crc, `crc page ${p.seq}`);
  assert.equal(oggCrc32(copy), p.crc);
}

// ---------- synthetic WebM ----------

const P20 = packet(40, 0xf8, 0x11); // config 31 (CELT 20 ms), code 0 → 960
const P_CODE3 = bytes([0xfb, 0x03], new Uint8Array(30).fill(0x22)); // 20 ms × 3 → 2880
const P300 = packet(300, 0xf8, 0x33); // spans 2 lacing segments
const P255 = packet(255, 0xf8, 0x44); // exact multiple → trailing 0 segment
const P_BLOCK = packet(50, 0xf8, 0x55); // inside BlockGroup/Block

function buildWebm(opts: { lacingFlag?: boolean; withSecondTrack?: boolean } = {}): Uint8Array {
  const ebmlHeader = el(0x1a45dfa3, bytes(el(0x4282, ascii("webm"))));
  const info = el(0x1549a966, bytes(el(0x2ad7b1, [0x0f, 0x42, 0x40])));
  const opusEntry = el(
    0xae,
    bytes(
      el(0xd7, [1]),
      el(0x86, ascii("A_OPUS")),
      el(0x63a2, opusHead(1, 312)),
      el(0xe1, bytes(el(0xb5, [0x47, 0x3b, 0x80, 0x00]))), // Audio (skipped)
    ),
  );
  const otherEntry = el(0xae, bytes(el(0xd7, [2]), el(0x86, ascii("V_VP8"))));
  const tracks = el(0x1654ae6b, opts.withSecondTrack ? bytes(opusEntry, otherEntry) : opusEntry);
  const cluster1 = bytes(
    unknownSize(0x1f43b675),
    el(0xe7, [0]),
    simpleBlock(1, P20),
    ...(opts.withSecondTrack ? [simpleBlock(2, packet(20, 0x00, 0x99))] : []),
    simpleBlock(1, P_CODE3, opts.lacingFlag ? 0x82 : 0x80),
    simpleBlock(1, P300),
    el(0xec, [0, 0, 0]), // Void
    simpleBlock(1, P255),
  );
  const cluster2 = bytes(
    unknownSize(0x1f43b675),
    el(0xe7, [0x10]),
    el(0xa0, bytes(el(0xa1, bytes([0x81, 0x00, 0x00, 0x00], P_BLOCK)), el(0x9b, [20]))),
  );
  return bytes(ebmlHeader, unknownSize(0x18538067), info, tracks, cluster1, cluster2);
}

const EXPECTED = [P20, P_CODE3, P300, P255, P_BLOCK];

// ---------- tests ----------

test("oggCrc32 matches an independent bitwise CRC", () => {
  const data = ascii("The quick brown fox jumps over the lazy dog");
  assert.equal(oggCrc32(data), bitwiseCrc(data));
  assert.equal(oggCrc32(new Uint8Array(0)), 0);
});

test("opusPacketSamples: all 32 configs × codes 0..3", () => {
  const perFrameMs = (c: number): number =>
    c < 12 ? [10, 20, 40, 60][c % 4]! : c < 16 ? [10, 20][c % 2]! : [2.5, 5, 10, 20][c % 4]!;
  for (let c = 0; c < 32; c++) {
    const per = perFrameMs(c) * 48;
    assert.equal(opusPacketSamples(Uint8Array.of((c << 3) | 0)), per, `c${c} code0`);
    assert.equal(opusPacketSamples(Uint8Array.of((c << 3) | 1, 0)), 2 * per, `c${c} code1`);
    assert.equal(opusPacketSamples(Uint8Array.of((c << 3) | 2, 0)), 2 * per, `c${c} code2`);
    assert.equal(opusPacketSamples(Uint8Array.of((c << 3) | 3, 0xc5)), 5 * per, `c${c} code3`);
  }
  assert.equal(opusPacketSamples(Uint8Array.of(16 << 3)), 120); // 2.5 ms
  assert.equal(opusPacketSamples(new Uint8Array(0)), 0);
});

test("readVint: lengths, values, unknown marker", () => {
  assert.deepEqual(readVint(Uint8Array.of(0x81), 0), { value: 1, len: 1, unknown: false });
  assert.deepEqual(readVint(Uint8Array.of(0x40, 0x02), 0), { value: 2, len: 2, unknown: false });
  assert.deepEqual(readVint(Uint8Array.of(0xff), 0).unknown, true);
  const u = readVint(Uint8Array.of(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff), 0);
  assert.equal(u.len, 8);
  assert.equal(u.unknown, true);
  assert.equal(readVint(Uint8Array.of(0x01, 0, 0, 0, 0, 0, 1, 0x2c), 0).value, 300);
  let threw: unknown = null;
  try {
    readVint(Uint8Array.of(0x40), 0);
  } catch (err) {
    threw = err;
  }
  assert.ok(threw instanceof WebmRemuxError);
});

test("webmOpusToOgg: pages, CRC, flags, lacing, granules", () => {
  const { ogg, info } = webmOpusToOgg(buildWebm(), { serial: 0xdeadbeef });
  const pages = parsePages(ogg);
  assert.ok(pages.length >= 3);
  pages.forEach((p, i) => {
    verifyCrc(p);
    assert.equal(p.seq, i);
    assert.equal(p.serial, 0xdeadbeef);
  });
  assert.equal(pages[0]!.headerType, 0x02);
  assert.equal(asciiAt(pages[0]!.data, 0, 8), "OpusHead");
  assert.equal(pages[0]!.granule, 0);
  assert.equal(asciiAt(pages[1]!.data, 0, 8), "OpusTags");
  assert.equal(pages[1]!.granule, 0);
  assert.equal(pages[pages.length - 1]!.headerType, 0x04);
  for (const p of pages.slice(1, -1)) assert.equal(p.headerType & 0x06, 0);

  const audio = reassemble(pages.slice(2));
  assert.equal(audio.length, EXPECTED.length);
  audio.forEach((p, i) => assert.deepEqual(Array.from(p), Array.from(EXPECTED[i]!)));

  // lacing for 255-byte packet = [255, 0]; 300 = [255, 45]
  const segs = pages[2]!.segs;
  assert.deepEqual(segs, [40, 32, 255, 45, 255, 0, 50]);

  const total = 960 + 2880 + 960 + 960 + 960;
  assert.equal(pages[pages.length - 1]!.granule, total);
  assert.deepEqual(info, {
    packets: 5,
    pages: pages.length,
    samples: total,
    durationMs: Math.round((total - 312) / 48),
    channels: 1,
    preSkip: 312,
  });
});

test("muxOggOpus: >50 packets split into pages with cumulative granules", () => {
  const pkts = Array.from({ length: 120 }, (_, i) => packet(10, 0xf8, i));
  const pages = parsePages(muxOggOpus({ packets: pkts }, { serial: 7 }));
  assert.equal(pages.length, 2 + 3);
  assert.equal(pages[2]!.granule, 50 * 960);
  assert.equal(pages[3]!.granule, 100 * 960);
  assert.equal(pages[4]!.granule, 120 * 960);
  assert.equal(pages[4]!.headerType, 0x04);
  assert.equal(pages[3]!.headerType, 0x00);
  pages.forEach(verifyCrc);
  // synthesized OpusHead: v1, ch 1, preSkip 312, 48000
  const h = pages[0]!.data;
  assert.equal(h.length, 19);
  assert.equal(h[8], 1);
  assert.equal(h[9], 1);
  assert.equal(h[10]! | (h[11]! << 8), 312);
  assert.equal(u32(h, 12), 48000);
  assert.equal(reassemble(pages.slice(2)).length, 120);
});

test("muxOggOpus: 255-segment page budget forces a new page", () => {
  const pkts = Array.from({ length: 10 }, () => packet(1000, 0xf8, 1)); // 4 segs each
  const pages = parsePages(muxOggOpus({ packets: pkts }, { serial: 1 }));
  for (const p of pages) assert.ok(p.segs.length <= 255);
  assert.equal(reassemble(pages.slice(2)).length, 10);
});

test("webmOpusToOgg: a second non-Opus track is ignored", () => {
  const { info, ogg } = webmOpusToOgg(buildWebm({ withSecondTrack: true }), { serial: 1 });
  assert.equal(info.packets, 5);
  const audio = reassemble(parsePages(ogg).slice(2));
  audio.forEach((p, i) => assert.deepEqual(Array.from(p), Array.from(EXPECTED[i]!)));
});

test("webmOpusToOgg: error codes", () => {
  const code = (fn: () => unknown): string => {
    try {
      fn();
    } catch (err) {
      assert.ok(err instanceof WebmRemuxError);
      return (err as WebmRemuxError).code;
    }
    return "no-throw";
  };
  assert.equal(code(() => webmOpusToOgg(buildWebm({ lacingFlag: true }))), "lacing_unsupported");
  assert.equal(code(() => webmOpusToOgg(ascii("RIFF....WAVE"))), "not_webm");
  const noOpus = bytes(
    el(0x1a45dfa3, []),
    unknownSize(0x18538067),
    el(0x1654ae6b, el(0xae, bytes(el(0xd7, [1]), el(0x86, ascii("A_VORBIS"))))),
  );
  assert.equal(code(() => webmOpusToOgg(noOpus)), "no_opus_track");
  const noPackets = bytes(
    el(0x1a45dfa3, []),
    unknownSize(0x18538067),
    el(0x1654ae6b, el(0xae, bytes(el(0xd7, [1]), el(0x86, ascii("A_OPUS"))))),
    unknownSize(0x1f43b675),
  );
  assert.equal(code(() => webmOpusToOgg(noPackets)), "no_packets");
  const full = buildWebm();
  assert.equal(code(() => webmOpusToOgg(full.slice(0, full.length - 15))), "truncated");
  const unknownLeaf = bytes(el(0x1a45dfa3, []), unknownSize(0x18538067), unknownSize(0x1549a966));
  assert.equal(code(() => webmOpusToOgg(unknownLeaf)), "truncated");
});

function envelope(head: Uint8Array, pkts: Uint8Array[]): Uint8Array {
  const parts: (number[] | Uint8Array)[] = [ascii("MDOP"), [head.length >> 8, head.length & 0xff], head];
  for (const p of pkts) parts.push([p.length >> 8, p.length & 0xff], p);
  return bytes(...parts);
}

test("packetsFromEnvelope: round-trip with and without OpusHead", () => {
  const head = opusHead(2, 3840);
  const r = packetsFromEnvelope(envelope(head, EXPECTED));
  assert.deepEqual(Array.from(r.opusHead!), Array.from(head));
  assert.equal(r.packets.length, EXPECTED.length);
  r.packets.forEach((p, i) => assert.deepEqual(Array.from(p), Array.from(EXPECTED[i]!)));

  const r2 = packetsFromEnvelope(envelope(new Uint8Array(0), [P20]));
  assert.equal(r2.opusHead, null);

  const { ogg, info } = envelopeToOgg(envelope(head, EXPECTED), { serial: 9 });
  assert.equal(info.channels, 2);
  assert.equal(info.preSkip, 3840);
  const pages = parsePages(ogg);
  pages.forEach(verifyCrc);
  assert.deepEqual(Array.from(pages[0]!.data), Array.from(head)); // used verbatim
});

test("packetsFromEnvelope: malformed input throws OpusEnvelopeError", () => {
  const code = (b: Uint8Array): string => {
    try {
      packetsFromEnvelope(b);
    } catch (err) {
      assert.ok(err instanceof OpusEnvelopeError);
      return (err as OpusEnvelopeError).code;
    }
    return "no-throw";
  };
  assert.equal(code(ascii("NOPE\x00\x00")), "bad_envelope");
  assert.equal(code(envelope(new Uint8Array(0), [])), "no_packets");
  assert.equal(code(envelope(ascii("NotAHeadAtAll......"), [P20])), "bad_head");
  const ok = envelope(new Uint8Array(0), [P20]);
  assert.equal(code(ok.slice(0, ok.length - 1)), "bad_envelope");
  assert.equal(code(bytes(ok, [0x00])), "bad_envelope");
});
