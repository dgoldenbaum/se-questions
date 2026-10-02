#!/usr/bin/env node
// Query the question catalog from a terminal, with the same syntax as the web app.
//   npm run query -- 'sso okta status:answered'
//   npm run query -- --similar "Do you support Okta SSO?"
//   npm run query -- 'is:gap' --json
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildIndex, search, similarToText } from "../src/query.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = { json: false, limit: 20, data: null, similar: null, help: false };
const rest = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--json") opt.json = true;
  else if (a === "--limit" || a === "-n") opt.limit = Number(args[++i]) || 20;
  else if (a === "--data") opt.data = args[++i];
  else if (a === "--similar") opt.similar = args[++i] ?? "";
  else if (a === "-h" || a === "--help") opt.help = true;
  else rest.push(a);
}

if (opt.help) {
  console.log(`Usage: npm run query -- [query] [--similar "text"] [--json] [--limit N] [--data file.json]

Query syntax: words, "phrases", -exclude, field:value (account topic product status by asker role source),
after:/before: (2026-05-01, 2026-05, 30d, 8w, 6m), has:answer|link|note, is:gap|pe|answered|partial|deferred`);
  process.exit(0);
}

const file = opt.data || [join(root, "data/questions.json"), join(root, "data/questions.sample.json")].find(existsSync);
if (!file) { console.error("No data found. Put your export at data/questions.json or pass --data <file>."); process.exit(1); }
const raw = JSON.parse(readFileSync(file, "utf8"));
const items = (Array.isArray(raw) ? raw : raw.questions || raw.docs || []).map((d, i) => ({ id: `q${i}`, ...(d.data && typeof d.data === "object" ? { ...d.data, id: d.id } : d) }));
const index = buildIndex(items);

const results = opt.similar !== null
  ? similarToText(index, opt.similar, opt.limit)
  : search(index, rest.join(" ")).results;
const shown = results.slice(0, opt.limit);

if (opt.json) { console.log(JSON.stringify(shown.map(r => r.item), null, 2)); process.exit(0); }

const tty = process.stdout.isTTY, dim = s => (tty ? `\x1b[2m${s}\x1b[0m` : s), bold = s => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const color = { Answered: 32, Partial: 33, Deferred: 31 };
if (/sample/.test(file) && !opt.data) console.log(dim("(sample data — add data/questions.json for the real catalog)\n"));
for (const { item: d } of shown) {
  const st = tty ? `\x1b[${color[d.status] || 0}m${d.status}\x1b[0m` : d.status;
  console.log(`${bold(d.question)}\n  ${d.account} · ${d.category} · ${d.product} · ${st} · ${d.date}${d.answeredBy ? ` · ${d.answeredBy}` : ""}`);
  if (d.referenceAnswer) console.log(`  ${dim("Answer:")} ${d.referenceAnswer}`);
  console.log("");
}
console.log(dim(`${shown.length} shown of ${results.length} matching, ${items.length} total`));
