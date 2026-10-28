/** Standalone Node script saved outside the workspace; runs even when Codec is closed. */
export const COMMIT_ATTRIBUTION_SCRIPT = String.raw`
const { spawnSync } = require("node:child_process");
const { readFileSync, writeFileSync, renameSync } = require("node:fs");
const { join } = require("node:path");
const dir = process.env.CODEC_RUN_DIR;
const run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
class AttributionError extends Error { code = "attribution_cleanup_failed"; }
function git(args, input, env = {}) {
  const result = spawnSync("git", ["-C", run.worktree, ...args], {
    input, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new AttributionError(result.stderr?.toString() || result.error?.message || "git failed");
  return result.stdout;
}
function text(args) { return git(args).toString("utf8").trim(); }
try {
  const ref = "refs/heads/" + run.branch;
  // Refuse detached HEADs and other branches, including the project's main branch.
  if (!run.branch.startsWith("codec/run-") || text(["symbolic-ref", "HEAD"]) !== ref) {
    throw new AttributionError("Attribution cleanup requires the task branch");
  }
  const head = text(["rev-parse", "HEAD"]);
  git(["merge-base", "--is-ancestor", run.baseSha, head]);
  const commits = text(["rev-list", "--reverse", "--topo-order", run.baseSha + ".." + head]).split("\n").filter(Boolean);
  const rewritten = new Map();
  let stripped = 0;
  for (const sha of commits) {
    // latin1 gives one character per byte so unrelated message bytes survive verbatim.
    const raw = git(["cat-file", "commit", sha]).toString("latin1");
    const split = raw.indexOf("\n\n");
    const headers = raw.slice(0, split).split("\n");
    const message = raw.slice(split + 2);
    const lines = message.match(/[^\n]*\n|[^\n]+$/g) || [];
    let end = lines.length;
    while (end && !lines[end - 1].trim()) end--;
    let start = end;
    while (start && lines[start - 1].trim()) start--;
    const trailerBlock = lines.slice(start, end).every(line => /^[\w-]+\s*:|^[ \t]+\S/.test(line));
    let removed = 0;
    const cleaned = lines.filter((line, index) => {
      if (!trailerBlock || index < start || index >= end) return true;
      const trailer = line.match(/^[ \t]*co-authored-by\s*:\s*(.*)/i);
      if (!trailer) return true;
      const name = trailer[1].split("<", 1)[0].trim();
      const ai = /^(?:claude(?:[ -]+(?:code|opus|sonnet|haiku|assistant|ai)\b.*)?|codex(?:\b.*)?|gemini(?:\b.*)?)$|\b(?:anthropic|openai|chatgpt|copilot|gpt|ai)\b/i.test(name) ||
        /<[^>]*(?:noreply|no-reply)[^>]*>/i.test(trailer[1]);
      if (ai) removed++;
      return !ai;
    }).join("");
    const parents = headers.filter(line => line.startsWith("parent ")).map(line => line.slice(7));
    const mapped = parents.map(parent => rewritten.get(parent) || parent);
    if (!removed && parents.every((parent, index) => parent === mapped[index])) continue;
    const tree = headers.find(line => line.startsWith("tree ")).slice(5);
    const date = kind => headers.find(line => line.startsWith(kind + " ")).match(/ (\d+ [+-]\d{4})$/)[1];
    const encoding = headers.find(line => line.startsWith("encoding "))?.slice(9) || "UTF-8";
    const next = git(["-c", "commit.gpgSign=false", "-c", "i18n.commitEncoding=" + encoding,
      "commit-tree", tree, ...mapped.flatMap(parent => ["-p", parent])], Buffer.from(cleaned, "latin1"), {
      GIT_AUTHOR_DATE: date("author"), GIT_COMMITTER_DATE: date("committer"),
    }).toString("utf8").trim();
    rewritten.set(sha, next);
    stripped += removed;
  }
  if (rewritten.has(head)) {
    // Compare-and-swap only the task ref. Neither the index nor worktree is changed.
    if (text(["symbolic-ref", "HEAD"]) !== ref) throw new AttributionError("Task branch changed during cleanup");
    git(["update-ref", "-m", "Codec: remove AI co-author trailers", ref, rewritten.get(head), head]);
  }
  if (stripped) {
    const file = join(dir, "attribution.json");
    writeFileSync(file + ".tmp", JSON.stringify({ coAuthorStripped: stripped }) + "\n");
    renameSync(file + ".tmp", file);
  }
} catch (error) {
  console.error("Codec attribution cleanup failed:", error.message);
  process.exitCode = 98;
}
`;
