// Minimal ambient declarations so the brain modules typecheck under
// tsconfig.test.json (types: [], lib ES2022) without pulling @types/node or
// @cloudflare/workers-types. Runtime is Node v24, which provides all of these.

interface Response {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

interface RequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

declare function fetch(input: string, init?: RequestInit): Promise<Response>;

declare function setTimeout(handler: () => void, timeout?: number): unknown;

declare namespace Intl {
  interface DateTimeFormatOptions {
    timeZone?: string;
    year?: "numeric" | "2-digit";
    month?: "numeric" | "2-digit";
    day?: "numeric" | "2-digit";
  }
  class DateTimeFormat {
    constructor(locales?: string, options?: DateTimeFormatOptions);
    format(date?: Date): string;
  }
}
