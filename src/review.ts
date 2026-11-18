import { queueTests } from "./test-runs.js";
import { spawn, spawnSync } from "child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";
import { CodecError } from "./errors.js";
import { git } from "./registry.js";
import { cleanRun, readRunStatus, recordReview, type RunStatus } from "./runs.js";
import { logEvent } from "./events.js";
import { checkpointIdentity, identityEnvironment } from "./settings.js";
import { redactSecrets } from "./secrets.js";
import { runsDir, withLock } from "./store.js";
import { S, wording } from "./strings.js";
import { helperRef } from "./coordinator.js";
import { postMessage } from "./messages.js";

export const MAX_FILE_DIFF_LINES = 2_000;
export const MAX_TOTAL_DIFF_LINES = 10_000;

export interface DiffLine {
  kind: "add" | "remove" | "context" | "hunk";
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  change: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
  truncated: boolean;
  lines: DiffLine[];
  wholeFile?: true;
  /** Zero-based line offset in the uncapped diff, including hunk headers. */
  hunks: { id: string; header: string; firstLine: number }[];
}

export interface RunChanges {
  status: "ready" | "no_changes";
  head: string;
  files: DiffFile[];
}

export interface FeedbackResult { delivered: boolean; messageId: string }

function feedbackRecipient(runId: string) {
  const run = readRunStatus(runId);
  if (!run) throw new CodecError("run_not_found", S.errors.run_not_found, {}, 404);
  const to = helperRef(run);
  if (run.state !== "done" || run.reviewStatus !== "ready" || run.reviewed || !to) {
    throw new CodecError("feedback_unavailable", S.errors.feedback_unavailable, {}, 409);
  }
  return { run, to };
}

/** Resolve line ids against the pinned diff; never trust client-supplied file details. */
export async function sendFeedback(runId: string, input: { head?: unknown; comments?: unknown }): Promise<FeedbackResult> {
  feedbackRecipient(runId);
  const changes = await runChanges(runId);
  if (changes.head !== input.head) throw new CodecError("changes_stale", S.errors.changes_stale, {}, 409);
  const invalid = () => new CodecError("invalid_feedback", S.errors.invalid_feedback, {}, 400);
  if (!Array.isArray(input.comments) || !input.comments.length || input.comments.length > 100) throw invalid();
  const known = new Map(changes.files.flatMap((file, fileIndex) => file.lines.flatMap((line, lineIndex) =>
    line.kind === "hunk" ? [] : [[`${fileIndex}:${lineIndex}`, { file, line }] as const])));
  const comments = new Map<string, string>();
  for (const comment of input.comments) {
    if (!comment || typeof comment.line !== "string" || !known.has(comment.line) || comments.has(comment.line) ||
        typeof comment.text !== "string" || !comment.text.trim() || comment.text.trim().length > 2_000) throw invalid();
    comments.set(comment.line, comment.text.trim());
  }
  // Loading the diff yields; check eligibility again before delivering anything.
  const { run, to } = feedbackRecipient(runId);
  const task = redactSecrets(run.task.split(/\r?\n/, 1)[0].trim()).slice(0, 100);
  const blocks = [wording(comments.size === 1 ? S.diffViewer.feedbackHeaderOne : S.diffViewer.feedbackHeader, { task, n: comments.size })];
  for (const [id, { file, line }] of known) {
    const text = comments.get(id);
    if (text === undefined) continue;
    const location = wording(line.kind === "remove" ? S.diffViewer.feedbackRemoved :
      line.kind === "add" ? S.diffViewer.feedbackAdded : S.diffViewer.feedbackUnchanged,
    { path: file.path, n: (line.kind === "remove" ? line.oldNo : line.newNo ?? line.oldNo) ?? S.diffViewer.unnumbered });
    blocks.push(wording(S.diffViewer.feedbackComment, {
      location, line: line.text.replace(/^[+\- ]/, "").slice(0, 200), text,
    }));
  }
  const message = postMessage({ from: "owner", to, body: blocks.join("\n\n") });
  return { delivered: !!message.deliveredAt, messageId: message.id };
}

const unavailable = () => new CodecError("changes_unavailable", S.errors.changes_unavailable, {}, 409);

// Pin diff formatting as well as HEAD: local diff preferences must not change unit boundaries.
const diffOptions = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M",
  "--no-relative", "--ignore-submodules=none", "--submodule=short",
  "--src-prefix=a/", "--dst-prefix=b/", "--output-indicator-new=+",
  "--output-indicator-old=-", "--output-indicator-context= "];

function assignUnits(files: DiffFile[]) {
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  files.forEach((file, i) => {
    if (!file.hunks.length) {
      file.wholeFile = true;
      file.hunks.push({ id: "", header: S.diffViewer.wholeFile, firstLine: 0 });
    }
    file.hunks.forEach((hunk, j) => { hunk.id = `${i}:${j}`; });
  });
}

/** -z keeps tabs, newlines, Unicode and rename paths unambiguous. */
function fileStats(output: string): DiffFile[] {
  const entries = output.split("\0");
  const files: DiffFile[] = [];
  for (let i = 0; i < entries.length - 1; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(entries[i]);
    if (!match) throw unavailable();
    let path = match[3];
    let oldPath: string | undefined;
    if (!path) {
      oldPath = entries[++i];
      path = entries[++i];
      if (!oldPath || !path) throw unavailable();
    }
    const binary = match[1] === "-";
    files.push({ path, ...(oldPath ? { oldPath } : {}), change: oldPath ? "renamed" : "modified",
      additions: binary ? 0 : Number(match[1]), deletions: binary ? 0 : Number(match[2]),
      binary, truncated: false, lines: [], hunks: [] });
  }
  return files;
}

/** Only inspect saved work. No client-supplied paths reach git. */
export async function runChanges(runId: string): Promise<RunChanges> {
  const run = readRunStatus(runId);
  if (!run) throw new CodecError("run_not_found", S.errors.run_not_found, {}, 404);
  if (run.reviewStatus !== "ready" && run.reviewStatus !== "no_changes") throw unavailable();
  // Pin HEAD so both reads describe the same checkpoint, even if another process commits.
  const head = git(run.worktree, ["rev-parse", "--verify", "HEAD"]);
  if (!head.ok) throw unavailable();
  if (run.reviewStatus === "no_changes") return { status: "no_changes", head: head.out, files: [] };
  const options = diffOptions;
  const range = [run.baseSha, head.out, "--"];
  const stats = git(run.worktree, [...options, "--numstat", "-z", ...range]);
  if (!stats.ok) throw unavailable();
  const files = fileStats(stats.out);

  // Stream the patch: large diffs must not hit spawnSync's output buffer limit.
  // The two commands use the same ordering; file boundaries never depend on decoding paths.
  const child = spawn("git", ["-C", run.worktree, ...options, "--unified=3", "--inter-hunk-context=0", ...range], { stdio: ["ignore", "pipe", "ignore"] });
  const finished = new Promise<boolean>((resolve) => {
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
  const input = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let index = -1;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  let fileLine = 0;
  let total = 0;
  let totalTruncated = false;
  function finishFile() {
    const file = files[index];
    if (!file) return;
    if (total + file.lines.length > MAX_TOTAL_DIFF_LINES) {
      file.lines = [];
      file.truncated = true;
      totalTruncated = true;
    }
    total += file.lines.length;
  }
  for await (const text of input) {
    if (text.startsWith("diff --git ")) {
      finishFile();
      index++;
      inHunk = false;
      fileLine = 0;
      continue;
    }
    const file = files[index];
    if (!file) continue;
    if (!inHunk) {
      if (text.startsWith("new file mode ")) file.change = "added";
      if (text.startsWith("deleted file mode ")) file.change = "deleted";
    }
    if (file.binary) continue;
    let line: DiffLine;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      file.hunks.push({ id: "", header: text, firstLine: fileLine });
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      line = { kind: "hunk", text };
    } else if (!inHunk) {
      continue;
    } else if (text.startsWith("+")) {
      line = { kind: "add", text, newNo: newNo++ };
    } else if (text.startsWith("-")) {
      line = { kind: "remove", text, oldNo: oldNo++ };
    } else if (text.startsWith(" ")) {
      line = { kind: "context", text, oldNo: oldNo++, newNo: newNo++ };
    } else if (text.startsWith("\\")) {
      // Git's missing-final-newline marker has no line number.
      line = { kind: "context", text };
    } else {
      continue;
    }
    fileLine++;
    if (file.lines.length >= MAX_FILE_DIFF_LINES || totalTruncated || total >= MAX_TOTAL_DIFF_LINES) {
      file.truncated = true;
    } else {
      file.lines.push(line);
    }
  }
  finishFile();
  if (!await finished || index + 1 !== files.length) throw unavailable();
  assignUnits(files);
  return { status: "ready", head: head.out, files };
}

function reviewable(runId: string, discard = false): RunStatus {
  const run = readRunStatus(runId);
  if (!run) throw new CodecError("run_not_found", S.errors.run_not_found, {}, 404);
  if (run.state !== "done" || run.reviewed ||
      (run.reviewStatus !== "ready" && !(discard && run.reviewStatus === "no_changes"))) throw unavailable();
  return run;
}

const conflict = () => new CodecError("changes_conflict", S.errors.changes_conflict, {}, 409);

/** Rebuild selection from trusted git output; patch contents and paths never come from the client. */
function selectedPatch(run: RunStatus, head: string, ids: unknown, patchFile: string) {
  const stats = git(run.worktree, [...diffOptions, "--numstat", "-z", run.baseSha, head, "--"]);
  if (!stats.ok) throw unavailable();
  const files = fileStats(stats.out);
  // Stream directly to disk without a stdout buffer limit. Latin-1 preserves every patch byte,
  // including non-UTF-8 text, CRLF and Git's binary patch payloads, while slicing sections.
  const fd = openSync(patchFile, "w", 0o600);
  try {
    const result = spawnSync("git", ["-C", run.worktree, ...diffOptions, "--binary", "--full-index", "--unified=3", "--inter-hunk-context=0", run.baseSha, head, "--"],
      { stdio: ["ignore", fd, "pipe"] });
    if (result.status !== 0) throw unavailable();
  } finally { closeSync(fd); }
  const patch = readFileSync(patchFile).toString("latin1");
  const sections = patch ? patch.split(/(?=^diff --git )/m) : [];
  if (sections.length !== files.length) throw unavailable();
  const patches = new Map(files.map((file, i) => {
    const section = sections[i];
    const starts = [...section.matchAll(/^@@ .*$/gm)];
    file.hunks = starts.map((match) => ({ id: "", header: match[0], firstLine: 0 }));
    return [file, { section, starts }];
  }));
  assignUnits(files);
  const known = new Set(files.flatMap((file) => file.hunks.map((hunk) => hunk.id)));
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length ||
      ids.some((id) => typeof id !== "string" || !known.has(id))) {
    throw new CodecError("invalid_selection", S.errors.invalid_selection, {}, 400);
  }
  const selected = new Set<string>(ids);
  const kept: string[] = [];
  for (const file of files) {
    const { section, starts } = patches.get(file)!;
    if (file.wholeFile) {
      if (selected.has(file.hunks[0].id)) kept.push(section);
      continue;
    }
    const hunks: string[] = [];
    let offset = 0;
    starts.forEach((start, i) => {
      if (!selected.has(file.hunks[i].id)) return;
      const hunk = section.slice(start.index, starts[i + 1]?.index ?? section.length);
      hunks.push(hunk.replace(/^@@ -(\d+)(,\d+)? \+\d+(,\d+)? @@/, (_, oldStart: string, oldRange: string | undefined, newRange: string | undefined) => {
        const oldCount = oldRange ? Number(oldRange.slice(1)) : 1;
        const newCount = newRange ? Number(newRange.slice(1)) : 1;
        // Empty ranges name the preceding line (new files start at +1, deletions at +0).
        const newStart = Number(oldStart) + offset + (oldCount === 0 ? 1 : 0) - (newCount === 0 ? 1 : 0);
        offset += newCount - oldCount;
        return `@@ -${oldStart}${oldRange ?? ""} +${newStart}${newRange ?? ""} @@`;
      }));
    });
    if (hunks.length) kept.push(section.slice(0, starts[0].index) + hunks.join(""));
  }
  writeFileSync(patchFile, Buffer.from(kept.join(""), "latin1"));
  return { hunks: selected.size, total: known.size };
}

export function applyChanges(runId: string, selection: { head?: unknown; hunks?: unknown }): RunStatus {
  const initial = reviewable(runId);
  // Serialize decisions too: discard calls cleanRun, which takes its own project/run locks.
  return withLock(`review-${runId}`, () => withLock(`project-${initial.project}`, () => {
    const run = reviewable(runId);
    const head = git(run.worktree, ["rev-parse", "--verify", "HEAD"]);
    if (!head.ok) throw unavailable();
    if (head.out !== selection.head) throw new CodecError("changes_stale", S.errors.changes_stale, {}, 409);
    const temp = mkdtempSync(join(runsDir(), runId, "review-"));
    try {
      const patchFile = join(temp, "selected.patch");
      const counts = selectedPatch(run, head.out, selection.hunks, patchFile);
      const projectGit = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync("git", ["-C", run.projectPath, ...args],
        { encoding: "utf-8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...env } });
      const status = projectGit(["status", "--porcelain", "--untracked-files=all"]);
      if (status.status !== 0 || status.stdout) throw new CodecError("project_not_clean", S.errors.project_not_clean, {}, 409);
      if (projectGit(["symbolic-ref", "-q", "HEAD"]).status !== 0) {
        throw new CodecError("project_detached", S.errors.project_detached, {}, 409);
      }
      const identity = checkpointIdentity(run.projectPath);
      if (!identity) throw new CodecError("identity_missing", S.errors.identity_missing, {}, 409);
      const original = projectGit(["rev-parse", "HEAD"]);
      if (original.status !== 0) throw unavailable();
      if (projectGit(["apply", "--check", "--index", "--whitespace=nowarn", patchFile]).status !== 0) throw conflict();
      // Without --reject, git apply fails atomically if any part cannot be applied.
      if (projectGit(["apply", "--index", "--whitespace=nowarn", patchFile]).status !== 0) throw conflict();
      const task = redactSecrets(run.task.split(/\r?\n/, 1)[0].trim()).slice(0, 100);
      const commit = projectGit(["-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null",
        "commit", "-m", wording(S.diffViewer.applyMessage, { task })], identityEnvironment(identity));
      if (commit.status !== 0) {
        projectGit(["reset", "--hard", original.stdout.trim()]);
        throw new CodecError("tracking_failed", S.errors.tracking_failed, {}, 500);
      }
      const reviewed = { action: "applied" as const, at: new Date().toISOString(),
        commit: projectGit(["rev-parse", "HEAD"]).stdout.trim(), ...counts };
      const updated = queueTests(run, { ...reviewed, tests: { state: "queued" } });
      logEvent("run.apply", { runId, project: run.project, ...reviewed });
      return updated;
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }));
}

export function discardChanges(runId: string): RunStatus {
  reviewable(runId, true);
  return withLock(`review-${runId}`, () => {
    const run = reviewable(runId, true);
    cleanRun(runId, { force: false, deleteBranch: false });
    const reviewed = { action: "discarded" as const, at: new Date().toISOString() };
    const updated = recordReview(runId, reviewed);
    logEvent("run.discard", { runId, project: run.project, ...reviewed });
    return updated;
  });
}
