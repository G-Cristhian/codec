/** Background project tests. Ownership and project queues belong to this process. */
import { spawn, spawnSync } from "child_process";
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { StringDecoder } from "string_decoder";
import { CodecError } from "./errors.js";
import { logEvent } from "./events.js";
import { helperRef } from "./coordinator.js";
import { postMessage } from "./messages.js";
import { git } from "./registry.js";
import { readRunStatus, recordReview, recordTests, type RunRecord, type RunReview, type RunStatus, type RunTests } from "./runs.js";
import { redactSecrets } from "./secrets.js";
import { runsDir, withLock } from "./store.js";
import { S, wording } from "./strings.js";

export const MAX_TEST_OUTPUT_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15 * 60 * 1000;
const owners = new Map<string, Promise<void>>();
const projects = new Map<string, Promise<void>>();
const key = (runId: string) => join(runsDir(), runId);
const unavailable = () => new CodecError("tests_unavailable", S.errors.tests_unavailable, {}, 409);

/** Read-time recovery; the next ordinary record write persists this result. */
export function recoverTestRun(record: RunRecord): void {
  const tests = record.reviewed?.action === "applied" ? record.reviewed.tests : undefined;
  if (tests && (tests.state === "queued" || tests.state === "running") && !owners.has(key(record.runId))) {
    tests.state = "interrupted";
    tests.note = S.tests.interrupted;
  }
}

/** Best effort reporter parsing. No filesystem or process access. */
export function parseTestFailures(output: string): NonNullable<RunTests["failures"]> {
  const failures: NonNullable<RunTests["failures"]> = [];
  const add = (name: string, file?: string) => {
    name = name.trim().replace(/\s+\d+(?:\.\d+)?m?s$/, "");
    if (failures.some((failure) => failure.name === name && failure.file === file)) return;
    const detailed = failures.find((failure) => failure.file === file && failure.name.endsWith(" > " + name));
    if (detailed) return;
    const compact = failures.find((failure) => failure.file === file && name.endsWith(" > " + failure.name));
    if (compact) { compact.name = name; return; }
    if (name && failures.length < 50) {
      failures.push({ name, ...(file ? { file } : {}) });
    }
  };
  let file: string | undefined;
  let mocha = false;
  let mochaName: string | undefined;
  const flushMocha = () => { if (mochaName) add(mochaName, file); mochaName = undefined; };
  for (const raw of output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const line = raw.trim();
    const fail = line.match(/^FAIL\s+(.+?)(?:\s+>\s+(.+))?$/);
    if (fail) {
      file = fail[1].replace(/\s+\(.+\)$/, "");
      if (fail[2]) add(fail[2], file);
      continue;
    }
    const vitestFile = line.match(/^[❯×]\s+(.+?\.(?:[cm]?[jt]sx?))\s+\(/);
    if (vitestFile) { file = vitestFile[1]; continue; }
    const named = line.match(/^(?:[×✕]\s+|●\s+)(.+)$/);
    if (named) { add(named[1], file); continue; }
    const node = line.match(/^not ok \d+\s*-\s*(.+)$/);
    if (node) { file = undefined; add(node[1]); continue; }
    const location = line.match(/^location:\s*['"]?(.+?):\d+(?::\d+)?['"]?$/);
    if (location && failures.length && !failures.at(-1)!.file) failures.at(-1)!.file = location[1];
    if (/^\d+ failing$/.test(line)) { mocha = true; file = undefined; continue; }
    if (mocha) {
      const numbered = line.match(/^\d+\)\s+(.+?)(?::)?$/);
      if (numbered) { flushMocha(); file = undefined; mochaName = numbered[1]; continue; }
      const stack = line.match(/\(?((?:[A-Za-z]:)?[^\s()]+\.[cm]?[jt]s):\d+:\d+\)?/);
      if (stack && mochaName) { file = stack[1]; flushMocha(); }
      else if (mochaName && line.endsWith(":")) mochaName += " " + line.slice(0, -1);
    }
  }
  flushMocha();
  return failures;
}

function tested(runId: string, states?: RunTests["state"][]) {
  const run = readRunStatus(runId);
  if (!run) throw new CodecError("run_not_found", S.errors.run_not_found, {}, 404);
  if (run.reviewed?.action !== "applied" || !run.reviewed.tests ||
      (states && !states.includes(run.reviewed.tests.state))) throw unavailable();
  return { run, reviewed: run.reviewed, tests: run.reviewed.tests };
}

export function testsOutput(runId: string, full = false): string {
  const { tests } = tested(runId);
  // Derive the path, never follow a path supplied by a client or stale metadata.
  const file = join(key(runId), "tests.log");
  if (!tests.outputFile || !existsSync(file)) throw unavailable();
  const output = readFileSync(file, "utf8");
  if (full) return output;
  const lines = output.replace(/\n$/, "").split("\n");
  return lines.length > 2000 ? S.tests.outputTrimmed + "\n\n" + lines.slice(-2000).join("\n") : output;
}

/** Claim before writing queued, so that status reads never mistake a new job for a restart. */
export function queueTests(run: RunStatus, reviewed: Extract<RunReview, { action: "applied" }>, options: { timeoutMs?: number } = {}): RunStatus {
  const id = key(run.runId);
  if (owners.has(id)) throw unavailable();
  const project = realpathSync(run.projectPath);
  const env = { ...process.env, CI: "true" };
  const previous = projects.get(project) ?? Promise.resolve();
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  let recorded = false;
  const job = previous.catch(() => {}).then(() => ready).then(() => recorded ? execute(run, env, options.timeoutMs ?? TIMEOUT_MS) : undefined)
    .catch(() => {
      try { recordTests(run.runId, (tests) => ({ ...tests, state: "error", finishedAt: new Date().toISOString(), note: S.tests.runError })); }
      catch { /* A lost data folder must not reject an unobserved background promise. */ }
      logEvent("run.tests", { runId: run.runId, phase: "finish", state: "error" });
    }).finally(() => {
      owners.delete(id);
      if (projects.get(project) === job) projects.delete(project);
    });
  owners.set(id, job);
  projects.set(project, job);
  try {
    const updated = recordReview(run.runId, { ...reviewed, tests: { state: "queued" } });
    recorded = true;
    return updated;
  }
  finally { release(); }
}

/** Also lets fixture teardown wait until no background writes remain. */
export async function waitForTests(runId: string): Promise<void> {
  await owners.get(key(runId));
}

async function execute(run: RunStatus, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<void> {
  const outputFile = join(key(run.runId), "tests.log");
  writeFileSync(outputFile, "", { mode: 0o600 });
  const finish = (patch: Partial<RunTests> & { state: RunTests["state"] }) => {
    recordTests(run.runId, (tests) => ({ ...tests, ...patch, outputFile, finishedAt: new Date().toISOString() }));
    logEvent("run.tests", { runId: run.runId, project: run.project, phase: "finish", state: patch.state });
  };
  if (!env.CODEC_TEST_COMMAND) {
    let script: unknown;
    try { script = JSON.parse(readFileSync(join(run.projectPath, "package.json"), "utf8")).scripts?.test; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") { finish({ state: "error", note: S.tests.startError }); return; }
    }
    if (typeof script !== "string" || !script.trim() || /^echo\s+["']Error: no test specified["']\s*&&\s*exit\s+1\s*;?$/.test(script.trim())) {
      finish({ state: "skipped", note: S.tests.skipNote });
      return;
    }
  }
  recordTests(run.runId, () => ({ state: "running", startedAt: new Date().toISOString(), outputFile }));
  logEvent("run.tests", { runId: run.runId, project: run.project, phase: "start", state: "running" });
  // Keep the tail in memory as well as on disk; neither can exceed the cap.
  let tail = Buffer.alloc(0);
  let outputError = false;
  const write = (chunk: string) => {
    if (outputError || !chunk) return;
    try {
      const safe = Buffer.from(redactSecrets(chunk));
      const combined = Buffer.concat([tail, safe]);
      if (combined.length > MAX_TEST_OUTPUT_BYTES) {
        tail = Buffer.from(combined.subarray(combined.length - MAX_TEST_OUTPUT_BYTES));
        // Don't leave a partial UTF-8 sequence at the new beginning.
        while (tail.length && (tail[0] & 0xc0) === 0x80) tail = tail.subarray(1);
        writeFileSync(outputFile, tail);
      } else { tail = combined; appendFileSync(outputFile, safe); }
    } catch { outputError = true; }
  };
  const result = await new Promise<{ code: number | null; error?: boolean; timedOut?: boolean }>((resolve) => {
    let child;
    try {
      child = env.CODEC_TEST_COMMAND
        ? spawn(env.CODEC_TEST_COMMAND, { cwd: run.projectPath, env, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"] })
        : spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["test"], { cwd: run.projectPath, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch { resolve({ code: null, error: true }); return; }
    let timedOut = false;
    let spawnError = false;
    const killGroup = () => {
      if (!child.pid) return;
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      else { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } }
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    // Preserve pipe arrival order, retaining incomplete lines so split secrets are redacted together.
    let pending = "";
    const consume = (text: string) => {
      pending += text;
      const end = pending.lastIndexOf("\n");
      if (end >= 0) { write(pending.slice(0, end + 1)); pending = pending.slice(end + 1); }
      if (pending.length > MAX_TEST_OUTPUT_BYTES) pending = redactSecrets(pending).slice(-MAX_TEST_OUTPUT_BYTES);
      if (outputError) killGroup();
    };
    for (const stream of [child.stdout!, child.stderr!]) {
      const decoder = new StringDecoder("utf8");
      stream.on("data", (chunk: Buffer) => consume(decoder.write(chunk)));
      stream.on("end", () => consume(decoder.end()));
    }
    child.on("error", () => { spawnError = true; });
    child.on("close", (code) => { clearTimeout(timer); write(pending); resolve({ code, error: spawnError, timedOut }); });
  });
  const output = tail.toString("utf8");
  const reviewed = tested(run.runId).reviewed;
  const changed = git(run.projectPath, ["show", "--pretty=format:", "--name-only", "-z", reviewed.commit, "--"]);
  finish({ state: result.timedOut || result.error || outputError ? "error" : result.code === 0 ? "passed" : "failed",
    ...(result.code === null ? {} : { exitCode: result.code }),
    ...(result.timedOut ? { note: S.tests.timedOut } : result.error ? { note: S.tests.startError } : outputError ? { note: S.tests.runError } : {}),
    failures: parseTestFailures(output), changedFiles: changed.ok ? changed.out.split("\0").filter((file) => file && output.includes(file)) : [],
  });
}

export function rerunTests(runId: string, options: { timeoutMs?: number } = {}): RunStatus {
  return withLock(`review-${runId}`, () => {
    const { run, reviewed } = tested(runId, ["failed", "error", "interrupted"]);
    return queueTests(run, reviewed, options);
  });
}

export function markTestsDone(runId: string): RunStatus {
  return withLock(`review-${runId}`, () => {
    tested(runId, ["failed", "error", "interrupted"]);
    return recordTests(runId, (tests) => ({ ...tests, closedAt: new Date().toISOString() }));
  });
}

export function sendTestsBack(runId: string): { delivered: boolean; messageId: string } {
  return withLock(`review-${runId}`, () => {
    const { run, reviewed, tests } = tested(runId, ["failed", "error"]);
    const to = helperRef(run);
    if (!to || tests.sentBack) throw unavailable();
    const task = redactSecrets(run.task.split(/\r?\n/, 1)[0].trim()).slice(0, 100);
    const blocks = [wording(S.tests.messageHeader, { task, commit: reviewed.commit.slice(0, 7) })];
    if (tests.note) blocks.push(tests.note);
    blocks.push(tests.failures?.length ? wording(S.tests.messageFailures, { failures: tests.failures.map((f) =>
      "- " + (f.file ? wording(S.tests.messageFile, f) : f.name)).join("\n") }) : S.tests.unparsed);
    if (tests.changedFiles?.length) blocks.push(wording(S.tests.messageChangedFiles, { files: tests.changedFiles.join("\n") }));
    const full = tests.outputFile ? testsOutput(runId, true) : "";
    if (full.length > 100_000) blocks.push(S.tests.messageTrimmed);
    const output = full.slice(-100_000);
    const fence = "`".repeat(Math.max(3, ...[...output.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    blocks.push(wording(S.tests.messageOutput, { output, fence }));
    const message = postMessage({ from: "owner", to, body: blocks.join("\n\n") });
    recordTests(runId, (current) => ({ ...current, closedAt: undefined, sentBack: { at: message.sentAt, messageId: message.id, to } }));
    logEvent("run.sendBack", { runId, messageId: message.id, to });
    return { delivered: !!message.deliveredAt, messageId: message.id };
  });
}
