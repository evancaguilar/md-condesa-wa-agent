import { test } from "node:test";
import assert from "node:assert/strict";

import {
  findSavedVideo,
  publicSavedVideos,
  resolveCaption,
  savedVideoNote,
  savedVideoStatus,
  sendSavedVideo,
  SAVED_VIDEO_CAPTION_MAX,
  type SavedVideoDeps,
} from "../src/services/saved-videos.js";
import type { SavedVideo } from "../src/client-config.js";
import { CLIENT } from "../src/client.gen.js";
import type { Env } from "../src/types.js";

const VIDEOS: SavedVideo[] = [
  { id: "tour", label: "Tour de la academia", url: "https://mdcondesa.com/media/tour-academia.mp4" },
  { id: "fer", label: "Fer se presenta", url: "https://mdcondesa.com/media/fer.mp4", caption: "¡Hola! Soy Fer 👋" },
];

const PHONE = "5215512345678";

// Minimal fake D1: answers getContact's SELECT; records every SQL it sees so a
// test can assert no takeover/approval writes happen.
function envWithContact(contact: Record<string, unknown> | null): { env: Env; sqls: string[] } {
  const sqls: string[] = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        bind: () => stmt,
        async first() {
          sqls.push(sql);
          return contact;
        },
        async run() {
          sqls.push(sql);
          return { results: [], meta: { changes: 1 } };
        },
        async all() {
          sqls.push(sql);
          return { results: [], meta: {} };
        },
      };
      return stmt;
    },
  };
  return { env: { DB: db } as unknown as Env, sqls };
}

function makeDeps(over: Partial<SavedVideoDeps> = {}) {
  const log = {
    sends: [] as { phone: string; url: string; caption?: string; meta: Record<string, unknown> }[],
    notes: [] as string[],
  };
  const deps: SavedVideoDeps = {
    videos: VIDEOS,
    async sendVideo(_e, phone, url, caption, meta) {
      log.sends.push({ phone, url, caption, meta });
      return "wamid.VID1";
    },
    isWindowClosed: (err) => err instanceof Error && err.name === "WindowClosedError",
    async postNote(text) {
      log.notes.push(text);
    },
    ...over,
  };
  return { deps, log };
}

test("findSavedVideo: exact id match, null for unknown / non-string", () => {
  assert.equal(findSavedVideo(VIDEOS, "tour")?.label, "Tour de la academia");
  assert.equal(findSavedVideo(VIDEOS, "TOUR"), null);
  assert.equal(findSavedVideo(VIDEOS, 3), null);
  assert.equal(findSavedVideo(undefined, "tour"), null);
});

test("publicSavedVideos exposes id + label only (no url/caption)", () => {
  assert.deepEqual(publicSavedVideos(VIDEOS), [
    { id: "tour", label: "Tour de la academia" },
    { id: "fer", label: "Fer se presenta" },
  ]);
  assert.deepEqual(publicSavedVideos(undefined), []);
});

test("resolveCaption: override wins, else configured default, blank → ''", () => {
  assert.equal(resolveCaption(VIDEOS[1]!, "  mira esto "), "mira esto");
  assert.equal(resolveCaption(VIDEOS[1]!, ""), "¡Hola! Soy Fer 👋");
  assert.equal(resolveCaption(VIDEOS[0]!, undefined), "");
});

test("savedVideoNote + savedVideoStatus", () => {
  assert.equal(
    savedVideoNote("Fer", "Tour de la academia", "Ana (5215512345678)"),
    "📹 Fer envió el video 'Tour de la academia' a Ana (5215512345678)",
  );
  assert.equal(savedVideoStatus({ ok: true, wamid: "w", id: "tour", label: "x" }), 200);
  assert.equal(savedVideoStatus({ ok: false, reason: "unknown_video" }), 404);
  assert.equal(savedVideoStatus({ ok: false, reason: "too_long" }), 400);
  assert.equal(savedVideoStatus({ ok: false, reason: "window_closed" }), 200);
});

test("sendSavedVideo: sends by link as a bot send with savedVideo/by meta, notes ops, no takeover", async () => {
  const { env, sqls } = envWithContact({ phone: PHONE, status: "lead", name: "Ana" });
  const { deps, log } = makeDeps();
  const r = await sendSavedVideo(env, PHONE, { id: "tour" }, "Fer", deps);
  assert.deepEqual(r, { ok: true, wamid: "wamid.VID1", id: "tour", label: "Tour de la academia" });
  assert.deepEqual(log.sends, [
    {
      phone: PHONE,
      url: "https://mdcondesa.com/media/tour-academia.mp4",
      caption: undefined,
      meta: { savedVideo: "tour", by: "Fer" },
    },
  ]);
  assert.deepEqual(log.notes, ["📹 Fer envió el video 'Tour de la academia' a Ana (5215512345678)"]);
  // Only the contact read — no human_override / pending_approvals writes.
  assert.equal(sqls.length, 1);
  assert.match(sqls[0]!, /SELECT/i);
});

test("sendSavedVideo: default caption rides along", async () => {
  const { env } = envWithContact({ phone: PHONE, status: "lead", name: null });
  const { deps, log } = makeDeps();
  await sendSavedVideo(env, PHONE, { id: "fer" }, "Evan", deps);
  assert.equal(log.sends[0]!.caption, "¡Hola! Soy Fer 👋");
  assert.equal(log.notes[0], `📹 Evan envió el video 'Fer se presenta' a ${PHONE}`);
});

test("sendSavedVideo: unknown id → unknown_video, nothing sent", async () => {
  const { env, sqls } = envWithContact({ phone: PHONE, status: "lead" });
  const { deps, log } = makeDeps();
  assert.deepEqual(await sendSavedVideo(env, PHONE, { id: "nope" }, "Fer", deps), {
    ok: false,
    reason: "unknown_video",
  });
  assert.equal(log.sends.length, 0);
  assert.equal(sqls.length, 0);
});

test("sendSavedVideo: opted-out and unknown contacts are refused", async () => {
  const { deps, log } = makeDeps();
  const optedOut = envWithContact({ phone: PHONE, status: "opted_out" });
  assert.deepEqual(await sendSavedVideo(optedOut.env, PHONE, { id: "tour" }, "Fer", deps), {
    ok: false,
    reason: "opted_out",
  });
  const none = envWithContact(null);
  assert.deepEqual(await sendSavedVideo(none.env, PHONE, { id: "tour" }, "Fer", deps), {
    ok: false,
    reason: "no_contact",
  });
  assert.equal(log.sends.length, 0);
  assert.equal(log.notes.length, 0);
});

test("sendSavedVideo: closed 24h window → window_closed (no template fallback), no note", async () => {
  const { env } = envWithContact({ phone: PHONE, status: "lead" });
  const { deps, log } = makeDeps({
    async sendVideo() {
      const e = new Error("closed");
      e.name = "WindowClosedError";
      throw e;
    },
  });
  assert.deepEqual(await sendSavedVideo(env, PHONE, { id: "tour" }, "Fer", deps), {
    ok: false,
    reason: "window_closed",
  });
  assert.equal(log.notes.length, 0);
});

test("sendSavedVideo: other Graph errors propagate", async () => {
  const { env } = envWithContact({ phone: PHONE, status: "lead" });
  const { deps } = makeDeps({
    async sendVideo() {
      throw new Error("WA send failed (500)");
    },
  });
  await assert.rejects(() => sendSavedVideo(env, PHONE, { id: "tour" }, "Fer", deps), /500/);
});

test("sendSavedVideo: over-long caption → too_long", async () => {
  const { env } = envWithContact({ phone: PHONE, status: "lead" });
  const { deps, log } = makeDeps();
  const r = await sendSavedVideo(
    env,
    PHONE,
    { id: "tour", caption: "x".repeat(SAVED_VIDEO_CAPTION_MAX + 1) },
    "Fer",
    deps,
  );
  assert.deepEqual(r, { ok: false, reason: "too_long" });
  assert.equal(log.sends.length, 0);
});

test("sendSavedVideo: a failing ops note never fails the send", async () => {
  const { env } = envWithContact({ phone: PHONE, status: "lead" });
  const { deps } = makeDeps({
    async postNote() {
      throw new Error("slack down");
    },
  });
  const r = await sendSavedVideo(env, PHONE, { id: "tour" }, "Fer", deps);
  assert.equal(r.ok, true);
});

test("compiled client config carries savedVideos (compile-kb whitelist)", () => {
  const tour = findSavedVideo(CLIENT.savedVideos, "tour");
  assert.ok(tour, "savedVideos.tour missing from client.gen.ts — whitelist in tools/compile-kb.mjs?");
  assert.match(tour?.url ?? "", /^https:\/\/.+\.mp4$/);
});
