// Post-send schedule check for HUMAN-written text (2026-10-21).
//
// findSlotClaimIssues (brain/slot-claims.ts) only ever judged BRAIN drafts
// (brain/claude.ts guard): a draft naming a slot that doesn't exist is demoted
// for review. Human text skipped it entirely — and the nightly auditor caught
// staff doing exactly what the guard exists for: approval #2067's EDIT turned
// a valid "9 am / Jiu-Jitsu 8 pm" into "mañana miércoles a las 8 pm … MMA"
// (sparring, no trials), and composer replies promised "sábados 3 pm" Box.
//
// The human already decided to send, so this NEVER blocks: after the message
// lands it runs the same checker and, on a hit, posts a task note to
// #wa-leads so staff can correct the lead right away. Never throws — it is
// bolted onto send paths that already succeeded (always awaited: Workers kill
// floating promises).

import type { Env } from "../types.js";
import { getContact } from "../db/queries.js";
import { getCampaign } from "../db/queries-admin.js";
import { findSlotClaimIssues } from "../brain/slot-claims.js";
import { bandFromQualification, type ProgramBand } from "./age-band.js";
import { classifyProgram, parseQualification } from "../cron/nudge-copy.js";
import { isKnownDiscipline, normalizeDiscipline } from "../brain/tools.js";
import { cdmxHintContext } from "../cron/time.js";
import { auditHumanSend } from "./booking-guard.js";
import type { HumanSendSource } from "./booking-claims.js";
import { postTaskNote } from "./slack.js";

/** Sources whose TEXT a human wrote (an "approved" draft was brain-checked already). */
const HUMAN_TEXT_SOURCES: ReadonlySet<HumanSendSource> = new Set(["edited", "staff", "staff_later"]);

const QUOTE_CAP = 220;

/** Pure. Who wrote it, for the warning line. */
export function sendSourceLabel(source: HumanSendSource, by?: string): string {
  const who = by ? `${by} ` : "";
  switch (source) {
    case "edited":
      return `${who}(aprobación editada)`.trim();
    case "staff":
      return `${who}(panel)`.trim();
    case "staff_later":
      return `${who}(envío programado)`.trim();
    default:
      return source;
  }
}

/** Pure. The #wa-leads warning for a human send that names a non-existent / no-trial slot. */
export function slotWarningText(
  phone: string,
  source: HumanSendSource,
  by: string | undefined,
  sent: string,
  notes: readonly string[],
): string {
  const quote = sent.length > QUOTE_CAP ? `${sent.slice(0, QUOTE_CAP)}…` : sent;
  return (
    `⚠️ Horario a revisar — ${sendSourceLabel(source, by)} le envió a ${phone}:\n> ${quote.replace(/\n/g, "\n> ")}\n` +
    `${notes.join(" ")}\n` +
    `_El mensaje YA salió. Si ofrece algo que no existe, corrígeselo al lead desde el panel._`
  );
}

export interface SlotAuditDeps {
  postTaskNote(env: Env, text: string): Promise<void>;
  now(): number;
  /** Band evidence for the lead (qualification, else campaign). Test seam. */
  leadEvidence?(env: Env, phone: string): Promise<{ band: ProgramBand | null; discipline: string | null }>;
}

async function realLeadEvidence(env: Env, phone: string): Promise<{ band: ProgramBand | null; discipline: string | null }> {
  const contact = await getContact(env.DB, phone);
  if (!contact) return { band: null, discipline: null };
  const qual = parseQualification(contact);
  let band = bandFromQualification(qual);
  if (!band && contact.campaign_id !== null && contact.campaign_id !== undefined) {
    const camp = await getCampaign(env.DB, contact.campaign_id);
    if (camp?.name) band = classifyProgram(contact, camp.name);
  }
  const disc = normalizeDiscipline(qual.discipline ?? "");
  return { band, discipline: isKnownDiscipline(disc) ? disc : null };
}

export function realSlotAuditDeps(): SlotAuditDeps {
  return {
    postTaskNote,
    now: () => Math.floor(Date.now() / 1000),
    leadEvidence: realLeadEvidence,
  };
}

/**
 * Non-blocking post-send schedule check of a human-written message. Only for
 * edited approvals and staff composer / scheduled sends. Never throws.
 */
export async function auditHumanSlotClaims(
  env: Env,
  phone: string,
  text: string,
  source: HumanSendSource,
  by?: string,
  deps: SlotAuditDeps = realSlotAuditDeps(),
): Promise<void> {
  try {
    if (!HUMAN_TEXT_SOURCES.has(source) || !text.trim()) return;
    const ev = deps.leadEvidence ? await deps.leadEvidence(env, phone) : { band: null, discipline: null };
    const { weekdayIdx } = cdmxHintContext(deps.now());
    const issues = findSlotClaimIssues(text, weekdayIdx, { band: ev.band, discipline: ev.discipline });
    if (issues.length === 0) return;
    await deps.postTaskNote(env, slotWarningText(phone, source, by, text, issues.map((i) => i.note)));
  } catch (err) {
    console.error(`[slot-audit] failed for ${phone}:`, err);
  }
}

/**
 * Both post-send audits of a staff send: the booking-capture card
 * (booking-guard.auditHumanSend) and the schedule check above. Drop-in for
 * the `auditSend` dep of services/staff-send.
 */
export async function auditStaffSend(
  env: Env,
  phone: string,
  text: string,
  source: HumanSendSource,
  by?: string,
): Promise<void> {
  await auditHumanSend(env, phone, text, source, by);
  await auditHumanSlotClaims(env, phone, text, source, by);
}
