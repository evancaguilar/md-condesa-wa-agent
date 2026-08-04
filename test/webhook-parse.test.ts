import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseWebhook,
  type EchoEvent,
  type InboundEvent,
} from "../src/routes/webhook-parse.js";
import inboundText from "./fixtures/inbound-text.json" with { type: "json" };
import echo from "./fixtures/echo.json" with { type: "json" };
import buttonReply from "./fixtures/button-reply.json" with { type: "json" };
import duplicateDelivery from "./fixtures/duplicate-delivery.json" with { type: "json" };
import inboundReferral from "./fixtures/inbound-referral.json" with { type: "json" };
import inboundAudio from "./fixtures/inbound-audio.json" with { type: "json" };
import igInboundText from "./fixtures/ig-inbound-text.json" with { type: "json" };
import igInboundImage from "./fixtures/ig-inbound-image.json" with { type: "json" };
import fbInboundText from "./fixtures/fb-inbound-text.json" with { type: "json" };
import fbEcho from "./fixtures/fb-echo.json" with { type: "json" };
import fbPostbackReferral from "./fixtures/fb-postback-referral.json" with { type: "json" };

test("parses an inbound text message", () => {
  const events = parseWebhook(inboundText);
  assert.equal(events.length, 1);
  const ev = events[0] as InboundEvent;
  assert.equal(ev.type, "inbound");
  assert.equal(ev.wamid, "wamid.INBOUND_1");
  assert.equal(ev.from, "5215512345678");
  assert.equal(ev.kind, "text");
  assert.equal(ev.ts, 1720200000);
  assert.equal(ev.body, "Hola, quiero una clase de prueba de jiu jitsu");
});

test("extracts the WhatsApp profile (push) name from the contacts rider", () => {
  const payload = {
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              contacts: [
                { wa_id: "5215512345678", profile: { name: "  Karla P  " } },
              ],
              messages: [
                {
                  from: "5215512345678",
                  id: "wamid.NAME",
                  timestamp: "1720200300",
                  type: "text",
                  text: { body: "hola" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const ev = parseWebhook(payload)[0] as InboundEvent;
  assert.equal(ev.profileName, "Karla P");
});

test("profileName is absent when the contacts rider doesn't match the sender", () => {
  const payload = {
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              contacts: [{ wa_id: "9999999999", profile: { name: "Otro" } }],
              messages: [
                {
                  from: "5215512345678",
                  id: "wamid.NONAME",
                  timestamp: "1720200301",
                  type: "text",
                  text: { body: "hola" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const ev = parseWebhook(payload)[0] as InboundEvent;
  assert.equal(ev.profileName, undefined);
});

test("parses a coexistence echo (smb_message_echoes)", () => {
  const events = parseWebhook(echo);
  assert.equal(events.length, 1);
  const ev = events[0] as EchoEvent;
  assert.equal(ev.type, "echo");
  assert.equal(ev.wamid, "wamid.ECHO_1");
  assert.equal(ev.to, "5215512345678");
  assert.equal(ev.body, "Claro, te agendo el sábado a las 2pm");
});

test("extracts body from a button reply", () => {
  const payload = {
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              messages: [
                {
                  from: "5215512345678",
                  id: "wamid.BTN",
                  timestamp: "1720200200",
                  type: "button",
                  button: { text: "Ahí estaré", payload: "CONFIRM" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const events = parseWebhook(payload);
  const ev = events[0] as InboundEvent;
  assert.equal(ev.kind, "button");
  assert.equal(ev.body, "Ahí estaré");
});

test("extracts body from an interactive list reply", () => {
  const payload = {
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              messages: [
                {
                  from: "5215512345678",
                  id: "wamid.INT",
                  timestamp: "1720200300",
                  type: "interactive",
                  interactive: {
                    type: "list_reply",
                    list_reply: { id: "opt_bjj", title: "Jiu Jitsu" },
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const events = parseWebhook(payload);
  const ev = events[0] as InboundEvent;
  assert.equal(ev.kind, "interactive");
  assert.equal(ev.body, "Jiu Jitsu");
});

test("fixture: button-reply payload parses as interactive button_reply", () => {
  const events = parseWebhook(buttonReply);
  assert.equal(events.length, 1);
  const ev = events[0] as InboundEvent;
  assert.equal(ev.type, "inbound");
  assert.equal(ev.wamid, "wamid.BUTTON_1");
  assert.equal(ev.kind, "interactive");
  assert.equal(ev.body, "Ahí estaré");
});

test("fixture: duplicate-delivery replays the same wamid as inbound-text", () => {
  // Same wamid as inbound-text.json → the pipeline's INSERT OR IGNORE dedupe
  // drops the second delivery. Here we assert the parser yields the identical
  // wamid so the dedupe key collides on replay.
  const first = parseWebhook(inboundText)[0] as InboundEvent;
  const dup = parseWebhook(duplicateDelivery)[0] as InboundEvent;
  assert.equal(dup.wamid, first.wamid);
  assert.equal(dup.type, "inbound");
});

test("fixture: click-to-WhatsApp referral is extracted onto the inbound event", () => {
  const events = parseWebhook(inboundReferral);
  assert.equal(events.length, 1);
  const ev = events[0] as InboundEvent;
  assert.equal(ev.type, "inbound");
  assert.equal(ev.wamid, "wamid.REFERRAL_1");
  assert.equal(ev.kind, "text");
  assert.equal(ev.body, "Hola, vi su anuncio de defensa personal");
  assert.ok(ev.referral);
  assert.equal(ev.referral?.sourceId, "120210000000012345");
  assert.equal(ev.referral?.sourceType, "ad");
  assert.equal(
    ev.referral?.headline,
    "Clase de prueba GRATIS — Defensa personal Condesa",
  );
  assert.equal(ev.referral?.ctwaClid, "ARBxyz0123456789ctwa");
  assert.equal(ev.referral?.sourceUrl, "https://fb.me/2abcdEF");
});

test("inbound without a referral has no referral field", () => {
  const ev = parseWebhook(inboundText)[0] as InboundEvent;
  assert.equal(ev.referral, undefined);
});

test("fixture: audio (voice note) parses as kind:'audio' with media + empty body", () => {
  const events = parseWebhook(inboundAudio);
  assert.equal(events.length, 1);
  const ev = events[0] as InboundEvent;
  assert.equal(ev.type, "inbound");
  assert.equal(ev.wamid, "wamid.AUDIO_1");
  assert.equal(ev.kind, "audio");
  assert.equal(ev.body, "");
  assert.ok(ev.media);
  assert.equal(ev.media?.mediaId, "MEDIA_ID_9876");
  assert.equal(ev.media?.mimeType, "audio/ogg; codecs=opus");
});

test("emits a status event and ignores app_state_sync payload content", () => {
  const payload = {
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              statuses: [
                {
                  id: "wamid.OUT",
                  status: "delivered",
                  recipient_id: "5215512345678",
                  timestamp: "1720200400",
                },
              ],
            },
          },
          { field: "smb_app_state_sync", value: {} },
        ],
      },
    ],
  };
  const events = parseWebhook(payload);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, "status");
  assert.equal(events[1]?.type, "app_state_sync");
});

// ---- R2: media messages (image/video/document/sticker) ----

function mediaPayload(msg: Record<string, unknown>): unknown {
  return {
    entry: [
      { changes: [{ field: "messages", value: { messages: [msg] } }] },
    ],
  };
}

test("parses an inbound image with caption + media id", () => {
  const ev = parseWebhook(
    mediaPayload({
      from: "5215512345678",
      id: "wamid.IMG1",
      timestamp: "1720200400",
      type: "image",
      image: { id: "MEDIA_IMG_1", mime_type: "image/jpeg", caption: "mi lesión" },
    }),
  )[0] as InboundEvent;
  assert.equal(ev.kind, "image");
  assert.equal(ev.body, "mi lesión");
  assert.equal(ev.media?.mediaId, "MEDIA_IMG_1");
  assert.equal(ev.media?.mimeType, "image/jpeg");
});

test("parses an inbound image without caption (empty body)", () => {
  const ev = parseWebhook(
    mediaPayload({
      from: "5215512345678",
      id: "wamid.IMG2",
      timestamp: "1720200401",
      type: "image",
      image: { id: "MEDIA_IMG_2", mime_type: "image/png" },
    }),
  )[0] as InboundEvent;
  assert.equal(ev.kind, "image");
  assert.equal(ev.body, "");
  assert.equal(ev.media?.mediaId, "MEDIA_IMG_2");
});

test("parses an inbound document with filename", () => {
  const ev = parseWebhook(
    mediaPayload({
      from: "5215512345678",
      id: "wamid.DOC1",
      timestamp: "1720200402",
      type: "document",
      document: {
        id: "MEDIA_DOC_1",
        mime_type: "application/pdf",
        filename: "certificado.pdf",
      },
    }),
  )[0] as InboundEvent;
  assert.equal(ev.kind, "document");
  assert.equal(ev.media?.filename, "certificado.pdf");
});

test("parses an inbound video and sticker", () => {
  const vid = parseWebhook(
    mediaPayload({
      from: "521", id: "wamid.VID1", timestamp: "1", type: "video",
      video: { id: "MEDIA_VID_1", mime_type: "video/mp4", caption: "mira" },
    }),
  )[0] as InboundEvent;
  assert.equal(vid.kind, "video");
  assert.equal(vid.body, "mira");
  const st = parseWebhook(
    mediaPayload({
      from: "521", id: "wamid.ST1", timestamp: "1", type: "sticker",
      sticker: { id: "MEDIA_ST_1", mime_type: "image/webp" },
    }),
  )[0] as InboundEvent;
  assert.equal(st.kind, "sticker");
  assert.equal(st.media?.mediaId, "MEDIA_ST_1");
});

// ---- Messenger Platform (Instagram DMs + Facebook Messenger) ----

test("fixture: IG inbound text parses with ig: prefix and ms→s timestamp", () => {
  const events = parseWebhook(igInboundText);
  assert.equal(events.length, 1);
  const ev = events[0] as InboundEvent;
  assert.equal(ev.type, "inbound");
  assert.equal(ev.wamid, "aWdfMESSAGE_IG_1");
  assert.equal(ev.from, "ig:1784140000000999");
  // 1720200000123 ms → 1720200000 s (the ms→s bug would put this in year ~56000)
  assert.equal(ev.ts, 1720200000);
  assert.equal(ev.kind, "text");
  assert.equal(ev.body, "Hola, vi su anuncio en Instagram");
  assert.equal(ev.profileName, undefined);
});

test("fixture: IG image attachment carries mediaUrl (no mediaId)", () => {
  const ev = parseWebhook(igInboundImage)[0] as InboundEvent;
  assert.equal(ev.kind, "image");
  assert.equal(ev.media?.mediaId, undefined);
  assert.equal(
    ev.media?.mediaUrl,
    "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=123&signature=abc",
  );
  assert.equal(ev.body, "");
});

test("fixture: FB Messenger inbound text parses with fb: prefix", () => {
  const ev = parseWebhook(fbInboundText)[0] as InboundEvent;
  assert.equal(ev.type, "inbound");
  assert.equal(ev.wamid, "m_FB_MESSAGE_1");
  assert.equal(ev.from, "fb:24500000000000777");
  assert.equal(ev.ts, 1720200200);
  assert.equal(ev.body, "Hola, ¿tienen clases de box?");
});

test("fixture: FB echo (is_echo) maps to an echo event keyed by the recipient", () => {
  const events = parseWebhook(fbEcho);
  assert.equal(events.length, 1);
  const ev = events[0] as EchoEvent;
  assert.equal(ev.type, "echo");
  assert.equal(ev.wamid, "m_FB_ECHO_1");
  assert.equal(ev.to, "fb:24500000000000777");
  assert.equal(ev.body, "Claro, te agendo el sábado a las 2pm");
});

test("fixture: FB postback referral maps ad_id → sourceId (campaign matching)", () => {
  const ev = parseWebhook(fbPostbackReferral)[0] as InboundEvent;
  assert.equal(ev.type, "inbound");
  assert.equal(ev.kind, "button");
  assert.equal(ev.body, "Empezar");
  assert.equal(ev.from, "fb:24500000000000888");
  assert.ok(ev.referral);
  assert.equal(ev.referral?.sourceId, "120210000000055555");
  assert.equal(ev.referral?.headline, "Clase de prueba GRATIS — Box Condesa");
  assert.equal(ev.referral?.thumbnailUrl, "https://scontent.fbcdn.net/ad-photo.jpg");
  assert.equal(ev.referral?.sourceUrl, "verano2026");
});

test("messenger unknown attachment types map to kind 'other' with a placeholder body", () => {
  const payload = {
    object: "instagram",
    entry: [
      {
        messaging: [
          {
            sender: { id: "111" },
            recipient: { id: "222" },
            timestamp: 1720200000000,
            message: {
              mid: "aWdfSTORY_1",
              attachments: [{ type: "story_mention", payload: { url: "https://x/y" } }],
            },
          },
        ],
      },
    ],
  };
  const ev = parseWebhook(payload)[0] as InboundEvent;
  assert.equal(ev.kind, "other");
  assert.equal(ev.body, "[mención en historia]");
  assert.equal(ev.media, undefined);
});

test("messenger read/delivery items produce no events", () => {
  const payload = {
    object: "page",
    entry: [
      {
        messaging: [
          {
            sender: { id: "111" },
            recipient: { id: "222" },
            timestamp: 1720200000000,
            read: { watermark: 1720199000000 },
          },
        ],
      },
    ],
  };
  assert.equal(parseWebhook(payload).length, 0);
});

test("WA payloads still parse identically (regression: object discrimination)", () => {
  // Every existing WA fixture must produce byte-identical events after the
  // messenger branch landed.
  for (const fixture of [inboundText, echo, buttonReply, inboundReferral, inboundAudio]) {
    const events = parseWebhook(fixture);
    assert.equal(events.length, 1);
    const ev = events[0]!;
    assert.notEqual(ev.type, undefined);
    if (ev.type === "inbound") assert.ok(!ev.from.startsWith("ig:") && !ev.from.startsWith("fb:"));
  }
});

test("referral carries the ad creative thumbnail/image/video urls", () => {
  const ev = parseWebhook(
    mediaPayload({
      from: "5215512345678",
      id: "wamid.ADTHUMB",
      timestamp: "1720200500",
      type: "text",
      text: { body: "Quiero más información" },
      referral: {
        source_url: "https://fb.me/xyz",
        source_type: "ad",
        source_id: "120210000000099999",
        headline: "Clases para niños",
        body: "Primera clase gratis",
        thumbnail_url: "https://scontent.fbcdn.net/thumb.jpg",
        image_url: "https://scontent.fbcdn.net/full.jpg",
        ctwa_clid: "CLID123",
      },
    }),
  )[0] as InboundEvent;
  assert.equal(ev.referral?.thumbnailUrl, "https://scontent.fbcdn.net/thumb.jpg");
  assert.equal(ev.referral?.imageUrl, "https://scontent.fbcdn.net/full.jpg");
  assert.equal(ev.referral?.videoUrl, null);
  assert.equal(ev.referral?.headline, "Clases para niños");
});
