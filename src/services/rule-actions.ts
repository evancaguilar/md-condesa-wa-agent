// Pure validation for Airtable-rule actions, factored out of kb-editor.ts so it
// can be unit-tested without dragging the editor's runtime graph (Anthropic
// transport, the compiled KB .md module, client.gen, …). Type-only imports here
// keep the emitted module dependency-free. See docs/airtable-rules-plan.md §4.

import type { BaseSchema } from "./airtable.js";
import type { RuleAction } from "../types.js";

/** Pure result of validating a rule's actions against the live base schema. */
export interface ValidateActionsResult {
  ok: boolean;
  reason?: "unknown_field" | "bad_action";
  /** Select values not yet among a field's options; typecast will create them. */
  createdOptions: string[];
}

const SELECT_TYPES = new Set(["singleSelect", "multipleSelects"]);

/**
 * Validate rule actions against a fresh base schema:
 * - the field must exist                             → unknown_field
 * - op "add" is only valid on a multipleSelects      → bad_action
 * - a value is required unless op is "clear"         → bad_action
 * - an empty actions list is invalid                 → bad_action
 * Also collects createdOptions: set/add values not already among a select
 * field's choices (allowed — Airtable typecast creates them; surfaced so the UI
 * toasts "se creará la opción nueva"). Pure.
 */
export function validateRuleActions(
  actions: RuleAction[],
  schema: BaseSchema,
): ValidateActionsResult {
  if (!Array.isArray(actions) || actions.length === 0) {
    return { ok: false, reason: "bad_action", createdOptions: [] };
  }
  const byName = new Map(schema.fields.map((f) => [f.name, f]));
  const createdOptions: string[] = [];
  for (const a of actions) {
    const field = byName.get(a.field);
    if (!field) return { ok: false, reason: "unknown_field", createdOptions: [] };
    if (a.op === "add" && field.type !== "multipleSelects") {
      return { ok: false, reason: "bad_action", createdOptions: [] };
    }
    if (a.op !== "clear") {
      const value = (a as { value?: unknown }).value;
      if (typeof value !== "string" || value === "") {
        return { ok: false, reason: "bad_action", createdOptions: [] };
      }
      if (SELECT_TYPES.has(field.type)) {
        const choices = field.choices ?? [];
        if (!choices.includes(value) && !createdOptions.includes(value)) {
          createdOptions.push(value);
        }
      }
    }
  }
  return { ok: true, createdOptions };
}
