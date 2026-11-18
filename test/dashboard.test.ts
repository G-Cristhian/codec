import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { request } from "http";
import { join } from "path";
import { existsSync, writeFileSync } from "fs";
import { addProject } from "../src/registry.js";
import { cleanRun, getRunStatus, listRuns, startRun, stopRun, type RunStatus } from "../src/runs.js";
import { agentMemoryBytes, laneOf, startDashboard, type Dashboard } from "../src/dashboard.js";
import { cleanupTemps, makeRepo, makeUiBundle, useIsolatedHome, waitFor } from "./helpers.js";
import { S, wording } from "../src/strings.js";
import { formatTimeLimit } from "../src/limits.js";
import { addMember, addTeam } from "../src/org.js";
import { listMessages, postMessage } from "../src/messages.js";
import { inboxFile, writeJsonAtomic } from "../src/store.js";

const FAKE = `sleep 1; echo "fake agent says hi"; echo "task: $(cat "$CODEC_TASK_FILE")"; echo saved > notes.txt`;

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
    d = await startDashboard({ port: 0, uiBundleDir: makeUiBundle() });
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
    expect((await call(d, "POST", "/api/projects", { body: { path: repo } })).json.code).toBe("project_exists");

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
    expect(busy.json.code).toBe("project_busy");

    await waitFor(id);
    const detail = (await call(d, "GET", `/api/runs/${id}`)).json;
    expect(detail).toMatchObject({ state: "done", lane: "inReview", branch: `codec/${id}`, worktreeExists: true });
    expect(detail.task).toBe("say hi");
    expect(detail.log).toContain("fake agent says hi");
    expect(detail.log).toContain("task: say hi");

    const board = (await call(d, "GET", "/api/projects/alpha")).json;
    expect(board.lanes.inReview.map((r: { runId: string }) => r.runId)).toEqual([id]);

    expect((await call(d, "POST", `/api/runs/${id}/stop`, { body: {} })).json.code).toBe("run_not_running");
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

  it.each(["stopped", "timed_out", "failed"] as const)(
    "shows the %s outcome ahead of unsaved workspace status",
    async (state) => {
      addProject(makeRepo("alpha"));
      process.env.CODEC_AGENT_COMMAND = "sleep 30";
      const run = startRun({ project: "alpha", agent: "claude", task: "wait", timeLimitMinutes: 1 });
      writeFileSync(join(run.worktree, "poem.txt"), "Work waiting for the owner\n");
      stopRun(run.runId);
      const dir = join(process.env.CODEC_HOME!, "runs", run.runId);
      if (state === "timed_out") writeFileSync(join(dir, "timed_out"), new Date().toISOString());
      if (state === "failed") {
        const { stoppedAt, ...record } = getRunStatus(run.runId)!;
        writeFileSync(join(dir, "run.json"), JSON.stringify(record));
        writeFileSync(join(dir, "exit_code"), "2\n");
      }
      const text = state === "stopped" ? S.tasks.stopped : state === "failed" ? S.tasks.failed
        : wording(S.tasks.timedOut, { limit: formatTimeLimit(1) });
      const expected = { state, reviewStatus: "unsaved", stateText: text, lane: "needsYou" };
      expect((await call(d, "GET", `/api/runs/${run.runId}`)).json).toMatchObject(expected);
      expect((await call(d, "GET", "/api/state")).json.runs[0]).toMatchObject(expected);
      expect((await call(d, "GET", "/api/projects/alpha")).json.lanes.needsYou[0]).toMatchObject(expected);
    },
  );

  it("returns clear errors for bad input", async () => {
    expect((await call(d, "GET", "/api/runs/nope")).status).toBe(404);
    expect((await call(d, "GET", "/api/projects/nope")).status).toBe(404);
    const r = await call(d, "POST", "/api/projects/nope/runs", { body: { agent: "claude", task: "x" } });
    expect(r.json.code).toBe("project_not_found");
    addProject(makeRepo("alpha"));
    expect((await call(d, "POST", "/api/projects/alpha/runs", { body: { agent: "gpt", task: "x" } })).json.code).toBe("invalid_tool");
    expect((await call(d, "POST", "/api/projects/alpha/runs", { body: { agent: "claude" } })).json.code).toBe("missing_task");
  });

  it("reads all changes with GET authentication and friendly missing/unavailable errors", async () => {
    addProject(makeRepo("alpha"));
    const run = startRun({ project: "alpha", agent: "claude", task: "Write notes" });
    const path = `/api/runs/${run.runId}/changes`;
    const running = await call(d, "GET", path);
    expect(running.status).toBe(409);
    expect(running.json).toMatchObject({ code: "changes_unavailable", error: S.errors.changes_unavailable });
    await waitFor(run.runId);
    expect((await call(d, "GET", path, { token: null })).status).toBe(401);
    expect((await call(d, "GET", path, { token: "wrong" })).status).toBe(401);
    const changes = await call(d, "GET", path);
    expect(changes.status, changes.body).toBe(200);
    expect(changes.json).toMatchObject({ status: "ready", files: [{ path: "notes.txt", change: "added", additions: 1, deletions: 0,
      binary: false, truncated: false, lines: [{ kind: "hunk" }, { kind: "add", text: "+saved", newNo: 1 }] }] });
    const cookie = await call(d, "GET", path, { token: null, cookie: `codec_token_${d.port}=${d.token}` });
    expect(cookie.status).toBe(200);
    expect(cookie.json).toEqual(changes.json);
    expect((await call(d, "POST", path, { body: {} })).status).toBe(404);
    const unknown = await call(d, "GET", "/api/runs/run-ffffffff/changes");
    expect(unknown.status).toBe(404);
    expect(unknown.json.code).toBe("run_not_found");
    cleanRun(run.runId);
    expect((await call(d, "GET", path)).status).toBe(409);
    process.env.CODEC_AGENT_COMMAND = "true";
    const empty = await waitFor(startRun({ project: "alpha", agent: "claude", task: "No edits" }).runId);
    expect((await call(d, "GET", `/api/runs/${empty.runId}/changes`)).json).toMatchObject({ status: "no_changes", files: [] });
  });

  it.each(["apply", "discard"])("requires POST auth and refuses running tasks for %s", async (action) => {
    addProject(makeRepo("alpha"));
    process.env.CODEC_AGENT_COMMAND = "sleep 30";
    const run = startRun({ project: "alpha", agent: "claude", task: "Wait" });
    const path = `/api/runs/${run.runId}/${action}`;
    for (const token of [null, "wrong"]) {
      expect((await call(d, "POST", path, { token, body: {} })).status).toBe(401);
    }
    expect((await call(d, "POST", path, { token: null, cookie: `codec_token_${d.port}=${d.token}`, body: {} })).status).toBe(401);
    const result = await call(d, "POST", path, { body: {} });
    expect(result.status).toBe(409);
    expect(result.json).toMatchObject({ code: "changes_unavailable", error: S.errors.changes_unavailable });
    expect((await call(d, "GET", path)).status).toBe(404);
  });

  it.each(["apply", "discard"])("returns a reviewed Done summary after %s", async (action) => {
    addProject(makeRepo("alpha"));
    process.env.CODEC_AGENT_COMMAND = "echo saved > notes.txt";
    const run = await waitFor(startRun({ project: "alpha", agent: "claude", task: "Write notes" }).runId);
    const base = `/api/runs/${run.runId}`;
    const changes = (await call(d, "GET", base + "/changes")).json;
    const body = action === "apply" ? { head: changes.head, hunks: ["0:0"] } : {};
    const result = await call(d, "POST", base + "/" + action, { body });
    expect(result.status, result.body).toBe(200);
    expect(result.json).toMatchObject({ runId: run.runId, lane: "done", reviewed: { action: action === "apply" ? "applied" : "discarded" } });
    expect((await call(d, "POST", base + "/" + action, { body })).status).toBe(409);
  });

  describe("project conversations", () => {
    beforeEach(() => {
      addProject(makeRepo("alpha"));
      addProject(makeRepo("beta"));
      addTeam({ name: "red", projects: ["alpha", "beta"] });
      addMember("red", { name: "reader", tool: "claude" });
      addMember("red", { name: "writer", tool: "claude" });
      addTeam({ name: "green", projects: ["alpha"] });
      addMember("green", { name: "reader", tool: "claude" });
      addTeam({ name: "blue", projects: ["beta"] });
      addMember("blue", { name: "reader", tool: "claude" });
    });

    it("includes both directions for every project helper, oldest first, without marking messages read", async () => {
      const owner = postMessage({ from: "owner", to: "red/reader", body: "Owner note" });
      const internal = postMessage({ from: "red/reader", to: "green/reader", body: "Another team" });
      const outgoing = postMessage({ from: "red/writer", to: "blue/reader", body: "Outgoing" });
      const incoming = postMessage({ from: "blue/reader", to: "red/reader", body: "Incoming" });
      const excluded = postMessage({ from: "owner", to: "blue/reader", body: "Only beta" });
      const at = (day: number) => `2026-11-0${day}T12:00:00.000Z`;
      writeJsonAtomic(inboxFile("red", "reader"), [{ ...owner, sentAt: at(4) }, { ...incoming, sentAt: at(1) }]);
      writeJsonAtomic(inboxFile("green", "reader"), [{ ...internal, sentAt: at(2), deliveredAt: at(2) }]);
      writeJsonAtomic(inboxFile("blue", "reader"), [{ ...outgoing, sentAt: at(3) }, { ...excluded, sentAt: at(5) }]);

      const result = await call(d, "GET", "/api/projects/alpha");
      expect(result.status).toBe(200);
      expect(result.json.messages).toEqual([
        { id: incoming.id, senderName: "blue/reader", senderKind: "helper", recipientName: "red/reader", body: "Incoming", sentAt: at(1), waiting: true },
        { id: internal.id, senderName: "red/reader", senderKind: "helper", recipientName: "green/reader", body: "Another team", sentAt: at(2), waiting: false },
        { id: outgoing.id, senderName: "red/writer", senderKind: "helper", recipientName: "blue/reader", body: "Outgoing", sentAt: at(3), waiting: true },
        { id: owner.id, senderName: S.conversation.you, senderKind: "owner", recipientName: "red/reader", body: "Owner note", sentAt: at(4), waiting: true },
      ]);
      expect(result.json.helpers).toEqual([
        { ref: "red/reader", name: "red/reader", running: false },
        { ref: "red/writer", name: "red/writer", running: false },
        { ref: "green/reader", name: "green/reader", running: false },
      ]);
      expect(listMessages().every((message) => !message.read)).toBe(true);
    });

    it("sends to one helper as the owner and clears waiting when its next task starts, including on another project", async () => {
      const result = await call(d, "POST", "/api/projects/alpha/messages", {
        body: { to: "red/reader", body: "Keep this\nline break", from: "blue/reader" },
      });
      expect(result.status).toBe(201);
      expect(result.json).toEqual([expect.objectContaining({ from: "owner", to: "red/reader", body: "Keep this\nline break" })]);
      const id = result.json[0].id;
      expect((await call(d, "GET", "/api/projects/alpha")).json.messages[0]).toMatchObject({ id, waiting: true });
      process.env.CODEC_AGENT_COMMAND = "sleep 30";
      const run = startRun({ project: "beta", member: "red/reader", task: "Check messages" });
      const active = (await call(d, "GET", "/api/projects/alpha")).json;
      expect(active.messages[0]).toMatchObject({ id, waiting: false });
      expect(active.helpers[0].running).toBe(true);
      const live = await call(d, "POST", "/api/projects/alpha/messages", { body: { to: "red/reader", body: "While working" } });
      expect(live.json[0]).toMatchObject({ deliveredAt: expect.any(String), runId: run.runId });
      stopRun(run.runId);
      const stopped = (await call(d, "GET", "/api/projects/alpha")).json;
      expect(stopped.helpers[0].running).toBe(false);
      expect(stopped.messages.every((message: { waiting: boolean }) => !message.waiting)).toBe(true);
    });

    it("sends all to each helper across the project's teams exactly once", async () => {
      const result = await call(d, "POST", "/api/projects/alpha/messages", { body: { to: "all", body: "Please coordinate" } });
      expect(result.status).toBe(201);
      expect(result.json.map((message: { to: string }) => message.to)).toEqual(["red/reader", "red/writer", "green/reader"]);
      expect(new Set(result.json.map((message: { id: string }) => message.id)).size).toBe(3);
      expect(listMessages()).toHaveLength(3);
      expect(listMessages({ to: "blue/reader" })).toEqual([]);
    });

    it.each(["missing/helper", "red/missing", "blue/reader", undefined, 42])("rejects recipient %s without sending", async (to) => {
      const result = await call(d, "POST", "/api/projects/alpha/messages", { body: { to, body: "Hello" } });
      expect(result.status).toBe(400);
      expect(result.json).toMatchObject({ code: "message_helper_not_on_project", error: S.errors.message_helper_not_on_project });
      expect(listMessages()).toEqual([]);
    });

    it.each(["", " \n\t ", undefined, 42])("rejects empty or invalid body %s before sending to anyone", async (body) => {
      const result = await call(d, "POST", "/api/projects/alpha/messages", { body: { to: "all", body } });
      expect(result.status).toBe(400);
      expect(result.json).toMatchObject({ code: "missing_message", error: S.errors.missing_message });
      expect(listMessages()).toEqual([]);
    });

    it("returns an empty feed and a friendly send error when a project has no helpers", async () => {
      addProject(makeRepo("empty"));
      expect((await call(d, "GET", "/api/projects/empty")).json).toMatchObject({ helpers: [], messages: [], messagesError: false });
      const result = await call(d, "POST", "/api/projects/empty/messages", { body: { to: "all", body: "Hello" } });
      expect(result.status).toBe(400);
      expect(result.json.code).toBe("message_no_helpers");
      expect((await call(d, "POST", "/api/projects/missing/messages", { body: { to: "all", body: "Hello" } })).status).toBe(404);
    });

    it("keeps the board available on a feed read error and recovers on the next request", async () => {
      const saved = postMessage({ from: "owner", to: "red/reader", body: "Recover me" });
      writeFileSync(inboxFile("red", "reader"), "invalid JSON");
      const result = await call(d, "GET", "/api/projects/alpha");
      expect(result.status).toBe(200);
      expect(result.json).toMatchObject({ project: { name: "alpha" }, lanes: { working: [] }, messagesError: true, messages: [] });
      writeJsonAtomic(inboxFile("red", "reader"), [saved]);
      expect((await call(d, "GET", "/api/projects/alpha")).json).toMatchObject({ messagesError: false, messages: [{ id: saved.id }] });
    });

    it("uses the existing token, JSON and POST protections for message writes", async () => {
      const body = { to: "red/reader", body: "Hello" };
      const path = "/api/projects/alpha/messages";
      expect((await call(d, "POST", path, { body, token: null, cookie: `codec_token_${d.port}=${d.token}` })).status).toBe(401);
      expect((await call(d, "POST", path, { body, type: "text/plain" })).status).toBe(415);
      expect((await call(d, "GET", path)).status).toBe(404);
      expect(listMessages()).toEqual([]);
    });
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
    expect(laneOf(fake({ state: "done", reviewStatus: "ready" }))).toBe("inReview");
    expect(laneOf(fake({ state: "done", reviewStatus: "no_changes" }))).toBe("done");
    expect(laneOf(fake({ state: "done", reviewStatus: "unsaved" }))).toBe("needsYou");
    expect(laneOf(fake({ state: "done", reviewStatus: "unavailable" }))).toBe("needsYou");
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
