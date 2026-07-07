// Brain integration entry. This is the ONE place that binds the compiled KB
// text module to the (KB-free, testable) brain factory. The integrator (E)
// imports createBrainWithKb from here and injects the AirtablePort + a
// db-bound accrueUsage closure.

import type { AirtablePort, BrainPort } from "../types.js";
import { KB } from "../kb.js";
import { createBrain, type AccrueUsage } from "./claude.js";
import { assembleOverlay } from "./overlay.js";
import { listKbSections } from "../db/queries-admin.js";

export { createBrain } from "./claude.js";
export type { BrainDeps, AccrueUsage } from "./claude.js";

/** Construct the brain with the compiled KB already bound. */
export function createBrainWithKb(deps: {
  apiKey: string;
  airtable: AirtablePort;
  accrueUsage: AccrueUsage;
  loadOverlay?: () => Promise<string>;
  fetchImpl?: typeof fetch;
}): BrainPort {
  return createBrain({ ...deps, kb: KB });
}

/**
 * Build the overlay loader for a given D1 binding: reads the live kb_sections
 * and assembles the second cached system block. Injected as `loadOverlay` into
 * createBrainWithKb so overlay edits take effect on the next brain turn without
 * a redeploy. Returns "" when there are no enabled sections.
 */
export function makeOverlayLoader(db: D1Database): () => Promise<string> {
  return async () => assembleOverlay(await listKbSections(db));
}
