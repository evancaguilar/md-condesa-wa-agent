// Overlay assembly: turns the live-editable kb_sections into the second cached
// system block that layers ON TOP of the compiled KB base. Pure module (no I/O)
// so it's unit-testable under plain Node — the db read lives in brain/index.ts's
// makeOverlayLoader.

import type { KbSection } from "../types.js";

/** Header that tells the model the overlay overrides the compiled KB base. */
export const OVERLAY_HEADER =
  "# ACTUALIZACIONES Y CORRECCIONES\nSi algo aquí contradice la base de conocimiento, ESTO manda.";

/**
 * Assemble the overlay text from the enabled sections.
 *
 * Returns "" when there are no enabled sections (the caller then omits block 2
 * entirely). Otherwise: the header, followed by one `## <title>\n<content>`
 * chunk per enabled section, in (sort ASC, id ASC) order. Sections are joined by
 * a blank line so the markdown reads cleanly.
 */
export function assembleOverlay(sections: KbSection[]): string {
  const enabled = sections
    .filter((s) => s.enabled === 1)
    .sort((a, b) => a.sort - b.sort || a.id - b.id);

  if (enabled.length === 0) return "";

  const parts = enabled.map((s) => `## ${s.title}\n${s.content}`);
  return `${OVERLAY_HEADER}\n\n${parts.join("\n\n")}`;
}

/** Rough token estimate: chars / 3.5, rounded up. Mirrors the brain's heuristic. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 3.5);
}
