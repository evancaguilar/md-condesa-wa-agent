# Post-trial sequence — the lead who came and did not sign up

Binding spec for `src/cron/post-trial.ts` (arming lives in `processResult`,
src/cron/followups.ts). History: v1 (d0 / d2 / d5) shipped 2026-09-21; on its
first live day (2026-09-30) it closed **two** people who had tried the class
the day before and walked out without paying. This is v2, same day.

## Why it works

They already did the hard part — they came. Nobody at the academy was writing
to them afterwards (163 attendees since July, zero follow-ups). The message
that closed both people on 09-30 was the plain "vi que todavía no queda tu
inscripción — ¿ya te decides a dar el paso?". No offer, no discount: a human
asking. Keep it that way.

## The arc (v2, 2026-09-30)

| kind | when (CDMX) | angle | template fallback |
|---|---|---|---|
| `post_trial_d0` | class start + 3h; past 21:00 → 09:30 next morning | "¿qué te pareció la experiencia?" — closes on enrollment | `post_trial_d0` ("hoy") or `post_trial_d1` ("ayer") |
| `post_trial_d2` | +2 days, 11:00 | "¿cómo amaneció el cuerpo?" — what do you still need to know | `post_trial_d2` |
| `post_trial_d4` | +4 days, 18:00 | objection discovery: horario / paquete / otra duda | `post_trial_d4` |
| `post_trial_d7` | +7 days, 11:00 (same weekday as the class) | "ya pasó una semana… la rutina se lo come todo" | `post_trial_d7` |
| `post_trial_d14` | +14 days, 18:00 | soft check-in + schedule link | `post_trial_d14` |
| `post_trial_d30` | +30 days, 11:00 | the goodbye, schedule link | `post_trial_d5` (approved body, reused) |

`post_trial_d5` (the v1 goodbye) is retired: never armed again, rows already in
`followups` keep draining with the same copy.

Timing is pure (`computePostTrialSequence`) and always inside 09:00–21:00 CDMX.
A result marked late arms only what is still ahead; older than 14 days arms
nothing. The Slack 🔥 card is posted only within 5 days (`POST_TRIAL_CARD_MAX_AGE`).

### "Hoy" vs "ayer" — the 09-30 bug

Paola's d0 went out at 09:31 the morning after her evening class and said "qué
gusto verte **hoy**". Two paths land there: an evening class (+3h spills past
21:00 → 09:30 tomorrow) and the front desk marking "Asistió" the next morning.

Fix: every chain row's `note` carries the class epoch (`encodeChainNote`). At
send time `processPostTrial` computes CDMX calendar days between the class and
now: 0 → "hoy" + template `post_trial_d0`; 1 → "ayer" + template
`post_trial_d1`; ≥2 → the first touch is dropped (d2 does not name the day).
The arming side already skips d0 when it could only fire two days late. Rows
armed before this shipped have no note and fall back to their arming time.

The copy has a `{when}` placeholder (client.mjs `postTrialD0Es/En`); templates
are one-variable, so "hoy"/"ayer" are two templates, not a `{{2}}`.

## Stop / pause rules (re-checked at every send)

| state at send time | effect |
|---|---|
| opted out (BAJA) | skipped, whole chain stays cancelled (inbound gate) |
| `student` | cancel + **stop chain** |
| a new future booking (anti-no-show rows live) | cancel + **stop chain** |
| human override active | skip this touch |
| lead wrote < 3 days ago (`CONVERSATION_GRACE`) | skip this touch — they are in a conversation |
| lead wrote ≥ 3 days ago and their message is the LAST in the thread | skip this touch — nobody answered them; a human owes the reply, not a bot nudge |
| lead wrote ≥ 3 days ago and we answered since | **send** — this is the lead the later touches exist for |
| Airtable "Perdido" | every chain row cancelled by the watcher |
| 🙋 "Yo le escribo" on the Slack card | cancels only the pending d0 |

v1 killed the whole chain on any reply. v2 pauses instead: a lead who asked for
prices, got them, and vanished is exactly the person +7d / +14d should reach.
The cost of the change is a lead who said "no gracias" and still gets a later
touch — the front desk stops that by marking **Perdido** in Airtable (or the
lead replies BAJA).

## Templates

Eight new ones (`post_trial_d1`, `d4`, `d7`, `d14` × es/en), all Marketing with
the BAJA footer, one `{{1}}` (first name). `createPostTrialV2Templates`
(src/cron/template-sync.ts, kv `tpl_create:post_trial_v2:2026-09-30`) submits
them on the first cron tick after deploy and posts one Slack note. Until Meta
approves them, a closed-window send of that touch is skipped with the usual
once-a-day note — in-window (free-form) sends work from the deploy on. Bodies:
docs/templates.md §7–12 and docs/template-submission.md §13–26.

## What to build next (brainstorm, not yet shipped)

Ordered by expected lift for the effort. None of these need a D1 migration.

1. **Outcome counter per touch.** We know d0 closed two people today only
   because Evan noticed. Log `sent → enrolled within 7d` per kind (kv or a tiny
   `chain_stats` table) and surface it on the Inicio tab + the 08:00 Slack
   brief. This is what tells us whether d14/d30 earn their template cost.
2. **"Dijo que se va a inscribir" fast lane.** Airtable already has that
   result value. When it sits next to "Asistió", pull d2 forward to the next
   morning and make the copy about *finishing* ("¿te dejo la inscripción lista
   hoy?") instead of asking how it felt. Hottest segment we have.
3. **Program-specific copy** the way the extended drip does it (adults /
   kids / baby via `classifyProgram`): a parent whose kid tried Mini Muay Thai
   should read "¿cómo le fue a Sofía?", not "¿cómo amaneció el cuerpo?". The
   name is often in the qualification already.
4. **Blast collision guard.** Evan's own rule for blasts is "no message of any
   kind in the last 3 days (4 for post-trial)". The blast sender does not know
   about the chain yet; `excludePhones` is done by hand. Make the queue skip
   phones with a scheduled post_trial row (or one sent < 4 days ago).
5. **Slack card v2.** The 🙋 button stops only d0. Add "🛑 Perdido" (writes the
   Airtable result, cancels the chain) and "✅ Se inscribió" so the front desk
   never has to open Airtable to keep the bot honest.
6. **Coach hand-off.** The person who taught the class is the one who can
   close them. Airtable knows the class; a per-coach Slack DM ("Ana estuvo en
   tu clase de 7 pm, no se inscribió — ¿le escribes?") beats a channel card.
7. **Second-trial offer as a manual play.** Some leads need a second free
   class, but that is a same-day, human decision at the desk — never automate
   it into the chain (it would read as a discount and we do not hold offers
   open).
