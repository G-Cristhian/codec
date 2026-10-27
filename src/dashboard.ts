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

import { checkTimeLimit, formatTimeLimit } from "./limits.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { randomBytes, timingSafeEqual } from "crypto";
import { existsSync, readdirSync, readFileSync } from "fs";
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
  listSpecialists,
  listTeams,
  removeSkillEverywhere,
  removeSpecialist,
  resolveMember,
  setTeamProjects,
  skillHolders,
  type ResolvedMember,
} from "./org.js";
import { importSkill, importSkillFiles, listSkills } from "./skills.js";
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
import { renderPage, renderLocked } from "./ui.js";

export const DEFAULT_PORT = 4777;
export const HOST = "127.0.0.1";
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
  if (run.state === "done") return "inReview";
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
  if (!existsSync("/proc/self/stat")) return undefined;
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
    runId: r.runId,
    project: r.project,
    agent: r.agent,
    state: r.state,
    stateText: r.state === "timed_out" ? `Stopped: took longer than ${formatTimeLimit(r.timeLimitMinutes)}` : r.state,
    timeLimitMinutes: r.timeLimitMinutes,
    deadline: r.deadline,
    exitCode: r.exitCode,
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
  let r: ResolvedMember;
  try {
    r = resolveMember(team, member);
  } catch (e) {
    throw new HttpError(404, (e as Error).message);
  }
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
        return { team: t.name, member: m.name, kind: m.kind, specialist: m.specialist, error: (e as Error).message };
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
      label: `${sp.name} (${sp.specialty})`,
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
          label: `${t.name}/${m.name}` + (r.specialist ? ` (clone of ${r.specialist})` : " (worker)"),
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
  if (!project) throw new HttpError(404, `no project named "${name}"`);
  const lanes: Record<Lane, ReturnType<typeof runSummary>[]> = { working: [], needsYou: [], inReview: [], done: [] };
  for (const r of listRuns({ project: name }).reverse()) lanes[laneOf(r)].push(runSummary(r));
  // Who can be started here: members of every team assigned to this project.
  const members = listTeams()
    .filter((t) => t.projects.includes(name))
    .flatMap((t) =>
      t.members.map((m) => {
        try {
          const r = resolveMember(t.name, m.name);
          return { ref: `${t.name}/${m.name}`, tool: r.tool, label: `${t.name}/${m.name}` + (r.specialty ? ` — ${r.specialty}` : " — worker") };
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
    specialty: r.specialty,
    skillsGiven: (r.skills ?? []) as GivenSkill[],
    skillsUsed: skillsUsed(r.runId),
    log: runOutput(r.runId, LOG_LINES),
  };
}

// ---------- HTTP plumbing ----------

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function findRunOr404(ref: string): RunStatus {
  try {
    return findRun(ref);
  } catch (e) {
    throw new HttpError(404, (e as Error).message);
  }
}

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function send(res: ServerResponse, status: number, body: string, type: string, extra: Record<string, string> = {}) {
  res.writeHead(status, { ...BASE_HEADERS, "Content-Type": type, ...extra });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  send(res, status, JSON.stringify(data), "application/json; charset=utf-8");
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
        reject(new HttpError(413, "request body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf-8");
      if (!text.trim()) return resolve({});
      try {
        const v = JSON.parse(text);
        if (v && typeof v === "object" && !Array.isArray(v)) resolve(v as Record<string, unknown>);
        else reject(new HttpError(400, "body must be a JSON object"));
      } catch {
        reject(new HttpError(400, "body is not valid JSON"));
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

export function startDashboard(opts: { port?: number; token?: string } = {}): Promise<Dashboard> {
  const token = opts.token ?? randomBytes(24).toString("base64url");
  let port = opts.port ?? DEFAULT_PORT;
  const cookieName = () => `codec_token_${port}`;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 1. DNS-rebinding guard: only our own loopback host names.
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return send(res, 421, "Codec dashboard: unexpected Host header\n", "text/plain; charset=utf-8");
    }
    const url = new URL(req.url ?? "/", `http://${host}`);
    const path = url.pathname;
    const headerToken = s(req.headers["x-codec-token"]);
    const cookieToken = cookie(req, cookieName());

    // 2. The page. ?token=... (the printed link) sets the cookie, then
    //    redirects so the token doesn't linger in the address bar.
    if (path === "/" && req.method === "GET") {
      const q = url.searchParams.get("token") ?? undefined;
      if (q !== undefined) {
        if (!tokenEquals(q, token)) return send(res, 401, renderLocked(), "text/html; charset=utf-8");
        res.writeHead(303, {
          ...BASE_HEADERS,
          Location: "/",
          "Set-Cookie": `${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        });
        return void res.end();
      }
      if (!tokenEquals(cookieToken, token)) return send(res, 401, renderLocked(), "text/html; charset=utf-8");
      return send(res, 200, renderPage(token), "text/html; charset=utf-8", {
        "Content-Security-Policy":
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      });
    }

    if (!path.startsWith("/api/")) return sendJson(res, 404, { error: "not found" });

    // 3. API auth. Reads: header or cookie. Writes: POST + header + JSON.
    if (req.method === "GET") {
      if (!tokenEquals(headerToken, token) && !tokenEquals(cookieToken, token)) {
        return sendJson(res, 401, { error: "missing or wrong token" });
      }
    } else if (req.method === "POST") {
      if (!tokenEquals(headerToken, token)) return sendJson(res, 401, { error: "missing or wrong token" });
      if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
        return sendJson(res, 415, { error: "Content-Type must be application/json" });
      }
    } else {
      return sendJson(res, 405, { error: "method not allowed" });
    }

    const parts = path.split("/").slice(2).map(decodeURIComponent); // after "/api/"
    const isGet = req.method === "GET";
    const body = isGet ? {} : await readBody(req, path === "/api/skills" ? MAX_UPLOAD : MAX_BODY);
    const need = (k: string): string => {
      const v = s(body[k]);
      if (!v || !v.trim()) throw new HttpError(400, `"${k}" is required`);
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
      if (!getTeam(b)) throw new HttpError(404, `no team named "${b}"`);
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
      return sendJson(res, 200, editMember(b, d2, { timeLimitMinutes: checkTimeLimit(body.timeLimitMinutes) }));
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
          if (typeof o.path !== "string" || typeof o.content !== "string") throw new HttpError(400, "each file needs path and content");
          return { path: o.path, content: o.content };
        });
        return sendJson(res, 201, importSkillFiles(files, tmpdir()));
      }
      return sendJson(res, 201, importSkill(need("path")));
    }
    if (!isGet && a === "skills" && b && c === "remove" && n === 3) return sendJson(res, 200, removeSkillEverywhere(b));

    if (isGet && a === "projects" && b && parts.length === 2) return sendJson(res, 200, projectView(b));
    if (isGet && a === "runs" && b && parts.length === 2) return sendJson(res, 200, runView(b));
    if (!isGet && a === "projects" && parts.length === 1) {
      return sendJson(res, 201, addProject(need("path"), s(body.name)?.trim() || undefined));
    }
    if (!isGet && a === "projects" && b && c === "remove" && parts.length === 3) {
      return sendJson(res, 200, removeProjectChecked(b));
    }
    if (!isGet && a === "projects" && b && c === "runs" && parts.length === 3) {
      const member = s(body.member)?.trim() || undefined;
      const agent = s(body.agent)?.trim() || undefined;
      if (!member && !agent) throw new HttpError(400, '"member" or "agent" is required');
      return sendJson(res, 201, runSummary(startRun({ project: b, member, agent, task: need("task"), timeLimitMinutes: checkTimeLimit(body.timeLimitMinutes) })));
    }
    if (!isGet && a === "runs" && b && c === "stop" && parts.length === 3) {
      return sendJson(res, 200, runSummary(stopRun(findRunOr404(b).runId)));
    }
    if (!isGet && a === "runs" && b && c === "clean" && parts.length === 3) {
      const r = cleanRun(findRunOr404(b).runId, { force: body.force === true, deleteBranch: body.deleteBranch === true });
      return sendJson(res, 200, runSummary(r));
    }
    return sendJson(res, 404, { error: "not found" });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 400; // engine errors are user errors
      if (!res.headersSent) sendJson(res, status, { error: e instanceof Error ? e.message : String(e) });
      else res.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) => {
      reject(e.code === "EADDRINUSE" ? new Error(`port ${port} is already in use — try --port <other>`) : e);
    });
    server.listen(port, HOST, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") port = addr.port;
      resolve({
        server,
        port,
        token,
        url: `http://${HOST}:${port}/?token=${token}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
            server.closeAllConnections();
          }),
      });
    });
  });
}
