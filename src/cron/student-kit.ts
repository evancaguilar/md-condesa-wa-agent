// Student kit (owner, 2026-10-13): when the front desk marks a lead
// "Se inscribió", the bot already sends the welcome; ~90 s later this row
// (followups kind `student_kit`, armed by processResult's enrolled branch)
// sends the new student their personal check-in QR as an image and, when
// Airtable says the responsiva is not signed yet, the signing link. Open 24h
// window → free-form; closed → the student_qr / student_responsiva Utility
// templates (docs/templates.md §17–18, self-submitted by
// template-seed-student.ts).
//
// Why a delayed row and not inline in processResult: the Alumnos record is
// created by an Airtable automation reacting to the same "Se inscribió", so it
// usually does not exist yet when the result watcher fires. The row polls the
// lead's `Alumnos` link every 5 min for ~1h before handing it to a human.
//
// This module holds the decision logic and runs it against an injected `KitIo`
// (followups.ts wires the real Airtable / Graph / D1 calls) so the whole flow is
// unit-testable without a network or a database.

import type { Followup } from "../types.js";
import { tpl } from "../services/template-params.js";
import { shiftOutOfQuiet } from "./quiet.js";

export const STUDENT_KIT_KIND = "student_kit";
/** Gap after the welcome: lets the Airtable automations create the Alumno + QR. */
export const STUDENT_KIT_DELAY = 90;
/** Alumno not linked yet: poll every 5 min, 12 times (~1h), then a human. */
export const ALUMNO_RETRY_EVERY = 5 * 60;
export const ALUMNO_MAX_ATTEMPTS = 12;
/** Template rejected / not approved yet: retry every 6h, 6 times (~1.5 days). */
export const TEMPLATE_RETRY_EVERY = 6 * 3600;
export const TEMPLATE_MAX_ATTEMPTS = 6;
/** Any other send failure (Graph hiccup, media upload): +5 min, 3 times. */
export const ERROR_RETRY_EVERY = 5 * 60;
export const ERROR_MAX_ATTEMPTS = 3;

/** Airtable names (verified against appcX38TBVltyxHR6, 2026-10-13). */
export const ALUMNOS_TABLE = "Alumnos";
/** Link field on Leads → the Alumno(s) the "Se inscribió" automation created. */
export const LEAD_ALUMNOS_FIELD = "Alumnos";
export const ALUMNO_FIELDS = {
  name: "Alumno",
  qrShared: "QR Compartido",
  responsivaOk: "Responsiva OK",
  responsivaLink: "Link Responsiva",
} as const;

/** One kit per Alumno, ever — a re-marked lead or a duplicate row stays silent. */
export function kitGuardKey(alumnoId: string): string {
  return `student_kit:${alumnoId}`;
}

/** The responsiva worker links a signed waiver by `rid` alone; n/t/e only prefill. */
export function responsivaFallbackLink(alumnoId: string): string {
  return `https://responsiva.mdcondesa.com/?rid=${encodeURIComponent(alumnoId)}`;
}

export interface AlumnoInfo {
  id: string;
  name: string;
  qrShared: boolean;
  responsivaSigned: boolean;
  /** Full prefilled signing link (formula), or the rid-only fallback. */
  responsivaLink: string;
}

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  // Formula fields can come back as {specialValue}/{error} objects — treat as empty.
  return "";
}

/** Pure. First record id of an Airtable link field value (array of ids). */
export function firstLinkedId(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  const id = v.find((x) => typeof x === "string" && /^rec[A-Za-z0-9]{14}$/.test(x));
  return (id as string | undefined) ?? null;
}

/** Pure. `Responsiva OK` is "✅" when signed, "⚠️ Falta" otherwise. */
export function responsivaSigned(v: unknown): boolean {
  return str(v).includes("✅");
}

/** Pure. The fields the kit reads off an Alumnos record. */
export function alumnoFromFields(id: string, fields: Record<string, unknown>): AlumnoInfo {
  const link = str(fields[ALUMNO_FIELDS.responsivaLink]).trim();
  return {
    id,
    name: str(fields[ALUMNO_FIELDS.name]).trim(),
    qrShared: fields[ALUMNO_FIELDS.qrShared] === true,
    responsivaSigned: responsivaSigned(fields[ALUMNO_FIELDS.responsivaOk]),
    responsivaLink: /^https:\/\//.test(link) ? link : responsivaFallbackLink(id),
  };
}

// ---- row state, carried in followups.note ----
//
// "alumno:3;tpl:1;err:0;qr:1;resp:0". qr/resp mark parts already delivered, so a
// retry never sends the QR twice. The generic failure handler may append
// "|attempts:N" — the parser ignores it.

export interface KitState {
  alumno: number;
  tpl: number;
  err: number;
  qr: boolean;
  resp: boolean;
}

export function parseKitNote(note: string | null): KitState {
  const s = note ?? "";
  const num = (k: string) => {
    const m = new RegExp(`(?:^|;)${k}:(\\d+)`).exec(s);
    return m ? Number(m[1]) : 0;
  };
  return { alumno: num("alumno"), tpl: num("tpl"), err: num("err"), qr: num("qr") > 0, resp: num("resp") > 0 };
}

export function encodeKitNote(st: KitState): string {
  return `alumno:${st.alumno};tpl:${st.tpl};err:${st.err};qr:${st.qr ? 1 : 0};resp:${st.resp ? 1 : 0}`;
}

// ---- template components ----

/** student_qr: the IMAGE header carries the freshly uploaded QR (media id). */
export function qrTemplateComponents(mediaId: string): unknown[] {
  return [{ type: "header", parameters: [{ type: "image", image: { id: mediaId } }] }];
}

/** student_responsiva: the URL button's {{1}} suffix is the Alumno record id. */
export function responsivaTemplateComponents(alumnoId: string): unknown[] {
  return [
    { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: alumnoId }] },
  ];
}

// ---- the run ----

export interface KitIo {
  now(): number;
  /** Ids in the lead's `Alumnos` link field (empty while the automation runs). */
  leadAlumnoIds(leadRecordId: string): Promise<string[]>;
  /** null when the record is gone. */
  alumno(alumnoId: string): Promise<AlumnoInfo | null>;
  kvGet(key: string): Promise<string | null>;
  kvSet(key: string, value: string): Promise<void>;
  /** PNG of the check-in QR, uploaded to Graph; returns the media id. */
  qrMediaId(alumnoId: string): Promise<string>;
  /** Free-form sends; throw a window-closed error when the 24h window is shut. */
  sendImage(mediaId: string, caption: string): Promise<void>;
  sendText(body: string): Promise<void>;
  sendTemplate(name: string, lang: string, components: unknown[]): Promise<void>;
  isWindowClosed(err: unknown): boolean;
  /** sendTemplate refuses an opted-out contact (OptedOutError). */
  isOptedOut(err: unknown): boolean;
  /** Fresh read of the contact: did they write BAJA since the row was loaded?
   *  Free-form media/text sends have no opt-out check of their own. */
  contactOptedOut(): Promise<boolean>;
  /** Best-effort tick of `QR Compartido`. */
  markQrShared(alumnoId: string): Promise<void>;
  /** Write the row note NOW (a part just landed) — so any later throw and the
   *  generic retry never resend it. */
  saveProgress(note: string): Promise<void>;
  reschedule(dueAt: number, note: string): Promise<void>;
  mark(status: Followup["status"]): Promise<void>;
  postNote(text: string): Promise<void>;
}

export interface KitContext {
  leadRecordId: string;
  lang: string;
  /** Human label for Slack (phone, or "IG 12345…6789"). */
  who: string;
  copy: { qr: string; responsiva: string };
}

type PartOutcome = "sent" | "template_failed" | "error" | "opted_out";

/**
 * One tick of a student_kit row. Every failure goes through the kit's own retry
 * paths (so exhaustion always ends in ONE Slack note); a throw only escapes from
 * the D1/kv/Slack writes themselves.
 */
export async function runStudentKit(io: KitIo, ctx: KitContext, note: string | null): Promise<void> {
  const st = parseKitNote(note);
  const now = io.now();

  // 1. The Alumno the "Se inscribió" automation creates — maybe not yet.
  //    An Airtable read error rides the kit's own err: path (+5 min ×3, then
  //    the one "mándaselos a mano" note) — the generic followup retry would
  //    give up silently.
  let alumno: AlumnoInfo | null;
  try {
    const ids = await io.leadAlumnoIds(ctx.leadRecordId);
    const alumnoId = ids[0] ?? null;
    alumno = alumnoId ? await io.alumno(alumnoId) : null;
  } catch (err) {
    const n = st.err + 1;
    if (n >= ERROR_MAX_ATTEMPTS) {
      await io.postNote(
        `⚠️ No pude leer el Alumno de ${ctx.who} en Airtable para mandarle su QR/responsiva (${String(err)}) — mándaselos a mano.`,
      );
      await io.mark("failed");
      return;
    }
    await io.reschedule(now + ERROR_RETRY_EVERY, encodeKitNote({ ...st, err: n }));
    return;
  }
  if (!alumno) {
    const n = st.alumno + 1;
    if (n >= ALUMNO_MAX_ATTEMPTS) {
      await io.postNote(
        `No encontré el Alumno de ${ctx.who} para mandarle su QR/responsiva — mándaselos a mano.`,
      );
      await io.mark("failed");
      return;
    }
    await io.reschedule(now + ALUMNO_RETRY_EVERY, encodeKitNote({ ...st, alumno: n }));
    return;
  }

  // 2. Once per Alumno, ever.
  const guard = kitGuardKey(alumno.id);
  if (await io.kvGet(guard)) {
    await io.mark("cancelled");
    return;
  }

  // 3. What is still owed. Staff ticking `QR Compartido` means they already
  //    sent it by hand; a signed responsiva needs no link.
  const wantQr = !st.qr && !alumno.qrShared;
  const wantResp = !st.resp && !alumno.responsivaSigned;
  if (!wantQr && !wantResp && !st.qr && !st.resp) {
    await io.kvSet(guard, "nothing_owed");
    await io.mark("cancelled");
    return;
  }

  let lastErr = "";
  const failures: { part: "qr" | "resp"; outcome: PartOutcome }[] = [];
  // Baja mid-run (or since the row was loaded): stop for good, in silence.
  const optedOut = async () => {
    await io.mark("cancelled");
  };

  if (wantQr) {
    if (await io.contactOptedOut()) return optedOut();
    const out = await sendPart(io, async () => {
      const mediaId = await io.qrMediaId(alumno.id);
      return {
        freeform: () => io.sendImage(mediaId, ctx.copy.qr),
        template: () => io.sendTemplate(tpl("student_qr", ctx.lang), ctx.lang, qrTemplateComponents(mediaId)),
      };
    });
    if (out.outcome === "opted_out") return optedOut();
    if (out.outcome === "sent") {
      st.qr = true;
      await io.saveProgress(encodeKitNote(st));
      await markQrSharedSafe(io, alumno.id);
    } else {
      failures.push({ part: "qr", outcome: out.outcome });
      lastErr = out.error;
    }
  }

  if (wantResp) {
    if (await io.contactOptedOut()) return optedOut();
    const body = ctx.copy.responsiva.replaceAll("{link}", alumno.responsivaLink);
    const out = await sendPart(io, async () => ({
      freeform: () => io.sendText(body),
      template: () =>
        io.sendTemplate(
          tpl("student_responsiva", ctx.lang),
          ctx.lang,
          responsivaTemplateComponents(alumno.id),
        ),
    }));
    if (out.outcome === "opted_out") return optedOut();
    if (out.outcome === "sent") {
      st.resp = true;
      await io.saveProgress(encodeKitNote(st));
    } else {
      failures.push({ part: "resp", outcome: out.outcome });
      lastErr = out.error;
    }
  }

  if (failures.length) {
    const transient = failures.some((x) => x.outcome === "error");
    const next = transient
      ? { ...st, err: st.err + 1 }
      : { ...st, tpl: st.tpl + 1 };
    const exhausted = transient
      ? next.err >= ERROR_MAX_ATTEMPTS
      : next.tpl >= TEMPLATE_MAX_ATTEMPTS;
    if (!exhausted) {
      // Never resend a part that already landed: qr/resp ride in the note.
      const dueAt = transient
        ? now + ERROR_RETRY_EVERY
        : shiftOutOfQuiet(now + TEMPLATE_RETRY_EVERY);
      await io.reschedule(dueAt, encodeKitNote(next));
      return;
    }
    // ONE note, then the row is done — never a note per retry.
    const missing = failures.map((x) => (x.part === "qr" ? "su QR de acceso" : "el link de la responsiva"));
    await io.postNote(
      `⚠️ No pude mandarle a ${label(alumno, ctx)} ${missing.join(" ni ")}` +
        (transient
          ? ` (error: ${lastErr}).`
          : ` (ventana de 24h cerrada y la plantilla falló: ${lastErr} — ¿ya está aprobada en WhatsApp Manager?).`) +
        ` Mándaselo a mano.`,
    );
    await io.kvSet(guard, "partial");
    await io.mark("failed");
    return;
  }

  await io.kvSet(guard, "sent");
  await io.mark("sent");
  await io.postNote(doneNote(alumno, ctx, st));
}

async function sendPart(
  io: KitIo,
  prepare: () => Promise<{ freeform: () => Promise<void>; template: () => Promise<void> }>,
): Promise<{ outcome: PartOutcome; error: string }> {
  let sends: Awaited<ReturnType<typeof prepare>> | null = null;
  try {
    sends = await prepare();
    await sends.freeform();
    return { outcome: "sent", error: "" };
  } catch (err) {
    if (io.isOptedOut(err)) return { outcome: "opted_out", error: String(err) };
    if (!sends || !io.isWindowClosed(err)) return { outcome: "error", error: String(err) };
  }
  try {
    await sends.template();
    return { outcome: "sent", error: "" };
  } catch (err) {
    // OptedOutError is terminal, never "is the template approved?".
    if (io.isOptedOut(err)) return { outcome: "opted_out", error: String(err) };
    return { outcome: "template_failed", error: String(err) };
  }
}

async function markQrSharedSafe(io: KitIo, alumnoId: string): Promise<void> {
  try {
    await io.markQrShared(alumnoId);
  } catch (err) {
    console.warn(`[student_kit] QR Compartido update failed for ${alumnoId}: ${String(err)}`);
  }
}

function label(a: AlumnoInfo, ctx: KitContext): string {
  return a.name ? `${a.name} (${ctx.who})` : ctx.who;
}

/** Pure. The ops note once the kit is out. */
export function doneNote(a: AlumnoInfo, ctx: KitContext, st: Pick<KitState, "qr" | "resp">): string {
  const who = label(a, ctx);
  if (st.qr && st.resp) return `🎟️ QR y responsiva enviados a ${who}`;
  if (st.qr) return `🎟️ QR enviado a ${who}; responsiva ya firmada`;
  return `🎟️ Responsiva enviada a ${who} (el QR ya lo había mandado recepción)`;
}
