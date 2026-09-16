# Bulk sends (blasts) — how it works and how to use it

Owner guide (English). Built 2026-09-16 on top of the Aug-28 one-off sender.
Code: `src/services/blast.ts` (pure planning + registry), `src/services/blast-templates.ts`
(Meta template catalog), `src/cron/blasts.ts` (the drain), `src/routes/admin-api.ts`
(`/admin/api/blast/*`), dashboard tab **Envíos** (owner only).

**In one sentence:** you pick an APPROVED marketing template, choose an audience
(CRM leads or a pasted phone list), preview, test on your own phone, confirm —
and the cron sends it in small paced batches inside 09:00–21:00 CDMX under a
daily cap, pausing itself and telling Slack if Meta rejects the template.

Nothing sends on its own. Queueing needs an owner login **and** the confirm
checkbox; the code refuses to queue a template Meta has not approved.

## 1. Prerequisites (one-time)

1. **Templates approved on the live WABA** (`1717538906028335`). Templates are
   WABA-scoped: anything approved on the old ManyChat WABA does not exist here
   (that is the `[132001] Template name does not exist` error you see in Slack
   today). Submit them in WhatsApp Manager → Account tools → Message templates.
   Guidance for blast templates is in `docs/templates.md` → "Blast templates".
2. **`WA_WABA_ID` var** is set in wrangler.jsonc (already `1717538906028335`).
   It lets the tab list your templates and check their status. If it is wrong
   or the token lacks `whatsapp_business_management`, the tab still works in
   manual mode (you type the exact name + language and the check is skipped).
3. **Payment method on the WABA** — done (Mastercard *5385). Marketing templates
   are paid per conversation (MX ≈ US$0.04–0.05 marketing, US$0.0115 utility).

## 2. Sending a blast (dashboard → Envíos)

1. **Plantilla** — the dropdown shows every template on the WABA sorted APPROVED
   first; PENDING/REJECTED are visible but disabled. Selecting one shows the
   body, footer and buttons and creates one input per `{{n}}` body variable.
   Write `{nombre}` in a variable to insert the contact's first name (falls back
   to 👋 when the name is unknown or junk, since Meta rejects empty params). A
   template with an IMAGE/VIDEO/DOCUMENT header needs the https link of the file.
2. **Audiencia** — two sources:
   - **Leads del CRM**: D1 contacts with status `lead`, created/active since a
     date, split by program (adults / kids / baby) from their campaign or
     qualification. By default excludes leads who already booked a trial, leads
     whose 24h window is open (they get free-form replies, not paid templates),
     students and opted-out contacts.
   - **Lista pegada**: one contact per line, `phone, name` or `name, phone` (a
     CSV export pastes fine; the ManyChat export in ~/Downloads works). Phones
     are normalized to the 521… shape; duplicates and header rows are dropped;
     opted-out contacts are always excluded, current students by default.
   - Both: **no repeat** to anyone who got a blast in the last N days (default
     7) and an optional **máximo** (freshest first).
3. **Vista previa** — counts, exclusions and a 10-contact sample. Required
   before queueing (the confirm checkbox shows the number).
4. **Prueba** — one real send to the phone you type (any phone, opt-out check
   bypassed on purpose). This is the moment Meta tells you if the name,
   language code, variable count or header link are wrong.
5. **Programar** — start time (empty = next tick inside the window) and the
   daily cap (default 250 = Meta's starting tier for a new WABA; it auto-grows
   to 1K/10K/100K with quality — raise the cap only after Meta raises yours).
6. Tick **Confirmo…** → **Poner en cola**. Slack gets a note; the run appears
   at the top with a progress bar and ⏸ Pausar / ▶ Reanudar / ⛔ Cancelar.

## 3. What the cron does with it

- Every 5-min tick, `runBlastBatch` sends up to **6** queued rows (kv
  `blast_per_tick`, 1–10, if you ever want to change it) — ~70/hour, ~860 in a
  full 09:00–21:00 day, so the daily cap is the real limit.
- Each row is **claimed before the Graph call** (status `sent`), so a tick that
  dies mid-batch never double-sends.
- Per-recipient errors (not a WhatsApp user, marketing limit for that user,
  undeliverable) → row `failed` with the error text (visible under "Ver fallos"),
  the run continues.
- Rate limits (throughput / spam-rate) → the row stays queued with an attempt
  count, the tick stops; three attempts → `failed`.
- Template/account errors (template missing, unapproved, paused, parameter
  mismatch, media link broken, payment issue, auth) → the **run pauses**, the
  remaining rows freeze, Slack gets one note with the error. Fix the cause and
  press ▶ Reanudar.
- A lead who replies **BAJA** at any point is opted out by the inbound pipeline
  and every queued row for them is skipped (`skipped_optout`).
- When the last row goes out, Slack gets a completion note with the totals.

## 4. Where the state lives (no D1 migration)

- Recipients = `followups` rows, `kind='blast'`, `airtable_record_id='blast:<runId>'`
  (UNIQUE per phone+run), `note` = JSON payload {t,l,v,h,nm,err,a}. Statuses:
  `scheduled` → `sent` | `failed` | `skipped_optout` | `paused` | `cancelled`.
- Run = kv `blast_run:<runId>` (JSON: name, template, params, total, status,
  cap, who, pausedReason). Counts are computed from the rows.
- kv `blast_sent:<YYYY-MM-DD>` = sends today (all runs), kv `blast_per_tick`.

## 5. API (owner session)

| Call | What |
|---|---|
| `GET /admin/api/blast/templates` | WABA template catalog (name, language, status, category, body, variables, header, buttons). |
| `GET /admin/api/blast/runs` | Runs with progress + today's count + window state. |
| `POST /admin/api/blast/runs/:id/pause` · `/resume` · `/cancel` | Run controls (Slack note each). |
| `GET /admin/api/blast/runs/:id/failures` | Failed rows with the error text. |
| `POST /admin/api/blast/preview {audience}` | Counts + samples, no sends. |
| `POST /admin/api/blast/test {phone, template, lang, params[], header?, name?}` | One real send. |
| `POST /admin/api/blast/queue {confirm:true, name, template:{name,lang,params,header?}, audience, startAt?, dailyCap?}` | Queue a run. `skipCheck:true` bypasses the Meta catalog check. |

`audience`: `{source:"crm", since, groups:["adults","kids","baby"], includeBooked, excludeBlastedDays, limit}`
or `{source:"list", list:"<pasted text>", excludeStudents, excludeBlastedDays, limit}`.
`mode:"freeform"` with a top-level `text` sends free text to the CRM leads whose
24h window is OPEN instead (no template, no Meta charge) — API only.

## 6. Things that will bite

- **Language code must match exactly** what Meta shows (`es` vs `es_MX`). The
  catalog dropdown carries it; in manual mode you type it.
- **Quality rating**: a wave of blocks/reports drops the WABA's rating and Meta
  cuts the messaging limit or pauses the template. Start small (a few hundred),
  watch the failure list and the Slack notes, then scale. The support number
  was banned once for bulk behaviour — the sales number is the whole funnel.
- The **ManyChat export has no opt-in on this WABA**; many of those 6k contacts
  never wrote to 2274. Meta allows marketing templates to opted-in users; use
  that list with care and prefer recent leads.
- Cloudflare's free-plan subrequest cap is why batches are small. Raising
  `blast_per_tick` above ~8 risks "Too many subrequests" on busy ticks (the
  row is already claimed, so nothing double-sends; the tick just ends early).
