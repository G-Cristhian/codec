import { execFile } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { promisify } from "util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAccount, setAccountChoice } from "../src/accounts.js";
import { assignByRole, getCoordinator, isPmHelper, setupCoordinator } from "../src/coordinator.js";
import { homeView, laneOf, projectView, startDashboard, type Dashboard } from "../src/dashboard.js";
import { listMessages, markRead, postMessage, receiveMessages } from "../src/messages.js";
import { addMember, addSpecialist, addTeam } from "../src/org.js";
import { addProject } from "../src/registry.js";
import { getRunStatus, listRuns, runOutput, startRun, stopRun } from "../src/runs.js";
import { coordinatorFile, coordinatorInboxFile, inboxFile, messageLimitsFile, readJson } from "../src/store.js";
import { S, wording } from "../src/strings.js";
import { cleanupTemps, cli, makeRepo, makeUiBundle, useIsolatedHome, waitFor } from "./helpers.js";

const command = '"$CODEC_NODE" "$CODEC_CLI"';
const start = (project = "alpha") => startRun({ project, member: "coordinator", task: "Coordinate the work" });
let home: string;
let dashboard: Dashboard | undefined;

beforeEach(() => {
  home = useIsolatedHome("true");
  delete process.env.CODEC_RUN_ID;
  addProject(makeRepo("alpha"));
});

afterEach(async () => {
  await dashboard?.close();
  dashboard = undefined;
  for (const run of listRuns({ state: "running" })) stopRun(run.runId);
  vi.restoreAllMocks();
  cleanupTemps();
});

function team(name = "red", project = "alpha") {
  addTeam({ name, projects: [project] });
  addMember(name, { name: "worker", tool: "claude" });
  addMember(name, { name: "team-PmLead", tool: "codex" });
}

function roles() {
  team();
  addSpecialist({ name: "Builder", specialty: "Builds and checks websites", tool: "codex" });
  addMember("red", { name: "first", specialist: "Builder" });
  addMember("red", { name: "second", specialist: "Builder" });
  team("blue");
  addMember("blue", { name: "third", specialist: "Builder" });
}

async function outputContains(runId: string, text: string) {
  await vi.waitFor(() => expect(runOutput(runId)).toContain(text), { timeout: 15_000 });
}

describe("coordinator settings and runs", () => {
  it("explains how to set up before starting or messaging it", () => {
    expect(getCoordinator()).toBeUndefined();
    expect(() => start()).toThrow(S.errors.coordinator_not_setup);
    expect(() => postMessage({ from: "owner", to: "coordinator", body: "Hello" })).toThrow(S.errors.coordinator_not_setup);
    const result = cli(["run", "alpha", "--member", "coordinator", "--task", "Coordinate"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(S.errors.coordinator_not_setup);
    expect(cli(["coordinator"]).stdout).toContain(S.coordinator.notSetup);
    expect(listRuns()).toEqual([]);
  });

  it("saves settings once per install and keeps the creation time when changed", () => {
    const result = cli(["coordinator", "setup", "--tool", "codex", "--model", "test-model", "--time-limit", "12.5"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Codex");
    const saved = getCoordinator()!;
    expect(saved).toEqual({ tool: "codex", model: "test-model", timeLimitMinutes: 12.5, createdAt: expect.any(String) });
    expect(coordinatorFile()).toBe(join(home, "coordinator.json"));
    expect(readJson(coordinatorFile(), null)).toEqual(saved);
    expect(setupCoordinator({ tool: "claude", model: "  opus  " })).toEqual({ tool: "claude", model: "opus", timeLimitMinutes: undefined, createdAt: saved.createdAt });
    expect(cli(["coordinator"]).stdout).toContain(S.home.free);
  });

  it("rejects bad tools, models and limits without replacing saved settings", () => {
    const saved = setupCoordinator({ tool: "claude" });
    expect(() => setupCoordinator({ tool: "other" })).toThrow(/unknown tool/);
    expect(cli(["coordinator", "setup", "--tool", "other"]).code).toBe(1);
    expect(() => setupCoordinator({ tool: "codex", model: "bad model" })).toThrow(/invalid model/);
    expect(() => setupCoordinator({ tool: "codex", timeLimitMinutes: -1 })).toThrow();
    expect(getCoordinator()).toEqual(saved);
  });

  it.each(["claude", "codex"])("starts with configured %s on a project without a team, and rejects a second task across projects", async (tool) => {
    setupCoordinator({ tool, model: "test-model", timeLimitMinutes: 5 });
    process.env.CODEC_AGENT_COMMAND = 'echo "$CODEC_AGENT"; sleep 60';
    const run = startRun({ project: "alpha", member: "coordinator", task: "Coordinate", timeLimitMinutes: 20 });
    await outputContains(run.runId, tool);
    expect(run).toMatchObject({ member: "coordinator", agent: tool, model: "test-model", timeLimitMinutes: 5 });
    expect(run.team).toBeUndefined();
    expect(laneOf(run)).toBe("working");
    expect(existsSync(join(run.worktree, "messages.md"))).toBe(true);
    expect(readFileSync(join(home, "runs", run.runId, "instructions.md"), "utf-8"))
      .toBe([S.helperInstructions.coordinator, S.helperInstructions.messages, S.helperInstructions.reportStatus, S.helperInstructions.attribution].join("\n\n") + "\n");
    addProject(makeRepo("beta"));
    expect(() => start("beta")).toThrow(S.errors.coordinator_busy);
    expect(cli(["coordinator"]).stdout).toContain(S.tasks.working);
    expect(cli(["status"]).stdout).toContain(S.coordinator.name);
    expect(projectView("beta").helpers).toEqual([{ ref: "coordinator", name: S.coordinator.name, running: true }]);
    stopRun(run.runId);
    expect(start("beta").project).toBe("beta");
  });

  it("serializes simultaneous starts from separate CLI processes", async () => {
    setupCoordinator({ tool: "codex" });
    process.env.CODEC_AGENT_COMMAND = "sleep 60";
    const args = ["--import", "tsx", resolve("src/cli.ts"), "run", "alpha", "--member", "coordinator", "--task", "Coordinate"];
    const results = await Promise.allSettled([promisify(execFile)(process.execPath, args), promisify(execFile)(process.execPath, args)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.stderr).toContain(S.errors.coordinator_busy);
    expect(listRuns({ state: "running" })).toHaveLength(1);
  });

  it("resolves helper:coordinator account choices without a team", async () => {
    setupCoordinator({ tool: "codex" });
    const account = addAccount("codex", "Coordinator login");
    setAccountChoice("helper", "coordinator", "codex", account.id);
    const run = start();
    expect(run.account).toEqual({ id: account.id, name: account.name });
    await waitFor(run.runId);
  });
});

describe("coordinator messages", () => {
  it.each([
    ["red/pm", true], ["blue/team-pm", true], ["ops/PMLead", true],
    ["pm/worker", false], ["coordinator", false], ["red/writer", false],
  ])("checks only the member name for PM authority: %s", (ref, allowed) => {
    expect(isPmHelper(ref)).toBe(allowed);
  });

  it("delivers owner and mixed-case PM messages but declines a running non-PM, replies directly and shows both rows", async () => {
    setupCoordinator({ tool: "codex" });
    team();
    process.env.CODEC_AGENT_COMMAND = "sleep 60";
    const coordinator = start();
    const owner = postMessage({ from: "owner", to: "coordinator", body: "Owner direction" });
    expect(owner).toMatchObject({ runId: coordinator.runId, deliveredAt: expect.any(String) });
    process.env.CODEC_AGENT_COMMAND = `${command} message coordinator "PM direction" && sleep 60`;
    const pm = startRun({ project: "alpha", member: "red/team-PmLead", task: "Coordinate" });
    await outputContains(pm.runId, wording(S.cli.messageSent, { helper: S.coordinator.name }));
    process.env.CODEC_AGENT_COMMAND = `${command} message coordinator "Worker direction" && echo accepted-exit-zero && sleep 60`;
    const worker = startRun({ project: "alpha", member: "red/worker", task: "Ask coordinator" });
    await outputContains(worker.runId, "accepted-exit-zero");
    expect(runOutput(worker.runId)).toContain(S.coordinator.pmOnly);
    expect(readFileSync(join(worker.worktree, "messages.md"), "utf-8")).toContain(S.coordinator.pmOnly);
    const messages = readFileSync(join(coordinator.worktree, "messages.md"), "utf-8");
    expect(messages).toContain("Owner direction");
    expect(messages).toContain("PM direction");
    expect(messages).not.toContain("Worker direction");
    const declined = listMessages({ to: "coordinator", from: "red/worker" })[0];
    expect(declined).toMatchObject({ declined: true, deliveredAt: expect.any(String) });
    expect(declined.runId).toBeUndefined();
    expect(projectView("alpha").messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ body: "Worker direction", senderKind: "helper", waiting: false }),
      expect.objectContaining({ body: S.coordinator.pmOnly, senderName: S.coordinator.name, senderKind: "coordinator", waiting: false }),
    ]));
    expect(receiveMessages("coordinator", coordinator.runId)).toEqual([]);
    stopRun(coordinator.runId);
    process.env.CODEC_AGENT_COMMAND = "cat messages.md";
    const next = start();
    await waitFor(next.runId);
    expect(runOutput(next.runId)).not.toContain("Worker direction");
  });

  it("queues accepted messages and decline replies, drains them on start, and marks the coordinator inbox read", async () => {
    setupCoordinator({ tool: "claude" });
    team();
    const owner = postMessage({ from: "owner", to: "coordinator", body: "Queued owner note" });
    postMessage({ from: "red/worker", to: "coordinator", body: "Declined queued note" });
    expect(owner.deliveredAt).toBeUndefined();
    expect(coordinatorInboxFile()).toBe(join(home, "messages", "_coordinator.json"));
    process.env.CODEC_AGENT_COMMAND = "cat messages.md";
    const coordinator = start();
    const worker = startRun({ project: "alpha", member: "red/worker", task: "Read inbox" });
    await Promise.all([waitFor(coordinator.runId), waitFor(worker.runId)]);
    expect(runOutput(coordinator.runId)).toContain(owner.body);
    expect(runOutput(coordinator.runId)).not.toContain("Declined queued note");
    expect(runOutput(worker.runId)).toContain(S.coordinator.pmOnly);
    markRead([owner.id]);
    expect(listMessages({ to: "coordinator", unread: true })).toHaveLength(1);
  });

  it("reports to the owner and helpers through real commands, and can report task status", async () => {
    setupCoordinator({ tool: "claude" });
    team();
    process.env.CODEC_AGENT_COMMAND = `${command} message owner "Team update" && ${command} message red/team-PmLead "PM update" && ${command} report stuck "Choose the next priority" && sleep 60`;
    const run = start();
    await vi.waitFor(() => expect(getRunStatus(run.runId)?.helperStatus?.state).toBe("stuck"), { timeout: 15_000 });
    expect(laneOf(getRunStatus(run.runId)!)).toBe("needsYou");
    expect(listMessages({ to: "owner" })[0]).toMatchObject({ from: "coordinator", body: "Team update", deliveredAt: expect.any(String) });
    expect(listMessages({ to: "red/team-PmLead" })[0]).toMatchObject({ from: "coordinator", body: "PM update" });
    expect(() => postMessage({ from: "red/worker", to: "owner", body: "Hello" })).toThrow(S.errors.coordinator_owner_only);
    expect(() => postMessage({ from: "coordinator", to: "coordinator", body: "Hello" })).toThrow(S.errors.coordinator_self_message);
  });

  it.each(["red/worker", "red/team-PmLead"])("rejects a direct cross-team message from %s and explains the coordinator route without storing or counting it", (from) => {
    setupCoordinator({ tool: "claude" });
    team("red");
    team("blue");
    const to = "blue/worker";
    const error = "blue/worker is on another team. Send cross-team messages through the coordinator: if you are your team's PM, message coordinator; otherwise pass it to your PM.";
    expect(wording(S.errors.cross_team_message, { to })).toBe(error);
    expect(() => postMessage({ from, to, body: "Check this directly" })).toThrowError(expect.objectContaining({
      name: "CodecError", code: "cross_team_message", message: error, params: { from, to }, status: 400,
    }));
    expect(listMessages()).toEqual([]);
    expect(existsSync(inboxFile("blue", "worker"))).toBe(false);
    expect(existsSync(coordinatorInboxFile())).toBe(false);
    expect(existsSync(messageLimitsFile())).toBe(false);
  });

  it("keeps same-team helper messages direct without coordinator involvement", () => {
    team();
    const direct = postMessage({ from: "red/worker", to: "red/team-PmLead", body: "Check this directly" });
    expect(listMessages()).toEqual([direct]);
    expect(listMessages({ helper: "coordinator" })).toEqual([]);
    expect(existsSync(coordinatorInboxFile())).toBe(false);
  });

  it.each(["owner", "coordinator"])("allows %s to message helpers on any team", (from) => {
    setupCoordinator({ tool: "claude" });
    for (const name of ["red", "blue"]) {
      team(name);
      const to = `${name}/worker`;
      const message = postMessage({ from, to, body: "Please check this" });
      expect(listMessages({ to })).toEqual([message]);
      expect(message).toMatchObject({ from, to, body: "Please check this" });
    }
    expect(listMessages()).toHaveLength(2);
  });

  it("routes a PM's cross-team request through the coordinator to the other team's helper", () => {
    setupCoordinator({ tool: "claude" });
    team("red");
    team("blue");
    const request = postMessage({ from: "red/team-PmLead", to: "coordinator", body: "Ask blue to check this" });
    expect(request.declined).toBeUndefined();
    expect(listMessages({ to: "coordinator" })).toEqual([request]);
    const forwarded = postMessage({ from: "coordinator", to: "blue/worker", body: "Please check this for red" });
    expect(listMessages({ to: "blue/worker" })).toEqual([forwarded]);
    expect(listMessages()).toHaveLength(2);
    expect(readJson(messageLimitsFile(), {})).toEqual({
      "coordinator|red/team-PmLead": { count: 1, limit: 10 },
      "blue/worker|coordinator": { count: 1, limit: 10 },
    });
  });
});

describe("coordinator assignments", () => {
  beforeEach(() => {
    setupCoordinator({ tool: "codex" });
    roles();
  });

  it("runs the real assign command, skips busy helpers in deterministic order and delivers the assignment before work", async () => {
    process.env.CODEC_AGENT_COMMAND = "sleep 60";
    const busy = startRun({ project: "alpha", member: "red/first", task: "Already busy" });
    process.env.CODEC_AGENT_COMMAND = `CODEC_AGENT_COMMAND='cat messages.md; sleep 60' ${command} assign bUiLdEr "Build the page" && sleep 60`;
    const run = start();
    await outputContains(run.runId, "Assigned to red/second.");
    const assigned = listRuns().find((task) => task.member === "second")!;
    expect(assigned).toMatchObject({ team: "red", member: "second", project: "alpha", task: "Build the page", state: "running" });
    await outputContains(assigned.runId, "The coordinator assigned you a task: Build the page");
    expect(runOutput(run.runId)).toContain(assigned.runId);
    expect(listMessages({ to: "red/second" })).toEqual([
      expect.objectContaining({ from: "coordinator", runId: assigned.runId, body: wording(S.coordinator.assigned, { task: "Build the page" }) }),
    ]);
    expect(getRunStatus(busy.runId)?.state).toBe("running");
    expect(listRuns().some((task) => task.team === "blue")).toBe(false);
  });

  it("supports specialty fallback and --project through the real command", async () => {
    addProject(makeRepo("beta"));
    team("green", "beta");
    addMember("green", { name: "builder", specialist: "Builder" });
    process.env.CODEC_AGENT_COMMAND = `CODEC_AGENT_COMMAND='sleep 60' ${command} assign WEBSITES "Check beta" --project beta`;
    const coordinator = start();
    expect((await waitFor(coordinator.runId)).state).toBe("done");
    expect(listRuns()).toEqual(expect.arrayContaining([
      expect.objectContaining({ team: "green", member: "builder", project: "beta", task: "Check beta", state: "running" }),
    ]));
  });

  it("serializes parallel assign commands so each task gets a different free helper", async () => {
    process.env.CODEC_AGENT_COMMAND = `CODEC_AGENT_COMMAND='sleep 60' ${command} assign Builder "First task" &
first=$!
CODEC_AGENT_COMMAND='sleep 60' ${command} assign Builder "Second task" &
second=$!
wait "$first" && wait "$second"`;
    const run = start();
    expect((await waitFor(run.runId)).state).toBe("done");
    const assigned = listRuns().filter((task) => task.team);
    expect(assigned.map((task) => `${task.team}/${task.member}`)).toEqual(["red/first", "red/second"]);
    expect(assigned.map((task) => task.task).sort()).toEqual(["First task", "Second task"]);
  });

  it("prefers an exact role name over a free specialty match and reports all busy", async () => {
    addSpecialist({ name: "Reviewer", specialty: "Builder support", tool: "claude" });
    addMember("red", { name: "fallback", specialist: "Reviewer" });
    process.env.CODEC_AGENT_COMMAND = "sleep 60";
    for (const member of ["red/first", "red/second", "blue/third"]) startRun({ project: "alpha", member, task: "Busy" });
    process.env.CODEC_AGENT_COMMAND = `${command} assign Builder "Wait for a builder"`;
    const run = start();
    expect((await waitFor(run.runId)).exitCode).toBe(1);
    expect(runOutput(run.runId)).toContain(wording(S.errors.coordinator_role_busy, { role: "Builder" }));
    expect(listMessages({ from: "coordinator" })).toEqual([]);
    expect(listRuns().some((task) => task.member === "fallback")).toBe(false);
  });

  it.each(["missing", "worker"])("reports no role match for %s; workers never match", async (role) => {
    process.env.CODEC_AGENT_COMMAND = `${command} assign ${role} "Do the work"`;
    const run = start();
    expect((await waitFor(run.runId)).exitCode).toBe(1);
    expect(runOutput(run.runId)).toContain(wording(S.errors.coordinator_no_role, { role }));
    expect(listMessages()).toEqual([]);
  });

  it("rejects a non-coordinator, even a PM helper, and callers outside a running task", async () => {
    expect(cli(["assign", "Builder", "Do the work"]).stderr).toContain(S.errors.coordinator_only);
    process.env.CODEC_AGENT_COMMAND = `${command} assign Builder "Do the work"`;
    for (const member of ["red/worker", "red/team-PmLead"]) {
      const run = startRun({ project: "alpha", member, task: "Try assigning" });
      expect((await waitFor(run.runId)).exitCode).toBe(1);
      expect(runOutput(run.runId)).toContain(S.errors.coordinator_only);
    }
    process.env.CODEC_AGENT_COMMAND = "true";
    const ended = start();
    await waitFor(ended.runId);
    expect(cli(["assign", "Builder", "Do the work"], { CODEC_RUN_ID: ended.runId }).stderr).toContain(S.errors.coordinator_only);
  });

  it("preserves task text beginning with a dash and rejects empty tasks or unknown projects", async () => {
    expect(() => assignByRole({ project: "alpha", role: "Builder", task: " " })).toThrow(S.errors.missing_task);
    expect(() => assignByRole({ project: "missing", role: "Builder", task: "Task" })).toThrow(S.errors.project_not_found);
    process.env.CODEC_AGENT_COMMAND = `CODEC_AGENT_COMMAND=true ${command} assign Builder "--help"`;
    const run = start();
    expect((await waitFor(run.runId)).state).toBe("done");
    const assigned = listRuns().find((task) => task.member === "first")!;
    expect(assigned.task).toBe("--help");
    await waitFor(assigned.runId);
  });
});

describe("coordinator dashboard API", () => {
  async function call(path: string, body?: unknown, token = dashboard!.token) {
    const response = await fetch(`http://127.0.0.1:${dashboard!.port}/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "X-Codec-Token": token, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  }

  beforeEach(async () => { dashboard = await startDashboard({ port: 0, uiBundleDir: makeUiBundle() }); });

  it("exposes authenticated settings GET/POST routes, validates input and includes settings in polling", async () => {
    expect(await call("coordinator")).toEqual({ status: 200, data: { settings: null, running: false } });
    expect((await call("coordinator", undefined, "wrong")).status).toBe(401);
    expect((await call("coordinator", { tool: "codex" }, "wrong")).status).toBe(401);
    expect((await call("coordinator", { tool: "other" })).data.code).toBe("invalid_tool");
    expect((await call("coordinator", { tool: "codex", timeLimitMinutes: 0 })).status).toBe(400);
    const saved = await call("coordinator", { tool: "claude", model: "opus", timeLimitMinutes: 10 });
    expect(saved).toMatchObject({ status: 200, data: { settings: { tool: "claude", model: "opus", timeLimitMinutes: 10 }, running: false } });
    expect(homeView().coordinator).toEqual(saved.data);
    expect((await call("coordinator")).data).toEqual(saved.data);
  });

  it("starts on a teamless project through the API and shows the configured tool and singleton state", async () => {
    expect((await call("projects/alpha/runs", { member: "coordinator", task: "Coordinate" })).data.code).toBe("coordinator_not_setup");
    await call("coordinator", { tool: "claude", model: "opus" });
    process.env.CODEC_AGENT_COMMAND = "sleep 60";
    const started = await call("projects/alpha/runs", { member: "coordinator", task: "Coordinate" });
    expect(started).toMatchObject({ status: 201, data: { member: "coordinator", agent: "claude" } });
    const view = (await call("projects/alpha")).data;
    expect(view.helpers).toEqual([{ ref: "coordinator", name: S.coordinator.name, running: true }]);
    expect(view.members).toEqual([{ ref: "coordinator", member: "coordinator", label: S.coordinator.name, tool: "claude" }]);
    expect((await call("coordinator")).data.running).toBe(true);
    expect((await call("projects/alpha/runs", { member: "coordinator", task: "Another" })).data.code).toBe("coordinator_busy");
  });

  it("accepts helper account choices for the reserved coordinator identity and checks its tool", async () => {
    const choice = { scope: "helper", name: "coordinator", kind: "codex", accountId: "computer-codex" };
    expect((await call("account-settings", choice)).data.code).toBe("coordinator_not_setup");
    setupCoordinator({ tool: "codex" });
    expect(await call("account-settings", choice)).toEqual({ status: 200, data: { "helper:coordinator": { codex: "computer-codex" } } });
    expect((await call("account-settings", { ...choice, kind: "claude" })).data.code).toBe("account_kind");
  });

  it("posts owner messages, shows owner/coordinator exchanges on every project, and keeps broadcasts and helper exchanges scoped", async () => {
    expect((await call("projects/alpha/messages", { to: "coordinator", body: "Hello" })).data.code).toBe("coordinator_not_setup");
    setupCoordinator({ tool: "codex" });
    team();
    addProject(makeRepo("beta"));
    team("blue", "beta");
    const owner = await call("projects/alpha/messages", { to: "coordinator", body: "Owner request" });
    expect(owner.status).toBe(201);
    postMessage({ from: "coordinator", to: "owner", body: "Install update" });
    postMessage({ from: "coordinator", to: "red/worker", body: "Red update" });
    postMessage({ from: "coordinator", to: "blue/worker", body: "Blue update" });
    for (const project of ["alpha", "beta"]) {
      const view = (await call(`projects/${project}`)).data;
      expect(view.helpers[0].ref).toBe("coordinator");
      expect(view.members[0].label).toBe(S.coordinator.name);
      expect(view.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ body: "Owner request", senderKind: "owner" }),
        expect.objectContaining({ body: "Install update", senderKind: "coordinator", senderName: S.coordinator.name, waiting: false }),
      ]));
      expect(view.messages.map((message: { body: string }) => message.body)).not.toContain(project === "alpha" ? "Blue update" : "Red update");
    }
    const broadcast = await call("projects/alpha/messages", { to: "all", body: "Team request" });
    expect(broadcast.data.map((message: { to: string }) => message.to)).toEqual(["red/worker", "red/team-PmLead"]);
    expect(listMessages({ to: "coordinator" })).toHaveLength(1);
    addProject(makeRepo("empty"));
    expect((await call("projects/empty/messages", { to: "coordinator", body: "Teamless request" })).status).toBe(201);
    expect((await call("projects/empty/messages", { to: "all", body: "No team" })).data.code).toBe("message_no_helpers");
  });
});
