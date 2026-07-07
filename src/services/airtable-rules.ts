// Pure evaluator for the Airtable rules engine. No DB, no I/O — shared by the
// lead-sync orchestrator (runtime), the Editor-chat proposal card, and the
// dashboard rules list (WS-2). See docs/airtable-rules-plan.md.

import type { RuleAction, RuleProgram, RuleTrigger } from "../types.js";

const PROGRAMS: readonly RuleProgram[] = ["adults", "kids", "baby"];

function isValidTrigger(t: unknown): t is RuleTrigger {
  if (typeof t !== "object" || t === null) return false;
  const type = (t as { type?: unknown }).type;
  if (type === "always") return true;
  if (type === "campaign") {
    return typeof (t as { campaignId?: unknown }).campaignId === "number";
  }
  if (type === "program") {
    return PROGRAMS.includes((t as { program?: unknown }).program as RuleProgram);
  }
  return false;
}

function isValidAction(a: unknown): a is RuleAction {
  if (typeof a !== "object" || a === null) return false;
  const op = (a as { op?: unknown }).op;
  const field = (a as { field?: unknown }).field;
  if (typeof field !== "string" || field.trim() === "") return false;
  if (op === "clear") return true;
  if (op === "set" || op === "add") {
    return typeof (a as { value?: unknown }).value === "string";
  }
  return false;
}

/** Parsed, validated rule contents (or null on bad/invalid JSON). */
export interface ParsedRule {
  trigger: RuleTrigger;
  actions: RuleAction[];
}

/**
 * Parse + validate a rule's trigger/actions JSON. Returns null on malformed
 * JSON, an unknown trigger type, or any malformed action (best-effort: a broken
 * rule is skipped, never crashes the sync).
 */
export function parseRule(
  triggerJson: string,
  actionsJson: string,
): ParsedRule | null {
  let trigger: unknown;
  let actions: unknown;
  try {
    trigger = JSON.parse(triggerJson);
    actions = JSON.parse(actionsJson);
  } catch {
    return null;
  }
  if (!isValidTrigger(trigger)) return null;
  if (!Array.isArray(actions) || actions.length === 0) return null;
  for (const a of actions) if (!isValidAction(a)) return null;
  return { trigger, actions: actions as RuleAction[] };
}

/** Context a trigger is evaluated against for one lead. */
export interface RuleMatchContext {
  campaignId: number | null;
  program: RuleProgram;
}

/** Whether a trigger fires for the given lead context. Pure. */
export function ruleMatches(trigger: RuleTrigger, ctx: RuleMatchContext): boolean {
  switch (trigger.type) {
    case "always":
      return true;
    case "campaign":
      return ctx.campaignId !== null && ctx.campaignId === trigger.campaignId;
    case "program":
      return ctx.program === trigger.program;
    default:
      return false;
  }
}

const PROGRAM_ES: Record<RuleProgram, string> = {
  adults: "adultos",
  kids: "niños",
  baby: "bebés",
};

function triggerSummaryEs(trigger: RuleTrigger, campaignName?: string): string {
  switch (trigger.type) {
    case "always":
      return "siempre";
    case "campaign":
      return `campaña «${campaignName ?? `#${trigger.campaignId}`}»`;
    case "program":
      return `programa ${PROGRAM_ES[trigger.program]}`;
    default:
      return "?";
  }
}

function actionSummaryEs(a: RuleAction): string {
  if (a.op === "set") return `${a.field} = ${a.value}`;
  if (a.op === "add") return `${a.field} += ${a.value}`;
  return `${a.field} = (vacío)`; // clear
}

/**
 * Spanish one-liner for a rule, e.g.
 *   SI campaña «Promo matutino» ENTONCES Tags += #promomatutino · Actividad = Baby Fight Club
 * Shared by the proposal card and the dashboard list. Pure.
 */
export function ruleSummaryEs(
  trigger: RuleTrigger,
  actions: RuleAction[],
  campaignName?: string,
): string {
  const cond = triggerSummaryEs(trigger, campaignName);
  const acts = actions.map(actionSummaryEs).join(" · ");
  return `SI ${cond} ENTONCES ${acts}`;
}
