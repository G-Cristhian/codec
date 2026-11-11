import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "http";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { startDashboard, type Dashboard } from "../src/dashboard.js";
import { CodecError } from "../src/errors.js";
import { S, wording } from "../src/strings.js";
import { friendlyError } from "../src/friendly.js";
import { getProject, git } from "../src/registry.js";
import { getSpecialist, getTeam, resolveMember } from "../src/org.js";
import { getSkill } from "../src/skills.js";
import { listRuns, stopRun } from "../src/runs.js";
import { projectsFile, specialistsFile } from "../src/store.js";
import type { CommandRunner } from "../src/setup.js";
import { cleanupTemps, makeRepo, tempDir, useIsolatedHome, waitFor } from "./helpers.js";

const runner: CommandRunner = async (_command, args) => ({ status: 0, stdout: args[0] === "--version" ? "v1.0" : '{"loggedIn":true}' });
let d: Dashboard;
let home: string;
interface RequestOptions { raw?: string; token?: string | null; cookie?: boolean; type?: string; host?: string }
function call(method: string, path: string, body?: unknown, opts: RequestOptions = {}) {
  const payload = opts.raw ?? (body === undefined ? undefined : JSON.stringify(body));
  const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${d.port}` };
  const token = opts.token === undefined ? d.token : opts.token;
  if (token) headers["x-codec-token"] = token;
  if (payload !== undefined) headers["content-type"] = opts.type ?? "application/json";
  if (opts.cookie) headers.cookie = `codec_token_${d.port}=${d.token}`;
  return new Promise<{ status: number; json: any; text: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: d.port, method, path, headers }, (res) => {
      let text = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, text, json: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}
const get = (path: string) => call("GET", path);
const post = (path: string, body: unknown = {}) => call("POST", path, body);
const preview = (kind: string, name: string) => get(`/api/remove-preview?kind=${kind}&name=${encodeURIComponent(name)}`);
function skillFolder(name = "review") {
  const dir = tempDir();
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Review changes\n---\nRead the diff.\n`);
  return dir;
}
async function project(name = "alpha") {
  const repo = makeRepo(name);
  expect((await post("/api/projects", { path: repo, name })).status).toBe(201);
  return repo;
}
async function team() {
  await project();
  expect((await post("/api/teams", { name: "Alpha", projects: ["alpha"] })).status).toBe(201);
}
beforeEach(async () => {
  home = useIsolatedHome("sleep 30");
  d = await startDashboard({ port: 0, setup: { runner, findBinary: (tool) => tool } });
});
afterEach(async () => {
  await d.close();
  for (const run of listRuns({ state: "running" })) stopRun(run.runId);
  vi.unstubAllEnvs();
  cleanupTemps();
});

describe("Stage A project and folder API", () => {
  it("requires explicit tracking setup, registers with it, and preserves source files", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "notes.txt"), "keep");
    const blocked = await post("/api/projects", { path: dir, name: "new-project" });
    expect(blocked).toMatchObject({ status: 409, json: { code: "needs_tracking", error: "This folder isn't set up for tracking changes yet. Set it up now?" } });
    expect(existsSync(join(dir, ".git"))).toBe(false);
    const created = await post("/api/projects", { path: dir, name: "new-project", setUpTracking: true });
    expect(created).toMatchObject({ status: 201, json: { name: "new-project", path: dir } });
    expect(git(dir, ["rev-parse", "HEAD"]).ok).toBe(true);
    expect(readFileSync(join(dir, "notes.txt"), "utf-8")).toBe("keep");
    expect((await get("/api/projects")).json).toHaveLength(1);
    expect((await get("/api/projects/new-project")).json.project.name).toBe("new-project");
    expect((await post("/api/projects/new-project/remove")).status).toBe(200);
    expect(getProject("new-project")).toBeUndefined();
    expect(existsSync(dir)).toBe(true);
  });
  it("can prepare an existing uncommitted repo", async () => {
    const dir = tempDir();
    execFileSync("git", ["init", "-q", dir]);
    expect((await post("/api/projects", { path: dir, name: "empty", setUpTracking: true })).status).toBe(201);
    expect(git(dir, ["rev-parse", "HEAD"]).ok).toBe(true);
  });
  it("browses folders with correct markers", async () => {
    const dir = tempDir();
    const child = join(dir, "skill");
    mkdirSync(child);
    mkdirSync(join(dir, ".hidden"));
    writeFileSync(join(child, "SKILL.md"), "skill");
    const result = await get(`/api/folders?path=${encodeURIComponent(dir)}`);
    expect(result).toMatchObject({ status: 200, json: { path: dir, parent: join(dir, ".."), isGit: false, hasSkill: false,
      folders: [{ name: "skill", path: child, isGit: false, hasSkill: true }] } });
  });
  it("returns folder errors for missing folders, files, and relative paths on new routes", async () => {
    const dir = tempDir();
    const file = join(dir, "file");
    writeFileSync(file, "file");
    for (const [path, code] of [[join(dir, "missing"), "folder_not_found"], [file, "not_a_folder"], ["relative", "invalid_path"]]) {
      for (const result of [await get(`/api/folders?path=${encodeURIComponent(path)}`), await post("/api/projects", { path }), await post("/api/skills", { path })]) {
        expect(result.json.code).toBe(code);
        expect(result.status).toBeGreaterThanOrEqual(400);
      }
    }
  });
});

describe("Stage A specialists, teams, members and skills", () => {
  it("creates, edits and removes specialists including every editable setting", async () => {
    await post("/api/skills", { path: skillFolder() });
    const create = await post("/api/specialists", { name: "reviewer", specialty: "review", tool: "claude", instructions: "Read carefully", model: "first", skills: ["review"], timeLimitMinutes: 15 });
    expect(create.status).toBe(201);
    expect(create.json).toMatchObject({ instructions: "Read carefully", skills: ["review"], timeLimitMinutes: 15 });
    const edit = await post("/api/specialists/reviewer/edit", { specialty: "test", tool: "codex", instructions: "Run tests", model: "second", skills: [], timeLimitMinutes: 7.5 });
    expect(edit.status).toBe(200);
    expect(getSpecialist("reviewer")).toMatchObject({ specialty: "test", tool: "codex", model: "second", instructions: "Run tests", skills: [], timeLimitMinutes: 7.5 });
    expect((await get("/api/specialists")).json).toHaveLength(1);
    expect((await post("/api/specialists/reviewer/remove")).status).toBe(200);
    expect(getSpecialist("reviewer")).toBeUndefined();
  });
  it("creates, edits and removes teams and members with extra skills and time limits", async () => {
    await team();
    await project("beta");
    await post("/api/skills", { path: skillFolder() });
    await post("/api/specialists", { name: "reviewer", specialty: "review", tool: "claude", skills: ["review"] });
    const clone = await post("/api/teams/Alpha/members", { name: "copy", specialist: "reviewer", timeLimitMinutes: 12 });
    expect(clone).toMatchObject({ status: 201, json: { kind: "clone", specialist: "reviewer", timeLimitMinutes: 12 } });
    const worker = await post("/api/teams/Alpha/members", { name: "worker", tool: "codex", skills: ["review"], model: "test-model", timeLimitMinutes: 20 });
    expect(worker).toMatchObject({ status: 201, json: { kind: "worker", skills: ["review"], model: "test-model" } });
    expect((await post("/api/teams/Alpha/members/copy/edit", { skills: ["review"], timeLimitMinutes: 3 })).status).toBe(200);
    expect(getTeam("Alpha")?.members.find((m) => m.name === "copy")).toMatchObject({ skills: ["review"], timeLimitMinutes: 3 });
    expect((await post("/api/teams/Alpha/members/worker/edit", { skills: [], timeLimitMinutes: 4 })).status).toBe(200);
    expect(resolveMember("Alpha", "worker")).toMatchObject({ skills: [], timeLimitMinutes: 4 });
    expect((await post("/api/teams/Alpha/projects", { projects: ["beta"] })).json.projects).toEqual(["beta"]);
    expect((await get("/api/members/Alpha/copy")).json.skills).toEqual([{ name: "review", source: "specialist" }]);
    expect((await get("/api/teams")).json).toHaveLength(1);
    expect((await post("/api/teams/Alpha/members/copy/remove")).status).toBe(200);
    expect((await post("/api/teams/Alpha/members/worker/remove")).status).toBe(200);
    expect((await post("/api/teams/Alpha/remove")).status).toBe(200);
    expect(getTeam("Alpha")).toBeUndefined();
  });
  it("imports skills by path and upload and unassigns removed skills everywhere", async () => {
    await team();
    expect((await post("/api/skills", { path: skillFolder() })).status).toBe(201);
    await post("/api/specialists", { name: "reviewer", specialty: "review", tool: "claude", skills: ["review"] });
    await post("/api/teams/Alpha/members", { name: "worker", tool: "codex", skills: ["review"] });
    const content = Buffer.from("---\nname: uploaded\ndescription: An upload\n---\nInstructions").toString("base64");
    expect((await post("/api/skills", { files: [{ path: "uploaded/SKILL.md", content }] })).status).toBe(201);
    expect((await get("/api/skills")).json.skills).toHaveLength(2);
    expect((await post("/api/skills/review/remove")).status).toBe(200);
    expect(getSkill("review")).toBeUndefined();
    expect(getSpecialist("reviewer")?.skills).toEqual([]);
    expect(resolveMember("Alpha", "worker").skills).toEqual([]);
    expect((await post("/api/skills/uploaded/remove")).status).toBe(200);
  });
  it("returns the exact no_skill_file response", async () => {
    expect(await post("/api/skills", { path: tempDir() })).toMatchObject({ status: 400, json: { code: "no_skill_file",
      error: S.errors.no_skill_file } });
  });
  it("rejects invalid skills, duplicate names and invalid time limits without changing saved values", async () => {
    await team();
    await post("/api/specialists", { name: "reviewer", specialty: "review", tool: "claude", timeLimitMinutes: 10 });
    await post("/api/teams/Alpha/members", { name: "worker", tool: "codex", timeLimitMinutes: 10 });
    expect((await post("/api/teams/Alpha/members/worker/edit", { skills: ["missing"] })).json.code).toBe("invalid_skill");
    expect((await post("/api/specialists/reviewer/edit", { skills: ["missing"] })).json.code).toBe("invalid_skill");
    expect((await post("/api/teams", { name: "Alpha", projects: ["alpha"] })).json.code).toBe("team_exists");
    expect((await post("/api/projects", { path: getProject("alpha")!.path })).json.code).toBe("project_exists");
    for (const value of [0, -1, 1441, "5", null]) {
      for (const path of ["/api/specialists/reviewer/edit", "/api/teams/Alpha/members/worker/edit", "/api/projects/alpha/runs"]) {
        const result = await post(path, { timeLimitMinutes: value, agent: "claude", task: "x" });
        expect(result).toMatchObject({ status: 400, json: { code: "invalid_time_limit" } });
      }
    }
    expect(getSpecialist("reviewer")?.timeLimitMinutes).toBe(10);
    expect(resolveMember("Alpha", "worker").timeLimitMinutes).toBe(10);
  });
});

describe("removal previews and runs", () => {
  it("previews each kind and respects specialist copies and inherited skills", async () => {
    await team();
    await post("/api/skills", { path: skillFolder() });
    await post("/api/specialists", { name: "reviewer", specialty: "review", tool: "claude", skills: ["review"] });
    await post("/api/teams/Alpha/members", { name: "copy", specialist: "reviewer" });
    for (const [kind, name] of [["project", "alpha"], ["team", "Alpha"], ["member", "Alpha/copy"], ["skill", "review"], ["specialist", "reviewer"]]) {
      const result = await preview(kind, name);
      expect(result).toMatchObject({ status: 200, json: { kind, name, blocked: kind === "specialist" } });
      expect(result.json.effects.length).toBeGreaterThan(0);
      expect(result.json.effects.every((effect: any) => typeof effect.what === "string")).toBe(true);
      expect(result.json.blockedReason).toEqual(kind === "specialist" ? expect.any(String) : undefined);
    }
    expect((await preview("project", "alpha")).json.effects).toContainEqual({ what: wording(S.wording.teamEffect, { name: "Alpha" }) });
    expect((await preview("skill", "review")).json.effects).toContainEqual({ what: wording(S.wording.helpersLose, { count: 1 }) });
    expect((await post("/api/specialists/reviewer/remove")).json.code).toBe("specialist_in_use");
    await post("/api/teams/Alpha/members/copy/remove");
    expect((await preview("specialist", "reviewer")).json.blocked).toBe(false);
  });
  it("previews and enforces running task blockers for project, team and member, then retains history", async () => {
    await team();
    await post("/api/teams/Alpha/members", { name: "worker", tool: "codex" });
    const started = await post("/api/projects/alpha/runs", { member: "Alpha/worker", task: "wait" });
    expect(started.status).toBe(201);
    const id = started.json.runId;
    expect((await get("/api/runs")).json).toHaveLength(1);
    expect((await get(`/api/runs/${id}`)).json.state).toBe("running");
    for (const [kind, name, path, code] of [["project", "alpha", "/api/projects/alpha/remove", "project_busy"], ["team", "Alpha", "/api/teams/Alpha/remove", "team_busy"], ["member", "Alpha/worker", "/api/teams/Alpha/members/worker/remove", "member_busy"]]) {
      expect((await preview(kind, name)).json).toMatchObject({ blocked: true, blockedReason: expect.any(String) });
      expect((await post(path)).json.code).toBe(code);
    }
    expect((await post(`/api/runs/${id}/stop`)).json.state).toBe("stopped");
    for (const [kind, name] of [["project", "alpha"], ["team", "Alpha"], ["member", "Alpha/worker"]]) {
      const result = (await preview(kind, name)).json;
      expect(result.blocked).toBe(false);
      expect(result.effects).toContainEqual({ what: wording(S.wording.history, { count: 1 }) });
    }
    expect((await post(`/api/runs/${id}/clean`, { force: true, deleteBranch: true })).json.lane).toBe("done");
    expect((await post("/api/projects/alpha/remove")).status).toBe(200);
    expect(getTeam("Alpha")?.projects).toEqual([]);
    expect((await get(`/api/runs/${id}`)).json.state).toBe("stopped");
  });
  it("starts quick runs and preserves completed tasks after cleanup", async () => {
    await project();
    process.env.CODEC_AGENT_COMMAND = "echo complete";
    const started = await post("/api/projects/alpha/runs", { agent: "claude", task: "complete", timeLimitMinutes: 1 });
    expect(started.status).toBe(201);
    await waitFor(started.json.runId);
    expect((await preview("project", "alpha")).json.effects).toContainEqual({ what: wording(S.wording.history, { count: 1 }) });
    expect((await post(`/api/runs/${started.json.runId}/clean`)).json.lane).toBe("done");
  });
  it("requires explicit force to discard unsaved task changes", async () => {
    await project();
    process.env.CODEC_AGENT_COMMAND = "echo complete";
    const started = await post("/api/projects/alpha/runs", { agent: "codex", task: "complete" });
    const run = await waitFor(started.json.runId);
    writeFileSync(join(run.worktree, "README.md"), "unsaved changes");
    const blocked = await post(`/api/runs/${run.runId}/clean`);
    expect(blocked).toMatchObject({ status: 400, json: { code: "uncommitted_changes", error: expect.stringContaining("unsaved changes") } });
    expect(readFileSync(join(run.worktree, "README.md"), "utf-8")).toBe("unsaved changes");
    expect((await post(`/api/runs/${run.runId}/clean`, { force: true })).json.lane).toBe("done");
  });
  it("rejects invalid kinds and missing items for every preview kind", async () => {
    expect((await preview("invalid", "x")).json.code).toBe("invalid_kind");
    for (const [kind, name] of [["project", "missing"], ["team", "missing"], ["member", "missing/person"], ["specialist", "missing"], ["skill", "missing"]]) {
      expect((await preview(kind, name)).status).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("setup API", () => {
  it("never asks the page to open setup by itself, and persists finishing across restarts", async () => {
    expect((await get("/api/setup")).json).toMatchObject({ ready: true });
    expect((await get("/api/setup")).json).not.toHaveProperty("shouldOpen");
    expect((await get("/api/settings")).json.setupFinished).toBe(false);
    expect((await call("POST", "/api/settings", { setupFinished: true }, { token: null, cookie: true })).status).toBe(401);
    expect((await get("/api/settings")).json.setupFinished).toBe(false);
    expect((await post("/api/settings", { setupFinished: true })).json.setupFinished).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf-8")).setupFinished).toBe(true);
    await d.close();
    d = await startDashboard({ port: 0, setup: { runner, findBinary: (tool) => tool } });
    expect((await get("/api/settings")).json.setupFinished).toBe(true);
    const identity = { name: "Setup Owner", email: "setup@example.invalid" };
    await post("/api/settings", { identity });
    expect((await get("/api/settings")).json).toEqual({ identity, setupFinished: true });
  });
  it("treats an existing project as finished setup and remembers that after removal", async () => {
    await project();
    expect((await get("/api/settings")).json.setupFinished).toBe(true);
    expect((await post("/api/projects/alpha/remove")).status).toBe(200);
    expect((await get("/api/settings")).json.setupFinished).toBe(true);
  });
  it("treats existing helpers as finished setup without requiring projects", async () => {
    await team();
    expect((await post("/api/teams/Alpha/members", { name: "helper", tool: "codex" })).status).toBe(201);
    expect((await post("/api/projects/alpha/remove")).status).toBe(200);
    expect((await get("/api/settings")).json.setupFinished).toBe(true);
    expect((await get("/api/settings")).json.setupFinished).toBe(true);
  });
  it("returns tools, readiness, cached results, and fresh rechecks", async () => {
    await d.close();
    const mock = vi.fn<CommandRunner>(runner);
    d = await startDashboard({ port: 0, setup: { runner: mock, findBinary: (tool) => tool === "codex" ? tool : undefined } });
    const result = await get("/api/setup");
    expect(result).toMatchObject({ status: 200, json: { ready: true, tools: [{ tool: "claude", installed: false, signedIn: null }, { tool: "codex", installed: true, signedIn: true }] } });
    await get("/api/setup");
    expect(mock).toHaveBeenCalledTimes(2);
    await get("/api/setup?fresh=1");
    expect(mock).toHaveBeenCalledTimes(4);
  });
  for (const tool of ["claude", "codex"]) {
    it(`returns 409 tool_unavailable for missing ${tool}, including member runs`, async () => {
      await team();
      await post("/api/teams/Alpha/members", { name: "worker", tool });
      await d.close();
      d = await startDashboard({ port: 0, setup: { runner, findBinary: () => undefined } });
      for (const body of [{ agent: tool, task: "x" }, { member: "Alpha/worker", task: "x" }]) {
        const result = await post("/api/projects/alpha/runs", body);
        expect(result).toMatchObject({ status: 409, json: { code: "tool_unavailable", error: expect.stringContaining("Open Setup") } });
        expect(listRuns()).toEqual([]);
      }
    });
  }
});

describe("security and error envelopes", () => {
  const reads = ["/api/settings", "/api/setup", "/api/setup?fresh=1", "/api/folders", "/api/remove-preview?kind=project&name=missing", "/api/projects", "/api/runs"];
  for (const path of reads) {
    it(`${path}: requires token and local Host`, async () => {
      expect((await call("GET", path, undefined, { token: null })).json.code).toBe("unauthorized");
      expect((await call("GET", path, undefined, { host: "evil.example" })).json.code).toBe("unexpected_host");
      expect((await call("DELETE", path)).status).toBe(405);
    });
  }
  it("allows cookie reads, but requires POST, JSON and header for every write action", async () => {
    expect((await call("POST", "/api/settings", {}, { token: null, cookie: true })).status).toBe(401);
    expect((await call("POST", "/api/settings", {}, { type: "text/plain" })).status).toBe(415);
    expect((await call("GET", "/api/setup", undefined, { token: null, cookie: true })).status).toBe(200);
    const writes = ["/api/projects", "/api/projects/alpha/remove", "/api/projects/alpha/runs", "/api/skills", "/api/skills/review/remove", "/api/specialists", "/api/specialists/reviewer/edit", "/api/specialists/reviewer/remove", "/api/teams", "/api/teams/Alpha/projects", "/api/teams/Alpha/remove", "/api/teams/Alpha/members", "/api/teams/Alpha/members/worker/edit", "/api/teams/Alpha/members/worker/remove", "/api/runs/test/stop", "/api/runs/test/clean"];
    for (const path of writes) {
      expect((await call("POST", path, {}, { token: null, cookie: true })).status).toBe(401);
      expect((await call("POST", path, {}, { type: "text/plain" })).status).toBe(415);
      expect((await call("POST", path, {}, { type: "application/jsonp" })).status).toBe(415);
      expect((await call("PUT", path, {})).status).toBe(405);
      // Collection GETs are reads. Action endpoints cannot mutate on GET.
      if (/\/(remove|edit|projects|members|runs|stop|clean)$/.test(path) && path.split("/").length > 3) {
        expect((await get(path)).status).toBeGreaterThanOrEqual(400);
      }
    }
  });
  it("returns bounded, friendly errors for bad JSON, huge bodies, bad URLs and unknown routes", async () => {
    for (const raw of ["{", "[]", "null", '"text"']) {
      expect((await call("POST", "/api/projects", undefined, { raw })).json.code).toBe("bad_json");
    }
    expect((await post("/api/projects", { path: "x".repeat(70 * 1024) })).json.code).toBe("body_too_large");
    expect((await post("/api/skills", { files: [], padding: "x".repeat(8 * 1024 * 1024) })).json.code).toBe("body_too_large");
    expect((await get("/api/projects/%ZZ")).json.code).toBe("bad_request");
    expect((await get("/api/not-a-route")).json.code).toBe("not_found");
    expect((await post("/api/setup")).status).toBe(404);
    expect((await post("/api/folders")).status).toBe(404);
    expect((await post("/api/remove-preview")).status).toBe(404);
  });
  it("logs technical detail and never sends stack traces or filesystem errors", async () => {
    writeFileSync(projectsFile(), "broken state with private-detail");
    const result = await get("/api/state");
    expect(result.status).toBe(500);
    expect(Object.keys(result.json).sort()).toEqual(["code", "error"]);
    expect(result.json.code).toBe("unknown_error");
    expect(result.text).not.toMatch(/SyntaxError|private-detail|at .*\.ts|ENOENT|errno|exit code|stack/);
    const log = readFileSync(join(home, "codec.log"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    expect(log.at(-1)).toMatchObject({ ts: expect.any(String), route: "/api/state", code: "unknown_error", detail: expect.stringContaining("SyntaxError") });
    writeFileSync(projectsFile(), '{"projects":[]}');
  });
  it("uses typed codes and never classifies arbitrary error text", () => {
    const raw = 'no project named "secret"';
    expect(friendlyError(new Error(raw), "/api/test").body.code).toBe("unknown_error");
    const result = friendlyError(new CodecError("project_not_found", "completely reworded private detail"), "/api/test");
    expect(result.body).toEqual({ code: "project_not_found", error: S.errors.project_not_found });
    expect(readFileSync(join(home, "codec.log"), "utf-8")).toContain("completely reworded private detail");
  });
});

describe("checkpoint identity settings API", () => {
  it("reads and saves the owner identity and uses it for starting checkpoints", async () => {
    vi.stubEnv("GIT_CONFIG_GLOBAL", join(tempDir(), "no-global-config"));
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    expect((await get("/api/settings")).json).toEqual({ identity: { name: "", email: "" }, setupFinished: false });
    expect((await get("/api/setup")).json.identityReady).toBe(false);
    const identity = { name: "Codec Owner", email: "owner@example.invalid" };
    expect(await post("/api/settings", { identity })).toMatchObject({ status: 200, json: { identity } });
    expect((await get("/api/settings")).json).toEqual({ identity, setupFinished: false });
    expect((await get("/api/setup")).json.identityReady).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf-8"))).toEqual({ identity });
    const dir = tempDir();
    expect((await post("/api/projects", { path: dir, name: "starting", setUpTracking: true })).status).toBe(201);
    expect(git(dir, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"]).out)
      .toBe("Codec Owner <owner@example.invalid>|Codec Owner <owner@example.invalid>");
    expect((await post("/api/settings", { identity: { name: "", email: "bad" } })).json.code).toBe("invalid_identity");
    expect((await get("/api/settings")).json).toEqual({ identity, setupFinished: true });
  });
  it("returns identity_missing with a Setup fix and starts successfully after it is saved", async () => {
    vi.stubEnv("GIT_CONFIG_GLOBAL", join(tempDir(), "no-global-config"));
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    const repo = await project();
    git(repo, ["config", "--unset", "user.name"]);
    git(repo, ["config", "--unset", "user.email"]);
    expect(await post("/api/projects/alpha/runs", { agent: "claude", task: "Check" })).toMatchObject({ status: 409,
      json: { code: "identity_missing", error: S.errors.identity_missing } });
    expect(listRuns()).toEqual([]);
    await post("/api/settings", { identity: { name: "Owner", email: "owner@example.invalid" } });
    process.env.CODEC_AGENT_COMMAND = "true";
    const started = await post("/api/projects/alpha/runs", { agent: "claude", task: "Check" });
    expect(started.status).toBe(201);
    await waitFor(started.json.runId);
  });
});

describe("Wave 2 checkpoint and source preservation", () => {
  it("offers a starting checkpoint for tracked folders and starts with their existing files", async () => {
    await post("/api/settings", { identity: { name: "Project Owner", email: "owner@example.invalid" } });
    const dir = tempDir();
    execFileSync("git", ["init", "-q", dir]);
    writeFileSync(join(dir, "existing.txt"), "first task needs this");
    writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(dir, "ignored.txt"), "keep here");
    expect(await post("/api/projects", { path: dir, name: "new" })).toMatchObject({ status: 409, json: { code: "needs_checkpoint", error: S.errors.needs_checkpoint } });
    expect(git(dir, ["rev-parse", "--verify", "HEAD"]).ok).toBe(false);
    expect((await post("/api/projects", { path: dir, name: "new", setUpTracking: true })).status).toBe(201);
    const started = await post("/api/projects/new/runs", { agent: "codex", task: "read existing files" });
    expect(started.status).toBe(201);
    const detail = (await get(`/api/runs/${started.json.runId}`)).json;
    expect(readFileSync(join(detail.worktree, "existing.txt"), "utf-8")).toBe("first task needs this");
    expect(existsSync(join(detail.worktree, "ignored.txt"))).toBe(false);
    expect(detail).not.toHaveProperty("exitCode");
    expect((await post(`/api/runs/${detail.runId}/clean`)).json.code).toBe("run_busy");
    expect((await post(`/api/runs/${detail.runId}/stop`)).status).toBe(200);
    expect((await post(`/api/runs/${detail.runId}/stop`)).json.code).toBe("run_not_running");
    expect((await post(`/api/runs/${detail.runId}/clean`)).status).toBe(200);
    expect((await post(`/api/runs/${detail.runId}/clean`)).json.code).toBe("already_cleaned");
  });
  it("imports a copy and removal via API leaves the entire original byte-identical", async () => {
    const dir = skillFolder();
    const extra = Buffer.from([0, 1, 255, 10, 127]);
    writeFileSync(join(dir, "extra.bin"), extra);
    const before = readFileSync(join(dir, "SKILL.md"));
    const added = await post("/api/skills", { path: dir });
    expect(added.status).toBe(201);
    const copy = getSkill("review")!.path;
    expect(copy).not.toBe(dir);
    expect(copy.startsWith(join(home, "skills"))).toBe(true);
    expect(readFileSync(join(copy, "SKILL.md"))).toEqual(before);
    expect(readFileSync(join(copy, "extra.bin"))).toEqual(extra);
    expect((await preview("skill", "review")).json.effects).toContainEqual({ what: S.wording.originalKept });
    expect((await post("/api/skills/review/remove")).status).toBe(200);
    expect(existsSync(copy)).toBe(false);
    expect(existsSync(dir)).toBe(true);
    expect(readFileSync(join(dir, "SKILL.md"))).toEqual(before);
    expect(readFileSync(join(dir, "extra.bin"))).toEqual(extra);
  });
  it("accepts a suggested skill name in Codec's copy without changing its original", async () => {
    const dir = skillFolder("Bad Skill!");
    const original = readFileSync(join(dir, "SKILL.md"));
    await post("/api/skills", { path: skillFolder("bad-skill") });
    const invalid = await post("/api/skills", { path: dir });
    expect(invalid.json).toMatchObject({ code: "invalid_skill_name", suggestion: "bad-skill-2" });
    expect((await post("/api/skills", { path: dir, name: invalid.json.suggestion })).status).toBe(201);
    expect(getSkill("bad-skill-2")?.name).toBe("bad-skill-2");
    await post("/api/skills/bad-skill-2/remove");
    expect(readFileSync(join(dir, "SKILL.md"))).toEqual(original);
  });
  it("replaces only Codec's copy after explicit replacement, preserving role choices and source files", async () => {
    const original = skillFolder();
    const replacement = skillFolder();
    writeFileSync(join(replacement, "extra.txt"), "new instructions");
    await post("/api/skills", { path: original });
    await post("/api/specialists", { name: "tester", specialty: "test", tool: "claude", skills: ["review"] });
    expect((await post("/api/skills", { path: replacement })).json.code).toBe("skill_exists");
    expect((await post("/api/skills", { path: replacement, replace: true })).status).toBe(201);
    expect(getSpecialist("tester")?.skills).toEqual(["review"]);
    expect(readFileSync(join(getSkill("review")!.path, "extra.txt"), "utf-8")).toBe("new instructions");
    await post("/api/skills/review/remove");
    expect(existsSync(join(original, "SKILL.md"))).toBe(true);
    expect(readFileSync(join(replacement, "extra.txt"), "utf-8")).toBe("new instructions");
  });
});

describe("Wave 2 domain error API paths", () => {
  beforeEach(async () => {
    await team();
    await post("/api/specialists", { name: "reviewer", specialty: "review", tool: "claude" });
    await post("/api/teams/Alpha/members", { name: "worker", tool: "codex" });
  });
  const cases: [string, string, unknown, string][] = [
    ["GET", "/api/projects/missing", undefined, "project_not_found"],
    ["GET", "/api/runs/missing", undefined, "run_not_found"],
    ["GET", "/api/members/missing/helper", undefined, "team_not_found"],
    ["GET", "/api/members/Alpha/missing", undefined, "member_not_found"],
    ["POST", "/api/projects/missing/remove", {}, "project_not_found"],
    ["POST", "/api/teams/missing/remove", {}, "team_not_found"],
    ["POST", "/api/teams/missing/projects", { projects: ["alpha"] }, "team_not_found"],
    ["POST", "/api/teams/Alpha/projects", { projects: ["missing"] }, "project_not_found"],
    ["POST", "/api/teams/Alpha/projects", {}, "missing_project"],
    ["POST", "/api/teams/Alpha/members/missing/remove", {}, "member_not_found"],
    ["POST", "/api/teams/Alpha/members/missing/edit", {}, "member_not_found"],
    ["POST", "/api/teams/missing/members/worker/edit", {}, "team_not_found"],
    ["POST", "/api/teams/missing/members", { tool: "claude" }, "team_not_found"],
    ["POST", "/api/teams/Alpha/members", { name: "worker", tool: "claude" }, "member_exists"],
    ["POST", "/api/teams/Alpha/members", { specialist: "missing" }, "specialist_not_found"],
    ["POST", "/api/teams/Alpha/members", { specialist: "reviewer", tool: "codex" }, "role_tool_mismatch"],
    ["POST", "/api/teams/Alpha/members", { tool: "missing" }, "invalid_tool"],
    ["POST", "/api/specialists/missing/edit", {}, "specialist_not_found"],
    ["POST", "/api/specialists/missing/remove", {}, "specialist_not_found"],
    ["POST", "/api/specialists", { name: "reviewer", specialty: "review", tool: "claude" }, "specialist_exists"],
    ["POST", "/api/specialists", { name: "new", tool: "claude" }, "missing_specialty"],
    ["POST", "/api/specialists/reviewer/edit", { specialty: "" }, "missing_specialty"],
    ["POST", "/api/specialists/reviewer/edit", { model: "not a model" }, "invalid_model"],
    ["POST", "/api/skills/missing/remove", {}, "invalid_skill"],
    ["POST", "/api/skills", { files: [] }, "invalid_upload"],
    ["POST", "/api/skills", { files: [{ path: "../bad", content: "a" }] }, "invalid_upload"],
    ["POST", "/api/skills", { files: [{ path: "bad" }] }, "invalid_upload"],
    ["POST", "/api/projects", {}, "missing_path"],
    ["POST", "/api/projects/alpha/runs", { task: "test" }, "missing_tool"],
    ["POST", "/api/projects/alpha/runs", { agent: "codex" }, "missing_task"],
    ["POST", "/api/projects/alpha/runs", { member: "broken", task: "test" }, "invalid_member"],
    ["POST", "/api/projects/alpha/runs", { member: "Alpha/worker", agent: "claude", task: "test" }, "tool_mismatch"],
    ["POST", "/api/projects/alpha/runs", { agent: "missing", task: "test" }, "invalid_tool"],
    ["POST", "/api/runs/missing/stop", {}, "run_not_found"],
    ["POST", "/api/runs/missing/clean", {}, "run_not_found"],
  ];
  it.each(cases)("%s %s returns %s", async (method, path, body, code) => {
    const result = await call(method, path, body);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.json.code).toBe(code);
    expect(result.json.error).toBe(wording(S.errors[code as keyof typeof S.errors], result.json.params));
    expect(result.text).not.toMatch(/stack|errno|exitCode|see: codec/);
  });
  it("suggests valid unused names for projects, roles, teams and team helpers", async () => {
    const repo = makeRepo("second");
    const inputs: [string, object, string, object][] = [
      ["/api/projects", { path: repo, name: "Bad Project!" }, "bad-project", { path: repo, name: "bad-project" }],
      ["/api/specialists", { name: "Bad Role!", specialty: "review", tool: "claude" }, "bad-role", { name: "bad-role", specialty: "review", tool: "claude" }],
      ["/api/teams", { name: "Bad Team!", projects: ["alpha"] }, "bad-team", { name: "bad-team", projects: ["alpha"] }],
      ["/api/teams/Alpha/members", { name: "Bad Helper!", tool: "codex" }, "bad-helper", { name: "bad-helper", tool: "codex" }],
    ];
    for (const [path, body, expected, valid] of inputs) {
      expect((await post(path, valid)).status).toBe(201);
      expect((await post(path, body)).json.suggestion).toBe(expected + "-2");
    }
  });
  it("returns specific skill header, size, link and library errors", async () => {
    const folder = tempDir();
    const md = join(folder, "SKILL.md");
    for (const text of ["no header", "---\nname: x\n"]) {
      writeFileSync(md, text);
      expect((await post("/api/skills", { path: folder })).json.code).toBe("skill_header");
    }
    for (const [text, field] of [["---\ndescription: x\n---", "name"], ["---\nname: x\n---", "description"]]) {
      writeFileSync(md, text);
      expect((await post("/api/skills", { path: folder })).json).toMatchObject({ code: "skill_field", params: { field } });
    }
    writeFileSync(md, "---\nname: linked\ndescription: x\n---");
    symlinkSync(join(folder, "SKILL.md"), join(folder, "linked.md"));
    expect((await post("/api/skills", { path: folder })).json.code).toBe("skill_symlink");
    rmSync(join(folder, "linked.md"));
    writeFileSync(md, "---\nname: big\ndescription: x\n---");
    writeFileSync(join(folder, "big.bin"), Buffer.alloc(5 * 1024 * 1024));
    expect((await post("/api/skills", { path: folder })).json.code).toBe("skill_too_large");
    expect((await post("/api/skills", { files: Array.from({ length: 201 }, () => ({ path: "x", content: "" })) })).json.code).toBe("skill_too_large");
    await post("/api/skills", { path: skillFolder() });
    expect((await post("/api/skills", { path: getSkill("review")!.path })).json.code).toBe("skill_inside");
  });
  it("returns log location and timestamp for Copy details", async () => {
    const result = await get("/api/error-details");
    expect(result.json).toMatchObject({ logPath: join(home, "codec.log"), time: expect.any(String) });
    expect(Number.isFinite(Date.parse(result.json.time))).toBe(true);
    expect((await call("GET", "/api/error-details", undefined, { token: null })).json.code).toBe("unauthorized");
  });
});


describe("Wave 2 operational error paths", () => {
  it("distinguishes a locked workspace from unsaved changes and refuses branch deletion when in use", async () => {
    const repo = await project();
    process.env.CODEC_AGENT_COMMAND = "true";
    const started = (await post("/api/projects/alpha/runs", { agent: "codex", task: "finish" })).json;
    const finished = await waitFor(started.runId);
    execFileSync("git", ["-C", repo, "worktree", "lock", finished.worktree]);
    const blocked = await post(`/api/runs/${finished.runId}/clean`);
    expect(blocked.json.code).toBe("workspace_remove_failed");
    expect(blocked.json.error).toBe(S.errors.workspace_remove_failed);
    execFileSync("git", ["-C", repo, "worktree", "unlock", finished.worktree]);
    const otherWorkspace = join(tempDir(), "other");
    execFileSync("git", ["-C", repo, "worktree", "add", "--force", "-q", otherWorkspace, finished.branch]);
    expect((await post(`/api/runs/${finished.runId}/clean`, { deleteBranch: true })).json.code).toBe("branch_remove_failed");
  });
  it("codes removed project folders, unreadable change tracking, and workspace creation failures", async () => {
    const repo = await project();
    const moved = repo + "-moved";
    renameSync(repo, moved);
    try {
      expect((await post("/api/projects/alpha/runs", { agent: "codex", task: "test" })).json.code).toBe("project_missing");
    } finally { renameSync(moved, repo); }
    renameSync(join(repo, ".git"), join(repo, "tracking-moved"));
    expect((await post("/api/projects/alpha/runs", { agent: "codex", task: "test" })).json.code).toBe("tracking_failed");
    renameSync(join(repo, "tracking-moved"), join(repo, ".git"));
    mkdirSync(join(home, "worktrees"), { recursive: true });
    writeFileSync(join(home, "worktrees", "alpha"), "cannot be a directory");
    // A native storage failure still gets a safe envelope and full technical log.
    expect((await post("/api/projects/alpha/runs", { agent: "codex", task: "test" })).json.code).toBe("unknown_error");
    rmSync(join(home, "worktrees", "alpha"));
    writeFileSync(join(repo, ".git", "worktrees"), "blocked metadata folder");
    expect((await post("/api/projects/alpha/runs", { agent: "codex", task: "test" })).json.code).toBe("workspace_failed");
    rmSync(join(repo, ".git", "worktrees"));
  });
  it("codes removed roles and missing skills without exposing engine details", async () => {
    await team();
    await post("/api/skills", { path: skillFolder() });
    await post("/api/specialists", { name: "reviewer", specialty: "review", tool: "claude", skills: ["review"] });
    await post("/api/teams/Alpha/members", { name: "tester", specialist: "reviewer" });
    const copy = getSkill("review")!.path;
    rmSync(copy, { recursive: true });
    expect((await post("/api/projects/alpha/runs", { member: "Alpha/tester", task: "test" })).json.code).toBe("missing_skill");
    writeFileSync(specialistsFile(), '{"specialists":[]}');
    expect((await get("/api/members/Alpha/tester")).json.code).toBe("role_missing");
    const broken = (await get("/api/teams")).json[0].members[0];
    expect(broken.code).toBe("role_missing");
    expect(broken.error).toContain("role, which has been removed");
    expect((await preview("member", "Alpha/tester")).json.blocked).toBe(false);
    expect((await post("/api/teams/Alpha/members/tester/remove")).status).toBe(200);
  });
  it("rejects an installed AI service that is signed out", async () => {
    await project();
    await d.close();
    d = await startDashboard({ port: 0, setup: {
      findBinary: (tool) => tool,
      runner: async (_command, args) => args[0] === "--version" ? { status: 0, stdout: "v1" } : { status: 1, stdout: "" },
    } });
    expect((await post("/api/projects/alpha/runs", { agent: "claude", task: "test" })).json).toMatchObject({ code: "tool_unavailable", params: { tool: "Claude" } });
    expect(listRuns()).toEqual([]);
  });
});
