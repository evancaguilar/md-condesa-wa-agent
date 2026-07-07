#!/usr/bin/env node
/* Deploy one client: build its KB/config, then wrangler-deploy its worker.
 *
 *   npm run deploy:client <clientId>       e.g. npm run deploy:client iasmin
 *
 * Uses clients/<id>/wrangler.jsonc when it exists; md-condesa (the original
 * deployment) keeps the repo-root wrangler.jsonc, so it falls back to that.
 * Refuses to deploy a wrangler config that still has REPLACE_WITH_ placeholders.
 *
 * NOTE: the generated files (src/client.gen.ts, kb/compiled/*, slots.gen.ts)
 * now reflect <clientId>. Run `npm run build` (md-condesa) before committing.
 */

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");

const clientId = process.argv[2];
if (!clientId) {
  console.error("Uso: npm run deploy:client <clientId>   (carpetas en clients/)");
  process.exit(1);
}
if (!existsSync(join(REPO, "clients", clientId, "client.mjs"))) {
  console.error(`clients/${clientId}/client.mjs no existe.`);
  process.exit(1);
}

const clientWrangler = join(REPO, "clients", clientId, "wrangler.jsonc");
const configPath = existsSync(clientWrangler)
  ? clientWrangler
  : join(REPO, "wrangler.jsonc");

const configText = readFileSync(configPath, "utf8");
if (configText.includes("REPLACE_WITH_")) {
  console.error(
    `${configPath} todavía tiene placeholders REPLACE_WITH_*. ` +
      `Completa la infra (docs/new-client.md) antes de deployar.`,
  );
  process.exit(1);
}

run("node", [join(REPO, "tools", "compile-kb.mjs")], { CLIENT: clientId });
run("npx", ["wrangler", "deploy", "--config", configPath]);

console.log(`\n[${clientId}] deploy OK (config: ${configPath})`);
console.log(
  "Recuerda: los archivos generados quedaron en modo " +
    clientId +
    " — corre `npm run build` antes de commitear.",
);

function run(cmd, args, extraEnv = {}) {
  const res = spawnSync(cmd, args, {
    cwd: REPO,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  if (res.status !== 0) process.exit(res.status ?? 1);
}
