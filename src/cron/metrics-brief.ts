// 08:00 CDMX Slack brief for the marketing funnel. The worker formats only:
// every ratio is Airtable's own formula field on the Días/Meses rows (single
// source of math). English by owner preference. Pure formatter exported.

import type { Env } from "../types.js";
import type { AirtableMetricsMap } from "../client-config.js";
import { kvGet } from "../db/queries.js";
import { cdmxDateStr, cdmxMonthStr, cdmxParts, DAY } from "./time.js";
import {
  EXCEPTION_CAP,
  exceptionCounts,
  getPeriodRow,
  metricsMap,
  numOrNull,
  type ExceptionCounts,
} from "../services/metrics-airtable.js";
import { KV_SPEND_CURRENCY, KV_SPEND_LAST_OK } from "./ad-spend.js";
import { metricsSinceIso } from "./metrics-link.js";

export interface PeriodMetrics {
  spend: number | null;
  conversations: number | null;
  leads: number | null;
  paidLeads: number | null;
  unknownLeads: number | null;
  booked: number | null;
  pastTrials: number | null;
  showed: number | null;
  pending: number | null;
  closed: number | null;
  closedAfterTrial: number | null;
  directCloses: number | null;
  marked: number | null;
  revenue: number | null;
  revenue90: number | null;
  cpl: number | null;
  costPerBooking: number | null;
  costPerShow: number | null;
  costPerClose: number | null;
  showRate: number | null;
  closeRate: number | null;
  roas: number | null;
  roas90: number | null;
  provisional: boolean;
}

const KEYS = [
  "spend",
  "conversations",
  "leads",
  "paidLeads",
  "unknownLeads",
  "booked",
  "pastTrials",
  "showed",
  "pending",
  "closed",
  "closedAfterTrial",
  "directCloses",
  "marked",
  "revenue",
  "revenue90",
  "cpl",
  "costPerBooking",
  "costPerShow",
  "costPerClose",
  "showRate",
  "closeRate",
  "roas",
  "roas90",
] as const;

/** Pure. Airtable row fields (by column name) → typed metrics. */
export function periodFromRecord(
  fields: Record<string, unknown>,
  m: AirtableMetricsMap = metricsMap(),
): PeriodMetrics {
  const out = {} as Record<(typeof KEYS)[number], number | null>;
  for (const k of KEYS) out[k] = numOrNull(fields[m.periods[k]]);
  return { ...out, provisional: numOrNull(fields[m.periods.provisional]) === 1 };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-09-08" → "Tue". */
export function weekdayName(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? "";
}

/** "2026-09" → "September". */
export function monthName(month: string): string {
  const idx = Number(month.slice(5, 7)) - 1;
  return MONTHS[idx] ?? month;
}

function n0(v: number | null): string {
  if (v === null) return "—";
  return Math.round(v)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function money(v: number | null, cur: string): string {
  return v === null ? "—" : `${cur} ${n0(v)}`;
}
function pct(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}
function x(v: number | null): string {
  return v === null ? "—" : `${(Math.round(v * 10) / 10).toFixed(1)}x`;
}

export interface BriefInput {
  /** Yesterday, "YYYY-MM-DD". */
  day: string;
  /** The month yesterday belongs to, "YYYY-MM". */
  month: string;
  dayRow: PeriodMetrics | null;
  monthRow: PeriodMetrics | null;
  exceptions: ExceptionCounts | null;
  currency: string;
  /** ISO of the last successful spend import, or null. */
  spendSyncedAt: string | null;
}

/** Pure. Slack mrkdwn text of the brief. Blanks render as "—", never NaN. */
export function formatBrief(a: BriefInput): string {
  const cur = a.currency || "MXN";
  const lines: string[] = [];
  lines.push(`📈 *Marketing funnel — ${weekdayName(a.day)} ${a.day}* (yesterday)`);
  const d = a.dayRow;
  if (!d || ((d.leads ?? 0) === 0 && (d.spend ?? 0) === 0)) {
    lines.push(`No leads or ad spend recorded for ${a.day} yet.`);
  } else {
    const src: string[] = [];
    if (d.paidLeads !== null) src.push(`${n0(d.paidLeads)} from ads`);
    if ((d.unknownLeads ?? 0) > 0) src.push(`${n0(d.unknownLeads)} unknown`);
    lines.push(
      `Spend ${money(d.spend, cur)} · ${n0(d.leads)} leads${src.length ? ` (${src.join(", ")})` : ""} · CPL ${money(d.cpl, cur)} · ${n0(d.booked)} booked · ${n0(d.showed)} showed · ${n0(d.closed)} closed · revenue ${money(d.revenue, cur)}`,
    );
  }
  const mo = a.monthRow;
  const label = `${monthName(a.month)} to date`;
  if (!mo) {
    lines.push(`*${label}*: no data yet.`);
  } else {
    lines.push(
      `*${label}* (leads created in ${monthName(a.month).slice(0, 3)}, outcomes as of today)${mo.provisional ? " ⚠️ provisional" : ""}`,
    );
    lines.push(
      `Spend ${money(mo.spend, cur)} · ${n0(mo.leads)} leads (${n0(mo.paidLeads)} from ads${(mo.unknownLeads ?? 0) > 0 ? `, ${n0(mo.unknownLeads)} unknown` : ""}) · CPL ${money(mo.cpl, cur)} · cost/booking ${money(mo.costPerBooking, cur)} · cost/show ${money(mo.costPerShow, cur)} · cost/close ${money(mo.costPerClose, cur)}`,
    );
    lines.push(
      `Show rate ${pct(mo.showRate)} (${n0(mo.showed)}/${n0(mo.pastTrials)}, ${n0(mo.pending)} pending) · close rate ${pct(mo.closeRate)} (${n0(mo.closedAfterTrial)}/${n0(mo.showed)}${(mo.directCloses ?? 0) > 0 ? `, +${n0(mo.directCloses)} direct` : ""}) · revenue ${money(mo.revenue, cur)} · ROAS ${x(mo.roas)} (90d ${x(mo.roas90)})`,
    );
    if (mo.conversations !== null && mo.paidLeads !== null && mo.conversations > mo.paidLeads * 1.3) {
      lines.push(
        `ℹ️ Meta counts ${n0(mo.conversations)} conversations vs ${n0(mo.paidLeads)} attributed leads — some ad leads arrive without a referral.`,
      );
    }
  }
  const e = a.exceptions;
  if (e) {
    const c = (v: number): string => (v >= EXCEPTION_CAP ? `${EXCEPTION_CAP}+` : n0(v));
    lines.push(
      `Exceptions: ${c(e.pendingAttendance)} trials awaiting attendance · ${c(e.closedUnknownOrigin)} closes with unknown origin (set Adquisición) · ${c(e.unlinkedPaidStudents)} paid students without lead · ${c(e.incomeWithoutStudent)} payments without student · ${c(e.incomeWithoutConcept)} payments without concept`,
    );
  }
  const synced = a.spendSyncedAt ? fmtSynced(a.spendSyncedAt) : "never";
  lines.push(`Spend synced ${synced} · Airtable → 📊 Dashboard General › 📣 Marketing`);
  return lines.join("\n");
}

function fmtSynced(isoStr: string): string {
  const t = Date.parse(isoStr);
  if (!Number.isFinite(t)) return isoStr;
  const p = cdmxParts(Math.floor(t / 1000));
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} CDMX`;
}

/** Read yesterday's Día + the month's Mes rows, format, post. Returns the text. */
export async function runMetricsBrief(
  env: Env,
  nowEpoch: number,
  deps: { postNote: (text: string) => Promise<void> },
): Promise<string> {
  const m = metricsMap();
  const day = cdmxDateStr(nowEpoch - DAY);
  const month = cdmxMonthStr(nowEpoch - DAY);
  const fields = Object.values(m.periods);
  const dayFields = await getPeriodRow(env, m.tables.days, m.periods.dayKey, day, fields);
  const monthFields = await getPeriodRow(env, m.tables.months, m.periods.monthKey, month, fields);
  let exceptions: ExceptionCounts | null = null;
  const sinceIso = metricsSinceIso(env);
  if (sinceIso) {
    try {
      exceptions = await exceptionCounts(env, sinceIso, m);
    } catch (err) {
      console.warn(`[metrics-brief] exceptions: ${String(err)}`);
    }
  }
  const text = formatBrief({
    day,
    month,
    dayRow: dayFields ? periodFromRecord(dayFields, m) : null,
    monthRow: monthFields ? periodFromRecord(monthFields, m) : null,
    exceptions,
    currency: (await kvGet(env.DB, KV_SPEND_CURRENCY)) ?? "MXN",
    spendSyncedAt: await kvGet(env.DB, KV_SPEND_LAST_OK),
  });
  await deps.postNote(text);
  return text;
}
