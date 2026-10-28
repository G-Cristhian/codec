import { spawn } from "child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { addProject } from "../src/registry.js";
import { addMember, addSpecialist, addTeam, editMember, editSpecialist, resolveMember } from "../src/org.js";
import { getRunStatus, listRuns, runOutput, startRun, stopRun, type RunRecord } from "../src/runs.js";
import { readEvents } from "../src/events.js";
import { startDashboard, type Dashboard } from "../src/dashboard.js";
import { checkTimeLimit, formatTimeLimit } from "../src/limits.js";
import { renderPage } from "../src/ui.js";
import { cleanupTemps, cli, makeRepo, useIsolatedHome, waitFor } from "./helpers.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 12_000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition did not become true in time");
    await pause(25);
  }
}
function alive(id: number): boolean {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${id}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
    }
    process.kill(id, 0);
    return true;
  } catch { return false; }
}
function groupId(dir: string, name: string): number {
  return Number(readFileSync(join(dir, name), "utf8").trim());
}
function commandsIn(dir: string): string[] {
  return readdirSync("/proc").filter((n) => /^\d+$/.test(n)).flatMap((n) => {
    try {
      const cmd = readFileSync(`/proc/${n}/cmdline`, "utf8");
      return cmd.includes(dir) ? [cmd] : [];
    } catch { return []; }
  });
}

let home: string;
let dashboard: Dashboard | undefined;
beforeEach(() => {
  home = useIsolatedHome("echo saved output; echo kept > result.txt");
  addProject(makeRepo("alpha"));
});
afterEach(async () => {
  await dashboard?.close();
  dashboard = undefined;
  for (const run of listRuns()) {
    if (run.state === "running") stopRun(run.runId);
    // Also clean up jobs from deliberate wrapper-loss tests or a failed assertion.
    const dir = join(home, "runs", run.runId);
    for (const name of ["agent_group"]) {
      try { process.kill(-groupId(dir, name), "SIGKILL"); } catch { /* already gone */ }
    }
    try { process.kill(-run.pid!, "SIGKILL"); } catch { /* already gone */ }
  }
  cleanupTemps();
});

function org() {
  addSpecialist({ name: "tester", specialty: "testing", tool: "codex", timeLimitMinutes: 90 });
  addTeam({ name: "red", projects: ["alpha"] });
  addMember("red", { name: "inherited", specialist: "tester" });
  addMember("red", { name: "overridden", specialist: "tester", timeLimitMinutes: 1 });
  addMember("red", { name: "worker", tool: "codex" });
}

async function call(path: string, body?: unknown) {
  dashboard ??= await startDashboard({ port: 0 });
  const response = await fetch(`http://127.0.0.1:${dashboard.port}/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-Codec-Token": dashboard.token, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as any };
}

describe("run time limits", () => {
  it("resolves run, member, specialist, and default limits and saves the effective deadline", async () => {
    org();
    const inputs = [
      { member: "red/overridden", timeLimitMinutes: 0.5 },
      { member: "red/overridden" },
      { member: "red/inherited" },
      { member: "red/worker" },
      { agent: "codex" },
    ];
    const runs = inputs.map((input) => startRun({ project: "alpha", task: "go", ...input }));
    expect(runs.map((r) => r.timeLimitMinutes)).toEqual([0.5, 1, 90, 60, 60]);
    for (const run of runs) {
      expect(Date.parse(run.deadline!) - Date.parse(run.startedAt)).toBe(run.timeLimitMinutes! * 60_000);
      const record = JSON.parse(readFileSync(join(home, "runs", run.runId, "run.json"), "utf8"));
      expect(record.timeLimitMinutes).toBe(run.timeLimitMinutes);
      expect(record.deadline).toBe(run.deadline);
      await waitFor(run.runId);
    }
    editSpecialist("tester", { timeLimitMinutes: 120 });
    expect(resolveMember("red", "inherited").timeLimitMinutes).toBe(120);
    expect(resolveMember("red", "overridden").timeLimitMinutes).toBe(1);
    editMember("red", "worker", { timeLimitMinutes: 0.05 });
    expect(resolveMember("red", "worker").timeLimitMinutes).toBe(0.05);
    expect(getRunStatus(runs[2].runId)!.timeLimitMinutes).toBe(90);
  });

  it.each([0, -1, 1441, Infinity, NaN, "1", null, true])("rejects an invalid limit %s", (value) => {
    expect(() => checkTimeLimit(value)).toThrow(/time limit.*positive.*1440/);
  });

  it("accepts fractions and the maximum and formats durations in plain words", () => {
    expect(checkTimeLimit(0.05)).toBe(0.05);
    expect(checkTimeLimit(1440)).toBe(1440);
    expect([0.05, 1, 90, 0.001, undefined].map(formatTimeLimit)).toEqual([
      "3 seconds", "1 minute", "90 minutes", "0.06 seconds", "No time limit",
    ]);
  });

  it("enforces the limit after the starting CLI exits and ends resistant descendants", async () => {
    // Two shells and a grandchild; ignore the first request so escalation is exercised.
    process.env.CODEC_AGENT_COMMAND = `echo saved output; echo kept > result.txt; bash -c 'trap "" TERM; sleep 120 & echo $! > "$CODEC_RUN_DIR/grandchild"; wait' & wait`;
    const started = cli(["run", "alpha", "--agent", "codex", "--task", "wait", "--time-limit", "0.05"]);
    expect(started.code, started.stderr).toBe(0);
    const id = /started (run-[a-f0-9]+)/.exec(started.stdout)![1];
    const dir = join(home, "runs", id);
    await until(() => existsSync(join(dir, "grandchild")));
    const child = groupId(dir, "grandchild");
    expect(alive(child)).toBe(true);
    // Wait on files directly: no Codec status reader is needed to enforce the limit.
    await until(() => existsSync(join(dir, "exit_code")));
    await until(() => readEvents().some((e) => e.kind === "run.finish" && e.runId === id));
    expect(getRunStatus(id)!.state).toBe("timed_out");
    expect(getRunStatus(id)!.exitCode).toBe(124);
    expect(alive(child)).toBe(false);
    expect(runOutput(id)).toContain("saved output");
    expect(existsSync(join(getRunStatus(id)!.worktree, "result.txt"))).toBe(true);
    expect(readEvents().filter((e) => e.kind === "run.timeout" && e.runId === id)).toHaveLength(1);
    expect(cli(["status"]).stdout).toContain("Stopped: took longer than 3 seconds");
    if (process.platform === "linux") await until(() => commandsIn(dir).length === 0);
  });

  it("cancels and reaps the timer when a fast agent finishes", async () => {
    const run = startRun({ project: "alpha", agent: "codex", task: "go", timeLimitMinutes: 90 });
    const dir = join(home, "runs", run.runId);
    expect((await waitFor(run.runId)).state).toBe("done");
    expect(alive(groupId(dir, "timer_pid"))).toBe(false);
    expect(existsSync(join(dir, "timed_out"))).toBe(false);
    expect(readEvents().some((e) => e.kind === "run.timeout")).toBe(false);
    if (process.platform === "linux") await until(() => commandsIn(dir).length === 0);
  });

  it("recovers an overdue run when status is read, even after its wrapper is lost", async () => {
    process.env.CODEC_AGENT_COMMAND = `bash -c 'trap "" TERM; sleep 120 & echo $! > "$CODEC_RUN_DIR/grandchild"; wait' & wait`;
    const run = startRun({ project: "alpha", agent: "codex", task: "go" });
    const dir = join(home, "runs", run.runId);
    await until(() => existsSync(join(dir, "grandchild")));
    const child = groupId(dir, "grandchild");
    process.kill(run.pid!, "SIGKILL");
    await until(() => !alive(run.pid!));
    writeFileSync(join(dir, "run.json"), JSON.stringify({ ...run, deadline: new Date(Date.now() - 31_000).toISOString() }));
    expect(getRunStatus(run.runId)!.state).toBe("timed_out");
    expect(alive(child)).toBe(false);
    expect(getRunStatus(run.runId)!.state).toBe("timed_out");
    expect(readEvents().filter((e) => e.kind === "run.timeout")).toHaveLength(1);
  });

  it("recovers an overdue live wrapper and allows a 30-second grace period", async () => {
    process.env.CODEC_AGENT_COMMAND = "sleep 120";
    const run = startRun({ project: "alpha", agent: "codex", task: "go" });
    const dir = join(home, "runs", run.runId);
    await until(() => existsSync(join(dir, "agent_group")));
    const agent = groupId(dir, "agent_group");
    const file = join(dir, "run.json");
    writeFileSync(file, JSON.stringify({ ...run, deadline: new Date(Date.now() - 1000).toISOString() }));
    expect(getRunStatus(run.runId)!.state).toBe("running");
    writeFileSync(file, JSON.stringify({ ...run, deadline: new Date(Date.now() - 31_000).toISOString() }));
    expect(getRunStatus(run.runId)!.state).toBe("timed_out");
    expect(alive(agent)).toBe(false);
    expect(alive(run.pid!)).toBe(false);
  });

  it("loads old run records without inferring a deadline", async () => {
    process.env.CODEC_AGENT_COMMAND = "sleep 120";
    const run = startRun({ project: "alpha", agent: "codex", task: "old" });
    const old: RunRecord = { ...run };
    delete old.timeLimitMinutes;
    delete old.deadline;
    old.startedAt = "2020-01-01T00:00:00Z";
    writeFileSync(join(home, "runs", run.runId, "run.json"), JSON.stringify(old));
    const status = getRunStatus(run.runId)!;
    expect(status.state).toBe("running");
    expect(status.timeLimitMinutes).toBeUndefined();
    expect(status.deadline).toBeUndefined();
    const detail = (await call(`runs/${run.runId}`)).json;
    expect(detail.state).toBe("running");
    expect(detail.deadline).toBeUndefined();
    stopRun(run.runId);
  });

  it("does not end an unrelated job when a saved group number has been reused", async () => {
    const run = startRun({ project: "alpha", agent: "codex", task: "go" });
    await waitFor(run.runId);
    const dir = join(home, "runs", run.runId);
    // A detached job without this run's environment simulates reuse after a restart.
    const unrelated = spawn("sleep", ["120"], { detached: true, stdio: "ignore", env: {} });
    try {
      const { unlinkSync } = await import("fs");
      unlinkSync(join(dir, "exit_code"));
      writeFileSync(join(dir, "agent_group"), String(unrelated.pid));
      writeFileSync(join(dir, "run.json"), JSON.stringify({ ...run, deadline: new Date(Date.now() - 31_000).toISOString() }));
      expect(getRunStatus(run.runId)!.state).toBe("timed_out");
      expect(alive(unrelated.pid!)).toBe(true);
    } finally {
      unrelated.kill("SIGKILL");
    }
  });

  it("preserves lost-run behavior before the deadline", async () => {
    process.env.CODEC_AGENT_COMMAND = "sleep 120";
    const run = startRun({ project: "alpha", agent: "codex", task: "go" });
    process.kill(-run.pid!, "SIGKILL");
    await until(() => !alive(run.pid!));
    expect(getRunStatus(run.runId)!.state).toBe("failed");
    expect(readEvents().some((e) => e.kind === "run.timeout")).toBe(false);
  });

  it("validates all CLI entry points and stores fractional options", async () => {
    org();
    const prefixes = [
      ["run", "alpha", "--agent", "codex", "--task", "go"],
      ["specialist", "add", "new", "--specialty", "QA", "--tool", "codex"],
      ["specialist", "edit", "tester"],
      ["team", "member", "add", "red", "--tool", "codex"],
    ];
    for (const prefix of prefixes) {
      for (const value of ["0", "-1", "1441", "NaN", "abc", ""]) {
        const response = cli([...prefix, "--time-limit", value]);
        expect(response.code, response.stdout).toBe(1);
        expect(response.stderr).toMatch(/time limit.*positive.*1440/);
      }
    }
    expect(cli(["specialist", "edit", "tester", "--time-limit", "0.05"]).code).toBe(0);
    expect(resolveMember("red", "inherited").timeLimitMinutes).toBe(0.05);
    expect(cli(["team", "member", "add", "red", "--name", "tiny", "--tool", "codex", "--time-limit", "0.5"]).code).toBe(0);
    expect(resolveMember("red", "tiny").timeLimitMinutes).toBe(0.5);
    expect(cli(["help"]).stdout).toContain("--time-limit <minutes>");
  });

  it("validates API create/edit options and exposes timed-out wording on the board and run page", async () => {
    org();
    const endpoints: [string, Record<string, unknown>][] = [
      ["projects/alpha/runs", { agent: "codex", task: "go" }],
      ["specialists", { name: "new", specialty: "QA", tool: "codex" }],
      ["specialists/tester/edit", {}],
      ["teams/red/members", { tool: "codex" }],
      ["teams/red/members/worker/edit", {}],
    ];
    for (const [path, body] of endpoints) {
      for (const timeLimitMinutes of [0, -1, 1441, "0.05", null, true]) {
        const response = await call(path, { ...body, timeLimitMinutes });
        expect(response.status).toBe(400);
        expect(response.json.code).toBe("invalid_time_limit");
      }
    }
    expect((await call("specialists", { name: "new", specialty: "QA", tool: "codex", timeLimitMinutes: 1 })).json.timeLimitMinutes).toBe(1);
    expect((await call("specialists/tester/edit", { timeLimitMinutes: 0.5 })).json.timeLimitMinutes).toBe(0.5);
    expect((await call("teams/red/members", { name: "tiny", tool: "codex", timeLimitMinutes: 0.05 })).json.timeLimitMinutes).toBe(0.05);
    expect((await call("teams/red/members/worker/edit", { timeLimitMinutes: 1 })).json.timeLimitMinutes).toBe(1);
    expect((await call("members/red/worker")).json.timeLimitMinutes).toBe(1);
    process.env.CODEC_AGENT_COMMAND = "echo saved output; sleep 120";
    const started = await call("projects/alpha/runs", { agent: "codex", task: "go", timeLimitMinutes: 0.05 });
    expect(started.status).toBe(201);
    expect(started.json.timeLimitMinutes).toBe(0.05);
    expect(started.json.deadline).toBeTruthy();
    const id = started.json.runId;
    await until(() => existsSync(join(home, "runs", id, "exit_code")));
    const detail = (await call(`runs/${id}`)).json;
    expect(detail).toMatchObject({
      state: "timed_out", lane: "needsYou", stateText: "Stopped: went over its time limit (3 seconds)", timeLimitMinutes: 0.05,
    });
    expect(detail.log).toContain("saved output");
    const board = (await call("projects/alpha")).json;
    expect(board.lanes.needsYou[0]).toMatchObject({ runId: id, stateText: detail.stateText, timeLimitMinutes: 0.05, deadline: detail.deadline });
    const page = renderPage("test-token");
    expect(page).toContain('if (r.state === "timed_out") return r.stateText');
    expect(page).toContain('text: "Time limit"');
    expect(page).toContain('Time limit (minutes)');
    const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)![1];
    expect(() => new Function(script)).not.toThrow();
  });
});
