import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { addProject } from "../src/registry.js";
import { cleanRun, findRun, getRunStatus, listRuns, runOutput, startRun, stopRun } from "../src/runs.js";
import { readEvents } from "../src/events.js";
import { pidAlive } from "../src/store.js";
import { cleanupTemps, makeRepo, useIsolatedHome, waitFor } from "./helpers.js";

// Fake agent: proves it runs inside its own worktree with the task file.
const FAKE = `sleep 1; cat "$CODEC_TASK_FILE" > agent-output.txt; echo "fake agent $CODEC_RUN_ID"`;

const gitOut = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf-8" });

describe("agent runs", () => {
  beforeEach(() => useIsolatedHome(FAKE));
  afterEach(() => {
    for (const r of listRuns({ state: "running" })) stopRun(r.runId);
    cleanupTemps();
  });

  it("creates a private worktree and branch per run", async () => {
    const repo = makeRepo("alpha");
    addProject(repo);
    const run = startRun({ project: "alpha", agent: "claude", task: "write hello" });

    expect(run.state).toBe("running");
    expect(run.branch).toBe(`codec/${run.runId}`);
    expect(existsSync(join(run.worktree, "README.md"))).toBe(true);
    expect(gitOut(repo, "worktree", "list")).toContain(run.worktree);
    expect(gitOut(run.worktree, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(run.branch);

    const done = await waitFor(run.runId);
    expect(done.state).toBe("done");
    expect(done.exitCode).toBe(0);
    expect(readFileSync(join(run.worktree, "agent-output.txt"), "utf-8")).toBe("write hello");
    // The agent's file is in its worktree only — the real project is untouched.
    expect(existsSync(join(repo, "agent-output.txt"))).toBe(false);
    expect(runOutput(run.runId)).toContain(`fake agent ${run.runId}`);
  });

  it("runs many agents across projects in parallel", async () => {
    addProject(makeRepo("alpha"));
    addProject(makeRepo("beta"));
    process.env.CODEC_AGENT_COMMAND = `sleep 2; echo ok`;

    const t0 = Date.now();
    const runs = [
      startRun({ project: "alpha", agent: "claude", task: "a1" }),
      startRun({ project: "alpha", agent: "codex", task: "a2" }),
      startRun({ project: "beta", agent: "claude", task: "b1" }),
      startRun({ project: "beta", agent: "codex", task: "b2" }),
    ];
    expect(listRuns({ state: "running" })).toHaveLength(4);
    expect(new Set(runs.map((r) => r.worktree)).size).toBe(4);

    const finished = await Promise.all(runs.map((r) => waitFor(r.runId)));
    expect(finished.map((r) => r.state)).toEqual(["done", "done", "done", "done"]);
    // Four 2-second agents finishing well under 8s means they overlapped.
    expect(Date.now() - t0).toBeLessThan(6000);

    const ev = readEvents();
    expect(ev.filter((e) => e.kind === "run.start")).toHaveLength(4);
    const fin = ev.filter((e) => e.kind === "run.finish");
    expect(fin).toHaveLength(4);
    expect(new Set(fin.map((e) => e.runId))).toEqual(new Set(runs.map((r) => r.runId)));
    expect(fin.every((e) => e.exitCode === 0)).toBe(true);
  });

  it("reports a failing agent as failed with its exit code", async () => {
    addProject(makeRepo("alpha"));
    process.env.CODEC_AGENT_COMMAND = `echo boom; exit 3`;
    const run = startRun({ project: "alpha", agent: "codex", task: "x" });
    const s = await waitFor(run.runId);
    expect(s.state).toBe("failed");
    expect(s.exitCode).toBe(3);
  });

  it("stops a running agent and its children", async () => {
    addProject(makeRepo("alpha"));
    process.env.CODEC_AGENT_COMMAND = `sleep 60`;
    const run = startRun({ project: "alpha", agent: "claude", task: "x" });
    expect(pidAlive(run.pid!)).toBe(true);
    const s = stopRun(run.runId.slice(4, 8)); // short prefix works
    expect(s.state).toBe("stopped");
    expect(() => stopRun(run.runId)).toThrow(/not running/);
    expect(readEvents().some((e) => e.kind === "run.stop" && e.runId === run.runId)).toBe(true);
  });

  it("recovers state when an agent dies without reporting (crash/reboot)", async () => {
    addProject(makeRepo("alpha"));
    process.env.CODEC_AGENT_COMMAND = `sleep 60`;
    const run = startRun({ project: "alpha", agent: "claude", task: "x" });
    process.kill(-run.pid!, "SIGKILL"); // nothing gets a chance to write an exit code
    await new Promise((r) => setTimeout(r, 200));

    expect(getRunStatus(run.runId)!.state).toBe("failed");
    expect(getRunStatus(run.runId)!.lostAt).toBeTruthy();
    // Detected once, logged once, no matter how often status is read.
    expect(readEvents().filter((e) => e.kind === "run.lost")).toHaveLength(1);
  });

  it("cleans a finished worktree, keeping the branch unless asked", async () => {
    const repo = makeRepo("alpha");
    addProject(repo);
    process.env.CODEC_AGENT_COMMAND = `sleep 60`;
    const live = startRun({ project: "alpha", agent: "claude", task: "x" });
    expect(() => cleanRun(live.runId)).toThrow(/still running/);
    stopRun(live.runId);
    cleanRun(live.runId);
    expect(existsSync(live.worktree)).toBe(false);
    expect(gitOut(repo, "worktree", "list")).not.toContain(live.worktree);
    expect(gitOut(repo, "branch", "--list", live.branch)).toContain(live.branch);
    expect(findRun(live.runId).cleanedAt).toBeTruthy();

    process.env.CODEC_AGENT_COMMAND = `echo change > dirty.txt`;
    const dirty = startRun({ project: "alpha", agent: "codex", task: "y" });
    await waitFor(dirty.runId);
    expect(() => cleanRun(dirty.runId)).toThrow(/uncommitted changes/);
    cleanRun(dirty.runId, { force: true, deleteBranch: true });
    expect(existsSync(dirty.worktree)).toBe(false);
    expect(gitOut(repo, "branch", "--list", dirty.branch).trim()).toBe("");
  });

  it("validates input", () => {
    addProject(makeRepo("alpha"));
    expect(() => startRun({ project: "alpha", agent: "gpt", task: "x" })).toThrow(/unknown agent/);
    expect(() => startRun({ project: "nope", agent: "claude", task: "x" })).toThrow(/no project/);
    expect(() => startRun({ project: "alpha", agent: "claude", task: " " })).toThrow(/--task/);
    expect(() => findRun("zzzz")).toThrow(/no run/);
  });

  it("builds the real agent command lines", async () => {
    const { agentCommand } = await import("../src/runs.js");
    delete process.env.CODEC_AGENT_COMMAND;
    expect(agentCommand("claude")).toBe(
      `claude --dangerously-skip-permissions -p "$(cat "$CODEC_TASK_FILE")" --output-format stream-json --verbose`,
    );
    expect(agentCommand("codex")).toBe(`codex exec --yolo "$(cat "$CODEC_TASK_FILE")"`);
    expect(agentCommand("claude", { model: "opus", instructions: true })).toBe(
      `claude --dangerously-skip-permissions -p "$(cat "$CODEC_TASK_FILE")" --output-format stream-json --verbose` +
        ` --model 'opus' --append-system-prompt "$(cat "$CODEC_RUN_DIR/instructions.md")"`,
    );
    expect(agentCommand("codex", { model: "gpt-6-astra", instructions: true })).toBe(
      `codex exec --yolo -m 'gpt-6-astra' -c "developer_instructions=$(cat "$CODEC_RUN_DIR/instructions.toml")" "$(cat "$CODEC_TASK_FILE")"`,
    );
  });
});
