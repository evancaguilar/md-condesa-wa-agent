# Conversions API for Business Messaging (Meta) — downstream funnel signals

**Status: shipped INERT (2026-09-21).** Nothing is sent to Meta until Evan does the
one-time setup below. Code: `src/services/meta-capi.ts` (pure builders + sender +
queue), `src/cron/capi.ts` (drain), hooks in `src/services/booking-core.ts` and
`src/cron/followups.ts`, owner routes in `src/routes/admin-api.ts`.

## Why

Every campaign is click-to-WhatsApp and optimizes for **"conversations started"**.
Meta therefore buys the cheapest possible chat, which is why the biggest-spend ad
of the period burned ~$13.9k MXN for one $500 sale. Meta cannot do better because
it never learns what happened after the chat started.

The Conversions API for Business Messaging closes that loop: for every lead that
arrived through an ad, we send back the three things that matter —

| Funnel step | When we send it | Meta event name |
|---|---|---|
| Booked a trial | a trial record exists (chat, staff, or web form) | `LeadSubmitted` |
| Attended the trial | `Resultado Clase Prueba` contains "Asistió" or "Se inscribió" | `QualifiedLead` |
| Enrolled (paid) | `Resultado Clase Prueba` contains "Se inscribió" | `Purchase` (value = `Pago Inicial`, MXN) |

Once those land, a campaign can optimize for **purchases through messaging**
instead of conversations (see "Then: the campaign change" at the end — that is
the step that actually changes what Meta buys; sending events alone changes
nothing).

### Why those event names

Meta documents a **closed list** of event names for business messaging
([FAQ](https://developers.facebook.com/documentation/ads-commerce/conversions-api/business-messaging)):
`Purchase, LeadSubmitted, InitiateCheckout, AddToCart, ViewContent, OrderCreated,
OrderShipped, OrderDelivered, OrderCanceled, OrderReturned, CartAbandoned,
QualifiedLead, RatingProvided, ReviewProvided`. Custom event names are **not**
documented as supported, so we do not invent one. `Schedule` and `Contact` — the
natural names for "booked" and "showed up" — are *not* on the list, so the
booking maps to `LeadSubmitted` and the attended trial to `QualifiedLead` (the
lead proved itself qualified by showing up). The mapping lives in
`CAPI_EVENT_NAMES` and a unit test pins it against the allowed list.

## What the worker does

- **Only ctwa_clid leads.** The inbound pipeline already stores the click id from
  the click-to-WhatsApp referral in `contacts.ad_ref` (`{sourceId, headline, body,
  sourceUrl, ctwaClid}`). No click id ⇒ the lead is skipped silently — organic
  leads, old rows, and WhatsApp-Status ads (Meta omits `ctwa_clid` there) simply
  produce no events.
- **Hooks only enqueue.** Each funnel hook writes a kv row (`capi_q:<eventId>`) —
  a D1 write, no network — so a Meta outage can never slow a reply or block a
  booking. Every hook is wrapped so it cannot throw into its caller.
- **At most once per contact per step, forever.** `kvSetIfAbsent` on
  `capi:<step>:<phone>` is the claim. Meta explicitly states it does **not**
  deduplicate business-messaging events for you, so the deduplication is ours.
  A deterministic `event_id` rides along anyway (it costs nothing and may help).
- **Drain:** `src/cron/capi.ts`, every 5-minute tick, ≤5 events per tick, **one
  POST per event** (Meta rejects an entire request if any event in it is
  invalid, so batching would let one bad row drop good conversions). An idle
  tick reads exactly ONE kv row thanks to the `capi_pending` gate — no
  `LIKE`-scan of `kv` on every tick (see the three D1 rows-read outages in
  STATUS.md).
- **Age limit:** Meta rejects a request when any `event_time` is more than 7 days
  old, so anything older is dropped before it is queued (and again at drain
  time). A late-marked result reports the **trial datetime**, not the day the
  front desk typed it.
- **Failures are quiet and bounded:** the row is retried up to 3 drains, then
  dropped; `capi_last_error` / `capi_last_ok` hold the state and at most **one
  Slack note per CDMX day** is posted.
- **No PII leaves the worker.** The payload carries only `ctwa_clid` +
  `whatsapp_business_account_id` (both documented as sent in the clear, never
  hashed) and, for a purchase, `value` + `currency`. No phone, no name, no email
  — so nothing that would require SHA-256 is ever involved. The access token
  goes in an `Authorization: Bearer` header (never a URL) and is scrubbed from
  every error string.

Exact payload we POST to `https://graph.facebook.com/v23.0/<DATASET_ID>/events`:

```json
{ "data": [ {
  "event_name": "Purchase",
  "event_time": 1789000000,
  "action_source": "business_messaging",
  "messaging_channel": "whatsapp",
  "event_id": "md-condesa-purchase-1a2b3c4d",
  "user_data": {
    "whatsapp_business_account_id": "1717538906028335",
    "ctwa_clid": "ARAkLkA8rml…"
  },
  "custom_data": { "value": 1500, "currency": "MXN" }
} ] }
```

No amount on file ⇒ the Purchase goes out **without** a value rather than with an
invented one (a 0 would tell Meta the sale was worthless).

## One-time setup (Evan)

1. **Create / find the dataset linked to the WABA** (`1717538906028335`).
   Meta's documented route is the Graph edge on the WABA itself:
   - read: `GET https://graph.facebook.com/v23.0/1717538906028335/dataset`
   - create: `POST https://graph.facebook.com/v23.0/1717538906028335/dataset`
     (returns the `dataset_id`; one dataset per asset)

   The worker's token is a Cloudflare secret, so the dashboard does the read for
   you: **`GET /admin/api/capi/dataset`** (owner-only) returns the dataset id(s)
   already linked. If it returns none, create one — either with the POST above
   from the Graph API Explorer using your own user token, or in **Events Manager
   → Data sources → Connect data source → Business messaging** and link it to
   the WhatsApp Business Account. (Meta's Help Center pages for that UI path
   could not be verified from the docs — the Graph edge above is the verified
   route; if the UI wording differs, trust the Graph call.)

2. **Token / permissions.** Posting to a business-messaging dataset needs
   `whatsapp_business_management` **and** `whatsapp_business_manage_events`
   (advanced access), plus the app's Marketing API access tier — *not* the ads
   permissions the spend import uses. So:
   - preferred: mint a system-user token with those scopes and set it as the
     Cloudflare secret **`META_CAPI_TOKEN`**
     (`npx wrangler secret put META_CAPI_TOKEN`, or the Cloudflare dashboard);
   - if the existing system user already holds them, the worker falls back to
     `ADS_ACCESS_TOKEN` and then `WA_ACCESS_TOKEN` — `/admin/api/capi/probe`
     reports which one is in play under `tokenSource`.
   - Never put a token in wrangler.jsonc or any file.

3. **Set the dataset id.** Uncomment `META_CAPI_DATASET_ID` in `wrangler.jsonc`
   (it is a non-secret id, same as `META_AD_ACCOUNT_ID`), paste the id, push.

4. **Dry-run before arming.** With the flag still off:
   `POST /admin/api/capi/test {"phone":"5215512345678"}` returns the exact
   payload for a real ad lead without sending anything. Add
   `{"send":true,"testEventCode":"TEST12345"}` (code from Events Manager → your
   dataset → **Test events**) to actually fire one and watch it appear there.
   *Unverified:* Meta documents `test_event_code` only for general CAPI — if the
   test event does not show up, send without the code and check the dataset's
   activity/overview instead.

5. **Arm it.** Flip `features.metaCapi` to `true` in
   `clients/md-condesa/client.mjs`, run `npm run build`, commit both the source
   and the compiled output, push. From then on every new booking/attendance/
   enrolment of an ad lead is reported within ~5 minutes.

6. **Verify.** `GET /admin/api/capi/probe` →
   `{enabled, datasetIdSet, tokenSource, lastOk, lastError, countToday, queued}`.
   `lastOk` moving and `countToday` climbing = events are landing; then confirm
   in Events Manager that the dataset shows LeadSubmitted / QualifiedLead /
   Purchase.

### Then: the campaign change (the part that changes spend)

Sending events does nothing on its own — a campaign has to **optimize** for one.
Meta's FAQ is explicit that the Conversions API "enables access to purchase
optimization for ads that click to Messenger and ads that click to WhatsApp".
In Ads Manager: create a campaign with objective **Sales** (API:
`OUTCOME_SALES`), conversion location **WhatsApp**, then set the performance goal
to maximize **conversions** rather than conversations, and pick the dataset +
conversion event (`Purchase`, or `QualifiedLead` while purchase volume is still
low — Meta needs roughly 50 conversions/week to learn). On the Marketing API the
same thing is an ad set with `optimization_goal: OFFSITE_CONVERSIONS` under
`OUTCOME_SALES` (with `OUTCOME_LEADS`, `CONVERSATIONS` is the only goal
available, which is exactly the trap we are escaping).

Run it **alongside** the current conversation-optimized campaign for a couple of
weeks — do not switch the whole account at once — and compare cost per enrolment,
not cost per chat. Give the events 2–3 weeks to accumulate before judging.

## Operating notes

- Turning it off is one line: `features.metaCapi: false` + `npm run build` + push.
  Queued rows simply stop draining.
- `/admin/api/capi/*` is **owner-only** (same gate as `/admin/api/metrics/*`).
- kv keys: `capi_q:<eventId>` (queue), `capi:<step>:<phone>` (claim),
  `capi_pending` (idle gate), `capi_last_ok`, `capi_last_error`,
  `capi_count:<YYYY-MM-DD>`, `capi_note:<YYYY-MM-DD>`.
- Purchase value comes from the Leads column **`Pago Inicial`**
  (`airtableLeads.initialPayment` in client.mjs — never hardcoded in `src/`).
  The worker only ever reads it.
- No D1 migration: everything lives in the existing `kv` table.

## Verified against Meta's docs (2026-09-21)

- Spec + FAQ (event list, dataset edge, permissions, "Meta does not deduplicate"):
  https://developers.facebook.com/documentation/ads-commerce/conversions-api/business-messaging
- Payload/auth forms, `test_event_code`, 7-day `event_time` rule, batch rejection:
  https://developers.facebook.com/documentation/ads-commerce/conversions-api/using-the-api
- Which `user_data` fields are hashed (`ctwa_clid` is not):
  https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters
- Newest curl sample (JSON body + `Authorization: Bearer`):
  https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/automatic-events-api
- `referral.ctwa_clid` on the inbound message (and its absence for Status ads):
  https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/text
- CTWA objectives / optimization goals:
  https://developers.facebook.com/documentation/ads-commerce/marketing-api/ad-creative/messaging-ads/click-to-whatsapp
- Retry guidance / 2xx-4xx contract:
  https://developers.facebook.com/docs/marketing-api/conversions-api/support/

**Could not be verified from official docs** (assumptions are conservative):
`test_event_code` support for business-messaging datasets; the success-response
JSON shape (we treat any 2xx as success and fall back to counting what we sent);
the ctwa_clid attribution-window length; whether custom event names are accepted
(we assume not); the Events Manager and Ads Manager UI wording (Help Center pages
render as an empty JS shell to a fetcher). The business-messaging guide's own
sample still shows Graph `v16.0`; we use the repo-wide pin `v23.0`.
