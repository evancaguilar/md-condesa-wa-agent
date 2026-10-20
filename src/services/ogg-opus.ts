/**
 * Ogg/Opus muxing + WebM→Ogg remux for staff voice notes.
 *
 * WhatsApp renders a voice note (waveform) only for audio/ogg with the Opus
 * codec. Browsers record differently: Chrome/Android MediaRecorder gives
 * audio/webm;codecs=opus (remuxed here — the Opus packets are copied, never
 * re-encoded), and the dashboard's WebCodecs path posts raw Opus packets in a
 * tiny "MDOP" envelope (muxed here).
 *
 * Pure and dependency-free: no TextDecoder, no Node APIs.
 * References: RFC 3533 (Ogg), RFC 7845 (Ogg Opus), RFC 6716 §3.1 (TOC byte),
 * Matroska/EBML spec (vints, SimpleBlock/Block layout).
 */

// ---------- Ogg CRC32 (poly 0x04c11db7, init 0, no reflection, no xor-out) ----------

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) {
      r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    }
    t[i] = r >>> 0;
  }
  return t;
})();

export function oggCrc32(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]!) & 0xff]!) >>> 0;
  }
  return crc >>> 0;
}

// ---------- Opus TOC (RFC 6716 §3.1) ----------

/** Samples per frame at 48 kHz, indexed by TOC config (0..31). */
const FRAME_SAMPLES: number[] = (() => {
  const out: number[] = [];
  for (let c = 0; c < 32; c++) {
    if (c < 12) out.push([480, 960, 1920, 2880][c % 4]!); // SILK 10/20/40/60 ms
    else if (c < 16) out.push([480, 960][c % 2]!); // Hybrid 10/20 ms
    else out.push([120, 240, 480, 960][c % 4]!); // CELT 2.5/5/10/20 ms
  }
  return out;
})();

/** Decoded samples (48 kHz) a packet represents; 0 for an empty packet. */
export function opusPacketSamples(packet: Uint8Array): number {
  if (packet.length === 0) return 0;
  const toc = packet[0]!;
  const perFrame = FRAME_SAMPLES[toc >> 3]!;
  const code = toc & 0x03;
  let frames: number;
  if (code === 0) frames = 1;
  else if (code === 1 || code === 2) frames = 2;
  else {
    if (packet.length < 2) throw new Error("opus code-3 packet missing frame count byte");
    frames = packet[1]! & 0x3f;
  }
  return frames * perFrame;
}

// ---------- EBML ----------

export type RemuxErrorCode =
  | "not_webm"
  | "no_opus_track"
  | "lacing_unsupported"
  | "truncated"
  | "no_packets";

export class WebmRemuxError extends Error {
  readonly code: RemuxErrorCode;
  constructor(code: RemuxErrorCode, message?: string) {
    super(message ?? code);
    this.name = "WebmRemuxError";
    this.code = code;
  }
}

/**
 * Reads an EBML variable-length integer (marker bit stripped). `unknown` is
 * true when every value bit is 1 (the "unknown size" marker, e.g.
 * 0x01FFFFFFFFFFFFFF). Throws WebmRemuxError("truncated") past the buffer end.
 */
export function readVint(
  buf: Uint8Array,
  off: number,
): { value: number; len: number; unknown: boolean } {
  if (off >= buf.length) throw new WebmRemuxError("truncated", "vint past end");
  const first = buf[off]!;
  if (first === 0) throw new WebmRemuxError("truncated", "invalid vint (0x00)");
  let len = 1;
  while (!(first & (0x80 >> (len - 1)))) len++;
  if (off + len > buf.length) throw new WebmRemuxError("truncated", "vint past end");
  const mask = 0xff >> len;
  let value = first & mask;
  let allOnes = (first & mask) === mask;
  for (let i = 1; i < len; i++) {
    const b = buf[off + i]!;
    value = value * 256 + b;
    if (b !== 0xff) allOnes = false;
  }
  return { value, len, unknown: allOnes };
}

/** Element id = the raw vint bytes including the marker (e.g. 0x1A45DFA3). */
function readId(buf: Uint8Array, off: number): { id: number; len: number } {
  if (off >= buf.length) throw new WebmRemuxError("truncated", "id past end");
  const first = buf[off]!;
  if (first === 0) throw new WebmRemuxError("truncated", "invalid element id");
  let len = 1;
  while (!(first & (0x80 >> (len - 1)))) len++;
  if (len > 4 || off + len > buf.length) {
    throw new WebmRemuxError("truncated", "bad element id");
  }
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + buf[off + i]!;
  return { id, len };
}

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_CLUSTER = 0x1f43b675;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_BLOCK_GROUP = 0xa0;
const ID_TRACK_NUMBER = 0xd7;
const ID_CODEC_ID = 0x86;
const ID_CODEC_PRIVATE = 0x63a2;
const ID_CODEC_DELAY = 0x56aa;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK = 0xa1;

const MASTERS = new Set([ID_SEGMENT, ID_CLUSTER, ID_TRACKS, ID_TRACK_ENTRY, ID_BLOCK_GROUP]);

function readUint(buf: Uint8Array, off: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + buf[off + i]!;
  return v;
}

function asciiEquals(buf: Uint8Array, off: number, s: string): boolean {
  if (off + s.length > buf.length) return false;
  for (let i = 0; i < s.length; i++) if (buf[off + i] !== s.charCodeAt(i)) return false;
  return true;
}

function asciiString(buf: Uint8Array): string {
  let s = "";
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) break; // EBML strings may be zero-padded
    s += String.fromCharCode(buf[i]!);
  }
  return s;
}

interface TrackInfo {
  number?: number;
  codecId?: string;
  codecPrivate?: Uint8Array;
  codecDelayNs?: number;
}

// ---------- Ogg muxer ----------

export interface RemuxInfo {
  packets: number;
  pages: number;
  samples: number;
  durationMs: number;
  channels: number;
  preSkip: number;
}

export interface MuxInput {
  opusHead?: Uint8Array;
  channels?: number;
  preSkip?: number;
  packets: Uint8Array[];
}

const VENDOR = "md-condesa-wa-agent";
const MAX_PACKETS_PER_PAGE = 50;
const MAX_SEGMENTS = 255;

function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function synthOpusHead(channels: number, preSkip: number): Uint8Array {
  const h = new Uint8Array(19);
  h.set(ascii("OpusHead"), 0);
  h[8] = 1; // version
  h[9] = channels;
  h[10] = preSkip & 0xff;
  h[11] = (preSkip >> 8) & 0xff;
  const rate = 48000;
  h[12] = rate & 0xff;
  h[13] = (rate >> 8) & 0xff;
  h[14] = (rate >> 16) & 0xff;
  h[15] = (rate >>> 24) & 0xff;
  // [16..17] output gain 0, [18] channel mapping family 0
  return h;
}

function opusTags(): Uint8Array {
  const vendor = ascii(VENDOR);
  const t = new Uint8Array(8 + 4 + vendor.length + 4);
  t.set(ascii("OpusTags"), 0);
  const n = vendor.length;
  t[8] = n & 0xff;
  t[9] = (n >> 8) & 0xff;
  t[10] = (n >> 16) & 0xff;
  t[11] = (n >>> 24) & 0xff;
  t.set(vendor, 12);
  // trailing u32 user-comment count = 0
  return t;
}

function lacing(len: number): number[] {
  const segs: number[] = [];
  let left = len;
  while (left >= 255) {
    segs.push(255);
    left -= 255;
  }
  segs.push(left); // exact multiple of 255 → trailing 0 segment
  return segs;
}

function buildPage(
  headerType: number,
  granule: number,
  serial: number,
  seq: number,
  packets: Uint8Array[],
): Uint8Array {
  const segs: number[] = [];
  let dataLen = 0;
  for (const p of packets) {
    segs.push(...lacing(p.length));
    dataLen += p.length;
  }
  const page = new Uint8Array(27 + segs.length + dataLen);
  page.set(ascii("OggS"), 0);
  page[4] = 0; // version
  page[5] = headerType;
  const lo = granule % 0x100000000;
  const hi = Math.floor(granule / 0x100000000);
  writeU32LE(page, 6, lo);
  writeU32LE(page, 10, hi);
  writeU32LE(page, 14, serial >>> 0);
  writeU32LE(page, 18, seq >>> 0);
  // [22..25] CRC, filled below (zero while computing)
  page[26] = segs.length;
  page.set(segs, 27);
  let pos = 27 + segs.length;
  for (const p of packets) {
    page.set(p, pos);
    pos += p.length;
  }
  writeU32LE(page, 22, oggCrc32(page));
  return page;
}

function writeU32LE(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >>> 8) & 0xff;
  buf[off + 2] = (v >>> 16) & 0xff;
  buf[off + 3] = (v >>> 24) & 0xff;
}

function defaultSerial(): number {
  try {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0]!;
  } catch {
    return 0x6d64636f; // "mdco"
  }
}

function muxDetailed(
  input: MuxInput,
  opts?: { serial?: number },
): { ogg: Uint8Array; info: RemuxInfo } {
  if (input.packets.length === 0) throw new Error("muxOggOpus: no packets");
  const serial = (opts?.serial ?? defaultSerial()) >>> 0;
  let head: Uint8Array;
  let channels: number;
  let preSkip: number;
  if (input.opusHead && input.opusHead.length >= 19 && asciiEquals(input.opusHead, 0, "OpusHead")) {
    head = input.opusHead;
    channels = head[9]!;
    preSkip = head[10]! | (head[11]! << 8);
  } else {
    channels = input.channels ?? 1;
    preSkip = input.preSkip ?? 312;
    head = synthOpusHead(channels, preSkip);
  }

  const pages: Uint8Array[] = [];
  let seq = 0;
  pages.push(buildPage(0x02, 0, serial, seq++, [head])); // BOS
  pages.push(buildPage(0x00, 0, serial, seq++, [opusTags()]));

  let granule = 0;
  let i = 0;
  const n = input.packets.length;
  while (i < n) {
    const batch: Uint8Array[] = [];
    let segCount = 0;
    while (i < n && batch.length < MAX_PACKETS_PER_PAGE) {
      const p = input.packets[i]!;
      const segs = Math.floor(p.length / 255) + 1;
      if (segs > MAX_SEGMENTS) throw new Error("muxOggOpus: packet too large for one page");
      if (segCount + segs > MAX_SEGMENTS) break;
      batch.push(p);
      segCount += segs;
      granule += opusPacketSamples(p);
      i++;
    }
    const last = i >= n;
    pages.push(buildPage(last ? 0x04 : 0x00, granule, serial, seq++, batch));
  }

  let total = 0;
  for (const p of pages) total += p.length;
  const ogg = new Uint8Array(total);
  let pos = 0;
  for (const p of pages) {
    ogg.set(p, pos);
    pos += p.length;
  }
  return {
    ogg,
    info: {
      packets: n,
      pages: pages.length,
      samples: granule,
      durationMs: Math.round(Math.max(0, granule - preSkip) / 48),
      channels,
      preSkip,
    },
  };
}

/**
 * Muxes raw Opus packets into an Ogg Opus stream: page 0 OpusHead (BOS),
 * page 1 OpusTags, then audio pages (≤50 packets, ≤255 lacing segments);
 * granule = cumulative 48 kHz samples; last page EOS.
 */
export function muxOggOpus(input: MuxInput, opts?: { serial?: number }): Uint8Array {
  return muxDetailed(input, opts).ogg;
}

// ---------- "MDOP" envelope (WebCodecs path) ----------

export type EnvelopeErrorCode = "bad_envelope" | "bad_head" | "no_packets";

export class OpusEnvelopeError extends Error {
  readonly code: EnvelopeErrorCode;
  constructor(code: EnvelopeErrorCode, message?: string) {
    super(message ?? code);
    this.name = "OpusEnvelopeError";
    this.code = code;
  }
}

/**
 * Parses: ASCII "MDOP" + u16 BE head length + OpusHead bytes (may be 0) +
 * repeated (u16 BE length + packet). Throws OpusEnvelopeError on malformed input.
 */
export function packetsFromEnvelope(bytes: Uint8Array): {
  opusHead: Uint8Array | null;
  packets: Uint8Array[];
} {
  if (bytes.length < 6 || !asciiEquals(bytes, 0, "MDOP")) {
    throw new OpusEnvelopeError("bad_envelope", "missing MDOP magic");
  }
  const headLen = (bytes[4]! << 8) | bytes[5]!;
  let pos = 6;
  if (pos + headLen > bytes.length) throw new OpusEnvelopeError("bad_envelope", "head past end");
  let opusHead: Uint8Array | null = null;
  if (headLen > 0) {
    opusHead = bytes.slice(pos, pos + headLen);
    if (headLen < 19 || !asciiEquals(opusHead, 0, "OpusHead")) {
      throw new OpusEnvelopeError("bad_head", "head is not an OpusHead");
    }
  }
  pos += headLen;
  const packets: Uint8Array[] = [];
  while (pos < bytes.length) {
    if (pos + 2 > bytes.length) throw new OpusEnvelopeError("bad_envelope", "length past end");
    const len = (bytes[pos]! << 8) | bytes[pos + 1]!;
    pos += 2;
    if (len === 0) throw new OpusEnvelopeError("bad_envelope", "empty packet");
    if (pos + len > bytes.length) throw new OpusEnvelopeError("bad_envelope", "packet past end");
    packets.push(bytes.slice(pos, pos + len));
    pos += len;
  }
  if (packets.length === 0) throw new OpusEnvelopeError("no_packets");
  return { opusHead, packets };
}

/** Envelope → Ogg Opus in one step (route helper). */
export function envelopeToOgg(
  bytes: Uint8Array,
  opts?: { serial?: number },
): { ogg: Uint8Array; info: RemuxInfo } {
  const { opusHead, packets } = packetsFromEnvelope(bytes);
  try {
    return muxDetailed({ opusHead: opusHead ?? undefined, packets }, opts);
  } catch (err) {
    throw new OpusEnvelopeError("bad_envelope", String(err));
  }
}

// ---------- WebM → Ogg remux ----------

/**
 * Remuxes a MediaRecorder WebM (Opus) into Ogg Opus. Flat EBML walk that
 * enters Segment/Cluster/Tracks/TrackEntry/BlockGroup regardless of size
 * (Chrome writes unknown-size Segment/Cluster) and skips every other
 * known-size element. Block timestamps are ignored; granules come from TOCs.
 */
export function webmOpusToOgg(
  webm: Uint8Array,
  opts?: { serial?: number },
): { ogg: Uint8Array; info: RemuxInfo } {
  if (webm.length < 4 || readUint(webm, 0, 4) !== ID_EBML) {
    throw new WebmRemuxError("not_webm");
  }
  const tracks: TrackInfo[] = [];
  let cur: TrackInfo | null = null;
  const blocks: { track: number; data: Uint8Array }[] = [];

  let pos = 0;
  while (pos < webm.length) {
    const { id, len: idLen } = readId(webm, pos);
    const size = readVint(webm, pos + idLen);
    const dataStart = pos + idLen + size.len;

    if (MASTERS.has(id)) {
      if (id === ID_TRACK_ENTRY) {
        cur = {};
        tracks.push(cur);
      }
      pos = dataStart; // children follow in the stream
      continue;
    }
    if (size.unknown) {
      if (id === ID_EBML) throw new WebmRemuxError("not_webm");
      throw new WebmRemuxError("truncated", `unknown-size element 0x${id.toString(16)}`);
    }
    const end = dataStart + size.value;
    if (end > webm.length) {
      throw new WebmRemuxError("truncated", `element 0x${id.toString(16)} past end`);
    }
    const payload = webm.subarray(dataStart, end);

    switch (id) {
      case ID_TRACK_NUMBER:
        if (cur) cur.number = readUint(payload, 0, payload.length);
        break;
      case ID_CODEC_ID:
        if (cur) cur.codecId = asciiString(payload);
        break;
      case ID_CODEC_PRIVATE:
        if (cur) cur.codecPrivate = payload.slice();
        break;
      case ID_CODEC_DELAY:
        if (cur) cur.codecDelayNs = readUint(payload, 0, payload.length);
        break;
      case ID_SIMPLE_BLOCK:
      case ID_BLOCK: {
        const tn = readVint(payload, 0);
        const hdr = tn.len + 3; // track vint + 2-byte timecode + flags
        if (hdr > payload.length) throw new WebmRemuxError("truncated", "block header");
        const flags = payload[tn.len + 2]!;
        if (flags & 0x06) throw new WebmRemuxError("lacing_unsupported");
        blocks.push({ track: tn.value, data: payload.slice(hdr) });
        break;
      }
      default:
        break; // EBML header, Info, SeekHead, Cues, Tags, Void, Audio, Timecode, …
    }
    pos = end;
  }

  const opus = tracks.find((t) => t.codecId === "A_OPUS" && t.number !== undefined);
  if (!opus) throw new WebmRemuxError("no_opus_track");
  const packets = blocks.filter((b) => b.track === opus.number && b.data.length > 0).map((b) => b.data);
  if (packets.length === 0) throw new WebmRemuxError("no_packets");

  const head =
    opus.codecPrivate && opus.codecPrivate.length >= 19 && asciiEquals(opus.codecPrivate, 0, "OpusHead")
      ? opus.codecPrivate
      : undefined;
  const preSkip =
    opus.codecDelayNs !== undefined ? Math.round((opus.codecDelayNs * 48000) / 1e9) : undefined;
  try {
    return muxDetailed({ opusHead: head, preSkip, packets }, opts);
  } catch (err) {
    throw new WebmRemuxError("truncated", String(err));
  }
}
