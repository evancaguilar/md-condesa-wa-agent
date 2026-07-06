# Workstream B (brain) — integration notes for E

Everything the brain needs is self-contained under `src/brain/*`, `tools/compile-kb.mjs`, and `kb/*`. No edits to shared files were made. Below is what E must wire.

## 1. Constructing the brain

The pipeline calls `brain.respond(ctx)`. Build the `BrainPort` once (per request or per worker init — it's stateless) and pass it into `Ports`:

```ts
import { createBrainWithKb } from "./brain/index.js";
import { accrueUsage } from "./db/queries.js";

const brain = createBrainWithKb({
  apiKey: env.ANTHROPIC_API_KEY,
  airtable, // the real AirtablePort (workstream D)
  accrueUsage: (day, inTok, cachedTok, outTok, cost) =>
    accrueUsage(env.DB, day, inTok, cachedTok, outTok, cost),
});
```

- `createBrainWithKb` (in `src/brain/index.ts`) is the ONE seam that binds the
  compiled KB text module (`src/kb.ts` → `kb/compiled/kb.md`) to the brain. The
  brain modules themselves are KB-free so they unit-test under plain Node.
- `accrueUsage` here is a **closure that already has `env.DB` bound** — the brain
  never sees D1. It maps `usage_log` columns as `(day, input_tokens,
  cached_tokens=cache_reads, output_tokens, cost_usd)`.

If you prefer the lower-level form, `createBrain({ apiKey, kb, airtable, accrueUsage, fetchImpl? })` is also exported (pass `KB` yourself).

## 2. book_trial → 'book' BrainResult

When the model books, `respond` returns `{ action: "book", ...BookTrialInput, followupMessage }`. The brain **already calls `airtable.bookTrial(input)`** inside the loop (to validate + create the record before confirming to the lead) and returns the `'book'` result for the pipeline to:

- send `followupMessage` to the lead (free-form if in-window, else `trial_confirm` template), and
- schedule anti-no-show followups (D's engine) keyed to the returned Airtable record.

Note: the brain does NOT have the Airtable record id in the `BrainResult` (the union in types.ts doesn't carry it). If the followup engine needs it, either (a) have the pipeline re-query, or (b) request a types.ts change to add `recordId?: string` to the `'book'` variant. **Flagging as an open question for E** — I didn't change types.ts.

## 3. set_followup

The brain acknowledges `set_followup` tool calls so the model proceeds to
`send_reply`, but does NOT persist them (no DB access in the brain). If you want
custom followups honored, the pipeline should inspect... actually the brain
currently only surfaces send/draft/escalate/book. **If custom followups matter,
the cleanest fix is a types.ts `BrainResult` addition** (e.g. a `followup`
action, or a `followups?: {...}[]` field on send/draft). Flagged for E — not
implemented to avoid touching the shared union.

## 4. Nothing else shared changed

- `tsconfig.test.json` include array: I added `test/brain-shims.d.ts` and the four
  pure brain modules (`prompt.ts`, `tools.ts`, `slots.gen.ts`, `claude.ts`). I
  preserved C/D's existing entries.
- The KB is compiled + committed at `kb/compiled/kb.md` (+ `slots.json` +
  generated `src/brain/slots.gen.ts`). Regenerate with `node tools/compile-kb.mjs`
  after editing `kb/intake.md` or when the site schedule/content changes, then
  commit the outputs. The compiler FAILS the build if the KB exceeds ~6000 tokens.
- `kb/intake.md` is a human-fill template (Evan). Known adult pricing is
  transcribed; kids pricing, drop-in/visitor rate, parking, and payment methods
  are `<!-- TODO(Evan) -->`.
