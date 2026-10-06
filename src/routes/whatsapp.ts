import type { Env, Ports } from "../types.js";
import { verifyMetaSignature } from "./verify.js";
import {
  parseWebhook,
  type EchoEvent,
  type InboundEvent,
} from "./webhook-parse.js";
import {
  cancelPendingApprovals,
  insertMessageIfNew,
  isOwnWamid,
  setHumanOverride,
  upsertContact,
  kvSet,
  kvClaimIfAbsentOrOlder,
} from "../db/queries.js";
import { classifyInfraError, reportInfraError } from "../services/infra-alert.js";
import { sendTextRaw } from "../services/wa.js";
import { HOLDING_LINE } from "../services/slack-timeouts.js";
import { processInbound } from "../pipeline/inbound.js";
import { channelOf, displayContact, type Channel } from "../services/channel.js";
import { CLIENT } from "../client.gen.js";

/** Deploy-dark gate: IG/FB events are dropped until the client flag is on. */
function channelEnabled(ch: Channel): boolean {
  if (ch === "ig") return CLIENT.features.instagram === true;
  if (ch === "fb") return CLIENT.features.messenger === true;
  return true;
}

export async function handleVerify(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token === env.WA_VERIFY_TOKEN && challenge) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("forbidden", { status: 403 });
}

export async function handleWebhook(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  ports: Ports,
): Promise<Response> {
  const raw = await req.text();
  const sig = req.headers.get("X-Hub-Signature-256");
  const ok = await verifyMetaSignature(env.META_APP_SECRET, sig, raw);
  if (!ok) return new Response("invalid signature", { status: 401 });

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  // Ack Meta immediately; do all work off the response path so we never risk a
  // webhook retry storm from a slow downstream (Anthropic/Slack/Airtable).
  ctx.waitUntil(processEvents(env, ctx, ports, payload));
  return new Response("ok", { status: 200 });
}

async function processEvents(
  env: Env,
  ctx: ExecutionContext,
  ports: Ports,
  payload: unknown,
): Promise<void> {
  const events = parseWebhook(payload);
  for (const ev of events) {
    try {
      const contactId =
        ev.type === "inbound" ? ev.from : ev.type === "echo" ? ev.to : null;
      if (contactId !== null && !channelEnabled(channelOf(contactId))) {
        console.log(
          `[webhook] ${channelOf(contactId)} channel disabled; dropping ${ev.type} from ${contactId}`,
        );
        continue;
      }
      if (ev.type === "inbound") await onInbound(env, ctx, ports, ev);
      else if (ev.type === "echo") await onEcho(env, ports, ev);
      else if (ev.type === "status" && ev.status === "failed") {
        // A FAILED delivery is the only status worth keeping: Meta accepts
        // sends synchronously and reports non-delivery here (2026-08-28: blast
        // smoke tests "sent" but never arrived — this is where the why lives).
        // kv-keyed by ts+wamid; /admin/api/wa-failures reads the newest.
        console.error(`[webhook] delivery FAILED to ${ev.recipient}: ${ev.error ?? "(sin detalle)"}`);
        await kvSet(
          env.DB,
          `wa_fail:${String(ev.ts).padStart(12, "0")}:${ev.wamid.slice(-24)}`,
          JSON.stringify({ to: ev.recipient, ts: ev.ts, error: ev.error ?? null }),
        );
      }
      // other statuses + app_state_sync: nothing to do.
    } catch (err) {
      console.error("webhook event error", ev.type, err);
      // D1 down ⇒ the message was NOT stored and nothing downstream will ever
      // see it (Meta got its 200). Make it visible anyway: the raw text to
      // Slack, a holding line to the lead (Graph API only, no DB). Best-effort.
      if (ev.type === "inbound" && classifyInfraError(err)?.kind.startsWith("d1")) {
        await fallbackUnstoredInbound(env, ports, ev);
      }
      // D1 / Anthropic / Meta outage ⇒ one <!here> per 15 min, throttled
      // OUTSIDE D1 when D1 is the thing that is down (2026-10-06 incident:
      // hours of "D1 DB is overloaded" with nothing but console.error).
      await reportInfraError(
        {
          postNote: (t) => ports.slack.postNote(t),
          kvClaim: (k, n, a) => kvClaimIfAbsentOrOlder(env.DB, k, n, a),
        },
        `webhook ${ev.type}`,
        err,
      );
    }
  }
}

// Per-isolate memory (D1 is down, there is nowhere else): wamids already
// relayed (Meta may redeliver) and the last holding line per phone.
const relayedWamids = new Set<string>();
const holdingSentAt = new Map<string, number>();
const HOLDING_FALLBACK_COOLDOWN_SEC = 30 * 60;

/**
 * 2026-10-06 D1 outage: for ~15 h every inbound was acked to Meta and then
 * lost when the first D1 call threw; Evan had no way to even SEE the leads.
 * Slack gets the raw text (phone + body, "responde desde la app de WhatsApp
 * Business o espera al reproceso"); the lead gets ONE holding line per 30 min
 * so they are not left on read. Both via paths that do not touch D1.
 */
async function fallbackUnstoredInbound(env: Env, ports: Ports, ev: InboundEvent): Promise<void> {
  if (!ev.wamid || !ev.from || relayedWamids.has(ev.wamid)) return;
  relayedWamids.add(ev.wamid);
  if (relayedWamids.size > 2000) relayedWamids.clear();
  const body = (ev.body ?? "").trim() || "[sin texto / media]";
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    await ports.slack.postNote(
      `📥 *Mensaje SIN guardar (base de datos caída)* — ${displayContact(ev.from)}` +
        `${ev.profileName ? ` · ${ev.profileName}` : ""}
` +
        `> ${body.slice(0, 600)}
` +
        `_No está en el panel. Respóndele desde la app de WhatsApp Business o espera a que la BD vuelva._`,
    );
  } catch (e) {
    console.error("[webhook] fallback slack note failed", ev.from, e);
  }
  if (channelOf(ev.from) !== "wa") return;
  const last = holdingSentAt.get(ev.from) ?? 0;
  if (nowSec - last < HOLDING_FALLBACK_COOLDOWN_SEC) return;
  holdingSentAt.set(ev.from, nowSec);
  try {
    await sendTextRaw(env, ev.from, HOLDING_LINE);
  } catch (e) {
    console.error("[webhook] fallback holding line failed", ev.from, e);
  }
}

async function onInbound(
  env: Env,
  ctx: ExecutionContext,
  ports: Ports,
  ev: InboundEvent,
): Promise<void> {
  if (!ev.wamid || !ev.from) return;
  await processInbound(env, ctx, ports, {
    wamid: ev.wamid,
    phone: ev.from,
    body: ev.body,
    ts: ev.ts,
    kind: ev.kind,
    profileName: ev.profileName,
    referral: ev.referral,
    media: ev.media,
  });
}

async function onEcho(env: Env, ports: Ports, ev: EchoEvent): Promise<void> {
  if (!ev.wamid) return;
  // Our own API sends are recorded in outbound_wamids — ignore those echoes.
  if (await isOwnWamid(env.DB, ev.wamid)) return;

  // Otherwise Evan replied from the WA Business app: log, snooze the bot, and
  // cancel any pending drafts so we don't double-answer.
  const phone = ev.to;
  if (!phone) return;
  await upsertContact(env.DB, { phone });
  await insertMessageIfNew(env.DB, {
    wamid: ev.wamid,
    phone,
    direction: "out_human_echo",
    body: ev.body,
    ts: ev.ts,
    meta: null,
  });
  const hours = Number(env.HUMAN_SNOOZE_HOURS) || 8;
  const until = await setHumanOverride(env.DB, phone, hours);
  await cancelPendingApprovals(env.DB, phone, "taken_over");
  const hhmm = new Intl.DateTimeFormat("es-MX", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Mexico_City",
  }).format(new Date(until * 1000));
  const source =
    channelOf(phone) === "wa" ? "desde el teléfono" : "desde la bandeja de la página";
  await ports.slack.postNote(
    `Evan respondió ${source} (${displayContact(phone)}) — bot en pausa hasta ${hhmm}.`,
  );
}
