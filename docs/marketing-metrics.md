# Marketing metrics — how it works and how to use it

Owner guide (English). Built 2026-09-09. Spec history: `~/.claude/plans/please-walk-me-through-cryptic-crab.md`.

**In one sentence:** Airtable is the source of truth and does the math (links + rollups + formulas); the always-on Cloudflare worker feeds it (daily Meta spend rows, lead↔ad/day/month links, student↔lead links) and posts a daily Slack brief with exceptions. Nothing here touches D1 (state is kv), and the booking/reply pipeline is untouched.

## 1. What you get

| Where | What |
|---|---|
| Airtable `Meses` | one row per month of lead creation: spend, leads, CPL, cost per booking / show / close, show rate, close rate, revenue, ROAS (lifetime and 90-day). `Es Mes Actual` = 1 on the current month, `Provisional` = 1 while the month is younger than 45 days. |
| Airtable `Días` | the same per day (for trend charts and the Slack brief). |
| Airtable `Anuncios Meta` | the same per Meta ad (creative-level ROAS). `Sin Gasto` = 1 flags ads with leads but no imported spend. |
| Airtable `Campañas Meta` | the same per Meta campaign. |
| Airtable `Ad Spend Diario` | raw Meta spend, one row per ad per day (the fact table). Do not edit by hand: the next import overwrites. |
| Slack `#wa-leads`, 08:00 CDMX | *Marketing funnel* brief: yesterday, month to date, exceptions, last spend sync. |
| Interface `📊 Dashboard General` | pages **📣 Marketing** (current month, trend, by campaign, by ad) and **⚠️ Excepciones** (closes with unknown origin, trials without a result, paid students without a lead, income without student / concept). |

Every number in Meses/Días/Anuncios/Campañas is an Airtable rollup or formula, so it updates the moment staff mark a result or a payment lands. Click any count to drill into the actual leads.

## 2. Measurement rules (cohort = the day/month the lead was created, CDMX)

| Metric | Definition |
|---|---|
| Leads | Leads rows created in the period. `Origen` on each lead: **Pagado** (arrived through an ad — `Ad` carries a Meta ad id — or `Adquisición` = Pagado), **Orgánico** (`Adquisición`/`Canal` say so), **Desconocido** (no evidence). **Staff knob:** setting `Adquisición` on a lead fixes its origin by hand. |
| CPL | Gasto / Leads Pagados. Meta's own "conversaciones iniciadas" sits next to it as a sanity check. |
| Booked (`Agendó`) | the lead has a `Fecha Clase Prueba` (unique lead, not attempts). |
| Show rate | `Asistieron` / `Pruebas Vencidas` — only trials whose date already passed count; `Pendientes` shows past trials nobody marked yet. `Asistió` = `Resultado Clase Prueba` contains "Asistió" or "Se inscribió". |
| Closed (`Cerró`, strict) | eligible income > 0 through Lead → Alumnos → Movimientos. Marking "Se inscribió" without a payment does **not** count here (it shows as `Inscritos (marcados)`). |
| Close rate | `Cerraron Tras Prueba` (closed AND attended) / `Asistieron`. `Cierres Directos` (closed without attending a trial) is shown separately. |
| Cost per booking / show / close | Gasto / the paid-lead count of that stage (`… Pagados` rollups). Cost per close is ad-only CAC (no staff cost). |
| Eligible income | Movimientos linked to the student with `Ingreso/Egreso = Ingreso` and `Concepto ≠ Sobrante`; an `Egreso` linked to a student subtracts (refunds, if you ever record them that way). |
| ROAS | `Ingresos Pagados` (lifetime) / Gasto. **ROAS 90d** counts only payments made within 90 days of the lead date — use it to compare months. |
| Rates | always computed from totals (rollups), never averaged percentages. |

Attribution is first-touch (`Ad` on the lead is fill-if-empty). Households: one lead can link several Alumnos (kids); revenue sums, the lead counts once, `Alumnos Inscritos` shows the student count.

Airtable formula fields come out as plain decimals (0.55). To display them as 55 %, open the field settings in Airtable and set the formatting to percent — a one-time click per field; the worker's brief already formats.

## 3. Your workflow (unchanged) and what feeds the numbers

- **Staff keep marking** `Fecha Clase Prueba` and `Resultado Clase Prueba` in Airtable exactly as today. Nothing else to do for bookings/shows.
- **Enrollments:** mark "Se inscribió" (and `Pago Inicial`) as today. The consolidated automation creates the Alumno linked to the lead AND, when `Pago Inicial` > 450, the Movimiento linked **by record id** to that same Alumno. Payments from Stripe / Mercado Pago keep arriving through md-reconciliation.
- **The worker does the rest:** spend import at 05:30, link sweeps every 15 minutes, brief at 08:00.

## 4. The attribution bug that was fixed (and the one-time repair)

Before 2026-09-09 two automations raced on "Se inscribió": one created the Alumno with `Lead Original`, the other ("Auto create payment") created the Movimiento with the student link filled from the lead's **name text**, which often created a second, phone-less Alumno with no lead. Since July: 64 paid students linked to a lead, 42 not linked. ROAS through the lead chain would have missed ~40 % of paid students.

Fix shipped in three parts:
1. **Consolidated automation** (draft on "Se inscribió", wflEwWirVlvaGQrDB): the payment step is now a conditional inside the same automation, linked by id. **You publish it** (open the automation → *Update*) and then **turn "Auto create payment" (wflFnQPACpCrB8i65) OFF** — same moment, or you get double payments / none.
2. **Duplicate relink (one-time, non-destructive):** `POST /admin/api/metrics/relink-students {"dryRun":true}` lists phone-less, unlinked, paid students whose same-named twin (linked to a lead) was created within 120 s. Review the list, then `{"dryRun":false}` sets `Lead Original` on them. Nothing is deleted; both records stay.
3. **Student↔lead sweep (ongoing):** every 15 min, students created since 2026-07-01 with a phone and no `Lead Original` get linked when **exactly one** lead matches by phone (last 10 digits) and predates them. Ambiguous ones stay in the Excepciones page.

## 5. Schedule, state and safety

| When (CDMX) | Job | Notes |
|---|---|---|
| ticks at minute 5–14, 20–29, 35–44, 50–59 | `leadLinkSweep` (≤40), `studentLinkSweep` (≤5) | links leads → Día/Mes/Anuncio and students → Lead. No cursor: linked rows drop out of the filter, so a failed tick just retries. |
| same ticks | `adSpendBackfill` | one 2-day chunk from `METRICS_SINCE` (2026-07-01) to yesterday (≈35 ticks ≈ 3 h), then kv `ad_spend_backfill_done` + a Slack note. Skipped on the tick that runs the daily pull. |
| 05:35–06:59 | `adSpendDaily` | re-pulls the last 3 days + today (Meta restates for ~72 h; upsert is idempotent). kv `ad_spend_mark` is set before the run, so a failure waits for tomorrow, whose window covers the gap. |
| 08:00 | `metricsBrief` | reads yesterday's `Días` row + the month's `Meses` row, posts to Slack. kv `metrics_brief_mark`. |

kv keys: `ad_spend_mark`, `ad_spend_last_ok`, `ad_spend_last_error`, `ad_spend_currency`, `ad_spend_backfill_cursor`, `ad_spend_backfill_done`, `metrics_brief_mark`, `metrics_link_last_ok`, `metrics_link_error`, `metrics_link_note:<day>`.

**Why the small batches:** Cloudflare caps *subrequests* per invocation (50 on this plan) and every Airtable, Graph or Slack call is one. The metrics work therefore runs on the cron ticks the booking sync does not use and each job is sized to ~10–15 requests; the admin endpoints have the same caps (loop them). This is also why a manual sweep of 300 leads + students failed with "Too many subrequests" on 2026-09-09.

Safety: everything is gated by `features.marketingMetrics` (clients/md-condesa/client.mjs) **and** the `META_AD_ACCOUNT_ID` var; every job runs inside the cron's `safe()` so a failure never touches replies or bookings. Airtable writes are batched (10) and paced (~3 rps) to stay under the 5 rps per-base limit shared with the live lead sync. A renamed Airtable column stops the affected job, stores kv `metrics_link_error` / `ad_spend_last_error` and posts ONE Slack note per day — fix the base (or the names in `airtableMetrics` in client.mjs) and it resumes by itself.

## 6. Admin endpoints (owner login, `/admin`)

| Call | What |
|---|---|
| `GET /admin/api/metrics/probe` | token source, ad account (name, currency, timezone), a one-day insights pull, and all kv state. **Run this first**; a permission error means: paste the creative-flywheel system-user token (your shell's `META_ACCESS_TOKEN`) as the encrypted secret `ADS_ACCESS_TOKEN` in Cloudflare → Workers → md-condesa-wa-agent → Settings → Variables, then re-probe. |
| `POST /admin/api/metrics/pull {"since":"2026-09-05","until":"2026-09-08"}` | import a window now (≤ 4 days per call). Run it twice: the second run reports `created: 0`. |
| `POST /admin/api/metrics/sweep {"target":"leads","limit":100}` | link up to 100 leads now (`target:"students"` → up to 10 students). Loop until `linked: 0`. |
| `POST /admin/api/metrics/relink-students {"dryRun":true}` | duplicate-student repair (see §4). |
| `POST /admin/api/metrics/brief` | post the Slack brief now; returns the text. |

From your logged-in browser tab on the worker origin (DevTools console), e.g.:

```js
await (await fetch("/admin/api/metrics/probe", { credentials: "include" })).json()
```

Backfill loop (links every lead since July in ~25 calls; the cron does the same on its own in a few hours):

```js
for (let i = 0; i < 40; i++) {
  const r = await (await fetch("/admin/api/metrics/sweep", { method: "POST", credentials: "include",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "leads", limit: 100 }) })).json();
  console.log(i, r.scanned, r.linked, r.errors);
  if (!r.ok || r.linked === 0) break;
}
```

## 7. Airtable field dictionary (what the worker writes / reads)

- **Leads** (new): `Ad ID`, `Día Lead`, `Mes Lead`, `Origen`, `Es Lead Pagado`, `Es Desconocido`, `Agendó`, `Prueba Vencida`, `Asistió`, `Asistencia Pendiente`, `Inscrito (marcado)`, `Alumnos Inscritos`, `Ingresos Lead`, `Ingresos Lead 90d`, `Cerró`, `Cerró Tras Prueba`, `Cierre Directo`, the `… Pagado` variants (formulas/rollups) and the three **links the worker writes**: `Día`, `Mes`, `Anuncio`.
- **Alumnos** (new): `Fecha Lead` (lookup), `Ingresos Elegibles`, `Ingresos Elegibles 90d` (rollups). The sweep writes `Lead Original`.
- **Movimientos** (new): `Ingreso Elegible`, `Fecha Lead (alumno)`, `Ingreso Elegible 90d`.
- **Ad Spend Diario** (worker-owned): `Clave` (upsert key `YYYY-MM-DD · <adId>`), `Fecha`, `Cuenta`, `Ad ID`, `Nombre Anuncio`, `Ad Set`, `Ad Set ID`, `Campaña Meta ID`, `Campaña Meta Nombre`, `Gasto`, `Impresiones`, `Clics`, `Alcance`, `Conversaciones (Meta)`, `Actualizado`, links `Anuncio`, `Campaña Meta`, `Día`, `Mes`.
- **Anuncios Meta / Campañas Meta / Días / Meses**: created automatically the first time something links to them (Airtable typecast on the primary field). Rollups: `Gasto`, `Impresiones`, `Clics`, `Conversaciones Meta`, `Total Leads`, `Leads Pagados`, `Desconocidos`, `Agendaron`, `Pruebas Vencidas`, `Asistieron`, `Pendientes`, `Cerraron`, `Cerraron Tras Prueba`, `Cierres Directos`, `Inscritos (marcados)`, `Ingresos`, `Ingresos 90d` (+ `… Pagados` on Días/Meses); formulas `CPL`, `Costo por Agendada`, `Costo por Asistencia`, `Costo por Cierre`, `Show Rate`, `Close Rate`, `Conversión Lead→Cierre`, `ROAS`, `ROAS 90d`.

All names live in `clients/md-condesa/client.mjs` → `airtableMetrics` (compiled into `src/client.gen.ts` by `npm run build`). Rename a column in Airtable → change the name there → build, commit, push. Never hand-edit `client.gen.ts`.

## 8. Reading the numbers well

- **Most paying leads since August have unknown origin.** They were created by hand (no channel, no ad) instead of marking the bot's lead row, so ROAS cannot credit an ad. Fix going forward: when someone enrolls, mark "Se inscribió" on the lead row that already exists for their phone (the bot's row carries the ad), or set `Adquisición` on the new row. The brief and the Excepciones page list "closes with unknown origin" for exactly this.

- **Read months, not days.** Shows and closes are attributed to the lead's arrival date, so a day looks bad for a week and a month is *provisional* for ~45 days.
- **Compare cohorts with ROAS 90d**, not lifetime ROAS (old months keep growing).
- **Pendientes > 0** means the show rate is not final — that is a staff to-do, not a marketing problem.
- **Meta conversations ≫ Leads Pagados** means leads are arriving without the ad referral (e.g. typed the number). The brief flags it when the gap exceeds 30 %.
- **Sin Gasto = 1 on an ad** with leads: the spend import does not cover its dates (older than 2026-07-01) or the ad was deleted.
- Leads before 2026-07-01 are not linked (ManyChat era, sparse ad ids). The `Ad spend` table and Leads' old `Amount Spent` / `ROAS` fields are superseded and untouched.

## 9. Deferred on purpose

Appointment-history table (Slots links cover bookings partially; KPIs count unique leads) · Slack Sí/No attendance write-back (you chose manual marking) · destructive merge of duplicate students (relink only) · 30/60-day and first-payment ROAS · fully loaded CAC (no staff/tool cost data) · /admin metrics tab · retiring the dead `com.evan.md-metrics` launchd job and `Metrics Diarias`.

## 10. Status log

- **2026-09-10:** Meta token set, spend backfilled from July 1 (1,373 rows). All leads since July linked; 3 students linked by phone; 3 duplicate students relinked. New **twin sweep** (`target:"twins"`, cursor kv `metrics_twin_cursor`, 8 leads/tick) copies the bot's ad onto same-phone form/manual rows — 61 repaired. Finding: August had 193 bookings / 26 enrollments but only 54 / 2 on ad rows; the website's embedded Airtable booking forms create ad-less rows. Next build: UTM `{{ad.id}}` on ads + hidden prefilled `Ad`/`Adquisición` on the forms (site repo). Pending Evan: publish "Se inscribió" automation + turn off "Auto create payment"; Omar García student → lead "Maro"; Leonardo Acosta lead → Adquisición Pagado.
- **2026-09-10 (site attribution):** shipped in the site repo (commit `65e52fd`): `js/attribution.js` remembers `utm_*`/`fbclid` for 7 days (first touch) and appends `prefill_Ad=utm (<utm_content>)`, `prefill_Adquisición=Pagado` (+ `hide_` params) to every embedded booking form; the four Airtable booking forms now carry `Ad` and `Adquisición` as hidden questions. `Ad` therefore has a third writer with the shape `utm (<ad id>)` — the `Ad ID` formula and the twin sweep's 13-digit test both accept it. **Finding:** Ads Manager has no link-click ads (all 22 campaigns optimize for messaging), so the ad-less form rows come from booking links sent in WhatsApp (bot or staff). Next: make the bot append `?utm_source=whatsapp&utm_content=<contact ad id>` to the booking URLs it sends (worker change, needs Evan's go). Done by Evan the same day: "Se inscribió" automation published + "Auto create payment" off; Omar García (bebe) → lead Maro; Leonardo Acosta Aug 4 → Adquisición Pagado.
- **2026-09-11 (bot booking links):** `src/services/booking-link.ts` (pure, unit-tested) appends `?utm_source=whatsapp&utm_content=<ad id>&utm_campaign=<D1 campaign>` to every booking/schedule URL the worker sends when the contact's `ad_ref` (or the inbound referral) carries an ad id: day-1 + extended nudges, no-show/welcome follow-ups, Messenger stand-ins, and the campaign `first_reply` text (bare known URLs are rewritten). No ad id → plain link, unchanged. The site's `attribution.js` then prefills `Ad`/`Adquisición` on the form. Airtable side already in place: Leads `Vio anuncio` (multi-select) + `WA Pregunta Origen` (tap-to-send wa.me), `Origen` honors `Vio anuncio` = Sí; Responsivas `Cómo nos encontraste` + `Vio anuncio redes`, propagated to the Lead by the "Responsiva recibida" automation (v3). The digital waiver (responsiva repo) now asks both questions (v1.4, pending deploy).
- **2026-09-24 (Google Ads on site forms):** site repo `e3158aa`..`51f0884` (live, `attribution.js?v=5`): a visit with `utm_source=google` or `gclid`/`gbraid`/`wbraid` goes to a separate Google slot (latest click) and never to the Meta slot; the form gets whichever slot's click is most recent. Google rows arrive with `Ad` = `google | kw: <utm_term> | ag: <utm_content> | camp: <utm_campaign> | gclid: <id>` (present parts only; Google ids are 10–12 digits, so `Ad ID` stays empty) and `Adquisición` = Pagado → `Origen` Pagado with no Meta ad/spend link. Both slots now expire after 90 days (Meta was 7). The twin sweep leaves Google rows alone (it only fills blank `Ad` and only copies 13-digit ids). Not yet counted: Google spend import, Google rollups.

## 11. Results log

### September 2026, snapshot taken 2026-09-21 (data through Sep 20)

**Owner's definition of ROAS (use this one):** Meta spend in the period versus sales to NEW sign-ups in that period whose lead came from an ad, including leads created in earlier months. Renewals of students who were already paying do not count. Computed by joining Movimientos → Alumnos → Leads and dropping any student with an eligible payment before the period. It is not an Airtable field yet.

| Window | Spend | New sign-up sales from ad leads | **ROAS (new sign-ups)** | For reference: all cash from ad leads, renewals included |
|---|---|---|---|---|
| Last 7 days (Sep 14–20) | $11,040 | $31,687 | **2.87** | $37,310 (3.38) |
| Last 14 days (Sep 7–20) | $21,198 | $35,583 | **1.68** | $54,737 (2.58) |
| Month to date (Sep 1–20) | $29,940 | $41,200 | **1.38** | $62,360 (2.08) |

Correction of an earlier reading the same day: $22,060 of September's cash from ad leads came from leads created before September. Checked payment by payment, $21,160 of it is renewals (13 students with payments going back to April–August, e.g. Victor Aparicio, Dante Monroy, Edwin Chi's weekly $499) and only $900 is first-time sign-ups (Ana Rene $500, Alexander Christiansen $400). The 2.08 / 2.58 / 3.38 figures therefore overstate ROAS under the owner's definition.

Funnel, month to date (paid leads only): 876 leads at $34 CPL → 160 booked (18 %) → 41 marked as attended → 14 closed (1.6 % of leads). Cost per close ≈ $2,139; first-payment revenue per close ≈ $2,879. Attendance is understated: past trials nobody marked still count as pending.

How to read it:
- **One day carries the week.** Sep 19 collected $27,195 in new sign-ups from ad leads (four multi-month prepayments of $3,740–$6,986 during the Independencia trimester promo). Without that day the 7-day figure is about 0.4. Judge ads on 14-day and monthly windows.
- **The number is a floor.** About $18,600 of September's new sign-up sales sit on leads with no origin recorded or marked Orgánico by channel only (Fred Rosa $5,499, Auzerais Bellamy $2,773, Alvaro Alarcon, Valentina, Jared Vargas, Emmanuel Romero, Stephen Baiardi, Giacome Peyron, Tomas Navarrete). If every one were an ad lead the month would read about 2.0. The waiver questions and `WA Pregunta Origen` exist to settle that.
- **Non-ad sources are real money.** Eight new students with no lead were traced by hand on Sep 21: Google Maps (Ezquerro $14,985, Reynaud $1,500, Segura $2,016), Google (Ghedia $7,499), Referido (Paullada $1,996), Reactivación (Barrera King $2,031), one unknown (Gutierrez Mendoza $499, student record says Instagram), and one Baby Fight Club ad (Enzo Fascio, linked to lead "Jacqueline Montiel", set to Pagado by owner decision: almost all BFC sign-ups come from ads; he has paid since July, so his September payment is a renewal).
- **Outlook (owner's goal: invest $100k, get $300–500k in new sign-up sales).** At today's funnel $100k buys roughly $140k of new sign-up sales, up to about $200k if the unknown-origin sign-ups are ads. 3x needs about twice the closes per lead or a higher first ticket; 5x needs both. The strong part is the close rate once someone attends (about one in three). The leaks are lead → booking (18 %) and booking → attendance. Multi-month prepayment promos move the number fast: Sep 19 alone shows it.

Data fixes made the same day: lead "Arturo D" (+52 55 2855 2298, ad 120249703090510518, closed by the WhatsApp agent) renamed to Arturo Tadeo Delgado Contreras, marked Se inscribió with Pago Inicial $999; the automation created the student and the Movimiento, which was then corrected to Sep 15, Transferencia (Mercado Pago), receipt 179171186008. Known gap: the "Se inscribió" automation skips the payment when staff mark the result before typing Pago Inicial (seen Sep 17 with Jose Ramos and Cesia Beltran); staff should fill Pago Inicial first.
