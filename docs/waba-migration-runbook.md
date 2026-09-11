# WABA migration runbook — move +52 1 56 4199 2274 to a WABA we own

**Why:** WABA `1582515279931864` was born through ManyChat's embedded signup and
still carries their shared credit line, which blocks adding our own card. From
**2026-10-01** Meta bills every in-window reply as a service message (MX ≈
US$0.0115, first 1,000/number/month free) and **stops delivering on a WABA with
no payment method**. Same number, new WABA = leads notice nothing.

**Who does what:** Parts 1–3 are WhatsApp Manager clicks (Evan; no API exists).
Part 4 runs through an owner-only worker endpoint that uses the token already
stored in Cloudflare — no Graph API Explorer, no token pasting. Part 5 is one
variable in the Cloudflare dashboard.

Everything in Part 4 is a single explicit call per step; nothing runs on its own
and nothing touches the number until the `migrate` step with its confirm phrase.

---

## Part 1 — Create the destination WABA (5 min)

1. business.facebook.com → **Business settings** → Accounts → **WhatsApp accounts**
   → **Add** → *Create a WhatsApp Business Account*. Name: `MD Condesa Ventas`.
   Same portfolio that owns app 2215578122600171 (this makes it a same-business
   migration, the simplest case — no cross-business approval).
2. Note the new **WABA ID** (WhatsApp Manager → account overview). Call it `NEW_WABA`.
3. Do **not** add any number to it yet.

## Part 2 — Put the card on the NEW WABA first (5 min, the go/no-go)

WhatsApp Manager → select `NEW_WABA` → **Billing / Payment settings** → Add
payment method → card. If Meta accepts the card here, the whole plan is
validated before the live number moves. If it refuses, stop and tell Claude
what it said — nothing has changed yet.

## Part 3 — Turn OFF two-step verification on 2274 (2 min)

WhatsApp Manager → WABA `1582515279931864` → Phone numbers → **+52 1 56 4199 2274**
→ Two-step verification → turn off (current PIN in STATUS.md). Meta requires it
off before a number can be moved. It goes back on in Part 4 step 5 with a new PIN.

Also make sure the SIM/eSIM for 2274 can receive an SMS (or a voice call):
Part 4 step 3 sends a 6-digit code to it.

## Part 4 — API steps from the /admin console (10 min)

Open https://md-condesa-wa-agent.evancaguilar.workers.dev/admin, log in as
**evan** (owner), open DevTools → Console, and define this helper once:

```js
const mig = (b) => fetch("/admin/api/wa/migrate", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(b)}).then(r => r.json()).then(j => (console.log(JSON.stringify(j, null, 2)), j));
const NEW_WABA = "PASTE_NEW_WABA_ID";
```

Run the steps in order, reading each response before the next.

1. **Check (read-only).** Confirms the token can see the old number and the new
   WABA, shows `readiness` (`newWabaHasFunding` should be `true` after Part 2,
   `oldNumberIsMx` true) and `willSend` = `{cc:"52", phone:"15641992274"}`.
   ```js
   await mig({step:"check", newWabaId: NEW_WABA, oldWabaId: "1582515279931864"})
   ```
2. **Migrate.** The only step that changes anything; it needs the exact phrase.
   Returns `newPhoneNumberId` — the worker also remembers it.
   ```js
   await mig({step:"migrate", newWabaId: NEW_WABA, confirm: "MIGRAR 2274"})
   ```
   If Meta refuses (`graphError` in the response), copy the message to Claude.
   Typical causes: two-step still on, the number still "in use" on the old
   WABA, or a billing precondition on the source. The old number keeps working
   until `register` succeeds on the new id.
3. **Request the code.** SMS by default; `codeMethod:"VOICE"` for a call.
   ```js
   await mig({step:"request_code"})
   ```
4. **Verify it.**
   ```js
   await mig({step:"verify_code", code:"123456"})
   ```
5. **Register** with a NEW six-digit PIN (this re-enables two-step). Store the
   PIN in the password manager and update STATUS.md.
   ```js
   await mig({step:"register", pin:"NEW6DIGITS"})
   ```
6. **Subscribe the app** so webhooks flow for the new WABA.
   ```js
   await mig({step:"subscribe", newWabaId: NEW_WABA})
   ```
7. **Post-check.** Shows the number as Meta sees it now and the exact variable
   to set.
   ```js
   await mig({step:"post_check"})
   ```

`GET /admin/api/wa/migrate` (or `fetch("/admin/api/wa/migrate").then(r=>r.json())`)
shows what the worker remembers (new id, last step) at any time.

## Part 5 — Point the worker at the new id (2 min)

Cloudflare dashboard → Workers & Pages → **md-condesa-wa-agent** → Settings →
Variables → `WA_PHONE_NUMBER_ID` = the `newPhoneNumberId` from step 2 → Save.
Takes effect on the next request, no redeploy.

Then: send "hola" to 2274 from your phone → Slack card appears → Aprobar →
reply lands. Check `/health` still says `dbOk:true`.

## Afterwards

- Submit the template pack under `NEW_WABA` (docs/template-submission.md) —
  templates are WABA-scoped and the pack was never submitted on the old one.
  This is what finally turns on the day-before / same-day reminders.
- Leave the old WABA alone for a week (nothing should be on it), then it can be
  ignored; do not delete it.
- Update STATUS.md: number topology (new WABA id, new phone-number-id, new PIN).

## Rollback

Before `register` succeeds on the new id, the old registration is intact:
nothing to roll back. After it, the number lives on the new WABA; the way back
is the same migration in reverse (Part 4 with the old WABA as destination) —
possible, but there is no reason to, since the old WABA is the one that cannot
take a payment method.
