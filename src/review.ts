import { spawn } from "child_process";
import { createInterface } from "readline";
import { CodecError } from "./errors.js";
import { git } from "./registry.js";
import { readRunStatus } from "./runs.js";
import { S } from "./strings.js";

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
}

export interface RunChanges {
  status: "ready" | "no_changes";
  files: DiffFile[];
}

const unavailable = () => new CodecError("changes_unavailable", S.errors.changes_unavailable, {}, 409);

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
      binary, truncated: false, lines: [] });
  }
  return files;
}

/** Only inspect saved work. No client-supplied paths reach git. */
export async function runChanges(runId: string): Promise<RunChanges> {
  const run = readRunStatus(runId);
  if (!run) throw new CodecError("run_not_found", S.errors.run_not_found, {}, 404);
  if (run.reviewStatus !== "ready" && run.reviewStatus !== "no_changes") throw unavailable();
  if (run.reviewStatus === "no_changes") return { status: "no_changes", files: [] };

  // Pin HEAD so both reads describe the same checkpoint, even if another process commits.
  const head = git(run.worktree, ["rev-parse", "--verify", "HEAD"]);
  if (!head.ok) throw unavailable();
  const options = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "--no-relative",
    "--ignore-submodules=none", "--submodule=short", "--output-indicator-new=+",
    "--output-indicator-old=-", "--output-indicator-context= "];
  const range = [run.baseSha, head.out, "--"];
  const stats = git(run.worktree, [...options, "--numstat", "-z", ...range]);
  if (!stats.ok) throw unavailable();
  const files = fileStats(stats.out);

  // Stream the patch: large diffs must not hit spawnSync's output buffer limit.
  // The two commands use the same ordering; file boundaries never depend on decoding paths.
  const child = spawn("git", ["-C", run.worktree, ...options, ...range], { stdio: ["ignore", "pipe", "ignore"] });
  const finished = new Promise<boolean>((resolve) => {
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
  const input = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let index = -1;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
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
    if (file.lines.length >= MAX_FILE_DIFF_LINES || totalTruncated || total >= MAX_TOTAL_DIFF_LINES) {
      file.truncated = true;
    } else {
      file.lines.push(line);
    }
  }
  finishFile();
  if (!await finished || index + 1 !== files.length) throw unavailable();
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { status: "ready", files };
}
