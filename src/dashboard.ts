/**
 * dashboard.ts — `codec dashboard`: a local web page over the same engine.
 *
 * It holds no state of its own. Every request re-reads ~/.codec through
 * registry.ts / runs.ts, exactly like the CLI, and every action calls the
 * same functions the CLI calls.
 *
 * Security (this page can launch agents with full permissions):
 *  - listens on 127.0.0.1 only;
 *  - rejects any Host header other than 127.0.0.1:<port> / localhost:<port>
 *    (stops DNS-rebinding pages from talking to it);
 *  - a random token is generated at start and printed in the URL. Opening
 *    that URL stores it in an HttpOnly cookie; the page also sends it as the
 *    X-Codec-Token header. Every /api call needs it, and every state-changing
 *    call must be a POST with JSON body AND the header (a cookie alone is not
 *    enough, so other websites can't forge actions).
 */

import { CodecError } from "./errors.js";
import { S, wording } from "./strings.js";
import { checkpointIdentity, getSettings, saveSettings, saveAccountSettings } from "./settings.js";
import { accountStore, addAccount, builtinId, getAccount, removeAccount, resolveAccount, setDefaultAccount } from "./accounts.js";
import { createAccountLogins, type AccountLoginOptions } from "./account-login.js";
import { redactValue } from "./secrets.js";
import { ApiError, friendlyError } from "./friendly.js";
import { hasCheckpoint, isGitRepo, listFolders, requireFolder, setUpTracking } from "./folders.js";
import { createSetupChecker, type SetupOptions } from "./setup.js";
import { checkTool } from "./tools.js";
import { checkTimeLimit, formatTimeLimit } from "./limits.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { randomBytes, timingSafeEqual, createHash } from "crypto";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { codecHome } from "./store.js";
import { tmpdir } from "os";
import { addProject, getProject, listProjects, type Project } from "./registry.js";
import {
  addMember,
  addSpecialist,
  addTeam,
  clonesOf,
  editSpecialist,
  editMember,
  getTeam,
  getSpecialist,
  parseMemberRef,
  listSpecialists,
  listTeams,
  removeSkillEverywhere,
  removeSpecialist,
  resolveMember,
  setTeamProjects,
  skillHolders,
  type ResolvedMember,
} from "./org.js";
import { getSkill, importSkill, importSkillFiles, listSkills } from "./skills.js";
import { projectSkills, type GivenSkill } from "./inject.js";
import {
  cleanRun,
  findRun,
  listRuns,
  removeMemberChecked,
  removeProjectChecked,
  removeTeamChecked,
  runOutput,
  skillsUsed,
  startRun,
  stopRun,
  type RunStatus,
} from "./runs.js";
import { renderLocked } from "./ui.js";
import { isUiAssetPath, readUiAsset, renderNextPage } from "./ui-bundle.js";

export const DEFAULT_PORT = 4777;
export const HOST = "127.0.0.1";
// All dashboard screens now use the production React bundle.
const REACT_AT_ROOT = true;
const LOG_LINES = 200;
const MAX_BODY = 64 * 1024;
const MAX_UPLOAD = 8 * 1024 * 1024; // skill folder upload (base64)

// ---------- lanes ----------

export type Lane = "working" | "needsYou" | "inReview" | "done";
export const LANES: Lane[] = ["working", "needsYou", "inReview", "done"];

/**
 * Which board lane a run belongs on.
 *  working   running
 *  needsYou  failed or stopped (until its worktree is cleaned)
 *  inReview  finished OK and the worktree still exists
 *  done      finished OK and the worktree is gone; also any cleaned run
 */
export function laneOf(run: RunStatus): Lane {
  if (run.state === "running") return "working";
  const cleaned = !!run.cleanedAt || !existsSync(run.worktree);
  if (cleaned) return "done";
  if (run.reviewStatus === "unsaved" || run.reviewStatus === "unavailable") return "needsYou";
  if (run.state === "done" && run.reviewStatus === "no_changes") return "done";
  if (run.state === "done" && run.reviewStatus === "ready") return "inReview";
  return "needsYou";
}

function emptyCounts(): Record<Lane, number> {
  return { working: 0, needsYou: 0, inReview: 0, done: 0 };
}

// ---------- memory ----------

interface ProcInfo {
  ppid: number;
  pgrp: number;
}

/** pid -> {ppid, pgrp} for every process, from /proc. Linux only. */
function readProcTable(): Map<number, ProcInfo> | undefined {
  if (process.platform !== "linux" || !existsSync("/proc/self/stat")) return undefined;
  const table = new Map<number, ProcInfo>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf-8");
      // comm (field 2) is in parens and may contain spaces — parse after the last ")".
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      table.set(Number(name), { ppid: Number(rest[1]), pgrp: Number(rest[2]) });
    } catch {
      // process exited while we were looking
    }
  }
  return table;
}

function rssBytes(pid: number): number {
  try {
    const m = /VmRSS:\s+(\d+)\s+kB/.exec(readFileSync(`/proc/${pid}/status`, "utf-8"));
    return m ? Number(m[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

/**
 * Total resident memory of every running run's process tree (the wrapper,
 * its process group and all descendants). `null` where /proc isn't available.
 */
export function agentMemoryBytes(running: RunStatus[]): number | null {
  const table = readProcTable();
  if (!table) return null;
  const children = new Map<number, number[]>();
  for (const [pid, info] of table) {
    const list = children.get(info.ppid) ?? [];
    list.push(pid);
    children.set(info.ppid, list);
  }
  const seen = new Set<number>();
  for (const run of running) {
    if (!run.pid || !table.has(run.pid)) continue;
    const stack = [run.pid];
    for (const [pid, info] of table) if (info.pgrp === run.pid) stack.push(pid);
    while (stack.length) {
      const pid = stack.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      stack.push(...(children.get(pid) ?? []));
    }
  }
  let total = 0;
  for (const pid of seen) total += rssBytes(pid);
  return total;
}

// ---------- API views ----------

function runSummary(r: RunStatus) {
  return {
    account: r.account ?? { id: builtinId(r.agent), name: S.accounts.computer },
    limitHit: !!r.limitHit,
    runId: r.runId,
    project: r.project,
    agent: r.agent,
    state: r.state,
    reviewStatus: r.reviewStatus,
    stateText: r.reviewStatus === "unsaved" ? S.tasks.unsaved : r.reviewStatus === "unavailable" ? S.tasks.workspaceUnchecked : r.reviewStatus === "no_changes" ? S.tasks.noChanges : r.lostAt ? S.wording.lost : r.state === "timed_out" ? wording(S.tasks.timedOut, { limit: formatTimeLimit(r.timeLimitMinutes) }) : ({ running: S.tasks.working, done: S.wording.finished, failed: S.tasks.failed, stopped: S.tasks.stopped })[r.state],
    lostAt: r.lostAt,
    timeLimitMinutes: r.timeLimitMinutes,
    deadline: r.deadline,
    lane: laneOf(r),
    startedAt: r.startedAt,
    task: r.task,
    team: r.team,
    member: r.member,
    specialist: r.specialist,
  };
}

/** Skills a member has, with source, plus what each of its projects ships itself. */
function memberSkills(m: ResolvedMember): { name: string; source: string; project?: string }[] {
  const out: { name: string; source: string; project?: string }[] = m.skills.map((s) => ({ ...s }));
  for (const p of m.projects) {
    const proj = getProject(p);
    if (!proj || !existsSync(proj.path)) continue;
    for (const s of projectSkills(proj.path, m.tool)) out.push({ name: s.name, source: "project", project: p });
  }
  return out;
}

function memberView(team: string, member: string, running: RunStatus[]) {
  const r = resolveMember(team, member);
  return {
    ...r,
    skills: memberSkills(r),
    working: running.filter((x) => x.team === team && x.member === member).map(runSummary),
  };
}

export function teamsView() {
  const running = listRuns({ state: "running" });
  return listTeams().map((t) => ({
    name: t.name,
    projects: t.projects,
    createdAt: t.createdAt,
    members: t.members.map((m) => {
      try {
        return memberView(t.name, m.name, running);
      } catch (e) {
        return { team: t.name, member: m.name, kind: m.kind, specialist: m.specialist, ...friendlyError(e, "/api/teams").body };
      }
    }),
  }));
}

export function memberPage(team: string, member: string) {
  const v = memberView(team, member, listRuns({ state: "running" }));
  const runs = listRuns()
    .filter((r) => r.team === team && r.member === member)
    .reverse()
    .map(runSummary);
  return { ...v, runs };
}

export function specialistsView() {
  return listSpecialists().map((s) => ({ ...s, clones: clonesOf(s.name) }));
}

/** The library, who has each skill, and an agents × skills grid. */
export function skillsView() {
  const skills = listSkills().map((s) => ({ name: s.name, description: s.description, files: s.files, ...skillHolders(s.name) }));
  const rows: { kind: "specialist" | "member"; id: string; label: string; tool: string; skills: Record<string, string> }[] = [];
  for (const sp of listSpecialists()) {
    rows.push({
      kind: "specialist",
      id: sp.name,
      label: wording(S.wording.roleGrid, { name: sp.name, specialty: sp.specialty }),
      tool: sp.tool,
      skills: Object.fromEntries(sp.skills.map((x) => [x, "own"])),
    });
  }
  for (const t of listTeams()) {
    for (const m of t.members) {
      try {
        const r = resolveMember(t.name, m.name);
        rows.push({
          kind: "member",
          id: `${t.name}/${m.name}`,
          label: wording(S.wording.helperGrid, { member: m.name, team: t.name, role: r.specialist ? wording(S.members.copyOf, { name: r.specialist }) : S.wording.general }),
          tool: r.tool,
          skills: Object.fromEntries(r.skills.map((x) => [x.name, x.source === "specialist" ? "via specialist" : "own"])),
        });
      } catch {
        // broken member (its specialist was removed): skip in the grid
      }
    }
  }
  return { skills, grid: { skills: skills.map((s) => s.name), rows } };
}

export function homeView() {
  const runs = listRuns();
  const running = runs.filter((r) => r.state === "running");
  const projects = listProjects().map((p: Project) => {
    const lanes = emptyCounts();
    for (const r of runs) if (r.project === p.name) lanes[laneOf(r)]++;
    return { name: p.name, path: p.path, lanes };
  });
  return {
    teamsCount: listTeams().length,
    agentsRunning: running.length,
    memoryBytes: agentMemoryBytes(running),
    projects,
    runs: runs.map(runSummary).reverse(), // newest first
  };
}

export function projectView(name: string) {
  const project = listProjects().find((p) => p.name === name);
  if (!project) throw new CodecError("project_not_found", `no project named "${name}"`, {}, 404);
  const lanes: Record<Lane, ReturnType<typeof runSummary>[]> = { working: [], needsYou: [], inReview: [], done: [] };
  for (const r of listRuns({ project: name }).reverse()) lanes[laneOf(r)].push(runSummary(r));
  // Who can be started here: members of every team assigned to this project.
  const members = listTeams()
    .filter((t) => t.projects.includes(name))
    .flatMap((t) =>
      t.members.map((m) => {
        try {
          const r = resolveMember(t.name, m.name);
          return { ref: `${t.name}/${m.name}`, tool: r.tool, label: wording(S.wording.helperOption, { member: m.name, team: t.name, specialty: r.specialty ?? S.members.worker, tool: r.tool === "claude" ? S.setup.claude : S.setup.codex }) };
        } catch {
          return undefined;
        }
      }),
    )
    .filter(Boolean);
  return { project, lanes, members };
}

export function runView(ref: string) {
  const r = findRunOr404(ref);
  return {
    ...runSummary(r),
    worktree: r.worktree,
    worktreeExists: existsSync(r.worktree),
    branch: r.branch,
    baseSha: r.baseSha,
    stoppedAt: r.stoppedAt,
    cleanedAt: r.cleanedAt,
    lostAt: r.lostAt,
    model: r.model,
    actualModel: r.actualModel,
    autoSaved: r.autoSaved,
    coAuthorStripped: r.coAuthorStripped,
    checkpointError: r.checkpointError,
    specialty: r.specialty,
    skillsGiven: (r.skills ?? []) as GivenSkill[],
    skillsUsed: skillsUsed(r.runId),
    log: runOutput(r.runId, LOG_LINES),
  };
}

/** Describe the same dependencies and blockers enforced by engine removals. */
export function removePreview(kind: string, name: string) {
  const effects: { what: string; kind: "lost" | "kept" }[] = [];
  let blockedReason: string | undefined;
  const runs = listRuns();
  let related: RunStatus[] = [];
  const effect = (kind: "lost" | "kept", what: string) => effects.push({ what, kind });
  if (kind === "project") {
    if (!getProject(name)) throw new CodecError("project_not_found", `no project named "${name}"`, {}, 404);
    related = runs.filter((run) => run.project === name);
    for (const team of listTeams().filter((team) => team.projects.includes(name))) {
      effect("lost", wording(S.wording.teamEffect, { name: team.name }));
    }
    effect("kept", S.wording.projectEffect);
  } else if (kind === "team") {
    const team = getTeam(name);
    if (!team) throw new CodecError("team_not_found", `no team named "${name}"`, { name: name }, 404);
    related = runs.filter((run) => run.team === name);
    effect("lost", wording(S.wording.helpersRemoved, { count: team.members.length }));
    effect("kept", S.wording.rolesKept);
  } else if (kind === "member") {
    const ref = parseMemberRef(name);
    const team = getTeam(ref.team);
    if (!team) throw new CodecError("team_not_found", `no team named "${ref.team}"`, { name: ref.team }, 404);
    if (!team.members.some((member) => member.name === ref.member)) throw new CodecError("member_not_found", `no member named "${name}"`, {}, 404);
    related = runs.filter((run) => run.team === ref.team && run.member === ref.member);
    effect("lost", wording(S.wording.memberEffect, { member: ref.member, team: ref.team }));
    effect("kept", S.wording.roleKept);
  } else if (kind === "specialist") {
    if (!getSpecialist(name)) throw new CodecError("specialist_not_found", `no specialist named "${name}"`, { name }, 404);
    const clones = clonesOf(name);
    if (clones.length) blockedReason = wording(S.wording.roleBlocked, { name, count: clones.length, list: clones.map((c) => wording(S.wording.helperTeam, c)).join(", ") });
    related = runs.filter((run) => run.specialist === name);
    effect("lost", S.wording.roleRemoved);
    effect("kept", S.wording.skillsKept);
  } else if (kind === "skill") {
    if (!getSkill(name)) throw new CodecError("invalid_skill", `no skill named "${name}"`, { name });
    const holders = skillHolders(name);
    effect("lost", wording(S.wording.rolesLose, { count: holders.specialists.length }));
    // Clones also lose access through their specialist, even without an extra assignment.
    const members = new Set([...holders.members, ...holders.specialists.flatMap((specialist) => clonesOf(specialist).map((clone) => `${clone.team}/${clone.member}`))]);
    effect("lost", wording(S.wording.helpersLose, { count: members.size }));
    effect("kept", S.wording.taskCopies);
    effect("kept", S.wording.originalKept);
    effect("lost", wording(S.wording.removeSkill, { name, list: [...holders.specialists.map((name) => wording(S.members.copyOf, { name })), ...Array.from(members, (ref) => wording(S.wording.helperTeam, parseMemberRef(ref)))].join(", ") || S.wording.noHolders }));
  } else {
    throw new ApiError(400, "invalid_kind", "Choose a project, team, specialist, skill or member to remove.");
  }
  if (kind === "project" || kind === "team" || kind === "member") {
    if (related.some((run) => run.state === "running")) blockedReason = S.wording.busy;
  }
  if (kind !== "skill") {
    const count = related.filter((run) => run.state !== "running").length;
    effect("kept", wording(S.wording.history, { count }));
  }
  const removalText = kind === "project" ? wording(S.wording.removeProject, { name })
    : kind === "team" ? wording(S.wording.removeTeam, { name })
    : kind === "member" ? wording(S.wording.removeMember, parseMemberRef(name))
    : kind === "specialist" ? wording(S.wording.removeRole, { name }) : undefined;
  return { kind, name, ...(removalText ? { removalText } : {}), blocked: !!blockedReason, ...(blockedReason ? { blockedReason } : {}), effects };
}

// ---------- HTTP plumbing ----------

function findRunOr404(ref: string): RunStatus {
  return findRun(ref);
}

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function send(res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}) {
  res.writeHead(status, { ...BASE_HEADERS, "Content-Type": type, ...extra });
  res.end(body);
}

function sendLocked(res: ServerResponse) {
  const html = renderLocked();
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1];
  const hash = createHash("sha256").update(style).digest("base64");
  return send(res, 401, html, "text/html; charset=utf-8", {
    "Content-Security-Policy": `default-src 'none'; script-src 'none'; style-src 'sha256-${hash}'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  send(res, status, JSON.stringify(redactValue(data)), "application/json; charset=utf-8");
}

function tokenEquals(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new CodecError("body_too_large", "request body too large", {}, 413));
        chunks.length = 0;
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (size > limit) return;
      const text = Buffer.concat(chunks).toString("utf-8");
      if (!text.trim()) return resolve({});
      try {
        const v = JSON.parse(text);
        if (v && typeof v === "object" && !Array.isArray(v)) resolve(v as Record<string, unknown>);
        else reject(new CodecError("bad_json", "body must be a JSON object"));
      } catch {
        reject(new CodecError("bad_json", "body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

const s = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const strs = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? v.split(",") : undefined;

export interface Dashboard {
  server: Server;
  port: number;
  token: string;
  url: string;
  close(): Promise<void>;
}

export function startDashboard(opts: { port?: number; token?: string; setup?: SetupOptions; accounts?: AccountLoginOptions; uiBundleDir?: string } = {}): Promise<Dashboard> {
  const token = opts.token ?? randomBytes(24).toString("base64url");
  let port = opts.port ?? DEFAULT_PORT;
  const cookieName = () => `codec_token_${port}`;
  const checkSetup = createSetupChecker(opts.setup);
  const logins = createAccountLogins(opts.accounts);
  async function setupStatus(fresh = false) {
    const status = await checkSetup(fresh);
    const saved = accountStore().accounts;
    const managed = await Promise.all(saved.map(async (account) => ({ kind: account.kind, ok: await logins.signedIn(account.id, fresh) })));
    const tools = status.tools.map((tool) => ({ ...tool, signedIn: managed.some((a) => a.kind === tool.tool && a.ok) ? true : tool.signedIn }));
    return { ...status, tools, ready: tools.some((t) => t.installed && t.signedIn) };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 1. DNS-rebinding guard: only our own loopback host names.
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      if ((req.url ?? "").startsWith("/api/")) throw new ApiError(421, "unexpected_host", "Open the dashboard using its local Codec link.");
      return send(res, 421, "Codec dashboard: unexpected Host header\n", "text/plain; charset=utf-8");
    }
    const rawPath = (req.url ?? "/").split("?")[0];
    const url = new URL(req.url ?? "/", `http://${host}`);
    const path = url.pathname;
    const headerToken = s(req.headers["x-codec-token"]);
    const cookieToken = cookie(req, cookieName());

    // 2. The page. ?token=... (the printed link) sets the cookie, then
    //    redirects so the token doesn't linger in the address bar.
    if ((path === "/" || path === "/next" || path === "/next/") && req.method === "GET" && !isUiAssetPath(rawPath)) {
      const q = url.searchParams.get("token") ?? undefined;
      if (q !== undefined) {
        if (!tokenEquals(q, token)) return sendLocked(res);
        res.writeHead(303, {
          ...BASE_HEADERS,
          Location: path,
          "Set-Cookie": `${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        });
        return void res.end();
      }
      if (!tokenEquals(cookieToken, token)) return sendLocked(res);
      // /next remains an authenticated alias for step 1 bookmarks.
      if (REACT_AT_ROOT || path !== "/") {
        const html = renderNextPage(token, opts.uiBundleDir);
        if (html === undefined) return send(res, 503, "Codec's new interface has not been built. Run npm run build, then refresh this page.\n", "text/plain; charset=utf-8");
        const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => "'sha256-" + createHash("sha256").update(m[1]).digest("base64") + "'");
        return send(res, 200, html, "text/html; charset=utf-8", {
          "Content-Security-Policy":
            `default-src 'none'; script-src 'self' ${hashes.join(" ")}; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
        });
      }
    }

    if (isUiAssetPath(rawPath) && req.method === "GET") {
      if (!tokenEquals(cookieToken, token)) return sendLocked(res);
      const asset = readUiAsset(rawPath, opts.uiBundleDir);
      if (!asset) return send(res, 404, "Asset not found.\n", "text/plain; charset=utf-8");
      return send(res, 200, asset.body, asset.type, { "Cache-Control": asset.cache });
    }

    if (!path.startsWith("/api/")) throw new ApiError(404, "not_found", "That page could not be found. Refresh the dashboard and try again.");

    // 3. API auth. Reads: header or cookie. Writes: POST + header + JSON.
    if (req.method === "GET") {
      if (!tokenEquals(headerToken, token) && !tokenEquals(cookieToken, token)) {
        throw new ApiError(401, "unauthorized", "Open the dashboard using the link printed by Codec.");
      }
    } else if (req.method === "POST") {
      if (!tokenEquals(headerToken, token)) throw new ApiError(401, "unauthorized", "Open the dashboard using the link printed by Codec.");
      if ((req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase() !== "application/json") {
        throw new ApiError(415, "json_required", "That request could not be read. Refresh the dashboard and try again.");
      }
    } else {
      throw new ApiError(405, "method_not_allowed", "That action is not supported. Refresh the dashboard and try again.");
    }

    // Decode the path after /api/ only once.
    let parts: string[];
    try { parts = path.split("/").slice(2).map(decodeURIComponent); }
    catch { throw new ApiError(400, "bad_request", "That address could not be read. Refresh the dashboard and try again."); }
    const isGet = req.method === "GET";
    const body = isGet ? {} : await readBody(req, path === "/api/skills" ? MAX_UPLOAD : MAX_BODY);
    const need = (k: string): string => {
      const v = s(body[k]);
      if (!v || !v.trim()) throw new ApiError(400, k === "task" ? "missing_task" : "missing_path", k === "task" ? "Describe the task before starting it." : "Choose a folder before continuing.");
      return v;
    };

    // GET  /api/state
    // GET  /api/projects/:name
    // GET  /api/runs/:id
    // POST /api/projects                 {path, name?}
    // POST /api/projects/:name/remove
    // POST /api/projects/:name/runs      {agent, task}
    // POST /api/runs/:id/stop
    // POST /api/runs/:id/clean           {force?, deleteBranch?}
    const [a, b, c, d2, e2] = parts;
    const n = parts.length;
    if (isGet && a === "error-details" && n === 1) return sendJson(res, 200, { logPath: join(codecHome(), "codec.log"), time: new Date().toISOString() });
    if (isGet && a === "setup" && n === 1) return sendJson(res, 200, { ...await setupStatus(url.searchParams.get("fresh") === "1"), identityReady: !!checkpointIdentity(), shouldOpen: !getSettings().setupFinished });
    if (isGet && a === "accounts" && n === 1) {
      const saved = accountStore();
      return sendJson(res, 200, { accounts: await logins.accountsView(listRuns(), url.searchParams.get("fresh") === "1"),
        defaults: { claude: saved.defaults.claude ?? builtinId("claude"), codex: saved.defaults.codex ?? builtinId("codex") }, choices: saved.choices });
    }
    if (!isGet && a === "accounts" && n === 1) return sendJson(res, 201, addAccount(s(body.kind) ?? "", s(body.name) ?? ""));
    if (!isGet && a === "account-settings" && n === 1) {
      const scope = s(body.scope);
      if (scope !== "helper" && scope !== "team" && scope !== "project") throw new ApiError(400, "bad_request", S.common.error);
      return sendJson(res, 200, saveAccountSettings(scope, s(body.name) ?? "", checkTool(s(body.kind) ?? ""), s(body.accountId) || undefined));
    }
    if (a === "accounts" && b && n === 3) {
      const account = getAccount(b);
      if (isGet && c === "login") return sendJson(res, 200, logins.view(b) ?? null);
      if (!isGet && c === "default") { setDefaultAccount(account.kind, b); return sendJson(res, 200, { ok: true }); }
      if (!isGet && c === "login") {
        if (listRuns({ state: "running" }).some((run) => run.account?.id === b)) throw new CodecError("account_busy", S.errors.account_busy, {}, 409);
        return sendJson(res, 200, logins.start(b, body.method === "browser" ? "browser" : "device"));
      }
      if (!isGet && c === "cancel") return sendJson(res, 200, logins.cancel(b) ?? null);
      if (!isGet && c === "code") { logins.submitCode(b, s(body.code) ?? ""); return sendJson(res, 200, { ok: true }); }
      if (!isGet && c === "remove") {
        if (account.builtin) throw new CodecError("account_builtin", S.errors.account_builtin, {}, 409);
        if (body.confirmed !== true) throw new CodecError("account_confirm", S.errors.account_confirm, {}, 409);
        if (listRuns({ state: "running" }).some((run) => run.account?.id === b)) throw new CodecError("account_busy", S.errors.account_busy, {}, 409);
        await logins.stop(b);
        return sendJson(res, 200, removeAccount(b, { confirmed: true, running: () => listRuns({ state: "running" }) }));
      }
    }
    if (isGet && a === "settings" && n === 1) return sendJson(res, 200, getSettings());
    if (!isGet && a === "settings" && n === 1) {
      const identity = body.identity as Record<string, unknown> | undefined;
      if (body.setupFinished !== undefined && body.setupFinished !== true) throw new CodecError("bad_request", S.common.error);
      return sendJson(res, 200, saveSettings({
        identity: identity ? { name: s(identity.name) ?? "", email: s(identity.email) ?? "" } : body.setupFinished === true ? undefined : { name: "", email: "" },
        setupFinished: body.setupFinished === true ? true : undefined,
      }));
    }
    if (isGet && a === "folders" && n === 1) return sendJson(res, 200, listFolders(url.searchParams.get("path") ?? undefined));
    if (isGet && a === "remove-preview" && n === 1) return sendJson(res, 200, removePreview(url.searchParams.get("kind") ?? "", url.searchParams.get("name") ?? ""));
    if (isGet && a === "projects" && n === 1) return sendJson(res, 200, listProjects());
    if (isGet && a === "runs" && n === 1) return sendJson(res, 200, listRuns({ project: url.searchParams.get("project") ?? undefined }).map(runSummary));
    if (isGet && a === "state" && n === 1) return sendJson(res, 200, homeView());
    if (isGet && a === "teams" && n === 1) return sendJson(res, 200, teamsView());
    if (isGet && a === "specialists" && n === 1) return sendJson(res, 200, specialistsView());
    if (isGet && a === "skills" && n === 1) return sendJson(res, 200, skillsView());
    if (isGet && a === "members" && b && c && n === 3) return sendJson(res, 200, memberPage(b, c));

    // Teams
    if (!isGet && a === "teams" && n === 1) {
      return sendJson(res, 201, addTeam({ name: s(body.name), projects: strs(body.projects) }));
    }
    if (!isGet && a === "teams" && b && n === 3 && c === "remove") return sendJson(res, 200, removeTeamChecked(b));
    if (!isGet && a === "teams" && b && n === 3 && c === "projects") {
      return sendJson(res, 200, setTeamProjects(b, strs(body.projects) ?? []));
    }
    if (!isGet && a === "teams" && b && n === 3 && c === "members") {
      if (!getTeam(b)) throw new CodecError("team_not_found", `no team named "${b}"`, { name: b }, 404);
      const m = addMember(b, {
        name: s(body.name),
        specialist: s(body.specialist) || undefined,
        tool: s(body.tool) || undefined,
        model: s(body.model),
        skills: strs(body.skills),
        timeLimitMinutes: checkTimeLimit(body.timeLimitMinutes),
      });
      return sendJson(res, 201, m);
    }
    if (!isGet && a === "teams" && b && c === "members" && d2 && e2 === "remove" && n === 5) {
      return sendJson(res, 200, removeMemberChecked(b, d2));
    }

    if (!isGet && a === "teams" && b && c === "members" && d2 && e2 === "edit" && n === 5) {
      return sendJson(res, 200, editMember(b, d2, { timeLimitMinutes: checkTimeLimit(body.timeLimitMinutes), skills: strs(body.skills) }));
    }

    // Specialists
    const specFields = () => ({
      specialty: s(body.specialty),
      tool: s(body.tool),
      model: s(body.model),
      instructions: s(body.instructions),
      skills: strs(body.skills),
      timeLimitMinutes: checkTimeLimit(body.timeLimitMinutes),
    });
    if (!isGet && a === "specialists" && n === 1) return sendJson(res, 201, addSpecialist({ name: s(body.name), ...specFields() }));
    if (!isGet && a === "specialists" && b && c === "edit" && n === 3) return sendJson(res, 200, editSpecialist(b, specFields()));
    if (!isGet && a === "specialists" && b && c === "remove" && n === 3) return sendJson(res, 200, removeSpecialist(b));

    // Skills: import from a folder path on this computer, or from uploaded files.
    if (!isGet && a === "skills" && n === 1) {
      if (Array.isArray(body.files)) {
        const files = (body.files as unknown[]).map((f) => {
          const o = (f ?? {}) as Record<string, unknown>;
          if (typeof o.path !== "string" || typeof o.content !== "string") throw new ApiError(400, "invalid_upload", "Choose the skill folder again so all its files can be read.");
          return { path: o.path, content: o.content };
        });
        return sendJson(res, 201, importSkillFiles(files, tmpdir(), { name: s(body.name), replace: body.replace === true }));
      }
      return sendJson(res, 201, importSkill(requireFolder(need("path")), { name: s(body.name), replace: body.replace === true }));
    }
    if (!isGet && a === "skills" && b && c === "remove" && n === 3) return sendJson(res, 200, removeSkillEverywhere(b));

    if (isGet && a === "projects" && b && parts.length === 2) return sendJson(res, 200, projectView(b));
    if (isGet && a === "runs" && b && parts.length === 2) return sendJson(res, 200, runView(b));
    if (!isGet && a === "projects" && parts.length === 1) {
      const folder = requireFolder(need("path"));
      if (!isGitRepo(folder) && body.setUpTracking !== true) {
        throw new ApiError(409, "needs_tracking", "This folder isn't set up for tracking changes yet. Set it up now?");
      }
      if (isGitRepo(folder) && !hasCheckpoint(folder) && body.setUpTracking !== true) {
        throw new CodecError("needs_checkpoint", "repository has no commits yet", {}, 409);
      }
      if (body.setUpTracking === true) setUpTracking(folder);
      return sendJson(res, 201, addProject(folder, s(body.name)?.trim() || undefined));
    }
    if (!isGet && a === "projects" && b && c === "remove" && parts.length === 3) {
      return sendJson(res, 200, removeProjectChecked(b));
    }
    if (!isGet && a === "projects" && b && c === "runs" && parts.length === 3) {
      const member = s(body.member)?.trim() || undefined;
      const agent = s(body.agent)?.trim() || undefined;
      if (!member && !agent) throw new ApiError(400, "missing_tool", "Choose a team member or a tool before starting this task.");
      if (!getProject(b)) throw new CodecError("project_not_found", `no project named "${b}"`, {}, 404);
      const timeLimitMinutes = checkTimeLimit(body.timeLimitMinutes);
      const task = need("task");
      const ref = member ? parseMemberRef(member) : undefined;
      const tool = ref ? resolveMember(ref.team, ref.member).tool : checkTool(agent!);
      const setup = await checkSetup();
      const account = resolveAccount(tool, { helper: member, team: ref?.team, project: b });
      const signedIn = account.builtin ? setup.tools.some((entry) => entry.tool === tool && entry.signedIn === true) : await logins.signedIn(account.id, true);
      if (!account.builtin && !signedIn) throw new CodecError("account_needs_sign_in", S.errors.account_needs_sign_in, { name: account.name }, 409);
      if (logins.view(account.id)?.state === "waiting") throw new CodecError("account_login_busy", S.errors.account_login_busy, {}, 409);
      if (!setup.tools.some((entry) => entry.tool === tool && entry.installed) || !signedIn) {
        const label = tool === "claude" ? S.setup.claude : S.setup.codex;
        throw new CodecError("tool_unavailable", `${label} is not installed or signed in`, { tool: label }, 409);
      }
      return sendJson(res, 201, runSummary(startRun({ project: b, member, agent, task, timeLimitMinutes })));
    }
    if (!isGet && a === "runs" && b && c === "stop" && parts.length === 3) {
      return sendJson(res, 200, runSummary(stopRun(findRunOr404(b).runId)));
    }
    if (!isGet && a === "runs" && b && c === "clean" && parts.length === 3) {
      const r = cleanRun(findRunOr404(b).runId, { force: body.force === true, deleteBranch: body.deleteBranch === true });
      return sendJson(res, 200, runSummary(r));
    }
    throw new ApiError(404, "not_found", "That page could not be found. Refresh the dashboard and try again.");
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const { status, body } = friendlyError(e, (req.url ?? "/").split("?")[0]);
      if (!res.headersSent) sendJson(res, status, body);
      else res.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) => {
      reject(e.code === "EADDRINUSE" ? new CodecError("port_busy", `port ${port} is already in use — try --port <other>`) : e);
    });
    server.listen(port, HOST, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") port = addr.port;
      resolve({
        server,
        port,
        token,
        url: `http://${HOST}:${port}/?token=${token}`,
        close: async () => {
          await logins.close();
          await new Promise<void>((r) => {
            server.close(() => r());
            server.closeAllConnections();
          });
        },
      });
    });
  });
}
