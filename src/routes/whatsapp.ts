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
} from "../db/queries.js";
import { processInbound } from "../pipeline/inbound.js";

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
      if (ev.type === "inbound") await onInbound(env, ctx, ports, ev);
      else if (ev.type === "echo") await onEcho(env, ports, ev);
      // statuses + app_state_sync: log only (already normalized; nothing to do).
    } catch (err) {
      console.error("webhook event error", ev.type, err);
    }
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
  await ports.slack.postNote(
    `Evan respondió desde el teléfono (${phone}) — bot en pausa hasta ${hhmm}.`,
  );
}
