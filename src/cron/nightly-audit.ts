// Auditor nocturno (owner directive 2026-08-28): once a day, an OPUS-tier
// review of the last 24h of conversations. Since 2026-10-22 the FULL report
// goes to the D1 ops_log (kind "audit", /admin → Logs) and #evan-alerts gets
// ONE summary message (auditSummaryMessage) linking to it. It REPORTS — it never edits code, campaigns, or the KB, and
// it never messages a lead. Structural fixes stay with a human + Claude Code.
//
// Cost note: claude-opus-5-5 at $4/$20 per MTok over a compacted day (~30–60K
// input, ~2K output incl. thinking) ≈ $0.15–0.30 per night. Usage is accrued
// into the same usage_log the budget report reads, at OPUS rates.

import type { Env } from "../types.js";
import { callAnthropic, type ApiMessage, type ApiUsage } from "../brain/claude.js";
import type { SystemBlock } from "../brain/prompt.js";
import { SLOTS } from "../brain/slots.gen.js";
import { accrueUsage } from "../db/queries.js";
import { listApprovalHistory, namesForPhones } from "../db/queries-admin.js";
import { cdmxDateStr } from "./time.js";
import { dashboardUrl } from "../services/dashboard-link.js";

export const AUDIT_MODEL = "claude-opus-5-5";
// Owner call 2026-10-26: Opus 5.5 at medium effort (was opus-5 high).
const AUDIT_EFFORT = "medium" as const;
/** Thinking spends from this too; the digest itself is ~1–2K tokens. */
const AUDIT_MAX_TOKENS = 12000;
/** Compacted transcript budget (chars ≈ tokens×3.5). Oldest convos drop first. */
const MAX_DATA_CHARS = 220_000;
/** Slack message ceiling per postNote chunk. */
// Slack rejects a section block over 3,000 characters ("invalid_blocks"), so a
// 3,400 chunk made the whole digest vanish from #bot-ops (2026-10-07/08: only
// the header posted). Keep headroom for mrkdwn escaping.
const SLACK_CHUNK = 2800;

const PRICE_IN = 4 / 1_000_000;
const PRICE_OUT = 20 / 1_000_000;

export interface AuditMessageRow {
  phone: string;
  direction: string;
  body: string;
  ts: number;
}

export interface AuditApprovalRow {
  id: number;
  phone: string;
  draft: string;
  final_text: string | null;
  status: string;
  created_at: number;
  resolved_at: number | null;
}

// ---- pure: when to run (retry-safe daily schedule) -------------------------
//
// 2026-10-20 had no report: the dispatcher wrote the day mark BEFORE the run,
// so a thrown run was never retried. Now the mark is written only after a
// successful run; attempts are tracked in kv `nightly_audit_try` with a lease
// (a killed run — Worker wall time — can't be told from a slow one, so a new
// attempt waits until the lease of the last one expires), at most
// NIGHTLY_AUDIT_MAX_ATTEMPTS inside the 05:00 hour, and ONE #evan-alerts note
// if the day ends up with no report.

export const NIGHTLY_AUDIT_MARK_KEY = "nightly_audit_mark";
export const NIGHTLY_AUDIT_TRY_KEY = "nightly_audit_try";
export const NIGHTLY_AUDIT_HOUR = 5;
export const NIGHTLY_AUDIT_MAX_ATTEMPTS = 3;
/** A started attempt blocks the next one for this long (cron ticks are 5 min). */
export const NIGHTLY_AUDIT_LEASE_SECONDS = 15 * 60;

export interface NightlyAuditTry {
  /** CDMX date the attempts belong to. */
  date: string;
  /** Attempts started that day. */
  n: number;
  /** Epoch of the running attempt; 0 once it finished (ok or thrown). */
  startedAt: number;
  /** Last thrown error (capped), for the give-up note. */
  lastError?: string;
  /** The give-up note already went out. */
  noted?: boolean;
}

export function parseNightlyAuditTry(raw: string | null): NightlyAuditTry | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<NightlyAuditTry>;
    if (typeof o.date !== "string" || typeof o.n !== "number") return null;
    return {
      date: o.date,
      n: o.n,
      startedAt: typeof o.startedAt === "number" ? o.startedAt : 0,
      ...(typeof o.lastError === "string" ? { lastError: o.lastError } : {}),
      ...(o.noted === true ? { noted: true } : {}),
    };
  } catch {
    return null;
  }
}

export type NightlyAuditStep =
  | { action: "skip" }
  | { action: "run"; attempt: number }
  | { action: "give_up"; attempts: number; lastError: string | null };

/**
 * Pure. What this tick does about today's audit. Runs only in the 05:00 CDMX
 * hour; gives up (one note) once the attempts are spent or the hour is over
 * (checked through 06:59) with no successful run.
 */
export function nightlyAuditStep(opts: {
  hour: number;
  today: string;
  now: number;
  mark: string | null;
  state: NightlyAuditTry | null;
}): NightlyAuditStep {
  if (opts.hour !== NIGHTLY_AUDIT_HOUR && opts.hour !== NIGHTLY_AUDIT_HOUR + 1) return { action: "skip" };
  if (opts.mark === opts.today) return { action: "skip" };
  const st: NightlyAuditTry =
    opts.state && opts.state.date === opts.today ? opts.state : { date: opts.today, n: 0, startedAt: 0 };
  if (st.noted) return { action: "skip" };
  if (st.startedAt > 0 && opts.now - st.startedAt < NIGHTLY_AUDIT_LEASE_SECONDS) return { action: "skip" };
  if (opts.hour === NIGHTLY_AUDIT_HOUR && st.n < NIGHTLY_AUDIT_MAX_ATTEMPTS) {
    return { action: "run", attempt: st.n + 1 };
  }
  return { action: "give_up", attempts: st.n, lastError: st.lastError ?? null };
}

/** The #evan-alerts line when the day ends with no report. Pure. */
export function nightlyAuditGiveUpNote(step: { attempts: number; lastError: string | null }, today: string): string {
  const why =
    step.attempts === 0
      ? "no llegó a correr en la hora de las 05:00"
      : `falló ${step.attempts} ${step.attempts === 1 ? "vez" : "veces"}${step.lastError ? ` — último error: ${step.lastError}` : " (sin error registrado: posible timeout del Worker)"}`;
  return `⚠️ Auditor nocturno ${today}: no hay reporte hoy — ${why}. Se vuelve a intentar mañana a las 05:00 (revisar logs del Worker).`;
}

// ---- pure: compaction ------------------------------------------------------

/**
 * Collapse template blasts so the model reads each canned text ONCE. Any
 * outbound body ≥120 chars that repeats across the day keeps its first
 * occurrence and becomes `[= plantilla #k]` afterwards — robust to future
 * template changes, no hand-kept pattern list.
 */
export function compactTranscripts(
  rows: AuditMessageRow[],
  names: Map<string, string | null>,
): string {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.direction !== "in" && r.body.length >= 120) {
      counts.set(r.body, (counts.get(r.body) ?? 0) + 1);
    }
  }
  const tplId = new Map<string, number>();
  const seen = new Map<string, boolean>();
  let nextTpl = 1;

  const byPhone = new Map<string, AuditMessageRow[]>();
  for (const r of rows) {
    const list = byPhone.get(r.phone) ?? [];
    list.push(r);
    byPhone.set(r.phone, list);
  }

  const blocks: string[] = [];
  for (const [phone, msgs] of byPhone) {
    const name = names.get(phone);
    const lines: string[] = [`## ${phone}${name ? ` (${name})` : ""}`];
    for (const m of msgs) {
      const hhmm = cdmxClock(m.ts);
      const who = m.direction === "in" ? "LEAD" : m.direction === "out_human" ? "HUMANO" : "BOT";
      let body = m.body;
      if (m.direction !== "in" && (counts.get(m.body) ?? 0) >= 2) {
        if (seen.has(m.body)) {
          body = `[= plantilla #${tplId.get(m.body)}]`;
        } else {
          seen.set(m.body, true);
          tplId.set(m.body, nextTpl);
          body = `[plantilla #${nextTpl}] ${m.body}`;
          nextTpl++;
        }
      }
      lines.push(`${hhmm} ${who}: ${body.replace(/\n+/g, " ⏎ ")}`);
    }
    blocks.push(lines.join("\n"));
  }
  // Newest conversations survive truncation (they're the ones worth reading).
  let out = blocks.join("\n\n");
  while (out.length > MAX_DATA_CHARS && blocks.length > 1) {
    blocks.shift();
    out = `[…conversaciones más antiguas omitidas por espacio…]\n\n` + blocks.join("\n\n");
  }
  return out;
}

function cdmxClock(ts: number): string {
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: "America/Mexico_City",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ts * 1000));
}

/** The real bookable grid, so "impossible hour" claims are judged vs truth. */
export function renderSlotsForAudit(): string {
  const days = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];
  return SLOTS.map(
    (s) =>
      `${days[s.weekday]} ${s.time} ${s.discipline} (${s.audience})${s.trial === false ? " [SIN prueba]" : ""}${s.pp ? " [padres participan]" : ""}`,
  ).join("\n");
}

export function formatApprovals(rows: AuditApprovalRow[]): string {
  if (!rows.length) return "(ninguna)";
  return rows
    .map((a) => {
      const lat = a.resolved_at ? `${Math.round((a.resolved_at - a.created_at) / 60)}m` : "PENDIENTE";
      const edited =
        a.final_text !== null && a.final_text !== a.draft ? ` | EDITADA→ «${a.final_text.slice(0, 120)}»` : "";
      return `#${a.id} ${a.phone} [${a.status} ${lat}] «${a.draft.slice(0, 160)}»${edited}`;
    })
    .join("\n");
}

// ---- pure: prompt ----------------------------------------------------------

export function buildAuditSystem(kb: string): SystemBlock[] {
  return [
    {
      type: "text",
      text: `Eres el auditor nocturno del agente de WhatsApp de MD Self Defense Academy Condesa (academia de artes marciales, CDMX). Cada madrugada revisas las conversaciones de las últimas 24 horas y publicas un reporte en el Slack del equipo.

Tu ÚNICA salida es el reporte. Reglas:
- Español, listo para Slack (sin markdown de encabezados #; usa emojis y guiones). Máximo ~2500 caracteres.
- PRIMERA LÍNEA, siempre: "🧾 Resumen: " + UNA frase (máx ~200 caracteres) con lo más importante del día para el dueño. Es lo único que verá en Slack; el resto se lee en el panel.
- Estructura después del resumen: 1) "📊 Números:" (leads nuevos, conversaciones activas, agendados detectados en las charlas, aprobaciones y su latencia mediana/máxima). 2) "🐛 Problemas:" cada uno con el TELÉFONO, una cita textual corta y por qué es un problema. 3) "💡 Sugerencias:" mejoras de conocimiento/copy (máx 3). Si el día estuvo limpio: "✅ Sin novedades" + los números.
- NUNCA inventes: cita textual. Si dudas de un dato del negocio, márcalo "(verificar)".
- Qué buscar, en orden de gravedad: leads con pregunta SIN respuesta del bot; respuestas con datos incorrectos (horarios/edades/precios que contradigan la parrilla o el KB); horarios propuestos que no existen en la parrilla; textos internos filtrados al lead (p.ej. "<sin_respuesta>", "no_tool_call"); mensajes duplicados o contradictorios al mismo lead; leads calientes que se enfriaron sin seguimiento; preguntas que el bot no supo responder (huecos de conocimiento); aprobaciones que esperaron >1h.
- El bot agenda en el chat, manda nudges automáticos y plantillas: los mensajes marcados [plantilla #N] son copys automáticos, no juzgues su repetición entre leads distintos — SÍ es problema el mismo lead recibiendo lo mismo dos veces.
- No propongas cambios de código; describe el síntoma y a quién le pasó.`,
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
    {
      type: "text",
      text: `PARRILLA REAL DE CLASES (única fuente de verdad de horarios):\n${renderSlotsForAudit()}\n\nCONOCIMIENTO DEL NEGOCIO (para validar datos que dio el bot):\n${kb}`,
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
  ];
}

export function buildAuditUser(
  transcripts: string,
  approvals: string,
  windowLabel: string,
): string {
  return `Ventana auditada: ${windowLabel}\n\n=== APROBACIONES DEL DÍA ===\n${approvals}\n\n=== CONVERSACIONES (hora CDMX) ===\n${transcripts || "(sin conversaciones en la ventana)"}`;
}

/**
 * Pure. The ONE #evan-alerts message for a finished audit: header, the
 * model's "🧾 Resumen:" line, the first "📊 Números:" line, problem /
 * suggestion counts and a link to the full report in /admin → Logs. Falls
 * back to the digest's first lines when the model skipped the structure.
 */
export function auditSummaryMessage(digest: string, header: string, logsUrl: string): string {
  const lines = digest.split("\n").map((l) => l.trim());
  const resumen = lines.find((l) => /^🧾|^\*?resumen\*?:/iu.test(l)) ?? null;
  const numIdx = lines.findIndex((l) => /^\*?📊/u.test(l));
  let numeros: string | null = null;
  if (numIdx >= 0) {
    const sameLine = (lines[numIdx] ?? "").replace(/^\*?📊\s*\*?n[úu]meros:?\*?\s*/iu, "").trim();
    numeros = sameLine || (lines[numIdx + 1] ?? "").replace(/^[-•]\s*/, "") || null;
  }
  const count = (marker: RegExp): number => {
    const start = lines.findIndex((l) => marker.test(l));
    if (start < 0) return 0;
    let n = 0;
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i] ?? "";
      if (/^\*?(📊|🐛|💡|✅)/u.test(l)) break;
      if (/^[-•]|^\d+[.)]\s/.test(l)) n++;
    }
    return n;
  };
  const problems = count(/^\*?🐛/u);
  const ideas = count(/^\*?💡/u);
  const clean = lines.some((l) => /^✅\s*sin novedades/iu.test(l));
  const out: string[] = [header];
  if (resumen) out.push(resumen);
  if (numeros) out.push(`📊 ${numeros}`);
  if (!resumen && !numeros) {
    const head = lines.filter(Boolean).slice(0, 4).join("\n");
    out.push(head.length > 600 ? `${head.slice(0, 599)}…` : head || "(el auditor no produjo reporte)");
  }
  const tally = clean && !problems ? "✅ sin problemas" : `🐛 ${problems} problema${problems === 1 ? "" : "s"}`;
  out.push(`${tally} · 💡 ${ideas} sugerencia${ideas === 1 ? "" : "s"} — <${logsUrl}|reporte completo en el panel>`);
  const msg = out.join("\n");
  return msg.length > SLACK_CHUNK ? `${msg.slice(0, SLACK_CHUNK - 1)}…` : msg;
}

/** Split the digest into Slack-sized chunks on line boundaries. */
export function chunkForSlack(text: string, max: number = SLACK_CHUNK): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur.length + line.length + 1 > max && cur) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out;
}

// ---- IO --------------------------------------------------------------------

export interface NightlyAuditDeps {
  /** Full report → ops_log (kind "audit"). */
  postNote(env: Env, text: string): Promise<void>;
  /** The one summary message → #evan-alerts. */
  postAlert(env: Env, text: string): Promise<void>;
  /** Compiled KB text — injected (src/kb.ts raw-imports kb.md, which node's
   *  test runner can't resolve; the dispatcher passes the real KB). */
  kb: string;
  doFetch?: typeof fetch;
  now?: number;
}

export async function runNightlyAudit(env: Env, deps: NightlyAuditDeps): Promise<void> {
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const since = now - 24 * 3600;

  const { results: msgs } = await env.DB.prepare(
    `SELECT phone, direction, body, ts FROM messages WHERE ts >= ?1 AND ts <= ?2 ORDER BY phone, ts`,
  )
    .bind(since, now)
    .all<AuditMessageRow>();
  if (!msgs.length) {
    await deps.postAlert(env, `🌙 Auditor nocturno: sin conversaciones en las últimas 24h.`);
    return;
  }

  const phones = [...new Set(msgs.map((m) => m.phone))];
  const names = await namesForPhones(env.DB, phones);
  const approvals = await listApprovalHistory(env.DB, {
    since,
    until: now,
    limit: 200,
    offset: 0,
  });

  const transcripts = compactTranscripts(msgs, names);
  const windowLabel = `${cdmxDateStr(since)} → ${cdmxDateStr(now)} (últimas 24h)`;
  const user = buildAuditUser(transcripts, formatApprovals(approvals), windowLabel);

  const messages: ApiMessage[] = [{ role: "user", content: user }];
  const resp = await callAnthropic(
    deps.doFetch ?? fetch,
    env.ANTHROPIC_API_KEY,
    buildAuditSystem(deps.kb),
    messages,
    [], // no tools — one review call, text out
    AUDIT_MAX_TOKENS,
    { thinking: { type: "adaptive" }, effort: AUDIT_EFFORT, model: AUDIT_MODEL },
  );

  const digest = resp.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  const header = `🌙 *Auditor nocturno* (${AUDIT_MODEL}, esfuerzo medio) — ${windowLabel}`;
  // Full report to the ops_log first (one row, no Slack size limit), then the
  // one summary to #evan-alerts. A Slack failure throws ⇒ the dispatcher's
  // retry runs the audit again (a duplicate log row is harmless).
  await deps.postNote(env, `${header}\n\n${digest || "(el auditor no produjo reporte — revisar logs)"}`);
  await deps.postAlert(env, auditSummaryMessage(digest, header, dashboardUrl(env, "logs/audit")));

  // Accrue at OPUS pricing into the same usage_log the budget report reads.
  try {
    const u: ApiUsage = resp.usage ?? {};
    const inTok = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const cached = u.cache_read_input_tokens ?? 0;
    const outTok = u.output_tokens ?? 0;
    const cost =
      (u.input_tokens ?? 0) * PRICE_IN +
      (u.cache_creation_input_tokens ?? 0) * PRICE_IN * 2 + // 1h cache write ≈ 2× base
      cached * PRICE_IN * 0.05 + // opus-5-5 cache read $0.20/MTok
      outTok * PRICE_OUT;
    await accrueUsage(env.DB, cdmxDateStr(now), inTok, cached, outTok, cost);
  } catch (err) {
    console.error("[nightly-audit] usage accrual failed", err);
  }
}
