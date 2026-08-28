// Auditor nocturno (owner directive 2026-08-28): once a day, an OPUS-tier
// review of the last 24h of conversations, posted to #wa-leads before the
// team wakes up. It REPORTS — it never edits code, campaigns, or the KB, and
// it never messages a lead. Structural fixes stay with a human + Claude Code.
//
// Cost note: claude-opus-5 at $5/$25 per MTok over a compacted day (~30–60K
// input, ~2K output incl. thinking) ≈ $0.20–0.40 per night. Usage is accrued
// into the same usage_log the budget report reads, at OPUS rates.

import type { Env } from "../types.js";
import { callAnthropic, type ApiMessage, type ApiUsage } from "../brain/claude.js";
import type { SystemBlock } from "../brain/prompt.js";
import { SLOTS } from "../brain/slots.gen.js";
import { accrueUsage } from "../db/queries.js";
import { listApprovalHistory, namesForPhones } from "../db/queries-admin.js";
import { cdmxDateStr } from "./time.js";

export const AUDIT_MODEL = "claude-opus-5";
const AUDIT_EFFORT = "high" as const;
/** Thinking spends from this too; the digest itself is ~1–2K tokens. */
const AUDIT_MAX_TOKENS = 12000;
/** Compacted transcript budget (chars ≈ tokens×3.5). Oldest convos drop first. */
const MAX_DATA_CHARS = 220_000;
/** Slack message ceiling per postNote chunk. */
const SLACK_CHUNK = 3400;

const PRICE_IN = 5 / 1_000_000;
const PRICE_OUT = 25 / 1_000_000;

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
- Estructura: 1) "📊 Números:" (leads nuevos, conversaciones activas, agendados detectados en las charlas, aprobaciones y su latencia mediana/máxima). 2) "🐛 Problemas:" cada uno con el TELÉFONO, una cita textual corta y por qué es un problema. 3) "💡 Sugerencias:" mejoras de conocimiento/copy (máx 3). Si el día estuvo limpio: "✅ Sin novedades" + los números.
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
  postNote(env: Env, text: string): Promise<void>;
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
    await deps.postNote(env, `🌙 Auditor nocturno: sin conversaciones en las últimas 24h.`);
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

  const header = `🌙 *Auditor nocturno* (${AUDIT_MODEL}, esfuerzo alto) — ${windowLabel}`;
  const chunks = chunkForSlack(digest || "(el auditor no produjo reporte — revisar logs)");
  await deps.postNote(env, header);
  for (const c of chunks) await deps.postNote(env, c);

  // Accrue at OPUS pricing into the same usage_log the budget report reads.
  try {
    const u: ApiUsage = resp.usage ?? {};
    const inTok = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const cached = u.cache_read_input_tokens ?? 0;
    const outTok = u.output_tokens ?? 0;
    const cost =
      (u.input_tokens ?? 0) * PRICE_IN +
      (u.cache_creation_input_tokens ?? 0) * PRICE_IN * 2 + // 1h cache write ≈ 2× base
      cached * PRICE_IN * 0.1 +
      outTok * PRICE_OUT;
    await accrueUsage(env.DB, cdmxDateStr(now), inTok, cached, outTok, cost);
  } catch (err) {
    console.error("[nightly-audit] usage accrual failed", err);
  }
}
