# Customer-list audiences from Airtable (Meta)

**Status: shipped INERT (2026-10-07).** `features.metaAudiences` is `false`; the
owner route can run it on demand (dry run first). Code:
`src/services/meta-audiences.ts` (normalizers, hashing, diff, Graph client),
`src/cron/audiences.ts` (daily sync + probe), routes in `src/routes/admin-api.ts`.

## What it maintains

Two customer-list custom audiences on `act_1334257084455191`, rebuilt from the
`Alumnos` table once a day (10:00 CDMX block) and created when missing:

| Audience (name in `metaAudiences` in client.mjs) | Who | Use |
|---|---|---|
| **MD Condesa - Alumnos que han pagado (Airtable)** | `Total Pagado` > 0 and `Status` ∉ {Profesor, Seminario, Visitantes de Pago} | lookalike seed; exclusion for acquisition |
| **MD Condesa - Alumnos activos** | `Vigencia por Fecha Activa` = 1 | exclude current members from ads |

Both are `subtype: CUSTOM`, `customer_file_source: USER_PROVIDED_ONLY`.

## Normalization (what Meta hashes must match)

- **Email** (`Email`): lowercase, trim; a cell holding several addresses is split
  on `, ; /` and whitespace; anything not shaped like an address is dropped.
- **Phone** (`Teléfono`): digits only; 10 digits → prefix `52`; `521` + 10
  digits → the legacy mobile `1` is dropped (`52` + 10); other country codes are
  kept as given; fewer than 10 digits → dropped.
- Each identifier is SHA-256 hashed (lowercase hex) and uploaded with the
  multi-key schema `["EMAIL","PHONE"]` — one row per email (each with the phone),
  or a phone-only row. **Nothing unhashed leaves the worker**, and only the row
  hashes are kept in kv (`meta_aud_members:<paid|active>`) for the diff.

## How a run works

1. One Airtable walk of `Alumnos` filtered to `OR({Total Pagado} > 0,
   {Vigencia por Fecha Activa} = 1)` (fields: Teléfono, Email, Total Pagado,
   Status, Vigencia por Fecha Activa).
2. Per audience: hash the members, **diff** against the last upload, `POST
   /<audience>/users` the adds and `DELETE /<audience>/users` the removes
   (≤10 000 rows per request), then store the new snapshot. A quiet day costs
   zero Graph writes; a lapsed member leaves "Alumnos activos" the next day.
   (A full `usersreplace` was rejected on purpose: it has session/ad-set
   restrictions and would re-upload everyone daily.)
3. Audience ids are cached in kv (`meta_aud:<slug>`); first run looks the name
   up on the account and creates it if absent.
4. State: `meta_aud_last_ok` / `meta_aud_last_error`; one Slack note per CDMX
   day on failure. Budget ≈ 3 Airtable pages + 1 list + ≤2 creates + a few
   `/users` calls — well under the 50-subrequest cap.

## One-time setup (Evan)

1. Token: the **ads** token the spend import already uses (`ADS_ACCESS_TOKEN`,
   has `ads_management` on `act_1334257084455191`). The WhatsApp app's
   system-user token (`META_CAPI_TOKEN`) is only a fallback — its generator
   offers no ads scopes. Nothing new to mint for this part.
2. Accept the **Custom Audience Terms** for the ad account once
   (Ads Manager → Audiences prompts for it; Graph returns an error naming the
   ToS URL otherwise).
3. `GET /admin/api/audiences/probe` → `enabled`, `reason`, `audienceIds`, last run.
4. **Dry run:** `POST /admin/api/audiences/sync {"dryRun": true}` → students
   scanned, members/rows per audience, planned adds/removes. No Graph call, no
   kv write.
5. **Run once now:** `POST /admin/api/audiences/sync {}` (the route bypasses the
   feature flag) → creates both audiences and uploads. Verify in Ads Manager →
   Audiences (size shows after Meta matches, usually within hours).
6. Flip `features.metaAudiences: true` in `clients/md-condesa/client.mjs`,
   `npm run build`, commit source + compiled output, push → daily from then on.

## Operating notes

- Column names live in `airtableMetrics.students` (`email`, `status`,
  `activeFlag`, `excludedStatuses`, plus the existing `phone`/`totalPaid`) and
  the audience names in `metaAudiences` — all in client.mjs, never in `src/`.
- Turning it off: `features.metaAudiences: false` + build + push. The audiences
  stay on the account as they are.
- No campaign or ad set is touched by this code; attaching an audience to an
  ad set is a manual Ads Manager step.
