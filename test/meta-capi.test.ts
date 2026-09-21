// Meta Conversions API for Business Messaging (src/services/meta-capi.ts,
// src/cron/capi.ts): payload shape vs. the documented spec, the result→event
// mapping, at-most-once queueing, the ctwa_clid / age gates, value handling,
// token redaction, and the feature-flag no-op — all against fakes, no network.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CAPI_ALLOWED_EVENT_NAMES,
  CAPI_EVENT_NAMES,
  CAPI_MAX_ATTEMPTS,
  CAPI_MAX_EVENT_AGE_SEC,
  CAPI_MAX_PER_TICK,
  KV_CAPI_LAST_ERROR,
  KV_CAPI_LAST_OK,
  KV_CAPI_PENDING,
  buildMessagingEvent,
  capiClaimKey,
  capiConfig,
  capiEventFresh,
  capiEventId,
  capiEventsForResult,
  capiQueueKey,
  captureResultCapiEvents,
  ctwaClidFromAdRef,
  enqueueCapiEvent,
  eventFromQueued,
  parseQueuedEvent,
  redactToken,
  sendMessagingEvents,
  type MessagingEvent,
} from "../src/services/meta-capi.js";
import { runCapiDrain } from "../src/cron/capi.js";
import { cdmxDateStr } from "../src/cron/time.js";
import { CLIENT } from "../src/client.gen.js";
import type { Env } from "../src/types.js";

// ---- fake D1 (kv + contacts only) ----

interface World {
  kv: Map<string, string>;
  contacts: Map<string, { ad_ref: string | null }>;
}

function fakeDb(w: World): D1Database {
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const exec = (): { first?: unknown; all?: unknown[]; changes?: number } => {
      if (sql.includes("SELECT key, value FROM kv") && sql.includes("LIKE")) {
        const m = /LIKE '([^']+)%'/.exec(sql);
        const prefix = (m?.[1] ?? "").replace(/%$/, "");
        const limit = Number(binds[0] ?? 100);
        const rows = [...w.kv]
          .filter(([k]) => k.startsWith(prefix))
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .slice(0, limit)
          .map(([key, value]) => ({ key, value }));
        return { all: rows };
      }
      if (sql.includes("COUNT(*)") && sql.includes("FROM kv")) {
        const m = /LIKE '([^']+)%'/.exec(sql);
        const prefix = (m?.[1] ?? "").replace(/%$/, "");
        return { first: { n: [...w.kv.keys()].filter((k) => k.startsWith(prefix)).length } };
      }
      if (sql.includes("SELECT value FROM kv")) {
        const v = w.kv.get(String(binds[0]));
        return { first: v === undefined ? null : { value: v } };
      }
      if (sql.startsWith("INSERT OR IGNORE INTO kv")) {
        const key = String(binds[0]);
        if (w.kv.has(key)) return { changes: 0 };
        w.kv.set(key, String(binds[1]));
        return { changes: 1 };
      }
      if (sql.includes("INSERT INTO kv")) {
        w.kv.set(String(binds[0]), String(binds[1]));
        return { changes: 1 };
      }
      if (sql.startsWith("DELETE FROM kv")) {
        w.kv.delete(String(binds[0]));
        return { changes: 1 };
      }
      if (sql.includes("FROM contacts")) {
        const c = w.contacts.get(String(binds[0]));
        return { first: c ? { phone: binds[0], ...c } : null };
      }
      return {};
    };
    const stmt = {
      bind(...args: unknown[]) {
        binds = args;
        return stmt;
      },
      async first<T>() {
        return (exec().first ?? null) as T;
      },
      async all<T>() {
        return { results: (exec().all ?? []) as T[], success: true, meta: {} };
      },
      async run() {
        const r = exec();
        return { success: true, meta: { changes: r.changes ?? 0 } };
      },
    } as unknown as D1PreparedStatement;
    return stmt;
  };
  return { prepare: make } as unknown as D1Database;
}

function envWith(w: World, over: Partial<Env> = {}): Env {
  return {
    DB: fakeDb(w),
    WA_WABA_ID: "1717538906028335",
    META_CAPI_DATASET_ID: "999000111",
    META_CAPI_TOKEN: "TOKEN-SECRET-ABC123",
    ...over,
  } as unknown as Env;
}

function world(): World {
  return { kv: new Map(), contacts: new Map() };
}

/** The test build has no Response constructor (see test/cron-shims.d.ts). */
function fakeRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  } as unknown as Response;
}

const CLID = "ARAkLkA8rmlFeiCktEJQ-QTwRiyYHAFDLMNDBH0CD3qpjd0";
const NOW = 1_789_000_000;

// ---- payload shape ----

test("buildMessagingEvent matches Meta's documented business-messaging shape", () => {
  const event = buildMessagingEvent({
    eventName: "Purchase",
    eventTimeSec: NOW + 0.7, // floored
    ctwaClid: CLID,
    wabaId: "1717538906028335",
    eventId: "md-condesa-purchase-deadbeef",
    value: 1500,
  });
  assert.deepEqual(event, {
    event_name: "Purchase",
    event_time: NOW,
    action_source: "business_messaging",
    messaging_channel: "whatsapp",
    event_id: "md-condesa-purchase-deadbeef",
    user_data: {
      whatsapp_business_account_id: "1717538906028335",
      ctwa_clid: CLID,
    },
    custom_data: { value: 1500, currency: "MXN" },
  });
  // ctwa_clid and the WABA id go in the CLEAR (Meta lists them as un-hashed),
  // and nothing that WOULD need hashing (phone/email/name) is ever included.
  const keys = Object.keys(event.user_data);
  assert.deepEqual(keys.sort(), ["ctwa_clid", "whatsapp_business_account_id"]);
});

test("no value ⇒ no custom_data at all (never a 0-peso sale)", () => {
  const base = {
    eventName: "LeadSubmitted",
    eventTimeSec: NOW,
    ctwaClid: CLID,
    wabaId: "W1",
    eventId: "e1",
  };
  assert.equal(buildMessagingEvent(base).custom_data, undefined);
  assert.equal(buildMessagingEvent({ ...base, value: 0 }).custom_data, undefined);
  assert.equal(buildMessagingEvent({ ...base, value: -5 }).custom_data, undefined);
  assert.equal(buildMessagingEvent({ ...base, value: NaN }).custom_data, undefined);
  assert.equal(buildMessagingEvent({ ...base, value: null }).custom_data, undefined);
  // currency defaults to MXN and is normalized when a value IS present
  assert.deepEqual(buildMessagingEvent({ ...base, value: 900, currency: "mxn" }).custom_data, {
    value: 900,
    currency: "MXN",
  });
});

test("every event name we send is on Meta's allowed business-messaging list", () => {
  for (const name of Object.values(CAPI_EVENT_NAMES)) {
    assert.ok(
      (CAPI_ALLOWED_EVENT_NAMES as readonly string[]).includes(name),
      `${name} is not an allowed business-messaging event`,
    );
  }
  assert.deepEqual(CAPI_EVENT_NAMES, {
    booked: "LeadSubmitted",
    attended: "QualifiedLead",
    purchase: "Purchase",
  });
});

// ---- result → events ----

test("capiEventsForResult maps the real Airtable values", () => {
  assert.deepEqual(capiEventsForResult("Se inscribió"), ["attended", "purchase"]);
  assert.deepEqual(capiEventsForResult("se inscribio"), ["attended", "purchase"]);
  assert.deepEqual(capiEventsForResult("Asistió"), ["attended"]);
  assert.deepEqual(capiEventsForResult("  ASISTIO, pendiente "), ["attended"]);
  // multipleSelects arrive joined; enrollment wins
  assert.deepEqual(capiEventsForResult("No asistió, Se inscribió"), ["attended", "purchase"]);
  // "no asistio" must NOT count as attendance even though it contains "asistio"
  assert.deepEqual(capiEventsForResult("No asistió"), []);
  assert.deepEqual(capiEventsForResult("no  asistio"), []);
  assert.deepEqual(capiEventsForResult("Pendiente"), []);
  assert.deepEqual(capiEventsForResult(""), []);
  assert.deepEqual(capiEventsForResult(null), []);
});

test("capiEventId is deterministic and carries no phone number", () => {
  const a = capiEventId("booked", "5215512345678", "recA");
  assert.equal(a, capiEventId("booked", "5215512345678", "recA"));
  assert.notEqual(a, capiEventId("attended", "5215512345678", "recA"));
  assert.notEqual(a, capiEventId("booked", "5215599999999", "recA"));
  assert.ok(!a.includes("5215512345678"));
  assert.ok(a.startsWith(`${CLIENT.clientId}-booked-`));
});

// ---- age gate ----

test("capiEventFresh enforces Meta's 7-day event_time window", () => {
  assert.equal(capiEventFresh(NOW, NOW), true);
  assert.equal(capiEventFresh(NOW - CAPI_MAX_EVENT_AGE_SEC + 60, NOW), true);
  assert.equal(capiEventFresh(NOW - CAPI_MAX_EVENT_AGE_SEC - 60, NOW), false);
  assert.equal(capiEventFresh(NOW - 8 * 86400, NOW), false);
  assert.ok(CAPI_MAX_EVENT_AGE_SEC < 7 * 86400); // margin against expiry mid-retry
  assert.equal(capiEventFresh(NOW + 120, NOW), true); // small clock skew ok
  assert.equal(capiEventFresh(NOW + 7200, NOW), false);
  assert.equal(capiEventFresh(NaN, NOW), false);
});

// ---- config / feature flag ----

test("capiConfig: the feature flag ships OFF and every miss is named", () => {
  assert.equal(CLIENT.features.metaCapi, false, "must ship inert");
  const w = world();
  assert.equal(capiConfig(envWith(w)).reason, "feature_off");
  assert.equal(capiConfig(envWith(w)).enabled, false);
});

test("capiConfig token precedence: META_CAPI_TOKEN > ADS_ACCESS_TOKEN > WA_ACCESS_TOKEN", () => {
  const w = world();
  const base = { ADS_ACCESS_TOKEN: "ads", WA_ACCESS_TOKEN: "wa" };
  assert.equal(
    capiConfig(envWith(w, { ...base, META_CAPI_TOKEN: "capi" })).tokenSource,
    "META_CAPI_TOKEN",
  );
  assert.equal(
    capiConfig(envWith(w, { ...base, META_CAPI_TOKEN: undefined })).tokenSource,
    "ADS_ACCESS_TOKEN",
  );
  assert.equal(
    capiConfig(envWith(w, { WA_ACCESS_TOKEN: "wa", META_CAPI_TOKEN: undefined })).tokenSource,
    "WA_ACCESS_TOKEN",
  );
  const none = capiConfig(
    envWith(w, { META_CAPI_TOKEN: undefined, ADS_ACCESS_TOKEN: undefined, WA_ACCESS_TOKEN: undefined }),
  );
  assert.equal(none.tokenSource, null);
});

test("the whole path is a NO-OP while the flag/dataset are unset", async () => {
  const w = world();
  w.contacts.set("521551", { ad_ref: JSON.stringify({ ctwaClid: CLID }) });
  // features.metaCapi is false in the compiled client ⇒ disabled regardless of env
  assert.equal(await enqueueCapiEvent(envWith(w), { kind: "booked", phone: "521551" }), "disabled");
  assert.equal(w.kv.size, 0);
  const send = await sendMessagingEvents(envWith(w), [
    buildMessagingEvent({
      eventName: "Purchase",
      eventTimeSec: NOW,
      ctwaClid: CLID,
      wabaId: "W",
      eventId: "x",
    }),
  ], async () => {
    throw new Error("must not be called");
  });
  assert.equal(send.skipped, "disabled");
  assert.equal(send.ok, false);
});

// ---- enqueue (with the flag forced on) ----

/** The compiled client ships metaCapi=false; tests that exercise the live path flip it. */
async function withFeatureOn(fn: () => Promise<void>): Promise<void> {
  const flags = CLIENT.features as { metaCapi?: boolean };
  const prev = flags.metaCapi;
  flags.metaCapi = true;
  try {
    await fn();
  } finally {
    flags.metaCapi = prev;
  }
}

test("enqueue: skipped silently for a contact with no ctwa_clid", async () => {
  await withFeatureOn(async () => {
    const w = world();
    w.contacts.set("5215500000000", { ad_ref: null });
    const env = envWith(w);
    assert.equal(await enqueueCapiEvent(env, { kind: "booked", phone: "5215500000000" }, NOW), "no_clid");
    // an ad_ref without a clid (organic referral shape) is just as skipped
    w.contacts.set("5215500000001", { ad_ref: JSON.stringify({ sourceId: "123", ctwaClid: null }) });
    assert.equal(await enqueueCapiEvent(env, { kind: "booked", phone: "5215500000001" }, NOW), "no_clid");
    // a contact row that does not exist at all
    assert.equal(await enqueueCapiEvent(env, { kind: "booked", phone: "nope" }, NOW), "no_clid");
    assert.equal(w.kv.size, 0);
  });
});

test("enqueue: at most ONE event per contact per kind, and the drain wakes up", async () => {
  await withFeatureOn(async () => {
    const w = world();
    w.contacts.set("521551", { ad_ref: JSON.stringify({ ctwaClid: CLID }) });
    const env = envWith(w);
    assert.equal(await enqueueCapiEvent(env, { kind: "booked", phone: "521551", recordId: "recA" }, NOW), "queued");
    assert.equal(await enqueueCapiEvent(env, { kind: "booked", phone: "521551", recordId: "recA" }, NOW), "duplicate");
    // …even when a later sync passes a different Airtable record for the phone
    assert.equal(await enqueueCapiEvent(env, { kind: "booked", phone: "521551", recordId: "recB" }, NOW), "duplicate");
    // a DIFFERENT funnel step is still allowed
    assert.equal(await enqueueCapiEvent(env, { kind: "attended", phone: "521551" }, NOW), "queued");
    assert.ok(w.kv.has(capiClaimKey("booked", "521551")));
    assert.equal(w.kv.get(KV_CAPI_PENDING), "1");
    const queued = [...w.kv.keys()].filter((k) => k.startsWith("capi_q:"));
    assert.equal(queued.length, 2);
  });
});

test("enqueue: an event older than Meta's window is dropped before it is queued", async () => {
  await withFeatureOn(async () => {
    const w = world();
    w.contacts.set("521551", { ad_ref: JSON.stringify({ ctwaClid: CLID }) });
    const env = envWith(w);
    const res = await enqueueCapiEvent(
      env,
      { kind: "attended", phone: "521551", eventTimeSec: NOW - 30 * 86400 },
      NOW,
    );
    assert.equal(res, "too_old");
    assert.equal(w.kv.size, 0); // no claim burned, no queue row
  });
});

test("enqueue: only purchase carries a value", async () => {
  await withFeatureOn(async () => {
    const w = world();
    w.contacts.set("521551", { ad_ref: JSON.stringify({ ctwaClid: CLID }) });
    const env = envWith(w);
    await enqueueCapiEvent(env, { kind: "purchase", phone: "521551", value: 1500 }, NOW);
    await enqueueCapiEvent(env, { kind: "booked", phone: "521551", value: 1500 }, NOW);
    const rows = [...w.kv.entries()]
      .filter(([k]) => k.startsWith("capi_q:"))
      .map(([, v]) => parseQueuedEvent(v)!);
    const purchase = rows.find((r) => r.kind === "purchase")!;
    const booked = rows.find((r) => r.kind === "booked")!;
    assert.equal(purchase.value, 1500);
    assert.equal(purchase.currency, "MXN");
    assert.equal(booked.value, undefined);
  });
});

test("result hook: 'Se inscribió' queues attended + purchase at the TRIAL time, with Pago Inicial", async () => {
  await withFeatureOn(async () => {
    const w = world();
    w.contacts.set("521551", { ad_ref: JSON.stringify({ ctwaClid: CLID }) });
    const env = envWith(w);
    const trialIso = new Date((NOW - 2 * 86400) * 1000).toISOString();
    const res = await captureResultCapiEvents(
      env,
      {
        phone: "521551",
        recordId: "recA",
        rawResult: "Se inscribió",
        trialDateTimeIso: trialIso,
        initialPayment: 2400,
      },
      NOW,
    );
    assert.deepEqual(res, ["queued", "queued"]);
    const rows = [...w.kv.entries()]
      .filter(([k]) => k.startsWith("capi_q:"))
      .map(([, v]) => parseQueuedEvent(v)!);
    assert.deepEqual(rows.map((r) => r.kind).sort(), ["attended", "purchase"]);
    // event_time is when the class happened, not when the front desk marked it
    for (const r of rows) assert.equal(r.eventTime, Math.floor(Date.parse(trialIso) / 1000));
    assert.equal(rows.find((r) => r.kind === "purchase")!.value, 2400);
    // no amount ⇒ Purchase without value, never an invented one
    const w2 = world();
    w2.contacts.set("521552", { ad_ref: JSON.stringify({ ctwaClid: CLID }) });
    await captureResultCapiEvents(
      envWith(w2),
      {
        phone: "521552",
        recordId: "recB",
        rawResult: "Se inscribió",
        trialDateTimeIso: trialIso,
        initialPayment: null,
      },
      NOW,
    );
    const purchase = [...w2.kv.entries()]
      .filter(([k]) => k.startsWith("capi_q:"))
      .map(([, v]) => parseQueuedEvent(v)!)
      .find((r) => r.kind === "purchase")!;
    assert.equal(purchase.value, undefined);
  });
});

test("result hook: a no-show queues nothing", async () => {
  await withFeatureOn(async () => {
    const w = world();
    w.contacts.set("521551", { ad_ref: JSON.stringify({ ctwaClid: CLID }) });
    const res = await captureResultCapiEvents(
      envWith(w),
      {
        phone: "521551",
        recordId: "recA",
        rawResult: "No asistió",
        trialDateTimeIso: new Date(NOW * 1000).toISOString(),
      },
      NOW,
    );
    assert.deepEqual(res, []);
    assert.equal(w.kv.size, 0);
  });
});

// ---- sender ----

test("sendMessagingEvents POSTs {data:[…]} with a Bearer header and no token in the URL", async () => {
  await withFeatureOn(async () => {
    const w = world();
    const calls: { url: string; init?: RequestInit }[] = [];
    const event = buildMessagingEvent({
      eventName: "Purchase",
      eventTimeSec: NOW,
      ctwaClid: CLID,
      wabaId: "W1",
      eventId: "e1",
      value: 1500,
    });
    const res = await sendMessagingEvents(
      envWith(w),
      [event],
      async (url, init) => {
        calls.push({ url, init });
        return fakeRes(200, { events_received: 1, fbtrace_id: "x" });
      },
      { testEventCode: "TEST123" },
    );
    assert.equal(res.ok, true);
    assert.equal(res.received, 1);
    const call = calls[0]!;
    assert.match(call.url, /\/999000111\/events$/);
    assert.ok(!call.url.includes("TOKEN-SECRET"), "token must never reach the URL");
    const headers = call.init!.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer TOKEN-SECRET-ABC123");
    const body = JSON.parse(String(call.init!.body)) as { data: MessagingEvent[]; test_event_code?: string };
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0]!.action_source, "business_messaging");
    assert.equal(body.data[0]!.messaging_channel, "whatsapp");
    assert.equal(body.test_event_code, "TEST123");
  });
});

test("sendMessagingEvents never throws and never leaks the token in an error", async () => {
  await withFeatureOn(async () => {
    const w = world();
    const event = buildMessagingEvent({
      eventName: "Purchase",
      eventTimeSec: NOW,
      ctwaClid: CLID,
      wabaId: "W1",
      eventId: "e1",
    });
    const graphError = await sendMessagingEvents(envWith(w), [event], async () =>
      fakeRes(400, {
        error: {
          message: "Invalid OAuth token TOKEN-SECRET-ABC123 for access_token=TOKEN-SECRET-ABC123",
          code: 190,
        },
      }),
    );
    assert.equal(graphError.ok, false);
    assert.equal(graphError.status, 400);
    assert.ok(!graphError.error!.includes("TOKEN-SECRET-ABC123"));
    assert.match(graphError.error!, /\*\*\*/);
    assert.match(graphError.error!, /code 190/);

    const thrown = await sendMessagingEvents(envWith(w), [event], async () => {
      throw new Error("network down at https://x?access_token=TOKEN-SECRET-ABC123");
    });
    assert.equal(thrown.ok, false);
    assert.ok(!thrown.error!.includes("TOKEN-SECRET-ABC123"));
  });
});

test("redactToken scrubs both the raw token and any access_token= query", () => {
  assert.equal(redactToken("boom TOK12345678 boom", "TOK12345678"), "boom *** boom");
  assert.equal(redactToken("https://x?access_token=abc&y=1", null), "https://x?access_token=***&y=1");
  assert.equal(redactToken("nothing to hide", "short"), "nothing to hide");
});

// ---- drain ----

test("drain: idle tick reads ONE kv row and sends nothing", async () => {
  await withFeatureOn(async () => {
    const w = world();
    let sends = 0;
    const res = await runCapiDrain(envWith(w), NOW, { postNote: async () => {} }, async () => {
      sends++;
      return { ok: true, received: 1, status: 200, error: null, skipped: null };
    });
    assert.equal(res.skipped, "empty");
    assert.equal(sends, 0);
  });
});

test("drain: sends one POST PER EVENT, caps the tick, and clears the rows", async () => {
  await withFeatureOn(async () => {
    const w = world();
    w.contacts.set("p1", { ad_ref: JSON.stringify({ ctwaClid: CLID }) });
    const env = envWith(w);
    for (const kind of ["booked", "attended", "purchase"] as const) {
      await enqueueCapiEvent(env, { kind, phone: "p1", value: 1500 }, NOW);
    }
    const batches: MessagingEvent[][] = [];
    const res = await runCapiDrain(env, NOW, { postNote: async () => {} }, async (_e, events) => {
      batches.push(events);
      return { ok: true, received: events.length, status: 200, error: null, skipped: null };
    });
    assert.equal(res.sent, 3);
    assert.equal(res.failed, 0);
    assert.equal(batches.length, 3, "one request per event (Meta rejects a whole bad batch)");
    for (const b of batches) assert.equal(b.length, 1);
    assert.ok(batches.length <= CAPI_MAX_PER_TICK);
    assert.equal([...w.kv.keys()].filter((k) => k.startsWith("capi_q:")).length, 0);
    assert.equal(w.kv.get(KV_CAPI_PENDING), "0");
    assert.match(w.kv.get(KV_CAPI_LAST_OK)!, /^\d{4}-/);
    assert.equal(w.kv.get("capi_count:" + cdmxDateStr(NOW)), "3");
    // the claims survive, so a later sync can never re-send the same step
    assert.ok(w.kv.has(capiClaimKey("booked", "p1")));
  });
});

test("drain: a failure retries, then gives up after CAPI_MAX_ATTEMPTS, and notes Slack once", async () => {
  await withFeatureOn(async () => {
    const w = world();
    w.contacts.set("p1", { ad_ref: JSON.stringify({ ctwaClid: CLID }) });
    const env = envWith(w);
    await enqueueCapiEvent(env, { kind: "booked", phone: "p1" }, NOW);
    const notes: string[] = [];
    const fail = async () => ({
      ok: false,
      received: 0,
      status: 400,
      error: "Invalid parameter (code 100)",
      skipped: null,
    });
    const deps = { postNote: async (t: string) => void notes.push(t) };

    const first = await runCapiDrain(env, NOW, deps, fail);
    assert.equal(first.failed, 1);
    assert.equal(first.sent, 0);
    assert.match(w.kv.get(KV_CAPI_LAST_ERROR)!, /code 100/);
    // the pass left work behind, so the drain re-arms itself for the next tick
    assert.equal(w.kv.get(KV_CAPI_PENDING), "1");
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /Conversions API/);

    const second = await runCapiDrain(env, NOW + 300, deps, fail);
    assert.equal(second.failed, 1);
    assert.equal(notes.length, 1, "at most one Slack note per CDMX day");

    const third = await runCapiDrain(env, NOW + 600, deps, fail);
    assert.equal(third.dropped, 1, "gives up instead of wedging the queue");
    assert.equal([...w.kv.keys()].filter((k) => k.startsWith("capi_q:")).length, 0);
    assert.equal(CAPI_MAX_ATTEMPTS, 3);
  });
});

test("drain: a row that aged out of Meta's window is dropped, never sent", async () => {
  await withFeatureOn(async () => {
    const w = world();
    const env = envWith(w);
    const stale = {
      kind: "attended" as const,
      phone: "p1",
      ctwaClid: CLID,
      eventTime: NOW - 30 * 86400,
    };
    w.kv.set(capiQueueKey(capiEventId("attended", "p1")), JSON.stringify(stale));
    w.kv.set(capiQueueKey("garbage"), "{not json");
    w.kv.set(KV_CAPI_PENDING, "1");
    let sends = 0;
    const res = await runCapiDrain(env, NOW, { postNote: async () => {} }, async () => {
      sends++;
      return { ok: true, received: 1, status: 200, error: null, skipped: null };
    });
    assert.equal(sends, 0);
    assert.equal(res.dropped, 2);
    assert.equal([...w.kv.keys()].filter((k) => k.startsWith("capi_q:")).length, 0);
  });
});

test("drain: disabled client ⇒ zero queries, zero sends", async () => {
  const w = world();
  w.kv.set(KV_CAPI_PENDING, "1");
  let sends = 0;
  const res = await runCapiDrain(envWith(w), NOW, { postNote: async () => {} }, async () => {
    sends++;
    return { ok: true, received: 1, status: 200, error: null, skipped: null };
  });
  assert.equal(res.skipped, "disabled");
  assert.equal(sends, 0);
});

// ---- small pure helpers ----

test("ctwaClidFromAdRef reads the stored referral JSON, tolerating junk", () => {
  assert.equal(ctwaClidFromAdRef(JSON.stringify({ ctwaClid: CLID })), CLID);
  assert.equal(ctwaClidFromAdRef(JSON.stringify({ ctwaClid: "  " })), null);
  assert.equal(ctwaClidFromAdRef(JSON.stringify({ sourceId: "1" })), null);
  assert.equal(ctwaClidFromAdRef("{not json"), null);
  assert.equal(ctwaClidFromAdRef(null), null);
});

test("parseQueuedEvent rejects malformed rows; eventFromQueued rebuilds the payload", () => {
  assert.equal(parseQueuedEvent(null), null);
  assert.equal(parseQueuedEvent("{"), null);
  assert.equal(parseQueuedEvent(JSON.stringify({ kind: "nope", phone: "p", ctwaClid: "c", eventTime: 1 })), null);
  assert.equal(parseQueuedEvent(JSON.stringify({ kind: "booked", phone: "p", eventTime: 1 })), null);
  const row = parseQueuedEvent(
    JSON.stringify({ kind: "purchase", phone: "p1", ctwaClid: CLID, eventTime: NOW, value: 1500, currency: "MXN" }),
  )!;
  const event = eventFromQueued(row, "W9");
  assert.equal(event.event_name, "Purchase");
  assert.equal(event.user_data.whatsapp_business_account_id, "W9");
  assert.deepEqual(event.custom_data, { value: 1500, currency: "MXN" });
});
