// Query engine for the SE technical question catalog.
// Shared by the browser app (src/app.js) and the CLI (bin/query.mjs), so it has no DOM or Node dependencies.
//
// Query syntax (combine freely, everything is AND-ed):
//   sso okta              free text, ranked by relevance (BM25 + prefixes + synonyms)
//   "data refresh"        exact phrase
//   -mobile               exclude a word or phrase
//   account:acme          field filter (substring, case-insensitive); a,b = OR; -field:x excludes
//   topic: product: status: by: asker: role: source:
//   after:2026-05-01 before:2026-07   date range (ISO prefix or relative: 30d, 8w, 6m)
//   has:answer has:link has:note      is:gap is:pe is:answered is:partial is:deferred

export const FIELD_ALIASES = {
  account: "account", acct: "account", client: "account",
  topic: "category", category: "category", cat: "category",
  product: "product", prod: "product",
  status: "status",
  by: "answeredBy", answeredby: "answeredBy", answerer: "answeredBy",
  asker: "asker", asked: "asker", askedby: "asker",
  role: "answererRole",
  source: "sourceType",
  id: "id",
};

const STOP = new Set(("a an and are as at be but by can could do does for from has have how i if in into is it its " +
  "of on or our so than that the their them then there these they this those to was we were what when where which " +
  "who why will with would you your").split(" "));

// Single-word synonym groups for the vocabulary SEs hear most. Stemmed at load.
const SYNONYM_GROUPS = [
  ["sso", "saml", "okta", "oidc", "oauth"],
  ["mfa", "2fa", "otp", "totp"],
  ["api", "endpoint", "rest", "graphql"],
  ["webhook", "callback", "notification"],
  ["bureau", "experian", "equifax", "transunion", "tu", "efx", "exp"],
  ["latency", "performance", "speed", "slow", "fast"],
  ["refresh", "update", "frequency", "cadence", "stale"],
  ["sla", "uptime", "availability", "downtime"],
  ["soc", "soc2", "audit", "pentest", "iso"],
  ["encrypt", "encryption", "tls", "kms", "aes"],
  ["pii", "ssn", "gdpr", "ccpa", "glba"],
  ["mobile", "ios", "android", "sdk", "webview", "native"],
  ["whitelabel", "branding", "theme", "css", "skin"],
  ["price", "pricing", "cost", "billing", "invoice", "fee"],
  ["furnish", "furnishing", "metro2", "tradeline"],
  ["aggregation", "aggregator", "plaid", "mx", "finicity", "yodlee"],
  ["embed", "iframe", "widget", "component"],
  ["score", "vantagescore", "fico"],
];

export function stem(word) {
  let w = String(word).toLowerCase();
  if (w.length > 5 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && /(sh|ch|x|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function words(text) {
  return String(text ?? "").toLowerCase().match(/[a-z0-9]+/g) || [];
}

export function tokenize(text) {
  return words(text).filter(t => !STOP.has(t)).map(stem);
}

const SYNONYMS = new Map();
for (const group of SYNONYM_GROUPS) {
  const stems = group.map(stem);
  for (const s of stems) {
    const set = SYNONYMS.get(s) || new Set();
    stems.forEach(o => o !== s && set.add(o));
    SYNONYMS.set(s, set);
  }
}

export function isGap(d) {
  return d.status !== "Answered" || !!d.needsProduct;
}

// ---------- parsing ----------

export function parseQuery(input) {
  const q = { text: [], phrases: [], filters: [], after: null, before: null, flags: [], warnings: [] };
  const re = /(-?)(?:([A-Za-z]+):)?(?:"([^"]*)"?|(\S*))/g;
  let m;
  const src = String(input ?? "");
  while ((m = re.exec(src))) {
    if (!m[0]) { re.lastIndex++; continue; }
    const neg = m[1] === "-";
    const rawField = m[2]?.toLowerCase();
    const quoted = m[3] !== undefined;
    const value = (quoted ? m[3] : m[4] ?? "").trim();
    if (!rawField) {
      if (!value) continue;
      if (quoted) q.phrases.push({ text: value.toLowerCase(), neg });
      else q.text.push({ text: value, neg });
      continue;
    }
    if (!value) { q.warnings.push(`“${rawField}:” needs a value`); continue; }
    if (rawField === "after" || rawField === "before" || rawField === "since") {
      const date = resolveDate(value);
      if (!date) q.warnings.push(`Couldn't read the date “${value}”. Use 2026-05-01, 2026-05, or 30d / 8w / 6m.`);
      else if (rawField === "before") q.before = date;
      else q.after = date;
    } else if (rawField === "has" || rawField === "is") {
      for (const v of value.toLowerCase().split(",").filter(Boolean)) {
        const name = `${rawField}:${v}`;
        if (!FLAGS[name]) q.warnings.push(`Unknown filter “${name}”`);
        else q.flags.push({ name, neg });
      }
    } else if (FIELD_ALIASES[rawField]) {
      q.filters.push({ field: FIELD_ALIASES[rawField], label: rawField, values: value.split(",").map(v => v.trim().toLowerCase()).filter(Boolean), neg });
    } else {
      // Not a field we know (e.g. a pasted URL). Treat it as plain text.
      q.text.push({ text: `${rawField} ${value}`, neg });
    }
  }
  return q;
}

export function resolveDate(v, today = new Date()) {
  if (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(v)) return v;
  const rel = /^(\d+)([dwmy])$/i.exec(v);
  if (!rel) return null;
  const n = +rel[1], unit = rel[2].toLowerCase(), d = new Date(today);
  if (unit === "d") d.setDate(d.getDate() - n);
  if (unit === "w") d.setDate(d.getDate() - n * 7);
  if (unit === "m") d.setMonth(d.getMonth() - n);
  if (unit === "y") d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
}

const FLAGS = {
  "has:answer": d => !!String(d.referenceAnswer ?? "").trim(),
  "has:link": d => !!d.sourceUrl,
  "has:note": d => !!String(d.note ?? "").trim(),
  "is:gap": isGap,
  "is:pe": d => d.answererRole === "Product/Eng",
  "is:answered": d => d.status === "Answered",
  "is:partial": d => d.status === "Partial",
  "is:deferred": d => d.status === "Deferred",
};

// ---------- index ----------

const WEIGHTS = { question: 3, referenceAnswer: 2, note: 1, account: 1.5, asker: 1, answeredBy: 1, category: 1.5, product: 1.5 };

export function buildIndex(items) {
  const docs = items.map(item => {
    const tf = new Map();
    let len = 0;
    for (const [field, w] of Object.entries(WEIGHTS)) {
      for (const t of tokenize(item[field])) { tf.set(t, (tf.get(t) || 0) + w); len += w; }
    }
    const blob = Object.keys(WEIGHTS).map(f => item[f] ?? "").join(" \u0001 ").toLowerCase();
    return { item, tf, len, blob };
  });
  const df = new Map();
  for (const doc of docs) for (const t of doc.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / (docs.length || 1);
  return { docs, df, avgLen, N: docs.length, vocab: [...df.keys()], byId: new Map(docs.map(d => [d.item.id, d])) };
}

function idf(index, t) {
  const n = index.df.get(t) || 0;
  return Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
}

// A query token expands to itself, vocabulary words it prefixes, and its synonyms, each with a weight.
function expand(index, token, { synonyms = true } = {}) {
  const out = new Map([[token, 1]]);
  if (token.length >= 3) for (const v of index.vocab) if (v !== token && v.startsWith(token)) out.set(v, Math.max(out.get(v) || 0, 0.6));
  if (synonyms) for (const s of SYNONYMS.get(token) || []) if (!out.has(s)) out.set(s, 0.5);
  return out;
}

function bm25(index, doc, t) {
  const f = doc.tf.get(t);
  if (!f) return 0;
  const k1 = 1.2, b = 0.75;
  return idf(index, t) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * doc.len / index.avgLen));
}

function fieldMatches(item, f) {
  const hay = String(item[f.field] ?? "").toLowerCase();
  return f.values.some(v => hay.includes(v));
}

function passes(item, q) {
  for (const f of q.filters) if (fieldMatches(item, f) === f.neg) return false;
  for (const fl of q.flags) if (!!FLAGS[fl.name](item) === fl.neg) return false;
  const date = String(item.date ?? "");
  if (q.after && date < q.after) return false;
  if (q.before && date >= q.before) return false;
  return true;
}

// ---------- search ----------

export function search(index, input) {
  const q = parseQuery(input);
  const positive = [], negative = [];
  for (const t of q.text) {
    for (const tok of tokenize(t.text)) (t.neg ? negative : positive).push(tok);
  }
  const groups = [...new Set(positive)].map(tok => ({ tok, exp: expand(index, tok) }));
  const negGroups = negative.map(tok => expand(index, tok, { synonyms: false }));

  let pool = index.docs.filter(doc => passes(doc.item, q));
  pool = pool.filter(doc => q.phrases.every(p => doc.blob.includes(p.text) !== p.neg));
  pool = pool.filter(doc => negGroups.every(exp => ![...exp.keys()].some(t => doc.tf.has(t))));

  const highlight = new Set(q.phrases.filter(p => !p.neg).map(p => p.text));
  for (const g of groups) for (const t of g.exp.keys()) highlight.add(t);

  if (!groups.length) {
    return { results: pool.map(doc => ({ item: doc.item, score: 0, matched: 0 })), query: q, partial: false, ranked: false, highlight: [...highlight] };
  }

  const scored = pool.map(doc => {
    let score = 0, matched = 0;
    for (const g of groups) {
      let best = 0;
      for (const [t, w] of g.exp) best = Math.max(best, w * bm25(index, doc, t));
      if (best > 0) { matched++; score += best; }
    }
    return { item: doc.item, score, matched };
  }).filter(r => r.matched > 0);

  const all = scored.filter(r => r.matched === groups.length);
  const partial = all.length === 0 && scored.length > 0;
  const results = (partial ? scored : all).sort((a, b) => b.matched - a.matched || b.score - a.score);
  return { results, query: q, partial, ranked: true, highlight: [...highlight] };
}

// Cosine similarity on the weighted term vectors: "has anyone been asked something like this?"
export function similar(index, id, k = 5) {
  const target = index.byId.get(id);
  if (!target) return [];
  const vec = doc => {
    const v = new Map(); let norm = 0;
    for (const [t, f] of doc.tf) { const w = f * idf(index, t); v.set(t, w); norm += w * w; }
    return { v, norm: Math.sqrt(norm) || 1 };
  };
  const a = vec(target);
  return index.docs.filter(d => d !== target).map(d => {
    const b = vec(d); let dot = 0;
    for (const [t, w] of a.v) { const o = b.v.get(t); if (o) dot += w * o; }
    return { item: d.item, score: dot / (a.norm * b.norm) };
  }).filter(r => r.score > 0.08).sort((x, y) => y.score - x.score).slice(0, k);
}

// Free-text "similar to this text" lookup, for pasting a new client question.
export function similarToText(index, text, k = 5) {
  const toks = tokenize(text);
  if (!toks.length) return [];
  const qv = new Map();
  for (const t of toks) qv.set(t, (qv.get(t) || 0) + 1);
  let qn = 0; for (const [t, f] of qv) { const w = f * idf(index, t); qv.set(t, w); qn += w * w; }
  qn = Math.sqrt(qn) || 1;
  return index.docs.map(d => {
    let dot = 0, norm = 0;
    for (const [t, f] of d.tf) { const w = f * idf(index, t); norm += w * w; const o = qv.get(t); if (o) dot += w * o; }
    return { item: d.item, score: dot / (qn * (Math.sqrt(norm) || 1)) };
  }).filter(r => r.score > 0.08).sort((x, y) => y.score - x.score).slice(0, k);
}

export function facetCounts(items, field) {
  const counts = new Map();
  for (const d of items) { const v = d[field]; if (v) counts.set(v, (counts.get(v) || 0) + 1); }
  return [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

// Facet clicks add or remove a field:value token in the query string, so the query bar stays the single source of truth.
function tokenRegex(field, value) {
  const token = /\s/.test(value) ? `${field}:"${value}"` : `${field}:${value}`;
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return { token, re: new RegExp(`(^|\\s)${esc}(?=\\s|$)`, "i") };
}

export function hasToken(input, field, value) {
  return tokenRegex(field, value).re.test(input);
}

export function toggleToken(input, field, value) {
  const { token, re } = tokenRegex(field, value);
  if (re.test(input)) return input.replace(re, " ").replace(/\s+/g, " ").trim();
  return `${input.trim()} ${token}`.trim();
}
