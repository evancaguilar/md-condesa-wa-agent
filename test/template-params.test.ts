// Filling an approved WhatsApp template (src/services/template-params.ts).
// Every template in docs/template-submission.md declares exactly ONE body
// variable, {{1}} = first name, in a bare vocative slot ("¡Hola {{1}}!"), so
// these are the rules that decide whether a send reaches the lead or bounces
// off Graph.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bodyParams,
  CODE_PARAM_COUNT,
  CODE_TEMPLATE_MISSING,
  graphErrorCode,
  isTemplateMissingError,
  nameFallback,
  nameParam,
  sanitizeParam,
  templateFirstName,
  tpl,
} from "../src/services/template-params.js";

test("tpl appends the language suffix Meta requires", () => {
  assert.equal(tpl("human_followup", "es"), "human_followup_es");
  assert.equal(tpl("human_followup", "en"), "human_followup_en");
  // Anything that isn't "en" is Spanish — lang comes from contacts.lang.
  assert.equal(tpl("post_trial_d0", ""), "post_trial_d0_es");
  assert.equal(tpl("post_trial_d0", "es-MX"), "post_trial_d0_es");
});

test("templateFirstName keeps the first token only", () => {
  assert.equal(templateFirstName("Ana Pérez Gómez", "es"), "Ana");
  assert.equal(templateFirstName("Mike", "en"), "Mike");
});

test("templateFirstName never returns an empty parameter (Meta 131008)", () => {
  // An empty body param is rejected outright, and a huge share of contacts have
  // no usable push name. The filler has to read as a greeting on its own.
  assert.equal(templateFirstName("", "es"), "qué tal");
  assert.equal(templateFirstName(null, "es"), "qué tal");
  assert.equal(templateFirstName(undefined, "es"), "qué tal");
  assert.equal(templateFirstName("   ", "es"), "qué tal");
  assert.equal(templateFirstName("", "en"), "there");
  // …and it reads right in the approved bodies.
  assert.equal(`¡Hola ${templateFirstName("", "es")}!`, "¡Hola qué tal!");
  assert.equal(`Hi ${templateFirstName("", "en")}!`, "Hi there!");
});

test("the fallback is a plain word, never an emoji", () => {
  // 👋 renders fine but Meta accepts an emoji-only parameter inconsistently.
  for (const lang of ["es", "en"]) {
    assert.equal(/\p{Extended_Pictographic}/u.test(nameFallback(lang)), false);
    assert.ok(nameFallback(lang).length > 1);
  }
});

test("sanitizeParam strips what Meta forbids inside a parameter", () => {
  assert.equal(sanitizeParam("Ana\nPérez"), "Ana Pérez");
  assert.equal(sanitizeParam("Ana\tPérez"), "Ana Pérez");
  assert.equal(sanitizeParam("Ana\r\nPérez"), "Ana Pérez");
  assert.equal(sanitizeParam("Ana     Pérez"), "Ana Pérez");
  assert.equal(sanitizeParam("  Ana  "), "Ana");
  // A newline-bearing name still yields ONE token downstream.
  assert.equal(templateFirstName("Ana\nPérez", "es"), "Ana");
});

test("nameParam builds the one-parameter BODY component the pack expects", () => {
  assert.deepEqual(nameParam("Ana Pérez", "es"), {
    type: "body",
    parameters: [{ type: "text", text: "Ana" }],
  });
  assert.deepEqual(nameParam(null, "en"), {
    type: "body",
    parameters: [{ type: "text", text: "there" }],
  });
});

test("bodyParams fills every empty value rather than sending a blank", () => {
  assert.deepEqual(bodyParams(["Ana", ""], "es").parameters, [
    { type: "text", text: "Ana" },
    { type: "text", text: "qué tal" },
  ]);
});

test("graphErrorCode reads the bracketed code wa.ts throws", () => {
  assert.equal(
    graphErrorCode("WA send failed (400) [132001]: template does not exist"),
    CODE_TEMPLATE_MISSING,
  );
  assert.equal(
    graphErrorCode("WA send failed (400) [132000]: params do not match"),
    CODE_PARAM_COUNT,
  );
  assert.equal(graphErrorCode("WA send failed (500): boom"), null);
});

test("isTemplateMissingError separates Evan's problem from ours", () => {
  // 132001 = submit/approve it. Everything else is a bug on our side and must
  // NOT be reported as "the template isn't approved yet".
  assert.equal(isTemplateMissingError("WA send failed (400) [132001]: nope"), true);
  assert.equal(isTemplateMissingError("WA send failed (400) [132000]: nope"), false);
  assert.equal(isTemplateMissingError("WA send failed (400) [131008]: nope"), false);
  assert.equal(isTemplateMissingError("WA send failed (500): boom"), false);
  // No bracketed code → fall back to Meta's prose.
  assert.equal(isTemplateMissingError("Template name does not exist"), true);
});
