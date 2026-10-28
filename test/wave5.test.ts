import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { addProject, git } from "../src/registry.js";
import { getRunStatus, listRuns, startRun, stopRun } from "../src/runs.js";
import { saveIdentity } from "../src/settings.js";
import { setUpTracking } from "../src/folders.js";
import { instructionsText } from "../src/inject.js";
import { COMMIT_ATTRIBUTION_SCRIPT } from "../src/commit-attribution.js";
import { cleanupTemps, makeRepo, tempDir, useIsolatedHome, waitFor } from "./helpers.js";

let home: string;
const owner = { name: "Project Owner", email: "owner@example.invalid" };
beforeEach(() => { home = useIsolatedHome("true"); saveIdentity(owner); });
afterEach(() => {
  for (const run of listRuns({ state: "running" })) stopRun(run.runId);
  vi.unstubAllEnvs();
  cleanupTemps();
});

describe("helper commit attribution", () => {
  it.each(["claude", "codex"] as const)("%s: passes no-attribution instructions, keeps injected settings out of commits, and saves without attribution", async agent => {
    addProject(makeRepo("alpha"));
    process.env.CODEC_AGENT_COMMAND = "echo saved > notes.txt";
    const run = await waitFor(startRun({ project: "alpha", agent, task: "Write notes" }).runId);
    const dir = join(home, "runs", run.runId);
    const instructions = readFileSync(join(dir, "instructions.md"), "utf8");
    expect(instructions).toBe(instructionsText(undefined, agent, []));
    expect(instructions).toContain("configured name and email only");
    expect(instructions).toContain("do not add any Co-Authored-By or AI attribution lines");
    if (agent === "claude") {
      expect(JSON.parse(readFileSync(join(dir, "claude-settings.json"), "utf8"))).toEqual({
        includeCoAuthoredBy: false, attribution: { commit: "", pr: "" },
      });
    }
    expect(git(run.worktree, ["ls-tree", "-r", "--name-only", "HEAD"]).out.split("\n")).toEqual(["README.md", "notes.txt"]);
    expect(git(run.worktree, ["log", "-1", "--format=%B"]).out).not.toMatch(/co-authored-by/i);
    expect(run).toMatchObject({ autoSaved: true, reviewStatus: "ready" });
  });

  it.each(["claude", "codex"] as const)("%s: strips only AI trailers throughout task history, preserving trees, owner, dates, human trailers, and base", async agent => {
    const repo = makeRepo("alpha");
    git(repo, ["commit", "--allow-empty", "-qm", "Existing history\n\nCo-Authored-By: Claude <noreply@anthropic.com>"]);
    const base = git(repo, ["rev-parse", "HEAD"]).out;
    const baseRaw = git(repo, ["cat-file", "commit", base]).out;
    addProject(repo);
    process.env.CODEC_AGENT_COMMAND = String.raw`
      echo first > notes.txt
      git add -A
      git commit -qm "First change

Mention Co-Authored-By: Claude in prose stays.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Co-Authored-By: Jane Developer <jane@example.com>
Co-authored-by: Codex <codex@openai.com>
Signed-off-by: Project Owner <owner@example.invalid>"
      git rev-parse HEAD > "$CODEC_RUN_DIR/first"
      echo second >> notes.txt
      git add -A
      git commit -qm "Second change

Co-Authored-By: Automation <no-reply@example.com>"
      git rev-parse HEAD > "$CODEC_RUN_DIR/second"
      git commit --allow-empty -qm "Clean descendant

Co-Authored-By: Jane Developer <jane@example.com>"
      git rev-parse HEAD > "$CODEC_RUN_DIR/third"
    `;
    const initial = startRun({ project: "alpha", agent, task: "Write notes" });
    const dir = join(home, "runs", initial.runId);
    // The detached wrapper must do the cleanup without status polling.
    await vi.waitFor(() => expect(existsSync(join(dir, "exit_code"))).toBe(true));
    const done = getRunStatus(initial.runId)!;
    expect(done).toMatchObject({ state: "done", coAuthorStripped: 3, reviewStatus: "ready" });
    expect(done.autoSaved).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).coAuthorStripped).toBe(3);
    const rewritten = git(done.worktree, ["rev-list", "--reverse", `${base}..HEAD`]).out.split("\n");
    for (const [index, name] of ["first", "second", "third"].entries()) {
      const old = readFileSync(join(dir, name), "utf8").trim();
      expect(rewritten[index]).not.toBe(old);
      const format = "--format=%T|%an <%ae>|%cn <%ce>|%aI|%cI";
      expect(git(done.worktree, ["show", "-s", format, rewritten[index]]).out)
        .toBe(git(done.worktree, ["show", "-s", format, old]).out);
    }
    const firstMessage = git(done.worktree, ["show", "-s", "--format=%B", rewritten[0]]).out;
    expect(firstMessage).toBe("First change\n\nMention Co-Authored-By: Claude in prose stays.\n\nCo-Authored-By: Jane Developer <jane@example.com>\nSigned-off-by: Project Owner <owner@example.invalid>");
    expect(git(done.worktree, ["log", "--format=%B", `${base}..HEAD`]).out).not.toMatch(/^(?:Co-Authored-By: Claude|Co-authored-by: Codex|Co-Authored-By: Automation)/m);
    expect(git(repo, ["rev-parse", "HEAD"]).out).toBe(base);
    expect(git(done.worktree, ["rev-parse", "HEAD~3"]).out).toBe(base);
    expect(git(repo, ["cat-file", "commit", base]).out).toBe(baseRaw);
    expect(git(done.worktree, ["status", "--porcelain"]).out).toBe("");
    const head = git(done.worktree, ["rev-parse", "HEAD"]).out;
    execFileSync(process.execPath, [join(dir, "strip-attribution.cjs")], { env: { ...process.env, CODEC_RUN_DIR: dir } });
    expect(git(done.worktree, ["rev-parse", "HEAD"]).out).toBe(head);
  });

  it("keeps clean human co-author commits unchanged", async () => {
    addProject(makeRepo("alpha"));
    process.env.CODEC_AGENT_COMMAND = 'git commit --allow-empty -qm "Human work\n\nCo-Authored-By: Jane Developer <jane@example.com>\nCo-Authored-By: Claude Shannon <claude@example.com>"; git rev-parse HEAD > "$CODEC_RUN_DIR/original"';
    const run = await waitFor(startRun({ project: "alpha", agent: "codex", task: "Check" }).runId);
    expect(git(run.worktree, ["rev-parse", "HEAD"]).out).toBe(readFileSync(join(home, "runs", run.runId, "original"), "utf8").trim());
    expect(run.coAuthorStripped).toBeUndefined();
  });

  it("removes hook-added attribution from an automatic save", async () => {
    const repo = makeRepo("alpha");
    const hooks = join(tempDir(), "hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "commit-msg"), '#!/bin/sh\nprintf "\\nCo-Authored-By: Claude <noreply@anthropic.com>\\n" >> "$1"\n', { mode: 0o755 });
    git(repo, ["config", "core.hooksPath", hooks]);
    addProject(repo);
    process.env.CODEC_AGENT_COMMAND = "echo leftover > notes.txt";
    const run = await waitFor(startRun({ project: "alpha", agent: "claude", task: "Write" }).runId);
    expect(run).toMatchObject({ state: "done", autoSaved: true, coAuthorStripped: 1 });
    expect(git(run.worktree, ["log", "-1", "--format=%B"]).out).not.toMatch(/co-authored-by/i);
    expect(git(run.worktree, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"]).out)
      .toBe(`${owner.name} <${owner.email}>|${owner.name} <${owner.email}>`);
  });

  it("retains merge parents and restores owner identity on rewritten commits", async () => {
    addProject(makeRepo("alpha"));
    process.env.CODEC_AGENT_COMMAND = String.raw`
      task_branch=$(git symbolic-ref --short HEAD)
      base=$(git rev-parse HEAD)
      git commit --allow-empty -qm "Side work

Co-Authored-By: Codex <codex@openai.com>"
      git branch side
      git update-ref "refs/heads/$task_branch" "$base"
      GIT_AUTHOR_NAME="Wrong Author" GIT_AUTHOR_EMAIL=wrong@example.com GIT_COMMITTER_NAME="Wrong Committer" GIT_COMMITTER_EMAIL=wrong@example.com git commit --allow-empty -qm "Task work

Co-Authored-By: Claude <noreply@anthropic.com>"
      git merge --no-ff side -m "Merge side work"
      git rev-parse HEAD > "$CODEC_RUN_DIR/original"
    `;
    const run = await waitFor(startRun({ project: "alpha", agent: "codex", task: "Merge" }).runId);
    expect(run).toMatchObject({ state: "done", coAuthorStripped: 2 });
    const parents = git(run.worktree, ["show", "-s", "--format=%P", "HEAD"]).out.split(" ");
    expect(parents).toHaveLength(2);
    for (const parent of parents) {
      expect(git(run.worktree, ["show", "-s", "--format=%P", parent]).out).toBe(run.baseSha);
    }
    const owners = git(run.worktree, ["log", "--format=%an <%ae>|%cn <%ce>", `${run.baseSha}..HEAD`]).out.split("\n");
    expect(owners).toHaveLength(3);
    expect(new Set(owners)).toEqual(new Set([`${owner.name} <${owner.email}>|${owner.name} <${owner.email}>`]));
    const old = readFileSync(join(home, "runs", run.runId, "original"), "utf8").trim();
    expect(git(run.worktree, ["show", "-s", "--format=%T", "HEAD"]).out).toBe(git(run.worktree, ["show", "-s", "--format=%T", old]).out);
  });

  it("cleans committed work even when the helper fails, leaving dirty work untouched", async () => {
    addProject(makeRepo("alpha"));
    process.env.CODEC_AGENT_COMMAND = 'git commit --allow-empty -qm "Saved\n\nCo-Authored-By: AI <ai@example.com>"; echo dirty > notes.txt; exit 2';
    const run = await waitFor(startRun({ project: "alpha", agent: "codex", task: "Check" }).runId);
    expect(run).toMatchObject({ state: "failed", exitCode: 2, coAuthorStripped: 1, reviewStatus: "unsaved" });
    expect(readFileSync(join(run.worktree, "notes.txt"), "utf8")).toBe("dirty\n");
  });

  it("refuses cleanup when the workspace is on the project's main branch", () => {
    const repo = makeRepo("alpha");
    const base = git(repo, ["rev-parse", "HEAD"]).out;
    const branch = git(repo, ["symbolic-ref", "--short", "HEAD"]).out;
    const dir = tempDir();
    writeFileSync(join(dir, "run.json"), JSON.stringify({ worktree: repo, branch, baseSha: base }));
    writeFileSync(join(dir, "strip-attribution.cjs"), COMMIT_ATTRIBUTION_SCRIPT);
    expect(() => execFileSync(process.execPath, [join(dir, "strip-attribution.cjs")], {
      env: { ...process.env, CODEC_RUN_DIR: dir }, stdio: "pipe",
    })).toThrow();
    expect(git(repo, ["rev-parse", "HEAD"]).out).toBe(base);
  });

  it("the first checkpoint has no attribution even with a commit-msg hook configured", () => {
    const repo = tempDir();
    git(repo, ["init", "-q"]);
    const hooks = join(tempDir(), "hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "commit-msg"), '#!/bin/sh\nprintf "\\nCo-Authored-By: Claude <noreply@anthropic.com>\\n" >> "$1"\n', { mode: 0o755 });
    git(repo, ["config", "core.hooksPath", hooks]);
    setUpTracking(repo);
    expect(git(repo, ["log", "-1", "--format=%B"]).out).not.toMatch(/co-authored-by/i);
  });
});
