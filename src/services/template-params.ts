// Everything about FILLING an approved WhatsApp template: its language-suffixed
// name, its BODY parameters, and the Graph error codes that come back when
// either is wrong. Pure — no I/O, unit-tested.
//
// Why this module exists (audit, 2026-09-21, the day the pack was submitted to
// Meta): every template in docs/template-submission.md has exactly ONE body
// variable, `{{1}}` = first name. Three call sites disagreed with that — one
// sent no parameters at all, one sent the base name without the `_es` suffix,
// and several sent an EMPTY string for leads with no usable push name. All
// three fail at Graph, not at compile time, which is the worst place to learn.

/** Template names carry the language suffix Meta requires (one per language). */
export function tpl(base: string, lang: string): string {
  return lang === "en" ? `${base}_en` : `${base}_es`;
}

/**
 * Stand-in when we have no usable first name. Meta REJECTS an empty body
 * parameter (131008 "required parameter is missing"), and our approved bodies
 * put {{1}} in a bare vocative slot ("¡Hola {{1}}!"), so the filler has to read
 * as a greeting on its own: "¡Hola qué tal!" / "Hi there!".
 *
 * NOT an emoji. The previous filler was 👋, which renders fine but which Meta
 * accepts inconsistently for a whole-parameter value — a plain word never
 * argues.
 */
export function nameFallback(lang: string): string {
  return lang === "en" ? "there" : "qué tal";
}

/**
 * Characters Meta forbids inside a template parameter: newlines, tabs, and runs
 * of 4+ spaces all return 132000-family errors. Collapse rather than reject —
 * a name that trips this is still a name.
 */
export function sanitizeParam(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}

/**
 * The {{1}} value for a name slot: the FIRST token of the name, sanitized, or
 * the language's natural filler. `name` is expected to have already passed
 * greetingName() — this only guards the shape Meta cares about.
 */
export function templateFirstName(
  name: string | null | undefined,
  lang: string,
): string {
  const first = sanitizeParam(name ?? "").split(" ")[0] ?? "";
  return first || nameFallback(lang);
}

export interface BodyComponent {
  type: "body";
  parameters: { type: "text"; text: string }[];
}

/** A BODY component from raw values; each empty value takes the filler. */
export function bodyParams(values: string[], lang = "es"): BodyComponent {
  return {
    type: "body",
    parameters: values.map((text) => ({
      type: "text" as const,
      text: sanitizeParam(text) || nameFallback(lang),
    })),
  };
}

/** The one-parameter BODY component every template in the pack takes. */
export function nameParam(
  name: string | null | undefined,
  lang: string,
): BodyComponent {
  return {
    type: "body",
    parameters: [{ type: "text" as const, text: templateFirstName(name, lang) }],
  };
}

/**
 * The Graph error code wa.ts brackets into its throw message
 * (`WA send failed (400) [132001]: …`). null when the message carries none.
 */
export function graphErrorCode(message: string): number | null {
  const m = /\[(\d+)\]/.exec(message);
  return m ? Number(m[1]) : null;
}

/** 132001: the template name/language pair does not exist on the WABA. */
export const CODE_TEMPLATE_MISSING = 132001;
/** 132000: the number of parameters sent ≠ the number the template declares. */
export const CODE_PARAM_COUNT = 132000;
/** 131008: a required parameter was missing (e.g. an empty-string value). */
export const CODE_PARAM_MISSING = 131008;

/**
 * True when the error means "submit/approve this template", as opposed to any
 * other Graph failure. Only 132001 (and Meta's prose for it, when no code is
 * bracketed) qualifies — a param-count bug is OUR bug and must not be filed
 * under "the template isn't approved yet".
 */
export function isTemplateMissingError(message: string): boolean {
  const code = graphErrorCode(message);
  if (code !== null) return code === CODE_TEMPLATE_MISSING;
  return /does not exist|not exist in the translation|Template name/i.test(message);
}
