// Blast drain (src/cron/blasts.ts) against a scriptable fake D1: claim-before-
// send, per-recipient failures, auto-pause on template errors, daily cap,
// sending window, completion note.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runBlastBatch, KV_SENT_DAY_PREFIX } from "../src/cron/blasts.js";
import { encodeBlastNote, encodeRunMeta, type BlastRunMeta } from "../src/services/blast.js";
import { cdmxToEpoch, cdmxDateStr } from "../src/cron/time.js";
import type { Env } from "../src/types.js";

type Row = {
  id: number;
  phone: string;
  note: string | null;
  rid: string | null;
  c_status: string | null;
  c_name: string | null;
  status: string;
};

interface World {
  rows: Row[];
  kv: Map<string, string>;
  notes: string[];
  sends: { phone: string; template: string; components: unknown }[];
  sendImpl?: (phone: string) => Promise<string>;
}

function fakeEnv(w: World): Env {
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const exec = (): { first?: unknown; all?: unknown[]; changes?: number } => {
      if (sql.includes("SELECT key, value FROM kv")) {
        // listRunMetas: `WHERE key LIKE 'blast_run:%'`
        return { all: [...w.kv].filter(([k]) => k.startsWith("blast_run:")).map(([key, value]) => ({ key, value })) };
      }
      if (sql.includes("SELECT value FROM kv")) {
        const v = w.kv.get(String(binds[0]));
        return { first: v === undefined ? null : { value: v } };
      }
      if (sql.includes("INSERT INTO kv")) {
        w.kv.set(String(binds[0]), String(binds[1]));
        return { changes: 1 };
      }
      if (sql.includes("FROM followups f LEFT JOIN contacts")) {
        const limit = Number(binds[1]);
        return { all: w.rows.filter((r) => r.status === "scheduled").slice(0, limit).map((r) => ({ ...r })) };
      }
      if (sql.includes("GROUP BY airtable_record_id, status")) {
        const agg = new Map<string, number>();
        for (const r of w.rows) agg.set(`${r.rid}|${r.status}`, (agg.get(`${r.rid}|${r.status}`) ?? 0) + 1);
        return { all: [...agg].map(([k, n]) => ({ rid: k.split("|")[0], status: k.split("|")[1], n })) };
      }
      if (sql.startsWith("UPDATE followups SET status = 'sent' WHERE id = ?1 AND status = 'scheduled'")) {
        const r = w.rows.find((x) => x.id === binds[0]);
        if (r && r.status === "scheduled") {
          r.status = "sent";
          return { changes: 1 };
        }
        return { changes: 0 };
      }
      if (sql.includes("UPDATE followups SET status = ?2") && sql.includes("airtable_record_id = ?1")) {
        let n = 0;
        for (const r of w.rows) {
          if (r.rid === binds[0] && (sql.includes(`'${r.status}'`))) {
            r.status = String(binds[1]);
            n++;
          }
        }
        return { changes: n };
      }
      const m = /UPDATE followups SET status = '(\w+)'(?:, note = \?2)? WHERE id = \?1/.exec(sql);
      if (m) {
        const r = w.rows.find((x) => x.id === binds[0]);
        if (r) {
          r.status = m[1]!;
          if (sql.includes("note = ?2")) r.note = String(binds[1]);
        }
        return { changes: r ? 1 : 0 };
      }
      throw new Error(`unexpected sql: ${sql}`);
    };
    const stmt: D1PreparedStatement = {
      bind(...v: unknown[]) {
        binds = v;
        return stmt;
      },
      async first<T>() {
        return (exec().first ?? null) as T | null;
      },
      async run() {
        return { results: [], meta: { changes: exec().changes ?? 1 } };
      },
      async all<T>() {
        return { results: (exec().all ?? []) as T[], meta: {} };
      },
    };
    return stmt;
  };
  return { DB: { prepare: make } } as unknown as Env;
}

const NOON = cdmxToEpoch(2026, 9, 16, 12, 0, 0);
const NIGHT = cdmxToEpoch(2026, 9, 16, 22, 0, 0);

function meta(over: Partial<BlastRunMeta> = {}): BlastRunMeta {
  return {
    id: "r1",
    name: "Promo",
    mode: "template",
    template: "promo_es",
    lang: "es",
    params: ["{nombre}"],
    header: null,
    text: null,
    total: 3,
    status: "active",
    createdAt: NOON - 100,
    startAt: NOON - 100,
    dailyCap: 250,
    by: "Evan",
    pausedReason: null,
    updatedAt: NOON - 100,
    ...over,
  };
}

function world(n = 3, over: Partial<BlastRunMeta> = {}): World {
  const note = encodeBlastNote({ t: "promo_es", l: "es", v: ["{nombre}"] });
  const w: World = {
    rows: Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      phone: `52155000000${i + 1}`,
      note,
      rid: "blast:r1",
      c_status: "lead",
      c_name: i === 0 ? "Ana" : null,
      status: "scheduled",
    })),
    kv: new Map([
      ["blast_run:r1", encodeRunMeta(meta(over))],
      ["blast_active", "1"],
    ]),
    notes: [],
    sends: [],
  };
  return w;
}

function deps(w: World) {
  return {
    slack: {
      postNote: async (t: string) => {
        w.notes.push(t);
      },
      postAttendanceCheck: async () => {},
    },
    sendTemplate: (async (_env: Env, phone: string, template: string, _lang: string, components?: unknown[]) => {
      w.sends.push({ phone, template, components });
      if (w.sendImpl) return w.sendImpl(phone);
      return `wamid.${phone}`;
    }) as never,
  };
}

test("drain: sends the batch, claims rows before sending, records the day count, finishes the run", async () => {
  const w = world(3);
  const r = await runBlastBatch(fakeEnv(w), deps(w), NOON);
  assert.equal(r.sent, 3);
  assert.equal(w.sends.length, 3);
  // {nombre} rendered from the contact name (first row) or the fallback.
  assert.deepEqual(w.sends[0]!.components, [{ type: "body", parameters: [{ type: "text", text: "Ana" }] }]);
  assert.deepEqual(w.sends[1]!.components, [{ type: "body", parameters: [{ type: "text", text: "👋" }] }]);
  assert.ok(w.rows.every((x) => x.status === "sent"));
  assert.equal(w.kv.get(KV_SENT_DAY_PREFIX + cdmxDateStr(NOON)), "3");
  assert.deepEqual(r.finishedRuns, ["r1"]);
  assert.equal(w.kv.get("blast_active"), "0"); // idle flag cleared → next ticks read one kv row
  assert.match(w.notes[0] ?? "", /terminado: 3 enviados/);
  assert.match(w.kv.get("blast_run:r1") ?? "", /"status":"done"/);
});

test("drain: outside 09:00–21:00 nothing happens", async () => {
  const w = world(2);
  const r = await runBlastBatch(fakeEnv(w), deps(w), NIGHT);
  assert.equal(r.idle, "window");
  assert.equal(w.sends.length, 0);
});

test("drain: per-recipient error marks the row failed with the message and continues", async () => {
  const w = world(2);
  w.sendImpl = async (phone) => {
    if (phone.endsWith("1")) throw new Error("WA send failed (400) [131026]: Message undeliverable");
    return "wamid.ok";
  };
  const r = await runBlastBatch(fakeEnv(w), deps(w), NOON);
  assert.equal(r.failed, 1);
  assert.equal(r.sent, 1);
  assert.equal(w.rows[0]!.status, "failed");
  assert.match(w.rows[0]!.note ?? "", /131026/);
  assert.equal(w.rows[1]!.status, "sent");
});

test("drain: template error pauses the run, freezes the rest, posts one note", async () => {
  const w = world(3);
  w.sendImpl = async () => {
    throw new Error("WA send failed (404) [132001]: Template name does not exist in the translation");
  };
  const r = await runBlastBatch(fakeEnv(w), deps(w), NOON);
  assert.equal(r.pausedRun, "r1");
  assert.equal(w.sends.length, 1);
  assert.deepEqual(w.rows.map((x) => x.status), ["paused", "paused", "paused"]);
  assert.match(w.rows[0]!.note ?? "", /132001/);
  assert.equal(w.notes.length, 1);
  assert.match(w.notes[0]!, /pausado automáticamente/);
  assert.match(w.kv.get("blast_run:r1") ?? "", /"status":"paused"/);
});

test("drain: rate limit leaves the row scheduled with an attempt count and stops the tick", async () => {
  const w = world(2);
  w.sendImpl = async () => {
    throw new Error("WA send failed (429) [130429]: Rate limit hit");
  };
  const r = await runBlastBatch(fakeEnv(w), deps(w), NOON);
  assert.equal(r.retried, 1);
  assert.equal(w.sends.length, 1);
  assert.equal(w.rows[0]!.status, "scheduled");
  assert.match(w.rows[0]!.note ?? "", /"a":1/);
  assert.equal(w.rows[1]!.status, "scheduled");
});

test("drain: daily cap stops sending; opted-out rows are skipped; paused runs are left alone", async () => {
  const w = world(3, { dailyCap: 1 });
  w.rows[1]!.c_status = "opted_out";
  const r = await runBlastBatch(fakeEnv(w), deps(w), NOON);
  assert.equal(r.sent, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.idle, "daily_cap");
  assert.deepEqual(w.rows.map((x) => x.status), ["sent", "skipped_optout", "scheduled"]);

  const p = world(1, { status: "paused" });
  const r2 = await runBlastBatch(fakeEnv(p), deps(p), NOON);
  assert.equal(r2.sent, 0);
  assert.equal(p.rows[0]!.status, "scheduled");
});

test("drain: with no active run the tick reads only the kv flag", async () => {
  const w = world(2);
  w.kv.set("blast_active", "0");
  const r = await runBlastBatch(fakeEnv(w), deps(w), NOON);
  assert.equal(r.idle, "no_active_run");
  assert.equal(w.sends.length, 0);
  assert.equal(w.rows[0]!.status, "scheduled");
});
