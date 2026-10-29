/** Self-contained dashboard. API data is inserted only through textContent. */
import { S } from "./strings.js";

export const THEME_KEY = "codec-theme";
const THEME_BOOT = `<script>try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}</script>`;
const DARK_VARS = `color-scheme: dark;
    --bg: #0f1115; --panel: #171a21; --panel2: #1f232c; --text: #e6e8ee; --muted: #8b93a7;
    --border: #2a2f3a; --accent: #6d8dff; --danger: #f06a6a;
    --working: #6d8dff; --needs: #f0a050; --review: #a78bfa; --done: #3ccf8e;`;

// JSON is script-safe even if future wording or a token contains markup.
function scriptJSON(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
function textHTML(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderLocked(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Codec</title>
<style>:root{color-scheme:light;--bg:#f6f7f9;--text:#1b1f27}
@media (prefers-color-scheme: dark){:root{color-scheme:dark;--bg:#0f1115;--text:#e6e6e6}}
body{font:15px system-ui,sans-serif;background:var(--bg);color:var(--text);display:grid;place-items:center;height:100vh;margin:0;padding:24px}</style></head>
<body><div><h2>${textHTML(S.locked.title)}</h2><p>${textHTML(S.locked.hint)}</p></div></body></html>`;
}

export function renderPage(token: string): string {
  return String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Codec</title>
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
.kv div:nth-child(odd) { color: var(--muted); word-break: normal; overflow-wrap: normal; }
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

header { flex-wrap: wrap; gap: 12px; }
header .theme { margin-left: auto; }
label.field { display: flex; flex-direction: column; gap: 4px; min-width: 180px; }
label.field textarea { min-height: 120px; width: 100%; }
.hint { color: var(--muted); font-size: 12px; }
.message { white-space: pre-wrap; color: var(--danger); margin: 6px 0; }
.message:empty { display: none; }
[hidden] { display: none !important; }
.message.success { color: var(--done); }
.folder-panel { border: 1px solid var(--border); padding: 12px; border-radius: 8px; margin-top: 8px; }
.folder-list { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; margin: 8px 0; max-height: 260px; overflow: auto; }
.folder-current { overflow-wrap: anywhere; }
dialog { background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 12px; width: min(600px, 94vw); padding: 24px; }
dialog::backdrop { background: #0008; }
dialog h2 { margin-top: 0; }
.setup-tool { margin: 12px 0; }
.fix { white-space: pre-wrap; overflow-wrap: anywhere; padding: 12px; background: var(--panel2); user-select: all; }
button:focus-visible, a:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.table-scroll { overflow-x: auto; }
@media (max-width: 650px) { header { position: static; padding: 12px; } main { padding: 12px; } .board { grid-template-columns: 1fr; } nav { flex-wrap: wrap; } }
</style></head><body>
<header>
<h1><a href="#/">Codec</a></h1>
<nav>
<a href="#/" data-page="projects" data-testid="nav-projects">${textHTML(S.nav.projects)}</a>
<a href="#/teams" data-page="teams" data-testid="nav-teams">${textHTML(S.nav.teams)}</a>
<a href="#/specialists" data-page="specialists" data-testid="nav-specialists">${textHTML(S.nav.specialists)}</a>
<a href="#/skills" data-page="skills" data-testid="nav-skills">${textHTML(S.nav.skills)}</a>
<a href="#/accounts" data-page="accounts" data-testid="nav-accounts">${textHTML(S.nav.accounts)}</a>
<a href="#/setup" data-page="setup" data-testid="setup-open">${textHTML(S.nav.setup)}</a>
</nav>
<span class="stat"><b id="teamsN">–</b>${textHTML(S.common.teamCount)}</span>
<span class="stat"><b id="running" title="${textHTML(S.wording.aiHelper)}">–</b>${textHTML(S.common.running)}</span>
<span class="stat" title="${textHTML(S.wording.memoryHint)}"><b id="memory">–</b>${textHTML(S.common.memory)}</span>
<label class="theme muted">${textHTML(S.theme.label)}
<select id="theme" data-testid="theme" aria-label="${textHTML(S.theme.label)}">
<option value="auto">${textHTML(S.theme.auto)}</option>
<option value="light">${textHTML(S.theme.light)}</option>
<option value="dark">${textHTML(S.theme.dark)}</option>
</select></label>
<span class="err" id="err" role="status" data-testid="connection-message" data-message-key="connection"></span>
</header>
<main id="app"></main>
<dialog id="confirm" data-testid="confirm-dialog" aria-labelledby="confirm-title"></dialog>
<script>
"use strict";
const S = ${scriptJSON(S)};
const TOKEN = ${scriptJSON(token)};
const THEME_KEY = ${JSON.stringify(THEME_KEY)};
const app = document.getElementById("app");
const enc = encodeURIComponent;
const folders = new Map();
const messages = new Map();
let setupState = { tools: [], ready: false };
let setupChecked = false;
let accountsState = { accounts: [], defaults: {}, choices: {} };
let timer = null;
let renderSeq = 0;
let busy = 0;
let lastRoute = null;
let tracking = null;
let dialogTrigger = null;
const LANES = [["working", S.tasks.working], ["needsYou", S.tasks.needsYou], ["inReview", S.tasks.inReview], ["done", S.tasks.done]];
function fmt(text, values) { return text.replace(/\{(\w+)\}/g, (_, k) => String(values[k] ?? "")); }
function h(spec, props, ...kids) {
  const [tag, ...classes] = spec.split(".");
  const el = document.createElement(tag || "div");
  if (classes.length) el.className = classes.join(" ");
  if (props) for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "text") el.textContent = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === undefined || kid === null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
function replace(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((kid) => kid !== null && kid !== undefined && kid !== false));
}
function button(id, text, onclick, props = {}) {
  return h("button", { type: "button", "data-testid": id, text, onclick, ...props });
}
function submit(id, text) { return h("button.primary", { type: "submit", "data-testid": id, text }); }
function heading(text) { return h("h2", { text }); }
function field(id, label, props = {}, tag = "input") {
  const node = h(tag, { id, "data-testid": id, type: tag === "input" ? "text" : undefined, ...props });
  return h("label.field", {}, h("span", { text: label }), node);
}
function hint(text) { return h("span.hint", { text }); }
function cardLine(text) { return text ? h("div.hint", { text: text + "\n" }) : null; }
function disclosure(id, title, child, key) {
  return h("details", { id: id + (key ? "-" + key : ""), "data-key": key },
    h("summary", { "data-testid": id, "data-key": key, text: title }), child);
}
function messageContent(key, m) {
  if (!m) return [];
  const e = m.error;
  return [m.text,
    e?.suggestion ? h("span", {}, " ", fmt(S.wording.tryName, { suggestion: e.suggestion }), " ",
      button("use-suggested-name", S.wording.useName, (event) => {
        const form = event.currentTarget.closest("form");
        if (!form) return;
        const name = form.querySelector('[data-testid$="-name"]');
        if (name) { name.value = e.suggestion; name.dispatchEvent(new Event("input", { bubbles: true })); name.focus(); }
        else { form.dataset.skillName = e.suggestion; form.requestSubmit(); }
        tell(key, "");
      })) : null,
    e?.code === "project_registered" ? h("a.link", { href: "#/project/" + enc(e.params?.name), text: fmt(S.wording.openProject, { name: e.params?.name }) }) : null,
    e?.code === "tool_unavailable" || e?.code === "spawn_failed" || e?.code === "identity_missing" ? h("a.link", { href: "#/setup", text: S.nav.setup }) : null,
    e?.code?.startsWith("account_") ? h("a.link", { href: "#/accounts", text: S.accounts.open }) : null,
    e?.links?.map((link) => h("a.link", { href: "#/run/" + enc(link.id), text: snippet(link.task, 40) })) || null,
    e?.code === "skill_exists" ? button("skill-replace", S.wording.replace, () => showDialog(
      fmt(S.wording.replaceTitle, { name: e.params.name }), [S.wording.replaceEffect], null,
      async () => { await e.replaceSkill(); tell(key, S.common.added, true); }, undefined, S.wording.replace)) : null,
    e && (!e.code || !Object.hasOwn(S.errors, e.code) || e.code === "unknown_error") ? button("copy-details", S.wording.copyDetails, async () => {
      try { const details = await api("error-details"); await navigator.clipboard.writeText(details.logPath + "\n" + details.time); tell(key, S.wording.detailsCopied); }
      catch (error) { tell(key, errorText(error)); }
    }) : null];
}
function message(key) {
  const m = messages.get(key);
  return h("div.message" + (m && m.success ? ".success" : ""), {
    role: "status", "data-testid": "action-message", "data-message-key": key,
  }, messageContent(key, m));
}
function tell(key, text, success = false, error = null) {
  const m = { text, success, error };
  messages.set(key, m);
  for (const el of document.querySelectorAll("[data-message-key]")) if (el.dataset.messageKey === key) {
    replace(el, messageContent(key, m)); el.classList.toggle("success", success);
  }
}
function errorText(error) {
  if (error?.code && Object.hasOwn(S.errors, error.code)) return fmt(S.errors[error.code], error.params || {});
  return error && error.friendly ? error.message : S.common.error;
}
async function api(path, body) {
  const opts = { headers: { "X-Codec-Token": TOKEN } };
  if (body !== undefined) {
    opts.method = "POST"; opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body);
  }
  let response;
  try { response = await fetch("/api/" + path, opts); }
  catch (_) { const e = new Error(S.common.networkError); e.friendly = true; throw e; }
  let data;
  try { data = await response.json(); }
  catch (_) { const e = new Error(S.common.invalidReply); e.friendly = true; throw e; }
  if (!response.ok) {
    const e = new Error(typeof data.error === "string" ? data.error : S.common.error);
    e.friendly = true; e.code = data.code; e.params = data.params; e.suggestion = data.suggestion; e.links = data.links;
    if (data.code === "skill_exists") e.replaceSkill = () => api(path, { ...body, replace: true });
    throw e;
  }
  return data;
}
async function act(key, trigger, action, success = S.common.saved) {
  if (trigger) trigger.disabled = true;
  busy++;
  tell(key, "");
  try { await action(); if (success) tell(key, success, true); return true; }
  catch (e) { tell(key, errorText(e), false, e); return false; }
  finally { busy--; if (trigger && trigger.isConnected) trigger.disabled = false; refresh(); }
}
function val(form, id) { return (form.querySelector('[data-field="' + id + '"]') || form.querySelector("#" + CSS.escape(id))).value; }
function limitField(id, value, placeholder = S.common.timeHint) {
  if (value !== undefined) placeholder = S.wording.keepLimit;
  return h("div", {}, field(id, S.common.timeLimit, { type: "number", min: "0", max: "1440", step: "any", value, placeholder,
    oninput: (e) => {
      const input = e.currentTarget;
      input.setCustomValidity(input.value !== "" && (Number(input.value) <= 0 || Number(input.value) > 1440) ? S.common.timeInvalid : "");
    },
  }), hint(placeholder));
}
function limitValue(form, id) {
  const value = val(form, id);
  if (value === "") return undefined;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) {
    const e = new Error(S.common.timeInvalid); e.friendly = true; throw e;
  }
  return minutes;
}
function limitText(value) { return value === undefined || value === 0 ? S.common.noLimit : fmt(S.common.minutes, { value }); }
function checks(id, names, selected = []) {
  return names.length ? h("div.checks", {}, names.map((name) => h("label.check", {},
    h("input", { type: "checkbox", id: id + "-" + name, "data-testid": id, "data-key": name, value: name, checked: selected.includes(name) }), " ", name)))
    : hint(S.common.noneAvailable);
}
function checked(form, id) { return [...form.querySelectorAll("input[type=checkbox]")].filter((n) => n.dataset.testid === id && n.checked).map((n) => n.value); }
function clearForm(form) {
  form.reset();
  for (const el of form.querySelectorAll("input, textarea")) {
    if (el.type === "checkbox") el.checked = false;
    else el.value = "";
    el.setCustomValidity("");
  }
}
function toolName(tool) { return tool === "claude" ? S.setup.claude : tool === "codex" ? S.setup.codex : S.common.unknown; }
function toolState(tool) { return setupState.tools.find((t) => t.tool === tool); }
function toolOK(tool) { const t = toolState(tool); return !!(t && t.installed && t.signedIn === true); }
function toolProblem(tool) {
  const t = toolState(tool);
  return t ? t.problem || (!t.installed ? S.setup.notInstalled : S.setup.notSignedIn) : S.setup.unchecked;
}
function toolOption(value, tool, label, selected) {
  const ok = toolOK(tool);
  return h("option", { value, selected, disabled: !ok, title: ok ? undefined : toolProblem(tool),
    text: label + (ok ? "" : " — " + S.common.unavailable + ": " + toolProblem(tool)) });
}
function toolPicker(id, selected) {
  const select = h("select", { id, "data-testid": id, required: true, "data-keep-unavailable": selected ? "true" : undefined }, ["claude", "codex"].map((t) => toolOption(t, t, toolName(t), selected === t)));
  select.value = selected || ["claude", "codex"].find(toolOK) || "";
  return h("label.field", {}, S.common.tool, select);
}
function stateText(r) {
  if (r.reviewStatus === "unsaved") return S.tasks.unsaved;
  if (r.reviewStatus === "unavailable") return S.tasks.workspaceUnchecked;
  if (r.reviewStatus === "no_changes") return S.tasks.noChanges;
  if (r.lostAt) return S.wording.lost;
  if (r.state === "timed_out") return r.stateText || fmt(S.tasks.timedOut, { limit: limitText(r.timeLimitMinutes) });
  const labels = { running: S.tasks.working, done: S.wording.finished, failed: S.tasks.failed, stopped: S.tasks.stopped, timed_out: S.tasks.timedOut };
  return labels[r.state] || S.common.unknown;
}
function whoText(r) { return r.team ? fmt(S.wording.helperTeam, { team: r.team, member: r.member }) : S.wording.quick; }
function memberHref(team, member) { return "#/member/" + enc(team) + "/" + enc(member); }
function when(iso) { return iso ? new Date(iso).toLocaleString() : S.common.unknown; }
function mem(bytes) {
  if (bytes === null || bytes === undefined) return S.wording.dash;
  if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(0) + " " + S.common.kb;
  if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(0) + " " + S.common.mb;
  return (bytes / 1024 ** 3).toFixed(2) + " " + S.common.gb;
}
function snippet(text, length = 120) { text = text.replace(/\s+/g, " ").trim(); return text.length > length ? text.slice(0, length) + "…" : text; }
function sourceText(s, project) { return s.source === "specialist" ? S.members.fromSpecialist : s.source === "project" ? fmt(S.members.fromProject, { project: s.project || project || S.tasks.project }) : S.members.own; }
function crumbs(...items) { return h("div.crumbs", {}, h("a", { href: "#/", text: S.nav.projects }), items.map((x) => [" / ", x])); }
function table(headers, rows) { return h("div.table-scroll", {}, h("table", {}, h("thead", {}, h("tr", {}, headers.map((t) => h("th", { text: t })))), h("tbody", {}, rows))); }
function taskTable(runs, forMember = false) {
  return runs.length ? table([S.tasks.project, ...(forMember ? [] : [S.tasks.who, S.common.tool]), S.tasks.state, S.tasks.started, S.tasks.task], runs.map((r) => h("tr", {},
    h("td", {}, h("a.link", { href: "#/project/" + enc(r.project), text: r.project })),
    forMember ? null : h("td", { text: whoText(r) }), forMember ? null : h("td", { text: toolName(r.agent) }), h("td", { text: stateText(r) }), h("td", { text: when(r.startedAt) }),
    h("td.task", {}, h("a.link", { href: "#/run/" + enc(r.runId), "data-testid": "task-open", "data-key": r.runId, title: r.task, text: snippet(r.task) }))))) : hint(S.tasks.empty);
}

// Polls preserve field values, focus/caret, disclosures, and page/log scroll.
function snapshot() {
  const fields = [...app.querySelectorAll("input[id], textarea[id], select[id]")].filter((el) => el.type !== "file" && el.type !== "password").map((el) => ({
    id: el.id, value: el.value, checked: el.checked,
  }));
  const open = [...app.querySelectorAll("details[id]")].map((el) => [el.id, el.open]);
  const active = document.activeElement;
  const focus = active && app.contains(active) && active.id ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
  const log = app.querySelector("pre.log");
  const files = [...app.querySelectorAll("input[type=file][id]")];
  return { fields, files, open, focus, scroll: window.scrollY, log: log && { top: log.scrollTop, bottom: log.scrollTop + log.clientHeight >= log.scrollHeight - 20 } };
}
function restore(snap) {
  for (const input of snap.files) { const next = document.getElementById(input.id); if (next) next.replaceWith(input); }
  for (const saved of snap.fields) {
    const el = document.getElementById(saved.id);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = saved.checked;
    else if (el.tagName !== "SELECT" || [...el.options].some((o) => o.value === saved.value && (!o.disabled || el.dataset?.keepUnavailable === "true"))) el.value = saved.value;
    else el.value = "";
  }
  for (const [id, open] of snap.open) { const el = document.getElementById(id); if (el) el.open = open; }
  if (snap.focus) {
    const el = document.getElementById(snap.focus.id);
    if (el) { el.focus({ preventScroll: true }); try { el.setSelectionRange(snap.focus.start, snap.focus.end); } catch (_) {} }
  }
  window.scrollTo(0, snap.scroll);
  const log = app.querySelector("pre.log");
  if (log) log.scrollTop = !snap.log || snap.log.bottom ? log.scrollHeight : snap.log.top;
}
function render(seq, ...kids) {
  if (seq !== renderSeq || busy) return;
  const snap = location.hash === lastRoute ? snapshot() : null;
  replace(app, ...kids);
  if (snap) restore(snap);
  lastRoute = location.hash;
}

// Folder data lives outside the polled DOM; browsing never loses typed form values.
function folderPicker(prefix, pathLabel) {
  const state = folders.get(prefix) || { data: null, error: "", loading: false, request: 0 };
  folders.set(prefix, state);
  const path = h("input", { id: prefix + "-path", "data-testid": prefix + "-path", type: "text", required: true, placeholder: S.wording.chooseFolder });
  const panel = h("section.folder-panel", { "data-testid": "folder-panel", hidden: !state.data && !state.error && !state.loading });
  function paint() {
    panel.hidden = !state.data && !state.error && !state.loading;
    const data = state.data;
    replace(panel,
      data ? h("div.folder-current", { "data-testid": "folder-current" }, S.folder.current + ": ", h("strong", { text: data.path })) : null,
      data ? hint([data.isGit ? S.folder.tracked : "", data.hasSkill ? S.folder.skill : ""].filter(Boolean).join(" · ")) : null,
      data ? button("folder-up", S.folder.up, () => browse(data.parent), { disabled: !data.parent }) : null,
      data ? h("div.folder-list", {}, data.folders.length ? data.folders.map((f) => button("folder-entry", f.name +
        (f.isGit ? " · " + S.folder.tracked : "") + (f.hasSkill ? " · " + S.folder.skill : ""), () => browse(f.path), { "data-key": f.path, disabled: state.loading })) : hint(S.folder.empty)) : null,
      data ? button("folder-use", S.folder.use, () => { path.value = data.path; path.dispatchEvent(new Event("input", { bubbles: true })); path.focus(); }, { disabled: state.loading }) : null,
      h("p.message", { role: "status", "data-testid": "action-message", text: state.error }));
  }
  async function browse(folder) {
    const request = ++state.request;
    state.loading = true; state.error = ""; state.paint();
    try { const data = await api("folders" + (folder ? "?path=" + enc(folder) : "")); if (request === state.request) state.data = data; }
    catch (e) { if (request === state.request) state.error = errorText(e); }
    finally { if (request === state.request) { state.loading = false; state.paint(); } }
  }
  state.paint = paint;
  paint();
  return h("div", { "data-testid": "folder-picker" }, h("label.field", {}, pathLabel, path), hint(S.folder.hint),
    button("folder-browse", S.folder.browse, () => browse(path.value.trim())), panel);
}

// The dialog stays outside the refreshed page, including when an action fails.
const dialog = document.getElementById("confirm");
function closeDialog() { dialog.close(); if (dialogTrigger && dialogTrigger.isConnected) dialogTrigger.focus(); }
dialog.addEventListener("close", () => { if (dialogTrigger && dialogTrigger.isConnected) dialogTrigger.focus(); });
function showDialog(title, effects, blocked, onConfirm, extra, confirmLabel = S.confirm.remove) {
  dialogTrigger = document.activeElement;
  const key = "dialog";
  messages.delete(key);
  const cancel = button("confirm-cancel", S.common.cancel, closeDialog);
  replace(dialog, heading(title), hint(S.confirm.hint),
    h("ul", { "data-testid": "confirm-effects" }, (effects.length ? effects : [S.confirm.noEffects]).map((text) => h("li", { text }))),
    blocked ? h("p.message", { "data-testid": "confirm-blocked", text: blocked }) : null,
    extra, message(key), h("div.actions", {}, cancel,
      blocked ? null : button("confirm-submit", confirmLabel, async (e) => {
        cancel.disabled = true;
        try { await act(key, e.currentTarget, async () => { await onConfirm(); closeDialog(); }, ""); }
        finally { cancel.disabled = false; }
      }, { class: "danger" })));
  dialog.querySelector("h2").id = "confirm-title";
  if (!dialog.open) dialog.showModal();
  cancel.focus();
}
async function removeItem(kind, name, route, key, trigger, after) {
  await act(key, trigger, async () => {
    const preview = await api("remove-preview?kind=" + enc(kind) + "&name=" + enc(name));
    showDialog(preview.removalText || fmt(S.confirm.title, { name }), preview.effects.map((e) => e.what),
      preview.blocked ? preview.blockedReason || S.confirm.blocked : null, async () => {
        await api(route, {}); tell(key, S.common.removed, true); if (after) after();
      });
  }, "");
}
function removeButton(kind, name, route, key, label, after) {
  return button(kind + "-remove", label, (e) => removeItem(kind, name, route, key, e.currentTarget, after), { class: "danger", "data-key": name });
}

async function setup(seq) {
  const settings = await api("settings");
  const identityForm = h("form.stack", { "data-testid": "identity-form", onsubmit: (e) => {
    e.preventDefault(); act("identity", e.submitter, async () => {
      await api("settings", { identity: { name: val(identityForm, "identity-name"), email: val(identityForm, "identity-email") } });
    });
  } }, h("h3", { text: S.setup.identity }), hint(S.setup.identityHint),
    setupState.identityReady ? null : h("p", { "data-testid": "identity-missing", text: S.setup.identityMissing }),
    field("identity-name", S.setup.identityName, { value: settings.identity.name, required: true, autocomplete: "name" }),
    field("identity-email", S.setup.identityEmail, { value: settings.identity.email, required: true, type: "email", autocomplete: "email" }),
    submit("identity-save", S.common.save), message("identity"));
  const working = setupState.tools.filter((t) => toolOK(t.tool));
  const needed = [];
  if (!setupState.ready) needed.push(S.setup.notReady);
  if (!setupState.identityReady) needed.push(S.setup.identityNeeded);
  const status = needed.length ? needed.join(" ") : working.length === 1
    ? fmt(S.setup.oneReady, { tool: toolName(working[0].tool) }) : S.setup.ready;
  const rows = setupState.tools.map((t) => {
    const fix = t.fix || S.setup.fixMissing;
    return h("section.card.setup-tool", { "data-testid": "setup-tool", "data-key": t.tool },
      h("h3", { text: toolName(t.tool) }), h("p", { text: toolOK(t.tool) ? S.setup.ok : toolProblem(t.tool) }),
      t.version ? h("span.muted", { text: t.version }) : null,
      toolOK(t.tool) ? null : h("div", {}, h("pre.fix", { "data-testid": "setup-fix", text: fix }),
        button("setup-copy", S.common.copy, async () => {
          try { await navigator.clipboard.writeText(fix); tell("setup-" + t.tool, S.common.copied, true); }
          catch (_) { tell("setup-" + t.tool, S.common.copyFailed); }
        }, { "data-key": t.tool }), message("setup-" + t.tool)));
  });
  render(seq, h("section", { "data-testid": "setup-wizard" }, heading(S.setup.title), h("p", { text: S.setup.hint }),
    h("p", { "data-testid": "setup-status", text: status }), identityForm, rows,
    button("setup-check", S.setup.check, (e) => act("setup", e.currentTarget, async () => { setupState = await api("setup?fresh=1"); }, "")),
    button("setup-continue", S.setup.continue, (e) => act("setup", e.currentTarget, async () => { await api("settings", { setupFinished: true }); go("#/"); }, ""), { disabled: !setupState.ready }),
    button("setup-skip", S.setup.skip, (e) => act("setup", e.currentTarget, async () => { await api("settings", { setupFinished: true }); go("#/"); }, "")), message("setup")));
}

function currentAccounts() { return typeof accountsState === "undefined" ? { accounts: [], choices: {}, defaults: {} } : accountsState; }
function accountPicker(scope, name, kind) {
  const state = currentAccounts();
  const key = scope + "-account-" + name + "-" + kind;
  const selected = state.choices[scope + ":" + name]?.[kind] || "";
  const select = h("select", { id: key, "data-testid": scope + "-account", "data-key": kind,
    onchange: (e) => act(key, e.currentTarget, () => api("account-settings", { scope, name, kind, accountId: e.currentTarget.value })) },
    h("option", { value: "", text: S.accounts.useDefault }), state.accounts.filter((a) => a.kind === kind).map((a) => h("option", { value: a.id, text: a.name })));
  select.value = selected;
  return h("div", {}, h("label.field", {}, h("span", { text: S.accounts.label + " · " + toolName(kind) }), select), message(key));
}
function accountSettings(scope, name, kind) {
  return h("div.stackcards", {}, kind ? accountPicker(scope, name, kind) : ["claude", "codex"].map((tool) => accountPicker(scope, name, tool)),
    hint(S.accounts.newTasks), h("a.link", { href: "#/accounts", text: S.accounts.open }));
}
function loginDetails(account) {
  const login = account.login, key = "account-" + account.id;
  if (!login) return null;
  if (login.state !== "waiting") return h("p", { "data-testid": "account-login-state", text: login.state === "signed_in" ? S.accounts.signedIn : S.accounts[login.state] });
  const codeForm = h("form.stack", { "data-testid": "account-code-form", onsubmit: (event) => {
    event.preventDefault();
    const input = codeForm.querySelector("input");
    const code = input.value.trim(); input.value = "";
    act(key, codeForm.querySelector("button"), () => api("accounts/" + enc(account.id) + "/code", { code }), "");
  } }, hint(S.accounts.pasteHint), field("account-code-" + account.id, S.accounts.pasteCode, { type: "password", autocomplete: "off" }), submit("account-send-code", S.accounts.sendCode));
  return h("div", { "data-testid": "account-login" }, h("p", { text: S.accounts.waiting }),
    login.url ? h("a.link", { href: login.url, target: "_blank", rel: "noopener noreferrer", referrerpolicy: "no-referrer", "data-testid": "account-open-sign-in", text: S.accounts.openSignIn }) : null,
    login.code ? h("p", {}, S.accounts.deviceCode, " ", h("strong", { "data-testid": "account-device-code", text: login.code })) : null,
    login.needsCode ? codeForm : null,
    button("account-cancel", S.common.cancel, (e) => act(key, e.currentTarget, () => api("accounts/" + enc(account.id) + "/cancel", {}), "")));
}
async function accounts(seq) {
  const state = await api("accounts");
  accountsState = state;
  const key = "account-add";
  const kind = h("select", { id: "account-kind", "data-testid": "account-kind", onchange: () => { methodField.hidden = kind.value !== "codex"; } }, ["claude", "codex"].map((tool) => h("option", { value: tool, text: toolName(tool) })));
  const method = h("select", { id: "account-method", "data-testid": "account-method" }, h("option", { value: "device", text: S.accounts.device }), h("option", { value: "browser", text: S.accounts.browser }));
  const methodField = h("label.field", { hidden: true }, S.accounts.method, method);
  const add = h("form.stack", { "data-testid": "account-add-form", onsubmit: (e) => {
    e.preventDefault();
    act(key, add.querySelector("button"), async () => {
      const account = await api("accounts", { name: val(add, "account-name").trim(), kind: kind.value });
      await api("accounts/" + enc(account.id) + "/login", { method: method.value });
      clearForm(add);
    }, "");
  } }, h("label.field", {}, S.common.tool, kind), field("account-name", S.common.name, { required: true, maxlength: 80 }), hint(S.accounts.nameHint),
    methodField, submit("account-sign-in", S.accounts.signIn), message(key));
  render(seq, crumbs(S.nav.accounts), heading(S.accounts.title), hint(S.accounts.intro), hint(S.accounts.newTasks),
    button("accounts-check", S.accounts.check, (e) => act("accounts", e.currentTarget, async () => { accountsState = await api("accounts?fresh=1"); }, "")), message("accounts"),
    h("div.stackcards", {}, state.accounts.map((account) => {
      const key = "account-" + account.id, route = "accounts/" + enc(account.id);
      const isDefault = state.defaults[account.kind] === account.id;
      return h("section.card", { "data-testid": "account-card", "data-key": account.id }, h("h3", { text: account.name }),
        h("p", { text: toolName(account.kind) + " · " + (account.status === "signed_in" ? S.accounts.signedIn : account.status === "limit" ? S.accounts.limit : S.accounts.needsSignIn) + (isDefault ? " · " + S.accounts.default : "") }),
        h("div.actions", {}, !isDefault ? button("account-default", S.accounts.makeDefault, (e) => act(key, e.currentTarget, () => api(route + "/default", {}))) : null,
          !account.builtin && account.login?.state !== "waiting" ? [button("account-sign-in-again", S.accounts.signIn, (e) => act(key, e.currentTarget, () => api(route + "/login", { method: "device" }), ""), { disabled: account.running }),
            account.kind === "codex" ? button("account-browser-sign-in", S.accounts.browser, (e) => act(key, e.currentTarget, () => api(route + "/login", { method: "browser" }), ""), { disabled: account.running }) : null] : null,
          !account.builtin ? button("account-remove", S.accounts.remove, () => showDialog(fmt(S.accounts.removeTitle, { name: account.name }), [S.accounts.removeEffect], account.running ? S.errors.account_busy : null,
            () => api(route + "/remove", { confirmed: true })), { class: "danger" }) : null), loginDetails(account), message(key));
    })), disclosure("account-add-open", S.accounts.add, add));
}
function projectAddForm() {
  const key = "project-add";
  const trackingBox = h("div", { "data-testid": "project-tracking", hidden: !tracking });
  function paintTracking(form) {
    trackingBox.hidden = !tracking;
    replace(trackingBox, tracking ? h("p", { text: tracking.question }) : null,
      tracking ? button("tracking-yes", tracking.checkpoint ? S.wording.checkpointYes : S.wording.trackingYes, (e) => act(key, e.currentTarget, async () => {
        await api("projects", { ...tracking.body, setUpTracking: true }); tracking = null; clearForm(form); paintTracking(form);
      }, S.common.added)) : null,
      tracking ? button("tracking-no", S.common.cancel, () => { tracking = null; paintTracking(form); }) : null);
  }
  const form = h("form.stack", { "data-testid": "project-add-form", onsubmit: (e) => {
    e.preventDefault();
    const body = { path: val(form, "project-path").trim(), name: val(form, "project-name").trim() || undefined };
    act(key, form.querySelector("[type=submit]"), async () => {
      try { await api("projects", body); tracking = null; clearForm(form); tell(key, S.common.added, true); }
      catch (error) {
        if (error.code !== "needs_tracking" && error.code !== "needs_checkpoint") throw error;
        tracking = { body, question: errorText(error), checkpoint: error.code === "needs_checkpoint" }; paintTracking(form);
      }
    }, "");
  } }, field("project-name", S.wording.projectName), hint(S.projects.nameHint), hint(S.wording.nameRules), folderPicker("project", S.projects.path),
    submit("project-save", S.projects.add), trackingBox, message(key));
  form.addEventListener("input", () => { if (tracking) { tracking = null; paintTracking(form); } });
  paintTracking(form);
  return form;
}
async function home(seq) {
  const state = await api("state");
  render(seq, heading(S.projects.title), hint(S.wording.helperIntro), state.projects.length ? h("div.grid", {}, state.projects.map((p) => h("a.card", { href: "#/project/" + enc(p.name) },
    h("div.title", { text: p.name }), h("div.sub", { text: p.path }), h("div.counts", {}, LANES.map(([k, text]) => h("span.pill." + k, { text: text + " " + p.lanes[k], title: laneHint(k) })))))) : hint(S.projects.empty),
    disclosure("project-add-open", S.projects.addTitle, projectAddForm()), heading(S.wording.allTasks), taskTable(state.runs));
}
async function project(seq, name) {
  const v = await api("projects/" + enc(name));
  const key = "project-" + name;
  const who = h("select", { id: "task-who", "data-testid": "task-who", required: true },
    h("optgroup", { label: S.tasks.teamMembers }, v.members.map((m) => toolOption("m:" + m.ref, m.tool, m.label))),
    h("optgroup", { label: S.tasks.worker }, ["claude", "codex"].map((t) => toolOption("a:" + t, t, fmt(S.wording.quickUsing, { tool: toolName(t) })))));
  who.value = [...who.options].find((o) => !o.disabled)?.value || "";
  const form = h("form.stack", { "data-testid": "task-form", onsubmit: (e) => {
    e.preventDefault();
    act(key, form.querySelector("[type=submit]"), async () => {
      const body = { task: val(form, "task-text"), timeLimitMinutes: limitValue(form, "task-limit") };
      if (who.value.startsWith("m:")) body.member = who.value.slice(2); else body.agent = who.value.slice(2);
      const r = await api("projects/" + enc(name) + "/runs", body); clearForm(form); go("#/run/" + enc(r.runId));
    }, "");
  } }, h("label.field", {}, S.tasks.who, who), field("task-text", S.tasks.task, { required: true, placeholder: S.tasks.prompt }, "textarea"),
    limitField("task-limit", undefined, S.wording.usualLimit), submit("task-start", S.tasks.start), message(key));
  render(seq, crumbs(name), h("div.headrow", {}, h("div", {}, h("h1", { text: name }), hint(v.project.path)),
    removeButton("project", name, "projects/" + enc(name) + "/remove", key, S.projects.remove, () => go("#/"))),
    disclosure("project-account-settings", S.accounts.label, accountSettings("project", name)),
    hint(S.wording.helperIntro), heading(S.wording.giveTask), !v.members.length ? h("p", {}, S.projects.noTeam, h("a.link", { href: "#/teams" }, h("strong", { text: S.members.addTeam })), S.projects.noTeamAfter) : null, form, heading(S.projects.board), hint(S.wording.workspace),
    h("div.board", {}, LANES.map(([lane, text]) => h("section.lane." + lane, { title: laneHint(lane) }, h("h3", { text: text + " · " + v.lanes[lane].length }),
      v.lanes[lane].length ? v.lanes[lane].map((r) => h("a.card", { href: "#/run/" + enc(r.runId), "data-testid": "task-open", "data-key": r.runId },
        h("b", { text: whoText(r) }), h("div.task", { text: snippet(r.task, 200) }), cardLine(r.specialist ? fmt(S.wording.teamRole, { team: r.team, role: r.specialist }) : ""), cardLine(stateText(r)), cardLine(when(r.startedAt)))) : hint(S.common.empty)))));
}

function laneHint(lane) { return ({ working: S.wording.workingHint, needsYou: S.wording.needsYouHint, inReview: S.wording.reviewHint, done: S.wording.doneHint })[lane]; }
function namespace(form, key) {
  for (const el of form.querySelectorAll("[id]")) { el.dataset.field = el.id; el.id = key + "-" + el.id; }
  return form;
}
function specialistForm(s, skillNames) {
  const key = s ? "specialist-edit-" + s.name : "specialist-add";
  const form = h("form.stack", { "data-testid": s ? "specialist-edit-form" : "specialist-add-form", "data-key": s?.name, onsubmit: (e) => {
    e.preventDefault();
    act(key, form.querySelector("[type=submit]"), async () => {
      const body = {
        name: s ? undefined : val(form, "specialist-name").trim(), specialty: val(form, "specialist-specialty").trim(),
        tool: val(form, "specialist-tool"), model: val(form, "specialist-model").trim(), instructions: val(form, "specialist-instructions"),
        skills: checked(form, "specialist-skill"), timeLimitMinutes: limitValue(form, "specialist-limit"),
      };
      await api(s ? "specialists/" + enc(s.name) + "/edit" : "specialists", body);
      if (!s) clearForm(form);
    }, s ? S.common.saved : S.common.added);
  } }, s ? null : h("div", {}, field("specialist-name", S.common.name, { required: true, placeholder: S.wording.roleName }), hint(S.wording.nameRules)),
    field("specialist-specialty", S.specialists.specialty, { required: true, value: s?.specialty, placeholder: S.specialists.specialtyHint }),
    toolPicker("specialist-tool", s?.tool), field("specialist-model", S.common.model, { value: s?.model }),
    limitField("specialist-limit", s?.timeLimitMinutes), field("specialist-instructions", S.common.instructions, { value: undefined }, "textarea"),
    hint(S.common.instructionsHint), hint(S.wording.skillsIntro), h("div", {}, S.specialists.skills, checks("specialist-skill", skillNames, s?.skills)),
    submit("specialist-save", s ? S.wording.saveChanges : S.specialists.add), message(key));
  form.querySelector("textarea").value = s?.instructions || "";
  return namespace(form, key);
}
async function specialists(seq) {
  const [specs, sk] = await Promise.all([api("specialists"), api("skills")]);
  const names = sk.skills.map((s) => s.name);
  render(seq, crumbs(S.nav.specialists), heading(S.specialists.title), hint(S.wording.rolesIntro), hint(S.wording.helperIntro), hint(S.wording.skillsIntro), specs.length ? h("div.stackcards", {}, specs.map((s) => h("section.card", { "data-key": s.name },
    h("div.headrow", {}, h("h3", { text: s.name }), removeButton("specialist", s.name, "specialists/" + enc(s.name) + "/remove", "specialist-" + s.name, S.specialists.remove)),
    hint(s.specialty + " · " + toolName(s.tool) + (s.model ? " · " + S.wording.aiModel + " " + s.model : "")),
    h("div.kv", {}, [S.common.timeLimitLabel, limitText(s.timeLimitMinutes ?? 60), S.common.skills, s.skills.join(", ") || S.common.none,
      S.common.instructions, s.instructions || S.common.none].map((text) => h("div.fulltask", { text }))),
    h("div", {}, hint(S.specialists.copies + ": "), s.clones.length ? s.clones.map((c, i) => [i ? ", " : "", h("a.link", { href: memberHref(c.team, c.member), text: fmt(S.wording.helperTeam, c) })]) : S.wording.noRoleUsers),
    message("specialist-" + s.name), disclosure("specialist-edit-open", S.specialists.edit, specialistForm(s, names), s.name)))) : hint(S.specialists.empty),
    disclosure("specialist-add-open", S.specialists.addTitle, specialistForm(null, names)));
}
function memberForm(team, specs, skillNames, member) {
  const key = member ? "member-edit-" + team + "-" + member.member : "member-add-" + team;
  const kind = h("select", { id: "member-kind", "data-testid": "member-kind", required: true },
    h("optgroup", { label: S.members.specialist }, specs.map((s) => toolOption("s:" + s.name, s.tool, s.name + " · " + s.specialty + " · " + toolName(s.tool)))),
    h("optgroup", { label: S.members.worker }, ["claude", "codex"].map((t) => toolOption("t:" + t, t, fmt(S.wording.generalUsing, { tool: toolName(t) })))));
  kind.value = [...kind.options].find((o) => !o.disabled)?.value || "";
  const form = h("form.stack", { "data-testid": member ? "member-edit-form" : "member-add-form", "data-key": member?.member, onsubmit: (e) => {
    e.preventDefault();
    act(key, form.querySelector("[type=submit]"), async () => {
      const body = { skills: checked(form, "member-skill"), timeLimitMinutes: limitValue(form, "member-limit") };
      if (!member) {
        body.name = val(form, "member-name").trim() || undefined;
        if (kind.value.startsWith("s:")) body.specialist = kind.value.slice(2); else body.tool = kind.value.slice(2);
        body.model = val(form, "member-model").trim() || undefined;
      }
      await api("teams/" + enc(team) + "/members" + (member ? "/" + enc(member.member) + "/edit" : ""), body);
      if (!member) clearForm(form);
    }, member ? S.common.saved : S.common.added);
  } }, member ? null : h("label.field", {}, S.members.kind, kind),
    member ? null : h("div", {}, field("member-name", S.common.optionalName, { placeholder: S.wording.helperName }), hint(S.wording.nameRules)), member ? null : field("member-model", S.common.model),
    limitField("member-limit", member?.timeLimitMinutes, member?.specialist || (!member && kind.value.startsWith("s:")) ? S.wording.roleLimit : S.common.timeHint), h("div", {}, S.members.extraSkills,
      checks("member-skill", skillNames, (member?.skills || []).filter((s) => s.source === "member").map((s) => s.name))),
    hint(S.wording.skillsIntro), hint(S.members.instructionsHint), submit("member-save", member ? S.common.save : S.members.add), message(key));
  return namespace(form, key);
}
function teamForm(t, projectNames) {
  const key = t ? "team-edit-" + t.name : "team-add";
  const form = h("form.stack", { "data-testid": t ? "team-edit-form" : "team-add-form", "data-key": t?.name, onsubmit: (e) => {
    e.preventDefault();
    act(key, form.querySelector("[type=submit]"), async () => {
      await api(t ? "teams/" + enc(t.name) + "/projects" : "teams", {
        name: t ? undefined : val(form, "team-name").trim(), projects: checked(form, "team-project"),
      });
      if (!t) clearForm(form);
    }, t ? S.common.saved : S.common.added);
  } }, t ? null : h("div", {}, field("team-name", S.common.name, { required: true, placeholder: S.wording.teamName }), hint(S.wording.nameRules)), h("div", {}, S.teams.projects, checks("team-project", projectNames, t?.projects)),
    submit("team-save", t ? S.common.save : S.teams.add), message(key));
  return namespace(form, key);
}
async function teams(seq) {
  const [list, state, specs, sk] = await Promise.all([api("teams"), api("state"), api("specialists"), api("skills")]);
  const projects = state.projects.map((p) => p.name);
  const skills = sk.skills.map((s) => s.name);
  render(seq, crumbs(S.nav.teams), heading(S.teams.title), hint(S.wording.helperIntro), hint(S.wording.skillsIntro), list.length ? h("div.stackcards", {}, list.map((t) => h("section.card", { "data-key": t.name },
    h("div.headrow", {}, h("h3", { text: t.name }), removeButton("team", t.name, "teams/" + enc(t.name) + "/remove", "team-" + t.name, S.teams.remove)),
    h("p", {}, S.teams.projects + ": ", t.projects.length ? t.projects.map((p, i) => [i ? ", " : "", h("a.link", { href: "#/project/" + enc(p), text: p })]) : S.common.noneAvailable),
    message("team-" + t.name), disclosure("team-edit-open", S.teams.edit, h("div", {}, teamForm(t, projects), accountSettings("team", t.name)), t.name),
    t.members.length ? table([S.members.title, S.members.kind, S.common.tool, S.wording.extraSkills, S.members.working, ""], t.members.map((m) => h("tr", {},
      h("td", {}, h("a.link", { href: memberHref(t.name, m.member || m.name), text: m.member || m.name })),
      h("td", { text: m.error ? S.members.broken : m.specialist ? fmt(S.members.copyOf, { name: m.specialist }) + (m.specialty ? " (" + m.specialty + ")" : "") : S.members.worker }),
      h("td", { text: toolName(m.tool) }), h("td", { text: (m.skills || []).filter((s) => s.source === "member").map((s) => s.name).join(", ") || S.common.none }),
      h("td", {}, m.working?.length ? m.working.map((r) => h("a.link", { href: "#/run/" + enc(r.runId), text: r.project })) : S.members.idle),
      h("td", {}, removeButton("member", t.name + "/" + (m.member || m.name), "teams/" + enc(t.name) + "/members/" + enc(m.member || m.name) + "/remove", "member-" + t.name + "-" + (m.member || m.name), S.members.remove),
        message("member-" + t.name + "-" + (m.member || m.name)))))) : hint(S.teams.noMembers),
    disclosure("member-add-open", S.members.add, memberForm(t.name, specs, skills), t.name)))) : hint(S.teams.empty),
    projects.length ? disclosure("team-add-open", S.teams.add, teamForm(null, projects)) : hint(S.teams.noProjects));
}
async function member(seq, team, name) {
  const [m, sk] = await Promise.all([api("members/" + enc(team) + "/" + enc(name)), api("skills")]);
  const key = "member-" + team + "-" + name;
  render(seq, crumbs(h("a", { href: "#/teams", text: S.nav.teams }), team, name),
    h("div.headrow", {}, h("h1", { text: fmt(S.wording.helperTeam, { team, member: name }) }), removeButton("member", team + "/" + name,
      "teams/" + enc(team) + "/members/" + enc(name) + "/remove", key, S.members.remove, () => go("#/teams"))),
    hint(S.wording.helperIntro), h("div.kv", {}, [S.members.title, whoText(m), S.members.kind,
      m.specialist ? fmt(S.wording.usesRole, { name: m.specialist, specialty: m.specialty }) : S.members.worker,
      S.common.tool, toolName(m.tool), S.common.timeLimitLabel, limitText(m.timeLimitMinutes ?? 60), S.nav.projects,
      m.projects.join(", ") || S.common.noneAvailable].map((text) => h("div", { text }))),
    heading(S.common.instructions), h("p.fulltask", { text: m.instructions || S.common.none }), message(key),
    disclosure("member-edit-open", S.members.edit, h("div", {}, memberForm(team, [], sk.skills.map((s) => s.name), m), accountSettings("helper", team + "/" + name, m.tool))),
    heading(S.common.skills), hint(S.wording.skillsIntro), m.skills.length ? table([S.common.skills, S.tasks.source], m.skills.map((s) => h("tr", {}, h("td", { text: s.name }), h("td", { text: sourceText(s) })))) : hint(S.wording.noSkills),
    heading(S.members.working), m.working.length ? taskTable(m.working, true) : hint(S.wording.nothingNow), heading(S.members.past), m.runs.some((r) => r.state !== "running") ? taskTable(m.runs.filter((r) => r.state !== "running"), true) : hint(S.wording.noFinished));
}
function readB64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error(S.skills.uploadError));
    reader.readAsDataURL(file);
  });
}
function skillAddForm() {
  const key = "skill-add";
  const form = h("form.stack", { "data-testid": "skill-add-form", onsubmit: (e) => {
    e.preventDefault();
    act(key, form.querySelector("[type=submit]"), async () => { await api("skills", { path: val(form, "skill-path").trim(), name: form.dataset.skillName }); delete form.dataset.skillName; clearForm(form); }, S.common.added);
  } }, folderPicker("skill", S.skills.path), hint(S.skills.hint), submit("skill-save", S.skills.add), message(key));
  return form;
}
function skillUploadForm() {
  const key = "skill-upload";
  const form = h("form.stack", { "data-testid": "skill-upload-form", onsubmit: (e) => {
    e.preventDefault();
    act(key, form.querySelector("[type=submit]"), async () => {
      const input = form.querySelector("[type=file]");
      if (!input.files.length) { tell(key, S.skills.uploadRequired); return; }
      const files = [];
      try { for (const f of input.files) files.push({ path: f.webkitRelativePath || f.name, content: await readB64(f) }); }
      catch (_) { const e = new Error(S.skills.uploadError); e.friendly = true; throw e; }
      await api("skills", { files, name: form.dataset.skillName }); delete form.dataset.skillName; input.value = ""; tell(key, S.common.added, true);
    }, "");
  } }, hint(S.skills.uploadHint), field("skill-upload", S.skills.upload, { type: "file", webkitdirectory: true, multiple: true, required: true }),
    submit("skill-upload-save", S.skills.uploadSave), message(key));
  return form;
}
async function skills(seq) {
  const v = await api("skills");
  render(seq, crumbs(S.nav.skills), heading(S.skills.library), hint(S.wording.helperIntro), hint(S.wording.skillsIntro), v.skills.length ? table([S.common.skills, S.skills.description, S.skills.holders, ""],
    v.skills.map((s) => h("tr", {}, h("td", { text: s.name }), h("td", { text: s.description }),
      h("td", { text: [...s.specialists.map((name) => fmt(S.members.copyOf, { name })), ...s.members.map((ref) => { const [team, member] = ref.split("/"); return fmt(S.wording.helperTeam, { team, member }); })].join(", ") || S.wording.noHolders }),
      h("td", {}, removeButton("skill", s.name, "skills/" + enc(s.name) + "/remove", "skill-" + s.name, S.skills.remove), message("skill-" + s.name))))) : hint(S.skills.empty),
    disclosure("skill-add-open", S.skills.addTitle, skillAddForm()), skillUploadForm(), heading(S.skills.grid), hint(S.skills.gridHint),
    v.grid.rows.length && v.grid.skills.length ? table([S.members.title, S.common.tool, ...v.grid.skills], v.grid.rows.map((r) => h("tr", {},
      h("td", {}, r.kind === "member" ? h("a.link", { href: memberHref(...r.id.split("/")), text: r.label }) : r.label), h("td", { text: toolName(r.tool) }),
      v.grid.skills.map((name) => h("td", { text: r.skills[name] ? (r.skills[name] === "own" ? "●" : "○") : "", title: r.skills[name] ? (r.skills[name] === "own" ? S.skills.own : S.skills.inherited) : "" }))))) : hint(S.wording.skillGridEmpty));
}

async function run(seq, id) {
  const r = await api("runs/" + enc(id));
  const key = "task-" + id;
  const pairs = [S.tasks.task, r.task, S.tasks.state, stateText(r), S.tasks.who, whoText(r), S.common.tool, toolName(r.agent),
    S.accounts.label, r.account?.name || S.accounts.computer,
    S.wording.aiModel, r.model || (r.actualModel ? fmt(S.common.defaultModelUsed, { model: r.actualModel }) : S.common.defaultModel), S.wording.team, r.team || S.common.none, S.members.kind, r.specialist || S.members.worker, S.tasks.started, when(r.startedAt),
    S.tasks.deadline, when(r.deadline)];
  function clean(force = false, deleteBranch = false) {
    const extra = h("label.check", {}, h("input", { type: "checkbox", id: "task-delete-branch", "data-testid": "task-delete-branch", checked: deleteBranch }), " ", S.tasks.deleteBranch);
    showDialog(force ? S.tasks.forceTitle : S.tasks.cleanTitle, [force ? S.tasks.forceEffect : S.tasks.cleanEffect, S.wording.deleteSavedEffect], null, async () => {
      const removeBranch = extra.querySelector("input").checked;
      try { await api("runs/" + enc(id) + "/clean", { force, deleteBranch: removeBranch }); }
      catch (e) {
        // A second explicit confirmation is required before discarding unsaved changes.
        if (!force && e.code === "uncommitted_changes") {
          setTimeout(() => clean(true, removeBranch), 0); throw e;
        }
        throw e;
      }
    }, extra, S.tasks.clean);
  }
  render(seq, crumbs(h("a", { href: "#/project/" + enc(r.project), text: r.project }), S.tasks.task), heading(S.tasks.details), hint(S.wording.helperIntro),
    r.limitHit ? h("div.card", { "data-testid": "task-account-limit" }, h("p", { text: S.accounts.limitMessage }), h("a.link", { href: "#/accounts", text: S.accounts.open })) : null,
    r.autoSaved ? h("p", { "data-testid": "task-auto-saved", text: S.tasks.autoSaved }) : null,
    r.checkpointError ? h("p", { "data-testid": "task-checkpoint-error", text: S.errors[r.checkpointError] }) : null,
    r.reviewStatus === "unsaved" ? h("p", { "data-testid": "task-unsaved", text: S.tasks.unsavedHelp }) : null,
    r.reviewStatus === "unavailable" ? h("p", { "data-testid": "task-workspace-unchecked", text: S.tasks.workspaceUncheckedHelp }) : null,
    h("div.kv", {}, pairs.map((text) => h("div.fulltask", { text })),
      h("div", { text: ${scriptJSON(S.common.timeLimitLabel)} }), h("div", { text: limitText(r.timeLimitMinutes) })),
    h("div.actions", {}, r.state === "running" ? button("task-stop", S.tasks.stop, () => showDialog(S.tasks.stopTitle,
      [fmt(S.tasks.stopEffect, { name: r.runId })], null, () => api("runs/" + enc(id) + "/stop", {}), undefined, S.tasks.stop), { class: "danger" }) :
      !r.cleanedAt ? button("task-clean", S.tasks.clean, () => clean()) : null), message(key),
    disclosure("task-technical", S.wording.technical, h("div.kv", {},
      [S.wording.taskNumber, r.runId, S.tasks.branch, r.branch, S.tasks.folder, r.cleanedAt ? S.tasks.cleaned : r.worktree].map((text) => h("div", { text })))),
    heading(S.tasks.skillsGiven), hint(S.wording.skillsIntro), r.skillsGiven.length ? table([S.common.skills, S.tasks.source, S.skills.description], r.skillsGiven.map((s) => h("tr", {},
      h("td", { text: s.name }), h("td", { text: sourceText(s, r.project) }), h("td", { text: s.description })))) : hint(S.tasks.noSkills),
    heading(S.tasks.skillsUsed), r.skillsUsed.length ? table([S.common.skills, S.tasks.how, S.tasks.evidence], r.skillsUsed.map((s) => h("tr", {},
      h("td", { text: s.name }), h("td", { text: s.how === "guess" ? S.tasks.guess : S.tasks.detected }), h("td", { text: s.evidence })))) : hint(r.agent === "codex" ? S.tasks.codexSkills : r.state === "running" ? S.tasks.noUsed : S.wording.noSkillUse),
    heading(S.tasks.output), h("pre.log", { text: r.log || S.tasks.noOutput }));
}

function go(hash) { if (location.hash === hash) refresh(); else location.hash = hash; }
(function themeSwitch() {
  const sel = document.getElementById("theme");
  const root = document.documentElement;
  sel.value = root.getAttribute("data-theme") || "auto";
  sel.addEventListener("change", () => {
    const value = sel.value;
    if (value === "light" || value === "dark") root.setAttribute("data-theme", value); else root.removeAttribute("data-theme");
    try { if (value === "auto") localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, value); } catch (_) {}
  });
})();
async function refresh() {
  clearTimeout(timer);
  const seq = ++renderSeq;
  if (busy) { timer = setTimeout(refresh, 2000); return; }
  try {
    setupState = await api("setup");
    accountsState = await api("accounts");
    if (seq !== renderSeq) return;
    if (!setupChecked) {
      setupChecked = true;
      if (setupState.shouldOpen && location.hash !== "#/setup") { go("#/setup"); return; }
    }
    const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
    let page = "projects";
    if (parts[0] === "setup") { page = "setup"; await setup(seq); }
    else if (parts[0] === "accounts") { page = "accounts"; await accounts(seq); }
    else if (parts[0] === "project" && parts[1]) await project(seq, parts[1]);
    else if (parts[0] === "run" && parts[1]) await run(seq, parts[1]);
    else if (parts[0] === "teams") { page = "teams"; await teams(seq); }
    else if (parts[0] === "specialists") { page = "specialists"; await specialists(seq); }
    else if (parts[0] === "skills") { page = "skills"; await skills(seq); }
    else if (parts[0] === "member" && parts[1] && parts[2]) { page = "teams"; await member(seq, parts[1], parts[2]); }
    else await home(seq);
    const state = await api("state");
    if (seq !== renderSeq) return;
    for (const a of document.querySelectorAll("nav a")) a.classList.toggle("on", a.dataset.page === page);
    document.getElementById("running").textContent = state.agentsRunning;
    document.getElementById("teamsN").textContent = state.teamsCount;
    document.getElementById("memory").textContent = mem(state.memoryBytes);
    document.getElementById("memory").title = state.memoryBytes == null ? S.wording.memoryMissing : S.wording.memoryHint;
    document.getElementById("err").textContent = "";
  } catch (e) {
    if (seq === renderSeq) tell("connection", errorText(e), false, e);
  } finally { if (seq === renderSeq) timer = setTimeout(refresh, 2000); }
}
window.addEventListener("hashchange", () => {
  messages.clear(); folders.clear(); tracking = null;
  if (dialog.open) closeDialog();
  document.getElementById("err").textContent = ""; refresh();
});
refresh();
</script></body></html>`;
}
