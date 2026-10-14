# "Se inscribió" push hook (Airtable → worker)

When the front desk marks a lead **Se inscribió**, the bot sends the welcome and
then the student kit (check-in QR + responsiva link). Without this hook both
wait for the */5 cron: one poll for `syncBookings` to see the record (welcome +
arms the `student_kit` row at +90 s), another for the row to run — up to
~10 min. With the hook, the existing "Se inscribió" automation (which creates
the Alumno) calls the worker as its **last action**, and both go out within
seconds. The cron is unchanged and stays the fallback: if the hook is off,
fails or times out, the next tick does exactly what it always did.

## Endpoint

`POST https://md-condesa-wa-agent.evancaguilar.workers.dev/hooks/airtable/enrolled`

- Header `X-Hook-Key: <AIRTABLE_HOOK_KEY>` (constant-time compare). Missing /
  wrong / secret unset → `401`.
- Body `{"recordId":"rec…"}` (the **Leads** record). Anything else → `400`.
- 60 calls/min (kv counter) → `429`.
- Reply (always `200` once authenticated):
  `{ ok, welcome, kit, ms }`, plus `error` when something failed.
  - `welcome`: `sent` · `skipped` (Baja, or trial > 14 days old) · `already`
    (the cron handled it) · `busy` (the cron is processing it this very second)
    · `not_enrolled` · `not_found` · `no_phone` · `error` · `pending`.
  - `kit`: `sent` · `scheduled` (Alumno not linked yet or a retry — the cron
    finishes it) · `failed` (gave up; the kit posted its own Slack note) ·
    `cancelled` (nothing owed / already sent / IG-FB hand-off / Baja) · `none`
    (no kit row: kit off, Baja, stale) · `cron` (row already due — the cron
    owns it) · `skipped` · `error` · `pending`.
  - `pending`: the reply budget (15 s) ran out; the work keeps running in the
    worker (`waitUntil`) and finishes on its own.

### Trust model

The body is only a record id. The worker GETs the Leads record from Airtable,
maps it with the cron's own mapper (`getBookingRecord`) and proceeds only if
`Resultado clase prueba` classifies as enrolled. Otherwise it answers
`welcome:"not_enrolled"` and does nothing. A forged call can therefore at most
make the bot do *early* what the cron would do anyway; the key is anti-spam.

### No double sends

- **Welcome:** `processResult` (the cron's function, same deps) is guarded by
  the kv marker `resultado:<recordId>` plus an atomic claim
  `resultado_lock:<recordId>` (120 s), so the hook and a concurrent cron tick
  can never both send it. The loser returns `busy`.
- **Kit:** `runStudentKitNow` (src/cron/followups.ts) runs the lead's
  `student_kit` row through the same `processOne` path the cron uses. The cron
  only selects `status='scheduled' AND due_at <= now`, so the hook (a) leaves a
  row that is already due to the cron, and (b) otherwise claims it with a
  compare-and-set that pushes `due_at` 10 min out. Exactly one caller wins; no
  tick can pick it up while it runs; if the worker died mid-run, the lease
  expires and the cron runs it. The kit's own `student_kit:<alumnoId>` guard
  and its qr/resp progress note still apply.

Slack: success is silent from the hook (the kit already posts its 🎟️ note in
#bot-ops). Failures (Airtable read, welcome, kit) post ONE ⚠️ note each.

## Setup (Evan)

1. Generate a random key, e.g. `openssl rand -hex 24`.
2. Cloudflare dashboard → Workers & Pages → **md-condesa-wa-agent** → Settings →
   Variables and Secrets → Add → type **Secret**, name `AIRTABLE_HOOK_KEY`,
   value = the key. (Local wrangler is logged into the wrong account; use the
   dashboard.)
3. Airtable → base `appcX38TBVltyxHR6` → Automations → the existing
   **"Se inscribió"** automation (`wflEwWirVlvaGQrDB`) → add an action at the
   **END** (after the Alumno is created): **Run a script**.
   - Input variables: `recordId` = the trigger record's **Airtable record ID**.
   - Paste the script below and replace `REPLACE_WITH_AIRTABLE_HOOK_KEY` with
     the same key.
4. Test the action with a real "Se inscribió" record you are happy to message
   (or one whose welcome already went out — it answers `welcome:"already"`).

### Script ("Run a script" action body)

```js
// Push the "Se inscribió" welcome + student kit (QR + responsiva) to the
// WhatsApp worker right away instead of waiting for its 5-minute cron.
// MUST be the last action: the Alumno record has to exist already.
// Never throws — a failure here must not fail the automation (the cron
// covers it within ~10 min anyway).
const HOOK_KEY = "REPLACE_WITH_AIRTABLE_HOOK_KEY";
const HOOK_URL = "https://md-condesa-wa-agent.evancaguilar.workers.dev/hooks/airtable/enrolled";

const { recordId } = input.config();

try {
  const res = await fetch(HOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Hook-Key": HOOK_KEY },
    body: JSON.stringify({ recordId }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.log(`Hook HTTP ${res.status}: ${text}`);
  } else {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    console.log("Hook response:", data);
  }
} catch (err) {
  console.log(`Hook call failed (the cron will handle it): ${err}`);
}
```

## Verify

- **Deployed?** Probe the new route (not just `/health`, which an old build
  also answers):
  `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://md-condesa-wa-agent.evancaguilar.workers.dev/hooks/airtable/enrolled`
  → `401` on the new build (`404` = old build still serving). `/health` still
  confirms liveness / `kbVersion`.
- **Working?** On the next real enrolment, the automation run log shows
  `Hook response: { ok: true, welcome: "sent", kit: "sent", ms: … }`, and the
  🎟️ "QR y responsiva enviados a …" note lands in #bot-ops seconds after the
  record was marked — not minutes. `kit:"scheduled"` means the Alumno link was
  not there yet; the cron retries every 5 min.
- **Failing?** A ⚠️ `Hook "Se inscribió" (rec…)` note in #bot-ops, or `401`
  in the run log (key mismatch between the script and the Cloudflare secret).
