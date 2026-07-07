import { test } from "node:test";
import assert from "node:assert/strict";
import { compileSafetyPatterns, matchesSafety } from "../src/pipeline/safety.js";
import type { SafetyConfig } from "../src/client-config.js";

// Mirrors the IAsmin client's crisis patterns (clients/iasmin/client.mjs).
const cfg: SafetyConfig = {
  patterns: [
    "suicid",
    "autolesion|auto lesion|cortarme|lastimarme|hacerme dano",
    "\\bmatarme\\b|quitarme la vida|acabar con todo|terminar con todo",
    "no quiero (vivir|existir|seguir|despertar)",
    "quiero desaparecer|quiero morir|me quiero morir|mejor no estar",
    "me esta pegando|me pega\\b|me golpea|me amenaza|tengo miedo de el|tengo miedo de ella",
    "abuso|me violo|violacion",
    "ataque de panico|no puedo respirar|crisis de panico",
    // note: normalizeText turns "don't" into "don t" (punctuation → space)
    "self harm|kill myself|end it all|suicide|want to die|don ?t want to (live|exist)",
  ],
  responseEs: "…",
  responseEn: "…",
  pauseHours: 24,
};

const patterns = compileSafetyPatterns(cfg);

test("crisis phrases match (case/diacritic-insensitive)", () => {
  const hits = [
    "Ya no quiero vivir",
    "He pensado en el suicidio",
    "quiero desaparecer de todo",
    "Me quiero morir.",
    "a veces pienso en MATARME",
    "mi esposo me golpea",
    "estoy teniendo un ataque de pánico y no puedo respirar",
    "I don't want to live anymore",
    "sufrí una violación hace años", // "violacion" after normalization
    "quisiera cortarme",
  ];
  for (const h of hits) {
    assert.ok(matchesSafety(h, patterns), `should match: ${h}`);
  }
});

test("ordinary companion-conversation messages do NOT match", () => {
  const misses = [
    "hola, ¿cómo estás?",
    "no puedo dejar de trabajar y me siento vacía",
    "me siento muy cansada esta semana",
    "quiero vivir más tranquila",
    "¿me recuerdas la meditación de anclaje?",
    "mi jefe me estresa muchísimo",
    "hoy sí hice la práctica de la semana",
    "vivo con mucha presión pero ahí voy",
  ];
  for (const m of misses) {
    assert.ok(!matchesSafety(m, patterns), `should NOT match: ${m}`);
  }
});

test("empty and whitespace bodies never match", () => {
  assert.ok(!matchesSafety("", patterns));
  assert.ok(!matchesSafety("   ", patterns));
  assert.ok(!matchesSafety("🙂", patterns));
});

test("no patterns → never matches", () => {
  assert.ok(!matchesSafety("no quiero vivir", []));
});
