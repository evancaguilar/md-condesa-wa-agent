// Angry leads always stop the sequence and go to a human (owner, 2026-11-10).
// routeResult sets the declined stop (source "complaint") on every
// complaint-class escalation — escalate_to_human or a draft with a complaint
// reason — on top of the existing human task. Explicit stop wording is still
// a full baja (opt-out gate), never just a decline.

import { test } from "node:test";
import assert from "node:assert/strict";
import { declineNote, encodeDeclineMarker, parseDeclineMarker, routeDeclineSource } from "../src/pipeline/decline.js";
import { classifyEscalation, escalationNeedsTask } from "../src/services/slack-timeouts.js";
import { isOptOut } from "../src/pipeline/opt-out.js";
import { applyDecline, isDeclined } from "../src/services/decline-stop.js";

test("routeDeclineSource: complaint escalations (escalate or draft) set the stop", () => {
  for (const reason of ["complaint", "queja: lead enojado por los mensajes", "Lead molesto, reclama cobro"]) {
    const kind = classifyEscalation(reason);
    assert.equal(kind, "complaint", reason);
    assert.equal(escalationNeedsTask(kind), true, "the human task still goes out");
    assert.equal(routeDeclineSource({ action: "escalate", escalationKind: kind }), "complaint");
    assert.equal(routeDeclineSource({ action: "draft", escalationKind: kind, message: "Perdón 🙏 ya le paso tu mensaje al equipo." }), "complaint");
  }
});

test("routeDeclineSource: complaint wins over the brain flag / promise; other escalations don't set it", () => {
  assert.equal(routeDeclineSource({ action: "draft", escalationKind: "complaint", leadDeclined: true, message: "No te molestamos más." }), "complaint");
  assert.equal(routeDeclineSource({ action: "escalate", escalationKind: "price" }), null);
  assert.equal(routeDeclineSource({ action: "escalate", escalationKind: null }), null);
  assert.equal(routeDeclineSource({ action: "draft", escalationKind: "private_class", message: "¡Claro!" }), null);
  // unchanged send/draft rules
  assert.equal(routeDeclineSource({ action: "send", escalationKind: null, leadDeclined: true, message: "ok" }), "brain");
  assert.equal(routeDeclineSource({ action: "send", escalationKind: null, message: "No te molestamos más." }), "promise");
  assert.equal(routeDeclineSource({ action: "send", escalationKind: null, message: "¿Te late el sábado?" }), null);
  assert.equal(routeDeclineSource({ action: "book", escalationKind: "complaint" }), null);
});

test("explicit stop wording is still a full baja", () => {
  assert.equal(isOptOut("Ya dejen de mandarme mensajes"), true);
});

test("complaint marker round-trips and its note names it", () => {
  assert.deepEqual(parseDeclineMarker(encodeDeclineMarker({ ts: 5, source: "complaint", text: "qué molestos" })), {
    ts: 5,
    source: "complaint",
    text: "qué molestos",
  });
  assert.match(declineNote("5215500000000", "complaint", 2), /queja.*2 envío\(s\)/);
});

test("applyDecline with source complaint writes the marker and cancels chasing rows", async () => {
  const kv = new Map<string, string>();
  const cancels: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      let b: unknown[] = [];
      const s = sql.replace(/\s+/g, " ").trim();
      const stmt = {
        bind: (...v: unknown[]) => ((b = v), stmt),
        first: async () => (s.startsWith("SELECT value FROM kv") ? (kv.has(String(b[0])) ? { value: kv.get(String(b[0])) } : null) : null),
        run: async () => {
          if (s.startsWith("INSERT INTO kv")) kv.set(String(b[0]), String(b[1]));
          if (s.startsWith("UPDATE followups")) cancels.push(b);
          return { results: [], meta: { changes: s.startsWith("UPDATE followups") ? 3 : 1 } };
        },
        all: async () => ({ results: [], meta: {} }),
      };
      return stmt;
    },
  } as unknown as D1Database;
  const notes: string[] = [];
  const r = await applyDecline(db, "5215500000000", "complaint", { text: "qué molestos", postNote: async (t) => void notes.push(t) });
  assert.deepEqual(r, { cancelled: 3, fresh: true });
  assert.equal(await isDeclined(db, "5215500000000"), true);
  assert.equal(parseDeclineMarker(kv.get("declined:5215500000000"))!.source, "complaint");
  assert.equal(cancels.length, 1);
  assert.equal(notes.length, 1);
});
