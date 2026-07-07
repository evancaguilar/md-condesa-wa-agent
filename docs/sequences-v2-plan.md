# Sequences v2 — quiet hours, extended drips, booking video

Binding spec. Extends the nudge engine from docs/followups-pack-plan.md using the transcribed ManyChat copy in docs/manychat-flows.md. Owner decisions (Evan, 2026-07-07):

## R1 — Quiet hours for ALL unsolicited sends
- No unsolicited follow-up may be SENT between **21:30 and 08:00 CDMX**. Replies to inbound messages are unaffected (bot replies immediately at any hour).
- Applies to nudges (day-1 + extended) and reengage sends. Existing trial-reminder clamp (09:00–21:00) already complies — leave it.
- Nudges 1–2 falling in quiet hours → defer to next 08:00 (preserve order; keep ≥2h between consecutive nudges after shifting; if that pushes past the 24h window, drop the nudge — the extended sequence covers it).

## R2 — Window-aware nudge 3
- Nudge 3 must land inside the 24h window AND outside quiet hours, with **≥2h after nudge 2's actual send time**:
  - If its natural time (+8h) is fine → keep.
  - If it falls in quiet hours (e.g. 22:30 or 00:30) or after window close → pull EARLIER to **21:30 same day** if 21:30 ≥ nudge2_time + 2h and still within the window.
  - Else defer to next 08:00 if that's still within the window.
  - Else drop nudge 3 (day-2 extended message takes over).

## R3 — Extended sequences (all programs, 7 touchpoints total)
- Timing: 3 day-1 nudges (existing kinds) + **nudge_d2** (24h after nudge 3's actual send), **nudge_d3** (+24h after d2), **nudge_d4** (+24h), **nudge_d5** (+24h). All shifted out of quiet hours (defer to 08:00) if needed.
- One extended sequence per lead per 30 days (kv `seq_done:<phone>` = epoch; day-1 nudges may re-arm per current logic but d2–d5 schedule only once per 30d).
- Cancel semantics identical to day-1 nudges (reply → cancel pending + d-steps stay cancelled until re-arm allowed; booking/opt-out/student → cancel all).
- Cap change: the 3-per-7d kv cap applies ONLY to day-1 nudges (re-arms), not to d2–d5 (they run once per sequence).
- Sending d2–d5: usually OUTSIDE the 24h window → try free-form first when window open (CTWA 72h windows make this common), else sendTemplate; template missing/unapproved → mark skipped + one Slack note per day (kv `tmpl_missing_note:<YYYY-MM-DD>`).
- **Program variants**: `adults` | `kids` | `baby`. Classification (pure fn `classifyProgram(contact, campaign?)`): baby if qualification.discipline contains "baby" OR campaign name matches /baby/i; kids if qualification.audience === "kid"; else adults.
- **Copy**: adapt from docs/manychat-flows.md (verbatim tone, fix truncations, replace mc.ht links with real ones: adults → https://mdcondesa.com/clase-prueba-adultos/, kids/baby → https://mdcondesa.com/clase-prueba-ninos/). Day-1 nudges get program-specific copy too (replace the generic copy in cron/nudges.ts). KIDS extended steps d2–d5 don't exist in ManyChat — AUTHOR them following the adults arc (retry → objection-handling: confianza/anti-bullying/pantallas → social proof → warm goodbye), same tone/emoji style.
- Adults nudge 3 (or d2) may include the group photo — OPTIONAL, only if trivially clean: host requires committing an image; SKIP image sends in this iteration, text + link only. (sendVideo below is the only media send.)
- Template copy for d2–d5 × 3 programs → append to docs/templates.md as `nudge_d2_adults` … `nudge_d5_baby` (marketing category, BAJA footer, es only for now; note in doc: submit at cutover).

## R4 — Booking video
- New `sendVideo(env, phone, videoUrl, caption?)` in services/wa.ts (Graph API `type:"video", video:{link, caption?}`), records to outbound_wamids/messages like sendText, same 24h-window guard (bookings are always in-window).
- New env var `BOOKING_VIDEO_URL` (wrangler vars) default `https://mdcondesa.com/media/confirmar-reserva.mp4` (already live).
- After a booking confirmation TEXT is sent (all three paths: pipeline auto-send book, approvals-approved book draft, syncBookings web-form trial_confirm), send the video right after (caption none — the text already carries the info). Failures: log + continue (video is best-effort, never blocks the confirmation).
- TRAINING_WHEELS: the confirmation text goes through approval as today; the video sends automatically right after the approved text is sent (no separate approval).

## Constraints
- Respect the in-flight multi-client refactor: package.json now uses `CLIENT=md-condesa` prefixes and tools emit `client.gen.ts/js` — do NOT revert those; keep new copy/config in the patterns you find (if a client config module exists, thread program copy through it only if trivial; otherwise keep copy in cron/nudges.ts as today and leave a TODO for the client refactor).
- Zero runtime deps; all 144 tests stay green; new pure logic (quiet-hour shifting, nudge-3 rule, classifyProgram, extended scheduling) unit-tested (fake clocks, CDMX offsets).
- New FollowupKind values: nudge_d2 | nudge_d3 | nudge_d4 | nudge_d5 (TEXT column — no migration).

## Verification
- Unit: quiet-hour shift cases (1am→8am; 22:00→21:30-pull rule incl. the ≥2h guard; drop cases), extended chain timing, classifyProgram, once-per-30d guard.
- Manual (Evan, test number): message at night → no nudge before 08:00; book via sandbox/phone → confirmation text + video arrive.
