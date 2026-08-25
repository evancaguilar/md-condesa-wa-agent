// Minimal ambient declarations so tests compile without @types/node (kept out of
// devDependencies per the zero-extra-deps rule). Runtime is Node v24.

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  const assert: {
    (value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    match(value: string, regexp: RegExp, message?: string): void;
    rejects(block: () => Promise<unknown>, error?: RegExp | Error): Promise<void>;
  };
  export default assert;
}

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

// Minimal Blob/FormData ambients (Node v24 has them at runtime; wa.ts uses
// them for the media upload path and is pulled into the test build by
// cron/followups.ts).
declare class Blob {
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}
declare class FormData {
  append(name: string, value: unknown, filename?: string): void;
}

declare const crypto: {
  subtle: SubtleCrypto;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
};
interface SubtleCrypto {
  importKey(
    format: string,
    keyData: ArrayBufferView,
    algorithm: { name: string; hash: string } | string,
    extractable: boolean,
    keyUsages: string[],
  ): Promise<CryptoKey>;
  sign(
    algorithm: string,
    key: CryptoKey,
    data: ArrayBufferView,
  ): Promise<ArrayBuffer>;
  deriveBits(
    algorithm: {
      name: string;
      hash: string;
      salt: ArrayBufferView;
      iterations: number;
    },
    baseKey: CryptoKey,
    length: number,
  ): Promise<ArrayBuffer>;
  digest(algorithm: string, data: ArrayBufferView): Promise<ArrayBuffer>;
}
interface CryptoKey {
  readonly __brand: "CryptoKey";
}

// URL-scoped JSON import support for fixtures.
declare module "*.json" {
  const value: unknown;
  export default value;
}
