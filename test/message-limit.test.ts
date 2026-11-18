import { execFile } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { promisify } from "util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupCoordinator } from "../src/coordinator.js";
import { homeView, laneOf, projectView, startDashboard, teamsView, type Dashboard } from "../src/dashboard.js";
import { readEvents } from "../src/events.js";
import { cappedMessagePairs, isHelperHeld, listMessages, postMessage, receiveMessages, resetMessageLimit } from "../src/messages.js";
import { addMember, addTeam, getTeam, setTeamMessageLimit, setTeamProjects } from "../src/org.js";
import { addProject, getProject, setProjectMessageLimit } from "../src/registry.js";
import { listRuns, runOutput, startRun, stopRun } from "../src/runs.js";
import * as store from "../src/store.js";
import { S } from "../src/strings.js";
import { cleanupTemps, cli, makeRepo, makeUiBundle, useIsolatedHome, waitFor } from "./helpers.js";

const a = "red/reader", b = "red/reviewer", c = "red/writer";
const key = [a, b].sort().join("|");
const exactNote = "Message limit reached. The owner needs to continue this conversation.";
const send = (from = a, to = b, body = "Keep talking") => postMessage({ from, to, body });
const state = () => store.readJson<Record<string, { count: number; limit?: number; cappedAt?: string }>>(store.messageLimitsFile(), {});
const start = (member = a, project = "alpha") => startRun({ project, member, task: "Check messages" });
let home: string;
let dashboard: Dashboard | undefined;

beforeEach(() => {
  home = useIsolatedHome("sleep 60");
  delete process.env.CODEC_RUN_ID;
  addProject(makeRepo("alpha"));
  for (const name of ["red", "blue"]) {
    addTeam({ name, projects: ["alpha"] });
    addMember(name, { name: "reader", tool: "codex" });
  }
  addMember("red", { name: "writer", tool: "claude" });
  addMember("red", { name: "reviewer", tool: "codex" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await dashboard?.close();
  dashboard = undefined;
  for (const run of listRuns({ state: "running" })) stopRun(run.runId);
  cleanupTemps();
});

describe("message safety cap", () => {
  it("delivers exchanges 1–10, sends exactly one notice to each running helper, and refuses 11–12", () => {
    const runs = [start(a), start(b)];
    for (let n = 1; n <= 12; n++) {
      const post = () => n % 2 ? send(a, b, `Exchange ${n}`) : send(b, a, `Exchange ${n}`);
      if (n <= 10) expect(post().deliveredAt).toBeTruthy();
      else expect(post).toThrowError(expect.objectContaining({ code: "message_limit_reached", message: exactNote }));
      expect(listMessages({ from: "codec" })).toHaveLength(n < 10 ? 0 : 2);
    }
    expect(S.messageLimit.reached).toBe(exactNote);
    expect(listMessages()).toHaveLength(12);
    expect(listMessages().filter((m) => m.from !== "codec")).toHaveLength(10);
    expect(listMessages().some((m) => /Exchange 1[12]/.test(m.body))).toBe(false);
    expect(store.messageLimitsFile()).toBe(join(home, "message-limits.json"));
    expect(state()).toEqual({ [key]: { count: 10, limit: 10, cappedAt: expect.any(String) } });
    for (const [i, ref] of [a, b].entries()) {
      const notices = listMessages({ from: "codec", to: ref });
      expect(notices).toEqual([expect.objectContaining({ body: exactNote, deliveredAt: expect.any(String), runId: runs[i].runId })]);
      const text = readFileSync(join(runs[i].worktree, "messages.md"), "utf-8");
      expect(text.split(exactNote)).toHaveLength(2);
      expect(laneOf(runs[i])).toBe("needsYou");
    }
    expect(homeView().runs.every((run) => run.held && run.lane === "needsYou")).toBe(true);
    expect(projectView("alpha").lanes.needsYou).toHaveLength(2);
    expect(teamsView().flatMap((t) => t.members).filter((m) => "held" in m && m.held)).toHaveLength(2);
  });

  it("keeps a stopped helper's notice in its inbox and delivers it on its next task", () => {
    setTeamMessageLimit("red", 1);
    const run = start(a);
    send();
    expect(laneOf(run)).toBe("needsYou");
    expect(listMessages({ from: "codec", to: b })[0].deliveredAt).toBeUndefined();
    expect(teamsView().find((team) => team.name === "red")!.members.find((member) => member.member === "reviewer")).toMatchObject({ held: true, working: [] });
    const next = start(b);
    expect(readFileSync(join(next.worktree, "messages.md"), "utf-8")).toContain(exactNote);
    expect(receiveMessages(b, next.runId)).toEqual([]);
  });

  it.each([a, b])("an owner message to %s resets the pair and its lanes, and restarts counting", (to) => {
    setTeamMessageLimit("red", 2);
    const runs = [start(a), start(b)];
    send(); send(b, a);
    expect(runs.map(laneOf)).toEqual(["needsYou", "needsYou"]);
    send("owner", to, "Continue now");
    expect(state()[key]).toEqual({ count: 0 });
    expect(runs.map(laneOf)).toEqual(["working", "working"]);
    expect(laneOf({ ...runs[0], helperStatus: { state: "stuck", note: "Choose a direction", at: new Date().toISOString() } })).toBe("needsYou");
    expect(teamsView().find((team) => team.name === "red")!.members.find((member) => member.member === "reviewer")).toMatchObject({ held: false });
    send();
    expect(state()[key]).toEqual({ count: 1, limit: 2 });
    expect(listMessages({ from: "codec" })).toHaveLength(2);
  });

  it("caps same-team pairs independently and holds a helper until all its capped pairs clear", () => {
    setTeamMessageLimit("red", 1);
    send();
    expect(send(a, c).from).toBe(a);
    expect(cappedMessagePairs()).toHaveLength(2);
    expect(() => send(c, a)).toThrowError(expect.objectContaining({ code: "message_limit_reached" }));
    resetMessageLimit(key);
    expect(isHelperHeld(a)).toBe(true);
    expect(isHelperHeld(b)).toBe(false);
    send("owner", c);
    expect(isHelperHeld(a)).toBe(false);
    expect(cappedMessagePairs()).toEqual([]);
    expect(() => send(b, a)).not.toThrow();
  });

  it("owner messages never count or reset a conversation that has not reached its cap", () => {
    for (let n = 0; n < 12; n++) send("owner", a);
    expect(state()).toEqual({});
    send(); send("owner", a); send(b, a);
    expect(state()[key].count).toBe(2);
    expect(cappedMessagePairs()).toEqual([]);
    expect(() => send("codec", a)).toThrow();
    expect(listMessages({ from: "codec" })).toEqual([]);
  });

  it("counts persisted messages even when live delivery fails and still queues both notices", () => {
    setTeamMessageLimit("red", 1);
    const runs = [start(a), start(b)];
    const write = vi.spyOn(store, "writeTextAtomic").mockImplementation(() => { throw new Error("Delivery unavailable"); });
    expect(() => send()).toThrow("Delivery unavailable");
    write.mockRestore();
    expect(state()[key].count).toBe(1);
    expect(listMessages({ from: "codec" })).toHaveLength(2);
    for (const [i, ref] of [a, b].entries()) {
      receiveMessages(ref, runs[i].runId);
      expect(readFileSync(join(runs[i].worktree, "messages.md"), "utf-8").split(exactNote)).toHaveLength(2);
    }
    expect(() => send()).toThrow(exactNote);
  });

  it("serializes the cap across separate processes and persists it across restarts", async () => {
    const source = `import { postMessage } from ${JSON.stringify(new URL("../src/messages.ts", import.meta.url).href)};
      const results = [];
      for (let n = 0; n < 4; n++) {
        try { postMessage({ from: ${JSON.stringify(a)}, to: ${JSON.stringify(b)}, body: "Concurrent " + n }); results.push("sent"); }
        catch (e) { results.push(e.code); }
      }
      process.stdout.write(JSON.stringify(results));`;
    const results = await Promise.all([1, 2, 3].map(() => promisify(execFile)(process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source], { env: { ...process.env } })));
    const codes = results.flatMap((result) => JSON.parse(result.stdout) as string[]);
    expect(codes.filter((code) => code === "sent")).toHaveLength(10);
    expect(codes.filter((code) => code === "message_limit_reached")).toHaveLength(2);
    expect(listMessages()).toHaveLength(12);
    expect(listMessages({ from: "codec" })).toHaveLength(2);
    expect(state()[key].count).toBe(10);
  });
});

describe("limit resolution", () => {
  it.each([
    [undefined, undefined, undefined, 10],
    [undefined, undefined, 3, 3],
    [8, undefined, 2, 8],
    [8, 4, 2, 8],
    [2, 4, 9, 2],
  ])("resolves a helper/coordinator limit from its team (%s), ignoring another team (%s), over project default (%s): %s", (red, blue, project, expected) => {
    setupCoordinator({ tool: "codex" });
    setTeamMessageLimit("red", red);
    setTeamMessageLimit("blue", blue);
    setProjectMessageLimit("alpha", project);
    send("coordinator", a);
    expect(state()["coordinator|red/reader"]).toEqual({ count: 1, limit: expected });
  });

  it("uses the sender's latest running project, otherwise the lowest shared project limit", () => {
    addProject(makeRepo("beta"));
    setTeamProjects("red", ["alpha", "beta"]);
    setProjectMessageLimit("alpha", 7);
    setProjectMessageLimit("beta", 3);
    send();
    expect(state()[key].limit).toBe(3);
    const older = start(a, "beta");
    const newest = start(a, "alpha");
    send();
    expect(state()[key].limit).toBe(7);
    stopRun(newest.runId); stopRun(older.runId);
    send();
    expect(state()[key]).toMatchObject({ limit: 3, count: 3, cappedAt: expect.any(String) });
  });

  it("ignores projects outside the helpers' team when the sender is not running, and keeps a cap after settings change", () => {
    addProject(makeRepo("beta"));
    setTeamProjects("blue", ["beta"]);
    setProjectMessageLimit("beta", 2);
    send();
    expect(state()[key].limit).toBe(10);
    setTeamMessageLimit("red", 1);
    send();
    setTeamMessageLimit("red", 100);
    expect(() => send()).toThrow(exactNote);
    resetMessageLimit(key);
    send();
    expect(state()[key]).toEqual({ count: 1, limit: 100 });
  });

  it.each([0, 101, 2.5, "text", "3", null, NaN, Infinity])("rejects invalid setting %s without saving", (value) => {
    expect(() => setTeamMessageLimit("red", value as number)).toThrowError(expect.objectContaining({ code: "invalid_message_limit" }));
    expect(() => setProjectMessageLimit("alpha", value as number)).toThrowError(expect.objectContaining({ code: "invalid_message_limit" }));
    expect(getTeam("red")?.messageLimit).toBeUndefined();
    expect(getProject("alpha")?.messageLimit).toBeUndefined();
  });

  it("accepts both bounds, clears overrides, and logs edits", () => {
    expect(setTeamMessageLimit("red", 1).messageLimit).toBe(1);
    expect(setProjectMessageLimit("alpha", 100).messageLimit).toBe(100);
    expect(setTeamMessageLimit("red", undefined).messageLimit).toBeUndefined();
    expect(setProjectMessageLimit("alpha", undefined).messageLimit).toBeUndefined();
    expect(readEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "team.edit", team: "red", messageLimit: 1 }),
      expect.objectContaining({ kind: "project.edit", project: "alpha", messageLimit: 100 }),
    ]));
  });
});

describe("coordinator and CLI", () => {
  it("counts the coordinator's declined-message auto-replies and delivers its system notice normally", () => {
    setupCoordinator({ tool: "codex" });
    const run = start("coordinator");
    for (let n = 0; n < 5; n++) expect(send(a, "coordinator").declined).toBe(true);
    expect(listMessages({ from: "coordinator", to: a })).toHaveLength(5);
    expect(listMessages({ from: a, to: "coordinator" })).toHaveLength(5);
    expect(listMessages({ from: "codec" })).toHaveLength(2);
    const notice = listMessages({ from: "codec", to: "coordinator" })[0];
    expect(notice).toMatchObject({ body: exactNote, runId: run.runId, deliveredAt: expect.any(String) });
    expect(notice.declined).toBeUndefined();
    expect(laneOf(run)).toBe("needsYou");
    expect(homeView().coordinator.settings).toMatchObject({ held: true });
    expect(projectView("alpha").messages.filter((message) => message.senderKind === "system")).toHaveLength(2);
    expect(readFileSync(join(run.worktree, "messages.md"), "utf-8")).toContain(exactNote);
    expect(state()[[a, "coordinator"].sort().join("|")].count).toBe(10);
    expect(() => send(a, "coordinator")).toThrow(exactNote);
    expect(() => send("coordinator", a)).toThrow(exactNote);
    send("coordinator", "owner");
    expect(laneOf(run)).toBe("needsYou");
    send("owner", "coordinator");
    expect(laneOf(run)).toBe("working");
  });

  it("does not exceed an odd limit to fit a coordinator auto-reply", () => {
    setupCoordinator({ tool: "claude" });
    setProjectMessageLimit("alpha", 3);
    send(a, "coordinator"); send(a, "coordinator");
    expect(listMessages({ from: "coordinator" })).toHaveLength(1);
    expect(listMessages({ from: "codec" })).toHaveLength(2);
    expect(state()[[a, "coordinator"].sort().join("|")].count).toBe(3);
  });

  it("uses a PM helper's team limit for exchanges with the coordinator, which has no team", () => {
    setupCoordinator({ tool: "codex" });
    addMember("red", { name: "pm", tool: "codex" });
    setProjectMessageLimit("alpha", 1);
    setTeamMessageLimit("red", 2);
    expect(send("red/pm", "coordinator").declined).toBeUndefined();
    send("coordinator", "red/pm");
    expect(state()["coordinator|red/pm"]).toMatchObject({ count: 2, limit: 2, cappedAt: expect.any(String) });
    expect(homeView().coordinator.settings).toMatchObject({ held: true });
  });

  it("the real message CLI exits nonzero with the friendly text from a fake helper task", async () => {
    setTeamMessageLimit("red", 1);
    send();
    process.env.CODEC_AGENT_COMMAND = '"$CODEC_NODE" "$CODEC_CLI" message red/reviewer "One more"';
    const run = start(a);
    expect(await waitFor(run.runId)).toMatchObject({ state: "failed", exitCode: 1 });
    expect(runOutput(run.runId)).toContain(exactNote);
    expect(listMessages()).toHaveLength(3);
  });

  it.each(["team", "project"])("sets and resets %s limits with the real CLI", (scope) => {
    const name = scope === "team" ? "red" : "alpha";
    const saved = () => scope === "team" ? getTeam(name) : getProject(name);
    expect(cli([scope, "message-limit", name, "4"]).code).toBe(0);
    expect(saved()?.messageLimit).toBe(4);
    for (const value of ["0", "101", "2.5", "text"]) {
      const result = cli([scope, "message-limit", name, value]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(S.errors.invalid_message_limit);
    }
    expect(cli([scope, "message-limit", name, "default"]).code).toBe(0);
    expect(saved()?.messageLimit).toBeUndefined();
    expect(cli([scope, "message-limit", name]).code).toBe(1);
  });
});

async function call(path: string, body?: unknown, token = dashboard!.token) {
  const response = await fetch(`http://127.0.0.1:${dashboard!.port}/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-Codec-Token": token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() };
}

describe("message limit dashboard API", () => {
  beforeEach(async () => { dashboard = await startDashboard({ port: 0, uiBundleDir: makeUiBundle() }); });

  it("sets and resets limits with authenticated routes and exposes current values", async () => {
    for (const path of ["teams/red/message-limit", "projects/alpha/message-limit"]) {
      expect((await call(path, { messageLimit: 4 }, "wrong")).status).toBe(401);
      for (const value of [0, 101, 2.5, "text", "4", null]) {
        expect(await call(path, { messageLimit: value })).toMatchObject({ status: 400, data: { code: "invalid_message_limit" } });
      }
      expect(await call(path, { messageLimit: 4 })).toMatchObject({ status: 200, data: { messageLimit: 4 } });
    }
    expect((await call("projects/alpha")).data.project.messageLimit).toBe(4);
    expect((await call("teams")).data[0].messageLimit).toBe(4);
    for (const path of ["teams/red/message-limit", "projects/alpha/message-limit"]) {
      expect((await call(path, {})).status).toBe(200);
    }
    expect(getProject("alpha")?.messageLimit).toBeUndefined();
    expect(getTeam("red")?.messageLimit).toBeUndefined();
    expect((await call("projects/missing/message-limit", {})).status).toBe(404);
    expect((await call("teams/missing/message-limit", {})).status).toBe(404);
  });

  it("shows scoped system rows and capped pairs, then resets both held helpers through the route", async () => {
    addProject(makeRepo("beta"));
    addProject(makeRepo("unrelated"));
    setTeamProjects("red", ["alpha", "beta"]);
    setTeamMessageLimit("red", 1);
    const runs = [start(a), start(b, "beta")];
    send();
    for (const project of ["alpha", "beta"]) {
      const view = (await call("projects/" + project)).data;
      expect(view.messages.filter((m: { senderKind: string }) => m.senderKind === "system")
        .sort((left: { recipientName: string }, right: { recipientName: string }) => left.recipientName.localeCompare(right.recipientName))).toEqual([
        expect.objectContaining({ senderName: "Codec", body: exactNote, recipientName: a }),
        expect.objectContaining({ senderName: "Codec", body: exactNote, recipientName: b }),
      ]);
      expect(view.cappedPairs).toEqual([{ key, a, b, limit: 1 }]);
    }
    expect((await call("projects/unrelated")).data).toMatchObject({ messages: [], cappedPairs: [] });
    const path = "projects/alpha/message-limits/reset";
    expect((await call(path, { pairKey: key }, "wrong")).status).toBe(401);
    expect((await call("projects/unrelated/message-limits/reset", { pairKey: key })).status).toBe(404);
    expect((await call(path)).status).toBe(404);
    expect((await call(path, { pairKey: "unknown" })).status).toBe(404);
    expect((await call(path, { pairKey: key })).status).toBe(200);
    expect(runs.map(laneOf)).toEqual(["working", "working"]);
    expect(state()[key]).toEqual({ count: 0 });
    expect((await call("projects/alpha")).data.cappedPairs).toEqual([]);
    expect(() => send()).not.toThrow();
  });

  it("API senders cannot impersonate Codec, and owner replies clear the cap", async () => {
    setTeamMessageLimit("red", 1);
    send();
    const response = await call("projects/alpha/messages", { from: "codec", to: a, body: "Continue" });
    expect(response).toMatchObject({ status: 201, data: [expect.objectContaining({ from: "owner" })] });
    expect(cappedMessagePairs()).toEqual([]);
    expect(listMessages({ from: "codec" })).toHaveLength(2);
    expect(() => send()).not.toThrow();
  });
});
