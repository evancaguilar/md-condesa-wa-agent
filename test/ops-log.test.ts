// ops_log (services/ops-log.ts): pure helpers + fail-soft IO, and the nightly
// audit's one-message #evan-alerts summary.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildOpsLogQuery,
  criticalAlertLine,
  inferLevel,
  levelsAtLeast,
  listOpsLog,
  pruneOpsLog,
  serializeMeta,
  shouldPostCritical,
  writeOpsLog,
} from "../src/services/ops-log.js";
import { auditSummaryMessage } from "../src/cron/nightly-audit.js";

const NOW = 1_800_000_000;

test("inferLevel: emoji prefix → level, never critical", () => {
  assert.equal(inferLevel("❌ No se pudo registrar 521…"), "error");
  assert.equal(inferLevel("🛑 algo"), "error");
  assert.equal(inferLevel("  ⚠️ Plantillas con error"), "warn");
  assert.equal(inferLevel("📝 Plantilla enviada"), "info");
  assert.equal(inferLevel("🚨 caído"), "error");
});

test("levelsAtLeast: inclusive minimum", () => {
  assert.deepEqual(levelsAtLeast("warn"), ["warn", "error", "critical"]);
  assert.deepEqual(levelsAtLeast("debug").length, 5);
});

test("buildOpsLogQuery: always ts-bounded and limited; params numbered in order", () => {
  const q = buildOpsLogQuery({}, NOW);
  assert.match(q.sql, /WHERE ts >= \?1 ORDER BY id DESC LIMIT 200$/);
  assert.deepEqual(q.params, [NOW - 7 * 86400]);

  const f = buildOpsLogQuery({ minLevel: "error", kind: "blast", from: 10, to: 20, before: 99, limit: 9999 }, NOW);
  assert.equal(
    f.sql,
    "SELECT id, ts, level, kind, message, meta FROM ops_log WHERE ts >= ?1 AND ts < ?2 AND kind = ?3 AND level IN (?4, ?5) AND id < ?6 ORDER BY id DESC LIMIT 500",
  );
  assert.deepEqual(f.params, [10, 20, "blast", "error", "critical", 99]);
});

test("criticalAlertLine: first non-empty line, capped", () => {
  assert.equal(criticalAlertLine("infra", "\n🛑 D1 caída\nQué revisar: …"), "🚨 *infra* — 🛑 D1 caída");
  assert.ok(criticalAlertLine("x", "a".repeat(1000)).length < 330);
});

test("shouldPostCritical: same line inside the window is deduped", () => {
  const line = "🚨 *blast* — pausado";
  assert.equal(shouldPostCritical(null, line, NOW), true);
  assert.equal(shouldPostCritical(`${NOW - 60}|${line}`, line, NOW), false);
  assert.equal(shouldPostCritical(`${NOW - 3600}|${line}`, line, NOW), true);
  assert.equal(shouldPostCritical(`${NOW - 60}|otra cosa`, line, NOW), true);
});

test("serializeMeta: empty ⇒ null, oversized ⇒ truncated wrapper", () => {
  assert.equal(serializeMeta({}), null);
  assert.equal(serializeMeta(undefined), null);
  assert.equal(serializeMeta({ a: 1 }), '{"a":1}');
  const big = serializeMeta({ s: "x".repeat(20_000) })!;
  assert.ok(big.length < 9000);
  assert.ok(JSON.parse(big).truncated);
});

function fakeDb(fail: string | null): { db: D1Database; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  const stmt = (sql: string) => {
    let params: unknown[] = [];
    const s = {
      bind: (...p: unknown[]) => ((params = p), s),
      run: async () => {
        calls.push({ sql, params });
        if (fail) throw new Error(fail);
        return { meta: { changes: 3 } };
      },
      all: async () => {
        calls.push({ sql, params });
        if (fail) throw new Error(fail);
        return { results: [{ id: 1 }] };
      },
    };
    return s;
  };
  return { db: { prepare: stmt } as unknown as D1Database, calls };
}

test("writeOpsLog: inserts; missing table / D1 error never throws", async () => {
  const ok = fakeDb(null);
  assert.equal(await writeOpsLog(ok.db, { level: "info", kind: "seed", message: "hola" }, NOW), true);
  assert.deepEqual(ok.calls[0]!.params, [NOW, "info", "seed", "hola", null]);

  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    assert.equal(await writeOpsLog(fakeDb("D1_ERROR: no such table: ops_log").db, { level: "warn", kind: "x", message: "y" }), false);
    assert.equal(await writeOpsLog(fakeDb("D1 DB is overloaded").db, { level: "warn", kind: "x", message: "y" }), false);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
});

test("listOpsLog / pruneOpsLog: pre-migration is soft, other errors throw", async () => {
  assert.deepEqual(await listOpsLog(fakeDb("no such table: ops_log").db, {}, NOW), { rows: [], migrated: false });
  assert.equal(await pruneOpsLog(fakeDb("no such table: ops_log").db, NOW), 0);
  await assert.rejects(() => listOpsLog(fakeDb("boom").db, {}, NOW));

  const ok = fakeDb(null);
  assert.equal(await pruneOpsLog(ok.db, NOW), 3);
  assert.equal(ok.calls.filter((c) => /CREATE INDEX/.test(c.sql)).length, 3);
  assert.deepEqual(ok.calls.at(-1)!.params, [NOW - 30 * 86400]);
});

test("auditSummaryMessage: one message with resumen, números, counts and link", () => {
  const digest = [
    "🧾 Resumen: 2 leads sin respuesta y un horario inexistente ofrecido.",
    "📊 Números: 14 leads nuevos, 22 conversaciones, 3 agendados, mediana 6 min.",
    "🐛 Problemas:",
    "- 5215511112222: «…» sin respuesta",
    "- 5215533334444: ofreció jueves 8pm",
    "💡 Sugerencias:",
    "- Añadir FAQ de estacionamiento",
  ].join("\n");
  const msg = auditSummaryMessage(digest, "🌙 *Auditor nocturno*", "https://x/admin#logs/audit");
  assert.equal(
    msg,
    [
      "🌙 *Auditor nocturno*",
      "🧾 Resumen: 2 leads sin respuesta y un horario inexistente ofrecido.",
      "📊 14 leads nuevos, 22 conversaciones, 3 agendados, mediana 6 min.",
      "🐛 2 problemas · 💡 1 sugerencia — <https://x/admin#logs/audit|reporte completo en el panel>",
    ].join("\n"),
  );
  assert.ok(!msg.includes("5215511112222"), "detail stays in the panel");
});

test("auditSummaryMessage: clean day and unstructured fallback", () => {
  const clean = auditSummaryMessage("✅ Sin novedades\n📊 Números:\n- 5 leads", "H", "u");
  assert.match(clean, /✅ sin problemas/);
  assert.match(clean, /📊 5 leads/);
  const raw = auditSummaryMessage("texto libre\nsegunda línea", "H", "u");
  assert.match(raw, /^H\ntexto libre\nsegunda línea\n🐛 0 problemas/);
});
