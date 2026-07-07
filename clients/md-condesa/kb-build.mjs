// MD Condesa — custom KB builder (client-specific, zero deps).
//
// Mirrors the ethos of the site's tools/build.js: reads the canonical site
// sources (schedule + NAP + content pages) plus this client's intake.md and
// returns a tight bilingual markdown KB body + the flattened booking slots.
//
// Invoked by tools/compile-kb.mjs when this file exists in the client folder:
//   buildKb({ intake, cfg }) → { body, slots, sources }
//
// Fuentes:
//   - ../md-condesa-site/js/schedule-data.js   (browser IIFE → window shim)
//   - ../md-condesa-site/content/site.js        (CommonJS NAP)
//   - ../md-condesa-site/content/pages/*.js      (disciplinas + FAQs)
//   - ../md-condesa-site/content/en-hub.js       (hub EN)
//   - ../md-condesa-site/content/founder.js      (confianza / linaje)
//   - clients/md-condesa/intake.md               (precios, VERBATIM)

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const SITE_LOCAL = join(REPO, "..", "md-condesa-site");
const SITE_ORIGIN = "https://mdcondesa.com";

// ---- source loaders (local sibling first, else fetch) --------------------

/** Fetch text from the live site (build-time only; Node v24 has global fetch). */
async function fetchText(pathname) {
  const res = await fetch(SITE_ORIGIN + pathname);
  if (!res.ok) throw new Error(`fetch ${pathname} → HTTP ${res.status}`);
  return await res.text();
}

/** Load a source file's raw text, preferring the local sibling checkout. */
async function loadSource(relPath, urlPath) {
  const local = join(SITE_LOCAL, relPath);
  if (existsSync(local)) return readFileSync(local, "utf8");
  return await fetchText(urlPath);
}

/** Evaluate the schedule IIFE with a window shim and return {MD_SCHEDULE, I18N}. */
function evalSchedule(code) {
  const win = {};
  // The file is an IIFE assigning window.MD_SCHEDULE / _I18N / _TIME.
  new Function("window", code)(win);
  if (!win.MD_SCHEDULE || !win.MD_SCHEDULE_I18N) {
    throw new Error("schedule-data.js did not populate window.MD_SCHEDULE*");
  }
  return { schedule: win.MD_SCHEDULE, i18n: win.MD_SCHEDULE_I18N };
}

/** Evaluate a CommonJS module's source and return its module.exports. */
function evalCjs(code) {
  const mod = { exports: {} };
  new Function("module", "exports", code)(mod, mod.exports);
  return mod.exports;
}

// ---- schedule rendering --------------------------------------------------

/** "7:00 AM" from a 24h hour, honoring an explicit slot.t label. */
function fmtTime(slot) {
  if (slot.t) return slot.t;
  const h = slot.h;
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${ampm}`;
}

/** "HH:mm" (24h) from a slot — used for the machine-readable slots. */
function hhmm(slot) {
  return String(slot.h).padStart(2, "0") + ":00";
}

/** Human label for one class within a slot, in the given language. */
function classLabel(cls, i18n, lang) {
  const t = i18n[lang];
  let name = t.progName[cls.n] || cls.n;
  const bits = [];
  if (cls.n === "jiu" && cls.v) bits.push(cls.v === "gi" ? t.gi : t.nogi);
  if (cls.a) bits.push(t.aud[cls.a] || cls.a);
  if (cls.l) bits.push(cls.l);
  if (cls.s) bits.push(t.sparring);
  return bits.length ? `${name} (${bits.join(", ")})` : name;
}

/**
 * Render the schedule TWICE: grouped by discipline (what leads ask — "when is
 * Muay Thai?") and by day. Compact one-liners keep the KB tight.
 */
function renderSchedule(schedule, i18n, lang) {
  const t = i18n[lang];
  const order = schedule.order;
  const days = schedule.days;

  // --- by discipline ---
  // program → day → [time labels]
  const byProg = {};
  for (const day of order) {
    for (const slot of days[day] || []) {
      for (const cls of slot.c) {
        (byProg[cls.n] ||= {});
        (byProg[cls.n][day] ||= []).push({ time: fmtTime(slot), cls });
      }
    }
  }

  const progLines = [];
  // Stable, lead-relevant program order.
  const progOrder = ["jiu", "muay", "mma", "box", "baby"];
  for (const p of progOrder) {
    if (!byProg[p]) continue;
    const dayParts = [];
    for (const day of order) {
      const entries = byProg[p][day];
      if (!entries) continue;
      // Collapse to "Lun 7 AM, 8 AM, 6 PM (Kids)" — dedupe identical time labels,
      // append audience/variant hints only when non-adult/non-plain.
      const labels = entries.map((e) => {
        const extra = classExtra(e.cls, i18n, lang);
        return extra ? `${e.time} ${extra}` : e.time;
      });
      dayParts.push(`${t.dayShort[day]} ${labels.join(", ")}`);
    }
    progLines.push(`- **${t.progName[p]}**: ${dayParts.join(" · ")}`);
  }

  // --- by day ---
  const dayLines = [];
  for (const day of order) {
    const slots = days[day] || [];
    if (!slots.length) {
      dayLines.push(`- **${t.dayFull[day]}**: ${t.closed}`);
      continue;
    }
    const parts = slots.map((slot) => {
      const classes = slot.c.map((c) => classLabel(c, i18n, lang)).join(" / ");
      return `${fmtTime(slot)} ${classes}`;
    });
    dayLines.push(`- **${t.dayFull[day]}**: ${parts.join("; ")}`);
  }

  return { progLines, dayLines, sparNote: t.sparNote };
}

/** Parenthetical variant/audience hint for the by-discipline view (or ""). */
function classExtra(cls, i18n, lang) {
  const t = i18n[lang];
  const bits = [];
  if (cls.n === "jiu" && cls.v) bits.push(cls.v === "gi" ? t.gi : t.nogi);
  if (cls.a) bits.push(t.aud[cls.a] || cls.a);
  if (cls.l) bits.push(cls.l);
  if (cls.s) bits.push(t.sparring);
  return bits.length ? `(${bits.join(", ")})` : "";
}

// ---- slots (machine-readable, for validateSlot) --------------------------

// The model resolves relative dates to a weekday; the executor maps that
// weekday to schedule days via this order-index. 0 = Monday … 6 = Sunday.
const WEEKDAY_KEYS = ["lun", "mar", "mie", "jue", "vie", "sab", "dom"];

/** Audience of a class: 'kid' for kids/teens/mini, else 'adult'. */
function audienceOf(cls) {
  return cls.a ? "kid" : "adult";
}

/**
 * Flatten the schedule into valid booking slots. One entry per
 * (weekday, time, discipline, audience). Discipline is the compact program key
 * (jiu/muay/mma/box/baby) so validateSlot can match the model's tool input.
 */
function buildSlots(schedule) {
  const slots = [];
  const seen = new Set();
  for (const day of schedule.order) {
    const idx = WEEKDAY_KEYS.indexOf(day);
    for (const slot of schedule.days[day] || []) {
      for (const cls of slot.c) {
        const key = `${idx}|${hhmm(slot)}|${cls.n}|${audienceOf(cls)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        slots.push({
          weekday: idx, // 0=Mon … 6=Sun
          time: hhmm(slot), // "HH:mm" 24h CDMX
          discipline: cls.n, // jiu|muay|mma|box|baby
          audience: audienceOf(cls), // 'adult'|'kid'
        });
      }
    }
  }
  return slots;
}

// ---- content curation (distilled, not dumped) ----------------------------

const stripHtml = (s) => (s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

/**
 * Distill discipline blurbs + a few FAQs. We keep the lead (one sentence) and
 * up to `faqMax` FAQs per page, ES + EN, to stay tight.
 */
function curatePages(pages) {
  const blurbEs = [];
  const blurbEn = [];
  const faqEs = [];
  const faqEn = [];
  const faqMax = 1; // one distilled FAQ per discipline keeps the KB tight

  // Only the disciplines a lead asks about; skip drop-in (folded into policies).
  const order = [
    "jiu-jitsu",
    "muay-thai",
    "mma",
    "box",
    "defensa-personal",
    "defensa-personal-mujeres",
    "clases-para-ninos",
    "baby-fight-club",
  ];
  const byslug = new Map(pages.map((p) => [p.slug, p]));

  for (const slug of order) {
    const p = byslug.get(slug);
    if (!p) continue;
    if (p.es) {
      blurbEs.push(`- **${stripHtml(p.es.h1 || p.es.serviceName)}**: ${stripHtml(p.es.lead)}`);
      for (const f of (p.es.faqs || []).slice(0, faqMax)) {
        faqEs.push(`- **${stripHtml(f.q)}** ${stripHtml(f.a)}`);
      }
    }
    if (p.en) {
      blurbEn.push(`- **${stripHtml(p.en.h1 || p.en.serviceName)}**: ${stripHtml(p.en.lead)}`);
      for (const f of (p.en.faqs || []).slice(0, faqMax)) {
        faqEn.push(`- **${stripHtml(f.q)}** ${stripHtml(f.a)}`);
      }
    }
  }
  return { blurbEs, blurbEn, faqEs, faqEn };
}

/** One-paragraph founder/trust distillation (ES + EN). */
function curateFounder(f) {
  const es = f.es
    ? `${stripHtml(f.es.lead)} ${stripHtml(f.es.pullQuote || "")}`.trim()
    : "";
  const en = f.en
    ? `${stripHtml(f.en.lead)} ${stripHtml(f.en.pullQuote || "")}`.trim()
    : "";
  return { es, en };
}

/** Load content pages/en-hub/founder from the local sibling (best effort). */
function loadContent() {
  const pagesDir = join(SITE_LOCAL, "content", "pages");
  const pages = [];
  if (existsSync(pagesDir)) {
    for (const f of readdirSync(pagesDir).filter((n) => n.endsWith(".js")).sort()) {
      pages.push(evalCjs(readFileSync(join(pagesDir, f), "utf8")));
    }
  }
  const enHubPath = join(SITE_LOCAL, "content", "en-hub.js");
  const enHub = existsSync(enHubPath) ? evalCjs(readFileSync(enHubPath, "utf8")) : {};
  const founderPath = join(SITE_LOCAL, "content", "founder.js");
  const founder = existsSync(founderPath) ? evalCjs(readFileSync(founderPath, "utf8")) : {};
  return { pages, enHub, founder };
}

// ---- assembly ------------------------------------------------------------

function assembleMarkdown({ cfg, site, schedEs, schedEn, curated, founderTxt, intake }) {
  const nap = site.address;
  const lines = [];

  lines.push(`# MD Self Defense Academy Condesa — Knowledge Base`);
  lines.push("");
  lines.push(
    `Academia de artes marciales (Jiu-Jitsu, Muay Thai, MMA, Box) en la Condesa, CDMX. Linaje directo Renzo Gracie. Bilingüe: español (principal) e inglés. Este KB es la única fuente de datos del bot: horario, contacto, disciplinas, confianza y precios.`,
  );
  lines.push("");

  // --- Contacto / NAP ---
  lines.push(`## Contacto y ubicación`);
  lines.push("");
  lines.push(`- **Nombre**: ${site.name}`);
  lines.push(`- **Dirección**: ${nap.display} (CP ${nap.postalCode})`);
  lines.push(`- **Referencia**: ${nap.landmark.es} / ${nap.landmark.en}`);
  lines.push(`- **WhatsApp / teléfono**: ${site.phoneDisplay}`);
  lines.push(`- **Google Maps**: ${site.mapsUrl}`);
  lines.push(`- **Instagram**: ${site.instagram}`);
  lines.push(`- **Agendar clase de prueba (adultos)**: ${cfg.links.booking}`);
  lines.push(`- **Agendar clase de prueba (niños)**: ${cfg.links.bookingKids}`);
  lines.push("");

  // --- Horario ES ---
  lines.push(`## Horario (America/Mexico_City)`);
  lines.push("");
  // ES: by-discipline (how leads ask "¿cuándo hay Muay Thai?") + by-day.
  lines.push(`### Por disciplina`);
  lines.push(...schedEs.progLines);
  lines.push("");
  lines.push(`### Por día`);
  lines.push(...schedEs.dayLines);
  lines.push("");
  lines.push(`> ${schedEs.sparNote}`);
  lines.push("");
  // EN: compact by-discipline only (the by-day ES grid above is the full grid;
  // EN readers get the same data condensed to disciplines to save tokens).
  lines.push(`### Schedule (English, by discipline)`);
  lines.push(...schedEn.progLines);
  lines.push("");

  // --- Disciplinas ---
  lines.push(`## Disciplinas`);
  lines.push("");
  lines.push(`### Español`);
  lines.push(...curated.blurbEs);
  lines.push("");
  lines.push(`### English`);
  lines.push(...curated.blurbEn);
  lines.push("");

  // --- Confianza / fundador ---
  lines.push(`## Fundador y confianza`);
  lines.push("");
  if (founderTxt.es) lines.push(`- ${founderTxt.es}`);
  if (founderTxt.en) lines.push(`- ${founderTxt.en}`);
  lines.push("");

  // --- FAQs ---
  lines.push(`## Preguntas frecuentes`);
  lines.push("");
  lines.push(`### Español`);
  lines.push(...curated.faqEs);
  lines.push("");
  lines.push(`### English`);
  lines.push(...curated.faqEn);
  lines.push("");

  // --- Precios (intake VERBATIM) ---
  lines.push(`## Precios y políticas`);
  lines.push("");
  lines.push(intake.trim());
  lines.push("");

  return lines.join("\n");
}

/** Entry point called by tools/compile-kb.mjs. */
export async function buildKb({ intake, cfg }) {
  const scheduleCode = await loadSource("js/schedule-data.js", "/js/schedule-data.js");
  const { schedule, i18n } = evalSchedule(scheduleCode);

  const siteCode = await loadSource("content/site.js", "/content/site.js");
  const site = evalCjs(siteCode);

  // Content pages: load from local sibling only (fetching each raw .js from the
  // live site isn't served — they're compiled into HTML). If the sibling is
  // absent we degrade to schedule+contact+intake, which is still a usable KB.
  const { pages, founder } = loadContent();

  const schedEs = renderSchedule(schedule, i18n, "es");
  const schedEn = renderSchedule(schedule, i18n, "en");
  const curated = curatePages(pages);
  const founderTxt = curateFounder(founder);
  const slots = buildSlots(schedule);

  const body = assembleMarkdown({
    cfg,
    site,
    schedEs,
    schedEn,
    curated,
    founderTxt,
    intake,
  });

  return {
    body,
    slots,
    sources: "schedule-data.js, site.js, content/pages/*, en-hub.js, founder.js, intake.md",
  };
}
