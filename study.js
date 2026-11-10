/* Resin duct counting study (CSE 594 Assignment 3).
 * One page serves both conditions: index.html?cond=withoutai  and  index.html?cond=withai
 * Data are sent to a Google Apps Script web app (config.js) as one record per event:
 *   session (start / complete / terminated), trial (one per image), questionnaire.
 */
(() => {
"use strict";

const CFG = window.STUDY_CONFIG || {};
const SCRIPT_URL = CFG.SCRIPT_URL || "";
const N_TRIALS = CFG.N_TRIALS || 6;
const N_TOTAL = N_TRIALS + 1;            // + one attention-check (catch) image
const CATCH_TOLERANCE = 1;               // catch image passes if |count - truth| <= 1
const MIN_ZOOM_FACTOR = 1, MAX_ZOOM_FACTOR = 8;   // relative to "fit"
const DRAG_PX = 5;                       // pointer movement that turns a click into a drag

const params = new URLSearchParams(location.search);
const COND = (params.get("cond") || "").toLowerCase();
const IS_AI = COND === "withai";
const VALID_COND = COND === "withai" || COND === "withoutai";

const $ = id => document.getElementById(id);
const now = () => Math.round(performance.now());

/* ---------------- state ---------------- */
let allTrials = [];
let plan = [];                 // trials for this session (incl. catch)
let idx = 0;
let participant = "";
let pkey = "";
const sessionId = "S-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
const sessionStart = Date.now();
let quizFails = 0;
let quizChoice = null;
let catchPass = null;
let orderInCondition = 1;

// per-trial state
let marks = [];                // human marks: {id, x, y, t}
let rejected = new Set();      // indices of AI ducts the participant rejected
let confidence = null;
let tState = null;             // counters/timers for the current trial
let markSeq = 0;

/* ---------------- storage helpers (never let storage errors break the study) ---------------- */
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }
const normName = s => s.trim().toLowerCase().replace(/\s+/g, " ");

/* ---------------- sending data ---------------- */
let queue = [];
let inflight = null;
let retryTimer = null;
let recSeq = 0;

function record(type, data) {
  const rec = Object.assign({
    type, record_id: `${sessionId}-${++recSeq}`, session_id: sessionId,
    participant, condition: COND, client_ts: new Date().toISOString(),
  }, data);
  queue.push(rec);
  const backup = lsGet("a3_backup", []); backup.push(rec); lsSet("a3_backup", backup.slice(-400));
  flush();
  return rec;
}

// Resolves true once everything queued so far has been sent, false if the network failed.
function flush() {
  if (!SCRIPT_URL) {
    if (queue.length) console.log("[TEST MODE] would send:", queue.splice(0));
    return Promise.resolve(true);
  }
  if (inflight) return inflight.then(ok => (ok ? flush() : false));
  if (!queue.length) return Promise.resolve(true);
  const batch = queue.slice();
  inflight = fetch(SCRIPT_URL, {
    method: "POST", mode: "no-cors",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ records: batch }),
  }).then(() => {
    queue.splice(0, batch.length);
    inflight = null;
    return true;
  }).catch(() => {
    inflight = null;
    if (!retryTimer) retryTimer = setTimeout(() => { retryTimer = null; flush(); }, 3000);  // background retry
    return false;
  });
  return inflight.then(ok => (ok && queue.length ? flush() : ok));
}

/* ---------------- screens ---------------- */
function show(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  $(id).classList.add("active");
  window.scrollTo(0, 0);
}

/* ---------------- setup ---------------- */
document.querySelectorAll(".n-images").forEach(e => e.textContent = N_TOTAL);
if (!SCRIPT_URL) $("test-banner").hidden = false;
if (!VALID_COND) $("cond-error").hidden = false;
if (IS_AI) {
  $("ai-instructions").hidden = false;
  document.querySelectorAll(".ai-only").forEach(e => e.hidden = false);
  $("task-hint").textContent = "Cyan = AI's ducts (click to reject or restore). Click a duct the AI missed to add a pink marker. Scroll to zoom, drag to move.";
}
$("cond-eyebrow").textContent = VALID_COND ? (IS_AI ? "Version B - with AI assistance" : "Version A - without AI") : "";

fetch("data/trials.json")
  .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then(d => { allTrials = d; updateWelcome(); })
  .catch(() => {
    $("load-error").textContent = "The study data couldn't be loaded. Please reload the page; if it keeps happening, tell the researcher.";
    $("load-error").hidden = false;
  });

function updateWelcome() {
  $("btn-welcome").disabled = !(VALID_COND && allTrials.length && $("consent").checked && $("pname").value.trim().length >= 2);
}
$("consent").addEventListener("change", updateWelcome);
$("pname").addEventListener("input", updateWelcome);

/* ---------------- trial selection ---------------- */
function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function buildPlan() {
  const seen = new Set(lsGet("a3_seen_" + pkey, []));
  const seenCores = new Set(allTrials.filter(t => seen.has(t.id)).map(t => t.core));
  const nCores = p => new Set(p.map(t => t.core)).size;
  // Prefer cores this participant hasn't seen (crops of one core overlap), then unseen trials, then anything.
  let pool = allTrials.filter(t => t.pool && !seenCores.has(t.core));
  if (nCores(pool) < N_TRIALS) pool = allTrials.filter(t => t.pool && !seen.has(t.id));
  if (nCores(pool) < N_TRIALS) pool = allTrials.filter(t => t.pool);
  // one trial per core: neighbouring crops overlap by 50%, so two crops of one core repeat ducts
  const byCore = {};
  shuffle(pool).forEach(t => { (byCore[t.core] = byCore[t.core] || []).push(t); });
  const chosen = shuffle(Object.keys(byCore)).slice(0, N_TRIALS).map(c => byCore[c][0]);

  const catches = allTrials.filter(t => t.catch);
  const freshCatch = catches.filter(t => !seen.has(t.id));
  const catchTrial = shuffle(freshCatch.length ? freshCatch : catches)[0];
  const pos = 2 + Math.floor(Math.random() * (N_TRIALS - 1));   // never 1st or 2nd image
  chosen.splice(pos, 0, catchTrial);
  return chosen;
}

/* ---------------- welcome → instructions → quiz ---------------- */
$("btn-welcome").addEventListener("click", () => {
  participant = $("pname").value.trim();
  pkey = normName(participant);
  const done = lsGet("a3_done_" + pkey, []);
  orderInCondition = done.filter(c => c !== COND).length ? 2 : 1;
  plan = buildPlan();
  plan.forEach(t => { const im = new Image(); im.src = `img/${t.id}.jpg`; });   // preload
  record("session", {
    event: "start", order_guess: orderInCondition, n_trials: plan.length,
    plan: plan.map(t => t.id).join(" "),
  });
  show("s-instructions");
});

$("btn-instructions").addEventListener("click", () => { buildQuiz(); show("s-quiz"); });

const QUIZ = [
  { k: "all", text: "Every duct in the image, including the greyed-out area" },
  { k: "bright", text: "Only ducts in the bright (not greyed-out) area" },
  { k: "specks", text: "Every dark dot, including the tiny specks" },
];
function buildQuiz() {
  quizChoice = null;
  $("btn-quiz").disabled = true;
  $("quiz-feedback").hidden = true;
  const box = $("quiz-options");
  box.innerHTML = "";
  shuffle(QUIZ).forEach(o => {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = o.text; b.setAttribute("role", "radio"); b.setAttribute("aria-checked", "false");
    b.addEventListener("click", () => {
      quizChoice = o.k;
      box.querySelectorAll("button").forEach(x => x.setAttribute("aria-checked", x === b ? "true" : "false"));
      $("btn-quiz").disabled = false;
    });
    box.appendChild(b);
  });
}

$("btn-quiz").addEventListener("click", () => {
  const pass = quizChoice === "bright";
  record("session", { event: "quiz", quiz_answer: quizChoice, quiz_pass: pass, quiz_attempt: quizFails + 1 });
  if (pass) { idx = 0; show("s-task"); startTrial(); return; }
  quizFails++;
  if (quizFails >= 2) {
    record("session", { event: "terminated", reason: "failed instructions check twice", quiz_fails: quizFails });
    show("s-terminated");
    return;
  }
  // first miss: back to the instructions, then try again
  show("s-instructions");
  const p = document.createElement("p");
  p.className = "error"; p.id = "reread";
  p.textContent = "That wasn't quite right. Please read the rules again, then answer once more.";
  if (!$("reread")) $("btn-instructions").before(p);
});

/* ---------------- viewer: zoom, pan, click ---------------- */
const viewer = $("viewer"), stage = $("stage"), img = $("trial-img"), svg = $("overlay");
const aiLayer = $("ai-layer"), humanLayer = $("human-layer");
let view = { s: 1, tx: 0, ty: 0, fit: 1 };

function applyView() { stage.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`; }

// whole=true shows the entire image; the default start view fills the width and may crop up to
// 20% of the height (mostly the mounting board above/below the core), so ducts are visible at a usable size.
function fitView(whole) {
  const t = plan[idx];
  const W = viewer.clientWidth, H = viewer.clientHeight;
  view.fit = Math.min(W / t.w, H / t.h);
  view.s = whole ? view.fit : Math.min(W / t.w, H / (0.8 * t.h));
  view.tx = (W - t.w * view.s) / 2;
  view.ty = (H - t.h * view.s) / 2;
  applyView();
}

function clampView() {
  const t = plan[idx];
  const W = viewer.clientWidth, H = viewer.clientHeight;
  const w = t.w * view.s, h = t.h * view.s;
  view.tx = w <= W ? (W - w) / 2 : Math.min(0, Math.max(W - w, view.tx));
  view.ty = h <= H ? (H - h) / 2 : Math.min(0, Math.max(H - h, view.ty));
}

function zoomAt(factor, cx, cy) {
  const s2 = Math.min(view.fit * MAX_ZOOM_FACTOR, Math.max(view.fit * MIN_ZOOM_FACTOR, view.s * factor));
  const k = s2 / view.s;
  view.tx = cx - (cx - view.tx) * k;
  view.ty = cy - (cy - view.ty) * k;
  view.s = s2;
  clampView(); applyView();
  if (tState) { tState.zoom_events++; tState.max_zoom = Math.max(tState.max_zoom, +(view.s / view.fit).toFixed(2)); }
}

viewer.addEventListener("wheel", e => {
  e.preventDefault();
  const r = viewer.getBoundingClientRect();
  zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });
$("zoom-in").addEventListener("click", () => zoomAt(1.5, viewer.clientWidth / 2, viewer.clientHeight / 2));
$("zoom-out").addEventListener("click", () => zoomAt(1 / 1.5, viewer.clientWidth / 2, viewer.clientHeight / 2));
$("zoom-fit").addEventListener("click", () => { fitView(true); if (tState) tState.zoom_events++; });
window.addEventListener("resize", () => { if ($("s-task").classList.contains("active") && plan[idx]) fitView(); });

let ptr = null;
viewer.addEventListener("pointerdown", e => {
  if (e.target.closest(".viewer-tools") || e.button !== 0) return;
  ptr = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, target: e.target, drag: false, id: e.pointerId };
  viewer.setPointerCapture(e.pointerId);
});
viewer.addEventListener("pointermove", e => {
  if (!ptr || e.pointerId !== ptr.id) return;
  const dx = e.clientX - ptr.x, dy = e.clientY - ptr.y;
  if (!ptr.drag && Math.hypot(dx, dy) > DRAG_PX) { ptr.drag = true; viewer.classList.add("dragging"); }
  if (ptr.drag) { view.tx = ptr.tx + dx; view.ty = ptr.ty + dy; clampView(); applyView(); }
});
viewer.addEventListener("pointerup", e => {
  if (!ptr || e.pointerId !== ptr.id) return;
  const p = ptr; ptr = null;
  viewer.classList.remove("dragging");
  if (p.drag) { if (tState) tState.pans++; return; }
  handleClick(p.target, e.clientX, e.clientY);
});
viewer.addEventListener("pointercancel", () => { ptr = null; viewer.classList.remove("dragging"); });

function toImage(cx, cy) {
  const r = viewer.getBoundingClientRect();
  return { x: (cx - r.left - view.tx) / view.s, y: (cy - r.top - view.ty) / view.s };
}

let toastTimer = null;
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 1800);
}

function handleClick(target, cx, cy) {
  if (!tState || !tState.loaded) return;
  const t = plan[idx];
  if (tState.first_action_ms === null) tState.first_action_ms = now() - tState.start;

  const hm = target.closest && target.closest(".human-mark");
  if (hm) {
    const id = +hm.dataset.id;
    marks = marks.filter(m => m.id !== id);
    tState.removes++;
    tState.log.push(["rm", id, now() - tState.start]);
    renderMarks(); updateCount(); return;
  }
  const ad = target.closest && target.closest(".ai-duct");
  if (ad && IS_AI && $("ai-toggle").checked) {
    const k = +ad.dataset.k;
    if (rejected.has(k)) { rejected.delete(k); tState.ai_restores++; tState.log.push(["ai+", k, now() - tState.start]); }
    else { rejected.add(k); tState.ai_rejects++; tState.log.push(["ai-", k, now() - tState.start]); }
    ad.classList.toggle("rejected", rejected.has(k));
    updateCount(); return;
  }
  const p = toImage(cx, cy);
  if (p.x < 0 || p.y < 0 || p.x >= t.w || p.y >= t.h) return;
  if (p.x < t.v0 || p.x >= t.v1) { toast("That's in the greyed-out area, which isn't counted."); tState.grey_clicks++; return; }
  const m = { id: ++markSeq, x: +p.x.toFixed(1), y: +p.y.toFixed(1), t: now() - tState.start };
  marks.push(m);
  tState.adds++;
  tState.log.push(["add", m.id, m.t]);
  renderMarks(); updateCount();
}

/* ---------------- drawing ---------------- */
const NS = "http://www.w3.org/2000/svg";
function el(name, attrs) { const e = document.createElementNS(NS, name); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }

function renderAI(t) {
  aiLayer.innerHTML = "";
  if (!IS_AI) return;
  t.ai.forEach((d, k) => {
    const g = el("g", { class: "ai-duct", "data-k": k });
    const r = Math.max(9, Math.sqrt(d.area / Math.PI) + 4);
    g.appendChild(el("circle", { class: "hit", cx: d.cx, cy: d.cy, r }));
    g.appendChild(el("polygon", { points: d.pts }));
    const q = r * 0.55;
    g.appendChild(el("line", { x1: d.cx - q, y1: d.cy - q, x2: d.cx + q, y2: d.cy + q }));
    g.appendChild(el("line", { x1: d.cx - q, y1: d.cy + q, x2: d.cx + q, y2: d.cy - q }));
    aiLayer.appendChild(g);
  });
}

function renderMarks() {
  humanLayer.innerHTML = "";
  marks.forEach(m => {
    const g = el("g", { class: "human-mark", "data-id": m.id });
    g.appendChild(el("circle", { class: "hit", cx: m.x, cy: m.y, r: 9 }));
    g.appendChild(el("circle", { class: "ring", cx: m.x, cy: m.y, r: 7 }));
    g.appendChild(el("circle", { class: "dot", cx: m.x, cy: m.y, r: 1.4 }));
    humanLayer.appendChild(g);
  });
}

function currentCount() {
  const t = plan[idx];
  return marks.length + (IS_AI ? t.ai.length - rejected.size : 0);
}
function updateCount() { $("my-count").textContent = currentCount(); }

/* ---------------- confidence scale ---------------- */
function buildScale(box, onPick) {
  box.innerHTML = "";
  for (let v = 1; v <= 7; v++) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = v; b.setAttribute("role", "radio"); b.setAttribute("aria-checked", "false");
    b.addEventListener("click", () => {
      box.querySelectorAll("button").forEach(x => x.setAttribute("aria-checked", x === b ? "true" : "false"));
      onPick(v);
    });
    box.appendChild(b);
  }
}

/* ---------------- trial flow ---------------- */
function startTrial() {
  const t = plan[idx];
  marks = []; rejected = new Set(); confidence = null; markSeq = 0;
  tState = { start: now(), loaded: false, first_action_ms: null, adds: 0, removes: 0, ai_rejects: 0, ai_restores: 0,
             grey_clicks: 0, zoom_events: 0, pans: 0, max_zoom: 1, toggles: 0, toggle_log: [], log: [] };

  $("progress-label").textContent = `Image ${idx + 1} of ${plan.length}`;
  $("progress").innerHTML = plan.map((_, i) => `<span class="${i < idx ? "done" : i === idx ? "now" : ""}"></span>`).join("");
  $("btn-next").disabled = true;
  $("btn-next").textContent = idx === plan.length - 1 ? "Finish counting" : "Next image";
  $("ai-toggle").checked = true;
  aiLayer.classList.remove("hidden");
  if (IS_AI) $("ai-count").textContent = t.model_count;
  buildScale($("conf-scale"), v => { confidence = v; $("btn-next").disabled = false; });

  img.style.visibility = "hidden";
  $("img-loading").hidden = false;
  img.width = t.w; img.height = t.h;
  svg.setAttribute("width", t.w); svg.setAttribute("height", t.h);
  svg.setAttribute("viewBox", `0 0 ${t.w} ${t.h}`);
  renderAI(t); renderMarks(); updateCount();
  fitView();

  img.onload = () => {
    img.style.visibility = "visible";
    $("img-loading").hidden = true;
    tState.loaded = true;
    tState.start = now();          // time counts from when the image is visible
  };
  img.onerror = () => { $("img-loading").textContent = "Image failed to load. Please reload the page."; };
  img.src = `img/${t.id}.jpg`;
}

$("ai-toggle").addEventListener("change", e => {
  aiLayer.classList.toggle("hidden", !e.target.checked);
  if (tState) { tState.toggles++; tState.toggle_log.push([e.target.checked ? "on" : "off", now() - tState.start]); }
});

$("btn-next").addEventListener("click", () => {
  if (confidence === null || !tState || !tState.loaded) return;
  const t = plan[idx];
  const count = currentCount();
  const rec = {
    trial_index: idx + 1, trial_id: t.id, core_id: t.core, is_catch: t.catch,
    response_count: count, confidence,
    rt_ms: now() - tState.start, first_action_ms: tState.first_action_ms,
    n_human_marks: marks.length, human_marks: marks.map(m => [m.x, m.y]),
    n_adds: tState.adds, n_removes: tState.removes, grey_clicks: tState.grey_clicks,
    zoom_events: tState.zoom_events, max_zoom: tState.max_zoom, pans: tState.pans,
    click_log: tState.log, order_guess: orderInCondition,
  };
  if (IS_AI) Object.assign(rec, {
    model_count: t.model_count, ai_shown: t.ai.length,
    ai_rejected_n: rejected.size, ai_rejected_idx: [...rejected].sort((a, b) => a - b),
    ai_kept_count: count === t.model_count,
    ai_unchanged: rejected.size === 0 && marks.length === 0,
    ai_rejects: tState.ai_rejects, ai_restores: tState.ai_restores,
    overlay_toggles: tState.toggles, overlay_toggle_log: tState.toggle_log,
    overlay_visible_at_end: $("ai-toggle").checked,
  });
  if (t.catch) {
    catchPass = Math.abs(count - t.gt) <= CATCH_TOLERANCE;
    rec.catch_gt = t.gt; rec.catch_pass = catchPass;
  }
  record("trial", rec);

  const seen = lsGet("a3_seen_" + pkey, []); seen.push(t.id); lsSet("a3_seen_" + pkey, [...new Set(seen)]);

  idx++;
  if (idx < plan.length) startTrial();
  else { tState = null; buildSurvey(); show("s-survey"); }
});

/* ---------------- questionnaire ---------------- */
// NASA-TLX (raw, 7-point) for workload; agreement items, incl. an instructed-response attention check.
const TLX = [
  ["tlx_mental", "Mental demand", "How mentally demanding was the task?", "Very low", "Very high"],
  ["tlx_physical", "Physical demand", "How physically demanding was the task (clicking, zooming)?", "Very low", "Very high"],
  ["tlx_temporal", "Time pressure", "How hurried or rushed was the pace of the task?", "Very low", "Very high"],
  ["tlx_performance", "Performance", "How successful were you in counting the ducts correctly?", "Perfect", "Failure"],
  ["tlx_effort", "Effort", "How hard did you have to work to reach your level of performance?", "Very low", "Very high"],
  ["tlx_frustration", "Frustration", "How insecure, discouraged, irritated, stressed or annoyed were you?", "Very low", "Very high"],
];
const AGREE = ["Strongly disagree", "Strongly agree"];
const ITEMS_COMMON = [["clear_instructions", "The instructions were clear."]];
const ITEMS_AI = [
  ["trust_reliable", "I could rely on the AI's outlines."],
  ["trust_checked", "I checked the AI's outlines carefully before accepting them."],
  ["ai_helpful", "The AI made the task easier."],
];
const ATTN_ITEM = ["attn_item", "To show you are reading carefully, please select 1 (Strongly disagree) for this statement."];
let surveyAnswers = {};
let surveyOrder = [];

function buildSurvey() {
  surveyAnswers = {};
  const box = $("survey-items");
  box.innerHTML = "";
  const agree = shuffle(ITEMS_COMMON.concat(IS_AI ? ITEMS_AI : []));
  agree.splice(1 + Math.floor(Math.random() * agree.length), 0, ATTN_ITEM);   // never first
  const items = TLX.map(([k, title, q, lo, hi]) => ({ k, title, q, lo, hi }))
    .concat(agree.map(([k, q]) => ({ k, q, lo: AGREE[0], hi: AGREE[1] })));
  surveyOrder = items.map(i => i.k);
  items.forEach(it => {
    const d = document.createElement("div");
    d.className = "survey-item"; d.dataset.k = it.k;
    d.innerHTML = `<p class="question" id="q-${it.k}">${it.title ? it.title + ": " : ""}${it.q}</p>
      <div class="scale" role="radiogroup" aria-labelledby="q-${it.k}"></div>
      <div class="scale-ends"><span>1 - ${it.lo}</span><span>7 - ${it.hi}</span></div>`;
    box.appendChild(d);
    buildScale(d.querySelector(".scale"), v => { surveyAnswers[it.k] = v; d.classList.remove("missing"); });
  });
}

$("btn-survey").addEventListener("click", () => {
  const missing = surveyOrder.filter(k => !(k in surveyAnswers));
  document.querySelectorAll(".survey-item").forEach(d => d.classList.toggle("missing", missing.includes(d.dataset.k)));
  $("survey-error").hidden = !missing.length;
  if (missing.length) { document.querySelector(".survey-item.missing").scrollIntoView({ behavior: "smooth", block: "center" }); return; }

  const attnPass = surveyAnswers.attn_item === 1;
  const tlx = TLX.map(t => surveyAnswers[t[0]]);
  record("questionnaire", Object.assign({}, surveyAnswers, {
    tlx_raw_mean: +(tlx.reduce((a, b) => a + b, 0) / tlx.length).toFixed(3),
    attn_pass: attnPass, comment: $("comment").value.trim(), order_guess: orderInCondition,
  }));
  // The instructions quiz has its own rule (retry once, restart after a 2nd miss). The session is
  // flagged for exclusion only if BOTH in-task checks fail: the easy catch image and the instructed item.
  const fails = (catchPass === false ? 1 : 0) + (attnPass ? 0 : 1);
  record("session", {
    event: "complete", total_ms: Date.now() - sessionStart, quiz_fails: quizFails,
    catch_pass: catchPass, attn_pass: attnPass, attention_fails: fails, flagged: fails >= 2,
    order_guess: orderInCondition,
  });
  const done = lsGet("a3_done_" + pkey, []); done.push(COND); lsSet("a3_done_" + pkey, done);
  finish();
});

/* ---------------- done ---------------- */
function finish() {
  show("s-done");
  $("done-mark").hidden = true;
  $("btn-retry").hidden = true;
  $("done-title").textContent = "Saving your answers…";
  $("done-msg").textContent = "Please keep this page open for a moment.";
  flush().then(ok => {
    if (ok || !queue.length) {
      $("done-mark").hidden = false;
      $("done-title").textContent = "Thanks, your answers are saved";
      $("done-msg").textContent = "You can close this page now.";
      const other = IS_AI ? "Version A (without AI)" : "Version B (with AI)";
      const doneList = lsGet("a3_done_" + pkey, []);
      if (!doneList.includes(IS_AI ? "withoutai" : "withai")) {
        $("done-next").innerHTML = `If you haven't yet, please also do <strong>${other}</strong> of this study.`;
        $("done-next").hidden = false;
      }
    } else {
      $("done-title").textContent = "Your answers weren't saved yet";
      $("done-msg").textContent = "The connection failed. Check your internet connection, then try again.";
      $("btn-retry").hidden = false;
    }
  });
}
$("btn-retry").addEventListener("click", finish);

// Warn before leaving mid-study
window.addEventListener("beforeunload", e => {
  if ($("s-task").classList.contains("active") || $("s-survey").classList.contains("active") || queue.length) {
    e.preventDefault(); e.returnValue = "";
  }
});
})();
