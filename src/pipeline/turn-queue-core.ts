// Pure scheduling core of the per-phone turn runner (src/pipeline/turn-runner.ts,
// docs/turn-runner.md). The Durable Object keeps a short list of turns that
// passed every gate; each is due DEBOUNCE ms after it was queued, exactly like
// the inline `setTimeout(8000)` it replaces, and at its due time it runs only
// if its message is still the phone's newest inbound. No I/O here.

/** Same 8 s as the inline debounce in processInbound. */
export const TURN_DEBOUNCE_MS = 8000;
/** A burst longer than this is a bot or a paste storm; the oldest entries go. */
export const MAX_PENDING_TURNS = 20;

export interface PendingEntry<T> {
  wamid: string;
  /** Epoch ms when this entry's debounce ends. */
  dueAt: number;
  turn: T;
}

/**
 * Adds a turn. A wamid already queued (Meta redelivery that slipped past the
 * dedupe, or an enqueue retried after a lost response) keeps its original due
 * time instead of being queued twice.
 */
export function enqueueTurn<T>(
  pending: readonly PendingEntry<T>[],
  wamid: string,
  turn: T,
  nowMs: number,
  debounceMs: number = TURN_DEBOUNCE_MS,
): PendingEntry<T>[] {
  if (pending.some((e) => e.wamid === wamid)) return [...pending];
  const next = [...pending, { wamid, dueAt: nowMs + debounceMs, turn }];
  next.sort((a, b) => a.dueAt - b.dueAt);
  return next.length > MAX_PENDING_TURNS ? next.slice(-MAX_PENDING_TURNS) : next;
}

/** When the alarm should fire next: the earliest due time, or null if empty. */
export function nextAlarmAt<T>(pending: readonly PendingEntry<T>[]): number | null {
  let min: number | null = null;
  for (const e of pending) if (min === null || e.dueAt < min) min = e.dueAt;
  return min;
}

/** Splits the queue at `nowMs`: entries whose debounce is over vs the rest. */
export function splitDue<T>(
  pending: readonly PendingEntry<T>[],
  nowMs: number,
): { due: PendingEntry<T>[]; keep: PendingEntry<T>[] } {
  const due: PendingEntry<T>[] = [];
  const keep: PendingEntry<T>[] = [];
  for (const e of pending) (e.dueAt <= nowMs ? due : keep).push(e);
  return { due, keep };
}

/**
 * The inline debounce's "only the newest inbound proceeds": of the due
 * entries, the one whose wamid is the phone's newest inbound runs; every other
 * due entry is dropped (a newer message owns the reply, or ended at a gate).
 */
export function pickTurn<T>(
  due: readonly PendingEntry<T>[],
  newestWamid: string | null,
): PendingEntry<T> | null {
  if (newestWamid === null) return null;
  return due.find((e) => e.wamid === newestWamid) ?? null;
}
