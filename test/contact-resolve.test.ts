import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveCandidates, resolveContactPhone } from "../src/db/queries-admin.js";
import { dashboardChatUrl } from "../src/services/dashboard-link.js";
import { draftBlocks } from "../src/services/slack.js";
import type { Env } from "../src/types.js";

test("resolveCandidates: shapes of an MX mobile", () => {
  const want = ["5215512345678", "525512345678"];
  assert.deepEqual(resolveCandidates("+5215512345678"), want);
  assert.deepEqual(resolveCandidates("+525512345678"), ["5215512345678", "525512345678"]);
  const bare = ["5215512345678", "5512345678", "525512345678"];
  assert.deepEqual(resolveCandidates("55 1234 5678"), bare);
  assert.deepEqual(resolveCandidates("5512345678"), bare);
});

test("resolveCandidates: non-phones yield nothing", () => {
  assert.deepEqual(resolveCandidates("ig:123456789012"), []);
  assert.deepEqual(resolveCandidates("fb:1234567890123"), []);
  assert.deepEqual(resolveCandidates("12345"), []);
  assert.deepEqual(resolveCandidates(""), []);
});

function fakeDb(exact: string[], loose: string[]) {
  const sqls: string[] = [];
  const db = {
    prepare(sql: string) {
      sqls.push(sql);
      const rows = /IN \(/.test(sql) ? exact : loose;
      const stmt = {
        bind() {
          return stmt;
        },
        async all() {
          return { results: rows.map((phone) => ({ phone })) };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, sqls };
}

test("resolveContactPhone: exact hit skips the last10 query", async () => {
  const f = fakeDb(["5215512345678"], ["x"]);
  const r = await resolveContactPhone(f.db, "+52 55 1234 5678");
  assert.deepEqual(r, { ok: true, phone: "5215512345678", via: "exact" });
  assert.equal(f.sqls.length, 1);
});

test("resolveContactPhone: last10 hit, ambiguous, not_found, invalid", async () => {
  assert.deepEqual(await resolveContactPhone(fakeDb([], ["525512345678"]).db, "5512345678"), {
    ok: true,
    phone: "525512345678",
    via: "last10",
  });
  assert.deepEqual(await resolveContactPhone(fakeDb([], ["a", "b"]).db, "5512345678"), {
    ok: false,
    reason: "ambiguous",
  });
  const nf = fakeDb([], []);
  assert.deepEqual(await resolveContactPhone(nf.db, "5512345678"), { ok: false, reason: "not_found" });
  assert.equal(nf.sqls.length, 2);
  assert.match(nf.sqls[1]!, /substr\(phone,-10\) = \?1/);
  const inv = fakeDb([], []);
  assert.deepEqual(await resolveContactPhone(inv.db, "ig:99"), { ok: false, reason: "invalid" });
  assert.equal(inv.sqls.length, 0);
});

test("dashboardChatUrl: digits, base override, ig/fb null", () => {
  const env = {} as Env;
  assert.equal(
    dashboardChatUrl(env, "5215512345678"),
    "https://md-condesa-wa-agent.evancaguilar.workers.dev/admin#chats/5215512345678",
  );
  assert.equal(
    dashboardChatUrl({ DASHBOARD_URL: "https://x.test/" } as unknown as Env, "+52 55"),
    "https://x.test/admin#chats/5255",
  );
  assert.equal(dashboardChatUrl(env, "ig:123"), null);
  assert.equal(dashboardChatUrl(env, ""), null);
});

test("approval card context line carries the dashboard link", () => {
  const approval = {
    id: 1,
    phone: "5215512345678",
    draft: "hola",
    confidence: "high",
    contextText: "",
  } as unknown as Parameters<typeof draftBlocks>[0];
  const withLink = JSON.stringify(
    draftBlocks(approval, "Ana", 5, null, null, "https://h/admin#chats/5215512345678"),
  );
  assert.match(withLink, /<https:\/\/h\/admin#chats\/5215512345678\|💬 Abrir en el panel>/);
  assert.doesNotMatch(JSON.stringify(draftBlocks(approval, "Ana", 5, null, null)), /Abrir en el panel/);
});
