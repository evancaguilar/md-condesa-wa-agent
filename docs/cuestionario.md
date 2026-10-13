# Pre-trial questionnaire (cuestionario)

Every lead who books a trial class gets ONE WhatsApp message with a link to a
one-question-per-screen questionnaire on the site
(`https://mdcondesa.com/cuestionario/?t=<token>`, built in md-condesa-site).
The page talks to this Worker over CORS and the answers land on the lead's
EXISTING Airtable `Leads` record. The coach reads them before the class; the
day-before reminder quotes the lead's goal back to them.

Code: `src/services/cuestionario-token.ts` (token), `src/services/cuestionario-core.ts`
(pure: whitelists, CORS, sanitize, version, copy, Slack summary),
`src/services/cuestionario.ts` (Airtable + send + hooks), `src/routes/cuestionario.ts`
(public routes). Tests: `test/cuestionario.test.ts`. Copy: `clients/md-condesa/client.mjs`
`copy.cuestionario*` and `copy.reminderMotivo*`.

## Token

```
v1.<base64url(JSON {r:<recordId>, v:"adultos"|"kids"|"bfc", e:<unix exp sec>})>.<base64url(first 16 bytes of HMAC-SHA256(CUESTIONARIO_SECRET, "<payloadB64>"))>
```

- Expires 14 days after issue. Constant-time signature check, done BEFORE the
  expiry check (a forged token is always `invalid`, never `expired`).
- Bound to one record + one version. Rotating `CUESTIONARIO_SECRET` kills every
  outstanding link.

## Endpoints

| Method | Path | Auth | Result |
|---|---|---|---|
| `GET` | `/api/cuestionario?t=<token>` | token | `{version, nombre, hijo, dia, hora, trialIso, answers}` |
| `PATCH` | `/api/cuestionario?t=<token>` | token | body `{answers:{"<field>":value,…}}` (+ `"__complete": true`) → `{ok:true}` |
| `OPTIONS` | `/api/cuestionario` | — | CORS preflight (204) |
| `POST` | `/api/cuestionario/send` | `Authorization: Bearer <CUESTIONARIO_SEND_KEY>` | body `{recordId, version?, resend?}` → send result |
| `POST` | `/admin/api/cuestionario/send` | owner session | same, `resend` defaults to true (testing) |

- GET: `nombre` = greeting-safe first name (`greetingName`, "" when the CRM name
  isn't clearly a first name); `hijo` = `Nombre Del Niñ@` or null; `dia` e.g.
  "jueves 16 de octubre" and `hora` "7:00 PM" (CDMX), null when the record has
  no `Fecha Clase Prueba`; `answers` = the version's columns (plus
  `Cuestionario completado` / `… el`) with their current values, empties
  omitted. Never the phone or any other column.
- PATCH: only the version's answer columns (below); unknown keys are ignored
  (no 400). Strings trimmed + capped at 2000 chars, `""`/`null` clears; arrays
  of strings for multi-selects (`Motivos`, `Horarios preferidos` — a bare
  string is wrapped); numbers; booleans. `typecast: true` (new select options
  are created). `"__complete": true` (top level or inside `answers`) also sets
  `Cuestionario completado` = ✓ and `Cuestionario completado el` = today (CDMX).
  The browser can NEVER write `Cuestionario enviado`, `Cuestionario versión`,
  nor the two completion columns directly. A column that doesn't exist in
  Airtable yet is dropped and the PATCH retried (the rest still saves).
  Idempotent, last write wins.
- Errors: 401 `{error:"invalid"}`, 410 `{error:"expired"}`, 404
  `{error:"not_found"}` (record deleted), 429 `{error:"rate_limited"}` (120
  requests per token per clock hour, GET+PATCH, kv `cq_rl:<hour>:<sig>`,
  GC'd daily), 413 body > 64 KB, 400 bad JSON, 502 Airtable down, 503 when
  `CUESTIONARIO_SECRET` is unset.
- CORS origins: `https://mdcondesa.com`, `https://www.mdcondesa.com`,
  `https://<anything>.md-condesa-site.pages.dev` (one label), and
  `http://localhost:4173`. Methods GET, PATCH, OPTIONS; header content-type.
- First completion (record wasn't already completed) → 4-line summary in
  #wa-leads (`SLACK_CHANNEL_ID`): name · program · class day/time · phone, then
  `Motivo principal`, `Costo de seguir así` (adultos) or `Meta 6 meses`
  (kids/bfc), and `Lesiones / cuidados`.

## When the link is sent

`sendCuestionario(env, deps, {recordId, version?, resend?, phone?})` — reads the
record, derives the version when not given (`Programa`: Adultos → adultos;
Kids / Mini Muay Thai / Teens → kids; Baby Fight Club → bfc; then `Actividad`
kid/baby options; then the contact's stored age band; else adultos), skips when
`Cuestionario enviado` is set (or the kv marker `cuestionario_sent:<rec>`)
unless `resend`, sends ONE free-form WhatsApp text, then stamps
`Cuestionario enviado` = today (CDMX) and `Cuestionario versión`. Window closed
→ **no template**: `{ok:false, reason:"window_closed"}` + one #bot-ops note.

Automatic triggers (all gated by `CUESTIONARIO_ENABLED === "1"`, best-effort,
never block or break the confirmation):

1. **Right after a booking confirmation lands** — `afterBookingConfirmed`
   replaced the booking-video call at every confirmation site (the video still
   goes first): brain direct send (`pipeline/inbound.ts` routeResult), approved /
   edited / best-bet booking drafts (`approvals.runPostSendEffects`), human
   registration (`booking-core.registerBooking`) and the web-form `trial_confirm`
   (`cron/followups.sendTrialConfirm`). The video call IS the "confirmation just
   landed" signal in all four paths, so the invite can never precede it.
2. **Airtable booking sync** (`cron/followups.syncBookings`, every 15 min) — for
   a record with a future trial and a phone whose `Cuestionario enviado` is
   empty, when no trial_confirm was just scheduled for it and it isn't a fresh
   chat booking (those two are covered by 1., after their confirmation). Tried
   once per record (kv `cuestionario_try:<rec>`).
3. **`POST /api/cuestionario/send`** — for an Airtable automation. **Optional /
   currently OFF**: 1 and 2 already cover every booking; keep it for manual or
   future use.

## Day-before reminder

When the record has `Motivo principal` (else `Meta 6 meses`), the day-before
reminder becomes "Hola {nombre}! Mañana a las {hora} es tu clase. Ya le pasé al
coach que buscas {motivo}, te va a estar esperando. Av. México 49, 1º piso.
Llega 10 min antes." (motivo lowercased, acronyms kept, no final period; >140
chars → generic copy). On WhatsApp this is tried free-form first; a closed
window falls back to the `trial_reminder_day_before` template exactly as
before. IG/FB use it as their free-form copy. Without an answer nothing changes.

## Airtable fields (Leads; the owner creates them — the worker never does)

Send path only: `Cuestionario versión` (single select adultos/kids/bfc),
`Cuestionario enviado` (date). Completion (via `__complete`):
`Cuestionario completado` (checkbox), `Cuestionario completado el` (date).

Answers, all versions: `Motivos` (multi), `Motivo principal`, `Situación actual`,
`Qué ha intentado`, `Por qué no funcionó`, `Costo de seguir así`, `Meta 6 meses`,
`Urgencia / evento`, `Por qué ahora`, `Días por semana` (single select
1/2/3/4+), `Qué lo haría faltar`, `Horarios preferidos` (multi),
`Lesiones / cuidados`, `Cómo nos encontró`.

- adultos adds: `Qué dejaría de sentir`, `Tiempo queriendo esto`,
  `Por qué esta vez sí`, `Rápido o permanente` (single select
  Rápidos/Permanentes), `Tamaño de grupo`.
- kids adds: `Cómo es el niño`, `Actividades previas`, `Impacto en casa`,
  `Quiere venir`, `Quién lo trae`.
- bfc adds: `Nombre Del Niñ@` (existing), `Meses bebé` (number, integer
  months), `Cómo es el niño`, `Quién lo trae`.

## Secrets / vars the owner sets

- `wrangler secret put CUESTIONARIO_SECRET` — any long random string (e.g.
  `openssl rand -base64 32`). Without it the routes answer 503 and nothing sends.
- `wrangler secret put CUESTIONARIO_SEND_KEY` — only if the Airtable automation
  (`/api/cuestionario/send`) is ever used.
- `CUESTIONARIO_ENABLED` (wrangler.jsonc var, default `"0"`) → `"1"` + push to
  turn on the automatic sends.

## Testing with one phone (feature still dark)

1. Set `CUESTIONARIO_SECRET`, deploy (with `CUESTIONARIO_ENABLED` still "0").
2. From your own phone, message the bot (opens the 24 h window) and make sure
   your number has a Leads record (book a test trial, or use an existing one).
3. Logged in to /admin as owner (browser console):
   `fetch('/admin/api/cuestionario/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({recordId:'rec…',version:'adultos'})}).then(r=>r.json())`
   → the result includes the link; the WhatsApp message arrives.
4. Open the link, answer, finish → check the Airtable row and the #wa-leads
   summary. Repeat with `version:'kids'` / `'bfc'` (resend is on by default).
5. When happy, flip `CUESTIONARIO_ENABLED` to "1" and push.
