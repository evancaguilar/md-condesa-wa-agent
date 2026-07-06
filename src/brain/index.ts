// Brain integration entry. This is the ONE place that binds the compiled KB
// text module to the (KB-free, testable) brain factory. The integrator (E)
// imports createBrainWithKb from here and injects the AirtablePort + a
// db-bound accrueUsage closure.

import type { AirtablePort, BrainPort } from "../types.js";
import { KB } from "../kb.js";
import { createBrain, type AccrueUsage } from "./claude.js";

export { createBrain } from "./claude.js";
export type { BrainDeps, AccrueUsage } from "./claude.js";

/** Construct the brain with the compiled KB already bound. */
export function createBrainWithKb(deps: {
  apiKey: string;
  airtable: AirtablePort;
  accrueUsage: AccrueUsage;
  fetchImpl?: typeof fetch;
}): BrainPort {
  return createBrain({ ...deps, kb: KB });
}
