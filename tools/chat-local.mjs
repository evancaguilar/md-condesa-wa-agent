// Local chat tester for the agent's BRAIN — talk to it in your terminal without
// any WhatsApp / Cloudflare / Slack setup. Run it with:  npm run chat
// (needs ANTHROPIC_API_KEY in your environment; Airtable is stubbed, so bookings
// are just printed, not saved anywhere.)
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createBrain } from "../.chatdist/brain/claude.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const KB = readFileSync(join(repo, "kb/compiled/kb.md"), "utf8");

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("Falta ANTHROPIC_API_KEY. Corre:  ANTHROPIC_API_KEY='sk-ant-...' npm run chat");
  process.exit(1);
}

const airtable = {
  async bookTrial(input) {
    console.log(`\n   \x1b[35m📇 [se guardaría en Airtable]\x1b[0m ${JSON.stringify(input)}`);
    return "recLOCALTEST123";
  },
};
// Wrap fetch so any API failure is shown loudly (instead of the brain silently
// falling back to its "dame un momento" holding reply on error).
const loggingFetch = async (url, init) => {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.clone().text().catch(() => "");
    console.log(`\n\x1b[31m⚠️  API ${res.status} ${res.statusText}\x1b[0m ${body.slice(0, 300)}`);
    if (res.status === 401) console.log(`   → tu ANTHROPIC_API_KEY es inválida o no es la correcta. Revisa con: echo $ANTHROPIC_API_KEY`);
    if (res.status === 400 && /credit|balance/i.test(body)) console.log(`   → la cuenta de Anthropic no tiene saldo. Agrega crédito en console.anthropic.com → Billing.`);
  }
  return res;
};
const brain = createBrain({ apiKey, kb: KB, airtable, accrueUsage: async () => {}, fetchImpl: loggingFetch });

const now = new Date();
const cdmx = new Date(now.getTime() - 6 * 3600 * 1000);
const nowCdmx = cdmx.toISOString().replace("Z", "-06:00");
const weekdayEs = ["domingo","lunes","martes","miércoles","jueves","viernes","sábado"][cdmx.getUTCDay()];

const phone = "5215500000000";
const contact = {
  phone, name: null, lang: "es", status: "lead", qualification: null,
  human_override_until: null, last_inbound_at: Math.floor(now.getTime()/1000),
  created_at: 0, updated_at: 0,
};

const history = [];
let seq = 0;
const rec = (direction, body) => history.push({ wamid:`w${seq++}`, phone, direction, body, ts:Math.floor(Date.now()/1000), meta:null });

async function turn(userMsg) {
  rec("in", userMsg);
  const ctx = { phone, contact, history: history.slice(-20), nowCdmx, weekday: weekdayEs, windowOpen:true, trainingWheels:false };
  let r;
  try { r = await brain.respond(ctx); }
  catch (e) { console.log(`\x1b[31m[error: ${e.message}]\x1b[0m`); return; }
  if (r.action === "send" || r.action === "draft") {
    const tag = r.action === "draft" ? " \x1b[33m(esperaría tu aprobación en Slack)\x1b[0m" : "";
    console.log(`\x1b[32m🤖 Agente\x1b[0m [${r.language}, conf:${r.confidence}]${tag}:`);
    console.log(`   ${r.message.replace(/\n/g,"\n   ")}`);
    rec("out_bot", r.message);
    if (r.followup) console.log(`   \x1b[90m⏰ follow-up +${r.followup.hoursFromNow}h — ${r.followup.note}\x1b[0m`);
  } else if (r.action === "book") {
    console.log(`\x1b[32m🤖 Agente\x1b[0m \x1b[35m[AGENDADO ✅ ${r.trialDate} ${r.trialTime} · ${r.discipline} · ${r.audience} · ${r.name}]\x1b[0m`);
    console.log(`   ${r.followupMessage.replace(/\n/g,"\n   ")}`);
    rec("out_bot", r.followupMessage);
  } else if (r.action === "escalate") {
    console.log(`\x1b[31m🤖 Agente [PASA A HUMANO] motivo: ${r.reason}\x1b[0m\n   ${r.summary}`);
  }
}

if (process.env.MSGS) {
  for (const m of JSON.parse(process.env.MSGS)) { console.log(`\n\x1b[36m👤 ${m}\x1b[0m`); await turn(m); }
  process.exit(0);
}

console.log(`\x1b[90mChat con el agente MD Condesa (${weekdayEs}, hora CDMX). Escribe como si fueras un lead del anuncio. Ctrl+C para salir.\x1b[0m`);
const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "\x1b[36m👤 tú: \x1b[0m" });
let busy = false, closed = false; const queue = [];
async function drain() {
  if (busy) return; busy = true;
  while (queue.length) { const m = queue.shift(); if (m) await turn(m); }
  busy = false;
  if (closed) process.exit(0); else rl.prompt();
}
rl.prompt();
rl.on("line", (line) => { queue.push(line.trim()); drain(); });
rl.on("close", () => { closed = true; if (!busy && !queue.length) process.exit(0); });
