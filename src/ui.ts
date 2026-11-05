/** Self-contained dashboard. API data is inserted only through textContent. */
import { S } from "./strings.js";

export const THEME_KEY = "codec-theme";
export const SIDEBAR_KEY = "codec-sidebar";
const THEME_BOOT = `<script>try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t);if(localStorage.getItem(${JSON.stringify(SIDEBAR_KEY)})==="collapsed")document.documentElement.setAttribute("data-sidebar","collapsed")}catch(e){}</script>`;
const DARK_VARS = `color-scheme: dark;
    --bg: #0f1115; --side: #14171c; --panel: #171a21; --panel2: #1f232c; --text: #e6e8ee; --muted: #8b93a7;
    --border: #2a2f3a; --accent: #8aa6ff; --danger: #f07a6a; --primary: #e6e8ee; --on-primary: #0f1115;
    --working: #4cc38a; --needs: #f07a6a; --review: #e5a54b; --done: #8b93a7;
    --working-bg: #16271f; --needs-bg: #2b1b1b; --review-bg: #2a2216;`;

// JSON is script-safe even if future wording or a token contains markup.
function scriptJSON(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
function textHTML(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderLocked(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Codec</title>
<style>:root{color-scheme:light;--bg:#f6f5f1;--text:#1c1c1a}
@media (prefers-color-scheme: dark){:root{color-scheme:dark;--bg:#0f1115;--text:#e6e6e6}}
body{font:15px system-ui,sans-serif;background:var(--bg);color:var(--text);display:grid;place-items:center;height:100vh;margin:0;padding:24px}</style></head>
<body><div><h2>${textHTML(S.locked.title)}</h2><p>${textHTML(S.locked.hint)}</p></div></body></html>`;
}

// Stroke icons for the sidebar links, drawn on the same 16px grid as icon() in the page script.
const NAV_ICONS: Record<string, string> = {
  home: "M2 7.5 8 2.5l6 5M3.5 6.5v7h9v-7M6.5 13.5v-4h3v4",
  helpers: "M8 1.5v2M4 5.5h8a1.5 1.5 0 0 1 1.5 1.5v4.5A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 4 5.5zM6 9h.01M10 9h.01",
  projects: "M1.5 4.5A1.5 1.5 0 0 1 3 3h3l1.5 1.5H13a1.5 1.5 0 0 1 1.5 1.5v5.5A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5z",
  teams: "M6 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM1.5 13.5c.4-2.4 2.2-3.8 4.5-3.8s4.1 1.4 4.5 3.8M11 2.7a2.5 2.5 0 0 1 0 4.6M12.5 9.9c1 .6 1.8 1.9 2 3.6",
  specialists: "M8 1.5l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.3l-3.8 2 .7-4.3-3.1-3 4.3-.6z",
  skills: "M3 2.5h7.5A2.5 2.5 0 0 1 13 5v8.5H5.5A2.5 2.5 0 0 1 3 11zM3 11a2.5 2.5 0 0 1 2.5-2.5H13",
  chat: "M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z",
  collapse: "M2.5 2.5h11v11h-11zM6 2.5v11M10.5 6 8.5 8l2 2",
  accounts: "M10.5 8.5a3 3 0 1 0-2.9-2.2L2.5 11.5v2h2v-1.5H6v-1.5h1.5l1.2-1.2c.5.2 1.1.2 1.8.2zM11 4.5h.01",
  setup: "M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4",
};
function navIcon(name: string): string {
  return `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="${NAV_ICONS[name]}"/></svg>`;
}
export function renderPage(token: string): string {
  return String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Codec</title>
${THEME_BOOT}
<style>
:root {
  color-scheme: light;
  --bg: #f6f5f1; --side: #ecebe6; --panel: #ffffff; --panel2: #f0efea; --text: #1c1c1a; --muted: #6b6a65;
  --border: #e0ded7; --accent: #2d5bb5; --danger: #a8322d; --primary: #1c1c1a; --on-primary: #ffffff;
  --working: #2e6b4e; --needs: #a8322d; --review: #9a5b00; --done: #6b6a65;
  --working-bg: #e7f0ea; --needs-bg: #faeeec; --review-bg: #fbf2e6;
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
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; display: grid; grid-template-columns: 176px minmax(0, 1fr); min-height: 100vh; }
a { color: inherit; text-decoration: none; }
/* The header is the left sidebar: brand, navigation, live counts and theme. */
header { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; gap: 4px; padding: 18px 8px 14px; background: var(--side); border-right: 1px solid var(--border); overflow-y: auto; }
header .brand { display: flex; align-items: center; justify-content: space-between; gap: 4px; margin: 0 0 14px 10px; }
header h1 { font-size: 16px; margin: 0; }
.sidetoggle { display: grid; place-items: center; padding: 5px; border: 0; background: none; color: var(--muted); cursor: pointer; }
.sidetoggle:hover { color: var(--text); background: var(--panel); }
/* Collapsed: an icon rail. Wide windows only; the phone layout is a top bar. */
@media (min-width: 761px) {
  :root[data-sidebar="collapsed"] body:not(.full) { grid-template-columns: 52px minmax(0, 1fr); }
  :root[data-sidebar="collapsed"] header .brand { flex-direction: column; margin: 0 0 14px; }
  :root[data-sidebar="collapsed"] header h1, :root[data-sidebar="collapsed"] nav a span, :root[data-sidebar="collapsed"] header .stat,
  :root[data-sidebar="collapsed"] header .theme, :root[data-sidebar="collapsed"] header .profile .who { display: none; }
  :root[data-sidebar="collapsed"] nav a { justify-content: center; padding: 8px 0; }
  :root[data-sidebar="collapsed"] .sidetoggle svg { transform: scaleX(-1); }
  :root[data-sidebar="collapsed"] header .foot { padding: 14px 0 0; align-items: center; }
  :root[data-sidebar="collapsed"] header .profile { margin: 12px 0 0; padding: 6px; border-top: 0; border-radius: 50%; }
}
nav { display: flex; flex-direction: column; gap: 2px; }
nav a { display: flex; align-items: center; gap: 8px; padding: 6px 10px; color: var(--muted); }
nav a:hover { color: var(--text); }
nav a { border-radius: 6px; }
nav a:hover { background: color-mix(in srgb, var(--text) 5%, var(--side)); }
nav a.on { background: color-mix(in srgb, var(--text) 11%, var(--side)); color: var(--text); font-weight: 600; box-shadow: inset 3px 0 0 var(--accent); }
header .foot { margin-top: auto; display: flex; flex-direction: column; gap: 4px; padding: 14px 10px 0; font-size: 12px; }
header .stat { color: var(--muted); }
header .stat b { color: var(--text); margin-right: 4px; }
header .theme { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
header .theme select { padding: 3px 6px; font-size: 12px; }
header .profile { display: flex; align-items: center; gap: 10px; margin: 12px -4px 0; padding: 8px; border-top: 1px solid var(--border); }
header .profile:hover { background: color-mix(in srgb, var(--text) 5%, var(--side)); }
header .profile.on { background: color-mix(in srgb, var(--text) 11%, var(--side)); }
header .profile .who { display: flex; flex-direction: column; min-width: 0; }
header .profile b { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.avatar { width: 30px; height: 30px; border-radius: 50%; background: var(--primary); color: var(--on-primary); display: grid; place-items: center; font-size: 12px; font-weight: 600; flex: none; }
.avatar svg { width: 16px; height: 16px; display: block; }
/* Full-window pages (Profile) hide the app sidebar but keep the connection message. */
body.full { grid-template-columns: minmax(0, 1fr); }
body.full header { display: contents; }
body.full header > :not(.err) { display: none; }
#app:has(> .settings) { padding: 0; max-width: none; }
.settings { display: grid; grid-template-columns: 240px minmax(0, 720px); gap: 48px; max-width: 1060px; margin: 0 auto; padding: 72px 32px 48px; }
.settings-nav { display: flex; flex-direction: column; gap: 4px; align-self: start; }
.settings-nav a { display: flex; align-items: center; gap: 12px; padding: 10px 14px; color: var(--muted); font-weight: 500; }
.settings-nav a:hover { color: var(--text); }
.settings-nav a.on { background: var(--panel); color: var(--text); box-shadow: 0 1px 2px #00000012; }
.settings-nav a.back { font-size: 13px; font-weight: 400; margin-bottom: 12px; }
.icon { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.settings-body h1 { font: 400 30px/1.2 Georgia, "Times New Roman", serif; }
.settings-body h2 { margin: 0; }
.settings-body .lede { color: var(--muted); margin: 6px 0 0; }
.settings-body hr { border: 0; border-top: 1px solid var(--border); margin: 24px 0; }
.settings-form { display: flex; flex-direction: column; gap: 18px; align-items: flex-start; }
.settings-form hr { align-self: stretch; margin: 6px 0; }
.settings-form label.field, .settings-form p { width: min(100%, 540px); }
.settings label.field > span:first-child { font: 500 12px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .06em; text-transform: uppercase; }
.settings input { padding: 10px 14px; }
button.savebtn::before { content: "✓"; }
.signins { margin: 16px 0 12px; }
header .err { position: fixed; right: 16px; bottom: 16px; max-width: min(420px, calc(100vw - 32px)); background: var(--panel); color: var(--danger); border: 1px solid var(--border); padding: 10px 14px; box-shadow: 0 6px 24px #0000001f; z-index: 5; font-size: 13px; }
header .err:empty { display: none; }
main { min-width: 0; }
#app { padding: 28px 32px 48px; max-width: 1400px; }
#app:has(> .split) { padding: 0; max-width: none; }
h1 { font-size: 22px; margin: 0; font-weight: 600; }
h2 { font-size: 15px; margin: 26px 0 10px; font-weight: 600; }
.crumbs { color: var(--muted); margin-bottom: 8px; }
.crumbs a:hover { color: var(--accent); }
.card { background: var(--panel); border: 1px solid var(--border); padding: 12px 14px; display: block; }
a.card:hover { border-color: var(--muted); }
.card .title { font-weight: 600; font-size: 15px; }
.card .sub { color: var(--muted); font-size: 12px; word-break: break-all; }
table { width: 100%; border-collapse: separate; border-spacing: 0; background: var(--panel); border: 1px solid var(--border); overflow: hidden; }
th, td { text-align: left; padding: 9px 14px; border-bottom: 1px solid var(--border); vertical-align: middle; }
tbody tr:last-child td { border-bottom: 0; }
th { color: var(--muted); font-weight: 500; font-size: 13px; }
tr.click { cursor: pointer; } tr.click:hover td { background: var(--panel2); }
td.task { max-width: 480px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.state { font-weight: 600; }
.state.running { color: var(--working); } .state.timed_out, .state.failed, .state.stopped { color: var(--needs); } .state.done { color: var(--done); }
.board { display: grid; grid-template-columns: repeat(4, minmax(160px, 1fr)); gap: 14px; align-items: start; }
.lane { min-height: 120px; }
.lane h3 { margin: 0 2px 10px; font-size: 14px; font-weight: 500; color: var(--muted); display: flex; align-items: center; gap: 7px; }
.lane h3::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--done); flex: none; }
.lane.working h3::before { background: var(--working); } .lane.needsYou h3::before { background: var(--needs); }
.lane.inReview h3::before { background: var(--review); }
.lane .card { margin-bottom: 10px; }
.lane .task { margin: 4px 0; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.lanecard.needsYou { border-color: color-mix(in srgb, var(--needs) 45%, var(--border)); }
.lanecard.inReview { border-color: color-mix(in srgb, var(--review) 45%, var(--border)); }
.empty { color: var(--muted); font-size: 12px; padding: 4px; }
form.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; background: var(--panel); border: 1px solid var(--border); padding: 10px; }
input, select, textarea { font: inherit; color: var(--text); background: var(--panel); border: 1px solid var(--border); padding: 7px 10px; }
input[type=text] { flex: 1; min-width: 200px; }
textarea { flex: 1; min-width: 260px; min-height: 38px; resize: vertical; }
button, a.btn { font: inherit; display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border); background: var(--panel); color: var(--text); padding: 7px 14px; cursor: pointer; }
button:hover, a.btn:hover { border-color: var(--muted); }
button.primary, a.btn.primary { background: var(--primary); border-color: var(--primary); color: var(--on-primary); }
button.danger { color: var(--danger); }
button:disabled { opacity: .5; cursor: default; }
.kv { display: grid; grid-template-columns: 120px 1fr; gap: 6px 14px; background: var(--panel); border: 1px solid var(--border); padding: 14px; }
.kv div:nth-child(odd) { color: var(--muted); word-break: normal; overflow-wrap: normal; }
.kv div { word-break: break-all; }
.fulltask { white-space: pre-wrap; word-break: normal; }
pre.log { background: #0b0d11; color: #d6dae3; padding: 14px; max-height: 60vh; overflow: auto; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-all; margin: 0; }
.actions { display: flex; gap: 8px; margin: 12px 0; flex-wrap: wrap; }
.headrow { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.muted { color: var(--muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
a.link { color: var(--accent); } a.link:hover { text-decoration: underline; }
.stackcards { display: flex; flex-direction: column; gap: 12px; }
.card.block { padding: 14px 16px; }
.card.block .sub { margin: 2px 0 10px; }
table.inner { margin: 8px 0; }
details { margin-top: 8px; } summary { cursor: pointer; color: var(--accent); }
form.stack { display: flex; flex-direction: column; gap: 8px; background: var(--panel); border: 1px solid var(--border); padding: 12px; margin-top: 8px; }
.row2 { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.checks { display: inline-flex; flex-wrap: wrap; gap: 4px 14px; }
label.check { cursor: pointer; white-space: nowrap; }
button.small { padding: 3px 10px; font-size: 12px; }
.actions.tight { margin: 0; }
.kv.compact { grid-template-columns: 100px 1fr; padding: 10px; margin-top: 6px; }
table.grid2 th.c, table.grid2 td.c { text-align: center; }
.dot.own { color: var(--done); } .dot.via { color: var(--review); }
.row.top { margin-top: 8px; }
label.field { display: flex; flex-direction: column; gap: 4px; min-width: 180px; }
label.field textarea { min-height: 120px; width: 100%; }
.hint { color: var(--muted); font-size: 12px; }
#app > .hint, .pane > .hint { display: block; margin: 4px 0; }
.message { white-space: pre-wrap; color: var(--danger); margin: 6px 0; }
.message:empty { display: none; }
[hidden] { display: none !important; }
.message.success { color: var(--working); }
.folder-panel { border: 1px solid var(--border); padding: 12px; margin-top: 8px; }
.folder-list { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; margin: 8px 0; max-height: 260px; overflow: auto; }
.folder-current { overflow-wrap: anywhere; }
dialog { background: var(--panel); color: var(--text); border: 1px solid var(--border); width: min(600px, 94vw); padding: 24px; }
dialog::backdrop { background: #0008; }
dialog h2 { margin-top: 0; }
.setup-tool { margin: 12px 0; }
.fix { white-space: pre-wrap; overflow-wrap: anywhere; padding: 12px; background: var(--panel2); user-select: all; }
button:focus-visible, a:focus-visible, summary:focus-visible, tr:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.table-scroll { overflow-x: auto; }
/* Full-height pages: a top bar across, then columns (list | main | side panel). */
.split { display: grid; grid-template-rows: auto 1fr; min-height: 100vh; }
.split.helpers { grid-template-columns: minmax(0, 1fr) 340px; }
.split.projects { grid-template-columns: 280px minmax(0, 1fr) 300px; }
.split.projects.index { grid-template-columns: 280px minmax(0, 1fr); }
.topbar { grid-column: 1 / -1; min-height: 73px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 18px 32px; background: var(--panel); border-bottom: 1px solid var(--border); }
.topactions { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; }
.pane { padding: 24px 32px 48px; min-width: 0; }
.pane > h2:first-child { margin-top: 0; }
.detail { background: var(--panel); border-left: 1px solid var(--border); padding: 24px; display: flex; flex-direction: column; min-width: 0; }
.detail h2 { margin: 22px 0 8px; font-size: 14px; }
.detail .who h2 { margin: 0; font-size: 18px; }
.plainlist { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
.plist { padding: 20px 16px; border-right: 1px solid var(--border); background: color-mix(in srgb, var(--panel) 45%, var(--bg)); display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.plist .label { color: var(--muted); font-size: 13px; padding: 0 4px; }
.pcard .sub { word-break: normal; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.detail .path { overflow-wrap: anywhere; }
.pcard.on { border-color: var(--muted); box-shadow: 0 1px 3px #00000014; }
.bar { height: 6px; background: var(--panel2); overflow: hidden; margin: 10px 0 6px; }
.bar i { display: block; height: 100%; background: var(--working); }
.bar.needsYou i { background: var(--needs); } .bar.inReview i { background: var(--review); }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { font-size: 13px; padding: 3px 11px; background: var(--panel2); border: 1px solid transparent; color: var(--text); }
.chip:hover { border-color: var(--border); }
.chip.on { background: var(--primary); color: var(--on-primary); }
.chip.working { background: var(--working-bg); color: var(--working); } .chip.needsYou { background: var(--needs-bg); color: var(--needs); }
.stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 20px; }
.statcard { background: var(--panel); border: 1px solid var(--border); padding: 14px 16px; }
.statcard span { display: block; color: var(--muted); font-size: 13px; }
.statcard b { display: block; font-size: 26px; font-weight: 600; margin-top: 2px; }
.statcard.inReview b { color: var(--review); } .statcard.needsYou b { color: var(--needs); }
.status { display: inline-flex; align-items: center; gap: 7px; font-weight: 500; }
.status::before { content: ""; width: 9px; height: 9px; border-radius: 50%; background: currentColor; flex: none; }
.status.working { color: var(--working); }
.status.inReview { color: var(--review); } .status.inReview::before { background: linear-gradient(90deg, currentColor 50%, transparent 50%); box-shadow: inset 0 0 0 1.5px currentColor; }
.status.needsYou { color: var(--needs); } .status.needsYou::before { border-radius: 0; clip-path: polygon(50% 0, 100% 100%, 0 100%); }
.status.idle { color: var(--muted); } .status.idle::before { background: none; box-shadow: inset 0 0 0 1.5px currentColor; }
table.helpers .name { font-weight: 600; }
table.helpers td.now { min-width: 200px; max-width: 360px; }
table.helpers .status, table.helpers td.nowrap { white-space: nowrap; }
table.helpers tr.on td { background: var(--panel2); }
table.helpers tr.alert td { background: var(--needs-bg); }
.callout { border: 1px solid var(--border); padding: 14px; margin-top: 16px; }
.callout b { display: block; }
.callout p { margin: 4px 0 12px; overflow-wrap: anywhere; }
.callout .actions { margin: 0; }
.callout.working { background: var(--working-bg); border-color: color-mix(in srgb, var(--working) 30%, transparent); } .callout.working b { color: var(--working); }
.callout.needsYou { background: var(--needs-bg); border-color: color-mix(in srgb, var(--needs) 30%, transparent); } .callout.needsYou b { color: var(--needs); }
.callout.inReview { background: var(--review-bg); border-color: color-mix(in srgb, var(--review) 30%, transparent); } .callout.inReview b { color: var(--review); }
.activity { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.activity li { overflow-wrap: anywhere; }
.activity li.working:last-child { color: var(--working); } .activity li.needsYou:last-child { color: var(--needs); } .activity li.inReview:last-child { color: var(--review); }
.compose { margin-top: auto; padding-top: 20px; display: flex; flex-direction: column; gap: 8px; }
.compose input[type=text] { min-width: 0; }
/* Home: greeting, teams beside what needs you, then the week's tasks. */
.homehead { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
.homehead h1 { font-size: 28px; }
.homehead p { margin: 4px 0 0; color: var(--muted); }
.home { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 16px; align-items: start; }
.home > .wide { grid-column: 1 / -1; }
.panel { background: var(--panel); border: 1px solid var(--border); padding: 18px 20px; min-width: 0; }
.panel h2 { margin: 0; font-size: 16px; }
.panel > .headrow { margin-bottom: 12px; }
a.teamrow { display: block; padding: 14px 0 12px; border-top: 1px solid var(--border); }
a.teamrow:hover .tname { text-decoration: underline; }
.teamrow .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.teamrow .tname { font-weight: 600; }
.teamrow .counts { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 2px 12px; font-size: 13px; }
.teamrow p { margin: 8px 0 0; }
.notes { display: flex; flex-direction: column; gap: 10px; margin-top: 14px; }
.note { display: block; border: 1px solid var(--border); padding: 10px 12px; }
a.note:hover { border-color: var(--muted); }
.note.urgent { border-color: var(--text); }
.note b { display: block; font-weight: 600; }
.note span { display: block; font-size: 13px; color: var(--muted); overflow-wrap: anywhere; }
.note.needsYou b { color: var(--needs); } .note.inReview b { color: var(--review); }
.week { display: grid; grid-template-columns: repeat(7, minmax(64px, 1fr)); gap: 8px; margin: 14px 0 8px; overflow-x: auto; }
button.day { flex-direction: column; justify-content: center; gap: 0; padding: 10px 4px; }
button.day span { color: var(--muted); font-size: 13px; }
button.day b { font-size: 20px; font-weight: 600; }
button.day small { color: var(--muted); font-size: 11px; min-height: 1.4em; }
button.day.today span, button.day.on small { color: var(--text); font-weight: 600; }
button.day.on { border: 2px solid var(--text); padding: 9px 3px; }
table.due { border: 0; }
table.due td { padding: 10px 12px 10px 0; }
table.due tr:first-child td { border-top: 1px solid var(--border); }
/* Chat: a full-height column. Top bar, scrolling messages, then the composer. */
#app:has(> .chatpage) { padding: 0; max-width: none; }
.chatpage { display: flex; flex-direction: column; height: 100vh; }
.pill { border: 1px solid var(--border); border-radius: 999px; padding: 5px 14px; background: var(--panel2); color: var(--text); font-size: 13px; }
select.pill { color: var(--accent); font-weight: 500; cursor: pointer; }
.chatlog { flex: 1; overflow-y: auto; padding: 16px 28px 24px; }
.chatlog > * { max-width: 920px; margin-left: auto; margin-right: auto; }
.chatempty { padding: 32px 0; } .chatempty h2 { margin: 0 0 6px; font-size: 18px; } .chatempty p { margin: 0; color: var(--muted); }
.msg { display: grid; grid-template-columns: 30px minmax(0, 1fr); column-gap: 14px; padding: 14px 0 6px; }
.msg .avatar { width: 30px; height: 30px; background: var(--panel2); color: var(--muted); border: 1px solid var(--border); font-size: 12px; }
.msg.assistant .avatar { background: var(--review-bg); color: var(--review); border-color: color-mix(in srgb, var(--review) 30%, transparent); }
.msg .meta { display: flex; align-items: center; gap: 12px; min-height: 30px; }
.msg .meta b { font-weight: 600; } .msg.assistant .meta b { color: var(--review); }
.msg .meta time { color: var(--muted); font-size: 12px; }
.msg .meta .copy { margin-left: auto; border: 0; background: none; color: var(--muted); padding: 4px; opacity: 0; }
.msg:hover .meta .copy, .msg .meta .copy:focus-visible { opacity: 1; } .msg .meta .copy:hover { color: var(--text); }
.msg .body { grid-column: 2; font-size: 15px; line-height: 1.6; overflow-wrap: anywhere; }
.msg .body > :first-child { margin-top: 4px; } .msg .body > :last-child { margin-bottom: 0; }
.msg .body p, .msg .body ul, .msg .body ol, .msg .body pre { margin: 0 0 12px; }
.msg .body li { margin: 3px 0; }
.msg .body h3 { font-size: 16px; margin: 16px 0 8px; }
.msg .body code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--panel2); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; color: var(--review); }
.msg .body pre { background: var(--panel2); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; overflow-x: auto; }
.msg .body pre code { background: none; border: 0; padding: 0; color: var(--text); }
.msg .body a { color: var(--accent); text-decoration: underline; }
.msg.error .body { color: var(--needs); }
.msg .typing { display: inline-flex; gap: 4px; padding: 10px 0; }
.msg .typing i { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); animation: typing 1.2s infinite ease-in-out; }
.msg .typing i:nth-child(2) { animation-delay: .2s; } .msg .typing i:nth-child(3) { animation-delay: .4s; }
@keyframes typing { 0%, 80%, 100% { opacity: .25; } 40% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .msg .typing i { animation: none; opacity: .6; } }
.chatform { flex: none; padding: 0 28px 20px; }
.composer { max-width: 920px; margin: 0 auto; background: var(--panel); border: 1px solid var(--border); border-radius: 16px; padding: 12px 14px 10px; box-shadow: 0 1px 3px #00000010; }
.composer:focus-within { border-color: var(--muted); }
.composer textarea { display: block; width: 100%; border: 0; background: none; padding: 4px 6px; min-height: 48px; max-height: 40vh; resize: none; font-size: 15px; outline: none; }
.composer .row { display: flex; align-items: center; gap: 8px; margin-top: 6px; flex-wrap: wrap; }
.composer .row .hint { margin-left: auto; }
.composer .row button { border-radius: 999px; padding: 6px 16px; }
.composer .row .pill { padding: 4px 12px; font-size: 13px; }
.composer select.pill { max-width: 200px; }
.chatform .message { max-width: 920px; margin-left: auto; margin-right: auto; }
table.due td:first-child { font-weight: 600; white-space: nowrap; }
@media (max-width: 1100px) {
  .home { grid-template-columns: minmax(0, 1fr); }
  .split.helpers, .split.projects, .split.projects.index { grid-template-columns: minmax(0, 1fr); }
  .detail { border-left: 0; border-top: 1px solid var(--border); }
  .plist { border-right: 0; border-bottom: 1px solid var(--border); }
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .board { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 760px) {
  body { grid-template-columns: minmax(0, 1fr); }
  header { position: static; height: auto; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 12px 16px; border-right: 0; border-bottom: 1px solid var(--border); }
  header .brand { margin: 0 8px 0 0; }
  .sidetoggle { display: none; }
  nav { flex-direction: row; flex-wrap: wrap; }
  header .foot { margin-top: 0; flex-direction: row; flex-wrap: wrap; gap: 4px 12px; padding: 0; width: 100%; }
  header .theme { margin-top: 0; }
  #app { padding: 16px; } .topbar, .pane, .detail { padding: 16px; }
  .settings { grid-template-columns: minmax(0, 1fr); gap: 24px; padding: 24px 16px; }
  .board { grid-template-columns: 1fr; }
  .split { min-height: 0; }
  .chatpage { height: auto; min-height: calc(100dvh - 120px); }
  .chatlog { padding-left: 16px; padding-right: 16px; }
  .composer .row .hint { display: none; } .composer .row button.primary { margin-left: auto; }
  .chatform { position: sticky; bottom: 0; padding: 8px 16px 12px; background: var(--bg); }
}
</style></head><body>
<header>
<div class="brand"><h1><a href="#/">Codec</a></h1><button type="button" class="sidetoggle" id="sidetoggle" data-testid="sidebar-toggle" aria-label="${textHTML(S.nav.collapse)}" title="${textHTML(S.nav.collapse)}" aria-expanded="true">${navIcon("collapse")}</button></div>
<nav>
<a href="#/" data-page="home" title="${textHTML(S.nav.home)}" data-testid="nav-home">${navIcon("home")}<span>${textHTML(S.nav.home)}</span></a>
<a href="#/chat" data-page="chat" title="${textHTML(S.nav.chat)}" data-testid="nav-chat">${navIcon("chat")}<span>${textHTML(S.nav.chat)}</span></a>
<a href="#/helpers" data-page="helpers" title="${textHTML(S.nav.helpers)}" data-testid="nav-helpers">${navIcon("helpers")}<span>${textHTML(S.nav.helpers)}</span></a>
<a href="#/projects" data-page="projects" title="${textHTML(S.nav.projects)}" data-testid="nav-projects">${navIcon("projects")}<span>${textHTML(S.nav.projects)}</span></a>
<a href="#/teams" data-page="teams" title="${textHTML(S.nav.teams)}" data-testid="nav-teams">${navIcon("teams")}<span>${textHTML(S.nav.teams)}</span></a>
<a href="#/specialists" data-page="specialists" title="${textHTML(S.nav.specialists)}" data-testid="nav-specialists">${navIcon("specialists")}<span>${textHTML(S.nav.specialists)}</span></a>
<a href="#/skills" data-page="skills" title="${textHTML(S.nav.skills)}" data-testid="nav-skills">${navIcon("skills")}<span>${textHTML(S.nav.skills)}</span></a>
<a href="#/accounts" data-page="accounts" title="${textHTML(S.nav.accounts)}" data-testid="nav-accounts">${navIcon("accounts")}<span>${textHTML(S.nav.accounts)}</span></a>
</nav>
<div class="foot">
<span class="stat"><b id="teamsN">–</b>${textHTML(S.common.teamCount)}</span>
<span class="stat"><b id="running" title="${textHTML(S.wording.aiHelper)}">–</b>${textHTML(S.common.running)}</span>
<span class="stat" title="${textHTML(S.wording.memoryHint)}"><b id="memory">–</b>${textHTML(S.common.memory)}</span>
<label class="theme muted">${textHTML(S.theme.label)}
<select id="theme" data-testid="theme" aria-label="${textHTML(S.theme.label)}">
<option value="auto">${textHTML(S.theme.auto)}</option>
<option value="light">${textHTML(S.theme.light)}</option>
<option value="dark">${textHTML(S.theme.dark)}</option>
</select></label>
<a href="#/profile" class="profile" id="profile-link" data-testid="profile-open" title="${textHTML(S.profile.open)}">
<span class="avatar" aria-hidden="true"><span id="avatar-icon"><svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="5.5" r="3"/><path d="M2 14.5c0-3 2.7-5 6-5s6 2 6 5z"/></svg></span><span id="avatar-initials"></span></span>
<span class="who"><b id="profile-name">${textHTML(S.profile.title)}</b><span class="muted" id="profile-sub" hidden>${textHTML(S.profile.title)}</span></span>
</a>
</div>
<span class="err" id="err" role="status" data-testid="connection-message" data-message-key="connection"></span>
</header>
<main id="app"></main>
<dialog id="confirm" data-testid="confirm-dialog" aria-labelledby="confirm-title"></dialog>
<script>
"use strict";
const S = ${scriptJSON(S)};
const TOKEN = ${scriptJSON(token)};
const THEME_KEY = ${JSON.stringify(THEME_KEY)};
const SIDEBAR_KEY = ${JSON.stringify(SIDEBAR_KEY)};
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
let helperTeam = "";
let helperPick = "";
let homeDay = "";
let homeMode = "calendar";
let projectAddOpen = false;
let profileReturn = "#/";
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
function disclosure(id, title, child, key, open) {
  return h("details", { id: id + (key ? "-" + key : ""), "data-key": key, open },
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
    e?.code === "tool_unavailable" || e?.code === "spawn_failed" || e?.code === "identity_missing" ? h("a.link", { href: "#/profile/setup", text: S.nav.setup }) : null,
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
function crumbs(...items) { return h("div.crumbs", {}, h("a", { href: "#/projects", text: S.nav.projects }), items.map((x) => [" / ", x])); }
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
  const log = app.querySelector("pre.log, .chatlog");
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
  const log = app.querySelector("pre.log, .chatlog");
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

// Shared by Setup (a card) and the profile's Info tab (plain, under the page heading).
function identityForm(settings, plain = false) {
  const form = h(plain ? "form.settings-form" : "form.stack", { "data-testid": "identity-form", onsubmit: (e) => {
    e.preventDefault(); act("identity", e.submitter, async () => {
      await api("settings", { identity: { name: val(form, "identity-name"), email: val(form, "identity-email") } });
    });
  } }, plain ? null : h("h3", { text: S.setup.identity }), plain ? null : hint(S.setup.identityHint),
    setupState.identityReady ? null : h("p", { "data-testid": "identity-missing", text: S.setup.identityMissing }),
    field("identity-name", S.setup.identityName, { value: settings.identity.name, required: true, autocomplete: "name" }),
    field("identity-email", S.setup.identityEmail, { value: settings.identity.email, required: true, type: "email", autocomplete: "email" }),
    plain ? h("hr") : null,
    plain ? h("button.savebtn", { type: "submit", "data-testid": "identity-save", text: S.profile.saveChanges }) : submit("identity-save", S.common.save),
    message("identity"));
  return form;
}
// Builds stroke icons. SVG needs its own namespace, so h() can't make them; the
// namespace is read from the sidebar's avatar icon to keep URLs out of the page.
function icon(name) {
  const paths = { user: "M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2.5 14.5c.5-2.8 2.7-4.5 5.5-4.5s5 1.7 5.5 4.5", back: "M10 3 5 8l5 5",
    accounts: "M10.5 8.5a3 3 0 1 0-2.9-2.2L2.5 11.5v2h2v-1.5H6v-1.5h1.5l1.2-1.2c.5.2 1.1.2 1.8.2zM11 4.5h.01",
  setup: "M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" };
  const ns = document.querySelector("#avatar-icon svg").namespaceURI;
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("class", "icon"); svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", paths[name]);
  svg.append(path);
  return svg;
}
function toolCards(okText = S.setup.ok) {
  return setupState.tools.map((t) => {
    const fix = t.fix || S.setup.fixMissing;
    return h("section.card.setup-tool", { "data-testid": "setup-tool", "data-key": t.tool },
      h("h3", { text: toolName(t.tool) }), h("p", { text: toolOK(t.tool) ? okText : toolProblem(t.tool) }),
      t.version ? h("span.muted", { text: t.version }) : null,
      toolOK(t.tool) ? null : h("div", {}, h("pre.fix", { "data-testid": "setup-fix", text: fix }),
        button("setup-copy", S.common.copy, async () => {
          try { await navigator.clipboard.writeText(fix); tell("setup-" + t.tool, S.common.copied, true); }
          catch (_) { tell("setup-" + t.tool, S.common.copyFailed); }
        }, { "data-key": t.tool }), message("setup-" + t.tool)));
  });
}
// The profile's Setup tab: the first-run checklist, also opened automatically until setup is finished.
function setupTab(settings) {
  const working = setupState.tools.filter((t) => toolOK(t.tool));
  const needed = [];
  if (!setupState.ready) needed.push(S.setup.notReady);
  if (!setupState.identityReady) needed.push(S.setup.identityNeeded);
  const status = needed.length ? needed.join(" ") : working.length === 1
    ? fmt(S.setup.oneReady, { tool: toolName(working[0].tool) }) : S.setup.ready;
  return h("div", { "data-testid": "setup-wizard" },
    h("p", { "data-testid": "setup-status", text: status }), identityForm(settings), toolCards(),
    button("setup-check", S.setup.check, (e) => act("setup", e.currentTarget, async () => { setupState = await api("setup?fresh=1"); }, "")),
    button("setup-continue", S.setup.continue, (e) => act("setup", e.currentTarget, async () => { await api("settings", { setupFinished: true }); go("#/"); }, ""), { disabled: !setupState.ready }),
    button("setup-skip", S.setup.skip, (e) => act("setup", e.currentTarget, async () => { await api("settings", { setupFinished: true }); go("#/"); }, "")), message("setup"));
}
// Each profile tab is [key, label, icon, description, renderer]; add more tabs here.
function profileTabs() {
  return [["info", S.profile.info, "user", S.profile.infoHint, profileInfo], ["setup", S.nav.setup, "setup", S.setup.hint, setupTab]];
}
function profileInfo(settings) {
  return [identityForm(settings, true), h("hr"), h("h2", { text: S.profile.signIns }), h("p.lede", { text: S.profile.signInsHint }),
    h("div.signins", {}, toolCards(S.profile.signedIn)),
    button("profile-check", S.profile.recheck, (e) => act("profile-check", e.currentTarget, async () => { setupState = await api("setup?fresh=1"); }, "")),
    message("profile-check")];
}
// A full-window page: its own section list on the left instead of the app sidebar.
async function profile(seq, tab) {
  const settings = await api("settings");
  const tabs = profileTabs();
  const [key, title, , lede, paint] = tabs.find(([k]) => k === tab) || tabs[0];
  render(seq, h("div.settings", {},
    h("nav.settings-nav", { "aria-label": S.profile.tabs },
      h("a.back", { href: profileReturn, "data-testid": "profile-back" }, icon("back"), S.profile.back),
      tabs.map(([k, text, name]) => h("a" + (k === key ? ".on" : ""), { href: "#/profile/" + k, "aria-current": k === key ? "page" : undefined,
        "data-testid": "profile-tab", "data-key": k }, icon(name), text))),
    h("section.settings-body", { "data-testid": "profile-" + key }, h("h1", { text: title }), h("p.lede", { text: lede }), h("hr"), paint(settings))));
}
function initials(name) {
  return (name || "").trim().split(/\s+/).filter(Boolean).slice(0, 2).map((word) => [...word][0]).join("").toUpperCase();
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
function ago(iso) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!iso || !Number.isFinite(minutes)) return S.common.unknown;
  if (minutes < 1) return S.time.now;
  if (minutes < 60) return fmt(S.time.minutes, { count: minutes });
  if (minutes < 1440) return fmt(S.time.hours, { count: Math.round(minutes / 60) });
  return fmt(S.time.days, { count: Math.round(minutes / 1440) });
}
// One row per team helper, plus quick helpers whose task still needs attention. Runs arrive newest first.
function helperRows(teamList, runs) {
  const rows = [];
  for (const t of teamList) for (const m of t.members) {
    const name = m.member || m.name;
    const mine = runs.filter((r) => r.team === t.name && r.member === name);
    rows.push({ key: t.name + "/" + name, name, team: t.name, tool: m.tool, broken: !!m.error, projects: m.projects || t.projects,
      sub: m.error ? S.helpers.broken : m.specialty || S.members.worker, href: memberHref(t.name, name),
      run: mine.find((r) => r.state === "running") || mine[0] });
  }
  for (const r of runs) if (!r.team && r.lane !== "done") rows.push({ key: "run:" + r.runId, name: S.helpers.quick, tool: r.agent, quick: true,
    projects: [r.project], sub: toolName(r.agent), href: "#/run/" + enc(r.runId), run: r });
  return rows;
}
function helperStatus(row) {
  if (row.broken) return ["needsYou", S.helpers.broken];
  const lane = row.run?.lane;
  return lane === "working" || lane === "needsYou" || lane === "inReview" ? [lane, LANES.find(([k]) => k === lane)[1]] : ["idle", S.members.idle];
}
function pickHelper(key) { helperPick = key; refresh(); }
function helperTable(rows, picked) {
  return h("div.table-scroll", {}, h("table.helpers", {}, h("thead", {}, h("tr", {}, [S.helpers.helper, S.tasks.state, S.helpers.current, S.tasks.project, S.tasks.started].map((t) => h("th", { text: t })))),
    h("tbody", {}, rows.map((row) => {
      const [k, text] = helperStatus(row);
      const active = k !== "idle" && row.run;
      return h("tr.click" + (row === picked ? ".on" : "") + (k === "needsYou" ? ".alert" : ""), { "data-testid": "helper-row", "data-key": row.key, tabindex: "0",
        "aria-selected": String(row === picked), onclick: () => pickHelper(row.key),
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickHelper(row.key); } } },
      h("td", {}, h("div.name", { text: row.name }), h("div.hint", { text: row.team ? row.sub + " · " + row.team : row.sub })),
      h("td", {}, h("span.status." + k, { text })),
      h("td.now", { text: active ? snippet(row.run.task, 90) : S.helpers.noTask }),
      h("td.nowrap", { text: active ? row.run.project : S.wording.dash }),
      h("td.muted.nowrap", { text: row.run ? ago(row.run.startedAt) : S.wording.dash }));
    }))));
}
function helperCallout(row, k, r) {
  if (row.broken) return h("div.callout.needsYou", {}, h("b", { text: S.helpers.broken }), h("p", { text: S.members.broken }),
    h("div.actions", {}, h("a.btn.primary", { href: row.href, text: S.helpers.openHelper })));
  if (k === "idle" || !r) return null;
  const open = h("a.btn.primary", { href: "#/run/" + enc(r.runId), text: S.helpers.openTask });
  const stop = k === "working" ? button("helper-stop", S.tasks.stop, () => showDialog(S.tasks.stopTitle, [fmt(S.tasks.stopEffect, { name: r.runId })], null,
    () => api("runs/" + enc(r.runId) + "/stop", {}), undefined, S.tasks.stop), { class: "danger" }) : null;
  const title = k === "working" ? S.helpers.workingOn : k === "inReview" ? S.tasks.inReview : S.tasks.needsYou;
  const body = k === "inReview" ? S.wording.reviewHint : k === "needsYou" ? stateText(r) : r.project;
  return h("div.callout." + k, {}, h("b", { text: title }), h("p", {}, k === "working" ? null : h("span", { text: body + " · " }), snippet(r.task, 200), k === "working" ? h("span.muted", { text: " · " + body }) : null),
    h("div.actions", {}, open, stop));
}
function helperCompose(row) {
  if (row.quick) return h("div.compose", {}, hint(S.helpers.quickHint));
  if (row.broken) return null;
  if (!row.projects.length) return h("div.compose", {}, hint(S.helpers.noProjects));
  const key = "helper-" + row.key;
  const where = h("select", { id: "helper-task-project", "data-testid": "helper-task-project", "aria-label": S.tasks.project }, row.projects.map((p) => h("option", { value: p, text: p })));
  const form = h("form.compose", { "data-testid": "helper-task-form", onsubmit: (e) => {
    e.preventDefault();
    act(key, e.submitter, async () => {
      await api("projects/" + enc(where.value) + "/runs", { member: row.key, task: val(form, "helper-task-text") });
      clearForm(form);
    }, S.helpers.started);
  } }, row.projects.length > 1 ? where : null,
    h("div.row2", {}, h("input", { id: "helper-task-text", "data-testid": "helper-task-text", type: "text", required: true,
      "aria-label": S.tasks.task, placeholder: fmt(S.helpers.compose, { name: row.name }) }),
      h("button.primary", { type: "submit", "data-testid": "helper-task-start", text: S.tasks.start, disabled: !toolOK(row.tool), title: toolOK(row.tool) ? undefined : toolProblem(row.tool) })),
    message(key));
  return form;
}
function helperDetail(row, r) {
  const [k] = helperStatus(row);
  const lines = r?.log ? r.log.split("\n").filter((line) => line.trim()).slice(-12) : [];
  return [h("div.who", {}, h("h2", {}, h("a", { href: row.href, text: row.name })), hint(row.team ? row.sub + " · " + row.team : row.sub)),
    helperCallout(row, k, r),
    h("h2", { text: S.helpers.activity }), lines.length ? h("ul.activity", {}, lines.map((line) => h("li." + k, { text: snippet(line, 160) }))) : hint(S.helpers.noActivity),
    r ? h("a.link.hint", { href: "#/run/" + enc(r.runId), text: S.helpers.fullActivity }) : null,
    helperCompose(row)];
}
async function helpers(seq) {
  const [teamList, state] = await Promise.all([api("teams"), api("state")]);
  if (!teamList.some((t) => t.name === helperTeam)) helperTeam = "";
  const rows = helperRows(teamList, state.runs).filter((row) => !helperTeam || row.team === helperTeam);
  const picked = rows.find((row) => row.key === helperPick) || rows.find((row) => helperStatus(row)[0] !== "idle") || rows[0];
  const detail = picked?.run ? await api("runs/" + enc(picked.run.runId)).catch(() => null) : null;
  const counts = { working: 0, inReview: 0, idle: 0, needsYou: 0 };
  for (const row of rows) counts[helperStatus(row)[0]]++;
  const chip = (name, text) => button("helpers-team", text, () => { helperTeam = name; refresh(); },
    { class: "chip" + (helperTeam === name ? " on" : ""), "data-key": name || undefined, "aria-pressed": String(helperTeam === name) });
  render(seq, h("div.split.helpers", {},
    h("div.topbar", {}, h("h1", { text: S.helpers.title }), teamList.length ? h("div.chips", {}, chip("", S.helpers.all), teamList.map((t) => chip(t.name, t.name))) : null,
      h("div.topactions", {}, h("a.btn", { href: "#/projects", text: S.helpers.startTask }), h("a.btn.primary", { href: "#/teams", text: S.members.add }))),
    h("section.pane", {}, h("div.stats", {}, [["working", S.tasks.working], ["inReview", S.tasks.inReview], ["idle", S.members.idle], ["needsYou", S.tasks.needsYou]]
      .map(([k, text]) => h("div.statcard." + k, {}, h("span", { text }), h("b", { text: String(counts[k]) })))),
      rows.length ? helperTable(rows, picked) : hint(S.helpers.empty)),
    h("aside.detail", { "data-testid": "helper-detail" }, picked ? helperDetail(picked, detail) : hint(S.helpers.pick))));
}

function projectList(projects, active) {
  return h("section.plist", {}, h("div.label", { text: S.projects.all }), projects.length ? projects.map((p) => {
    const total = LANES.reduce((n, [k]) => n + p.lanes[k], 0);
    const percent = total ? Math.round(p.lanes.done / total * 100) : 0;
    const tone = p.lanes.needsYou ? "needsYou" : p.lanes.inReview ? "inReview" : "working";
    const notes = total ? [fmt(S.projects.progress, { percent }), p.lanes.needsYou ? fmt(S.projects.needCount, { count: p.lanes.needsYou }) : "",
      p.lanes.inReview ? fmt(S.projects.reviewCount, { count: p.lanes.inReview }) : ""].filter(Boolean).join(" · ") : S.projects.noTasks;
    return h("a.card.pcard" + (p.name === active ? ".on" : ""), { href: "#/project/" + enc(p.name), "aria-current": p.name === active ? "page" : undefined },
      h("div.title", { text: p.name }), h("div.sub", { text: p.path, title: p.path }), h("div.bar." + tone, {}, h("i", { style: "width:" + percent + "%" })), h("div.hint", { text: notes }));
  }) : hint(S.projects.empty));
}
function plural(count, one, many) { return fmt(count === 1 ? one : many, { count }); }
function dayKey(d) { return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
// Monday through Sunday of the week containing now, at local midnight.
function weekOf(now) {
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getDay() + 6) % 7);
  return Array.from({ length: 7 }, (_, i) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i));
}
function greeting(now, name) {
  const hour = now.getHours();
  const part = hour < 12 ? S.home.morning : hour < 18 ? S.home.afternoon : S.home.evening;
  const first = (name || "").trim().split(/\s+/)[0];
  return first ? fmt(S.home.named, { greeting: part, name: first }) : part;
}
// What needs the user: tasks to fix or review, broken helpers, and setup gaps for the tools teams rely on.
function homeNotes(rows, runs) {
  const notes = [];
  const list = (items) => items.slice(0, 2).map((r) => whoText(r) + ": " + snippet(r.task, 60)).join(" · ") + (items.length > 2 ? " " + fmt(S.home.more, { count: items.length - 2 }) : "");
  const href = (items) => items.length === 1 ? "#/run/" + enc(items[0].runId) : "#/helpers";
  const needs = runs.filter((r) => r.lane === "needsYou");
  if (needs.length) notes.push({ tone: "needsYou", count: needs.length, title: plural(needs.length, S.home.needsOne, S.home.needsMany), body: list(needs), href: href(needs) });
  const broken = rows.filter((row) => row.broken);
  if (broken.length) notes.push({ tone: "needsYou", count: broken.length, title: plural(broken.length, S.home.brokenOne, S.home.brokenMany),
    body: broken.map((row) => fmt(S.wording.helperTeam, { team: row.team, member: row.name })).join(", "), href: broken[0].href });
  const review = runs.filter((r) => r.lane === "inReview");
  if (review.length) notes.push({ tone: "inReview", count: review.length, title: plural(review.length, S.home.reviewOne, S.home.reviewMany), body: list(review), href: href(review) });
  const used = new Set(rows.filter((row) => row.team).map((row) => row.tool));
  const anyReady = setupState.tools.some((t) => toolOK(t.tool));
  for (const t of setupState.tools) if (!toolOK(t.tool) && (used.has(t.tool) || !anyReady)) {
    notes.push({ count: 1, title: fmt(S.home.toolTitle, { tool: toolName(t.tool) }), body: toolProblem(t.tool), href: "#/profile/setup" });
  }
  if (setupState.identityReady === false) notes.push({ count: 1, title: S.home.identityTitle, body: S.home.identityHint, href: "#/profile" });
  return notes;
}
function teamCard(t, rows, runs) {
  const mine = rows.filter((row) => row.team === t.name);
  const counts = { working: 0, needsYou: 0, inReview: 0, idle: 0 };
  const lines = [];
  for (const row of mine) {
    const [k] = helperStatus(row);
    counts[k]++;
    if (row.broken) lines.push(fmt(S.home.broken, { name: row.name }));
    else if (k === "working") lines.push(fmt(S.home.isWorking, { name: row.name, task: snippet(row.run.task, 60) }));
    else if (k === "needsYou") lines.push(fmt(S.home.needsYou, { name: row.name, state: stateText(row.run) }));
    else if (k === "inReview") lines.push(fmt(S.home.toReview, { name: row.name, task: snippet(row.run.task, 60) }));
  }
  const teamRuns = runs.filter((r) => r.team === t.name);
  const percent = teamRuns.length ? Math.round(teamRuns.filter((r) => r.lane === "done").length / teamRuns.length * 100) : 0;
  const tone = counts.needsYou ? "needsYou" : counts.inReview ? "inReview" : "working";
  const status = [["working", S.home.countWorking], ["needsYou", S.home.countNeeds], ["inReview", S.home.countReview]]
    .filter(([k]) => counts[k]).map(([k, text]) => h("span.status." + k, { text: fmt(text, { count: counts[k] }) }));
  const where = t.projects.length ? fmt(S.home.workingOn, { projects: t.projects.join(", ") }) : S.home.noProject;
  return h("a.teamrow", { href: "#/helpers", "data-testid": "home-team", "data-key": t.name, onclick: () => { helperTeam = t.name; } },
    h("div.top", {}, h("div", {}, h("div.tname", { text: t.name }), h("div.hint", { text: plural(mine.length, S.home.memberOne, S.home.memberMany) + " · " + where })),
      h("div.counts", {}, status.length ? status : h("span.status.idle", { text: S.home.free }))),
    h("p", { text: lines.length ? lines.slice(0, 3).join(" ") + (lines.length > 3 ? " " + fmt(S.home.more, { count: lines.length - 3 }) : "") : S.home.idleTeam }),
    teamRuns.length ? h("div.bar." + tone, { title: fmt(S.projects.progress, { percent }) }, h("i", { style: "width:" + percent + "%" })) : null);
}
function dayText(d, now) { return dayKey(d) === dayKey(now) ? S.home.today : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }); }
// Tasks by the day they started, Monday to Sunday. Calendar shows one day; List shows the whole week, newest first.
function weekTasks(runs, now) {
  const days = weekOf(now);
  if (!days.some((d) => dayKey(d) === homeDay)) homeDay = dayKey(now);
  const byDay = new Map(days.map((d) => [dayKey(d), []]));
  for (const r of runs) byDay.get(dayKey(new Date(r.startedAt)))?.push(r);
  const shown = homeMode === "list" ? [...days].reverse().flatMap((d) => byDay.get(dayKey(d))) : byDay.get(homeDay);
  const mode = (key, text) => button("home-mode", text, () => { homeMode = key; refresh(); },
    { class: "chip" + (homeMode === key ? " on" : ""), "data-key": key, "aria-pressed": String(homeMode === key) });
  return h("section.panel.wide", {}, h("div.headrow", {}, h("h2", { text: S.home.week }), h("div.chips", {}, mode("calendar", S.home.calendar), mode("list", S.home.list))),
    homeMode === "calendar" ? h("div.week", {}, days.map((d) => {
      const key = dayKey(d);
      const count = byDay.get(key).length;
      const on = key === homeDay;
      return h("button.day" + (key === dayKey(now) ? ".today" : "") + (on ? ".on" : ""), { type: "button", "data-testid": "home-day", "data-key": key, "aria-pressed": String(on),
        onclick: () => { homeDay = key; refresh(); } },
        h("span", { text: key === dayKey(now) ? S.home.today : d.toLocaleDateString(undefined, { weekday: "short" }) }), h("b", { text: String(d.getDate()) }),
        h("small", { text: count ? plural(count, S.home.taskOne, S.home.taskMany) : "" }));
    })) : null,
    shown.length ? h("div.table-scroll", {}, h("table.due", {}, h("tbody", {}, shown.map((r) => {
      const started = new Date(r.startedAt);
      return h("tr", { "data-testid": "home-task", "data-key": r.runId },
        h("td", { text: dayText(started, now) + ", " + started.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) }),
        h("td.task", {}, h("a.link", { href: "#/run/" + enc(r.runId), title: r.task, text: snippet(r.task, 90) })),
        h("td.muted", { text: whoText(r) + " · " + stateText(r) }),
        h("td", {}, h("a.link", { href: "#/project/" + enc(r.project), text: r.project })));
    })))) : h("p.muted", { text: homeMode === "list" ? S.home.noWeek : S.home.noDay }));
}
async function homePage(seq) {
  const [teamList, state] = await Promise.all([api("teams"), api("state")]);
  const now = new Date();
  const rows = helperRows(teamList, state.runs);
  const notes = homeNotes(rows, state.runs);
  const count = notes.reduce((n, note) => n + note.count, 0);
  const date = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  render(seq, h("div.homehead", {},
      h("div", {}, h("h1", { text: greeting(now, setupState.profileName) }), h("p", { "data-testid": "home-summary", text: date + " · " + (count ? plural(count, S.home.itemOne, S.home.itemMany) : S.home.itemNone) })),
      button("home-new-project", S.home.newProject, () => { projectAddOpen = true; go("#/projects"); }, { class: "primary" })),
    h("div.home", {},
      h("section.panel", { "data-testid": "home-teams" }, h("div.headrow", {}, h("h2", { text: S.home.teams }), h("a.link.hint", { href: "#/helpers", text: S.home.viewHelpers })),
        teamList.length ? teamList.map((t) => teamCard(t, rows, state.runs)) : h("p.muted", {}, S.home.noTeams + " ", h("a.link", { href: "#/teams", text: S.home.addTeam }))),
      h("section.panel", { "data-testid": "home-important" }, h("h2", { text: S.home.important }), h("div.notes", {}, notes.length
        ? notes.map((note, i) => h("a.note" + (i === 0 ? ".urgent" : "") + (note.tone ? "." + note.tone : ""), { href: note.href, "data-testid": "home-note" }, h("b", { text: note.title }), h("span", { text: note.body })))
        : h("div.note", { "data-testid": "home-note" }, h("b", { text: S.home.calm }), h("span", { text: S.home.calmHint })))),
      weekTasks(state.runs, now)));
}
async function home(seq) {
  const state = await api("state");
  const openAdd = !state.projects.length || projectAddOpen;
  projectAddOpen = false;
  render(seq, h("div.split.projects.index", {}, h("div.topbar", {}, h("h1", { text: S.projects.title })), projectList(state.projects, ""),
    h("section.pane", {}, hint(S.wording.helperIntro), disclosure("project-add-open", S.projects.addTitle, projectAddForm(), undefined, openAdd),
      state.projects.length ? hint(S.projects.pick) : null, heading(S.wording.allTasks), taskTable(state.runs))));
}
async function project(seq, name) {
  const [v, state] = await Promise.all([api("projects/" + enc(name)), api("state")]);
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
  const total = LANES.reduce((n, [lane]) => n + v.lanes[lane].length, 0);
  const [tone, toneText] = v.lanes.needsYou.length ? ["needsYou", S.tasks.needsYou] : ["working", S.projects.onTrack];
  const openForm = () => {
    const box = document.getElementById("task-new-open");
    if (box) { box.open = true; document.getElementById("task-text")?.focus(); }
  };
  render(seq, h("div.split.projects", {},
    h("div.topbar", {}, h("h1", { text: name }), h("span.chip." + tone, { text: toneText }),
      h("div.topactions", {}, button("task-new", S.projects.newTask, openForm, { class: "primary" }))),
    projectList(state.projects || [], name),
    h("section.pane", {}, !v.members.length ? h("p", {}, S.projects.noTeam, h("a.link", { href: "#/teams" }, h("strong", { text: S.members.addTeam })), S.projects.noTeamAfter) : null,
      disclosure("task-new-open", S.wording.giveTask, form, undefined, !total), disclosure("project-account-settings", S.accounts.label, accountSettings("project", name)), heading(S.projects.board),
      h("div.board", {}, LANES.map(([lane, text]) => h("section.lane." + lane, { title: laneHint(lane) }, h("h3", { text: text + " · " + v.lanes[lane].length }),
        v.lanes[lane].length ? v.lanes[lane].map((r) => h("a.card.lanecard." + lane, { href: "#/run/" + enc(r.runId), "data-testid": "task-open", "data-key": r.runId },
          h("b", { text: whoText(r) }), h("div.task", { text: snippet(r.task, 200) }), cardLine(r.specialist ? fmt(S.wording.teamRole, { team: r.team, role: r.specialist }) : ""), cardLine(stateText(r)), cardLine(when(r.startedAt)))) : hint(S.common.empty))))),
    h("aside.detail", {}, h("h2", { text: S.projects.team }), v.members.length ? h("ul.plainlist", {}, v.members.map((m) => h("li", {},
      h("a.link", { href: memberHref(m.team, m.member), text: m.member }), " · " + (m.specialty || S.members.worker), h("div.hint", { text: fmt(S.wording.helperTeam, m) + " · " + toolName(m.tool) })))) : hint(S.projects.noHelpers),
      h("h2", { text: S.projects.path }), h("div.path", { text: v.project.path }), hint(S.wording.workspace),
      h("div.actions", {}, removeButton("project", name, "projects/" + enc(name) + "/remove", key + "-remove", S.projects.remove, () => go("#/projects"))), message(key + "-remove"))));
}

// Replies arrive as Markdown. Build DOM nodes from a safe subset; never parse HTML.
function inlineMarkdown(text) {
  const out = [];
  const pattern = /\x60([^\x60\n]+)\x60|\*\*([^*\n]+)\*\*|(?:\*|_)([^*_\n]+)(?:\*|_)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0, m;
  while ((m = pattern.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(h("code", { text: m[1] }));
    else if (m[2] !== undefined) out.push(h("strong", {}, inlineMarkdown(m[2])));
    else if (m[3] !== undefined) out.push(h("em", { text: m[3] }));
    else out.push(h("a", { href: m[5], target: "_blank", rel: "noopener noreferrer", referrerpolicy: "no-referrer", text: m[4] }));
    last = pattern.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function markdown(text) {
  const blocks = [];
  const parts = text.split(/^\x60\x60\x60[^\n]*\n?/m);
  parts.forEach((part, i) => {
    // Odd parts sit between fences: code shown exactly as written.
    if (i % 2) { blocks.push(h("pre", {}, h("code", { text: part.replace(/\n$/, "") }))); return; }
    let list = null, para = [];
    const flush = () => {
      if (para.length) blocks.push(h("p", {}, para.flatMap((line, n) => n ? [h("br", {}), inlineMarkdown(line)] : inlineMarkdown(line))));
      para = []; list = null;
    };
    for (const line of part.split("\n")) {
      const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
      const head = /^#{1,6}\s+(.*)$/.exec(line);
      if (!line.trim()) flush();
      else if (head) { flush(); blocks.push(h("h3", {}, inlineMarkdown(head[1]))); }
      else if (item) {
        const tag = item[1] ? "ul" : "ol";
        if (para.length) flush();
        if (!list || list.tagName.toLowerCase() !== tag) { list = h(tag, {}); blocks.push(list); }
        list.append(h("li", {}, inlineMarkdown(item[3])));
      } else if (list && /^\s{2,}\S/.test(line)) list.lastChild.append(" ", ...inlineMarkdown(line.trim()));
      else { list = null; para.push(line); }
    }
    flush();
  });
  return blocks;
}
function clock(iso) {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
// One conversation with Claude or Codex; each reply arrives on a later poll.
async function chat(seq) {
  const v = await api("chat");
  const tool = toolName(v.tool);
  const key = "chat";
  const me = setupState.profileName ? setupState.profileName.trim().split(/\s+/)[0] : S.chat.you;
  const models = v.models?.[v.tool] || [];
  const modelName = (id) => models.find((m) => m.id === id)?.label || id;
  const text = h("textarea", { id: "chat-text", "data-testid": "chat-text", "aria-label": S.chat.message, placeholder: fmt(S.chat.placeholder, { tool }), maxlength: 20000, rows: 2,
    onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } } });
  const provider = h("select.pill", { id: "chat-tool", "data-testid": "chat-tool", "aria-label": S.chat.provider, title: S.chat.switchHint,
    onchange: (e) => act(key, e.currentTarget, () => api("chat/new", { tool: e.currentTarget.value }), "") },
    ["claude", "codex"].map((t) => h("option", { value: t, text: toolName(t), selected: t === v.tool })));
  // A model saved earlier but no longer listed stays selectable so the choice isn't silently lost.
  const choices = v.model && !models.some((m) => m.id === v.model) ? [...models, { id: v.model, label: v.model }] : models;
  const model = h("select.pill", { id: "chat-model", "data-testid": "chat-model", "aria-label": S.chat.model, title: S.chat.modelHint,
    onchange: (e) => act(key, e.currentTarget, () => api("chat/model", { model: e.currentTarget.value }), "") },
    h("option", { value: "", text: S.chat.defaultModel, selected: !v.model }), choices.map((m) => h("option", { value: m.id, text: m.label, selected: m.id === v.model })));
  const form = h("form.chatform", { "data-testid": "chat-form", onsubmit: (e) => {
    e.preventDefault();
    const message = text.value.trim();
    if (!message || v.busy) return;
    act(key, form.querySelector("button[type=submit]"), async () => { await api("chat", { text: message }); text.value = ""; }, "");
  } }, h("div.composer", {}, text, h("div.row", {}, provider, model,
    button("chat-new", S.chat.newChat, (e) => act(key, e.currentTarget, () => api("chat/new", {}), ""), { class: "pill", disabled: !v.messages.length && !v.busy }),
    hint(S.chat.enterHint), h("button.primary", { type: "submit", "data-testid": "chat-send", text: S.chat.send, disabled: v.busy }))), message(key));
  const row = (role, name, at, body, m) => h("article.msg." + role, m ? { "data-testid": "chat-message", "data-key": role } : { "data-testid": "chat-thinking", "aria-label": fmt(S.chat.thinking, { tool }) },
    h("span.avatar", { "aria-hidden": "true", text: role === "user" ? initials(setupState.profileName) || name[0] : name[0] }),
    h("div.meta", {}, h("b", { text: name }), m?.model ? h("span.hint", { text: modelName(m.model) }) : null, at ? h("time", { datetime: at, text: clock(at) }) : null,
      m && m.role === "assistant" ? button("chat-copy", "⧉", async () => {
        try { await navigator.clipboard.writeText(m.text); tell(key, S.common.copied, true); } catch (_) { tell(key, S.common.copyFailed); }
      }, { class: "copy", "aria-label": S.chat.copy, title: S.chat.copy }) : null),
    h("div.body", {}, body));
  const fresh = lastRoute !== location.hash;
  render(seq, h("div.chatpage", {},
    h("div.chatlog", { "data-testid": "chat-log", "aria-live": "polite" },
      !v.messages.length && !v.busy ? h("div.chatempty", {}, h("h2", { text: S.chat.empty }), h("p", { text: S.chat.intro })) : null,
      v.messages.map((m) => row(m.role, m.role === "user" ? me : tool, m.at, m.role === "assistant" ? markdown(m.text) : h("p", { text: m.text }), m)),
      v.busy ? row("assistant", tool, "", h("span.typing", {}, h("i"), h("i"), h("i"))) : null),
    form));
  // Open a chat at its latest message; later polls keep the reader's place.
  const log = app.querySelector(".chatlog");
  if (fresh && log && seq === renderSeq) log.scrollTop = log.scrollHeight;
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
(function sidebarToggle() {
  const btn = document.getElementById("sidetoggle");
  const root = document.documentElement;
  const sync = () => {
    const collapsed = root.getAttribute("data-sidebar") === "collapsed";
    const label = collapsed ? S.nav.expand : S.nav.collapse;
    btn.setAttribute("aria-expanded", String(!collapsed)); btn.setAttribute("aria-label", label); btn.title = label;
  };
  sync();
  btn.addEventListener("click", () => {
    const collapse = root.getAttribute("data-sidebar") !== "collapsed";
    if (collapse) root.setAttribute("data-sidebar", "collapsed"); else root.removeAttribute("data-sidebar");
    try { if (collapse) localStorage.setItem(SIDEBAR_KEY, "collapsed"); else localStorage.removeItem(SIDEBAR_KEY); } catch (_) {}
    sync();
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
      if (setupState.shouldOpen && location.hash !== "#/profile/setup") { go("#/profile/setup"); return; }
    }
    const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
    let page = "projects";
    document.body.classList.toggle("full", parts[0] === "profile");
    // Setup now lives in the profile; keep old #/setup links working.
    if (parts[0] === "setup") { go("#/profile/setup"); return; }
    if (parts[0] === "profile") { page = "profile"; await profile(seq, parts[1]); }
    else if (parts[0] === "projects") await home(seq);
    else if (parts[0] === "accounts") { page = "accounts"; await accounts(seq); }
    else if (parts[0] === "project" && parts[1]) await project(seq, parts[1]);
    else if (parts[0] === "run" && parts[1]) await run(seq, parts[1]);
    else if (parts[0] === "teams") { page = "teams"; await teams(seq); }
    else if (parts[0] === "specialists") { page = "specialists"; await specialists(seq); }
    else if (parts[0] === "skills") { page = "skills"; await skills(seq); }
    else if (parts[0] === "member" && parts[1] && parts[2]) { page = "teams"; await member(seq, parts[1], parts[2]); }
    else if (parts[0] === "chat") { page = "chat"; await chat(seq); }
    else if (parts[0] === "helpers") { page = "helpers"; await helpers(seq); }
    else { page = "home"; await homePage(seq); }
    const state = await api("state");
    if (seq !== renderSeq) return;
    for (const a of document.querySelectorAll("header nav a")) {
      a.classList.toggle("on", a.dataset.page === page);
      if (a.dataset.page === page) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    }
    const short = initials(setupState.profileName);
    document.getElementById("profile-link").classList.toggle("on", page === "profile");
    document.getElementById("profile-name").textContent = setupState.profileName || S.profile.title;
    document.getElementById("profile-sub").hidden = !setupState.profileName;
    document.getElementById("avatar-initials").textContent = short;
    document.getElementById("avatar-icon").hidden = !!short;
    document.getElementById("running").textContent = state.agentsRunning;
    document.getElementById("teamsN").textContent = state.teamsCount;
    document.getElementById("memory").textContent = mem(state.memoryBytes);
    document.getElementById("memory").title = state.memoryBytes == null ? S.wording.memoryMissing : S.wording.memoryHint;
    document.getElementById("err").textContent = "";
  } catch (e) {
    if (seq === renderSeq) tell("connection", errorText(e), false, e);
  } finally { if (seq === renderSeq) timer = setTimeout(refresh, 2000); }
}
window.addEventListener("hashchange", (e) => {
  // "Back to Codec" returns to whatever page opened the profile.
  const from = new URL(e.oldURL).hash || "#/";
  if (location.hash.startsWith("#/profile") && !from.startsWith("#/profile")) profileReturn = from;
  messages.clear(); folders.clear(); tracking = null;
  if (dialog.open) closeDialog();
  document.getElementById("err").textContent = ""; refresh();
});
refresh();
</script></body></html>`;
}
