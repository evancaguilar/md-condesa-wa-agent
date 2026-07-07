#!/usr/bin/env node
/* Scaffold a new client from clients/_template:
 *
 *   node tools/new-client.mjs <client-id>     (kebab-case, e.g. "iasmin")
 *
 * Copies the template into clients/<client-id>/ replacing {{CLIENT_ID}}, then
 * prints the onboarding checklist pointer. Refuses to overwrite.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");

const id = process.argv[2];
if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
  console.error("Uso: node tools/new-client.mjs <client-id>   (kebab-case, p. ej. 'iasmin')");
  process.exit(1);
}

const src = join(REPO, "clients", "_template");
const dst = join(REPO, "clients", id);
if (existsSync(dst)) {
  console.error(`clients/${id}/ ya existe — no sobrescribo.`);
  process.exit(1);
}

mkdirSync(dst, { recursive: true });
for (const f of readdirSync(src)) {
  const text = readFileSync(join(src, f), "utf8").replaceAll("{{CLIENT_ID}}", id);
  writeFileSync(join(dst, f), text);
}

console.log(`clients/${id}/ creado. Siguientes pasos:`);
console.log(`  1. Llena clients/${id}/client.mjs, persona.md e intake.md`);
console.log(`  2. CLIENT=${id} npm run build   (compila y valida)`);
console.log(`  3. Sigue docs/new-client.md para la infra (Meta, Slack, Cloudflare)`);
console.log(`  4. npm run deploy:client ${id}`);
