import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { addProject, git } from "../src/registry.js";
import { addMember, addTeam } from "../src/org.js";
import { importSkill } from "../src/skills.js";
import { getRunStatus, listRuns, startRun, stopRun } from "../src/runs.js";
import { laneOf, runView } from "../src/dashboard.js";
import { saveIdentity } from "../src/settings.js";
import { modelFromCodexOutput } from "../src/codex-output.js";
import { S, wording } from "../src/strings.js";
import { cleanupTemps, makeRepo, tempDir, useIsolatedHome, waitFor } from "./helpers.js";

let home: string;
beforeEach(() => { home = useIsolatedHome("true"); });
afterEach(() => {
  for (const run of listRuns({ state: "running" })) stopRun(run.runId);
  vi.unstubAllEnvs();
  cleanupTemps();
});

describe("saved checkpoints before review", () => {
  it.each(["claude", "codex"] as const)("%s: wrapper saves leftover tracked and untracked work with the owner identity and excludes injected files", async (agent) => {
    const repo = makeRepo("alpha");
    writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
    git(repo, ["add", ".gitignore"]);
    git(repo, ["commit", "-qm", "Ignore scratch files"]);
    addProject(repo);
    const skill = tempDir();
    writeFileSync(join(skill, "SKILL.md"), "---\nname: review\ndescription: Review work\n---\nReview work.\n");
    importSkill(skill);
    addTeam({ name: "team", projects: ["alpha"] });
    addMember("team", { name: "helper", tool: agent, skills: ["review"] });
    const owner = { name: "Workspace Owner", email: "owner@example.invalid" };
    saveIdentity(owner);
    process.env.CODEC_AGENT_COMMAND = 'echo changed >> README.md; echo notes > notes.txt; echo scratch > ignored.txt';
    const run = startRun({ project: "alpha", member: "team/helper", task: '  Write notes $(touch bad)  \nSecond line' });
    const dir = join(home, "runs", run.runId);
    const wrapper = readFileSync(join(dir, "run.sh"), "utf-8");
    expect(wrapper).toContain("git add -A");
    expect(wrapper).toContain('commit -m "$CODEC_CHECKPOINT_MESSAGE"');
    expect(wrapper.indexOf("git add -A")).toBeGreaterThan(wrapper.indexOf('wait "$agent_pid"\n  code=$?'));
    // No dashboard or status polling is needed for the wrapper to save its result.
    await vi.waitFor(() => expect(existsSync(join(dir, "exit_code"))).toBe(true));
    expect(JSON.parse(readFileSync(join(dir, "checkpoint.json"), "utf-8"))).toEqual({ autoSaved: true });
    expect(git(run.worktree, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"]).out)
      .toBe(`${owner.name} <${owner.email}>|${owner.name} <${owner.email}>`);
    expect(git(run.worktree, ["log", "-1", "--format=%s"]).out).toBe(wording(S.tasks.checkpointMessage, { id: run.runId.slice(4), task: 'Write notes $(touch bad)' }));
    expect(git(run.worktree, ["ls-tree", "-r", "--name-only", "HEAD"]).out.split("\n")).toEqual([".gitignore", "README.md", "notes.txt"]);
    expect(git(run.worktree, ["status", "--porcelain"]).out).toBe("");
    const done = getRunStatus(run.runId)!;
    expect(done).toMatchObject({ autoSaved: true, reviewStatus: "ready" });
    expect(laneOf(done)).toBe("inReview");
    expect(runView(run.runId).autoSaved).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf-8")).autoSaved).toBe(true);
  });

  it("a failed save is coded, remains unsaved, and cannot be ready to review", async () => {
    const repo = makeRepo("alpha");
    git(repo, ["config", "core.hooksPath", "/dev/null"]);
    addProject(repo);
    process.env.CODEC_AGENT_COMMAND = 'echo leftover > notes.txt; git config core.hooksPath "$CODEC_RUN_DIR/hooks"; mkdir "$CODEC_RUN_DIR/hooks"; printf "#!/bin/sh\\nexit 1\\n" > "$CODEC_RUN_DIR/hooks/pre-commit"; chmod +x "$CODEC_RUN_DIR/hooks/pre-commit"';
    const run = await waitFor(startRun({ project: "alpha", agent: "codex", task: "Write notes" }).runId);
    expect(run).toMatchObject({ state: "done", checkpointError: "checkpoint_save_failed", reviewStatus: "unsaved" });
    expect(laneOf(run)).toBe("needsYou");
    expect(runView(run.runId).stateText).toBe(S.tasks.unsaved);
    expect(git(run.worktree, ["rev-parse", "HEAD"]).out).toBe(run.baseSha);
  });

  it("shows no changes separately, and rechecks files changed after exit", async () => {
    addProject(makeRepo("alpha"));
    const run = await waitFor(startRun({ project: "alpha", agent: "codex", task: "Check" }).runId);
    expect(run.reviewStatus).toBe("no_changes");
    expect(laneOf(run)).toBe("done");
    expect(runView(run.runId).stateText).toBe(S.tasks.noChanges);
    writeFileSync(join(run.worktree, "late.txt"), "unsaved");
    expect(getRunStatus(run.runId)?.reviewStatus).toBe("unsaved");
    expect(runView(run.runId)).toMatchObject({ lane: "needsYou", stateText: S.tasks.unsaved });
  });

  it("clean work the helper committed is ready without an automatic save", async () => {
    addProject(makeRepo("alpha"));
    process.env.CODEC_AGENT_COMMAND = 'echo saved > notes.txt; git add -A; git commit -qm "Write notes"';
    const run = await waitFor(startRun({ project: "alpha", agent: "codex", task: "Write" }).runId);
    expect(run.reviewStatus).toBe("ready");
    expect(run.autoSaved).toBeUndefined();
    expect(laneOf(run)).toBe("inReview");
    writeFileSync(join(run.worktree, "README.md"), "unsaved after checkpoint");
    expect(runView(run.runId).lane).toBe("needsYou");
  });

  it.each(["failed", "stopped", "timed_out", "lost"])("%s: unsaved work cannot enter review", async (ending) => {
    addProject(makeRepo("alpha"));
    process.env.CODEC_AGENT_COMMAND = ending === "failed" ? 'echo dirty > notes.txt; exit 2' : 'echo dirty > notes.txt; sleep 60';
    const run = startRun({ project: "alpha", agent: "codex", task: "Write", timeLimitMinutes: ending === "timed_out" ? 0.01 : 1 });
    await vi.waitFor(() => expect(existsSync(join(run.worktree, "notes.txt"))).toBe(true));
    if (ending === "stopped") stopRun(run.runId);
    if (ending === "lost") process.kill(-run.pid!, "SIGKILL");
    const done = await waitFor(run.runId);
    expect(done.reviewStatus).toBe("unsaved");
    expect(done.autoSaved).toBeUndefined();
    expect(laneOf(done)).toBe("needsYou");
    expect(runView(run.runId).stateText).toBe(S.tasks.unsaved);
  });

  it("a workspace that cannot be checked never enters review", async () => {
    addProject(makeRepo("alpha"));
    const run = await waitFor(startRun({ project: "alpha", agent: "codex", task: "Check" }).runId);
    writeFileSync(join(run.worktree, ".git"), "invalid");
    expect(runView(run.runId)).toMatchObject({ lane: "needsYou", reviewStatus: "unavailable" });
  });
});

describe("Codex model in the session header", () => {
  it.each([
    ["OpenAI Codex v0.162.1\n--------\nworkdir: /tmp/project\nmodel: gpt-6.1-sol\n--------\nuser\nWrite notes", "gpt-6.1-sol"],
    ["OpenAI Codex v0.162.1\n--------\nworkdir: /tmp/project\n--------\nuser\nmodel: pretend", undefined],
    ["OpenAI Codex v0.162.1\nmodel: \nuser\nCheck", undefined],
  ])("parses only the header model", (raw, expected) => {
    expect(modelFromCodexOutput(raw)).toBe(expected);
  });
  it.each([undefined, "chosen-model"])("persists the detected model while keeping the model choice %s", async (model) => {
    addProject(makeRepo("alpha"));
    addTeam({ name: "team", projects: ["alpha"] });
    addMember("team", { name: "helper", tool: "codex", model });
    process.env.CODEC_AGENT_COMMAND = "printf 'OpenAI Codex v0.162.1\\nmodel: gpt-6.1-sol\\nuser\\nCheck\\n'";
    const run = await waitFor(startRun({ project: "alpha", member: "team/helper", task: "Check" }).runId);
    expect(run.model).toBe(model);
    expect(run.actualModel).toBe("gpt-6.1-sol");
    const dir = join(home, "runs", run.runId);
    expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf-8")).actualModel).toBe("gpt-6.1-sol");
    writeFileSync(join(dir, "output.log"), "");
    expect(getRunStatus(run.runId)?.actualModel).toBe("gpt-6.1-sol");
  });
});
