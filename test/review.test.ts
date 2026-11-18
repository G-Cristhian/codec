import { execFileSync } from "child_process";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addProject } from "../src/registry.js";
import { MAX_FILE_DIFF_LINES, MAX_TOTAL_DIFF_LINES, runChanges } from "../src/review.js";
import { cleanRun, listRuns, startRun, stopRun } from "../src/runs.js";
import { S } from "../src/strings.js";
import { cleanupTemps, makeRepo, tempDir, useIsolatedHome, waitFor } from "./helpers.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
const unavailable = { code: "changes_unavailable", status: 409, message: S.errors.changes_unavailable };

async function finish(repo: string, command = "true") {
  addProject(repo);
  process.env.CODEC_AGENT_COMMAND = command;
  return waitFor(startRun({ project: "site", agent: "claude", task: "Make fixture changes" }).runId);
}

// A fake helper script can write awkward filenames without shell interpolation.
function editFiles(files: Record<string, string>): string {
  const script = join(tempDir(), "edit.cjs");
  writeFileSync(script, `const fs = require("fs");
for (const [path, text] of Object.entries(${JSON.stringify(files)})) fs.writeFileSync(path, text);
require("child_process").execFileSync("git", ["add", "-A"]);
require("child_process").execFileSync("git", ["commit", "-qm", "Fixture changes"]);
`);
  return `node '${script}'`;
}

describe("review changes", () => {
  beforeEach(() => useIsolatedHome("true"));
  afterEach(() => {
    for (const run of listRuns({ state: "running" })) stopRun(run.runId);
    cleanupTemps();
  });

  it("reads added, modified, deleted, renamed and binary files with counts and line numbers", async () => {
    const repo = makeRepo("site");
    writeFileSync(join(repo, "modified.txt"), "same\nbefore\nlast\n");
    writeFileSync(join(repo, "deleted.txt"), "remove me\n");
    writeFileSync(join(repo, "old.txt"), "rename this exact content\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "Fixture base");
    const run = await finish(repo, `printf 'new line\n' > added.txt
printf 'same\nafter\nlast\n' > modified.txt
rm deleted.txt
git mv old.txt renamed.txt
printf '\\000\\001\\002' > image.bin
touch empty-added.txt
git add -A
git commit -qm 'Fixture changes'`);
    const before = { status: git(run.worktree, "status", "--porcelain"), head: git(run.worktree, "rev-parse", "HEAD") };
    const record = join(process.env.CODEC_HOME!, "runs", run.runId, "run.json");
    // A normal status read would merge this marker into run.json; review must not.
    writeFileSync(join(process.env.CODEC_HOME!, "runs", run.runId, "limit_hit"), "yes");
    const recordBefore = readFileSync(record, "utf-8");
    const result = await runChanges(run.runId);
    expect(result.status).toBe("ready");
    expect(result.files.map((f) => f.path)).toEqual([
      "added.txt", "deleted.txt", "empty-added.txt", "image.bin", "modified.txt", "renamed.txt",
    ]);
    const file = (path: string) => result.files.find((f) => f.path === path)!;
    expect(file("added.txt")).toMatchObject({ change: "added", additions: 1, deletions: 0, binary: false, truncated: false,
      lines: [{ kind: "hunk", text: "@@ -0,0 +1 @@" }, { kind: "add", text: "+new line", newNo: 1 }] });
    expect(file("deleted.txt")).toMatchObject({ change: "deleted", additions: 0, deletions: 1,
      lines: [{ kind: "hunk", text: "@@ -1 +0,0 @@" }, { kind: "remove", text: "-remove me", oldNo: 1 }] });
    expect(file("modified.txt")).toMatchObject({ change: "modified", additions: 1, deletions: 1, lines: [
      { kind: "hunk", text: "@@ -1,3 +1,3 @@" },
      { kind: "context", text: " same", oldNo: 1, newNo: 1 },
      { kind: "remove", text: "-before", oldNo: 2 },
      { kind: "add", text: "+after", newNo: 2 },
      { kind: "context", text: " last", oldNo: 3, newNo: 3 },
    ] });
    expect(file("renamed.txt")).toMatchObject({ change: "renamed", oldPath: "old.txt", additions: 0, deletions: 0, lines: [] });
    expect(file("image.bin")).toMatchObject({ change: "added", additions: 0, deletions: 0, binary: true, lines: [] });
    expect(file("empty-added.txt")).toMatchObject({ change: "added", lines: [] });
    expect({ status: git(run.worktree, "status", "--porcelain"), head: git(run.worktree, "rev-parse", "HEAD") }).toEqual(before);
    expect(readFileSync(record, "utf-8")).toBe(recordBefore);
  });

  it("returns no files for a finished run with no changes", async () => {
    const run = await finish(makeRepo("site"));
    expect(await runChanges(run.runId)).toEqual({ status: "no_changes", files: [] });
  });

  it("lists deleted empty files even without any hunks", async () => {
    const repo = makeRepo("site");
    writeFileSync(join(repo, "empty.txt"), "");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "Empty fixture");
    const run = await finish(repo, "rm empty.txt; git add -A; git commit -qm 'Delete empty fixture'");
    expect((await runChanges(run.runId)).files).toEqual([
      { path: "empty.txt", change: "deleted", additions: 0, deletions: 0, binary: false, truncated: false, lines: [] },
    ]);
  });

  it("rejects running, unsaved, failed and cleaned runs with a friendly conflict", async () => {
    addProject(makeRepo("site"));
    process.env.CODEC_AGENT_COMMAND = "sleep 30";
    const running = startRun({ project: "site", agent: "claude", task: "Wait" });
    await expect(runChanges(running.runId)).rejects.toMatchObject(unavailable);
    stopRun(running.runId);
    await expect(runChanges(running.runId)).rejects.toMatchObject(unavailable);
    process.env.CODEC_AGENT_COMMAND = "true";
    const run = await waitFor(startRun({ project: "site", agent: "claude", task: "Finish" }).runId);
    writeFileSync(join(run.worktree, "unsaved.txt"), "Unsaved\n");
    await expect(runChanges(run.runId)).rejects.toMatchObject(unavailable);
    cleanRun(run.runId, { force: true });
    await expect(runChanges(run.runId)).rejects.toMatchObject(unavailable);
    process.env.CODEC_AGENT_COMMAND = "exit 1";
    const failed = await waitFor(startRun({ project: "site", agent: "claude", task: "Fail" }).runId);
    await expect(runChanges(failed.runId)).rejects.toMatchObject(unavailable);
  });

  it("rejects unknown IDs and path traversal as missing runs", async () => {
    await expect(runChanges("run-ffffffff")).rejects.toMatchObject({ code: "run_not_found", status: 404 });
    await expect(runChanges("../run-ffffffff")).rejects.toMatchObject({ code: "run_not_found", status: 404 });
  });

  it("handles tabs, newlines, Unicode, spaces and pathspec-like filenames literally", async () => {
    const paths = [" spaced file ", "tab\tfile", "line\nbreak", "résumé.txt", ":(glob)*.txt", "quote\"file"];
    const run = await finish(makeRepo("site"), editFiles(Object.fromEntries(paths.map((path, i) => [path, `file ${i}  \n`]))));
    const result = await runChanges(run.runId);
    expect(result.files.map((f) => f.path)).toEqual([...paths].sort());
    for (const [i, path] of paths.entries()) {
      expect(result.files.find((f) => f.path === path)).toMatchObject({ change: "added", additions: 1,
        lines: [{ kind: "hunk" }, { kind: "add", text: `+file ${i}  `, newNo: 1 }] });
    }
  });

  it("keeps rename paths and edited hunks even when directory names contain spaces", async () => {
    const repo = makeRepo("site");
    mkdirSync(join(repo, "old dir"));
    writeFileSync(join(repo, "old dir", "old.txt"), "one\ntwo\nthree\nfour\nfive\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "Fixture base");
    const run = await finish(repo, `mkdir 'new dir'
git mv 'old dir/old.txt' 'new dir/new.txt'
printf 'one\ntwo\nthree\nfour\nsix\n' > 'new dir/new.txt'
git add -A
git commit -qm 'Fixture rename'`);
    const { files } = await runChanges(run.runId);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: "new dir/new.txt", oldPath: "old dir/old.txt", change: "renamed", additions: 1, deletions: 1 });
    expect(files[0].lines).toContainEqual({ kind: "add", text: "+six", newNo: 5 });
  });

  it("resets line numbers at each hunk and preserves missing-newline markers", async () => {
    const repo = makeRepo("site");
    const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(repo, "hunks.txt"), lines.join("\n"));
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "Fixture base");
    lines[0] = "first";
    lines[24] = "last";
    const run = await finish(repo, editFiles({ "hunks.txt": lines.join("\n") }));
    const { files: [file] } = await runChanges(run.runId);
    expect(file.lines.filter((line) => line.kind === "hunk")).toHaveLength(2);
    expect(file.lines).toContainEqual({ kind: "add", text: "+last", newNo: 25 });
    expect(file.lines).toContainEqual({ kind: "remove", text: "-line 25", oldNo: 25 });
    expect(file.lines).toContainEqual({ kind: "context", text: "\\ No newline at end of file" });
  });

  it("caps each file at 2,000 lines while streaming patches larger than a megabyte", async () => {
    const text = ("x".repeat(600) + "\n").repeat(MAX_FILE_DIFF_LINES + 10);
    const run = await finish(makeRepo("site"), editFiles({ "long.txt": text, "small.txt": "kept\n" }));
    const { files } = await runChanges(run.runId);
    expect(files[0]).toMatchObject({ path: "long.txt", truncated: true, additions: MAX_FILE_DIFF_LINES + 10 });
    expect(files[0].lines).toHaveLength(MAX_FILE_DIFF_LINES);
    expect(files[1]).toMatchObject({ path: "small.txt", truncated: false });
    expect(files[1].lines).toHaveLength(2);
  });

  it("caps the response at 10,000 lines and lists later files with empty truncated diffs", async () => {
    const files = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`${i}.txt`, "line\n".repeat(MAX_FILE_DIFF_LINES - 1)]));
    const run = await finish(makeRepo("site"), editFiles(files));
    const result = await runChanges(run.runId);
    expect(result.files).toHaveLength(7);
    expect(result.files.reduce((sum, file) => sum + file.lines.length, 0)).toBe(MAX_TOTAL_DIFF_LINES);
    for (const file of result.files.slice(0, 5)) {
      expect(file.truncated).toBe(false);
      expect(file.lines).toHaveLength(MAX_FILE_DIFF_LINES);
    }
    for (const file of result.files.slice(5)) expect(file).toMatchObject({ truncated: true, lines: [] });
  });

  it("disables external diff and text conversion programs", async () => {
    const repo = makeRepo("site");
    writeFileSync(join(repo, ".gitattributes"), "*.txt diff=fixture\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "Fixture attributes");
    const run = await finish(repo, editFiles({ "safe.txt": "safe\n" }));
    git(repo, "config", "diff.external", "false");
    git(repo, "config", "diff.fixture.textconv", "false");
    expect((await runChanges(run.runId)).files[0]).toMatchObject({ path: "safe.txt", additions: 1 });
  });

  it("omits the whole next file when it would cross the total limit, and keeps later files listed", async () => {
    const sizes = [1999, 1999, 1999, 1999, 1499, 999, 1];
    const run = await finish(makeRepo("site"), editFiles(Object.fromEntries(sizes.map((size, i) => [`${i}.txt`, "line\n".repeat(size)]))));
    const { files } = await runChanges(run.runId);
    expect(files.reduce((sum, file) => sum + file.lines.length, 0)).toBe(9500);
    expect(files.slice(5)).toMatchObject([{ truncated: true, lines: [] }, { truncated: true, lines: [] }]);
  });
});
