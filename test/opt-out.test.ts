import { test } from "node:test";
import assert from "node:assert/strict";
import { isOptOut } from "../src/pipeline/opt-out.js";
import { OptedOutError, sendTemplate } from "../src/services/wa.js";
import { approveAndSend } from "../src/services/approvals.js";
import type { Contact, Env, PendingApproval } from "../src/types.js";

// ---- positives ------------------------------------------------------------

test("isOptOut: baja", () => {
  assert.equal(isOptOut("baja"), true);
});

test("isOptOut: Baja. (trailing punctuation)", () => {
  assert.equal(isOptOut("Baja."), true);
});

test("isOptOut:  BAJA  (case + surrounding whitespace)", () => {
  assert.equal(isOptOut(" BAJA "), true);
});

test("isOptOut: stop", () => {
  assert.equal(isOptOut("stop"), true);
});

test("isOptOut: Alto!", () => {
  assert.equal(isOptOut("Alto!"), true);
});

test("isOptOut: unsubscribe", () => {
  assert.equal(isOptOut("unsubscribe"), true);
});

test("isOptOut: Ya no me envíen mensajes (accents)", () => {
  assert.equal(isOptOut("Ya no me envíen mensajes"), true);
});

test("isOptOut: no me envien más mensajes. (accent + trailing period)", () => {
  assert.equal(isOptOut("no me envien más mensajes."), true);
});

test("isOptOut: Quiero darme de baja", () => {
  assert.equal(isOptOut("Quiero darme de baja"), true);
});

test("isOptOut: ya no me manden mensajes", () => {
  assert.equal(isOptOut("ya no me manden mensajes"), true);
});

test("isOptOut: Oigan me pueden dejar de mandar mensajes? (Pamela case)", () => {
  assert.equal(isOptOut("Oigan me pueden dejar de mandar mensajes?"), true);
});

test("isOptOut: hola por favor dejen de mandarme mensajes", () => {
  assert.equal(isOptOut("hola por favor dejen de mandarme mensajes"), true);
});

test("isOptOut: ya no quiero recibir mensajes", () => {
  assert.equal(isOptOut("ya no quiero recibir mensajes"), true);
});

// ---- negatives (no substring matching) -------------------------------------

test("isOptOut: false for cuando quieran pueden dejar de mandar mensajes (non-filler lead-in)", () => {
  assert.equal(isOptOut("cuando quieran pueden dejar de mandar mensajes"), false);
});

test("isOptOut: false for hola quiero recibir mensajes", () => {
  assert.equal(isOptOut("hola quiero recibir mensajes"), false);
});

test("isOptOut: false for hola quiero info", () => {
  assert.equal(isOptOut("hola quiero info"), false);
});

test("isOptOut: false for baja de peso (contains baja, not exact)", () => {
  assert.equal(isOptOut("baja de peso"), false);
});

test("isOptOut: false for alto rendimiento (contains alto, not exact)", () => {
  assert.equal(isOptOut("alto rendimiento"), false);
});

test("isOptOut: false for no me envien el video (not the exact phrase)", () => {
  assert.equal(isOptOut("no me envien el video"), false);
});

test("isOptOut: false for quiero darme de baja del curso (extra words)", () => {
  assert.equal(isOptOut("quiero darme de baja del curso"), false);
});

test("isOptOut: false for stop, mejor mándame la info (extra words)", () => {
  assert.equal(isOptOut("stop, mejor mándame la info"), false);
});

// ---- enforcement (F5): the gates that make a baja actually stick -------------

// Tiny scriptable fake D1 (same shape as cron.test.ts / nudges.test.ts).
type Handler = (sql: string, binds: unknown[]) => {
  first?: unknown;
  all?: unknown[];
  changes?: number;
};

function fakeDb(handler: Handler): D1Database {
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const stmt: D1PreparedStatement = {
      bind(...v: unknown[]) {
        binds = v;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        return (handler(sql, binds).first ?? null) as T | null;
      },
      async run() {
        return { results: [], meta: { changes: handler(sql, binds).changes ?? 1 } };
      },
      async all<T>() {
        return { results: (handler(sql, binds).all ?? []) as T[], meta: {} };
      },
    };
    return stmt;
  };
  return { prepare: make } as D1Database;
}

function envWith(db: D1Database): Env {
  return { DB: db, WA_PHONE_NUMBER_ID: "1", WA_ACCESS_TOKEN: "t" } as unknown as Env;
}

function optedOutContact(): Contact {
  return {
    phone: "5215512345678",
    name: "Ana",
    lang: "es",
    status: "opted_out",
    qualification: null,
    human_override_until: null,
    last_inbound_at: Math.floor(Date.now() / 1000),
    campaign_id: null,
    ad_ref: null,
    airtable_lead_id: null,
    created_at: 0,
    updated_at: 0,
  };
}

/** Counts Graph sends; returns a wamid so the happy path completes. */
function countingFetch(): () => number {
  let sends = 0;
  (globalThis as { fetch: unknown }).fetch = async () => {
    sends++;
    return {
      ok: true,
      status: 200,
      async json() {
        return { messages: [{ id: "wamid.X" }] };
      },
      async text() {
        return "";
      },
    };
  };
  return () => sends;
}

test("sendTemplate: opted-out contact → OptedOutError, nothing hits Graph", async () => {
  const sends = countingFetch();
  const db = fakeDb((sql) => {
    if (sql.includes("SELECT * FROM contacts")) return { first: optedOutContact() };
    return {};
  });
  let thrown: unknown = null;
  try {
    await sendTemplate(envWith(db), "5215512345678", "reengage_lead_es", "es");
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof OptedOutError, "must throw OptedOutError");
  assert.equal((thrown as OptedOutError).phone, "5215512345678");
  assert.equal(sends(), 0);
});

test("sendTemplate: force:true bypasses the opt-out guard", async () => {
  const sends = countingFetch();
  const db = fakeDb((sql) => {
    if (sql.includes("SELECT * FROM contacts")) return { first: optedOutContact() };
    return {};
  });
  const wamid = await sendTemplate(
    envWith(db),
    "5215512345678",
    "reengage_lead_es",
    "es",
    undefined,
    { force: true },
  );
  assert.equal(wamid, "wamid.X");
  assert.equal(sends(), 1);
});

test("sendTemplate: normal lead still sends", async () => {
  const sends = countingFetch();
  const db = fakeDb((sql) => {
    if (sql.includes("SELECT * FROM contacts"))
      return { first: { ...optedOutContact(), status: "lead" } };
    return {};
  });
  await sendTemplate(envWith(db), "5215512345678", "reengage_lead_es", "es");
  assert.equal(sends(), 1);
});

test("approveAndSend: opted-out lead → draft discarded, reason opted_out, no send", async () => {
  const sends = countingFetch();
  const approval: PendingApproval = {
    id: 7,
    phone: "5215512345678",
    draft: "¿Te late el martes?",
    context: null,
    confidence: "high",
    status: "pending",
    slack_ts: null, // no Slack card → card helpers no-op
    final_text: null,
    holding_sent: 0,
    created_at: 0,
    resolved_at: null,
  };
  let claimedStatus: unknown = null;
  const db = fakeDb((sql, binds) => {
    if (sql.includes("SELECT * FROM pending_approvals")) return { first: approval };
    if (sql.includes("SELECT * FROM contacts")) return { first: optedOutContact() };
    if (sql.includes("UPDATE pending_approvals")) {
      claimedStatus = binds[1];
      return { changes: 1 };
    }
    return {};
  });
  const res = await approveAndSend(envWith(db), 7);
  assert.deepEqual(res, { ok: false, reason: "opted_out" });
  assert.equal(claimedStatus, "discarded");
  assert.equal(sends(), 0);
});
