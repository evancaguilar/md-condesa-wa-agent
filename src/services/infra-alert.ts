// Infrastructure outage alarm — the one alert that must NOT depend on the thing
// that is failing.
//
// 2026-10-06: D1 answered "D1_ERROR: D1 DB is overloaded. Requests queued for
// too long." for hours. The brain path does ~20 D1 calls per inbound message,
// so every turn died mid-pipeline: no draft, no Aprobar card, no Slack note.
// The only trace was console.error in the webhook/cron catch blocks, which
// nobody watches. The existing brain alarm (inbound.ts, `api_error`) never
// fired because it sits AFTER the D1 calls that were throwing — and it claims
// its throttle slot in kv, i.e. in D1.
//
// This module classifies an error as an infra outage (D1 / Anthropic / Meta /
// Slack) and posts ONE <!here> note per kind per THROTTLE window. Throttle:
// try the shared kv claim first (one note across all isolates); when kv itself
// throws, fall back to a per-isolate in-memory timestamp so the alarm still
// goes out while the DB is down (a handful of isolates ⇒ a handful of notes,
// never a flood). Pure: D1 and Slack arrive as injected functions.

export type InfraKind = "d1_overloaded" | "d1_error" | "anthropic" | "meta_api";

export interface InfraClassification {
  kind: InfraKind;
  /** Short, single-line excerpt of the error for the note. */
  detail: string;
  /** What a human should look at — rendered in the note. */
  hint: string;
}

/** Minutes between two notes of the same kind (same key in kv and memory). */
export const INFRA_ALERT_THROTTLE_SECONDS = 15 * 60;

const KV_KEY_PREFIX = "infra_alert:";

/** Returns null when the error is an ordinary bug, not an infra outage. */
export function classifyInfraError(err: unknown): InfraClassification | null {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? "");
  const text = raw.replace(/\s+/g, " ").trim();
  const detail = text.slice(0, 180);
  if (/D1_ERROR|D1 DB|D1_TYPE_ERROR|D1_EXEC_ERROR/i.test(text)) {
    if (/overloaded|queued for too long|too many requests|rate ?limit/i.test(text)) {
      return {
        kind: "d1_overloaded",
        detail,
        hint:
          "Cloudflare → Storage & databases → D1 → wa-agent-db → Metrics / Query insights: busca la consulta lenta o el pico de lecturas. " +
          "Hasta que baje, los mensajes entrantes se pierden tras el ack a Meta (revisa Chats → No leídos y la app de WhatsApp Business).",
      };
    }
    return {
      kind: "d1_error",
      detail,
      hint:
        "Cloudflare → D1 → wa-agent-db (¿límite diario de lecturas? ¿migración pendiente?). " +
        "Los mensajes entrantes se pierden mientras dure; revisa la app de WhatsApp Business.",
    };
  }
  if (/anthropic HTTP (5\d\d|429|400)|anthropic request failed/i.test(text)) {
    return {
      kind: "anthropic",
      detail,
      hint: "console.anthropic.com → Billing (saldo / auto-reload) o la API key en Cloudflare.",
    };
  }
  if (/WA send failed \((5\d\d|429)\)|error code: 5\d\d|graph\.facebook\.com.*(5\d\d|ECONN)/i.test(text)) {
    return {
      kind: "meta_api",
      detail,
      hint: "Meta Cloud API con errores 5xx/429 — suele ser de Meta; si dura >30 min revisa WhatsApp Manager → Estado.",
    };
  }
  return null;
}

export interface InfraAlertDeps {
  /** Posts to the ops channel. Must not touch D1. */
  postNote(text: string): Promise<void>;
  /**
   * Shared throttle (kv, lives in D1): return true when THIS caller won the
   * slot. May throw — that is exactly the case the memory fallback covers.
   */
  kvClaim?(key: string, nowSec: number, minAgeSeconds: number): Promise<boolean>;
}

// Per-isolate fallback throttle: kind → epoch seconds of the last note.
const lastNoteAt = new Map<InfraKind, number>();

/**
 * Colo-wide throttle that does NOT touch D1: the Workers Cache API (shared by
 * every isolate in the colo). 2026-10-06 15:00: with only the per-isolate
 * memory gate, a dozen isolates each posted their own <!here> inside 25 min.
 * Returns true = this caller won the window, false = someone already posted,
 * null = Cache API unavailable (tests, or a runtime without it).
 */
async function cacheGate(kind: InfraKind, ttlSeconds: number): Promise<boolean | null> {
  // Structural types on purpose: this module is compiled by the node test
  // config (lib ES2022, no DOM/Workers globals) as well as by the worker.
  type CacheLike = {
    match(key: string): Promise<unknown>;
    put(key: string, res: unknown): Promise<void>;
  };
  type ResponseCtor = new (body: string, init: { headers: Record<string, string> }) => unknown;
  const g = globalThis as { caches?: { default?: CacheLike }; Response?: ResponseCtor };
  const store = g.caches?.default;
  if (!store || !g.Response) return null;
  try {
    const key = `https://infra-alert.internal/${kind}`;
    if (await store.match(key)) return false;
    await store.put(key, new g.Response("1", { headers: { "Cache-Control": `max-age=${ttlSeconds}` } }));
    return true;
  } catch {
    return null;
  }
}

/** Test hook. */
export function resetInfraAlertMemoryForTests(): void {
  lastNoteAt.clear();
}

export function formatInfraAlert(
  scope: string,
  c: InfraClassification,
  viaMemory: boolean,
): string {
  const title: Record<InfraKind, string> = {
    d1_overloaded: "La base de datos (D1) está saturada",
    d1_error: "La base de datos (D1) está fallando",
    anthropic: "El cerebro (Anthropic) está fallando",
    meta_api: "La API de WhatsApp (Meta) está fallando",
  };
  return (
    `<!here> 🛑 *${title[c.kind]}* — el bot NO está procesando mensajes (${scope}).\n` +
    `Error: \`${c.detail}\`\n` +
    `Qué revisar: ${c.hint}` +
    (viaMemory
      ? "\n_(Sin base de datos ni caché para coordinar esta alerta: puede repetirse.)_"
      : "")
  );
}

/**
 * Classify `err`; if it is an infra outage and the throttle allows, post the
 * alarm. Never throws. Returns the kind when a note went out, else null.
 */
export async function reportInfraError(
  deps: InfraAlertDeps,
  scope: string,
  err: unknown,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<InfraKind | null> {
  const c = classifyInfraError(err);
  if (!c) return null;
  // Memory gate first: cheap, and it keeps a dead DB from being hammered with
  // a claim attempt on every failing request from this isolate.
  const last = lastNoteAt.get(c.kind);
  if (last !== undefined && nowSec - last < INFRA_ALERT_THROTTLE_SECONDS) return null;

  let viaMemory = true;
  if (deps.kvClaim) {
    try {
      const won = await deps.kvClaim(`${KV_KEY_PREFIX}${c.kind}`, nowSec, INFRA_ALERT_THROTTLE_SECONDS);
      viaMemory = false;
      if (!won) {
        // Another isolate posted inside the window: remember it so we stay quiet too.
        lastNoteAt.set(c.kind, nowSec);
        return null;
      }
    } catch {
      viaMemory = true; // kv (D1) is down — colo-wide Cache API gate, then memory
    }
  }
  if (viaMemory) {
    const won = await cacheGate(c.kind, INFRA_ALERT_THROTTLE_SECONDS);
    if (won === false) {
      lastNoteAt.set(c.kind, nowSec);
      return null;
    }
    if (won === true) viaMemory = false;
  }
  if (viaMemory && !/^cron\b/.test(scope)) {
    // No shared throttle at all (D1 down; Cache API is a no-op on workers.dev —
    // 2026-10-06 15:17: five identical <!here> in one minute from the
    // dashboard's polls landing on different isolates). Only the cron may
    // post in this state: one invocation per 5 min is a hard ceiling. The
    // webhook/admin paths stay silent; the cron sees the same outage within
    // minutes because its own queries fail too.
    lastNoteAt.set(c.kind, nowSec);
    return null;
  }
  lastNoteAt.set(c.kind, nowSec);
  try {
    await deps.postNote(formatInfraAlert(scope, c, viaMemory));
  } catch (e) {
    console.error("[infra-alert] slack post failed", e);
    return null;
  }
  return c.kind;
}
