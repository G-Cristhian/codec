import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { request } from "http";
import { existsSync } from "fs";
import { addProject } from "../src/registry.js";
import { cleanRun, getRunStatus, listRuns, startRun, stopRun, type RunStatus } from "../src/runs.js";
import { agentMemoryBytes, laneOf, startDashboard, type Dashboard } from "../src/dashboard.js";
import { cleanupTemps, makeRepo, useIsolatedHome, waitFor } from "./helpers.js";

const FAKE = `sleep 1; echo "fake agent says hi"; echo "task: $(cat "$CODEC_TASK_FILE")"`;

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: any;
}

/** Raw HTTP so the test controls the Host header (fetch won't let us). */
function call(
  d: Dashboard,
  method: string,
  path: string,
  opts: { token?: string | null; host?: string; body?: unknown; cookie?: string; type?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = { Host: opts.host ?? `127.0.0.1:${d.port}` };
  const token = opts.token === undefined ? d.token : opts.token;
  if (token) headers["X-Codec-Token"] = token;
  if (opts.cookie) headers.Cookie = opts.cookie;
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (payload !== undefined) headers["Content-Type"] = opts.type ?? "application/json";
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: d.port, method, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        let json: any;
        try {
          json = JSON.parse(body);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode!, headers: res.headers, body, json });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe("dashboard", () => {
  let d: Dashboard;
  beforeEach(async () => {
    useIsolatedHome(FAKE);
    d = await startDashboard({ port: 0 });
  });
  afterEach(async () => {
    await d.close();
    for (const r of listRuns({ state: "running" })) stopRun(r.runId);
    cleanupTemps();
  });

  it("listens on 127.0.0.1 only and prints a tokenised URL", () => {
    const addr = d.server.address() as { address: string };
    expect(addr.address).toBe("127.0.0.1");
    expect(d.url).toBe(`http://127.0.0.1:${d.port}/?token=${d.token}`);
    expect(d.token.length).toBeGreaterThanOrEqual(32);
  });

  it("rejects foreign Host headers (DNS rebinding)", async () => {
    for (const host of ["evil.example.com", `evil.example.com:${d.port}`, `127.0.0.1:${d.port + 1}`, "localhost"]) {
      expect((await call(d, "GET", "/api/state", { host })).status).toBe(421);
    }
    expect((await call(d, "GET", "/api/state", { host: `localhost:${d.port}` })).status).toBe(200);
  });

  it("requires the token on every API call; writes need POST + header", async () => {
    expect((await call(d, "GET", "/api/state", { token: null })).status).toBe(401);
    expect((await call(d, "GET", "/api/state", { token: "wrong" })).status).toBe(401);
    // Cookie works for reads...
    const cookie = `codec_token_${d.port}=${d.token}`;
    expect((await call(d, "GET", "/api/state", { token: null, cookie })).status).toBe(200);
    // ...but not for writes (CSRF): the header is mandatory.
    const repo = makeRepo("alpha");
    const noHeader = await call(d, "POST", "/api/projects", { token: null, cookie, body: { path: repo } });
    expect(noHeader.status).toBe(401);
    expect((await call(d, "POST", "/api/projects", { body: { path: repo }, type: "text/plain" })).status).toBe(415);
    expect((await call(d, "PUT", "/api/projects")).status).toBe(405);
    expect((await call(d, "GET", "/api/projects/alpha/remove")).status).toBe(404); // GET never changes state
    expect(listRuns()).toEqual([]);
  });

  it("page: token link sets a cookie and redirects; no token gets a locked page", async () => {
    expect((await call(d, "GET", "/", { token: null })).status).toBe(401);
    expect((await call(d, "GET", "/?token=nope", { token: null })).status).toBe(401);
    const r = await call(d, "GET", `/?token=${d.token}`, { token: null });
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe("/");
    const set = String(r.headers["set-cookie"]);
    expect(set).toContain(`codec_token_${d.port}=${d.token}`);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    const page = await call(d, "GET", "/", { token: null, cookie: `codec_token_${d.port}=${d.token}` });
    expect(page.status).toBe(200);
    expect(page.body).toContain("<title>Codec</title>");
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  it("adds/removes projects and starts, follows, stops and cleans runs via the API", async () => {
    const repo = makeRepo("alpha");
    const add = await call(d, "POST", "/api/projects", { body: { path: repo } });
    expect(add.status, add.body).toBe(201);
    expect(add.json.name).toBe("alpha");
    expect((await call(d, "POST", "/api/projects", { body: { path: repo } })).json.error).toMatch(/already exists/);

    const started = await call(d, "POST", "/api/projects/alpha/runs", { body: { agent: "claude", task: "say hi" } });
    expect(started.status, started.body).toBe(201);
    const id = started.json.runId as string;
    expect(started.json.lane).toBe("working");

    let home = (await call(d, "GET", "/api/state")).json;
    expect(home.agentsRunning).toBe(1);
    expect(home.projects[0]).toMatchObject({ name: "alpha", lanes: { working: 1, needsYou: 0, inReview: 0, done: 0 } });
    expect(home.runs[0]).toMatchObject({ runId: id, project: "alpha", agent: "claude", state: "running" });
    if (process.platform === "linux") expect(home.memoryBytes).toBeGreaterThan(0);

    // Can't remove a project while it has a running agent (same rule as the CLI).
    const busy = await call(d, "POST", "/api/projects/alpha/remove", { body: {} });
    expect(busy.status).toBe(400);
    expect(busy.json.error).toMatch(/running agent/);

    await waitFor(id);
    const detail = (await call(d, "GET", `/api/runs/${id}`)).json;
    expect(detail).toMatchObject({ state: "done", lane: "inReview", branch: `codec/${id}`, worktreeExists: true });
    expect(detail.task).toBe("say hi");
    expect(detail.log).toContain("fake agent says hi");
    expect(detail.log).toContain("task: say hi");

    const board = (await call(d, "GET", "/api/projects/alpha")).json;
    expect(board.lanes.inReview.map((r: { runId: string }) => r.runId)).toEqual([id]);

    expect((await call(d, "POST", `/api/runs/${id}/stop`, { body: {} })).json.error).toMatch(/not running/);
    const cleaned = await call(d, "POST", `/api/runs/${id}/clean`, { body: {} });
    expect(cleaned.status, cleaned.body).toBe(200);
    expect(cleaned.json.lane).toBe("done");
    expect(existsSync(detail.worktree)).toBe(false);

    // A long-running agent can be stopped from the page.
    process.env.CODEC_AGENT_COMMAND = "sleep 30";
    const long = await call(d, "POST", "/api/projects/alpha/runs", { body: { agent: "codex", task: "wait" } });
    const stopped = await call(d, "POST", `/api/runs/${long.json.runId}/stop`, { body: {} });
    expect(stopped.json).toMatchObject({ state: "stopped", lane: "needsYou" });

    expect((await call(d, "POST", "/api/projects/alpha/remove", { body: {} })).status).toBe(200);
    expect((await call(d, "GET", "/api/state")).json.projects).toEqual([]);
  });

  it("returns clear errors for bad input", async () => {
    expect((await call(d, "GET", "/api/runs/nope")).status).toBe(404);
    expect((await call(d, "GET", "/api/projects/nope")).status).toBe(404);
    const r = await call(d, "POST", "/api/projects/nope/runs", { body: { agent: "claude", task: "x" } });
    expect(r.json.error).toMatch(/no project named/);
    addProject(makeRepo("alpha"));
    expect((await call(d, "POST", "/api/projects/alpha/runs", { body: { agent: "gpt", task: "x" } })).json.error).toMatch(
      /unknown agent/,
    );
    expect((await call(d, "POST", "/api/projects/alpha/runs", { body: { agent: "claude" } })).json.error).toMatch(
      /"task" is required/,
    );
  });
});

describe("lane mapping", () => {
  beforeEach(() => useIsolatedHome("exit 0"));
  afterEach(cleanupTemps);

  it("maps every state to the right lane", async () => {
    addProject(makeRepo("alpha"));
    const base = getRunStatus(startRun({ project: "alpha", agent: "claude", task: "x" }).runId)!;
    const fake = (o: Partial<RunStatus>): RunStatus => ({ ...base, ...o });
    expect(laneOf(fake({ state: "running" }))).toBe("working");
    expect(laneOf(fake({ state: "failed" }))).toBe("needsYou");
    expect(laneOf(fake({ state: "stopped" }))).toBe("needsYou");
    expect(laneOf(fake({ state: "done" }))).toBe("inReview");
    expect(laneOf(fake({ state: "done", cleanedAt: "2026-01-01T00:00:00Z" }))).toBe("done");
    expect(laneOf(fake({ state: "failed", cleanedAt: "2026-01-01T00:00:00Z" }))).toBe("done");
    expect(laneOf(fake({ state: "done", worktree: "/nonexistent/codec/wt" }))).toBe("done");
    await waitFor(base.runId);
    cleanRun(base.runId);
  });

  it("memory: sums the run's process tree, n/a-safe", () => {
    const m = agentMemoryBytes([]);
    if (process.platform === "linux") expect(m).toBe(0);
    else expect(m).toBeNull();
  });
});
