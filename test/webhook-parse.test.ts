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
