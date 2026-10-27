/**
 * ui.ts — the dashboard page: one self-contained HTML document (inline CSS
 * and JS, no build step, no external requests). It polls the JSON API every
 * 2 seconds and re-renders; all text is inserted with textContent, never as
 * HTML, so task text or agent output can't inject markup.
 */

/** localStorage key holding the user's theme choice ("light" | "dark"; absent = auto). */
export const THEME_KEY = "codec-theme";

/**
 * Runs in <head> before first paint so a saved choice never flashes the
 * wrong palette. Allowed by the page CSP (script-src 'unsafe-inline').
 */
const THEME_BOOT = `<script>try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}</script>`;

const DARK_VARS = `color-scheme: dark;
    --bg: #0f1115; --panel: #171a21; --panel2: #1f232c; --text: #e6e8ee; --muted: #8b93a7;
    --border: #2a2f3a; --accent: #6d8dff; --danger: #f06a6a;
    --working: #6d8dff; --needs: #f0a050; --review: #a78bfa; --done: #3ccf8e;`;

/** The locked page follows the OS theme (auto); it is shown before any login, so no stored choice. */
export function renderLocked(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Codec</title>
<style>:root{color-scheme:light;--bg:#f6f7f9;--text:#1b1f27;--code:#eef0f4}
@media (prefers-color-scheme: dark){:root{color-scheme:dark;--bg:#0f1115;--text:#e6e6e6;--code:#1c2029}}
body{font:15px system-ui,sans-serif;background:var(--bg);color:var(--text);display:grid;place-items:center;height:100vh;margin:0}
code{background:var(--code);padding:2px 6px;border-radius:4px}</style></head>
<body><div><h2>Codec dashboard</h2><p>Open the link printed by <code>codec dashboard</code> (it contains a secret token).</p></div></body></html>`;
}

export function renderPage(token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codec</title>
${THEME_BOOT}
<style>
:root {
  color-scheme: light;
  --bg: #f6f7f9; --panel: #ffffff; --panel2: #eef0f4; --text: #1b1f27; --muted: #667085;
  --border: #dde1e8; --accent: #3b6cf6; --danger: #d14343;
  --working: #3b6cf6; --needs: #e0802a; --review: #8b5cf6; --done: #22a06b;
}
/* Dark: chosen explicitly, or auto (no data-theme) while the OS is dark. */
:root[data-theme="dark"] {
    ${DARK_VARS}
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {
    ${DARK_VARS}
  }
}
header .theme { margin-left: auto; }
header .theme select { padding: 4px 8px; }
header .err { margin-left: 0; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; }
a { color: inherit; text-decoration: none; }
header { display: flex; align-items: center; gap: 24px; padding: 14px 24px; background: var(--panel); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 1; }
header h1 { font-size: 18px; margin: 0; letter-spacing: .5px; }
header .stat { color: var(--muted); }
header .stat b { color: var(--text); font-size: 16px; margin-right: 4px; }
header .err { margin-left: auto; color: var(--danger); }
main { padding: 20px 24px; max-width: 1400px; margin: 0 auto; }
h2 { font-size: 15px; margin: 24px 0 10px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .6px; }
.crumbs { color: var(--muted); margin-bottom: 8px; }
.crumbs a:hover { color: var(--accent); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; display: block; }
a.card:hover { border-color: var(--accent); }
.card .title { font-weight: 600; font-size: 15px; }
.card .sub { color: var(--muted); font-size: 12px; word-break: break-all; }
.counts { display: flex; gap: 10px; margin-top: 8px; flex-wrap: wrap; }
.pill { font-size: 12px; padding: 1px 8px; border-radius: 99px; background: var(--panel2); }
.pill.working { color: var(--working); } .pill.needsYou { color: var(--needs); }
.pill.inReview { color: var(--review); } .pill.done { color: var(--done); }
table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); }
th { color: var(--muted); font-weight: 500; font-size: 12px; }
tr.click { cursor: pointer; } tr.click:hover td { background: var(--panel2); }
td.task { max-width: 480px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.state { font-weight: 600; }
.state.running { color: var(--working); } .state.timed_out, .state.failed, .state.stopped { color: var(--needs); } .state.done { color: var(--done); }
.board { display: grid; grid-template-columns: repeat(4, minmax(220px, 1fr)); gap: 12px; align-items: start; }
.lane { background: var(--panel2); border-radius: 10px; padding: 10px; min-height: 120px; }
.lane h3 { margin: 2px 4px 10px; font-size: 13px; display: flex; justify-content: space-between; }
.lane.working h3 { color: var(--working); } .lane.needsYou h3 { color: var(--needs); }
.lane.inReview h3 { color: var(--review); } .lane.done h3 { color: var(--done); }
.lane .card { margin-bottom: 8px; }
.lane .task { margin: 4px 0; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.empty { color: var(--muted); font-size: 12px; padding: 4px; }
form.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 10px; }
input, select, textarea { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 7px 9px; }
input[type=text] { flex: 1; min-width: 200px; }
textarea { flex: 1; min-width: 260px; min-height: 38px; resize: vertical; }
button { font: inherit; border: 1px solid var(--border); background: var(--panel2); color: var(--text); border-radius: 6px; padding: 7px 14px; cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.danger { color: var(--danger); }
button:disabled { opacity: .5; cursor: default; }
.kv { display: grid; grid-template-columns: 120px 1fr; gap: 6px 14px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
.kv div:nth-child(odd) { color: var(--muted); }
.kv div { word-break: break-all; }
.fulltask { white-space: pre-wrap; word-break: normal; }
pre.log { background: #0b0d11; color: #d6dae3; border-radius: 10px; padding: 14px; max-height: 60vh; overflow: auto; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-all; margin: 0; }
.actions { display: flex; gap: 8px; margin: 12px 0; }
.headrow { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.muted { color: var(--muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
nav { display: flex; gap: 4px; }
nav a { padding: 5px 10px; border-radius: 6px; color: var(--muted); }
nav a:hover { color: var(--text); } nav a.on { background: var(--panel2); color: var(--text); }
a.link { color: var(--accent); } a.link:hover { text-decoration: underline; }
.summary { display: flex; gap: 12px; margin-bottom: 4px; flex-wrap: wrap; }
.card.stat { min-width: 140px; color: var(--muted); } .card.stat b { color: var(--text); font-size: 20px; margin-right: 4px; }
.stackcards { display: flex; flex-direction: column; gap: 12px; }
.card.block { padding: 14px 16px; }
.card.block .sub { margin: 2px 0 10px; }
table.inner { margin: 8px 0; }
details { margin-top: 8px; } summary { cursor: pointer; color: var(--accent); }
form.stack { display: flex; flex-direction: column; gap: 8px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 10px; margin-top: 8px; }
.row2 { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.checks { display: inline-flex; flex-wrap: wrap; gap: 4px 14px; }
label.check { cursor: pointer; white-space: nowrap; }
button.small { padding: 3px 10px; font-size: 12px; }
.actions.tight { margin: 0; }
.kv.compact { grid-template-columns: 100px 1fr; padding: 10px; margin-top: 6px; }
.pill.guess { color: var(--needs); }
table.grid2 th.c, table.grid2 td.c { text-align: center; }
.dot.own { color: var(--done); } .dot.via { color: var(--review); }
.row.top { margin-top: 8px; }
@media (max-width: 900px) { .board { grid-template-columns: 1fr 1fr; } }
</style>
</head>
<body>
<header>
  <h1><a href="#/">Codec</a></h1>
  <nav>
    <a href="#/" data-page="projects">Projects</a>
    <a href="#/teams" data-page="teams">Teams</a>
    <a href="#/specialists" data-page="specialists">Specialists</a>
    <a href="#/skills" data-page="skills">Skills</a>
  </nav>
  <span class="stat"><b id="teamsN">–</b>teams</span>
  <span class="stat"><b id="running">–</b>agents running</span>
  <span class="stat"><b id="memory">–</b>memory in use</span>
  <label class="theme muted">Theme
    <select id="theme" aria-label="Theme">
      <option value="auto">Auto</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  </label>
  <span class="err" id="err"></span>
</header>
<main id="app"></main>
<script>
"use strict";
const TOKEN = ${JSON.stringify(token)};
const LANES = [
  ["working", "Working"], ["needsYou", "Needs you"], ["inReview", "In review"], ["done", "Done"],
];
const app = document.getElementById("app");
let timer = null;

// Theme switch: Auto (follow the OS) / Light / Dark, remembered per browser.
(function themeSwitch() {
  const KEY = ${JSON.stringify(THEME_KEY)};
  const sel = document.getElementById("theme");
  const root = document.documentElement;
  const cur = root.getAttribute("data-theme");
  sel.value = cur === "light" || cur === "dark" ? cur : "auto";
  sel.addEventListener("change", () => {
    const v = sel.value;
    if (v === "light" || v === "dark") root.setAttribute("data-theme", v);
    else root.removeAttribute("data-theme");
    try {
      if (v === "light" || v === "dark") localStorage.setItem(KEY, v);
      else localStorage.removeItem(KEY);
    } catch (e) { /* storage blocked: the choice still applies to this tab */ }
  });
})();
let renderSeq = 0;

// ---------- tiny DOM helper: h("div.card", {onclick}, children...) ----------
function h(spec, props, ...kids) {
  const [tag, ...classes] = spec.split(".");
  const el = document.createElement(tag || "div");
  if (classes.length) el.className = classes.join(" ");
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// ---------- API ----------
async function api(path, body) {
  const opts = { headers: { "X-Codec-Token": TOKEN } };
  if (body !== undefined) {
    opts.method = "POST";
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch("/api/" + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const enc = encodeURIComponent;

function showError(msg) { document.getElementById("err").textContent = msg || ""; }

// ---------- formatting ----------
function when(iso) {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString() : d.toLocaleString();
}
function mem(bytes) {
  if (bytes === null || bytes === undefined) return "n/a";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  if (bytes < 1024 ** 3) return (bytes / 1024 / 1024).toFixed(0) + " MB";
  return (bytes / 1024 ** 3).toFixed(2) + " GB";
}
function snippet(t, n = 90) { t = t.replace(/\\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; }
function limitText(minutes) {
  if (minutes === undefined) return "No time limit";
  const seconds = Number((minutes * 60).toPrecision(8));
  const value = seconds < 60 ? seconds : Number(minutes.toPrecision(8));
  const unit = seconds < 60 ? "second" : "minute";
  return value + " " + unit + (value === 1 ? "" : "s");
}
function limitInput(id, value, placeholder) {
  return h("label", {}, "Time limit (minutes) ", h("input", {
    type: "number", id, min: "0", max: "1440", step: "any",
    value, placeholder: placeholder || "60 by default",
  }));
}
function limitValue(form, id) {
  const value = form.querySelector("#" + CSS.escape(id)).value;
  return value === "" ? undefined : Number(value);
}
function stateText(r) { if (r.state === "timed_out") return r.stateText; return r.state === "failed" && r.exitCode !== undefined ? "failed (exit " + r.exitCode + ")" : r.state; }

// ---------- form state: survives the 2-second re-render ----------
// Every input with an id keeps its value, checked state, focus and caret
// across re-renders of the same page. Changing page starts fresh.
let lastRoute = "";
function snapshot() {
  const vals = {};
  for (const el of app.querySelectorAll("input[id], select[id], textarea[id]")) {
    if (el.type === "file") continue;
    vals[el.id] = el.type === "checkbox" ? el.checked : el.value;
  }
  const a = document.activeElement;
  const focus = a && a.id && app.contains(a) ? { id: a.id, s: a.selectionStart, e: a.selectionEnd } : null;
  return { vals, focus };
}
function restore(snap) {
  for (const [id, v] of Object.entries(snap.vals)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = v;
    else if (el.tagName === "SELECT") { if ([...el.options].some((o) => o.value === v)) el.value = v; }
    else el.value = v;
  }
  if (snap.focus) {
    const el = document.getElementById(snap.focus.id);
    if (el) { el.focus(); try { if (snap.focus.s !== null) el.setSelectionRange(snap.focus.s, snap.focus.e); } catch (e) {} }
  }
}
function render(...kids) {
  const route = location.hash;
  const snap = route === lastRoute ? snapshot() : { vals: {}, focus: null };
  const scroll = window.scrollY;
  app.replaceChildren(...kids);
  restore(snap);
  if (route === lastRoute) window.scrollTo(0, scroll);
  lastRoute = route;
}
// Clear a form's fields after a successful submit (so the snapshot is empty too).
function clearForm(form) { form.reset(); for (const el of form.querySelectorAll("input, textarea")) if (el.type !== "checkbox") el.value = ""; }

async function act(fn, btn) {
  if (btn) btn.disabled = true;
  try { await fn(); showError(""); return true; }
  catch (err) { showError(err.message); return false; }
  finally { if (btn) btn.disabled = false; refresh(); }
}

function checks(prefix, names, selected) {
  if (!names.length) return h("span.muted", { text: "none available" });
  return h("span.checks", {}, names.map((n) => h("label.check", {},
    h("input", { type: "checkbox", id: prefix + n, value: n, checked: selected && selected.includes(n) }), " " + n)));
}
function checked(form, prefix) {
  return [...form.querySelectorAll("input[type=checkbox]")].filter((c) => c.id.startsWith(prefix) && c.checked).map((c) => c.value);
}
function whoText(r) { return r.team ? r.team + "/" + r.member : "unassigned worker"; }
function memberHref(team, member) { return "#/member/" + enc(team) + "/" + enc(member); }
function sourceText(s) {
  if (s.source === "project") return "from the project" + (s.project ? " (" + s.project + ")" : "");
  if (s.source === "specialist") return "from the specialist";
  return "its own";
}
function crumbs(...items) {
  const out = [h("a", { href: "#/", text: "Projects" })];
  for (const it of items) { out.push(" / "); out.push(typeof it === "string" ? it : it); }
  return h("div.crumbs", {}, out);
}

// ---------- screens ----------
async function home(seq) {
  const s = await api("state");
  if (seq !== renderSeq) return;
  const addForm = h("form.row", { onsubmit: async (e) => {
      e.preventDefault();
      const path = e.target.elements.path.value.trim();
      if (!path) return;
      if (await act(() => api("projects", { path }))) clearForm(e.target);
    } },
    h("input", { type: "text", name: "path", id: "addpath", placeholder: "/path/to/a/git/repository" }),
    h("button.primary", { type: "submit", text: "Add project" }));
  const cards = s.projects.map((p) => h("a.card", { href: "#/project/" + enc(p.name) },
    h("div.title", { text: p.name }),
    h("div.sub", { text: p.path }),
    h("div.counts", ...LANES.map(([k, label]) => h("span.pill." + k, { text: label + " " + p.lanes[k] })))));
  const rows = s.runs.map((r) => h("tr.click", { onclick: () => go("#/run/" + r.runId) },
    h("td", { text: r.project }), h("td", { text: whoText(r) }), h("td", { text: r.agent }),
    h("td", {}, h("span.state." + r.state, { text: stateText(r) })),
    h("td", { text: when(r.startedAt) }), h("td.task", { text: snippet(r.task), title: r.task }),
    h("td.mono", { text: r.runId })));
  render(
    h("div.summary", {},
      h("a.card.stat", { href: "#/teams" }, h("b", { text: String(s.teamsCount) }), s.teamsCount === 1 ? " team" : " teams"),
      h("div.card.stat", {}, h("b", { text: String(s.projects.length) }), s.projects.length === 1 ? " project" : " projects"),
      h("div.card.stat", {}, h("b", { text: String(s.agentsRunning) }), " agents running")),
    h("h2", { text: "Projects" }),
    s.projects.length ? h("div.grid", {}, cards) : h("p.muted", { text: "No projects yet — add a git repository below." }),
    h("h2", { text: "Add a project" }), addForm,
    h("h2", { text: "All runs" }),
    s.runs.length
      ? h("table", {}, h("tr", {}, ["Project", "Who", "Tool", "State", "Started", "Task", "Run"].map((t) => h("th", { text: t }))), rows)
      : h("p.muted", { text: "No runs yet." }));
}

async function project(seq, name) {
  const v = await api("projects/" + enc(name));
  if (seq !== renderSeq) return;
  const lanes = LANES.map(([k, label]) => h("div.lane." + k, {},
    h("h3", {}, h("span", { text: label }), h("span", { text: String(v.lanes[k].length) })),
    v.lanes[k].length ? v.lanes[k].map((r) => h("a.card", { href: "#/run/" + r.runId },
      h("div", {}, h("b", { text: whoText(r) }), " ", h("span.muted", { text: "(" + r.agent + ")" }), " ",
        h("span.state." + r.state, { text: "· " + stateText(r) })),
      r.team ? h("div.sub", { text: "team " + r.team + (r.specialist ? " · " + r.specialist : "") }) : null,
      h("div.task", { text: snippet(r.task, 200) }),
      h("div.sub", { text: when(r.startedAt) + " · " + r.runId }))) : h("div.empty", { text: "nothing here" })));
  const whoSel = h("select", { id: "p-who" },
    v.members.length
      ? h("optgroup", { label: "Team members" }, v.members.map((m) => h("option", { value: "m:" + m.ref, text: m.label + " (" + m.tool + ")" })))
      : null,
    h("optgroup", { label: "Unassigned worker" },
      h("option", { value: "a:claude", text: "unassigned worker — claude" }),
      h("option", { value: "a:codex", text: "unassigned worker — codex" })));
  const task = h("textarea", { id: "p-task", placeholder: "What should the agent do?" });
  const form = h("form.row", { onsubmit: async (e) => {
      e.preventDefault();
      const t = task.value;
      if (!t.trim()) return;
      const who = whoSel.value;
      const body = who.startsWith("m:") ? { member: who.slice(2), task: t } : { agent: who.slice(2), task: t };
      body.timeLimitMinutes = limitValue(e.target, "p-time-limit");
      const btn = e.target.querySelector("button"); btn.disabled = true;
      try {
        const r = await api("projects/" + enc(name) + "/runs", body);
        clearForm(e.target); showError(""); go("#/run/" + r.runId);
      } catch (err) { showError(err.message); btn.disabled = false; }
    } }, whoSel, task, limitInput("p-time-limit", undefined, "Use member or specialist limit, else 60"), h("button.primary", { type: "submit", text: "Start agent" }));
  const remove = h("button.danger", { text: "Remove project", onclick: async () => {
      if (!confirm("Remove " + name + " from Codec? The repository itself is not touched.")) return;
      try { await api("projects/" + enc(name) + "/remove", {}); showError(""); go("#/"); }
      catch (err) { showError(err.message); }
    } });
  render(
    crumbs(name),
    h("div.headrow", {}, h("div", {}, h("div.title", {}, h("b", { text: name })), h("div.sub.muted", { text: v.project.path })), remove),
    h("h2", { text: "Start an agent" }),
    v.members.length ? null : h("p.muted", {}, "No team works on this project yet — ", h("a.link", { href: "#/teams", text: "assign a team" }), ", or start an unassigned worker."),
    form,
    h("h2", { text: "Board" }), h("div.board", {}, lanes));
}

async function run(seq, id) {
  const r = await api("runs/" + enc(id));
  if (seq !== renderSeq) return;
  const old = app.querySelector("pre.log");
  const stick = !old || old.scrollTop + old.clientHeight >= old.scrollHeight - 20;
  const actions = h("div.actions");
  if (r.state === "running") {
    actions.append(h("button.danger", { text: "Stop", onclick: async (e) => {
        e.target.disabled = true;
        try { await api("runs/" + r.runId + "/stop", {}); showError(""); } catch (err) { showError(err.message); }
        refresh();
      } }));
  } else if (!r.cleanedAt) {
    actions.append(h("button", { text: "Clean", onclick: async () => {
        if (!confirm("Remove the worktree for " + r.runId + "? The branch " + r.branch + " and its commits are kept.")) return;
        try { await api("runs/" + r.runId + "/clean", {}); showError(""); }
        catch (err) {
          if (/uncommitted/.test(err.message) && confirm("The worktree has uncommitted changes. Discard them and clean anyway?")) {
            try { await api("runs/" + r.runId + "/clean", { force: true }); showError(""); } catch (e2) { showError(e2.message); }
          } else showError(err.message);
        }
        refresh();
      } }));
  }
  const given = r.skillsGiven || [];
  const used = r.skillsUsed || [];
  const givenTable = given.length
    ? h("table", {}, h("tr", {}, ["Skill", "Source", "Description"].map((t) => h("th", { text: t }))),
        given.map((s) => h("tr", {}, h("td", { text: s.name }), h("td", { text: sourceText(s) + (s.note ? " — " + s.note : "") }),
          h("td.task", { text: s.description || "", title: s.description || "" }))))
    : h("p.muted", { text: "No skills were given to this run." });
  const usedBox = used.length
    ? h("table", {}, h("tr", {}, ["Skill", "How we know", "Evidence"].map((t) => h("th", { text: t }))),
        used.map((u) => h("tr", {}, h("td", { text: u.name }),
          h("td", {}, u.how === "guess" ? h("span.pill.guess", { text: "guess" }) : h("span.pill.done", { text: "detected" })),
          h("td.task", { text: u.evidence || "", title: u.evidence || "" }))))
    : h("p.muted", { text: r.agent === "codex"
        ? "None spotted. Codex doesn't report skill use, so this is a best-effort guess from its output."
        : (r.state === "running" ? "None yet." : "The agent didn't call any skill.") });
  const log = h("pre.log", { text: r.log || "(no output yet)" });
  render(
    crumbs(h("a", { href: "#/project/" + enc(r.project), text: r.project }), r.runId),
    h("div.kv", {},
      h("div", { text: "Task" }), h("div.fulltask", { text: r.task }),
      h("div", { text: "State" }), h("div", {}, h("span.state." + r.state, { text: stateText(r) })),
      h("div", { text: "Who" }), h("div", {}, r.team ? h("a.link", { href: memberHref(r.team, r.member), text: r.team + "/" + r.member }) : "unassigned worker"),
      r.team ? h("div", { text: "Team" }) : null, r.team ? h("div", { text: r.team }) : null,
      r.specialist ? h("div", { text: "Specialist" }) : null,
      r.specialist ? h("div", { text: r.specialist + (r.specialty ? " — " + r.specialty : "") }) : null,
      h("div", { text: "Tool" }), h("div", { text: r.agent + (r.model ? " (model " + r.model + ")" : "") }),
      h("div", { text: "Time limit" }), h("div", { text: limitText(r.timeLimitMinutes) }),
      r.deadline ? h("div", { text: "Due by" }) : null, r.deadline ? h("div", { text: when(r.deadline) }) : null,
      h("div", { text: "Started" }), h("div", { text: when(r.startedAt) }),
      h("div", { text: "Branch" }), h("div.mono", { text: r.branch }),
      h("div", { text: "Worktree" }), h("div.mono", { text: r.cleanedAt ? r.worktree + "  (cleaned)" : r.worktree })),
    actions,
    h("h2", { text: "Skills given" }), givenTable,
    h("h2", { text: "Skills used" }), usedBox,
    h("h2", { text: "Output (last 200 lines)" }), log);
  log.scrollTop = stick ? log.scrollHeight : old.scrollTop;
}

async function teams(seq) {
  const [ts, st, specs, sk] = await Promise.all([api("teams"), api("state"), api("specialists"), api("skills")]);
  if (seq !== renderSeq) return;
  const projectNames = st.projects.map((p) => p.name);
  const skillNames = sk.skills.map((s) => s.name);
  const create = h("form.stack", { onsubmit: async (e) => {
      e.preventDefault();
      const name = e.target.querySelector("#t-new-name").value.trim();
      const projects = checked(e.target, "t-new-p-");
      if (await act(() => api("teams", { name, projects }), e.target.querySelector("button"))) clearForm(e.target);
    } },
    h("div.row2", {}, h("input", { type: "text", id: "t-new-name", placeholder: "team name, e.g. alpha" }),
      h("button.primary", { type: "submit", text: "Create team" })),
    h("div", {}, h("span.muted", { text: "Works on: " }), checks("t-new-p-", projectNames)));
  const cards = ts.map((t) => {
    const key = "t-" + t.name + "-";
    const memberRows = t.members.map((m) => h("tr", {},
      h("td", {}, h("a.link", { href: memberHref(t.name, m.member), text: m.member })),
      h("td", { text: m.error ? "broken: " + m.error : (m.kind === "clone" ? "copy of " + m.specialist + (m.specialty ? " (" + m.specialty + ")" : "") : "plain worker") }),
      h("td", { text: m.tool || "" }),
      h("td", { text: (m.skills || []).filter((s) => s.source !== "project").map((s) => s.name).join(", ") || "–" }),
      h("td", {}, (m.working || []).length ? m.working.map((r) => h("a.link", { href: "#/run/" + r.runId, text: r.project + " · " + r.runId + " " })) : h("span.muted", { text: "idle" })),
      h("td", {}, h("button.danger.small", { text: "Remove", onclick: async (e) => {
          if (!confirm("Remove " + t.name + "/" + m.member + " from the team?")) return;
          await act(() => api("teams/" + enc(t.name) + "/members/" + enc(m.member) + "/remove", {}), e.target);
        } }))));
    const whoOpts = h("select", { id: key + "kind" },
      specs.length ? h("optgroup", { label: "Copy of a specialist" }, specs.map((s) => h("option", { value: "s:" + s.name, text: s.name + " (" + s.specialty + ", " + s.tool + ")" }))) : null,
      h("optgroup", { label: "Plain worker" }, h("option", { value: "t:claude", text: "claude worker" }), h("option", { value: "t:codex", text: "codex worker" })));
    const addMember = h("form.stack", { onsubmit: async (e) => {
        e.preventDefault();
        const kind = whoOpts.value;
        const body = { timeLimitMinutes: limitValue(e.target, key + "limit"), name: e.target.querySelector("#" + CSS.escape(key + "mname")).value.trim() || undefined, skills: checked(e.target, key + "ms-") };
        if (kind.startsWith("s:")) body.specialist = kind.slice(2); else body.tool = kind.slice(2);
        if (await act(() => api("teams/" + enc(t.name) + "/members", body), e.target.querySelector("button"))) clearForm(e.target);
      } },
      h("div.row2", {}, whoOpts,
        h("input", { type: "text", id: key + "mname", placeholder: "name (optional, e.g. tester-2)" }),
        h("button.primary", { type: "submit", text: "Add member" })),
      limitInput(key + "limit", undefined, "Use specialist limit, else 60"),
      h("div", {}, h("span.muted", { text: "Extra skills: " }), checks(key + "ms-", skillNames)));
    const editProjects = h("form.stack", { onsubmit: async (e) => {
        e.preventDefault();
        await act(() => api("teams/" + enc(t.name) + "/projects", { projects: checked(e.target, key + "p-") }), e.target.querySelector("button"));
      } },
      h("div", {}, h("span.muted", { text: "Works on: " }), checks(key + "p-", projectNames, t.projects), " ",
        h("button.small", { type: "submit", text: "Save projects" })));
    return h("div.card.block", {},
      h("div.headrow", {}, h("div.title", { text: t.name }),
        h("button.danger.small", { text: "Remove team", onclick: async (e) => {
            if (!confirm("Remove team " + t.name + " and its " + t.members.length + " member(s)?")) return;
            await act(() => api("teams/" + enc(t.name) + "/remove", {}), e.target);
          } })),
      h("div.sub", {}, "Projects: ", t.projects.length ? t.projects.map((p, i) => [i ? ", " : "", h("a.link", { href: "#/project/" + enc(p), text: p })]) : "none"),
      t.members.length
        ? h("table.inner", {}, h("tr", {}, ["Member", "Kind", "Tool", "Skills", "Working on", ""].map((x) => h("th", { text: x }))), memberRows)
        : h("p.muted", { text: "No members yet." }),
      h("details", {}, h("summary", { text: "Add a member" }), addMember),
      h("details", {}, h("summary", { text: "Change projects" }), editProjects));
  });
  render(
    crumbs("Teams"),
    h("h2", { text: "Teams" }),
    ts.length ? h("div.stackcards", {}, cards) : h("p.muted", { text: "No teams yet." }),
    h("h2", { text: "Create a team" }),
    projectNames.length ? create : h("p.muted", { text: "Add a project first — a team needs at least one project." }));
}

let editingSpec = null;
function specForm(key, s, skillNames, onSubmit) {
  return h("form.stack", { onsubmit: onSubmit },
    h("div.row2", {},
      s ? null : h("input", { type: "text", id: key + "name", placeholder: "name, e.g. tester" }),
      h("input", { type: "text", id: key + "specialty", placeholder: "specialty, e.g. QA tester", value: s ? s.specialty : undefined }),
      h("select", { id: key + "tool" }, ["claude", "codex"].map((t) => h("option", { value: t, text: t, selected: s && s.tool === t }))),
      h("input", { type: "text", id: key + "model", placeholder: "model (optional)", value: s && s.model ? s.model : undefined })),
    limitInput(key + "limit", s ? s.timeLimitMinutes : undefined),
    h("textarea", { id: key + "instr", placeholder: "Standing instructions (optional)" }, s ? s.instructions : null),
    h("div", {}, h("span.muted", { text: "Skills: " }), checks(key + "sk-", skillNames, s ? s.skills : [])),
    h("div", {}, h("button.primary", { type: "submit", text: s ? "Save" : "Create specialist" })));
}
function specValues(form, key) {
  const q = (id) => form.querySelector("#" + CSS.escape(key + id));
  return {
    timeLimitMinutes: limitValue(form, key + "limit"),
    specialty: q("specialty").value.trim(), tool: q("tool").value, model: q("model").value.trim(),
    instructions: q("instr").value, skills: checked(form, key + "sk-"),
  };
}

async function specialists(seq) {
  const [specs, sk] = await Promise.all([api("specialists"), api("skills")]);
  if (seq !== renderSeq) return;
  const skillNames = sk.skills.map((s) => s.name);
  const cards = specs.map((s) => {
    const key = "s-" + s.name + "-";
    const editing = editingSpec === s.name;
    return h("div.card.block", {},
      h("div.headrow", {},
        h("div", {}, h("div.title", { text: s.name }), h("div.sub", { text: s.specialty + " · " + s.tool + (s.model ? " · model " + s.model : "") })),
        h("div.actions.tight", {},
          h("button.small", { text: editing ? "Cancel" : "Edit", onclick: () => { editingSpec = editing ? null : s.name; refresh(); } }),
          h("button.danger.small", { text: "Delete", onclick: async (e) => {
              if (!confirm("Delete specialist " + s.name + "?")) return;
              await act(() => api("specialists/" + enc(s.name) + "/remove", {}), e.target);
            } }))),
      editing
        ? specForm(key, s, skillNames, async (e) => {
            e.preventDefault();
            if (await act(() => api("specialists/" + enc(s.name) + "/edit", specValues(e.target, key)), e.target.querySelector("button[type=submit]"))) editingSpec = null;
          })
        : h("div", {},
            h("div.kv.compact", {},
              h("div", { text: "Time limit" }), h("div", { text: limitText(s.timeLimitMinutes === undefined ? 60 : s.timeLimitMinutes) }),
              h("div", { text: "Skills" }), h("div", { text: s.skills.join(", ") || "none" }),
              h("div", { text: "Instructions" }), h("div.fulltask", { text: s.instructions || "none" }),
              h("div", { text: "Clones" }),
              h("div", {}, s.clones.length ? s.clones.map((c, i) => [i ? ", " : "", h("a.link", { href: memberHref(c.team, c.member), text: c.team + "/" + c.member })]) : "none yet"))));
  });
  const nk = "s-new-";
  render(
    crumbs("Specialists"),
    h("h2", { text: "Specialists" }),
    specs.length ? h("div.stackcards", {}, cards) : h("p.muted", { text: "No specialists yet." }),
    h("h2", { text: "Create a specialist" }),
    specForm(nk, null, skillNames, async (e) => {
      e.preventDefault();
      const body = { name: e.target.querySelector("#" + nk + "name").value.trim(), ...specValues(e.target, nk) };
      if (await act(() => api("specialists", body), e.target.querySelector("button[type=submit]"))) clearForm(e.target);
    }));
}

function readB64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).replace(/^data:[^,]*,/, ""));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}

async function skills(seq) {
  const v = await api("skills");
  if (seq !== renderSeq) return;
  const rows = v.skills.map((s) => {
    const holders = [...s.specialists.map((x) => "specialist " + x), ...s.members.map((x) => x)];
    return h("tr", {},
      h("td", {}, h("b", { text: s.name })),
      h("td.task", { text: s.description, title: s.description }),
      h("td", { text: holders.join(", ") || "nobody" }),
      h("td", { text: String(s.files.length) }),
      h("td", {}, h("button.danger.small", { text: "Remove", onclick: async (e) => {
          const msg = "Remove skill " + s.name + " from the library?" +
            (holders.length ? "\\n\\nIt will be taken away from: " + holders.join(", ") : "");
          if (!confirm(msg)) return;
          await act(() => api("skills/" + enc(s.name) + "/remove", {}), e.target);
        } })));
  });
  const byPath = h("form.row", { onsubmit: async (e) => {
      e.preventDefault();
      const path = e.target.querySelector("#k-path").value.trim();
      if (!path) return;
      if (await act(() => api("skills", { path }), e.target.querySelector("button"))) clearForm(e.target);
    } },
    h("input", { type: "text", id: "k-path", placeholder: "/path/to/a/skill-folder (contains SKILL.md)" }),
    h("button.primary", { type: "submit", text: "Import folder" }));
  const upload = h("input", { type: "file", id: "k-upload", webkitdirectory: true, multiple: true, onchange: async (e) => {
      const list = [...e.target.files];
      if (!list.length) return;
      await act(async () => {
        const files = [];
        for (const f of list) files.push({ path: f.webkitRelativePath || f.name, content: await readB64(f) });
        await api("skills", { files });
      });
      e.target.value = "";
    } });
  const grid = v.grid.rows.length && v.grid.skills.length
    ? h("table.grid2", {},
        h("tr", {}, h("th", { text: "Agent" }), h("th", { text: "Tool" }), v.grid.skills.map((n) => h("th.c", { text: n }))),
        v.grid.rows.map((r) => h("tr", {},
          h("td", {}, r.kind === "member"
            ? h("a.link", { href: memberHref(r.id.split("/")[0], r.id.split("/").slice(1).join("/")), text: r.label })
            : h("span", { text: r.label })),
          h("td", { text: r.tool }),
          v.grid.skills.map((n) => h("td.c", { title: r.skills[n] || "" },
            r.skills[n] ? h("span", { class: r.skills[n] === "own" ? "dot own" : "dot via", text: r.skills[n] === "own" ? "●" : "○" }) : "")))))
    : h("p.muted", { text: "Nothing to show yet — create specialists or team members and give them skills." });
  render(
    crumbs("Skills"),
    h("h2", { text: "Library" }),
    v.skills.length
      ? h("table", {}, h("tr", {}, ["Skill", "Description", "Who has it", "Files", ""].map((t) => h("th", { text: t }))), rows)
      : h("p.muted", { text: "No skills yet." }),
    h("h2", { text: "Import a skill" }),
    byPath,
    h("div.row.top", {}, h("span.muted", { text: "…or upload a skill folder from this computer: " }), upload),
    h("h2", { text: "Who has which skill" }),
    h("p.muted", { text: "● the agent's own skill   ○ comes from its specialist" }),
    grid);
}

async function member(seq, team, name) {
  const m = await api("members/" + enc(team) + "/" + enc(name));
  if (seq !== renderSeq) return;
  const runRow = (r) => h("tr.click", { onclick: () => go("#/run/" + r.runId) },
    h("td", { text: r.project }), h("td", {}, h("span.state." + r.state, { text: stateText(r) })),
    h("td", { text: when(r.startedAt) }), h("td.task", { text: snippet(r.task), title: r.task }), h("td.mono", { text: r.runId }));
  const runTable = (list, empty) => list.length
    ? h("table", {}, h("tr", {}, ["Project", "State", "Started", "Task", "Run"].map((t) => h("th", { text: t }))), list.map(runRow))
    : h("p.muted", { text: empty });
  const past = m.runs.filter((r) => r.state !== "running");
  render(
    crumbs(h("a", { href: "#/teams", text: "Teams" }), team, name),
    h("div.kv", {},
      h("div", { text: "Member" }), h("div", {}, h("b", { text: team + "/" + name })),
      h("div", { text: "Kind" }), h("div", { text: m.kind === "clone" ? "copy of the " + m.specialist + " specialist (" + m.specialty + ")" : "plain worker" }),
      h("div", { text: "Tool" }), h("div", { text: m.tool + (m.model ? " (model " + m.model + ")" : "") }),
      h("div", { text: "Time limit" }), h("div", { text: limitText(m.timeLimitMinutes === undefined ? 60 : m.timeLimitMinutes) }),
      h("div", { text: "Projects" }), h("div", {}, m.projects.map((p, i) => [i ? ", " : "", h("a.link", { href: "#/project/" + enc(p), text: p })])),
      h("div", { text: "Instructions" }), h("div.fulltask", { text: m.instructions || "none" })),
    h("form.row", { onsubmit: async (e) => {
        e.preventDefault();
        await act(() => api("teams/" + enc(team) + "/members/" + enc(name) + "/edit", {
          timeLimitMinutes: limitValue(e.target, "m-time-limit"),
        }), e.target.querySelector("button"));
      } }, limitInput("m-time-limit", m.timeLimitMinutes, "Use specialist limit, else 60"),
      h("button.primary", { type: "submit", text: "Save time limit" })),
    h("h2", { text: "Skills" }),
    m.skills.length
      ? h("table", {}, h("tr", {}, ["Skill", "Source"].map((t) => h("th", { text: t }))),
          m.skills.map((s) => h("tr", {}, h("td", { text: s.name }), h("td", { text: sourceText(s) }))))
      : h("p.muted", { text: "No skills." }),
    h("h2", { text: "Working on now" }), runTable(m.working, "Nothing right now."),
    h("h2", { text: "Past tasks" }), runTable(past, "No finished tasks yet."));
}

// ---------- routing + polling ----------
function go(hash) { if (location.hash === hash) refresh(); else location.hash = hash; }
function markNav(page) {
  for (const a of document.querySelectorAll("nav a")) a.classList.toggle("on", a.dataset.page === page);
}
async function refresh() {
  clearTimeout(timer);
  const seq = ++renderSeq;
  const parts = location.hash.replace(/^#\\/?/, "").split("/").map(decodeURIComponent);
  try {
    let page = "projects";
    if (parts[0] === "project" && parts[1]) await project(seq, parts[1]);
    else if (parts[0] === "run" && parts[1]) await run(seq, parts[1]);
    else if (parts[0] === "teams") { page = "teams"; await teams(seq); }
    else if (parts[0] === "specialists") { page = "specialists"; await specialists(seq); }
    else if (parts[0] === "skills") { page = "skills"; await skills(seq); }
    else if (parts[0] === "member" && parts[1] && parts[2]) { page = "teams"; await member(seq, parts[1], parts[2]); }
    else await home(seq);
    markNav(page);
    const s = await api("state");
    document.getElementById("running").textContent = s.agentsRunning;
    document.getElementById("teamsN").textContent = s.teamsCount;
    document.getElementById("memory").textContent = mem(s.memoryBytes);
    if (document.getElementById("err").dataset.conn) { showError(""); delete document.getElementById("err").dataset.conn; }
  } catch (err) {
    showError(err.message);
    if (err instanceof TypeError) document.getElementById("err").dataset.conn = "1";
  }
  if (seq === renderSeq) timer = setTimeout(refresh, 2000);
}
window.addEventListener("hashchange", () => { showError(""); refresh(); });
refresh();
</script>
</body>
</html>`;
}
