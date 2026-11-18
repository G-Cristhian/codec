import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addProject } from "../src/registry.js";
import { MAX_FILE_DIFF_LINES, MAX_TOTAL_DIFF_LINES, applyChanges, discardChanges, runChanges } from "../src/review.js";
import { cleanRun, readRunStatus, listRuns, startRun, stopRun } from "../src/runs.js";
import { laneOf } from "../src/dashboard.js";
import { readEvents } from "../src/events.js";
import { saveIdentity } from "../src/settings.js";
import { S } from "../src/strings.js";
import { cleanupTemps, makeRepo, tempDir, useIsolatedHome, waitFor } from "./helpers.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
const unavailable = { code: "changes_unavailable", status: 409, message: S.errors.changes_unavailable };

async function finish(repo: string, command = "true", task = "Make fixture changes") {
  addProject(repo);
  process.env.CODEC_AGENT_COMMAND = command;
  return waitFor(startRun({ project: "site", agent: "claude", task }).runId);
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
    expect(await runChanges(run.runId)).toEqual({ status: "no_changes", head: git(run.worktree, "rev-parse", "HEAD").trim(), files: [] });
  });

  it("lists deleted empty files even without any hunks", async () => {
    const repo = makeRepo("site");
    writeFileSync(join(repo, "empty.txt"), "");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "Empty fixture");
    const run = await finish(repo, "rm empty.txt; git add -A; git commit -qm 'Delete empty fixture'");
    expect((await runChanges(run.runId)).files).toEqual([
      { path: "empty.txt", change: "deleted", additions: 0, deletions: 0, binary: false, truncated: false, lines: [], wholeFile: true, hunks: [{ id: "0:0", header: S.diffViewer.wholeFile, firstLine: 0 }] },
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

const allIds = (changes: Awaited<ReturnType<typeof runChanges>>) => changes.files.flatMap((file) => file.hunks.map((hunk) => hunk.id));
function projectSnapshot(repo: string) {
  const files: Record<string, Buffer> = {};
  function visit(dir: string) {
    for (const entry of readdirSync(join(repo, dir), { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else files[path] = readFileSync(join(repo, path));
    }
  }
  visit("");
  return { files, head: git(repo, "rev-parse", "HEAD"), index: readFileSync(join(repo, ".git", "index")) };
}

describe("review decisions", () => {
  beforeEach(() => useIsolatedHome("true"));
  afterEach(() => {
    for (const run of listRuns({ state: "running" })) stopRun(run.runId);
    cleanupTemps();
  });

  it("all selected copies the full tree in one owner commit and leaves the helper untouched", async () => {
    const repo = makeRepo("site");
    for (const [path, text] of Object.entries({ "deleted.txt": "delete me\n", "old.txt": "rename me\n", "mode.txt": "mode\n", "empty-delete": "" })) {
      writeFileSync(join(repo, path), text);
    }
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "Fixture base");
    const task = "A".repeat(120) + "\nThis line must not enter the message";
    const run = await finish(repo, `printf 'changed\n' > README.md
printf 'new\n' > added.txt
rm deleted.txt empty-delete
touch empty-add
git mv old.txt renamed.txt
chmod +x mode.txt
printf '\\000\\001\\377' > binary.dat`, task);
    const changes = await runChanges(run.runId);
    const head = git(run.worktree, "rev-parse", "HEAD");
    const tree = git(run.worktree, "rev-parse", "HEAD^{tree}");
    const branch = git(repo, "rev-parse", run.branch);
    const worktreeStatus = git(run.worktree, "status", "--porcelain");
    // Applying must use the current checkpoint identity and must not run attribution hooks.
    saveIdentity({ name: "Fixture Owner", email: "owner@example.invalid" });
    git(repo, "config", "commit.gpgSign", "true");
    const hooks = tempDir();
    writeFileSync(join(hooks, "commit-msg"), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    git(repo, "config", "core.hooksPath", hooks);
    const updated = applyChanges(run.runId, { head: changes.head, hunks: allIds(changes) });
    expect(git(repo, "rev-parse", "HEAD^{tree}")).toBe(tree);
    expect(git(repo, "rev-list", "--count", `${run.baseSha}..HEAD`).trim()).toBe("1");
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "log", "-1", "--format=%an <%ae>%n%cn <%ce>").trim()).toBe("Fixture Owner <owner@example.invalid>\nFixture Owner <owner@example.invalid>");
    expect(git(repo, "log", "-1", "--format=%B").trim()).toBe("Keep helper changes: " + "A".repeat(100));
    expect(git(run.worktree, "rev-parse", "HEAD")).toBe(head);
    expect(git(repo, "rev-parse", run.branch)).toBe(branch);
    expect(git(run.worktree, "status", "--porcelain")).toBe(worktreeStatus);
    expect(updated.reviewed).toEqual({ action: "applied", at: expect.any(String), commit: git(repo, "rev-parse", "HEAD").trim(), hunks: 7, total: 7 });
    expect(laneOf(updated)).toBe("done");
    expect(readRunStatus(run.runId)?.reviewed).toEqual(updated.reviewed);
    expect(readEvents().filter((event) => event.kind === "run.apply")).toMatchObject([{ runId: run.runId, hunks: 7, total: 7 }]);
    expect(() => applyChanges(run.runId, { head: changes.head, hunks: allIds(changes) })).toThrowError(expect.objectContaining(unavailable));
    expect(() => discardChanges(run.runId)).toThrowError(expect.objectContaining(unavailable));
    expect(await runChanges(run.runId)).toEqual(changes);
  });

  it.each([{ selected: [1] }, { selected: [0, 2] }, { selected: [1, 2] }])("rewrites offsets for selected hunks $selected and leaves all unselected work in place", async ({ selected }) => {
    const repo = makeRepo("site");
    const base = Array.from({ length: 70 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(repo, "hunks.txt"), base.join("\n"));
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "Fixture base");
    const change = (indices: number[]) => base.flatMap((line, i) =>
      i === 2 && indices.includes(0) ? [line, "first addition", "second addition"] :
      i === 30 && indices.includes(1) ? ["replacement", "another addition"] :
      i === 65 && indices.includes(2) ? [] : [line]).join("\n");
    const run = await finish(repo, editFiles({ "hunks.txt": change([0, 1, 2]) }));
    const changes = await runChanges(run.runId);
    expect(changes.files[0].hunks).toHaveLength(3);
    const helperHead = git(run.worktree, "rev-parse", "HEAD");
    applyChanges(run.runId, { head: changes.head, hunks: selected.map((i) => `0:${i}`) });
    expect(readFileSync(join(repo, "hunks.txt"), "utf8")).toBe(change(selected));
    expect(readFileSync(join(run.worktree, "hunks.txt"), "utf8")).toBe(change([0, 1, 2]));
    expect(git(run.worktree, "rev-parse", "HEAD")).toBe(helperHead);
    expect(git(repo, "rev-parse", run.branch)).toBe(helperHead);
  });

  it.each(["empty-add", "empty-delete", "renamed.txt", "mode.txt", "binary.dat"])("selects %s as a whole-file unit", async (path) => {
    const repo = makeRepo("site");
    writeFileSync(join(repo, "old.txt"), "rename\n");
    writeFileSync(join(repo, "empty-delete"), "");
    writeFileSync(join(repo, "mode.txt"), "mode\n");
    writeFileSync(join(repo, "binary.dat"), Buffer.from([0, 1, 2]));
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "Fixture base");
    const run = await finish(repo, `${path === "empty-delete" ? "" : "touch empty-add"}
${path === "empty-add" ? "" : "rm empty-delete"}
git mv old.txt renamed.txt
chmod +x mode.txt
printf '\\000\\002\\377' > binary.dat`);
    const changes = await runChanges(run.runId);
    const file = changes.files.find((file) => file.path === path)!;
    expect(file).toMatchObject({ wholeFile: true, hunks: [{ id: `${changes.files.indexOf(file)}:0`, header: S.diffViewer.wholeFile }] });
    applyChanges(run.runId, { head: changes.head, hunks: [file.hunks[0].id] });
    expect(git(repo, "diff", "--name-only", "-M", run.baseSha, "HEAD").trim()).toBe(path);
    expect(git(repo, "diff", "HEAD", changes.head, "--", path)).toBe("");
    expect(existsSync(run.worktree)).toBe(true);
  });

  it("applies only the second of two hunks in an edited rename using API file order", async () => {
    const repo = makeRepo("site");
    const base = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") + "\n";
    writeFileSync(join(repo, "z old.txt"), base);
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "Fixture base");
    const run = await finish(repo, `git mv 'z old.txt' 'a new.txt'\nprintf 'added\n' > 'middle.txt'`);
    writeFileSync(join(run.worktree, "a new.txt"), "inserted\n" + base.replace("line 35", "kept"));
    git(run.worktree, "add", ".");
    git(run.worktree, "commit", "-qm", "Two hunks");
    const changes = await runChanges(run.runId);
    expect(changes.files.map((file) => file.path)).toEqual(["a new.txt", "middle.txt"]);
    expect(changes.files[0].hunks).toHaveLength(2);
    applyChanges(run.runId, { head: changes.head, hunks: ["0:1"] });
    expect(readFileSync(join(repo, "a new.txt"), "utf8")).toBe(base.replace("line 35", "kept"));
    expect(existsSync(join(repo, "z old.txt"))).toBe(false);
    expect(existsSync(join(repo, "middle.txt"))).toBe(false);
  });

  it("includes hidden hunks past both caps and applies the full multi-megabyte patch", async () => {
    const repo = makeRepo("site");
    const base = Array.from({ length: 2200 }, (_, i) => `line ${i}`).join("\n") + "\n";
    writeFileSync(join(repo, "0.txt"), base);
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "Fixture base");
    const files = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`${i + 1}.txt`, ("x".repeat(600) + "\n").repeat(2100)]));
    files["0.txt"] = base.replace("line 0\n", "added\n".repeat(2100)).replace("line 2190\n", "last changed\n");
    const run = await finish(repo, editFiles(files));
    const changes = await runChanges(run.runId);
    expect(changes.files[0].hunks).toHaveLength(2);
    expect(changes.files[0].hunks[1].firstLine).toBeGreaterThan(MAX_FILE_DIFF_LINES);
    expect(changes.files.at(-1)).toMatchObject({ truncated: true, lines: [], hunks: [{ id: "7:0" }] });
    applyChanges(run.runId, { head: changes.head, hunks: allIds(changes) });
    expect(git(repo, "rev-parse", "HEAD^{tree}")).toBe(git(run.worktree, "rev-parse", "HEAD^{tree}"));
  });

  it("preserves non-UTF-8 bytes, CRLF, whitespace and missing final newlines", async () => {
    const repo = makeRepo("site");
    const run = await finish(repo);
    const bytes = Buffer.from([0x61, 0xff, 0x20, 0x20, 0x0d, 0x0a, 0x62]);
    writeFileSync(join(run.worktree, "bytes.txt"), bytes);
    git(run.worktree, "add", ".");
    git(run.worktree, "commit", "-qm", "Byte fixture");
    git(repo, "config", "apply.whitespace", "fix");
    const changes = await runChanges(run.runId);
    applyChanges(run.runId, { head: changes.head, hunks: allIds(changes) });
    expect(readFileSync(join(repo, "bytes.txt"))).toEqual(bytes);
    expect(git(repo, "rev-parse", "HEAD^{tree}")).toBe(git(run.worktree, "rev-parse", "HEAD^{tree}"));
  });

  it("rejects empty, duplicate and unknown unit ids without changing the project", async () => {
    const repo = makeRepo("site");
    const run = await finish(repo, editFiles({ "new.txt": "new\n" }));
    const changes = await runChanges(run.runId);
    const before = projectSnapshot(repo);
    for (const hunks of [[], ["0:0", "0:0"], ["99:0"], ["../../README.md"], [4], null]) {
      expect(() => applyChanges(run.runId, { head: changes.head, hunks })).toThrowError(expect.objectContaining({ code: "invalid_selection", status: 400 }));
      expect(projectSnapshot(repo)).toEqual(before);
    }
  });

  it("rejects a stale head and leaves the decision unset", async () => {
    const repo = makeRepo("site");
    const run = await finish(repo, editFiles({ "new.txt": "new\n" }));
    const changes = await runChanges(run.runId);
    git(run.worktree, "commit", "--allow-empty", "-qm", "New helper checkpoint");
    const before = projectSnapshot(repo);
    expect(() => applyChanges(run.runId, { head: changes.head, hunks: allIds(changes) })).toThrowError(expect.objectContaining({ code: "changes_stale", status: 409 }));
    expect(projectSnapshot(repo)).toEqual(before);
    expect(readRunStatus(run.runId)?.reviewed).toBeUndefined();
  });

  it.each(["unstaged", "staged", "untracked"])("refuses a %s project without changing any bytes or HEAD", async (kind) => {
    const repo = makeRepo("site");
    const run = await finish(repo, editFiles({ "new.txt": "new\n" }));
    const changes = await runChanges(run.runId);
    writeFileSync(join(repo, kind === "untracked" ? "mine.txt" : "README.md"), "owner edits\n");
    if (kind === "staged") git(repo, "add", ".");
    const before = projectSnapshot(repo);
    expect(() => applyChanges(run.runId, { head: changes.head, hunks: allIds(changes) })).toThrowError(expect.objectContaining({ code: "project_not_clean", status: 409 }));
    expect(projectSnapshot(repo)).toEqual(before);
  });

  it("refuses a detached project", async () => {
    const repo = makeRepo("site");
    const run = await finish(repo, editFiles({ "new.txt": "new\n" }));
    const changes = await runChanges(run.runId);
    git(repo, "checkout", "--detach", "-q");
    const before = projectSnapshot(repo);
    expect(() => applyChanges(run.runId, { head: changes.head, hunks: allIds(changes) })).toThrowError(expect.objectContaining({ code: "project_detached", status: 409 }));
    expect(projectSnapshot(repo)).toEqual(before);
  });

  it("refuses conflicting changes atomically even when another selected file would apply", async () => {
    const repo = makeRepo("site");
    const run = await finish(repo, editFiles({ "README.md": "helper edits\n", "a-new.txt": "would apply\n" }));
    const changes = await runChanges(run.runId);
    writeFileSync(join(repo, "README.md"), "owner committed edits\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "Project moved on");
    const before = projectSnapshot(repo);
    expect(() => applyChanges(run.runId, { head: changes.head, hunks: allIds(changes) })).toThrowError(expect.objectContaining({ code: "changes_conflict", status: 409 }));
    expect(projectSnapshot(repo)).toEqual(before);
    expect(readRunStatus(run.runId)?.reviewed).toBeUndefined();
  });

  it("commits on the current project branch after unrelated work", async () => {
    const repo = makeRepo("site");
    const run = await finish(repo, editFiles({ "helper.txt": "helper\n" }));
    const changes = await runChanges(run.runId);
    git(repo, "checkout", "-qb", "owner-branch");
    writeFileSync(join(repo, "owner.txt"), "owner\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "Owner work");
    const parent = git(repo, "rev-parse", "HEAD");
    applyChanges(run.runId, { head: changes.head, hunks: allIds(changes) });
    expect(git(repo, "branch", "--show-current").trim()).toBe("owner-branch");
    expect(git(repo, "rev-parse", "HEAD^")).toBe(parent);
    expect(readFileSync(join(repo, "owner.txt"), "utf8")).toBe("owner\n");
  });

  it.each([true, false])("discard removes the worktree but keeps recoverable commits (changes: %s)", async (changed) => {
    const repo = makeRepo("site");
    const run = await finish(repo, changed ? editFiles({ "helper.txt": "helper\n" }) : "true");
    const helperHead = git(run.worktree, "rev-parse", "HEAD");
    const before = projectSnapshot(repo);
    const updated = discardChanges(run.runId);
    expect(existsSync(run.worktree)).toBe(false);
    expect(git(repo, "rev-parse", run.branch)).toBe(helperHead);
    expect(projectSnapshot(repo)).toEqual(before);
    expect(updated.reviewed).toEqual({ action: "discarded", at: expect.any(String) });
    expect(laneOf(updated)).toBe("done");
    expect(readEvents().filter((event) => event.kind === "run.discard")).toMatchObject([{ runId: run.runId }]);
    expect(() => discardChanges(run.runId)).toThrowError(expect.objectContaining(unavailable));
  });

  it("refuses unsaved helper work for either decision", async () => {
    const run = await finish(makeRepo("site"), editFiles({ "new.txt": "new\n" }));
    const changes = await runChanges(run.runId);
    writeFileSync(join(run.worktree, "unsaved.txt"), "still editing\n");
    expect(() => discardChanges(run.runId)).toThrowError(expect.objectContaining(unavailable));
    expect(() => applyChanges(run.runId, { head: changes.head, hunks: allIds(changes) })).toThrowError(expect.objectContaining(unavailable));
    expect(existsSync(run.worktree)).toBe(true);
  });
});
