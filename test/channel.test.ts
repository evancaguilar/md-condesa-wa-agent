import { test } from "node:test";
import assert from "node:assert/strict";
import {
  channelOf,
  platformId,
  displayContact,
  planMessengerSend,
  ChannelCapabilityError,
} from "../src/services/channel.js";
import { messengerReminderText } from "../src/cron/followups.js";

// ---- channelOf / platformId / displayContact ----

test("channelOf derives the channel from the id prefix", () => {
  assert.equal(channelOf("5215512345678"), "wa");
  assert.equal(channelOf("ig:1784140000000999"), "ig");
  assert.equal(channelOf("fb:24500000000000777"), "fb");
  assert.equal(channelOf(""), "wa");
});

test("platformId strips the channel prefix for Graph calls", () => {
  assert.equal(platformId("ig:1784140000000999"), "1784140000000999");
  assert.equal(platformId("fb:245"), "245");
  assert.equal(platformId("5215512345678"), "5215512345678");
});

test("displayContact labels non-WA contacts and shortens long ids", () => {
  assert.equal(displayContact("5215512345678"), "5215512345678");
  assert.equal(displayContact("ig:1784140000000999"), "IG 17841…0999");
  assert.equal(displayContact("fb:245"), "FB 245");
});

// ---- planMessengerSend window math ----

const NOW = 1_720_200_000;
const H = 3600;

test("planMessengerSend: <24h → free", () => {
  assert.equal(planMessengerSend(NOW - 1, NOW), "free");
  assert.equal(planMessengerSend(NOW - (23 * H + 59 * 60), NOW), "free");
});

test("planMessengerSend: 24h–7d → human_agent", () => {
  assert.equal(planMessengerSend(NOW - 24 * H, NOW), "human_agent");
  assert.equal(planMessengerSend(NOW - 25 * H, NOW), "human_agent");
  assert.equal(planMessengerSend(NOW - (7 * 24 * H - 1), NOW), "human_agent");
});

test("planMessengerSend: ≥7d or no inbound ever → blocked", () => {
  assert.equal(planMessengerSend(NOW - 7 * 24 * H, NOW), "blocked");
  assert.equal(planMessengerSend(NOW - 8 * 24 * H, NOW), "blocked");
  assert.equal(planMessengerSend(null, NOW), "blocked");
  assert.equal(planMessengerSend(0, NOW), "blocked");
  assert.equal(planMessengerSend(undefined, NOW), "blocked");
});

// ---- ChannelCapabilityError ----

test("ChannelCapabilityError names the channel and capability", () => {
  const err = new ChannelCapabilityError("ig:123", "template send");
  assert.equal(err.name, "ChannelCapabilityError");
  assert.equal(err.phone, "ig:123");
  assert.ok(/template send/.test(err.message));
  assert.ok(/ig/.test(err.message));
});

// ---- messengerReminderText (free-form stand-ins for WA templates) ----

test("messengerReminderText uses the first name and both languages", () => {
  const es = messengerReminderText("day_before", "Karla Pérez", "es");
  assert.ok(/Karla/.test(es));
  assert.ok(!es.includes("Pérez"));
  assert.ok(/mañana/i.test(es));
  const en = messengerReminderText("same_day", "", "en");
  assert.ok(/trial class/i.test(en));
  assert.ok(!en.includes("undefined"));
});

test("messengerReminderText no_show reuses the client no-show copy with link", () => {
  const es = messengerReminderText("no_show", "Ana", "es");
  assert.ok(/https?:\/\//.test(es));
});
