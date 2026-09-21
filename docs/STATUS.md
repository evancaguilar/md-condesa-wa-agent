# Project status

> Update this file whenever something ships or a pending item completes. Last updated: **2026-09-21**.

> **Branch `roas-phase1`** merges the three 2026-09-21 workstreams below — soonest-slot-first, the post-trial sequence, and the Meta CAPI (inert) — plus the KB-build fix. Each entry quotes its own test count against main; **merged the suite is 891 green**.

### ⚠️ The KB build was silently shipping a TRUNCATED KB (2026-09-21)

**What happens.** `clients/md-condesa/kb-build.mjs` reads the site sources from the sibling checkout `<repo>/../md-condesa-site`. Only two of them — `js/schedule-data.js` and `content/site.js` — are also served in raw form by the live site, so `loadSource` can fetch those. **`content/pages/*`, `en-hub.js` and `founder.js` are compiled into HTML and can ONLY come from a local checkout**, and `loadContent()` simply returned nothing when it was missing. No error, no warning: the build just produced a KB **~8 038 tokens instead of ~10 340** — no disciplines, no FAQs, no founder — and exited 0.

**Who this bit.** (1) Every **git worktree** build: the sibling path resolves to `<repo>/.claude/worktrees/<id>/../md-condesa-site`, which does not exist (a symlink there is what makes it work today). (2) **Very likely production.** Workers Builds runs `npm run build` on every push (docs/phase0-checklist.md §5) and does **not** check out the site repo, so CI has been recompiling the committed 10 340-token `kb.md` down to the 8 038-token version at deploy time. That is consistent with the long-standing "served `kbVersion` never matches the local one" gotcha. **UNVERIFIED** — confirm by comparing the `kbVersion` at `/health` with `kb/compiled/kb.md`'s header, or by asking the bot something only the disciplines/FAQ sections answer.

**Fixed:**
- **`MD_SITE_DIR`** env override (absolute, or relative to the repo) picks the checkout explicitly.
- A local build with no checkout now **fails loudly, exit 1**, with a message naming the three ways out. It no longer degrades in silence.
- **CI keeps working**: the remote path stays allowed when `KB_ALLOW_REMOTE=1` or a CI env var (`WORKERS_CI` / `CI` / `CF_PAGES` / `GITHUB_ACTIONS`) is set, so push-to-deploy is not broken by this change.
- **The real safety net:** `buildKb` returns `degraded: true` when it ran without the checkout, and `tools/compile-kb.mjs` then **refuses to overwrite an already-committed `kb.md` that is materially (>5%) larger**, keeping that file *and its version* so the other generated files stay consistent. A degraded CI build therefore deploys the full KB from git instead of a truncated rebuild.

**Pendiente Evan:** confirm which KB prod is actually serving (above), and decide the permanent CI shape — either check out `md-condesa-site` in the Workers Builds step and set `MD_SITE_DIR`, or drop the CI build command to `npx wrangler deploy` since every compiled artifact is committed anyway. The guard makes either safe, but it is a guard, not the design.

### Meta Conversions API for Business Messaging — shipped INERT (2026-09-21)

Owner guide: **docs/meta-capi.md**. Campaigns optimize for "conversations started", so Meta buys the cheapest chat (one ad: $13.9k MXN → 1 sale of $500). The fix is to send the downstream funnel back to Meta for ad leads: **Booked → `LeadSubmitted`, Attended → `QualifiedLead`, Enrolled → `Purchase`** (value = `Pago Inicial`, MXN), keyed on the `ctwa_clid` the inbound pipeline already stores in `contacts.ad_ref`. Event names come from Meta's closed business-messaging list (Schedule/Contact are NOT on it; custom names are undocumented → not used).

- `src/services/meta-capi.ts`: pure payload builders + `capiEventsForResult` + a sender that never throws and scrubs the token from every error (Bearer header, never a URL). `src/cron/capi.ts`: drains ≤5 events per tick, **one POST per event** (Meta rejects a whole request if any event in it is invalid), retries 3× then drops, `capi_last_ok` / `capi_last_error`, one Slack note per CDMX day. Idle ticks read ONE kv row (`capi_pending` gate) — no `LIKE` scan of kv per tick.
- Hooks only ENQUEUE (a D1 write, no network): `finalizeBooking` (chat/staff bookings), `syncBookings` (web-form bookings), and one self-contained clearly-marked block at the top of `processResult` that reads the raw Airtable result itself — it does not touch `classifyResult` or the existing branches. At most one event per contact per step (kv claim), since Meta does NOT deduplicate business-messaging events.
- Leads without a `ctwa_clid` are skipped silently; events older than Meta's 7-day `event_time` window are dropped; a late-marked result reports the trial datetime, not the marking day; no amount ⇒ Purchase without value.
- Config: `features.metaCapi` (client.mjs, **false**) AND var `META_CAPI_DATASET_ID` (commented placeholder in wrangler.jsonc) AND a token — any one missing ⇒ complete no-op. Token order `META_CAPI_TOKEN` → `ADS_ACCESS_TOKEN` → `WA_ACCESS_TOKEN` (the API needs `whatsapp_business_management` + `whatsapp_business_manage_events`, not the ads scopes). New Leads column read (never written): `Pago Inicial` via `airtableLeads.initialPayment`.
- Owner routes: `GET /admin/api/capi/probe` (state, never the token), `GET /admin/api/capi/dataset` (reads the dataset linked to the WABA — Evan cannot curl it himself, the token is a Cloudflare secret), `POST /admin/api/capi/test {phone, kind?, send?, testEventCode?}`. No D1 migration, no dashboard UI change. Tests 775 → **802**.

**Pendiente Evan:** (1) create/find the dataset on WABA 1717538906028335 (`GET /admin/api/capi/dataset`, else `POST /<WABA_ID>/dataset` or Events Manager → Business messaging); (2) set `META_CAPI_TOKEN` as a Cloudflare secret if the ads token lacks `whatsapp_business_manage_events` (advanced access); (3) paste the id into `META_CAPI_DATASET_ID` in wrangler.jsonc; (4) dry-run `POST /admin/api/capi/test` and watch Events Manager → Test events; (5) only then flip `features.metaCapi` to true + `npm run build` + push; (6) the step that actually changes spend: a NEW campaign with objective Sales / conversion location WhatsApp / performance goal "maximize conversions" on the dataset's `Purchase` (or `QualifiedLead` while volume is low), run alongside the current one for 2–3 weeks and compared on cost per enrolment.

### Post-trial sequence + no-show rebook — the two dead ends in the funnel (2026-09-21)

The funnel numbers that forced this: **163 people attended a free trial since July and did not buy**, and the bot did nothing for any of them; **~400 booked and never showed**, and the bot sent exactly ONE message.

- **New result class `attended`.** `classifyResult` (src/services/airtable.ts) now returns `"attended"` when `Resultado Clase Prueba` holds a BARE "asistió" — one that isn't the tail of "no asistió", which a plain `includes()` could never tell apart. Enrollment still wins over everything; a multi-select join with both ("Asistió, No asistió") reads as attended.
- **The live option list** (verified 2026-09-21): **No asistió · Reprogramó · Asistió · Dijo que se va a inscribir · Perdido · Se inscribió**, ticked several at a time. Two of them are signals orthogonal to the outcome:
  - **"Perdido"** (staff gave up) → `isLostResult`. Every marketing chain is cancelled, nothing is sent, nothing is armed — and class reminders are deliberately left alone, because a "Perdido" next to a live booking must not kill the reminders for a class the lead may still walk into. Enrolment outranks it. The kv marker carries a `+lost` suffix so `"Asistió"` → `"Asistió, Perdido"` counts as a NEW value and actually retires the chain the first value just armed.
  - **"Reprogramó"** (or a record simply moved to a new date) → read as a live anti-no-show sequence (`hasScheduledFollowupOfKind(BOOKING_KINDS)`). The no-show branch then stays silent and **no branch cancels that sequence**. This also fixes a latent bug: `syncBookings` arms the new sequence earlier in the same loop, so the previous code armed those reminders and cancelled them milliseconds later.
  - **"Dijo que se va a inscribir"** is an intention, never an enrolment ("inscribir" ≠ "inscribio" — one letter after normalization). Alone it classifies as nothing; next to "Asistió" it is `attended`, i.e. the hottest lead in the chain.
- **Post-trial chain (attended, didn't sign up):** `post_trial_d0` ≈ 3h after the class starts (past 21:00 CDMX → 09:30 next morning), `post_trial_d2` and `post_trial_d5` at 11:00 CDMX. Timing is pure (`computePostTrialSequence`, src/cron/post-trial.ts) and always lands in 09:00–21:00 CDMX. Armed by the result watcher, idempotent via `UNIQUE(phone, kind, record)`. Marked >48h late ⇒ d0 is dropped as stale; >5 days ⇒ nothing is armed. The contact stays a **lead** (never flipped to student). Every stop condition is re-checked AT SEND TIME: student / opted_out / human takeover / a reply since the row was armed / a new future booking — the last three cancel the rest of the chain. A later "Se inscribió" on the same record runs the enrolled branch (the kv marker is per record+VALUE) and `cancelFollowups` retires the chain.
- One Slack note per attendee, at marking time: `🔥 <name> (<phone>) asistió y no se inscribió — seguimiento automático armado (hoy, +2d, +5d). Quien cerró: escríbele hoy.`
- **No-show is now two touches.** The immediate message proposes ONE real upcoming slot via `nextTrialSlot`/`slotCta` (program-aware — a kids lead never sees an adult class) instead of a bare link; `no_show_d3` follows at 11:00 CDMX three days after the missed class with different copy and the same stop conditions. Both fall back to the existing `no_show_followup` template out of window.
- Sending everywhere here is free-form first (these leads are usually inside the 24h window), template on `WindowClosedError`, and a missing/unapproved template ⇒ skip + ONE throttled Slack note per day. IG/FB keep the `noteMessengerWindowClosed` path.
- **No D1 migration:** `followups.kind` has no CHECK constraint; the four new kinds (`post_trial_d0|d2|d5`, `no_show_d3`) are comment-only in schema.sql.
- Dead code removed: the `no_show_1` / `reengage_7d` scheduling in `onAttendance` (src/routes/slack.ts) had no producer since the Slack attendance card was retired on 2026-09-18. The kv write stays so a tap on an old card still resolves legacy rows, and `runDueFollowups` still drains both legacy kinds harmlessly.
- **NO offer in the copy (owner, 2026-09-21).** An earlier draft held the inscription discount open for 48h. The discount is **same-day-only at the academy**, so that was a promise the gym would not honor: every price, discount and deadline is out of all three messages, in both languages, and a test pins it (`/\$\s*[\d,]+/`, `\d+ horas|hours`, `descuento|sin costo|gratis|vence|plazo` must not appear). The messages open a conversation; the humans quote the numbers.
- Copy lives in `clients/md-condesa/client.mjs` (`postTrialD0/D2/D5`, `noShowD3`, plus `{cta}` in the no-show copy). Tests 775 → **821** (876 on `roas-phase1`).

### Inscripción: the real rule, not half of it (2026-09-21)

The KB said **"Inscripción: $999 — GRATIS al inscribirse en línea"**, which is true and incomplete — it let the bot offer free inscription to someone who had already visited. Owner's exact rule, now in intake.md: **$999** for every program; **free only when they sign up online BEFORE visiting** (never having come to a trial); once they have visited it is paid, with **$500 off if they sign up the SAME DAY of the visit / trial class**; after that day, full price. Never offer the free inscription or the same-day discount to someone who already came and did not sign up that day. persona.md's price-audit checkbox now lists the inscription among the approved figures so a correct `$500` mention does not fail the check. The Baby Fight Club line (§ precios) only states `$999`, which stays true, so it is untouched. KB **10,340 → 10,459 tokens** (limit 11,000).

### ⚠️ Template parameter audit — three ways the pack would have failed at Graph (2026-09-21)

Audited the day the operational pack was submitted to Meta. **Every template in docs/template-submission.md declares exactly ONE body variable, `{{1}}` = first name.** The code disagreed in three places, each of which fails at Graph rather than at compile time:

1. **`processExtendedNudge` sent ZERO parameters.** All 12 `nudge_d{2..5}_{adults|kids|baby}_es` bodies carry `{{1}}`, so every out-of-window d2–d5 would have come back **132000** (parameter count mismatch) — and the bare `catch` reported it as `template_missing`, i.e. "not approved yet". That is the worst possible misdiagnosis: it sends Evan hunting in WhatsApp Manager for a template sitting there approved. Now the body component goes out, and the outcome carries `missing` (true only for **132001**, template does not exist) plus Graph's verbatim `error`. The throttled Slack note has two shapes — "falta aprobarla" vs "⚠️ NO es que falte aprobarla · Error de Meta: …".
2. **`sendHumanFollowupTemplate` sent the base name with no params**: literal `human_followup` instead of `human_followup_es`, and no `{{1}}`. Wrong on both counts, so **every** click of "📨 Enviar plantilla" on an expired card failed silently.
3. **Empty name parameters.** Several call sites passed `bodyParams([name ?? ""])`; Meta rejects an empty parameter with **131008**, and a large share of contacts have no usable push name (greetingName correctly rejects emails, handles, fancy fonts). The old filler was `👋`, which Meta accepts inconsistently as a whole-parameter value.

New pure module **`src/services/template-params.ts`** (`tpl`, `templateFirstName`, `nameParam`, `bodyParams`, `sanitizeParam`, `graphErrorCode`, `isTemplateMissingError`) is now the single source for all of it: first token only, newlines/tabs/multi-space stripped, and a filler that reads as a greeting on its own — ES `"qué tal"` → "¡Hola qué tal!", EN `"there"` → "Hi there!". Applied at every name-filling `sendTemplate` call site: trial_confirm, day_before, same_day, no_show_followup (both touches), reengage_lead, human_followup (cron + Slack card), post_trial_d0/d2/d5, no_show_d3, and the 12 extended nudges.

**Not changed, on purpose:** the blast sender (`src/services/blast.ts`) keeps `NAME_FALLBACK = "👋"`. Its parameters are owner-authored and their count is already validated against the live Meta catalog at queue time (`blast-templates.ts` `checkTemplate`), and two large real runs went out with it at 0 failures. Making it consistent means threading `lang` through `renderParams` and five call sites — worth doing, but not inside this fix.

### 🙋 "Yo le escribo" — the claim button on the attended card

The bot cannot see the follow-up staff actually do: they write these leads from their OWN phones, so no inbound ever reaches D1, every send-time stop condition stays false, and the bot writes on top of a human. The button IS that missing signal.

- The 🔥 attended-not-enrolled note is now a Block Kit card (`postPostTrialCard`, src/services/slack.ts) with one primary button, verb **`posttrial_claim|<phone>`** — the same action-id plumbing as `takeover_phone`, same signature verification, same ack-then-`waitUntil` pattern.
- A click cancels **only the pending `post_trial_d0` row**; d2 and d5 keep running under their normal stop conditions, because the promise being made is about TODAY. The `UPDATE … WHERE status='scheduled'` is the atomic gate (`claimPendingFollowup`), so two simultaneous clicks can never both believe they stopped the send.
- It records kv `post_trial_claim:<phone>` = `{user, ts}` and rewrites the card (kv `post_trial_card:<phone>` holds the Slack ts — there is no approval row to hang one on). Idempotent: a second click by anyone else only reports who got there first. If d0 had already gone out, the claim is still recorded and the card says at what time (from the row's `due_at`; the drain fires within one 5-minute tick and `followups` has no `sent_at`).
- `CronSlackDeps.postPostTrialCard` is optional so the console stubs and the one-line fakes in test/ stay one-liners; without it the watcher falls back to the plain note.

**Para el equipo (en corto).** Cuando alguien viene a su clase de prueba y no se inscribe, al canal llega una tarjeta 🔥 con su nombre. El bot le va a escribir tres veces: hoy mismo, a los 2 días y a los 5. **Si tú le vas a escribir por tu cuenta, dale al botón «🙋 Yo le escribo»** — así el bot NO manda el mensaje de hoy y no quedan dos mensajes encimados. Los de +2d y +5d siguen programados por si el lead no contesta y nadie marca resultado en Airtable; si se inscribe, responde por WhatsApp, o agenda otra clase, se cancelan solos. Si alguien ya le picó antes que tú, la tarjeta te dice quién y a qué hora.

**Pendiente Evan: aprobar textos + enviar plantillas post_trial_\*** (6 templates — **las tres MARKETING con footer BAJA**; bodies ready to paste in docs/template-submission.md §13–18). Until they are approved, out-of-window post-trial sends are skipped with one Slack note a day.

### Soonest slot first — stop defaulting leads to Saturday (2026-09-21)

**The data (Jul 1 – Sep 21, 645 trial classes that came due).** Trials booked for the SAME DAY — under 24h after the lead first wrote — show up **54% of the time (115/214)**. Trials booked one or more days out show **~29% (126/431)**. Only a third of all trials are booked inside that 24h window. And **Saturday holds 37% of every booked trial but shows at just 33%**, while Mon/Tue/Wed show 44–51%. The bot was not refusing anything — it was simply *offering* the weekend first, and the weekend is the worst-converting day we have.

Goal of this change: the FIRST option the lead ever sees is the soonest valid class for their program, while the day a lead asks for is still honored without argument.

- **persona.md → "Flujo de agendado"** gained three lines: (1) the first option is always the soonest valid class — today when it is ≥4h away, otherwise tomorrow — then at most two alternatives inside the next 3 days, with Sat/Sun first ONLY when the lead asked for the weekend or it genuinely is the soonest; (2) if the lead names a day, honor it, and only when that day is 3+ days out add ONE gentle "si quieres venir antes…" line; (3) the *why* (the show-rate numbers above), so the model applies judgement instead of pattern-matching. KB body is unchanged at **10 340 / 11 000 tokens** (the persona compiles into `client.gen.ts`, not `kb.md`).
- **`nextTrialSlot` (src/cron/next-slot.ts)** was audited and was already soonest-first — day offsets ascending, slots sorted by clock time inside each day, no weekend or "popular slot" bias. A brute-force unit test (expand the whole grid, take the min by epoch) now pins that for every audience at 7 days × 7 hours, so it can't regress.
- **Preferred blocks (new, config-driven, EMPTY by default).** `booking.preferredBlocks` in clients/md-condesa/client.mjs: `{dow, from, to}` (dow 0=Mon…6=Sun, from/to inclusive class START times). When two candidates fall inside the same 24h, the one in a block wins; past 24h, sooner always wins; a block never conjures a slot the grid lacks. With the empty default the behavior is *exactly* pure soonest-first. **Evan: fill this in with the hours you're on the floor closing.** (compile-kb whitelist + `BookingConfig` in client-config.ts updated — malformed blocks are dropped at compile time.)
- **Brain per-turn context** now carries `próximos horarios válidos para <grupo>: …` — the 3 nearest valid hours for that lead's program, soonest first, generated from the same SLOTS + closed-dates logic using the persona's own 4h buffer, plus a line telling the model to offer the first one and still verify the KB row. It lives in `buildContextBlock` only; a test pins it OUT of both cached system blocks (cache stability is contractual) and pins that an unparseable clock degrades to the previous context shape.
- **Nudge copy checked, no change needed:** `src/cron/nudge-copy.ts` already closes every step with `slotCta`, i.e. whatever `nextTrialSlot` returns — no hard-coded "este sábado" anywhere in the drip.

Tests 775 → **790**.

### Baby Fight Club Wednesday trial moved 11 am → 1 pm (2026-09-18)

Evan's call. Changed in `withBabyTrialSlots` (kb-build.mjs → slots.gen: mié 13:00, both audiences; 11:00 now rejected by validateSlot), intake.md (3 mentions), and live D1 copy via the admin API: KB overlay section 3 and campaign «baby fight club» (first_reply + info). Saturday 2 pm unchanged; member classes (mié 12 pm / sáb 3 pm) untouched — Evan to confirm the Wednesday member class did not move too. The website does not list trial hours, so no site change.

### Sales-conversation recordings → transcript + AI summary (2026-09-18)

Staff upload the recording of an in-person sales conversation to the Leads column **Audio venta** (attachment). `src/cron/sales-audio.ts` runs LAST in every cron tick, one record per tick: streams the file from Airtable's signed URL straight into Workers AI **Deepgram Nova-3** (`language: "multi"` for Spanish/English code-switching, falls back to `es`; the body is a stream, so the isolate never buffers the file), then Claude writes a structured summary (RESULTADO / PROSPECTO / OBJECIONES / OFERTA PRESENTADA / SIGUIENTE PASO / MENSAJE SUGERIDO / COACHING). Writes **Transcripción venta** + **Resumen venta (IA)** and posts a 🎙️ note to Slack. **Audio venta procesado** is the visible state machine: blank = waiting, `procesando… <epoch>` = claimed (stale after 30 min), attachment ids = done, `ERROR: …` = failed (clear the cell to retry). Column names live in `airtableLeads.salesAudio` (client.mjs). **UNVERIFIED in prod:** whether a 30-minute m4a passes through the Workers AI binding in one call (Cloudflare documents no cap) — first real upload is the test; fallback is Deepgram's own API by URL (needs a `DEEPGRAM_API_KEY` secret). Consent: recordings need a visible notice + aviso de privacidad update (Evan).

Same day: booking-guard false positive fixed (claimsBooking), Slack "¿Llegó?" card retired (attendance = Airtable only), late-marked results react (no-show ≤48h, enrolled ≤14d), nudge signals (dedupe / buy-intent → Slack / age-conflict → link only), Reto welcome → in-chat booking, campaigns "Sitio web" + "Website (EN)" and the site's lead buttons now point at 2274, blast `excludePhones`, 450-message Saturday-trial blast (Kids 250 / Adults 100 / Baby 100, 0 failures).

### Brain sees template text (2026-09-17, night of the first promo blast)

Leads answering the blast with "10 am" confused the bot: its own turn in the history was the placeholder `[template:promo_independencia_manana]`. **Fix:** src/services/template-text.ts resolves placeholders before the brain runs — real body rendered with the sent params (wa.ts now records `params` in the template meta; older rows fall back to the contact's first name), prefixed with the CDMX send time, plus footer/button. Template texts come from the Meta catalog and are cached in kv `tpl_body:<name>` (one Graph fetch per cold name); fail-soft to the placeholder. Wired in inbound.ts step 7 only (approval cards still show the placeholder). Tests 755 → **761**.

Also tonight: template `promo_independencia_manana` created via the new `POST /admin/api/blast/templates/create`, per-tick cap 25 (`POST /admin/api/blast/settings`), first real blast = 300 sends in 3 runs (booked-no-show since Aug 1, booked-no-show before Aug 1 from Airtable, recent never-booked CRM leads), 0 send failures, 2 bookings + 2 bajas in the first hour.

### ⚠️ THIRD D1 rows-read incident — Chats inbox list query (2026-09-17, ~18:50 CDMX)

Budget for the new UTC day (starts 18:00 CDMX) was gone in under an hour: dashboard Usage showed **7.46M / 5M rows read from 886 queries**. D1 query insights named the culprit: `listConversations` (Chats inbox, polled every 5 s) at **~600k rows read PER CALL** (5 calls = 3.07M). Its two correlated "latest message for this phone" subqueries run per contact and need `idx_messages_phone_ts` — which schema.sql has carried since the inbox shipped but as a *console-paste* migration that prod evidently never received. **Fix shipped:** the index is now in the worker-applied batch (src/db/indexes.ts, guard bumped to `migr_idx_2026_09_17`), so the first cron tick after reads unblock creates it; test pins every index the inbox plan depends on to INDEX_SQL. Tests 751 → **752**. Side effects while blocked: inbound leads fail after the 200 ack (`setContactNameIfEmpty` throws), all cron jobs fail, the D1 console itself is blocked (cannot even read sqlite_master). **Evan upgraded / was asked to upgrade to Workers Paid tonight (US$5/mo, 25B rows/day)** — that is the only way reads come back before 18:00 CDMX 2026-09-18.

### ⚠️ Second D1 rows-read incident — caused by the blast sender (2026-09-16, ~15:30 CDMX)

Same symptom as 09-10: every admin route that reads a normal table threw (Cloudflare 1101 "Worker threw exception"), fail-soft routes (`/me`, `/staff`) and `/health` (`SELECT 1`) stayed green, inbound leads dropped after the 200 ack until the 00:00 UTC (18:00 CDMX) reset. **Cause:** the new blast code filtered `followups` on `kind='blast'` with no index — a full scan on every cron tick (drain) AND on every 10-s poll of the Envíos tab (per-run counts GROUP BY) while the tab was open for ~1 h. **Fix shipped:** index `followups(kind, status, due_at)` (worker-applied, kv guard `migr_idx_2026_09_16`; it can only be created once reads unblock), kv `blast_active` idle gate so a tick with no active run reads ONE kv row and never touches followups, the flag maintained on queue/pause/resume/cancel/done, tab poll 10 s → 30 s. Tests 750 → **751**.

**Lesson (add to every new query):** any new filter on a big table needs an index in src/db/indexes.ts BEFORE it ships, and nothing in the dashboard may poll a table scan. **Evan:** this is the second outage from the 5M rows/day free cap — Workers Paid (US$5/mo, 25 B rows read) removes the cliff entirely; strongly recommended. Check the WhatsApp Business app for leads who wrote between ~15:30 and 18:00 CDMX today.

### Closed dates (holidays) — bot stops offering today (2026-09-16)

Evan reported the bot booking trials on Independence Day. Immediate fix: KB overlay section (D1, id 5) telling the brain today is closed. Durable fix: `closedDates: [{date, reason}]` in clients/md-condesa/client.mjs (compiled into `CLIENT.closedDates`; compile-kb whitelist updated). Honored in three places: `buildContextBlock` adds a loud "CERRADO HOY …" line (plus closures in the next 14 days), `nextTrialSlot` skips the date (nudges / best-bet never propose it), `validateSlot` rejects `book_trial` on it. Tests 748 → **750**. **Add each holiday the academy closes to that list** (only 2026-09-16 is there — Evan to confirm Nov 2 / Nov 16 / Dec 25 / Jan 1 etc.). The overlay section is deleted once the deploy is verified.

### Bulk sender v2 (template blasts) — ready for the marketing templates (2026-09-16)

Owner guide: **docs/blasts.md**. The Aug-28 one-off sender (API-only, hard-wired to the old WABA's three program templates) became a real subsystem so the day Meta approves the marketing templates on WABA 1717538906028335, Evan can send from the dashboard without code.

- **Dashboard tab Envíos** (owner only, src/ui/admin.html `VIEWS.envios`): template picker fed by Meta (`GET /admin/api/blast/templates`, APPROVED first, others disabled), one input per `{{n}}` (`{nombre}` = first name, 👋 fallback), media-header link, audience from CRM leads (since date, program groups, include-booked) or a pasted `phone,name` list (ManyChat export pastes as-is), no-repeat window (7 d), limit, preview with exclusions + sample, one-phone test, start time + daily cap (250 default), confirm checkbox, runs list with progress bars and ⏸/▶/⛔ + failure detail.
- **Drain** (src/cron/blasts.ts, every tick after runDueFollowups): 6 sends/tick (kv `blast_per_tick`, max 10 — free-plan subrequest cap), 09:00–21:00 CDMX only, per-day cap from the run, rows **claimed before the Graph POST** (at-most-once). Errors are classified from the Graph code that wa.ts now puts in brackets (`WA send failed (404) [132001]: …`): template/account/auth/media → run auto-pauses + one Slack note; rate limits → retry (3×); everything else → row `failed` with the text. Completion note with totals. `dueFollowups` now excludes `kind='blast'`.
- **Registry in kv** (`blast_run:<id>` JSON) + counts from `followups` — **no D1 migration**. New row statuses `paused` / `failed` (schema.sql comment only).
- **Template preflight** (src/services/blast-templates.ts): queue refuses a template that is not APPROVED on the WABA, a wrong variable count, or a missing/mismatched media header. `WA_WABA_ID=1717538906028335` added to wrangler vars; without it the tab falls back to manual name+language.
- Tests 728 → **748** (blast planning, catalog parsing/validation, drain with fake D1).

**Pendiente Evan:** (1) submit the marketing templates (and the rest of the pack) under WABA 1717538906028335 — see docs/templates.md → "Blast templates" for the shape the sender supports; (2) first real blast: small audience (≤200), test on your phone first, watch the run card + Slack; (3) if the template dropdown says the catalog is unavailable, the WA token lacks `whatsapp_business_management` — manual mode still works.

### WABA migration DONE — 2274 now on WABA 1717538906028335 (2026-09-11)

**Executed 2026-09-11 (Evan + Claude in Chrome), runbook followed with two deviations.** New WABA **1717538906028335** ("MD Self Defense Condesa", currency MXN, verified/approved, ownership SELF) created from Business settings → WhatsApp accounts → Add → *Create a new WhatsApp Business account* → phone step **"Use a display name only"** (the new wizard has no number-less create and no WABA-name field; the display-name-only sender is inert). Card **MASTERCARD *5385** attached to it FIRST (UI-confirmed; `check` reported `newWabaHasFunding:false` because the token cannot read `primary_funding_id` — a false negative, not a missing card). Two-step on 2274 was already OFF in WhatsApp Manager (nothing toggled). Part 4 order actually run: `check` → **`subscribe` first** (empty WABA, so webhooks were live before the number landed) → `migrate` → `request_code` (SMS) → `verify_code` → `register` (PIN unchanged, still the one in the topology below) → `post_check`. All 7 calls returned `ok:true`, no `graphError`. `post_check`: CONNECTED, code VERIFIED, quality GREEN, name APPROVED on the new id. New **phone-number-id `1298937523303215`**; `WA_PHONE_NUMBER_ID` set in Cloudflare (Part 5) — live test passed: "hola" to 2274 → Slack card → Aprobar → reply landed; worker `post_check` shows `workerStillPointsAt: 1298937523303215`, `/health` ok/dbOk. Total outbound gap = the seconds between `register` and the Cloudflare save.

- [x] Parts 1–5 done (see above).
- [ ] Submit the template pack under WABA **1717538906028335** (docs/template-submission.md) — templates are WABA-scoped; this is what turns on the day-before / same-day reminders.
- [ ] Leave WABA 1582515279931864 alone for a week; do not delete it. The credit-line tickets (ManyChat + Meta support) are now moot.
- [ ] Bundle the `subscribe`-before-`migrate` ordering and the "Use a display name only" wizard path back into docs/waba-migration-runbook.md.

**Original decision (Evan, 2026-09-11):** move the sales number +52 1 56 4199 2274 to a fresh WABA we create ourselves, because WABA 1582515279931864 carries ManyChat's shared credit line and cannot take our card — and from **2026-10-01** Meta stops delivering in-window replies on a WABA with no payment method (service messages become paid: MX ≈ US$0.0115, first 1,000/number/month free). Full steps: **docs/waba-migration-runbook.md**.

Shipped: owner-only `GET|POST /admin/api/wa/migrate` (src/services/wa-migrate.ts) — one explicit Graph call per step (`check` → `migrate` [needs confirm `MIGRAR 2274`] → `request_code` → `verify_code` → `register` → `subscribe` → `post_check`), using the token already in Cloudflare; remembers the new phone-number-id in kv `wa_migration:new_phone_id`. Nothing runs on its own. Tests 722 → **728**.

- [x] ~~Parts 1–5~~ — done 2026-09-11, see the section above.

### D1 rows-read budget: inbox query rewrite + indexes (2026-09-11)

**Incident (2026-09-10):** Cloudflare blocked D1 reads for the day ("exceeded the daily D1 free tier limit of 5,000,000 rows read", reset 00:00 UTC = 18:00 CDMX). Writes still worked, but every path reads first, so inbound leads were dropped after the 200 ack (Meta does not retry), Slack buttons errored, cron did nothing useful, the dashboard could not even log in. `/health` showed `dbOk:false`. **Root cause:** the Chats inbox polled `listConversations` every 5s and that query did three full scans of `messages` + three of `pending_approvals` per call; the chat-detail poll added a full `pending_approvals` scan every 5s (no phone index). Nothing was lost in storage; messages that arrived during the block are lost (check the WhatsApp Business app for that window).

**Shipped:**
- `listConversations` rewritten (src/db/queries-admin.ts, `conversationsSql`): driven by `contacts`, one index probe per contact for the newest non-holding message, then page, then per-page counts via indexes. Also fixes a latent duplicate row when two messages shared a `ts`.
- `conversationsEtag` change fingerprint (`MAX(rowid) messages`, `MAX(id)` + pending count on `pending_approvals`, `MAX(updated_at) contacts`) — the SPA sends `&etag=` on every poll and gets `{unchanged:true}` for ~4 index reads when nothing moved; a full reload is forced every 15 min (covers campaign renames, the one thing the fingerprint misses). Poll cadence unchanged (5s / 10s with a chat open) because the steady-state cost is now trivial.
- Indexes, **applied from the worker** (src/db/indexes.ts, kv guard `migr_idx_2026_09_11`, runs on the first cron tick / first inbox load after deploy, memoized per isolate; mirrored at the end of schema.sql — nothing to paste): `pending_approvals(phone)`, `pending_approvals(status)`, `followups(status, due_at)`, `messages(direction, ts)`, `contacts(updated_at)`. They also make cron's every-5-min `dueFollowups` / `getPendingApprovals`, the Inicio overview (`COUNT(DISTINCT phone)` over the week's inbound), and the chat-detail pending lookup index-only.
- New test: test/conversations-list.test.ts runs the real query on `node:sqlite` loaded from schema.sql and pins the **query plan** (any full scan of `messages`/`pending_approvals` fails the suite). Tests 665 → **722**, green.

**Verify after deploy:** `/health` → `rev` bumped; open Chats, Network tab → repeated `/admin/api/conversations?...&etag=` responses are `{"unchanged":true,...}`; Cloudflare dashboard → D1 → wa-agent-db → metrics: rows read should flatten to well under 1M/day. If it climbs toward 5M again, upgrade to Workers Paid ($5/mo, 25B rows/month) per Evan's call on 2026-09-11.

**Related (not built):** Meta "Business Agent" emails (Sept 10) — Meta-hosted AI on the same Cloud API number; coexistence is via the handover protocol (`standby` webhook, thread control). Evaluated, not adopted: no approval-before-send, no custom persona/KB rules, $2/1M tokens per agent message. Watch the **Oct 1 2026** change instead: free-form service replies inside the 24h window become paid per message (payment method required in WhatsApp Manager → Billing by Sept 30 or delivery is suspended) — that hits THIS bot.

### Marketing metrics feeder + attribution repair (2026-09-09)

Full owner guide: **docs/marketing-metrics.md**. Airtable does the math (5 new tables `Ad Spend Diario`, `Anuncios Meta`, `Campañas Meta`, `Días`, `Meses` + rollups/formulas on Leads/Alumnos/Movimientos); the worker feeds it: Meta spend import (05:30 CDMX, 3-day re-pull, chunked backfill from `METRICS_SINCE`=2026-07-01), lead→Día/Mes/Anuncio and student→Lead link sweeps (every 15 min, same slot as syncBookings), 08:00 Slack brief (English) with exceptions. New modules: src/services/meta-insights.ts, src/services/metrics-airtable.ts, src/cron/ad-spend.ts, metrics-link.ts, metrics-brief.ts. Owner endpoints `/admin/api/metrics/{probe,pull,sweep,relink-students,brief}`. Gated by `features.marketingMetrics` + `META_AD_ACCOUNT_ID`. No D1 migration (kv only).

**Attribution bug found + fixed:** the Airtable "Auto create payment" automation linked the payment to the student by *name text*, racing the "Se inscribió" automation → phone-less duplicate students without `Lead Original` (since July: 64 paid students linked, 42 not). The "Se inscribió" automation now has the payment step inside (linked by record id) as a **draft**.

**Pendiente Evan:** (1) `GET /admin/api/metrics/probe` — if it reports a permission error, paste the creative-flywheel `META_ACCESS_TOKEN` as the encrypted secret `ADS_ACCESS_TOKEN` in the Cloudflare dashboard and re-probe; (2) publish the consolidated "Se inscribió" automation (open → Update) and turn **"Auto create payment" OFF** at the same moment; (3) `POST /admin/api/metrics/relink-students {"dryRun":true}` → review → `{"dryRun":false}`; (4) set percent formatting on the `Show Rate` / `Close Rate` / `Conversión` formula fields in Airtable (display only); (5) eyeball `Meses` 2026-08 `Gasto` vs Ads Manager August.

**2026-09-10 site attribution:** website booking forms now credit the ad (site repo `js/attribution.js` + hidden `Ad`/`Adquisición` questions on the 4 Airtable forms; see marketing-metrics.md §10). Evan's items (2) and the two record fixes from 09-10 are done. **2026-09-21 results:** September ROAS on the owner's definition (new sign-up sales from ad leads / spend, renewals excluded): month to date 1.38, last 14 days 1.68, last 7 days 2.87 (one promo day). Full table, funnel and outlook in marketing-metrics.md §11. **2026-09-11:** the worker now appends `utm_source=whatsapp&utm_content=<ad id>&utm_campaign=<campaign>` to every booking/schedule link it sends when the lead's ad is known (`src/services/booking-link.ts`, nudges + follow-ups + canned welcome). Pending Evan: push (= deploy) and create the Leads view «Origen pendiente» + its section on ⚠️ Excepciones (the MCP cannot create views/sections).


### Auditor nocturno Opus + fixes del día (2026-08-28)

**Auditor nocturno (owner-directed).** Cron diario 05:00 CDMX: compacta las conversaciones de las últimas 24h (plantillas repetidas → `[plantilla #N]`), adjunta la parrilla generada + el KB como verdad de referencia y las aprobaciones con latencia, y pide a **claude-opus-5** (thinking adaptativo, effort high) un reporte a #wa-leads: números, problemas con teléfono + cita, sugerencias. Solo reporta. `callAnthropic` ganó override de modelo. ~$0.20-0.40/noche, acreditado en usage_log (src/cron/nightly-audit.ts).

**Fixes de la revisión del 28/08** (todo verde, 679 tests): carrera del debounce — turnos de cerebro concurrentes (Axel: 3 respuestas en 40s) ahora se descartan si llegó un mensaje más nuevo mientras pensaba (book exento); `<context>` avisa cuando ya hay reserva registrada; `claimsBooking` ya no cuenta "¿me confirmas tu nombre para dejarlo agendado?" como reserva hecha (falsos capture cards); `parseBookingHints` entiende "5 de septiembre" (día-mes explícito gana al weekday); el recon solo exige día exacto con fecha explícita y la ventana sin fecha pasó a ±7/+30d (digest del 28/08: 6 flags, ~0-1 reales).

**Del 27/08 (noche):** los 4 bugs del day-after arreglados (pp slots fuera de nudges, marker booking_recorded en el camino del cerebro + guard con memoria, trial_confirm duplicado, supersede de tarjetas viejas al agendar/enviar directo); sentinel `<sin_respuesta>` hard-stop; holding line máx 1/tel/45min; reintento único cuando el modelo no llama send_reply (causa raíz de que best-bet nunca disparara — 0 auto_sent con sureness=∅, confirmado por la nota bb_diag); KB: elevador sí, Mini MT papás ayudan en partes, IG para fotos, Teens fin de semana, seminario Cejudo (3/sep, preventa $899, CLABE + comprobante → humano), promo Mañanas $999 con link de pago mpago.la/2UBtTvP y cierre por el bot.

**Pendiente Evan:** pegar firstReply/info nuevos en las 2 campañas mañanas $999 (textos entregados 27/08); enviar a Meta las plantillas d2-d5 (docs/templates.md — un envío d5 ya se omitió) y las 3 plantillas de blast por definir.

### Over-offering fixes — double welcome + impossible hours (2026-08-25, later)

Two live defects reported by Evan the same afternoon, both about the bot throwing too many/wrong schedule options at a lead.

**1. Two messages back-to-back after a campaign welcome.** Lead 5215525756692 (Reto Gladiador) got the canned `first_reply` at +3s and a brain reply at +14s — 5 time slots in 14 seconds. Cause: the first-reply gate's `hasRealQuestion` fall-through fires on ANY "?", and the welcome had already answered the question ("dónde están ubicados"), so the brain had nothing to add and filled the gap by re-offering horarios. 4 of the last 42 first-reply leads hit it. Fix: `ConvoContext.justSentWelcome` carries the welcome text into the same turn's brain call; `buildContextBlock` renders `<bienvenida_ya_enviada>` (answer only what's uncovered, never re-offer horarios or the link, never repeat greeting/location/pitch), and the model can end the turn with the `<sin_respuesta>` sentinel to send nothing at all. Sentinel honored ONLY on a welcome turn, only for send/draft, and only when the message has no real words beside it.

**2. Box offered at 7/8 am.** Lead 5215626500140 asked about Box and was drafted "hoy Box a las 9 pm, o mañana miércoles a las 7 u 8 am". Box runs Tue 9 pm / Thu 9 pm / Sat 2 pm and nothing else; the model carried the L–J morning combo over to a discipline with no morning. `guardUnverifiedSlotClaim` held it — but by luck: `parseBookingHints` reads the first day and first hour independently, so it paired "miércoles" with "21:00" and judged a phantom slot. Fix: a new day-independent tier — for copy naming exactly ONE discipline, every hour must be an hour that discipline runs at some point in the week (`disciplineNeverRunsAt`); the reason names the discipline's real hours. The old pairing tier now runs only on copy naming one hour and ≤1 day (it would otherwise false-flag legitimate multi-offer replies). New pure helpers: `parseAllTimes` (incl. the "7 u 8 am" shared-meridiem run), `parseAllDisciplines`, `countDayTokens`.

**Copy/KB changes.** persona: the offer cap is now a hard "máximo TRES opciones, nunca cuatro", explicitly allowed to span two days ("hoy 6 pm, 7 pm, o mañana 7 am") — the old rule said "del mismo día" and the model read past it; open ranges are not options; a two-class combo at one arrival hour counts as one. Plus a rule that every hour offered must be a row of the discipline the lead asked for, and an alternative must be named as itself. intake.md gained explicit Box and MMA hour lines (the KB listed the morning combo but never said Box has no morning). Campaign #4 (Reto Gladiador) `first_reply` rewritten live in D1: the 4-slot menu is gone, it now closes on the booking link (https://mdcondesa.com/clase-prueba-adultos/) per owner directive.

Tests 654 → **665**, green. No D1 migration.

### Sureness: probability-driven sending + 1-hour best-bet (2026-08-25, owner-directed)

Owner's rules now live: the model reports `sureness` 0-100 per reply. **>=75 → sends immediately** (auto-send lane; kill switch + 100/day breaker + the two correctness locks: unbacked booking claims and invented schedule slots NEVER auto-send). **25-74 → queues for approval, and if nobody acts within 1 HOUR the draft sends itself** (status `auto_sent`, Slack card stamped "Enviada automáticamente tras 1h · seguridad NN%"; opt-out re-checked; guarded/⚠️ drafts excluded; ignores business hours — it's a direct reply). **<25 → human-only, expires at 12h as before.** Price/first-contact auto-send gates removed by owner directive. Sparring hours are BOOKABLE for trials again (professor gives first-timers a mini-lesson); defensa personal routes to muay/jiu/mma/box with the MMA-foundations framing. Draft cards now show "seguridad NN%".

### KB pack — confidence rewrite + mined rules + nudge overhaul (2026-08-25, later)

Part A: persona.md gained the 8-box confidence checklist ("high" is the default when every box ticks; low is priced at "up to 12h delay"), the 19 style rules mined from Evan's 128 edits, schedule corrections (Kids 4pm arrival, Friday warning, Sunday adults-only, Mini MT exact days, BFC-only price exception, positive price reframe), a "Datos que preguntan seguido" facts section (verbatim-sourced from edit finals; Mini MT + adult class DURATIONS still need Evan wording), BFC minimum age ruled 12 months. Code: `guardUnverifiedSlotClaim` (full day+time+discipline claims that don't resolve to a SLOTS row force draft/low), campaign first-reply question passthrough (canned welcome + brain answers the appended question), KB TOKEN_LIMIT 9000→11000 (KB now 9,838).
Part B: nudges propose a REAL next slot (`nextTrialSlot` over generated SLOTS, sparring skipped, ≥2h buffer), plural voice + kids link for kids/baby leads, day-1 cadence 3→2 (dropped nudge_6h), open-question guard (never nudge over the bot's own <2h-old question). Also: one-time in-worker migration created `idx_pending_approvals_created` and force-refreshed the Slack control panel (auto-send button now visible).

### Hardening slice — precision fixes from an external review (2026-08-25)

Five tightenings, no behavior changes beyond the ones described. Tests 573 → **586**, green; no D1 migration (kv + an existing table only).

- **Slot-exact capture guard** (booking-core/booking-guard): `booking_recorded:<phone>` now stores `{"ts","trialDate","trialTime"}` instead of a bare epoch (the reader still accepts legacy bare-epoch rows, which back any claim for their 72h life). `auditHumanSend` parses the sent text FIRST; when the copy names a date, only a marker for that same date/time or an anti-no-show sequence armed for it counts as backed — a fresh booking no longer masks a NEW unbacked promise for a different class. Dateless copy keeps the old "any fresh marker" rule (no false positives on vague texts). A mismatch card carries `⚠️ Ya hay un registro para <fecha> <hora> — esto parece OTRA clase`. Followup→trial-date mapping is derived from `computeTrialSequence` (same_day ⇒ its CDMX due date; day_before ⇒ +1 day; trial_confirm carries no date signal).
- **Slot-exact nightly reconciliation** (booking-recon): a dated claim now needs a booking on that same CDMX calendar day (day granularity — the digest's job is "does this class exist at all"); dateless claims keep the ±7/14d window. Digest lines gained `— prometido <fecha>, en Airtable: <fecha|ninguna clase>`.
- **Airtable schema drift can't drop essentials** (airtable.ts): an `UNKNOWN_FIELD_NAME` 422 on the phone or trial-datetime column now throws `AirtableWriteError` ("booking aborted, fix the base or client.gen mapping") instead of dropping the field and reporting a dateless "successful" booking. Everything else keeps drop-and-retry.
- **finalizeBooking step isolation**: Slack FYI / sequence / qualification / lead sync each get their own try/catch, so a Slack outage can never cost the lead their anti-no-show reminders.
- **Atomic auto-send cap + pre-send re-check**: `tryClaimAutoSendSlot` (INSERT OR IGNORE + guarded UPDATE) replaces the read-modify-write bump and is claimed immediately before delivery (released if delivery degrades to an approval); the pure gate's count is now only a pre-screen. The Slack holding line re-reads the approval's status after winning `claimHoldingSend` and stays quiet if a human resolved it in between — best-effort narrowing, not elimination (no transaction spans D1 and the Graph API).

### 15-day conversation audit — findings + pending actions (2026-08-25)

Full report (artifact): "Radiografía del Agente". 185 convos / 226 approvals / 128 edits reviewed by a 22-agent fleet; every critical finding verified against raw transcripts (56 confirmed, 9 adjusted, 0 refuted). Headlines: only 9.7% of leads reach an evidenced booking; 23% of approval drafts EXPIRE unanswered (65% die overnight); ALL 226 approvals were confidence:low (structural — the persona's "high" definition is unreachable); link-push campaigns (Reto 7.6%, Kids 4.5%) convert half of the in-chat-booking baby flow (16.1%); overlay §1 actively instructed offering Thursday sparring ("ni menciones que uno es sparring"); 18/128 owner edits are schedule corrections (Friday afternoons invented, Sunday kids offered, Mini MT days wrong).

Shipped this same day (7 slices, 573 tests green): atomic holding/expire claims; approvals-history endpoint (+ IN()-chunking 500 fix); slot hardening (sparring `trial:false`, Mini MT dual-audience, defensa-personal mapping, contract tests); booking-failure Slack alerts; human-booking capture cards (detect + 1-click Registrar); multi-person bookings; gated auto-send lane (inert); nightly booking reconciliation digest.

- [x] Overlay §1 updated live (mini-lesson sparring framing + hora-actual validation); campaigns 3/4 first_reply now book in-chat with real slots; campaigns 5/6 schedule claim corrected to day-accurate.
- [ ] **Evan**: check mdcondesa.com/clase-prueba-adultos/ (lead reported it broken 08-24) and confirm the canonical booking URLs (`/agendar-clase-prueba-adultos/` vs the stale ones intake.md ships).
- [ ] **Evan**: say "aplica el paquete de KB" → one slice deploys the confidence checklist (high-as-default with 8 verifiable boxes + code backstop), 19 mined style rules, schedule corrections, missing facts (Reto prize, WellHub, class size, duration, Del Valle), campaign fixes (answer appended question + in-chat booking for Reto/Kids/mañanas), nudge copy rewrite. Requires raising the KB TOKEN_LIMIT (at 8,921/9,000).
- [ ] **Evan**: rule on Baby Fight Club minimum age — his edits say 11 months, intake/campaign say 12.
- [x] Auto-send ARMED 2026-08-25 (Probar verified: FAQ/price/sparring-booking all rate high; cap 100/day; kill switch = same Slack button or POST /admin/api/autosend {"enabled":false}).
- [x] Index created via the one-time in-worker migration (kv `migr_idx_pending_approvals_created`).

### Sureness: the owner's 75/25 rule (2026-08-25)

Evan's directive, verbatim: *"if it's at least 75% sure it has the correct answer, it sends. only asks for approval if it's less than 75% sure"* and *"if it waits more than an hour with no approval, it sends its best bet as long as it's 25% sure — a 30% answer in an hour beats the 100% answer 12 hours later."* The audit had shown 23% of drafts expiring unanswered (65% overnight); this is the fix.

- **`send_reply` gained a required integer `sureness` (0–100)** (src/brain/tools.ts). `confidence` stays on the wire but is now DERIVED in `sendResult` (src/brain/claude.ts): `sureness >= 75 ⇒ "high"`. Missing/garbage sureness (incl. `null`) falls back to the old enum and stores no number. `BrainResult` send/draft carry `sureness?`. The correctness guards (`guardUnbackedBookingClaim`, `guardUnverifiedSlotClaim`) DROP the number — their drafts must never self-send.
- **persona.md**: the `# Confidence` section is now `# Seguridad (sureness 0-100)` — same 8-box checklist, re-framed as calibration (8/8 ⇒ 80-100; soft phrasing doubt ⇒ 60-75; a factual box fails ⇒ 25-50; guessing/escalation ⇒ 0-20), with the stakes spelled out. The "sparring hour ⇒ low" clause is gone (sparring trials are allowed now).
- **Auto-send lane** (src/services/auto-send.ts): gates are now `switch → action → sureness (>=75) → booking_claim → cap`. The `price` and `first_contact` gates were REMOVED by the directive — sureness owns price caution (checklist box 3), and a lead's first reply no longer needs a prior human sign-off. `booking_claim` stays: an unbacked "ya quedó agendado" is a correctness lock, not caution. Cap raised **20 → 100/day** (circuit breaker, not throttle). `hasResolvedApproval` deleted with its gate.
- **Best-bet timeout** (src/services/slack-timeouts.ts + slack.ts): `decideTimeout` gained `kind:"bestbet"` — pending >1h, kv sureness ≥25, not guarded, window open. It IGNORES the 09:00–21:00 gate (it's a reply to a lead who wrote ≤13h ago) and is checked ABOVE expiry. Execution claims the row as the new `auto_sent` status (atomic; lost claim ⇒ silent), sends the draft verbatim, stamps the card `⏱️ Enviada automáticamente tras 1h sin revisión · seguridad NN%`, then runs the shared `runPostSendEffects` (booking video / nudge re-arm / booking-claim audit under new source `auto_timeout`). `WindowClosedError` downgrades the row to `expired` + template card. Holding line (10min) and expiry (12h) unchanged for everything best-bet won't touch.
- **No D1 migration.** Sureness and the guard flag ride kv side-channels written by `queueApproval` (`sureness:<id>`, `guarded:<id>` when the draft's reason carries "⚠️"), exactly like `booking_approval:<id>`. `auto_sent` is an additive TEXT value in an existing column; every status filter is either pending-scoped or an explicit list, and the history endpoint's `STATUSES` map is exhaustive-by-construction (adding the member was a compile error until listed).
- Slack draft cards show `· seguridad NN%` in the header; the auto-sent FYI shows `🤖 Auto-enviado (seguridad NN%)`.
- Tests 632 → **647**, all green.

### Slice 6 — gated auto-send: a narrow always-on lane under training wheels (2026-08-25)

Training wheels still route every reply through Slack. This adds ONE exception: a reply that is obviously safe **and** lands in a chat a human already signed off on goes out immediately instead of waiting for an approval. Ships **inert** — the kv key is absent, which means disabled; Evan arms it from the Slack panel (or `POST /admin/api/autosend`).

- ⚠️ **Superseded the same day by the sureness rework above** — the `confidence`, `price` and `first_contact` gates described here no longer exist and the cap is 100. Kept for the reasoning behind the surviving gates.
- **`src/services/auto-send.ts`** — `decideAutoSend()` is the whole safety contract, pure and unit-tested. Gates, first failure wins (`blockedBy`): `switch` (kv `auto_send_enabled` !== "1", **missing = OFF**) → `action` (only the brain's plain `send`) → `confidence` (only `high`) → `booking_claim` (shared `claimsBooking` regex — anything promising a real class gets human eyes) → `price` (`PRICE_PROMO_RE`: `$`, precio/costo/promo/descuento/mxn/inscripci*/mensualidad/membres*) → `first_contact` (the phone needs ≥1 approval a human resolved as approved|edited — the FIRST reply of a conversation is never auto-sent) → `cap` (**20 auto-sends per CDMX day**, kv `auto_send_count:<YYYY-MM-DD>`, rolls over on its own). `evaluateAutoSendLane()` wraps the D1 reads (switch first, per-lead queries only for a message that is eligible on its own text) so the pipeline stays a thin call.
- **`routeResult`** (src/pipeline/inbound.ts): unchanged when wheels are OFF. With wheels ON and the old `autoSend` false, it evaluates the lane; on `auto` it delivers through the SAME `deliverOrDraft` as the wheels-off path (outbound row stored, nudge drip armed, closed window still degrades to an approval), bumps the counter and posts an FYI. Anything the lane refuses falls through to `queueApproval` exactly like before — no other behavior change.
- **Slack**: silent FYI card `🤖 Auto-enviado (alta confianza) — nombre · teléfono` + the text + `n/20 hoy`, with **🙋 Tomar control** (new `takeover_phone|<phone>` verb — an auto-sent reply has no approval row to claim, so it just applies the same `HUMAN_SNOOZE_HOURS` pause). Control panel gained an **Activar/Apagar auto-envío** button pair (`autosend_on`/`autosend_off`) plus a status line; every flip posts an audit note naming who clicked (`ParsedInteraction.user` is now parsed).
- **Admin API**: `GET /admin/api/autosend` → `{enabled, todayCount, cap}`; `POST /admin/api/autosend {enabled}` sets the kv and returns the new state (also refreshes the Slack panel). No dashboard UI yet — the Slack button is the switch.
- Master override unchanged: `getTrainingWheels(env) === false` (night mode / TRAINING_WHEELS=0) ⇒ the old path already auto-sends and this lane never runs.
- Tests 530 → **555**, all green. No D1 migration (kv only).
- [ ] **Evan**: arm it when ready — Slack `#wa-leads` control panel → 🤖 Activar auto-envío. Turning it off is the same button (or `POST /admin/api/autosend {"enabled":false}`).

### Slice 4 — human-booking gap closure: detect + 1-click Registrar (2026-08-25)

Until now the **only** thing that wrote a trial to Airtable was the brain's `book_trial`. Every class a human confirmed over WhatsApp — Aprobar/Editar on a Slack draft, a dashboard staff reply, a scheduled "send later" — left the CRM empty and the anti-no-show sequence unarmed. Slice 7's nightly digest reported the damage; this closes the loop in real time.

- **`src/services/booking-core.ts`** is now the one place a booking is finalized. `finalizeBooking` (Slack FYI + anti-no-show sequence with `includeConfirm:false` + qualification + `booking_created` sync) was lifted verbatim out of `routeResult`'s `book` branch, which now calls it — zero behavior change, except it no longer throws out of the reply path. `registerBooking` is the human entry point: validateSlot (skippable via `force`) → Airtable `bookTrial` → `finalizeBooking` → booking video, plus a `booking_recorded:<phone>` kv marker.
- **`src/services/booking-guard.ts` — `auditHumanSend(env, phone, text, source, by?)`**: fire-and-forget post-send audit, never throws, always awaited. Gates: `claimsBooking` → already-backed check (fresh `booking_recorded` marker <72h, or a scheduled booking-kind followup) → one capture per lead per CDMX day → parse → validate → Slack capture card. Hooked into `approveAndSend`/`editAndSend` (skipped for booking-origin drafts, which already wrote Airtable), the dashboard composer and the `staff_later` cron dispatch.
- **Parsing** is regex-first (`parseBookingHints` in booking-claims.ts — hoy/mañana/pasado mañana, weekday→next occurrence, `7 pm`/`11 am`/`19:00`/`3:15 pm`→15:15, disciplines via CLIENT.services + Baby Fight Club / Mini Muay Thai special cases). Only a non-`full` parse spends **one** cheap `propose_booking` model call (300 max tokens, no KB) to fill the gaps; regex always wins on what it read.
- **Slack card**: `⚠️ Confirmaste una clase sin registro en Airtable` with the quoted send, the parsed fields, a ✅/⚠️ schedule verdict, and **Registrar en Airtable** (label becomes "Registrar de todos modos" when the verdict failed) / **Corregir datos** (5-field modal) / **No era un agendado**. Registering is at-most-once via a kv claim, released on failure so a fixable cause can be retried.
- **Dashboard endpoints (no UI yet)**: `POST /admin/api/conversations/:phone/booking/parse` (read-only: hints + verdict for the last outbound) and `POST /admin/api/conversations/:phone/booking` (registers; `{name, childName?, discipline, audience, trialDate, trialTime, force?}`).
- `accrueChatUsage` moved to `src/services/usage.ts` (kb-editor.ts re-exports it) so a caller that just logs tokens no longer drags the whole compiled KB in behind it.
- Tests 473 → **530**, all green. No D1 migration (kv only).

### Attribution v2: trigger-first precedence + ad-name lookup + staleness fixes (2026-08-04, later)

Root-caused the "mananas-999 ad answered as Reto Gladiador" incident (Evan's own test click): (1) Meta LOCALIZED the prefill (English phone ⇒ "Hello! Can I get more info on this?") so the Spanish trigger never matched; (2) the new mananas campaigns had no keywords/ad-ids; (3) the contact carried a STALE July Reto attribution (campaign_id + ad_ref) that the brain was briefed with. Fixes:

- **Precedence reordered: trigger phrase FIRST**, then exact ad-id, then keywords. One ad's several ice-breaker prefills can route to DIFFERENT campaigns (mananas "probar" vs "inscribirse"), so the designed phrase must outrank the shared ad id.
- **Ad-name tier**: `lookupAdMeta` (src/services/ad-meta.ts) resolves referral ad id → Ads-Manager ad name + Meta campaign name via Graph API (kv-cached `ad_meta:<id>`, miss retries daily, fail-soft). Normalized name feeds the keyword matcher — keyword `mananas 999` matches ad "mananas-999 cafe comparison". Token: optional `ADS_ACCESS_TOKEN` secret (needs ads_read), falls back to WA_ACCESS_TOKEN — if the WA system-user token lacks ad-account access the tier silently skips; add the secret to enable it.
- **Fresh `<ad_info>`**: the brain now sees THIS click's referral, not the contact's first-ever ad_ref (CRM keeps first-touch).
- **Stale-tag clear**: a referral click matching NO campaign clears contact.campaign_id instead of leaving the old campaign's info to mislead the brain.
- [ ] Optional (Evan): create a Meta token with ads_read on act_1334257084455191 and `wrangler secret put ADS_ACCESS_TOKEN` (or Cloudflare dashboard) if the WA token turns out not to cover ad lookups — check for `ad_meta:*` kv rows or the 🎯 line correctness after the next new-ad click.

### IG/FB DM adapter (shipped DARK 2026-08-04 — flags off, plan: ~/.claude/plans/now-that-the-app-replicated-cat.md)

The bot can now answer **Instagram DMs + Facebook Messenger** through the same pipeline (brain → training-wheels approval → reply on the right channel). Everything ships behind `features.instagram` / `features.messenger` in clients/md-condesa/client.mjs (**both false** — IG/FB webhook events are logged + dropped until flipped). WA behavior unchanged; 380 tests green.

How it works: IG/FB contacts live in the existing `phone` column as namespaced ids (`ig:<IGSID>` / `fb:<PSID>`, zero D1 migration); the webhook parser dispatches on the payload's `object` field (same endpoint — `/webhook/meta` is an alias of `/webhook/whatsapp`, same verify token + app secret since the products share app 2215578122600171); sends go through the new `src/services/send.ts` facade → `messenger.ts` (`POST /<FB_PAGE_ID>/messages`, page token). **No templates on IG/FB**: 24h–7d sends auto-use the HUMAN_AGENT tag (needs its own App Review permission), >7d = cancelled + one throttled Slack note; cron reminders send free-form equivalents (`messengerReminderText`). Airtable syncs IG/FB leads with exact-string identity + Canal=IG/FB (the last-10-digit fuzzy match is guarded — an unguarded IG id could have cross-matched and corrupted a real lead's row; that guard is live NOW regardless of flags). Dashboard shows IG/FB chips, renders CDN media (urls expire — accepted v1), composer stays open 7d on IG/FB, attachments are WA-only v1.

### ⚠️ Evan's checklist (IG/FB — Meta console, in order)

- [ ] Confirm @mdcondesa (IG professional) is linked to the academy's **FB Page** (Page ↔ IG link; separate axis from the IG↔WhatsApp-0813 pending decision below, which does NOT block IG DMs).
- [ ] App 2215578122600171 → add **Messenger** + **Instagram** products. Webhooks callback: `https://md-condesa-wa-agent.evancaguilar.workers.dev/webhook/meta`, verify token = the existing `WA_VERIFY_TOKEN`. Subscribe fields on BOTH products: `messages`, `messaging_postbacks`, `message_echoes` (echoes = replying from the IG/page inbox pauses the bot; without them it double-answers).
- [ ] Subscribe the **Page** to the app; generate a **Page access token** (page-scoped — NOT the WABA system-user token) with `pages_messaging` + `instagram_manage_messages`.
- [ ] Cloudflare dashboard (local wrangler = wrong account): add secrets **`PAGE_ACCESS_TOKEN`** and **`FB_PAGE_ID`**.
- [ ] Airtable: add **`IG`** and **`FB`** options to the Canal select (missing option = loud daily sync-failure note, never a wrong "WA").
- [ ] Tester phase: flip `features.instagram/messenger: true` in client.mjs → `npm run build` → push. App still in Standard Access ⇒ only app-role testers' DMs arrive; TRAINING_WHEELS gates every reply anyway. Verify: text round-trip IG+FB, voice note transcribed, echo takeover from the IG inbox, full booking (Canal=IG row + anti-no-show armed), timestamps sane.
- [ ] **App Review round 2**: `instagram_manage_messages`, `pages_messaging` + the **Human Agent** permission (7-day tag; until approved >24h sends degrade into the WindowClosed→approval path). Screencast the tester flow. Per the 2026-07 lesson: after submitting, hunt ALL Meta surfaces for undismissed forms — silence = a form waiting somewhere, not a slow queue.
- [ ] Approved → real IG/FB users flow in automatically (flags already on from tester phase). Watch Slack sync notes + cancelled-followup counts the first week.

### Inbox v2 (shipped 2026-08-04 morning — 4 commits, 10be1ad..1a0aaa7)

The /admin Chats inbox is now a team tool. Built via multi-agent workflow + 3-verifier adversarial pass (which caught 1 real BLOCKER pre-push — the verify-fixes commit).

- **/health `rev`** — content hash of src/** (tools/gen-rev.mjs → src/rev.gen.ts). THE deploy fingerprint for code-only deploys (kbVersion can't see them). Verify: `node tools/gen-rev.mjs` at a commit == served `rev`.
- **Draft cards capped** (#pendWrap/.pbody scroll) — the transcript is always visible.
- **Assign to anyone**: header dropdown (— Sin asignar — / roster from `GET /admin/api/staff`); action row memoized so the open dropdown survives the 5s poll. Needs fer/vale accounts created in Usuarios.
- **Shared read/unread**: `contacts.read_at` (⚠️ migration below), 📩 No leído header action (works even when the last message is ours), "No leídos" filter chip, open chats advance the shared watermark. Pre-migration: falls back to per-browser localStorage, zero regression.
- **Send later ⏰**: composer button + presets (Mañana 8:00 / Hoy 18:00 / En 1h) + datetime; rides `followups` kind `staff_later` (no migration). Auto-cancels if the lead writes first (text preserved on a 🚫 card with 📋 Usar en composer); quiet-hours clamp; window-closed at fire time = LOUD Slack note; sends as staff (pauses bot like any staff reply). At-most-once with claim-release-on-failure (the BLOCKER fix: a transient Graph error now retries instead of laundering into a fake 'sent').
- **🪄 Reescribir (guided rewrite)**: tell the bot how to change a pending draft ("ofrécele el horario de mañana"); `POST /approvals/:id/rewrite` runs a bare no-tools model call (book_trial can't fire); result lands in the edit box for review; sending via the normal edit path logs the draft→final pair for the edit tuner. In Chats pendcards + Aprobaciones.
- **Opt-out hardening**: `sendTemplate` throws OptedOutError for baja'd contacts (universal backstop incl. future broadcasts); result-watcher sends skip baja; a baja discards pending drafts (gate 3 + claimAndSend race defense); staff sends soft-block with clear toasts; **manual 🚫 baja via the existing status control** (`POST .../status {status:"opted_out"}`) with gate-3 side effects + kv audit + Slack note; unknown status values 400 (no more silent un-baja).
- **📝 Historial de ediciones** panel in the Editor view (lazy, diff cards, phone links into Chats) — completes the edit-tuner loop UI.
- Tests 339 → **360**, all green.

### ⚠️ Evan's checklist (Inbox v2)

- [ ] **D1 migration** (console paste; mirrored at end of schema.sql): `ALTER TABLE contacts ADD COLUMN read_at INTEGER;` — until then read/unread is per-browser like before.
- [ ] Create **fer/vale** accounts in /admin → Usuarios (needs the inbox-v1 admin_users migration) so the assign dropdown has people.
- [ ] **Mark `oswinvaldes` +52 55 1909 4323 as baja** ("No y bloqueame", 2026-08-03 23:03 — NOT one of the 9 exact opt-out phrases, so the gate did NOT flag him; the polite reply was the brain). One tap now: his chat → status → 🚫 baja.
- [ ] **Submit the template pack on WABA 1717538906028335** (payment method is now on that WABA) — still the highest-leverage item: day-before/same-day reminders silently do nothing until then. Answer to the confirmation question: day-of confirm for a booking made days earlier REQUIRES a template (window closed) → `trial_reminder_same_day` (Utility) already covers it in the pack.
- [ ] Cloudflare → Workers Builds: confirm last night's + this morning's builds deployed (/health `rev` should be `40056eea736b`).

Deferred by decision: broadcast/plantillas panels (phase 2, after templates+payment), profile photos (Meta doesn't expose them — skipped), nightly auto-arm of night mode (stays manual).

### Keyword campaign matching + edit-learning loop (shipped 2026-08-04)

**Ad-keyword matching kills the ad-id treadmill.** Campaign attribution is now three-tier (gate 3b): exact ad-id → **ad-creative keywords** (`campaigns.ad_keywords`, comma-separated phrases matched normalized/whole-phrase against the referral headline+body) → trigger phrase. A keyword/trigger match on an ad referral **auto-learns** the new ad id into the campaign's `ad_id` (race-safe append + one-time Slack note "🔗 Anuncio … vinculado"). New ads self-attribute + self-register — no more manual id entry. Campañas UI has the keywords field (create + edit, 🔑 chip); Probar has "📣 Simular anuncio" (headline/texto/ad id, no auto-learn from sandbox); the Editor's propose_campaign can set keywords.

- [ ] ⚠️ **D1 migration (keywords)** — Evan pastes in D1 console (mirrored at end of src/db/schema.sql; code fail-softs until then — keyword tier inert, dashboard field a silent no-op). Also confirm the older `first_reply` ALTER ran (listed at line ~"first_reply" below):
```sql
ALTER TABLE campaigns ADD COLUMN ad_keywords TEXT;
```
- [ ] After the ALTER: add keywords to each campaign in /admin → Campañas (e.g. Reto: `reto gladiador, reto`). That supersedes the "add ad id 120249684011870518 manually" item below — the next click on any Reto ad auto-attributes and registers its id.

**Edit tuner (training-wheels feedback loop) is live.** D1 `edits` (every ✏️ Editar diff) now has a consumer: `src/services/edit-tuner.ts` (+ pure `edit-tuner-core.ts`, unit-tested). Cron: inside the daily 10:00 block, self-gated to ≥6.5 days since last run AND ≥5 new edits past the kv watermark (`edit_tuner_watermark`, `edit_tuner_last_run`); analyzes the most recent ≤30 pairs (draft→final) against the current overlay, proposes ≤3 overlay edits (propose_kb_edit/delete only), posts a 🧠 summary + per-proposal Slack cards with **✅ Aplicar / 🗑 Descartar** buttons (`tune_apply|` / `tune_discard|` / `tune_force|`; records in kv `tuning_proposal:<epoch>:<n>`, double-tap claim-guarded, stale-section warning with explicit force). Apply reuses kb-editor `applyProposal` (2000-token overlay cap enforced). On-demand: **🧠 Analizar ediciones** button in the Editor tab (`POST /admin/api/kb/analyze-edits`, watermark-untouched) renders proposals in the existing chat/Confirmar UI. No migration needed (kv only).

### CTWA ads → 2274 repoint + result-watcher staleness guard (2026-08-04)

**Ads were NOT all pointing at 2274** (contrary to the note below from cutover day) — at least one ad set was bound to the dead eSIM debris number **7197** (leads messaging it = black hole). Repointed via Ads Manager. The saga, for next time:

- The Page-level "Connect WhatsApp number" OTP dialog (Page settings) can **NEVER** accept 2274 — it only verifies numbers running the WhatsApp/WA Business *phone app*; a pure Cloud API number always errors "isn't associated with a WhatsApp account". That's expected, not a problem. **NEVER click "create a new account" there** — it would register the number in the app and destroy the Cloud API registration (1–2 month re-entry cooldown).
- Working path: WhatsApp Manager → 2274 → Profile → Social accounts → connect the FB Page, then facebook.com/settings?tab=linked_whatsapp → **Set as Primary**. After that (plus a hard refresh + a few min of propagation), the Ads Manager ad-set "Message destination" dropdown lists Cloud API numbers — pick **+52 1 56 4199 2274 (Cloud API number)**. Ad IDs don't change on edit, so campaign attribution is untouched.
- **Legacy ad sets freeze their WhatsApp binding at creation.** Some old ad sets keep showing the "You'll need WhatsApp Business" wizard even after the Page fix (new ad sets in the same campaign show the dropdown fine). Try: Manual destination → uncheck WhatsApp → save → re-check. If the wizard persists, rebuild: new ad set + duplicate the ads into it → **new ad IDs** → APPEND them to the campaign's ad-id list in /admin → Campañas (keep the old IDs listed so late-tapping leads still match).
- Dropdown number cheat-sheet: 2274 = bot (sales, correct). 0813 = humans/support (never for ads). 7197 = dead debris. +1 555… = Meta test number.
- **IG ↔ WhatsApp pending decision:** @mdcondesa Instagram is still linked to 0813's WA Business app (that's why "Connect Instagram" for 2274 errors "already connected to another WhatsApp account"). NOT needed for ads (Page connection covers IG placements); it only controls the IG-profile WhatsApp button. Moving it to 2274 = first disconnect on the academy phone (WA Business app → Business tools → Facebook e Instagram), then connect in WhatsApp Manager. Evan's call, unhurried.

**Result-watcher staleness guard** (code rode along inside commit 85a451b "R2: media in/out"): `processResult` now only sends the welcome/no-show reaction when the record's Trial DateTime is **same-day CDMX**; older or dateless records still get status=student/cancel/KV-marker treatment silently. Root cause: lead-sync bumps an old Airtable row's modified time whenever that contact writes in again → syncBookings re-surfaced months-old "Se inscribió" results → ghost "¡Bienvenid@ a la familia!" (happened to Valeria Nava, Feb enrollee, 2026-08-03). Each pre-guard record could still fire at most once; guard is live as of the 2026-08-03 20:19 deploy.

### Ad-context awareness (shipped 2026-08-04)

- **Brain sees the clicked ad**: the contact's `ad_ref` (headline + creative text) now rides into the per-turn `<context>` as an `<ad_info>` block, even when the ad id isn't mapped to any campaign — the model infers program/audience from the creative (e.g. Reto Gladiador ⇒ adult) instead of asking "¿para ti o para un peque?".
- **Slack draft card shows attribution**: `🎯 Campaña: <name>` (or `_sin asignar_` when an ad lead has no campaign match — the cue to add that ad id in /admin → Campañas) + `📣 Anuncio: headline — «body snippet» (ad id)`.
- **Adults with a usable WA profile name skip name confirmation**: persona rule — if `<context>` already carries a real-looking `name`, book_trial uses it directly and goes straight to the confirmation message; only ask when the name is missing or junk (emojis/numbers/handles).
- [ ] ⚠️ Ad id `120249684011870518` (¡Agenda tu Día Gratis! / Reto Gladiador) was NOT matched to a campaign on 2026-08-03 (lead Ricardo) — add it to the Reto campaign's ad ids in /admin → Campañas so the canned first-reply + campaign info fire.

## 🟢 LIVE (2026-08-03) — read this first

**THE AGENT IS LIVE ON THE SALES NUMBER.** Full loop verified end-to-end on 2026-08-03: lead messages +52 1 56 4199 2274 → worker → Claude brain → Slack #wa-leads card (campaign attribution working, real ad lead captured same day) → Aprobar → reply delivered. TRAINING_WHEELS=1 (every reply needs approval).

### Current number topology (changed a LOT on 2026-08-03 — trust this, not older sections)

- **SALES (bot): +52 1 56 4199 2274** — phone-number-id **`1298937523303215`**, on WABA **1717538906028335** ("MD Self Defense Condesa", created 2026-09-11 by us, currency MXN, card MASTERCARD *5385 attached, app 2215578122600171 subscribed, no partner). Migrated 2026-09-11 from WABA 1582515279931864 / phone-number-id 1159187097288000 (ManyChat's first-attempt WABA with the shared credit line — now empty of live numbers; leave it, do not delete). Pure Cloud API number — NOT in any phone app, and cannot be put back in one without deregistering (coexistence re-entry has a 1–2 month cooldown). Two-step PIN: **152683**. Registered + verified 2026-08-03. Display name "MD Self Defense Condesa" (was in review at go-live; sends worked anyway).
- **SUPPORT (humans): +52 55 3426 0813** — on the academy phone in WA Business app. Was BANNED ~2026-07-28 (bulk group-adds — NEVER bulk-add to groups, invite links only); appeal WON same day. Its Cloud API registration dropped during the ban and it is now SMB-classified (app-linked) → API sends give #133010 and /register is blocked ("SMB businesses"). It stays human-only until/unless we build embedded-signup coexistence (phase 2, maybe never).
- **DEAD/DEBRIS:** WABA 890463570149597 (coexistence WABA from the eSIM ManyChat era) was DESTROYED when the app account was deleted — its phone-number-id 1208573689006666 is gone; +52 1 55 4132 7197 (first abandoned eSIM) sits Offline on WABA 1582515279931864; WABA 1895136994223683 holds unknown unverified number +52 1 55 2497 9988. Old real WABA 2227852814309146 holds only the banned-then-unbanned 0813.

### How we got here (2026-08-03, the cutover saga — lessons inline)

1. Meta App Review APPROVED (all three permissions Advanced Access). Access Verification had approved earlier.
2. Removing ManyChat as WABA **partner** (Partners tab) was required even after their disconnect — leftover partner grant caused #200 on sends while management calls worked.
3. Coexistence numbers CANNOT be API-registered (`Register endpoint is not available for SMB businesses`). Meta's documented escape: delete the account in the phone app, then /register. **BUT deleting the app account also destroyed the coexistence-created WABA** — the number came off Meta entirely and had to be re-added (SMS verify) to another WABA. Cost: ~2.5 weeks of app chat history on the eSIM number.
4. "Add phone number" was greyed out on WABA 2227852814309146 (likely due to the banned number on it) — used WABA 1582515279931864 instead, which worked fine.
5. Brain `api_error` at first live test = Anthropic credits ran out. Topped up; consider auto-reload — this failure is silent except for fallback holding-line replies.

### ManyChat is GONE (2026-08-03)

Disconnected + removed as partner. Before disconnecting we exported all contacts: **~6,019 WhatsApp contacts (name, phone, subscribed date) in `~/Downloads/manychat-master.csv`** + Google Sheet "ManyChat Export". Tags were NOT exportable (ManyChat has no bulk tag export; API phone-lookup can't see WhatsApp IDs). Blast idea parked — if revived: needs approved marketing template + payment method + throttled sender (not built).

### Dashboard inbox v1 (shipped 2026-08-03, same day as go-live)

The /admin Chats view is now a WhatsApp-style live inbox — the human reply surface for the API-only sales number: 5s polling, real scroll pane, composer (staff replies log as `direction:"out_human"` with `meta.by`), inline pending-draft cards (Aprobar/Editar/Descartar in-chat), unread dots + tab badge + title flash + beep (mute 🔔/🔕), per-chat assignment (Asignarme/Liberar + Míos/Sin asignar filters), read-marks to the lead (blue ticks) on open. **A staff reply pauses the bot on that conversation INDEFINITELY (1-year override) until ▶ Reanudar** — amber banner shows in-chat (Evan's decision). Sends are idempotent (client token claimed in kv pre-send; 24h-window closed → composer disabled with hint).

**Per-user accounts:** login now takes usuario+contraseña. `admin_users` table (PBKDF2-SHA256 100k), cookie v2 carries the username (old sessions force one re-login). Master `ADMIN_PASSWORD` = permanent break-glass, logs in as evan/owner only (cannot impersonate staff). Owner-only Usuarios view (Inicio → 👥 card): create fer/vale, reset passwords, disable. Dashboard approvals post attribution notes to Slack ("por <user> desde el panel").

- [ ] ⚠️ **D1 migration (inbox v1)** — Evan pastes in D1 console (also mirrored at the end of schema.sql). Until it runs: only evan (master password) can log in, assignment is a silent no-op, everything else works:
```sql
CREATE TABLE IF NOT EXISTS admin_users(
  username TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  pass_salt TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_phone_ts ON messages(phone, ts);
ALTER TABLE contacts ADD COLUMN assigned_to TEXT;
```
- [ ] After migration: Inicio → Usuarios → create `fer` + `vale`; they log in on their phones.
**R2 shipped (2026-08-03, same day):** media + ad-context.
- Inbound image/video/document/sticker now parsed + stored (caption = body, else placeholder; `meta {type, mediaId, mimeType, filename}`) and rendered in the chat (img inline, video/audio players, 📄 doc link) via the auth-gated proxy `GET /admin/api/media/:id` (Graph 2-hop, streamed). Voice notes keep the transcript AND are playable.
- **Ad context is visible**: each inbound that carried a CTWA referral shows "📣 Respondió a un anuncio: <headline>" (+ creative thumbnail when Meta sends one) on the bubble (`meta.adRef`), and the chat header shows the contact's original attribution card ("📣 Llegó por el anuncio…", `contacts.ad_ref`, now also storing thumbnailUrl). So "quiero más información" from a kids ad is identifiable at a glance.
- 📎 attach in the composer: jpg/png/webp, mp4, pdf (≤16MB) → `POST .../send-media` (multipart) → Graph /media upload → send; same idempotency token + indefinite-pause takeover as text sends; logs `out_human` with `meta.by`.
- R3 next (✓✓ ticks via status webhooks + template picker once templates/payment exist). Plan: ~/.claude/plans/i-want-to-go-ancient-milner.md

### Open items (post-go-live)

- [x] ~~Payment method on WABA 1582515279931864~~ — superseded 2026-09-11: 2274 now lives on WABA 1717538906028335, which has the card.
- [ ] ⚠️ **Submit templates** (docs/template-submission.md) under WABA **1717538906028335** (templates are WABA-scoped; the pack was never submitted on the old WABA).
- [ ] CTWA repoint to 2274 (2026-08-04, see section at top): most ad sets repointed + re-live; **verify every remaining active ad set's WhatsApp number** (at least one legacy ad set was stuck on the connect wizard — toggle destination or rebuild; a rebuild's new ad IDs must be appended in /admin → Campañas).
- [ ] Anthropic auto-reload ON (avoid silent brain outage).
- [ ] Watch display-name review status for 2274; watch quality rating (starts UNKNOWN).
- [ ] Old contact backfill: manychat-master.csv → Airtable (leads 7/16–8/03 missing from CRM).
- [ ] Phase 2 backlog: two-number send routing, support bot on 0813 (needs coexistence build), ~~IG/FB DM adapter~~ (shipped dark 2026-08-04, see top), EN templates.
- [ ] Old-number spam-ban lesson is now a standing team rule: **never bulk-add students to WhatsApp groups; invite links/QR only.**

## ⚡ PREVIOUS SITUATION (2026-07-18) — historical, superseded above

**App Review SUBMITTED** (2026-07-15) for `whatsapp_business_messaging` + `whatsapp_business_management` + `public_profile` on app 2215578122600171. Both required videos attached (msg-send via API + template creation in WhatsApp Manager), API test calls show **Completed**, own-business reviewer note included. Status: **In review** — Meta quotes "most within 20 days" but clean own-business submissions usually land in 1–5 business days. Business Support ticket filed in parallel (WABA 2227852814309146, own-business #200, expedite request).

**ManyChat involuntarily disconnected from the real number** (2026-07-18). When we subscribed our app to the real WABA, ManyChat's link to +52 55 3426 0813 broke and **will not reconnect** — its onboarding wizard throws `#2388002 "failed to check phone number eligibility"` because the number is already registered to the Cloud API under our WABA with our app subscribed. The number itself is **healthy**: WABA 2227852814309146, status Connected, quality rating back to **High**. So: we still RECEIVE every lead (worker webhooks → Slack + Airtable, name + campaign captured), but neither ManyChat nor our app can SEND until App Review lands. Effectively the receive-side cutover happened early; only send permission is missing.

### New TWO-NUMBER architecture (decided 2026-07-18)

Turning the disruption into the sales/support split Evan already wanted (~100 sales convos/day were drowning student-support messages like "left my gloves at the academy"):

- **NEW number = permanent SALES number.** Onboard a genuinely fresh MX number (new SIM/eSIM/virtual, never had WhatsApp recently) into **ManyChat** now → restores sales coverage in ~1 day (fresh onboarding has no eligibility conflict). Point all active CTWA ad campaigns at this new number (per-campaign in Ads Manager; **ad IDs stay the same**, so worker campaign-matching keeps working post-cutover untouched). When App Review lands, cut the NEW number over to the worker (add to a WABA we control → subscribe our app → set `WA_PHONE_NUMBER_ID`). ManyChat's role ends there.
- **OLD number (+52 55 3426 0813) = STUDENT SUPPORT number.** Already registered under our WABA with our app receiving webhooks; existing students already have it saved = perfect support audience. Bot can answer support there in phase 2, or staff handles it.

End-state: sales + support separated at the number level, both eventually on the worker. Two-number *send* support in the worker is a modest phase-2 code change (today it handles one send number via `WA_PHONE_NUMBER_ID`).

**Caveats logged:** (1) ManyChat leads on the new number won't flow into our Airtable/Slack pipeline until cutover (same as old ManyChat days; backfill later or rewire MC's own Airtable push). (2) In-flight leads on the old number keep replying there — cover manually for a few days, volume decays fast once ads move. (3) Do NOT touch the old number registration or app 2215578122600171 while App Review is in flight. (4) Keep review pressure on: update support ticket noting the business number has no automated-reply capability (operational-impact tickets get escalated).

## Where we are

**LIVE end-to-end on the Meta TEST number** (+1 555 089 6235), verified with 3 test recipient numbers. Full loop works: WhatsApp → worker → Claude brain → Slack #wa-leads approval card → Aprobar/Editar → reply + booking video land on the lead's phone. TRAINING_WHEELS=1 (every reply needs approval). The REAL leads number (+52 55 3426 0813) still runs ManyChat via coexistence — cutover is the final step (docs/cutover-runbook.md).

Everything shipped: brain + KB, Slack approvals, admin dashboard (/admin), anti-no-show sequence, lead-nudge drips (day-1 + extended 7-touch per program), quiet hours 21:30–08:00, booking video, ad attribution, voice-note transcription, Airtable lead-sync + natural-language rules engine, campaign inline editing, KB rewrite (Evan's copy, 2026-07-07/08: positioning, all programs, Curso de Verano, Reto Gladiador, two-step price deflection → range only, horarios phrasing).

Recent fixes (2026-07-08/09): stale pending approvals auto-supersede when the lead keeps writing (kills duplicate holding lines); Slack **Editar** no longer turns spaces into `+` (form-encoding decode); Editor chat no longer 500s pre-migration.

**Shipped 2026-07-11 (phase-1 ManyChat parity):**
- **Campaign first-reply** (new gate 5c): a brand-new ad lead whose message matches a campaign with `first_reply` set gets the pre-written welcome instantly — no brain, no approval; ⚡ FYI note in Slack; nudge drip arms off it; AI takes over from the lead's next message. Editable per campaign in /admin → Campañas ("Respuesta automática"). Requires the migration below; code fail-softs until it runs.
- **Multi-ad-id campaigns**: `campaigns.ad_id` now accepts a comma-separated list (one concept = many live Meta ads).
- **Opt-out hardening**: broader exact-match set (baja/stop/alto/unsubscribe + "ya no me manden mensajes" variants, accent/punctuation-tolerant, src/pipeline/opt-out.ts), 🚫 Slack note, and best-effort `Tags += "Baja"` on the Airtable lead.
- **Template submission pack**: docs/template-submission.md — copy-paste doc for Evan to submit all 24 templates in WhatsApp Manager.
- **First-reply RE-send on ad re-click** (Evan request, same day): a known lead who clicks an ad again (inbound carries a referral) and has no trial booked gets the same campaign welcome again, at most once per 24h (`kvClaimIfAbsentOrOlder` cooldown claim). Typing trigger-like text mid-chat never re-welcomes. Slack note: 🔁.
- **🧹 Reiniciar (prueba)** button in Chats detail: wipes messages/followups/approvals/kv claims + resets the contact so a test phone acts like a brand-new lead (POST /admin/api/conversations/:phone/reset).
- The 4 campaigns are LOADED in /admin with welcomes + ad ids (curso de verano ends 14-ago; BFC active but ad-less, ads paused on purpose).

## Evan's pending setup (blockers marked ⚠️)

- [x] D1 migration: `airtable_rules` table + `contacts.airtable_lead_id` (ran 2026-07-09)
- [x] **AIRTABLE_PAT secret** — set on the worker (confirmed 2026-07-11). If Airtable writes ever fail, verify the token still has scopes `data.records:read`, `data.records:write`, `schema.bases:read` on base `appcX38TBVltyxHR6`.
- [x] Airtable field mapping (2026-07-09): the bot now writes Evan's REAL Spanish CRM columns (`# de Teléfono`, `Nombre de Lead`, `Fecha Clase Prueba`, `Actividad`, `Programa`, `Canal`="WA", `Campaña`, `Ad`, `Resultado Clase Prueba`, `Tags`) via `airtableLeads` map in clients/md-condesa/client.mjs. Phone lookup matches last-10-digits regardless of stored format. No English fields needed.
- [ ] ⚠️ **D1 migration for campaign first replies**: `ALTER TABLE campaigns ADD COLUMN first_reply TEXT;` — until it runs, saved first replies are silently dropped (soft-fail) and gate 5c never fires.
- [ ] Earlier D1 migrations if not yet run: `ALTER TABLE contacts ADD COLUMN ad_ref TEXT; ALTER TABLE campaigns ADD COLUMN ad_id TEXT;` + dashboard tables (docs/phase0-checklist.md Step 6c).
- [ ] Create the 4 campaigns in /admin → Campañas (Curso de Verano, Baby Fight Club, Kids, Reto) with trigger phrase, ad id(s), info, and first reply. Active Meta ad ids pulled 2026-07-11: Curso de Verano = 120248879929990518, 120248879930930518, 120248879925940518, 120248879928990518; Kids = 120245400639450518, 120245400692660518, 120245396039730518, 120245400408310518, 120245400081370518, 120245400540790518, 120245197707210518, 120245198063240518, 120245197395390518, 120244434754400518; Reto = 120244947083620518, 120244434043620518, 120244433794140518. **Baby Fight Club has NO active ads right now** — confirm with Evan. Prefilled phrases must come from Ads Manager (not exposed via API).
- [ ] Confirm WA_ACCESS_TOKEN is the permanent System User token (temp tokens 401 after ~24h).
- [ ] Submit WhatsApp templates (docs/template-submission.md — 24 copy-paste-ready; source docs/templates.md) — Evan chose to do this NOW, pre-cutover, so d2–d5 drips work from day one.
- [ ] ⚠️ **Blocked on Meta App Review** — SUBMITTED 2026-07-15 (see CURRENT SITUATION at top). Root cause was `whatsapp_business_messaging` at **Standard access**; new apps must pass App Review for production sends even for their own business. Proof on record: identical token sends fine via TEST number (`1208228772369686`), fails via real one (`919322911268999`) with `(#200) permissions on behalf of this WABA`. Token verified clean (System User waagentsystem, messaging+management, granular = all objects, never expires). `WA_PHONE_NUMBER_ID` is set in the **Cloudflare dashboard** (Settings → Variables), NOT wrangler.jsonc — currently = real number id `919322911268999`; takes effect on next request, no redeploy. Ignore duplicate app id 1327983355704061 (empty shell).
- [ ] **Onboard NEW sales number into ManyChat + repoint ads** (two-number plan, see top) — restores sales coverage while App Review pends. Fresh number only.
- [ ] After approval: cut the NEW sales number over to the worker (add to controlled WABA → subscribe app → set `WA_PHONE_NUMBER_ID`). NOTE: add own payment method to the WABA before relying on template sends (was ManyChat's credit line).
- [ ] Phase-2 code: two-number *send* support in the worker (sales vs. student-support routing); old number +52 55 3426 0813 becomes the support line.

## Known bugs / next work

1. ~~trial_confirm mis-timed for web-form bookers~~ **FIXED 2026-07-09**: `computeTrialSequence` now fires trial_confirm at booking-detection time (clamped to the send window) instead of at class time; chat bookings pass `includeConfirm: false` since the bot confirms inline (src/cron/followups.ts, src/pipeline/inbound.ts).
2. Meta test-number quirk (not a code bug): outbound to non-verified recipients fails; Mexico numbers may need the `521…` form in the allowlist. Disappears on the real number.
3. Tune the brain weekly from Slack Editar diffs while training wheels are on (edits are logged to D1 `edits`).

## Key IDs

- Worker: md-condesa-wa-agent (account: evancaguilar — local wrangler CLI is logged into the WRONG account)
- D1: wa-agent-db `c57b17de-9e0c-4a48-adc7-7cb791372cdc`
- Slack channel #wa-leads `C0BFKQ6AU9F` · Airtable base `appcX38TBVltyxHR6` / table `Leads`
- Meta test number ID `1208228772369686`, WABA `1545530463899885`; real leads number +52 55 3426 0813
