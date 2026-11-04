// Agenda tab pure helpers (src/services/agenda-core.ts). Fake clocks only:
// anchor Mon 2026-10-26 (CDMX), no Intl, no Date.now().

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  agendaFormula,
  agendaWindow,
  cdmxMidnight,
  dayLabelEs,
  filterForView,
  groupByClassTime,
  joinContacts,
  nextResultValue,
  phonesOf,
  reminderKindFor,
  resolveWhoTrains,
  rowFromRecord,
  sameDayKeysOf,
  timeLabel12h,
  windowOpenAt,
  type AgendaContact,
  type AgendaRow,
} from "../src/services/agenda-core.js";
import { DEFAULT_LEADS_MAP } from "../src/services/airtable.js";
import { cdmxToEpoch, DAY } from "../src/cron/time.js";
import type { AirtableLeadsMap } from "../src/client-config.js";

const MAP: AirtableLeadsMap = {
  ...DEFAULT_LEADS_MAP,
  phone: "# de Teléfono",
  name: "Nombre de Lead",
  trialDateTime: "Fecha Clase Prueba",
  discipline: "Actividad",
  audience: "Programa",
  result: "Resultado Clase Prueba",
  childName: "Nombre Del Niñ@",
  whoTrains: "Quién entrena",
  cuestionarioStatus: "Respuestas cuestionario",
  enrolled: "Se inscribió",
};
const RESULT = "Resultado Clase Prueba";

// Mon 2026-10-26 10:30 CDMX
const NOW = cdmxToEpoch(2026, 10, 26, 10, 30);
const T = (d: number, h: number, m = 0): number => cdmxToEpoch(2026, 10, d, h, m);
const iso = (epoch: number): string => new Date(epoch * 1000).toISOString();

function rec(id: string, fields: Record<string, unknown>): { id: string; fields: Record<string, unknown> } {
  return { id, fields };
}

test("agendaWindow: hoy / mañana are CDMX days, por_confirmar looks 7 days ahead, no_asistieron 7 back", () => {
  const today = cdmxMidnight(NOW);
  assert.equal(today, T(26, 0));
  assert.deepEqual(agendaWindow("hoy", NOW), { fromEpoch: T(26, 0), toEpoch: T(27, 0) });
  assert.deepEqual(agendaWindow("manana", NOW), { fromEpoch: T(27, 0), toEpoch: T(28, 0) });
  assert.deepEqual(agendaWindow("por_confirmar", NOW), { fromEpoch: T(26, 0), toEpoch: T(26, 0) + 7 * DAY });
  assert.deepEqual(agendaWindow("no_asistieron", NOW), { fromEpoch: T(20, 0), toEpoch: T(27, 0) });
});

test("agendaWindow: 23:30 CDMX is still today (UTC already rolled over)", () => {
  const late = cdmxToEpoch(2026, 10, 26, 23, 30);
  assert.deepEqual(agendaWindow("hoy", late), { fromEpoch: T(26, 0), toEpoch: T(27, 0) });
});

test("agendaFormula: UTC instants, field braces escaped, empty cells excluded", () => {
  const f = agendaFormula("Fecha Clase Prueba", agendaWindow("hoy", NOW));
  assert.equal(
    f,
    "AND({Fecha Clase Prueba}, IS_AFTER({Fecha Clase Prueba}, '2026-10-26T05:59:59.000Z'), IS_BEFORE({Fecha Clase Prueba}, '2026-10-27T06:00:00.000Z'))",
  );
  assert.ok(!agendaFormula("{Weird}", agendaWindow("hoy", NOW)).includes("{{"));
});

test("rowFromRecord: child vs parent, formula wins, phone normalized to wa_id, multi-selects joined", () => {
  const r = rowFromRecord(
    rec("rec1", {
      "Fecha Clase Prueba": iso(T(26, 15, 15)),
      "Nombre de Lead": "Amairani Rivera",
      "Nombre Del Niñ@": "Enya",
      "Quién entrena": "Enya",
      "# de Teléfono": "+52 55 1234 5678",
      Programa: "Mini Muay Thai",
      Actividad: ["Muay Thai Kids"],
      "Respuestas cuestionario": "✅ Cuestionario completado",
      [RESULT]: ["Asistió", "Reprogramó"],
      "Se inscribió": false,
    }),
    MAP,
    RESULT,
  );
  assert.equal(r.recordId, "rec1");
  assert.equal(r.trialEpoch, T(26, 15, 15));
  assert.equal(r.dateKey, "2026-10-26");
  assert.equal(r.leadName, "Amairani Rivera");
  assert.equal(r.childName, "Enya");
  assert.equal(r.whoTrains, "Enya");
  assert.equal(r.phone, "5215512345678");
  assert.equal(r.programa, "Mini Muay Thai");
  assert.deepEqual(r.actividad, ["Muay Thai Kids"]);
  assert.equal(r.cuestionario, "✅ Cuestionario completado");
  assert.equal(r.result, "Asistió, Reprogramó");
  assert.equal(r.resultClass, "attended");
  assert.equal(r.enrolled, false);
  assert.equal(r.lost, false);
});

test("rowFromRecord: adult without child → who trains is the lead; no formula column → derived", () => {
  const mapNoFormula: AirtableLeadsMap = { ...MAP, whoTrains: undefined, enrolled: undefined };
  const adult = rowFromRecord(
    rec("rec2", { "Fecha Clase Prueba": iso(T(26, 7)), "Nombre de Lead": "Diego Vargas", "# de Teléfono": "5215599887766", [RESULT]: "Se inscribió" }),
    mapNoFormula,
    RESULT,
  );
  assert.equal(adult.whoTrains, "Diego Vargas");
  assert.equal(adult.childName, null);
  assert.equal(adult.enrolled, true); // derived from the result when no checkbox is mapped
  const kid = rowFromRecord(
    rec("rec3", { "Nombre de Lead": "Mamá", "Nombre Del Niñ@": "  Romy  " }),
    mapNoFormula,
    RESULT,
  );
  assert.equal(kid.whoTrains, "Romy");
  assert.equal(kid.trialEpoch, null);
  assert.equal(kid.dateKey, null);
  assert.equal(kid.phone, null);
});

test("rowFromRecord: unreadable phone or date → null, never throws", () => {
  const r = rowFromRecord(rec("rec4", { "Fecha Clase Prueba": "ayer", "# de Teléfono": "sin número" }), MAP, RESULT);
  assert.equal(r.trialEpoch, null);
  assert.equal(r.phone, null);
  assert.equal(r.phoneRaw, "sin número");
});

test("resolveWhoTrains precedence: formula > child > lead > null", () => {
  assert.equal(resolveWhoTrains({ whoTrains: "F", childName: "C", leadName: "L" }), "F");
  assert.equal(resolveWhoTrains({ whoTrains: " ", childName: "C", leadName: "L" }), "C");
  assert.equal(resolveWhoTrains({ childName: null, leadName: "L" }), "L");
  assert.equal(resolveWhoTrains({}), null);
});

function row(over: Partial<AgendaRow>): AgendaRow {
  return {
    recordId: "r",
    trialIso: null,
    trialEpoch: null,
    dateKey: null,
    leadName: null,
    childName: null,
    whoTrains: null,
    phoneRaw: null,
    phone: null,
    programa: null,
    actividad: [],
    cuestionario: null,
    result: null,
    resultClass: null,
    lost: false,
    enrolled: false,
    ...over,
  };
}

test("filterForView: por_confirmar keeps only upcoming rows with no outcome", () => {
  const rows = [
    row({ recordId: "future", trialEpoch: T(27, 8), dateKey: "2026-10-27" }),
    row({ recordId: "past", trialEpoch: T(26, 7), dateKey: "2026-10-26" }),
    row({ recordId: "done", trialEpoch: T(27, 8), resultClass: "attended", result: "Asistió" }),
    row({ recordId: "lost", trialEpoch: T(27, 8), lost: true, result: "Perdido" }),
    row({ recordId: "enrolled", trialEpoch: T(27, 8), enrolled: true }),
    row({ recordId: "undated" }),
  ];
  assert.deepEqual(filterForView(rows, "por_confirmar", NOW).map((r) => r.recordId), ["future"]);
  assert.equal(filterForView(rows, "hoy", NOW).length, 6);
  assert.equal(filterForView(rows, "manana", NOW).length, 6);
});

test("filterForView: no_asistieron = plain no-shows only", () => {
  const rows = [
    row({ recordId: "ns", resultClass: "no_show", result: "No asistió" }),
    row({ recordId: "ns-lost", resultClass: "no_show", result: "No asistió, Perdido", lost: true }),
    row({ recordId: "came", resultClass: "attended", result: "Asistió, No asistió" }),
    row({ recordId: "signed", resultClass: "no_show", enrolled: true }),
    row({ recordId: "none" }),
  ];
  assert.deepEqual(filterForView(rows, "no_asistieron", NOW).map((r) => r.recordId), ["ns"]);
});

test("windowOpenAt: strictly inside 24h", () => {
  assert.equal(windowOpenAt(NOW - 3600, NOW), true);
  assert.equal(windowOpenAt(NOW - DAY, NOW), false);
  assert.equal(windowOpenAt(null, NOW), false);
  assert.equal(windowOpenAt(0, NOW), false);
});

test("phonesOf / sameDayKeysOf: distinct, dated rows only", () => {
  const rows = [
    row({ phone: "5215511111111", dateKey: "2026-10-26" }),
    row({ phone: "5215511111111", dateKey: "2026-10-26" }),
    row({ phone: "5215522222222" }),
    row({ dateKey: "2026-10-26" }),
  ];
  assert.deepEqual(phonesOf(rows), ["5215511111111", "5215522222222"]);
  assert.deepEqual(sameDayKeysOf(rows), ["same_day_sent:5215511111111:2026-10-26"]);
});

test("joinContacts: matches by wa_id, window + reminder flags", () => {
  const rows = [
    row({ recordId: "a", phone: "5215511111111", dateKey: "2026-10-26" }),
    row({ recordId: "b", phone: "5215522222222", dateKey: "2026-10-26" }),
    row({ recordId: "c" }),
  ];
  const contacts = new Map<string, AgendaContact>([
    ["5215511111111", { phone: "5215511111111", name: "Ana", status: "lead", lastInboundAt: NOW - 600 }],
  ]);
  const out = joinContacts(rows, contacts, new Set(["same_day_sent:5215522222222:2026-10-26"]), NOW);
  assert.equal(out[0]!.contact?.name, "Ana");
  assert.equal(out[0]!.windowOpen, true);
  assert.equal(out[0]!.sameDaySent, false);
  assert.equal(out[1]!.contact, null);
  assert.equal(out[1]!.windowOpen, false);
  assert.equal(out[1]!.sameDaySent, true);
  assert.equal(out[2]!.contact, null);
});

test("groupByClassTime: by CDMX slot soonest first, undated last, names sorted inside", () => {
  const mk = (id: string, epoch: number | null, who: string): ReturnType<typeof joinContacts>[number] => ({
    ...row({ recordId: id, trialEpoch: epoch, dateKey: epoch === null ? null : "2026-10-26", whoTrains: who }),
    contact: null,
    windowOpen: false,
    sameDaySent: false,
  });
  const groups = groupByClassTime([
    mk("late", T(26, 16), "Romy"),
    mk("undated", null, "X"),
    mk("mini2", T(26, 15, 15), "Enya"),
    mk("early", T(26, 7), "Diego"),
    mk("mini1", T(26, 15, 15), "Amairani"),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.key, g.timeLabel, g.rows.map((r) => r.recordId)]),
    [
      ["2026-10-26T07:00", "7:00 am", ["early"]],
      ["2026-10-26T15:15", "3:15 pm", ["mini1", "mini2"]],
      ["2026-10-26T16:00", "4:00 pm", ["late"]],
      ["sin-fecha", null, ["undated"]],
    ],
  );
  assert.equal(groups[0]!.dayLabel, "lun 26 oct");
});

test("timeLabel12h / dayLabelEs: CDMX wall clock, 12-hour, noon and midnight", () => {
  assert.equal(timeLabel12h(T(26, 0)), "12:00 am");
  assert.equal(timeLabel12h(T(26, 12)), "12:00 pm");
  assert.equal(timeLabel12h(T(26, 19, 5)), "7:05 pm");
  assert.equal(dayLabelEs(T(31, 13, 15)), "sáb 31 oct");
});

test("nextResultValue: swaps only the Asistió / No asistió pair", () => {
  assert.deepEqual(nextResultValue(["No asistió", "Reprogramó"], "attended"), ["Reprogramó", "Asistió"]);
  assert.deepEqual(nextResultValue(["Asistió"], "no_show"), ["No asistió"]);
  assert.deepEqual(nextResultValue(["Asistió", "Perdido"], "clear"), ["Perdido"]);
  assert.deepEqual(nextResultValue(undefined, "attended"), ["Asistió"]);
  assert.deepEqual(nextResultValue("Se inscribió", "no_show"), ["Se inscribió", "No asistió"]);
});

test("reminderKindFor: today → same_day, tomorrow → day_before, later → null", () => {
  assert.equal(reminderKindFor(T(26, 19), NOW), "same_day");
  assert.equal(reminderKindFor(T(26, 7), NOW), "same_day"); // already past today: late arrival still confirmable
  assert.equal(reminderKindFor(T(27, 8), NOW), "day_before");
  assert.equal(reminderKindFor(T(28, 8), NOW), null);
  // 23:59 CDMX, class at 00:30 "tomorrow" CDMX → day_before even though UTC is the same day
  assert.equal(reminderKindFor(cdmxToEpoch(2026, 10, 27, 0, 30), cdmxToEpoch(2026, 10, 26, 23, 59)), "day_before");
});
