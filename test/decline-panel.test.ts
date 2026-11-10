// Panel indicator for the declined stop (2026-11-10): the Chats list probes
// kv `declined:<phone>` for a whole page in batched PRIMARY KEY IN-lists (≤90
// keys each) — never one query per row, never a LIKE / range scan.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DECLINE_PROBE_CHUNK, declineMarkersSql, getDeclineMarkers } from "../src/services/decline-stop.js";
import { declineNote, encodeDeclineMarker } from "../src/pipeline/decline.js";
import { readFileSync } from "node:fs";

function fakeDb(kv: Map<string, string>, log: { sql: string; n: number }[], fail = false): D1Database {
  return {
    prepare(sql: string) {
      let b: unknown[] = [];
      const stmt = {
        bind: (...v: unknown[]) => ((b = v), stmt),
        all: async () => {
          if (fail) throw new Error("boom");
          log.push({ sql, n: b.length });
          return { results: b.map(String).filter((k) => kv.has(k)).map((k) => ({ key: k, value: kv.get(k)! })), meta: {} };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

test("getDeclineMarkers: one PK IN-list per ≤90 phones; returns only marked phones", async () => {
  const phones = Array.from({ length: 100 }, (_, i) => `52155000${String(i).padStart(5, "0")}`);
  const kv = new Map<string, string>([
    [`declined:${phones[3]}`, encodeDeclineMarker({ ts: 10, source: "complaint", text: "qué molestos" })],
    [`declined:${phones[95]}`, encodeDeclineMarker({ ts: 20, source: "objection" })],
    ["unrelated", "x"],
  ]);
  const log: { sql: string; n: number }[] = [];
  const m = await getDeclineMarkers(fakeDb(kv, log), [...phones, phones[0]!]);
  assert.equal(log.length, 2, "100 phones → 2 statements");
  assert.deepEqual(log.map((l) => l.n), [DECLINE_PROBE_CHUNK, 10]);
  for (const l of log) {
    assert.match(l.sql, /^SELECT key, value FROM kv WHERE key IN \(\?1(, \?\d+)*\)$/);
    assert.doesNotMatch(l.sql, /LIKE|>=/);
  }
  assert.deepEqual([...m.keys()], [phones[3], phones[95]]);
  assert.equal(m.get(phones[3]!)!.source, "complaint");
});

test("getDeclineMarkers: empty page = no query; a D1 error fails soft to empty", async () => {
  const log: { sql: string; n: number }[] = [];
  assert.equal((await getDeclineMarkers(fakeDb(new Map(), log), [])).size, 0);
  assert.equal(log.length, 0);
  assert.equal((await getDeclineMarkers(fakeDb(new Map(), log, true), ["521"])).size, 0);
  assert.equal(declineMarkersSql(2), "SELECT key, value FROM kv WHERE key IN (?1, ?2)");
});

test("decline note points at the panel button", () => {
  assert.match(declineNote("521", "objection", 0), /Reactivar seguimiento/);
});

test("admin SPA: chip in list + header, reactivate route wired; inline script parses", () => {
  const html = readFileSync("src/ui/admin.html", "utf8");
  assert.ok(html.includes("if(c.declined) out.push(declineChip(c.declined));"));
  assert.ok(html.includes("chatState.declined?' '+declineChip(chatState.declined)"));
  assert.ok(html.includes('"/reactivate",{method:"POST"}'));
  for (const m of html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)) new Function(m[1]!);
  const api = readFileSync("src/routes/admin-api.ts", "utf8");
  assert.match(api, /booking\|reactivate\)\)\?\$\//);
});
