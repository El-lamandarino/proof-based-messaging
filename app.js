// Proof-Based Messaging: browser logic.
// AI does language work (grouping, writing, checking). This file does the accuracy work:
// parsing, persona mapping, counting, recency, trends, and verifying that every quote really exists.

const RECENT_FROM = "2025-01-01";
const EXCERPT_WORDS = 30; // public pages show short excerpts only, credited to their source

const DEFAULT_PERSONAS = [
  {
    name: "Head of Fraud & Risk", person_name: "Maya Levin", type: "buyer", role_in_deal: "Champion",
    function: "Owns fraud strategy, rules and the review team",
    jtbd: "Stop fraud without blocking real customers\nUnderstand why each order was declined\nAdjust the strategy when fraud patterns change",
    cares_about: "Decision accuracy, false positives, transparency of declines, control over rules",
    keywords: "fraud, risk, compliance, crime, security, chargeback",
  },
  {
    name: "CFO", person_name: "Daniel Ortiz", type: "buyer", role_in_deal: "Economic buyer",
    function: "Owns revenue, payment costs and vendor budgets",
    jtbd: "Approve more revenue without taking on chargeback risk\nKnow the cost stays justified as volume grows",
    cares_about: "Approval rate, chargeback guarantee, ROI, cost as volume grows",
    keywords: "finance, payments, billing, accounting, c.o.o, cfo, revenue",
  },
  {
    name: "Head of eCommerce Operations", person_name: "Priya Shah", type: "buyer", role_in_deal: "User and influencer",
    function: "Runs order processing, customer service and the store platform",
    jtbd: "Cut manual order review\nExplain declines to customers quickly\nKeep checkout fast for good customers",
    cares_about: "Less manual review, explaining declines to customers, portal speed and usability",
    keywords: "ecommerce, e-commerce, customer service, customer support, cx, customer experience, operations, marketplace, quality assurance",
  },
  {
    name: "SDR", person_name: "Tom Becker", type: "internal", role_in_deal: "Internal checkpoint",
    function: "Opens first conversations with prospects",
    jtbd: "Remember the pitch after one read\nSay it naturally on a first call",
    cares_about: "A pitch short and clear enough to remember after one read and say naturally to a prospect",
    keywords: "",
  },
];

const PAGES = [
  { id: "reviews", label: "Reviews" },
  { id: "personas", label: "Personas" },
  { id: "report", label: "Report" },
  { id: "messaging", label: "Messaging" },
];

const state = {
  reviews: [], fileName: "", personas: structuredClone(DEFAULT_PERSONAS),
  result: null, selected: "PS", editPersonas: false,
  filters: { source: "", persona: "", q: "" },
};

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const buyers = (ps) => ps.filter((p) => p.type !== "internal");
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== "")) rows.push(row);
  const head = rows.shift().map((h) => h.trim().toLowerCase());
  const need = ["id", "source", "date", "reviewer_role", "company_size", "text"];
  const missing = need.filter((n) => !head.includes(n));
  if (missing.length) throw new Error("The CSV is missing these columns: " + missing.join(", "));
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
}

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[‘’‛`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[\s"'.,;:!?-]+|[\s"'.,;:!?-]+$/g, "")
    .trim();

function personaFor(role, personas) {
  if (/^unknown\b/i.test(role || "")) return null; // industry-only reviewers get no persona
  const r = String(role || "").split("(")[0].toLowerCase();
  for (const p of buyers(personas)) {
    const kws = String(p.keywords || "").split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
    if (kws.some((k) => r.includes(k))) return p.name;
  }
  return null;
}

function excerpt(text) {
  const w = String(text || "").split(/\s+/);
  return w.length > EXCERPT_WORDS ? w.slice(0, EXCERPT_WORDS).join(" ") + "…" : text;
}

/* ---------- code-side enrichment ---------- */
function enrichThemes(themes, reviews, personas) {
  const byId = Object.fromEntries(reviews.map((r) => [r.id, r]));
  const baseRecent = reviews.length ? reviews.filter((r) => r.date >= RECENT_FROM).length / reviews.length : 0;
  return themes.map((t) => {
    const ids = [...new Set((t.review_ids || []).filter((id) => byId[id]))];
    const quotes = (t.quotes || []).map((q) => {
      const src = byId[q.review_id];
      const verified = !!src && norm(src.text).includes(norm(q.quote));
      return { ...q, verified, source: src?.source || "", date: src?.date || "", role: src?.reviewer_role || "",
        persona: src ? personaFor(src.reviewer_role, personas) : null };
    });
    const persona_counts = Object.fromEntries(buyers(personas).map((p) => [p.name, 0]));
    let recent = 0;
    for (const id of ids) {
      const r = byId[id];
      if (r.date >= RECENT_FROM) recent++;
      const p = personaFor(r.reviewer_role, personas);
      if (p) persona_counts[p]++;
    }
    // trend: is this theme over- or under-represented in recent reviews vs the dataset overall?
    let trend = "too few reviews";
    if (ids.length >= 3) {
      const diff = recent / ids.length - baseRecent;
      trend = diff >= 0.15 ? "rising" : diff <= -0.15 ? "fading" : "steady";
    }
    return { ...t, review_ids: ids, review_count: ids.length, recent_count: recent, trend, persona_counts, quotes };
  });
}

function syllables(w) {
  w = w.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  const m = w.match(/[aeiouy]{1,2}/g);
  return Math.max(1, m ? m.length : 1);
}
function sdrMetrics(pitch) {
  if (!pitch) return null;
  const count = (t) => (String(t || "").match(/[A-Za-z0-9'%$]+/g) || []).length;
  const text = [pitch.one_liner, ...(pitch.talk_track || [])].join(". ");
  const words = text.match(/[A-Za-z']+/g) || [];
  const sentences = Math.max(1, (text.match(/[.!?]+/g) || []).length);
  const syl = words.reduce((n, w) => n + syllables(w), 0);
  const grade = words.length ? 0.39 * (words.length / sentences) + 11.8 * (syl / words.length) - 15.59 : 0;
  return {
    one_liner_words: count(pitch.one_liner),
    longest_track_words: Math.max(0, ...(pitch.talk_track || []).map(count)),
    reading_grade: Math.max(0, Math.round(grade * 10) / 10),
  };
}

/* ---------- API ---------- */
async function callStep(step, input) {
  const r = await fetch("/api/analyze", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step, input }),
  });
  let data = {};
  try { data = await r.json(); } catch { /* fall through */ }
  if (!r.ok) throw new Error(data.error || `Step "${step}" failed (${r.status}).`);
  return data;
}

function setStatus(msg, kind = "") {
  const el = $("#status");
  el.textContent = msg;
  el.dataset.kind = kind;
}

async function run() {
  if (!state.reviews.length) { go("reviews"); return setStatus("Upload a reviews CSV first.", "error"); }
  const product = $("#product").value.trim() || "the product";
  const btn = $("#run");
  btn.disabled = true;
  try {
    setStatus("Step 1 of 3: finding themes and quotes…");
    const lines = state.reviews
      .map((r) => [r.id, r.source, r.date, r.reviewer_role, r.company_size, r.text.replace(/\s+/g, " ")].join(" | "))
      .join("\n");
    const s1 = await callStep("themes", { product, reviews: lines });
    const themes = enrichThemes(s1.result.themes || [], state.reviews, state.personas)
      .filter((t) => t.review_count > 0)
      .sort((a, b) => b.review_count - a.review_count);

    setStatus("Step 2 of 3: writing positioning and messaging…");
    const forAI = themes.map(({ id, type, label, summary, review_count, recent_count, persona_counts, quotes }) => ({
      id, type, label, summary, review_count, recent_count, persona_counts,
      quotes: quotes.filter((q) => q.verified).map(({ review_id, quote, quote_en }) => ({ review_id, quote, quote_en })),
    }));
    const personas = buyers(state.personas).map(({ name, role_in_deal, cares_about }) => ({ name, role_in_deal, cares_about }));
    const s2 = await callStep("messaging", { product, themes: forAI, personas });

    setStatus("Step 3 of 3: checking every claim against the quotes…");
    const s3 = await callStep("proof", { messaging: s2.result, themes: forAI });

    state.result = buildResult(product, themes, s1.result.findings || [], s2.result, s3.result, s1.model);
    state.selected = "PS";
    renderAll();
    go("report");
    setStatus("Done. Start with the Report, then open Messaging.", "ok");
  } catch (e) {
    setStatus(e.message, "error");
  } finally {
    btn.disabled = false;
  }
}

function buildResult(product, themes, findings, messaging, proof, model) {
  const claims = proof.claims || [];
  const verdicts = { supported: 0, weak: 0, unsupported: 0 };
  claims.forEach((c) => { if (verdicts[c.verdict] !== undefined) verdicts[c.verdict]++; });
  const allQuotes = themes.flatMap((t) => t.quotes);
  const dates = state.reviews.map((r) => r.date).filter(Boolean).sort();
  const known = new Set(themes.map((t) => t.id));
  return {
    product, generated_at: new Date().toISOString(), model,
    dataset: {
      reviews: state.reviews.length,
      recent: state.reviews.filter((r) => r.date >= RECENT_FROM).length,
      sources: [...new Set(state.reviews.map((r) => r.source))],
      from: dates[0], to: dates[dates.length - 1],
    },
    reviews_public: state.reviews.map((r) => ({
      id: r.id, source: r.source, date: r.date, reviewer_role: r.reviewer_role, company_size: r.company_size,
      excerpt: excerpt(r.text),
    })),
    personas: state.personas,
    stats: {
      claims: claims.length, ...verdicts,
      quotes: allQuotes.length, quotes_verified: allQuotes.filter((q) => q.verified).length,
    },
    themes,
    findings: findings.map((f) => ({ ...f, theme_ids: (f.theme_ids || []).filter((id) => known.has(id)) })),
    messaging, claims,
    sdr: proof.sdr_check ? { ...proof.sdr_check, metrics: sdrMetrics(messaging.sdr_pitch) } : null,
  };
}

/* ---------- navigation ---------- */
function go(page) {
  if (!PAGES.some((p) => p.id === page)) page = state.result ? "messaging" : "reviews";
  if (location.hash.slice(1) !== page) history.replaceState(null, "", "#" + page);
  document.querySelectorAll(".page").forEach((s) => (s.hidden = s.id !== "page-" + page));
  document.querySelectorAll(".nav a").forEach((a) => {
    const on = a.dataset.page === page;
    a.classList.toggle("on", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  window.scrollTo({ top: 0 });
}

function renderNav() {
  $(".nav").innerHTML = PAGES.map((p, i) =>
    `<a href="#${p.id}" data-page="${p.id}"><span class="step">${i + 1}</span>${esc(p.label)}</a>`).join("");
}

/* ---------- top action bar ---------- */
function renderBar() {
  const loaded = state.reviews.length;
  const R = state.result;
  $("#bar-info").innerHTML = loaded
    ? `<b>${loaded} reviews</b> from your file · ${buyers(state.personas).length} buyer personas + SDR check`
    : R ? `Showing a saved run: <b>${esc(R.product)}</b>, ${R.dataset.reviews} reviews. Upload your own CSV on the Reviews page to run a new analysis.`
        : `No reviews yet. Start on the <a href="#reviews">Reviews</a> page.`;
  $("#run").hidden = !loaded;
}

/* ---------- page 1: reviews ---------- */
function reviewRows() {
  if (state.reviews.length)
    return state.reviews.map((r) => ({ ...r, persona: personaFor(r.reviewer_role, state.personas), full: true }));
  if (state.result?.reviews_public)
    return state.result.reviews_public.map((r) => ({ ...r, text: r.excerpt, persona: personaFor(r.reviewer_role, state.personas), full: false }));
  return [];
}

function renderReviews() {
  const rows = reviewRows();
  const local = state.reviews.length > 0;
  $("#reviews-note").innerHTML = local
    ? `Loaded from <b>${esc(state.fileName)}</b>. Full text stays in your browser; nothing is stored.`
    : rows.length ? `Short excerpts from public review sites, credited to their source.` : "";
  const sources = [...new Set(rows.map((r) => r.source))];
  const recent = rows.filter((r) => r.date >= RECENT_FROM).length;
  const mapped = rows.filter((r) => r.persona).length;
  $("#reviews-stats").innerHTML = rows.length ? `
    <div><dt>Reviews</dt><dd>${rows.length}</dd></div>
    <div><dt>Sources</dt><dd>${sources.map((s) => `${esc(s)} ${rows.filter((r) => r.source === s).length}`).join(" · ")}</dd></div>
    <div><dt>From 2025 or later</dt><dd>${recent} (${pct(recent, rows.length)}%)</dd></div>
    <div><dt>Matched to a buyer persona</dt><dd>${mapped} (${pct(mapped, rows.length)}%)</dd></div>` : "";

  const f = state.filters;
  $("#f-source").innerHTML = `<option value="">All sources</option>` + sources.map((s) => `<option ${f.source === s ? "selected" : ""}>${esc(s)}</option>`).join("");
  $("#f-persona").innerHTML = `<option value="">All personas</option>` +
    buyers(state.personas).map((p) => `<option ${f.persona === p.name ? "selected" : ""}>${esc(p.name)}</option>`).join("") +
    `<option value="__none" ${f.persona === "__none" ? "selected" : ""}>No persona</option>`;
  $(".filters").hidden = !rows.length;

  const q = f.q.toLowerCase();
  const shown = rows
    .filter((r) => !f.source || r.source === f.source)
    .filter((r) => !f.persona || (f.persona === "__none" ? !r.persona : r.persona === f.persona))
    .filter((r) => !q || (r.text + " " + r.reviewer_role).toLowerCase().includes(q))
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  $("#f-count").textContent = rows.length ? `${shown.length} shown` : "";
  $("#reviews-list").innerHTML = rows.length ? shown.map((r) => `
    <article class="review">
      <header>
        <code>${esc(r.id)}</code>
        <span>${esc(r.source)}</span><span>${esc(r.date)}</span>
        ${r.persona ? `<span class="ptag">${esc(r.persona)}</span>` : ""}
      </header>
      <p class="who">${esc(r.reviewer_role)}${r.company_size && r.company_size !== "Unknown" ? ` · ${esc(r.company_size)}` : ""}</p>
      <p class="txt">${esc(r.text).replace(/ \| (LIKE|DISLIKE|PROS|CONS|USE CASE|RECOMMEND|OVERALL|PROBLEM SOLVED):/g, "<br><b>$1:</b>").replace(/^(LIKE|USE CASE|OVERALL|PROS):/, "<b>$1:</b>")}</p>
    </article>`).join("") || `<p class="empty">No reviews match these filters.</p>`
    : `<div class="emptybox"><p><b>Upload a CSV of customer reviews to begin.</b></p>
       <p>Columns needed: id, source, date, reviewer_role, company_size, text. Use public reviews only.</p></div>`;
}

/* ---------- page 2: personas ---------- */
function personaQuote(name) {
  const R = state.result;
  if (!R) return null;
  for (const t of R.themes) for (const q of t.quotes) if (q.verified && q.persona === name) return q;
  return null;
}

function renderPersonas() {
  const R = state.result;
  const rows = reviewRows();
  const count = (n) => rows.filter((r) => r.persona === n).length;
  const msgs = R?.messaging?.personas || [];
  $("#persona-toggle").textContent = state.editPersonas ? "Done editing" : "Edit personas";
  $("#persona-reset").hidden = !state.editPersonas;

  $("#persona-grid").innerHTML = state.personas.map((p, i) => {
    const internal = p.type === "internal";
    if (state.editPersonas) return `
      <fieldset class="pcard edit" data-i="${i}">
        <legend>${internal ? "Internal checkpoint" : "Buyer"}</legend>
        <label>Person's name<input data-k="person_name" value="${esc(p.person_name)}"></label>
        <label>Job title<input data-k="name" value="${esc(p.name)}"></label>
        <label>Role in the deal<input data-k="role_in_deal" value="${esc(p.role_in_deal)}"></label>
        <label>Job function<input data-k="function" value="${esc(p.function)}"></label>
        <label>Jobs to be done (one per line)<textarea data-k="jtbd" rows="3">${esc(p.jtbd)}</textarea></label>
        <label>${internal ? "What we test" : "Cares about"}<input data-k="cares_about" value="${esc(p.cares_about)}"></label>
        ${internal ? "" : `<label>Match reviewer job titles containing<input data-k="keywords" value="${esc(p.keywords)}"></label>`}
      </fieldset>`;
    const q = internal ? null : personaQuote(p.name);
    const msg = msgs.find((m) => m.persona === p.name);
    const initials = (p.person_name || p.name).split(/\s+/).map((w) => w[0]).slice(0, 2).join("");
    return `
      <article class="pcard${internal ? " internal" : ""}">
        <div class="ptop">
          <span class="avatar" aria-hidden="true">${esc(initials)}</span>
          <div><h3>${esc(p.person_name)}</h3><p class="title">${esc(p.name)}</p></div>
        </div>
        <p class="deal">${esc(p.role_in_deal)}</p>
        <p class="func">${esc(p.function)}</p>
        <h4>Jobs to be done</h4>
        <ul>${String(p.jtbd || "").split("\n").filter(Boolean).map((j) => `<li>${esc(j)}</li>`).join("")}</ul>
        ${internal
          ? `<p class="evid">Not matched to reviews. Tests whether the messaging is easy to remember and say. Result on the <a href="#messaging">Messaging</a> page.</p>`
          : `<p class="evid">${count(p.name)} reviews from people in this role</p>
             ${q ? `<blockquote><p>“${esc(q.quote)}”</p><cite><code>${esc(q.review_id)}</code> ${esc(q.role)} · ${esc(q.source)}</cite></blockquote>` : ""}
             ${msg ? `<a class="tomsg" href="#messaging" data-item="${esc(msg.id)}">See their message →</a>` : ""}`}
      </article>`;
  }).join("");
}

/* ---------- page 3: report ---------- */
const TYPE_LABEL = { value: "Value", pain: "Pain", objection: "Objection", use_case: "Use case", trigger: "Trigger" };

function renderReport() {
  const R = state.result;
  $("#report-empty").hidden = !!R;
  $("#report-body").hidden = !R;
  if (!R) return;
  const D = R.dataset;
  $("#report-kpis").innerHTML = `
    <div><dt>Reviews analyzed</dt><dd>${D.reviews}</dd></div>
    <div><dt>Sources</dt><dd>${esc(D.sources.join(", "))}</dd></div>
    <div><dt>Period</dt><dd>${esc(D.from || "")} to ${esc(D.to || "")}</dd></div>
    <div><dt>From 2025 or later</dt><dd>${pct(D.recent, D.reviews)}%</dd></div>
    <div><dt>Themes found</dt><dd>${R.themes.length}</dd></div>
    <div><dt>Quotes verified word for word</dt><dd>${R.stats.quotes_verified} of ${R.stats.quotes}</dd></div>`;

  const tmap = Object.fromEntries(R.themes.map((t) => [t.id, t]));
  $("#report-findings").innerHTML = (R.findings || []).map((f) => `
    <li><b>${esc(f.headline)}</b><span>${esc(f.detail)}</span>
      <span class="tids">${(f.theme_ids || []).map((id) => `<a href="#report" data-theme="${esc(id)}">${esc(tmap[id]?.label || id)}</a>`).join("")}</span></li>`).join("")
    || `<li class="empty">No findings in this run.</li>`;

  const max = Math.max(1, ...R.themes.map((t) => t.review_count));
  const groups = [["value", "Why customers buy and stay"], ["use_case", "What they use it for"], ["trigger", "What made them look"], ["pain", "Pains"], ["objection", "Objections and concerns"]];
  $("#report-themes").innerHTML = groups.map(([type, title]) => {
    const ts = R.themes.filter((t) => t.type === type);
    if (!ts.length) return "";
    return `<div class="tgroup"><h4>${esc(title)}</h4>${ts.map((t) => `
      <details class="trow" id="theme-${esc(t.id)}">
        <summary>
          <span class="tname">${esc(t.label)}</span>
          <span class="tbar"><span class="fill type-${esc(t.type)}" style="width:${Math.round((t.review_count / max) * 100)}%"></span></span>
          <span class="tnum">${t.review_count}</span>
          <span class="trend trend-${esc(t.trend.replace(/ /g, "-"))}">${esc(t.trend)}</span>
        </summary>
        <div class="tbody">
          <p>${esc(t.summary)}</p>
          ${t.quotes.slice(0, 3).map(quoteHTML).join("")}
        </div>
      </details>`).join("")}</div>`;
  }).join("");

  const pNames = buyers(R.personas).map((p) => p.name);
  const pmax = Math.max(1, ...R.themes.flatMap((t) => pNames.map((n) => t.persona_counts[n] || 0)));
  $("#report-heat").innerHTML = `
    <table class="heat">
      <thead><tr><th>Theme</th>${pNames.map((n) => `<th class="n">${esc(n)}</th>`).join("")}</tr></thead>
      <tbody>${R.themes.map((t) => `<tr><td><span class="type type-${esc(t.type)}">${esc(TYPE_LABEL[t.type] || t.type)}</span> ${esc(t.label)}</td>
        ${pNames.map((n) => { const v = t.persona_counts[n] || 0; return `<td class="n"><span class="cell" style="--a:${(v / pmax).toFixed(2)}">${v || "·"}</span></td>`; }).join("")}</tr>`).join("")}
      </tbody>
    </table>`;
}

/* ---------- page 4: messaging ---------- */
const RANK = { unsupported: 3, weak: 2, supported: 1 };
function itemVerdict(id) {
  const cs = (state.result?.claims || []).filter((c) => c.item_id === id);
  if (!cs.length) return "unchecked";
  return cs.reduce((w, c) => ((RANK[c.verdict] || 0) > (RANK[w] || 0) ? c.verdict : w), "supported");
}
function line(id, inner, tag = "div") {
  const v = itemVerdict(id);
  const sel = state.selected === id ? " is-selected" : "";
  return `<${tag} class="claim v-${v}${sel}" data-item="${esc(id)}" tabindex="0" role="button" aria-label="Show evidence (${v})">${inner}</${tag}>`;
}
function findItem(id) {
  const m = state.result?.messaging || {};
  return [m.positioning, m.value_prop, ...(m.pillars || []), ...(m.personas || []), ...(m.objections || []), m.outreach_email, m.sdr_pitch]
    .find((x) => x && x.id === id);
}

function renderMessaging() {
  const R = state.result;
  $("#msg-empty").hidden = !!R;
  $("#msg-body").hidden = !R;
  if (!R) return;
  const m = R.messaging, s = R.stats;
  $("#scoreline").innerHTML = `
    <div class="score"><strong>${pct(s.supported, s.claims)}%</strong><span>of ${s.claims} claims backed by customer quotes</span></div>
    <ul class="tally">
      <li class="t-supported">${s.supported} supported</li>
      <li class="t-weak">${s.weak} weak</li>
      <li class="t-unsupported">${s.unsupported} unsupported</li>
    </ul>`;

  const ps = m.positioning, vp = m.value_prop || {}, em = m.outreach_email || {};
  const posPlain = positioningSentence(ps, R.product);
  const posWords = (posPlain.match(/[A-Za-z0-9'&%$-]+/g) || []).length;
  const posText = ps ? `For <b>${esc(ps.for_who)}</b> ${esc(needText(ps.need))}, ${esc(R.product)} is the ${esc(ps.category)} that <b>${esc(ps.key_benefit)}</b>, unlike ${esc(ps.unlike)}.` : "";
  const ra = ps?.rationale;
  const why = ra ? `<details class="why"><summary>Why this positioning</summary><dl>
      <div><dt>Alternative</dt><dd>${esc(ra.alternative)}</dd></div>
      <div><dt>Unique attribute</dt><dd>${esc(ra.unique_attribute)}</dd></div>
      <div><dt>Target</dt><dd>${esc(ra.target)}</dd></div>
      ${ra.left_out?.length ? `<div><dt>Left out on purpose</dt><dd><ul>${ra.left_out.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></dd></div>` : ""}
    </dl></details>` : "";
  $("#msg-positioning").innerHTML = `
    ${ps ? `<section class="block"><h3>Positioning statement · ${posWords} words${posWords > 30 ? ` <span class="over">over the 30-word limit</span>` : ""}</h3>${line(ps.id || "PS", `<span class="pos">${posText}</span>`)}${why}</section>` : ""}
    <section class="block"><h3>Value proposition</h3>${line(vp.id || "VP", `<span class="vp">${esc(vp.text)}</span>`)}</section>`;
  $("#msg-messaging").innerHTML = `
    <section class="block"><h3>Messaging pillars</h3>${(m.pillars || []).map((p) =>
      line(p.id, `<b>${esc(p.headline)}</b><span>${esc(p.body)}</span>`)).join("")}</section>
    <section class="block"><h3>By persona</h3>${(m.personas || []).map((p) => {
      const per = R.personas.find((x) => x.name === p.persona);
      return line(p.id, `<b>${esc(p.persona)}${per?.person_name ? ` <small>(${esc(per.person_name)})</small>` : ""}</b><span class="pain">Top pain: ${esc(p.top_pain)}</span><span>${esc(p.message)}</span>${p.evidence_note ? `<em class="note">${esc(p.evidence_note)}</em>` : ""}`);
    }).join("")}</section>`;
  $("#msg-sales").innerHTML = `
    <section class="block"><h3>Objection handling</h3>${(m.objections || []).map((o) =>
      line(o.id, `<b>“${esc(o.objection)}”</b><span>${esc(o.response)}</span>`)).join("")}</section>
    <section class="block"><h3>Outreach email · to ${esc(em.persona)}</h3>
      ${line(em.id || "EM", `<b>Subject: ${esc(em.subject)}</b><span class="email">${esc(em.body)}</span>`)}</section>
    ${sdrHTML(m.sdr_pitch, R.sdr)}`;
  renderEvidence();
}

// One sentence, max 30 words: For [target] who [need], [product] is the [category] that [benefit], unlike [alternative].
function needText(need) {
  const n = String(need || "").trim().replace(/[.\s]+$/, "");
  return /^(who|that)\b/i.test(n) || /^\w+ing\b/i.test(n) ? n : "who " + n;
}
function positioningSentence(ps, product) {
  if (!ps) return "";
  const clean = (x) => String(x || "").trim().replace(/[.\s]+$/, "");
  return `For ${clean(ps.for_who)} ${needText(ps.need)}, ${product} is the ${clean(ps.category)} that ${clean(ps.key_benefit)}, unlike ${clean(ps.unlike)}.`;
}

function sdrHTML(pitch, chk) {
  if (!pitch) return "";
  const mt = chk?.metrics || sdrMetrics(pitch) || {};
  const cls = (c) => (c ? "" : ' class="warn"');
  return `<section class="block">
      <h3>SDR pitch · can they remember it and say it?</h3>
      ${line(pitch.id || "SD", `<b class="oneliner">${esc(pitch.one_liner)}</b><span class="track">${(pitch.talk_track || []).map((t) => `<span>${esc(t)}</span>`).join("")}</span>`)}
      ${chk ? `<div class="sdr-card sdr-${esc(chk.verdict)}">
        <p class="sdr-verdict">${chk.verdict === "pass" ? "Passes the SDR test" : "Needs a simpler version"}</p>
        <dl>
          <div><dt>Recall</dt><dd>${esc(chk.recall)} / 5</dd></div>
          <div><dt>Says it naturally</dt><dd>${esc(chk.say_it)} / 5</dd></div>
          <div${cls(mt.one_liner_words <= 15)}><dt>One-liner</dt><dd>${mt.one_liner_words} words</dd></div>
          <div${cls(mt.reading_grade <= 8)}><dt>Reading grade</dt><dd>${mt.reading_grade}</dd></div>
          <div${cls(chk.matches_messaging)}><dt>Same promise as value prop</dt><dd>${chk.matches_messaging ? "Yes" : "No"}</dd></div>
        </dl>
        ${chk.jargon?.length ? `<p class="jargon">Hard to say: ${chk.jargon.map((j) => `<span>${esc(j)}</span>`).join("")}</p>` : ""}
        <p class="reason">${esc(chk.note)}</p>
        ${chk.simpler_version ? `<p class="rewrite"><span>Try:</span> ${esc(chk.simpler_version)}</p>` : ""}
      </div>` : ""}
    </section>`;
}

function quoteHTML(q) {
  return `<blockquote class="${q.verified ? "" : "unverified"}">
    <p>“${esc(q.quote)}”${q.quote_en ? `<span class="tr">${esc(q.quote_en)}</span>` : ""}</p>
    <cite><code>${esc(q.review_id)}</code> ${esc(q.role)} · ${esc(q.source)} · ${esc(q.date)}${q.verified ? "" : ' · <strong>not found in source text</strong>'}</cite>
  </blockquote>`;
}

function renderEvidence() {
  const R = state.result, id = state.selected, el = $("#evidence");
  const item = id && findItem(id);
  if (!item) { el.innerHTML = `<p class="empty">Click any line to see the customer quotes behind it.</p>`; return; }
  const claims = R.claims.filter((c) => c.item_id === id);
  const themes = R.themes.filter((t) => (item.theme_ids || []).includes(t.id));
  el.innerHTML = `
    <h3>Evidence</h3>
    ${claims.map((c) => `
      <div class="check v-${esc(c.verdict)}">
        <span class="badge">${esc(c.verdict)}</span>
        <p class="claimtext">${esc(c.claim)}</p>
        <p class="reason">${esc(c.reason)}</p>
        ${c.suggested_rewrite ? `<p class="rewrite"><span>Evidence supports:</span> ${esc(c.suggested_rewrite)}</p>` : ""}
      </div>`).join("") || `<p class="empty">No claims were checked for this line.</p>`}
    ${themes.map((t) => `
      <div class="theme-ev">
        <p class="tlabel">${esc(t.label)} <span>${t.review_count} reviews · ${t.recent_count} since 2025</span></p>
        ${t.quotes.slice(0, 3).map(quoteHTML).join("")}
      </div>`).join("")}`;
}

function renderAll() {
  renderBar(); renderReviews(); renderPersonas(); renderReport(); renderMessaging();
}

/* ---------- data in / out ---------- */
function loadCSVText(text, label) {
  try {
    state.reviews = parseCSV(text);
    state.fileName = label;
    renderAll();
    setStatus(`${state.reviews.length} reviews loaded. Check the Personas page, then click Analyze reviews.`, "ok");
  } catch (e) { setStatus(e.message, "error"); }
}

function exportJSON() {
  if (!state.result) return setStatus("Run an analysis first, then export it.", "error");
  const blob = new Blob([JSON.stringify(state.result, null, 2)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "example.json" });
  a.click();
  URL.revokeObjectURL(a.href);
}

async function loadExample() {
  try {
    const r = await fetch("data/example.json", { cache: "no-store" });
    if (!r.ok) return false;
    state.result = await r.json();
    if (state.result.personas) state.personas = state.result.personas;
    $("#product").value = state.result.product || "";
    return true;
  } catch { return false; }
}

/* ---------- wire up ---------- */
if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", async () => {
  renderNav();
  await loadExample();
  renderAll();
  go(location.hash.slice(1));
  window.addEventListener("hashchange", () => go(location.hash.slice(1)));

  $("#file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (f) loadCSVText(await f.text(), f.name);
  });
  $("#run").addEventListener("click", run);
  $("#export").addEventListener("click", exportJSON);

  $(".filters").addEventListener("input", (e) => {
    const k = e.target.dataset.f;
    if (!k) return;
    state.filters[k] = e.target.value;
    renderReviews();
  });

  $("#persona-toggle").addEventListener("click", () => { state.editPersonas = !state.editPersonas; renderPersonas(); renderBar(); });
  $("#persona-reset").addEventListener("click", () => { state.personas = structuredClone(DEFAULT_PERSONAS); renderPersonas(); });
  $("#persona-grid").addEventListener("input", (e) => {
    const fs = e.target.closest(".pcard.edit");
    if (!fs) return;
    state.personas[+fs.dataset.i][e.target.dataset.k] = e.target.value;
  });
  $("#persona-grid").addEventListener("click", (e) => {
    const a = e.target.closest(".tomsg");
    if (a) { state.selected = a.dataset.item; renderMessaging(); }
  });
  $("#report-findings").addEventListener("click", (e) => {
    const a = e.target.closest("[data-theme]");
    if (!a) return;
    e.preventDefault();
    const d = document.getElementById("theme-" + a.dataset.theme);
    if (d) { d.open = true; d.scrollIntoView({ behavior: "smooth", block: "center" }); }
  });

  const pick = (e) => {
    const c = e.target.closest(".claim");
    if (!c) return;
    if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    state.selected = c.dataset.item;
    document.querySelectorAll(".claim").forEach((x) => x.classList.toggle("is-selected", x === c));
    renderEvidence();
    if (window.matchMedia("(max-width: 900px)").matches) $("#evidence").scrollIntoView({ behavior: "smooth", block: "start" });
  };
  $("#msg-body").addEventListener("click", pick);
  $("#msg-body").addEventListener("keydown", pick);
});

// Exposed for testing in Node
if (typeof module !== "undefined") module.exports = { positioningSentence, parseCSV, norm, personaFor, enrichThemes, sdrMetrics, buyers, excerpt, DEFAULT_PERSONAS };
