// Minimal ambient globals so workstream D's src modules (which import queries.ts
// / wa.ts, and use fetch/URL/console/setTimeout) compile under the test build,
// which deliberately omits @cloudflare/workers-types (zero-extra-deps rule).
// These are structural stand-ins — the real runtime types live in the worker
// build (tsconfig.json → @cloudflare/workers-types).

interface D1Result<T = unknown> {
  results: T[];
  meta: { changes?: number; last_row_id?: number };
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(col?: string): Promise<T | null>;
  run(): Promise<D1Result>;
  all<T = unknown>(): Promise<D1Result<T>>;
}
interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

declare const console: {
  log(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
};

declare function setTimeout(cb: () => void, ms?: number): unknown;

declare function fetch(
  input: string,
  init?: RequestInit,
): Promise<Response>;

interface RequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}
interface Response {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

declare class URL {
  constructor(url: string, base?: string);
  searchParams: {
    set(name: string, value: string): void;
    get(name: string): string | null;
  };
  toString(): string;
}
