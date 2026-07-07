// Crisis-safety gate (features.safety). A deterministic pre-brain layer for
// clients whose conversations can carry crisis signals (self-harm, abuse,
// acute panic). The client brief for companion products is explicit: crisis
// handling must NOT depend on the model prompt alone — this gate runs before
// the brain ever sees the message.
//
// On a match the pipeline:
//   1. replies ONLY with the client's containment message (real crisis resources),
//   2. pauses the bot for the conversation (human_override, safety.pauseHours),
//   3. cancels every pending followup/nudge for the contact,
//   4. escalates to Slack with an urgent note.
//
// Matching is case- and diacritic-insensitive (normalizeText), so patterns in
// client.mjs must be written unaccented/lowercase (e.g. "no quiero (vivir|existir)").
//
// Pure matcher — unit-tested; the side effects live in the inbound pipeline.

import type { SafetyConfig } from "../client-config.js";
import { normalizeText } from "./campaigns.js";

/** Compile a config's patterns once; invalid regexes fail loudly at first use. */
export function compileSafetyPatterns(cfg: SafetyConfig): RegExp[] {
  return cfg.patterns.map((p) => new RegExp(p, "u"));
}

/**
 * True when the (raw) inbound body matches any crisis pattern. `body` is
 * normalized here; `patterns` come pre-compiled from compileSafetyPatterns.
 */
export function matchesSafety(body: string, patterns: readonly RegExp[]): boolean {
  const norm = normalizeText(body);
  if (!norm) return false;
  return patterns.some((re) => re.test(norm));
}
