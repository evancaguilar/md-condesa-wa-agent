import { test } from "node:test";
import assert from "node:assert/strict";

import { formatBrief, monthName, periodFieldList, periodFromRecord, weekdayName } from "../src/cron/metrics-brief.js";
import { DEFAULT_METRICS_MAP } from "../src/services/metrics-airtable.js";

const M = DEFAULT_METRICS_MAP;

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Gasto: 9870,
    "Conversaciones Meta": 90,
    "Total Leads": 95,
    "Leads Pagados": 80,
    Desconocidos: 3,
    Agendaron: 40,
    "Pruebas Vencidas": 30,
    Asistieron: 22,
    Pendientes: 4,
    Cerraron: 9,
    "Cerraron Tras Prueba": 9,
    "Cierres Directos": 2,
    "Inscritos (marcados)": 10,
    Ingresos: 26964,
    "Ingresos 90d": 20000,
    CPL: 123.4,
    "Costo por Agendada": 246.75,
    "Costo por Asistencia": 448.6,
    "Costo por Cierre": 1096.7,
    "Show Rate": 0.7333,
    "Close Rate": 0.409,
    ROAS: 2.73,
    "ROAS 90d": 2.03,
    Provisional: 1,
    ...over,
  };
}

test("periodFieldList never requests a table's own key; Provisional only for Meses", () => {
  const days = periodFieldList(M);
  assert.equal(days.length, 23);
  assert.ok(!days.includes("Día") && !days.includes("Mes") && !days.includes("Provisional"));
  assert.ok(days.includes("Gasto") && days.includes("Total Leads") && days.includes("ROAS 90d"));
  const months = periodFieldList(M, { withProvisional: true });
  assert.equal(months.length, 24);
  assert.ok(months.includes("Provisional") && !months.includes("Mes"));
});

test("weekdayName / monthName", () => {
  assert.equal(weekdayName("2026-09-08"), "Tue");
  assert.equal(weekdayName("2026-09-13"), "Sun");
  assert.equal(monthName("2026-09"), "September");
  assert.equal(monthName("2026-01"), "January");
});

test("periodFromRecord maps by column name and tolerates error cells", () => {
  const p = periodFromRecord(row({ CPL: { specialValue: "NaN" }, ROAS: "2.5" }), M);
  assert.equal(p.spend, 9870);
  assert.equal(p.leads, 95);
  assert.equal(p.cpl, null);
  assert.equal(p.roas, 2.5);
  assert.equal(p.provisional, true);
  assert.equal(periodFromRecord({}, M).provisional, false);
});

test("formatBrief: full rows → yesterday + MTD + exceptions, no NaN, provisional flag", () => {
  const text = formatBrief({
    day: "2026-09-08",
    month: "2026-09",
    dayRow: periodFromRecord(row({ Gasto: 1234, "Total Leads": 12, "Leads Pagados": 10, Desconocidos: 1, Agendaron: 5, Asistieron: 3, Cerraron: 1, Ingresos: 2996, CPL: 123.4 }), M),
    monthRow: periodFromRecord(row(), M),
    exceptions: { pendingAttendance: 4, unlinkedPaidStudents: 3, incomeWithoutStudent: 9, incomeWithoutConcept: 300, closedUnknownOrigin: 12 },
    currency: "MXN",
    spendSyncedAt: "2026-09-09T11:32:00.000Z",
  });
  assert.match(text, /Tue 2026-09-08/);
  assert.match(text, /Spend MXN 1,234 · 12 leads \(10 from ads, 1 unknown\) · CPL MXN 123 · 5 booked · 3 showed · 1 closed · revenue MXN 2,996/);
  assert.match(text, /September to date/);
  assert.match(text, /⚠️ provisional/);
  assert.match(text, /Spend MXN 9,870 · 95 leads \(80 from ads, 3 unknown\) · CPL MXN 123 · cost\/booking MXN 247 · cost\/show MXN 449 · cost\/close MXN 1,097/);
  assert.match(text, /Show rate 73% \(22\/30, 4 pending\) · close rate 41% \(9\/22, \+2 direct\) · revenue MXN 26,964 · ROAS 2.7x \(90d 2.0x\)/);
  assert.match(text, /Exceptions: 4 trials awaiting attendance · 12 closes with unknown origin \(set Adquisición\) · 3 paid students without lead · 9 payments without student · 300\+ payments without concept/);
  assert.match(text, /Spend synced 2026-09-09 05:32 CDMX/);
  assert.ok(!/NaN|undefined|null/.test(text));
});

test("formatBrief: no rows → explicit no-data lines, never synced", () => {
  const text = formatBrief({
    day: "2026-10-01",
    month: "2026-10",
    dayRow: null,
    monthRow: null,
    exceptions: null,
    currency: "",
    spendSyncedAt: null,
  });
  assert.match(text, /No leads or ad spend recorded for 2026-10-01 yet/);
  assert.match(text, /October to date\*: no data yet/);
  assert.match(text, /Spend synced never/);
  assert.ok(!text.includes("Exceptions:"));
});

test("formatBrief: blank ratios render as — and Meta-vs-attributed hint fires on a gap", () => {
  const text = formatBrief({
    day: "2026-09-08",
    month: "2026-09",
    dayRow: periodFromRecord(row({ CPL: null, Cerraron: 0 }), M),
    monthRow: periodFromRecord(row({ "Show Rate": null, ROAS: null, "ROAS 90d": null, "Conversaciones Meta": 200, Provisional: 0, "Cierres Directos": 0 }), M),
    exceptions: null,
    currency: "MXN",
    spendSyncedAt: "bad-date",
  });
  assert.match(text, /CPL — /);
  assert.match(text, /Show rate — /);
  assert.match(text, /ROAS — \(90d —\)/);
  assert.match(text, /Meta counts 200 conversations vs 80 attributed leads/);
  assert.ok(!text.includes("provisional"));
  assert.ok(!text.includes("direct"));
  assert.match(text, /Spend synced bad-date/);
});
