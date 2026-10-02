import { buildIndex, search, similar, similarToText, facetCounts, toggleToken, hasToken, isGap, words } from "./query.js";

const CATS = ["Integration & APIs", "Data sources & bureaus", "Security & compliance", "Mobile & embed", "Credit reporting & furnishing", "Data refresh & performance", "Aggregation & Financial Links", "White-label & UI", "Calculation logic", "SLAs & billing"];
const PRODS = ["Array+ Platform", "Credit Monitoring", "Identity Protection", "Privacy Protection", "Financial Links", "Build Credit Rent", "Subscription Manager", "Debt Navigator", "Home Title Monitoring", "My Money Plan", "Marketplace", "Calculators"];
const EXAMPLES = ["is:gap", "status:partial,deferred", "is:pe", "has:answer", "sso", "\"refresh\" after:90d", "bureau -status:answered", "topic:security"];
const STATUS_ORDER = { Deferred: 0, Partial: 1, Answered: 2 };
const LS = { data: "seqf.dataset.v1", edits: "seqf.edits.v1" };

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const today = () => new Date().toISOString().slice(0, 10);

let base = [], items = [], index = buildIndex([]), source = "none", edits = { updated: {}, added: [] };
let current = { results: [], highlight: [], ranked: false, partial: false, query: { warnings: [] } };
let sel = null;

// ---------- storage (per-browser convenience; the shared copy is data/questions.json) ----------

function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }
function lsDel(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }

function toast(m) { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2400); }

// ---------- data ----------

function normalize(d, i) {
  const role = d.answererRole || (/product|eng/i.test(d.answeredBy || "") ? "Product/Eng" : /\(SE\)/.test(d.answeredBy || "") ? "SE" : "AE");
  const status = ["Answered", "Partial", "Deferred"].find(s => s.toLowerCase() === String(d.status || "").trim().toLowerCase()) || "Answered";
  return {
    id: String(d.id ?? `q${i}`), question: String(d.question ?? "").trim(), account: d.account ?? "", asker: d.asker ?? "",
    category: d.category ?? d.topic ?? "", product: d.product ?? "", answeredBy: d.answeredBy ?? "", answererRole: role, status,
    needsProduct: d.needsProduct === true || d.needsProduct === "true" || role === "Product/Eng",
    date: String(d.date ?? "").slice(0, 10), sourceType: d.sourceType ?? (d.sourceUrl ? "call" : ""), sourceUrl: d.sourceUrl ?? "",
    sourceLabel: d.sourceLabel ?? "", note: d.note ?? "", referenceAnswer: d.referenceAnswer ?? "", updatedAt: d.updatedAt ?? "",
  };
}

function extractList(json) {
  if (Array.isArray(json)) return json;
  const list = json && (json.questions || json.docs || json.documents || json.items);
  if (!Array.isArray(list)) throw new Error("Expected a JSON array of questions");
  return list.map(x => (x && typeof x.data === "object" ? { ...x.data, id: x.id ?? x.data.id } : x));
}

const CSV_FIELDS = {
  id: "id", question: "question", account: "account", client: "account", asker: "asker", "asked by": "asker",
  topic: "category", category: "category", product: "product", "answered by": "answeredBy", answeredby: "answeredBy",
  role: "answererRole", answererrole: "answererRole", status: "status", date: "date", "source url": "sourceUrl",
  sourceurl: "sourceUrl", "gong link": "sourceUrl", "gong call link": "sourceUrl", note: "note", notes: "note",
  "reference answer": "referenceAnswer", referenceanswer: "referenceAnswer", "needs product": "needsProduct", needsproduct: "needsProduct",
};

function parseCSV(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter(r => r.some(c => c.trim()));
  if (!head) return [];
  const keys = head.map(h => CSV_FIELDS[h.trim().toLowerCase()] || null);
  if (!keys.includes("question")) throw new Error("The CSV needs a “question” column");
  return body.map(r => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ""]).filter(([k]) => k)));
}

function toCSV(list) {
  const cols = ["id", "question", "account", "asker", "category", "product", "answeredBy", "answererRole", "status", "date", "sourceUrl", "note", "referenceAnswer"];
  const cell = v => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(","), ...list.map(d => cols.map(c => cell(d[c])).join(","))].join("\n");
}

function applyEdits() {
  const added = edits.added.filter(a => !base.some(b => b.id === a.id));
  items = [...base, ...added].map(d => (edits.updated[d.id] ? { ...d, ...edits.updated[d.id] } : d));
  index = buildIndex(items);
}

async function fetchJSON(path) {
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

async function load() {
  edits = lsGet(LS.edits) || { updated: {}, added: [] };
  const imported = lsGet(LS.data);
  if (imported?.items?.length) { base = imported.items.map(normalize); source = "imported"; }
  else {
    try { base = extractList(await fetchJSON("data/questions.json")).map(normalize); source = "repo"; }
    catch {
      try { base = extractList(await fetchJSON("data/questions.sample.json")).map(normalize); source = "sample"; }
      catch { base = []; source = "none"; }
    }
  }
  applyEdits();
  fillSelects();
  readHash();
  run();
  if (sel) openDetail(sel, false);
}

function fillSelects() {
  const cats = [...new Set([...CATS, ...items.map(d => d.category).filter(Boolean)])];
  const prods = [...new Set([...PRODS, ...items.map(d => d.product).filter(Boolean)])];
  $("nCat").innerHTML = cats.map(c => `<option>${esc(c)}</option>`).join("");
  $("nProd").innerHTML = prods.map(c => `<option>${esc(c)}</option>`).join("");
  $("acctList").innerHTML = [...new Set(items.map(d => d.account))].sort().map(a => `<option value="${esc(a)}">`).join("");
}

// ---------- rendering ----------

function highlighter(terms) {
  const t = terms.filter(Boolean).sort((a, b) => b.length - a.length).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
  if (!t.length) return esc;
  const re = new RegExp(`\\b(?:${t.join("|")})[a-z0-9]*`, "gi");
  return text => {
    const s = String(text ?? ""); let out = "", last = 0, m;
    re.lastIndex = 0;
    while ((m = re.exec(s))) { out += esc(s.slice(last, m.index)) + `<mark>${esc(m[0])}</mark>`; last = m.index + m[0].length; if (!m[0]) re.lastIndex++; }
    return out + esc(s.slice(last));
  };
}

// A short excerpt of a long field, centered on the first highlighted term.
function snippet(text, terms, len = 150) {
  const s = String(text ?? "");
  if (s.length <= len) return s;
  const lower = s.toLowerCase();
  const at = Math.min(...terms.map(t => { const i = lower.search(new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)); return i < 0 ? Infinity : i; }));
  const start = Number.isFinite(at) ? Math.max(0, at - 40) : 0;
  return (start ? "…" : "") + s.slice(start, start + len).trim() + (start + len < s.length ? "…" : "");
}

function renderBanner() {
  const b = $("banner"), n = Object.keys(edits.updated).length + edits.added.length, parts = [];
  if (source === "sample") parts.push(`<span>Showing <b>sample data</b> with made-up accounts. Add your export as <code>data/questions.json</code>, or</span><button type="button" data-act="import">import a JSON or CSV file</button>`);
  if (source === "imported") parts.push(`<span>Using data you imported into this browser (${esc(lsGet(LS.data)?.at || "")}).</span><button type="button" data-act="revert">Go back to the shared data</button>`);
  if (source === "none") parts.push(`<span>No data loaded. Open this page through <code>npm start</code>, or</span><button type="button" data-act="import">import a JSON or CSV file</button>`);
  if (n) parts.push(`<span>${n} local change${n > 1 ? "s" : ""} saved in this browser only.</span><button type="button" data-act="export">Export the dataset to share them</button><button type="button" data-act="discard">Discard</button>`);
  b.innerHTML = parts.join(" ");
  b.hidden = !parts.length;
}

function renderStats() {
  const n = items.length, pe = items.filter(d => d.answererRole === "Product/Eng").length,
    open = items.filter(d => d.status !== "Answered").length, ref = items.filter(d => d.referenceAnswer).length,
    gaps = items.filter(isGap).length, accts = new Set(items.map(d => d.account)).size;
  const tiles = [
    [n, "questions cataloged", ""], [accts, "accounts", ""],
    [pe, `answered with product/eng (${n ? Math.round(pe / n * 100) : 0}%)`, "is:pe"],
    [open, "partial or deferred", "status:partial,deferred"], [gaps, "training gaps", "is:gap"], [ref, "have a reference answer", "has:answer"],
  ];
  $("stats").innerHTML = tiles.map(([v, l, q]) => q
    ? `<button class="stat" type="button" data-q="${esc(q)}" title="Search ${esc(q)}"><b>${v}</b><span>${esc(l)}</span></button>`
    : `<div class="stat"><b>${v}</b><span>${esc(l)}</span></div>`).join("");

  const rows = [...new Set(items.map(d => d.category).filter(Boolean))].map(c => {
    const g = items.filter(d => d.category === c);
    return { c, n: g.length, a: g.filter(d => d.status === "Answered" && d.answererRole !== "Product/Eng").length, pe: g.filter(d => d.status === "Answered" && d.answererRole === "Product/Eng").length, p: g.filter(d => d.status === "Partial").length, d: g.filter(d => d.status === "Deferred").length };
  }).sort((a, b) => b.n - a.n);
  const max = Math.max(1, ...rows.map(r => r.n)), w = x => `${x / max * 100}%`;
  $("bars").innerHTML = rows.map(r => `<button class="bar" type="button" data-c="${esc(r.c)}" title="Search topic: ${esc(r.c)}"><span>${esc(r.c)}</span><span class="track">
    <i style="width:${w(r.a)};background:var(--ok)"></i><i style="width:${w(r.pe)};background:var(--accent)"></i><i style="width:${w(r.p)};background:var(--warn)"></i><i style="width:${w(r.d)};background:var(--bad)"></i></span><span class="n">${r.n}</span></button>`).join("");
}

function renderFacets() {
  const q = $("q").value, list = current.results.map(r => r.item);
  const groups = [["topic", "category", "Topic"], ["product", "product", "Product"], ["status", "status", "Status"], ["role", "answererRole", "Answered by"], ["account", "account", "Account"]];
  $("facets").innerHTML = groups.map(([key, field, label]) => {
    let counts = facetCounts(list, field);
    // Keep selected values visible even when they'd fall off the list.
    const on = facetCounts(items, field).filter(([v]) => hasToken(q, key, v));
    for (const o of on) if (!counts.some(([v]) => v === o[0])) counts.push([o[0], 0]);
    if (key === "account") counts = counts.filter(([v], i) => i < 8 || hasToken(q, key, v));
    if (!counts.length) return "";
    return `<div class="facet"><h4>${label}</h4>${counts.map(([v, c]) =>
      `<button type="button" class="${hasToken(q, key, v) ? "on" : ""}" data-f="${key}" data-v="${esc(v)}"><span>${esc(v)}</span><span>${c}</span></button>`).join("")}</div>`;
  }).join("");
}

function sorted(results) {
  const mode = $("sort").value, r = [...results];
  if (mode === "relevance" && current.ranked) return r;
  const by = {
    relevance: (a, b) => b.item.date.localeCompare(a.item.date), date: (a, b) => b.item.date.localeCompare(a.item.date),
    "date-asc": (a, b) => a.item.date.localeCompare(b.item.date), account: (a, b) => a.item.account.localeCompare(b.item.account) || b.item.date.localeCompare(a.item.date),
    status: (a, b) => STATUS_ORDER[a.item.status] - STATUS_ORDER[b.item.status] || b.item.date.localeCompare(a.item.date),
  }[mode];
  return r.sort(by);
}

function renderRows() {
  const hl = highlighter(current.highlight), list = sorted(current.results);
  current.view = list;
  $("count").textContent = `${list.length} of ${items.length} questions`;
  $("partial").hidden = !current.partial;
  const w = current.query.warnings || [];
  $("warnings").hidden = !w.length; $("warnings").textContent = w.join(" · ");
  $("empty").hidden = list.length > 0;
  $("empty").textContent = !items.length ? (source === "none" ? "No questions loaded yet." : "No questions yet. Use “Add a question” to log the first one.") : "No questions match. Try fewer words, or remove a filter.";
  const terms = current.highlight;
  $("rows").innerHTML = list.map(({ item: d }) => {
    const ref = d.referenceAnswer, hitRef = terms.length && ref && words(ref).some(x => terms.some(t => x.startsWith(t)));
    const hitNote = terms.length && d.note && words(d.note).some(x => terms.some(t => x.startsWith(t)));
    return `<tr tabindex="0" data-id="${esc(d.id)}" class="${sel === d.id ? "sel" : ""}">
    <td class="q">${hl(d.question)}${ref ? ' <span class="has-ref">· has answer</span>' : ""}
      ${hitRef ? `<span class="snippet">Answer: ${hl(snippet(ref, terms))}</span>` : ""}
      ${hitNote ? `<span class="snippet">Note: ${hl(snippet(d.note, terms))}</span>` : ""}
      <div><span class="tag">${hl(d.category)}</span><span class="tag">${hl(d.product)}</span></div></td>
    <td class="acct">${hl(d.account)}${d.asker ? `<br><span class="muted">${hl(d.asker)}</span>` : ""}</td>
    <td>${hl(d.answeredBy) || "—"}${d.answererRole === "Product/Eng" ? '<br><span class="flag">Product/eng</span>' : ""}</td>
    <td><span class="pill s-${esc(d.status)}">${esc(d.status)}</span></td>
    <td class="date">${esc(d.date)}</td></tr>`;
  }).join("");
}

function run() {
  current = search(index, $("q").value);
  renderBanner(); renderStats(); renderFacets(); renderRows();
  writeHash();
}

function openDetail(id, focus = true) {
  const d = items.find(x => x.id === id);
  if (!d) return;
  sel = id;
  $("main").classList.add("open");
  const el = $("detail"); el.hidden = false;
  const hl = highlighter(current.highlight);
  const sims = similar(index, id, 5);
  el.innerHTML = `<div class="row" style="justify-content:space-between"><span class="pill s-${esc(d.status)}">${esc(d.status)}</span>
      <span class="row"><button class="btn ghost small" type="button" id="copyLink">Copy link</button><button class="btn ghost small" type="button" id="closeD">Close</button></span></div>
    <h3>${hl(d.question)}</h3>
    <dl class="kv"><dt>Account</dt><dd>${esc(d.account)}</dd><dt>Asked by</dt><dd>${esc(d.asker) || "—"}</dd>
      <dt>Answered by</dt><dd>${esc(d.answeredBy) || "—"} <span class="muted">(${esc(d.answererRole)})</span></dd>
      <dt>Topic</dt><dd>${esc(d.category)}</dd><dt>Product</dt><dd>${esc(d.product)}</dd><dt>Date</dt><dd>${esc(d.date)}</dd>
      <dt>Source</dt><dd>${/^https?:\/\//.test(d.sourceUrl) ? `<a href="${esc(d.sourceUrl)}" target="_blank" rel="noopener">Open ${esc(d.sourceLabel || "source")}</a>` : esc(d.sourceLabel || "—")}</dd>
      ${d.note ? `<dt>Note</dt><dd>${hl(d.note)}</dd>` : ""}</dl>
    <label class="sect" for="dStatus">Status</label>
    <select id="dStatus">${["Answered", "Partial", "Deferred"].map(s => `<option ${s === d.status ? "selected" : ""}>${s}</option>`).join("")}</select>
    <label class="sect" for="dRef">Reference answer for the SE team</label>
    <textarea id="dRef" placeholder="Write the answer an SE should give, with links to docs.">${esc(d.referenceAnswer)}</textarea>
    <div class="row"><button class="btn" type="button" id="saveD">Save</button><button class="btn ghost" type="button" id="copyAns" ${d.referenceAnswer ? "" : "hidden"}>Copy answer</button></div>
    <p class="sect">Similar questions</p>
    ${sims.length ? `<ul class="simlist">${sims.map(s => `<li><button type="button" data-id="${esc(s.item.id)}">${esc(s.item.question)}
      <small>${esc(s.item.account)} · ${esc(s.item.status)}${s.item.referenceAnswer ? " · has answer" : ""}</small></button></li>`).join("")}</ul>` : '<p class="muted">Nothing close yet.</p>'}`;
  $("closeD").onclick = closeDetail;
  $("copyLink").onclick = () => copy(location.href, "Link copied");
  $("copyAns").onclick = () => copy(d.referenceAnswer, "Answer copied");
  el.querySelectorAll(".simlist button").forEach(b => (b.onclick = () => openDetail(b.dataset.id)));
  $("saveD").onclick = () => {
    const patch = { status: $("dStatus").value, referenceAnswer: $("dRef").value.trim(), updatedAt: today() };
    const added = edits.added.find(a => a.id === id);
    if (added) Object.assign(added, patch); else edits.updated[id] = { ...edits.updated[id], ...patch };
    const ok = lsSet(LS.edits, edits);
    applyEdits(); run(); openDetail(id, false);
    toast(ok ? "Saved in this browser. Export the dataset to share it." : "Saved for this session only (browser storage is off).");
  };
  renderRows(); writeHash();
  if (focus && matchMedia("(max-width:1100px)").matches) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeDetail() {
  sel = null; $("detail").hidden = true; $("main").classList.remove("open"); renderRows(); writeHash();
}

async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); } catch { toast("Couldn't copy. Your browser blocked clipboard access."); }
}

// ---------- URL state ----------

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  $("q").value = p.get("q") || "";
  if (p.get("sort")) $("sort").value = p.get("sort");
  sel = p.get("id") || null;
}
function writeHash() {
  const p = new URLSearchParams();
  if ($("q").value.trim()) p.set("q", $("q").value.trim());
  if ($("sort").value !== "relevance") p.set("sort", $("sort").value);
  if (sel) p.set("id", sel);
  const h = p.toString();
  history.replaceState(null, "", h ? `#${h}` : location.pathname + location.search);
}

// ---------- import / export ----------

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportAs(kind) {
  const results = (current.view || []).map(r => r.item), stamp = today();
  if (kind === "csv") download(`questions-${stamp}.csv`, toCSV(results), "text/csv");
  if (kind === "json-results") download(`questions-${stamp}.json`, JSON.stringify(results, null, 2), "application/json");
  if (kind === "json-all") { download("questions.json", JSON.stringify(items, null, 2), "application/json"); toast("Commit it as data/questions.json to share with the team."); }
}

async function importFile(file) {
  try {
    const text = await file.text();
    const list = /\.csv$/i.test(file.name) || file.type === "text/csv" ? parseCSV(text) : extractList(JSON.parse(text));
    const norm = list.map(normalize).filter(d => d.question);
    if (!norm.length) throw new Error("No questions found in that file");
    if (items.length && !confirm(`Replace the ${items.length} questions in this browser with ${norm.length} from ${file.name}?`)) return;
    base = norm; source = "imported"; edits = { updated: {}, added: [] };
    const ok = lsSet(LS.data, { at: new Date().toLocaleString(), items: norm });
    lsSet(LS.edits, edits);
    applyEdits(); fillSelects(); closeDetail(); run();
    toast(ok ? `Imported ${norm.length} questions` : `Imported ${norm.length} questions for this session only`);
  } catch (e) { toast(`Couldn't import: ${e.message}`); }
}

// ---------- events ----------

let debounce;
$("q").addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(run, 80); });
$("sort").addEventListener("change", () => { renderRows(); writeHash(); });
$("helpBtn").onclick = () => { const h = $("help"); h.hidden = !h.hidden; $("helpBtn").setAttribute("aria-expanded", String(!h.hidden)); };
$("examples").innerHTML = EXAMPLES.map(x => `<button class="chip" type="button" data-q="${esc(x)}">${esc(x)}</button>`).join("");

function setQuery(q) { $("q").value = q; run(); }
document.addEventListener("click", e => {
  const t = e.target.closest("[data-q],[data-f],[data-c],[data-act],[data-export],#rows tr");
  if (!t) { if (!e.target.closest(".menu")) $("exportMenu").hidden = true; return; }
  if (t.dataset.q !== undefined) setQuery(t.dataset.q);
  else if (t.dataset.f) setQuery(toggleToken($("q").value, t.dataset.f, t.dataset.v));
  else if (t.dataset.c) setQuery(toggleToken($("q").value, "topic", t.dataset.c));
  else if (t.dataset.export) { $("exportMenu").hidden = true; exportAs(t.dataset.export); }
  else if (t.dataset.act === "import") $("importFile").click();
  else if (t.dataset.act === "export") exportAs("json-all");
  else if (t.dataset.act === "revert") { lsDel(LS.data); location.reload(); }
  else if (t.dataset.act === "discard") { if (confirm("Discard your local changes?")) { edits = { updated: {}, added: [] }; lsDel(LS.edits); applyEdits(); run(); if (sel) openDetail(sel, false); } }
  else if (t.matches("#rows tr")) openDetail(t.dataset.id);
});

$("exportBtn").onclick = () => { const m = $("exportMenu"); m.hidden = !m.hidden; $("exportBtn").setAttribute("aria-expanded", String(!m.hidden)); };
$("importBtn").onclick = () => $("importFile").click();
$("importFile").onchange = e => { const f = e.target.files[0]; if (f) importFile(f); e.target.value = ""; };

function moveSel(step) {
  const list = current.view || [];
  if (!list.length) return;
  const i = list.findIndex(r => r.item.id === sel);
  const next = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + step))];
  openDetail(next.item.id, false);
  document.querySelector(`#rows tr[data-id="${CSS.escape(next.item.id)}"]`)?.focus();
}

document.addEventListener("keydown", e => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (e.key === "/" && !typing) { e.preventDefault(); $("q").focus(); $("q").select(); }
  else if (e.key === "Escape") {
    if (!$("overlay").hidden) $("overlay").hidden = true;
    else if (sel && e.target !== $("q")) closeDetail();
  }
  else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && (!typing || e.target === $("q"))) { e.preventDefault(); moveSel(e.key === "ArrowDown" ? 1 : -1); }
  else if (e.key === "Enter" && e.target.matches?.("#rows tr")) openDetail(e.target.dataset.id);
});

// ---------- add a question ----------

$("addBtn").onclick = () => { $("overlay").hidden = false; $("nDate").value = today(); $("nQ").focus(); };
$("cancelAdd").onclick = () => ($("overlay").hidden = true);
$("overlay").addEventListener("click", e => { if (e.target === $("overlay")) $("overlay").hidden = true; });
let simDebounce;
$("nQ").addEventListener("input", () => {
  clearTimeout(simDebounce);
  simDebounce = setTimeout(() => {
    const sims = similarToText(index, $("nQ").value, 3).filter(s => s.score > 0.2), box = $("nSimilar");
    box.hidden = !sims.length;
    box.innerHTML = `Already asked? <ul>${sims.map(s => `<li>${esc(s.item.question)} <span class="muted">(${esc(s.item.account)}${s.item.referenceAnswer ? ", has answer" : ""})</span></li>`).join("")}</ul>`;
  }, 200);
});
$("addForm").addEventListener("submit", e => {
  e.preventDefault();
  const pe = $("nPE").checked, url = $("nUrl").value.trim(), by = $("nBy").value.trim();
  const d = normalize({
    id: "m" + Date.now().toString(36), question: $("nQ").value, account: $("nAcct").value.trim(), asker: $("nAsker").value.trim(),
    category: $("nCat").value, product: $("nProd").value, answeredBy: by || "—",
    answererRole: pe ? "Product/Eng" : /\(SE\)/.test(by) ? "SE" : "AE", status: $("nStatus").value,
    needsProduct: pe || $("nStatus").value !== "Answered", date: $("nDate").value || today(),
    sourceType: url ? "call" : "manual", sourceUrl: url, sourceLabel: url ? "Gong call" : "Added by SE",
  });
  edits.added.push(d);
  const ok = lsSet(LS.edits, edits);
  applyEdits(); fillSelects(); run();
  $("overlay").hidden = true; e.target.reset(); $("nSimilar").hidden = true;
  openDetail(d.id);
  toast(ok ? "Question added in this browser. Export the dataset to share it." : "Question added for this session only.");
});

load();
