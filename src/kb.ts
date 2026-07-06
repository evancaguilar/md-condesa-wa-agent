// The compiled KB is bundled as a text module by Wrangler (see wrangler.jsonc
// `rules`). Import it here so the rest of the code depends on one accessor.
import kbText from "../kb/compiled/kb.md";

export const KB: string = kbText;
