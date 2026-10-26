/**
 * ui.ts — the dashboard page: one self-contained HTML document (inline CSS
 * and JS, no build step, no external requests). It polls the JSON API every
 * 2 seconds and re-renders; all text is inserted with textContent, never as
 * HTML, so task text or agent output can't inject markup.
 */

export function renderLocked(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Codec</title>
<style>body{font:15px system-ui,sans-serif;background:#0f1115;color:#e6e6e6;display:grid;place-items:center;height:100vh;margin:0}
code{background:#1c2029;padding:2px 6px;border-radius:4px}</style></head>
<body><div><h2>Codec dashboard</h2><p>Open the link printed by <code>codec dashboard</code> (it contains a secret token).</p></div></body></html>`;
}

export function renderPage(token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codec</title>
<style>
:root {
  --bg: #f6f7f9; --panel: #ffffff; --panel2: #eef0f4; --text: #1b1f27; --muted: #667085;
  --border: #dde1e8; --accent: #3b6cf6; --danger: #d14343;
  --working: #3b6cf6; --needs: #e0802a; --review: #8b5cf6; --done: #22a06b;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115; --panel: #171a21; --panel2: #1f232c; --text: #e6e8ee; --muted: #8b93a7;
    --border: #2a2f3a; --accent: #6d8dff; --danger: #f06a6a;
    --working: #6d8dff; --needs: #f0a050; --review: #a78bfa; --done: #3ccf8e;
  }
}
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
.state.running { color: var(--working); } .state.failed, .state.stopped { color: var(--needs); } .state.done { color: var(--done); }
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
@media (max-width: 900px) { .board { grid-template-columns: 1fr 1fr; } }
</style>
</head>
<body>
<header>
  <h1><a href="#/">Codec</a></h1>
  <span class="stat"><b id="running">–</b>agents running</span>
  <span class="stat"><b id="memory">–</b>memory in use</span>
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
function stateText(r) { return r.state === "failed" && r.exitCode !== undefined ? "failed (exit " + r.exitCode + ")" : r.state; }

// ---------- screens ----------
async function home(seq) {
  const s = await api("state");
  if (seq !== renderSeq) return;
  const keep = document.activeElement && document.activeElement.id === "addpath" ? document.activeElement.value : null;
  const addForm = h("form.row", { onsubmit: async (e) => {
      e.preventDefault();
      const path = e.target.elements.path.value.trim();
      if (!path) return;
      try { await api("projects", { path }); e.target.reset(); showError(""); refresh(); }
      catch (err) { showError(err.message); }
    } },
    h("input", { type: "text", name: "path", id: "addpath", placeholder: "/path/to/a/git/repository" }),
    h("button.primary", { type: "submit", text: "Add project" }));
  const cards = s.projects.map((p) => h("a.card", { href: "#/project/" + enc(p.name) },
    h("div.title", { text: p.name }),
    h("div.sub", { text: p.path }),
    h("div.counts", ...LANES.map(([k, label]) => h("span.pill." + k, { text: label + " " + p.lanes[k] })))));
  const rows = s.runs.map((r) => h("tr.click", { onclick: () => go("#/run/" + r.runId) },
    h("td", { text: r.project }), h("td", { text: r.agent }),
    h("td", {}, h("span.state." + r.state, { text: stateText(r) })),
    h("td", { text: when(r.startedAt) }), h("td.task", { text: snippet(r.task), title: r.task }),
    h("td.mono", { text: r.runId })));
  app.replaceChildren(
    h("h2", { text: "Projects" }),
    s.projects.length ? h("div.grid", {}, cards) : h("p.muted", { text: "No projects yet — add a git repository below." }),
    h("h2", { text: "Add a project" }), addForm,
    h("h2", { text: "All runs" }),
    s.runs.length
      ? h("table", {}, h("tr", {}, ["Project", "Agent", "State", "Started", "Task", "Run"].map((t) => h("th", { text: t }))), rows)
      : h("p.muted", { text: "No runs yet." }));
  if (keep !== null) { const i = document.getElementById("addpath"); i.value = keep; i.focus(); }
}

let draft = { agent: "claude", task: "" };
async function project(seq, name) {
  const v = await api("projects/" + enc(name));
  if (seq !== renderSeq) return;
  const focused = document.activeElement && document.activeElement.id === "task";
  const lanes = LANES.map(([k, label]) => h("div.lane." + k, {},
    h("h3", {}, h("span", { text: label }), h("span", { text: String(v.lanes[k].length) })),
    v.lanes[k].length ? v.lanes[k].map((r) => h("a.card", { href: "#/run/" + r.runId },
      h("div", {}, h("b", { text: r.agent }), " ", h("span.state." + r.state, { text: "· " + stateText(r) })),
      h("div.task", { text: snippet(r.task, 200) }),
      h("div.sub", { text: when(r.startedAt) + " · " + r.runId }))) : h("div.empty", { text: "nothing here" })));
  const agentSel = h("select", { id: "agent", onchange: (e) => (draft.agent = e.target.value) },
    ["claude", "codex"].map((a) => h("option", { value: a, selected: a === draft.agent, text: a })));
  const task = h("textarea", { id: "task", placeholder: "What should the agent do?", oninput: (e) => (draft.task = e.target.value) });
  task.value = draft.task;
  const form = h("form.row", { onsubmit: async (e) => {
      e.preventDefault();
      if (!draft.task.trim()) return;
      const btn = e.target.querySelector("button"); btn.disabled = true;
      try {
        const r = await api("projects/" + enc(name) + "/runs", { agent: draft.agent, task: draft.task });
        draft.task = ""; showError(""); go("#/run/" + r.runId);
      } catch (err) { showError(err.message); btn.disabled = false; }
    } }, agentSel, task, h("button.primary", { type: "submit", text: "Start agent" }));
  const remove = h("button.danger", { text: "Remove project", onclick: async () => {
      if (!confirm("Remove " + name + " from Codec? The repository itself is not touched.")) return;
      try { await api("projects/" + enc(name) + "/remove", {}); showError(""); go("#/"); }
      catch (err) { showError(err.message); }
    } });
  app.replaceChildren(
    h("div.crumbs", {}, h("a", { href: "#/", text: "Projects" }), " / " + name),
    h("div.headrow", {}, h("div", {}, h("div.title", {}, h("b", { text: name })), h("div.sub.muted", { text: v.project.path })), remove),
    h("h2", { text: "Start an agent" }), form,
    h("h2", { text: "Board" }), h("div.board", {}, lanes));
  if (focused) { const t = document.getElementById("task"); t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
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
  const log = h("pre.log", { text: r.log || "(no output yet)" });
  app.replaceChildren(
    h("div.crumbs", {}, h("a", { href: "#/", text: "Projects" }), " / ",
      h("a", { href: "#/project/" + enc(r.project), text: r.project }), " / " + r.runId),
    h("div.kv", {},
      h("div", { text: "Task" }), h("div.fulltask", { text: r.task }),
      h("div", { text: "State" }), h("div", {}, h("span.state." + r.state, { text: stateText(r) })),
      h("div", { text: "Agent" }), h("div", { text: r.agent }),
      h("div", { text: "Started" }), h("div", { text: when(r.startedAt) }),
      h("div", { text: "Branch" }), h("div.mono", { text: r.branch }),
      h("div", { text: "Worktree" }), h("div.mono", { text: r.cleanedAt ? r.worktree + "  (cleaned)" : r.worktree })),
    actions,
    h("h2", { text: "Output (last 200 lines)" }), log);
  log.scrollTop = stick ? log.scrollHeight : old.scrollTop;
}

// ---------- routing + polling ----------
function go(hash) { if (location.hash === hash) refresh(); else location.hash = hash; }
async function refresh() {
  clearTimeout(timer);
  const seq = ++renderSeq;
  const parts = location.hash.replace(/^#\\/?/, "").split("/").map(decodeURIComponent);
  try {
    if (parts[0] === "project" && parts[1]) await project(seq, parts[1]);
    else if (parts[0] === "run" && parts[1]) await run(seq, parts[1]);
    else await home(seq);
    const s = await api("state");
    document.getElementById("running").textContent = s.agentsRunning;
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
