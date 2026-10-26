/**
 * runs.ts — agent runs: one git worktree + one background agent process each.
 *
 * Adapted from the hive's codex-tasks engine (backend commands, verified
 * registration, durable on-disk records), reworked for many projects:
 *
 *   $CODEC_HOME/runs/<runId>/
 *     run.json     the run record (project, agent, pid, worktree, ...)
 *     task.txt     the task text handed to the agent
 *     agent.sh     the agent command line
 *     run.sh       wrapper: cd into the worktree, run agent.sh, record exit
 *     output.log   everything the agent printed
 *     exit_code    written by run.sh when the agent exits
 *   $CODEC_HOME/worktrees/<project>/<runId>/   the agent's private checkout
 *
 * The agent runs as a detached process group, so it keeps going after the
 * `codec` command that started it exits. A run's state is never cached — it
 * is derived each time from run.json + exit_code + whether the pid is alive,
 * so restarting codec (or the whole terminal) loses nothing.
 */

import { spawn } from "child_process";
import { existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import { logEvent } from "./events.js";
import { getProject, git } from "./registry.js";
import {
  eventsFile,
  pidAlive,
  readJson,
  runsDir,
  sleepSync,
  withLock,
  worktreesDir,
  writeJsonAtomic,
} from "./store.js";

export const AGENTS = ["claude", "codex"] as const;
export type Agent = (typeof AGENTS)[number];
export type RunState = "running" | "done" | "failed" | "stopped";

export interface RunRecord {
  runId: string;
  project: string;
  projectPath: string;
  agent: Agent;
  task: string;
  branch: string;
  worktree: string;
  baseSha: string;
  command: string;
  startedAt: string;
  pid?: number;
  stoppedAt?: string;
  lostAt?: string;
  cleanedAt?: string;
}

export interface RunStatus extends RunRecord {
  state: RunState;
  exitCode?: number;
}

/** A run with no pid yet is "starting"; past this it's considered lost. */
const START_GRACE_MS = 10_000;

const runDir = (runId: string): string => join(runsDir(), runId);
const recordFile = (runId: string): string => join(runDir(runId), "run.json");

/**
 * The CLI command for each agent. Both run headless and fully autonomous
 * inside their own worktree, reading the task from $CODEC_TASK_FILE.
 * CODEC_AGENT_COMMAND overrides it (used by tests and demos with a fake agent).
 */
export function agentCommand(agent: Agent): string {
  const override = process.env.CODEC_AGENT_COMMAND;
  if (override) return override;
  const prompt = `"$(cat "$CODEC_TASK_FILE")"`;
  if (agent === "claude") return `claude --dangerously-skip-permissions -p ${prompt}`;
  return `codex exec --yolo ${prompt}`;
}

// Fixed wrapper; every variable part arrives through the environment, so
// nothing user-supplied is ever spliced into shell source here.
const WRAPPER = `# codec run wrapper (generated)
if cd "$CODEC_WORKTREE"; then
  bash "$CODEC_RUN_DIR/agent.sh"
  code=$?
else
  code=97
fi
printf '%s\\n' "$code" > "$CODEC_RUN_DIR/exit_code.tmp" && mv -f "$CODEC_RUN_DIR/exit_code.tmp" "$CODEC_RUN_DIR/exit_code"
printf '{"ts":"%s","kind":"run.finish","runId":"%s","project":"%s","agent":"%s","exitCode":%s}\\n' \\
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$CODEC_RUN_ID" "$CODEC_PROJECT" "$CODEC_AGENT" "$code" >> "$CODEC_EVENTS_FILE"
exit "$code"
`;

export function startRun(input: { project: string; agent: string; task: string }): RunStatus {
  if (!(AGENTS as readonly string[]).includes(input.agent)) {
    throw new Error(`unknown agent "${input.agent}" (use: ${AGENTS.join(", ")})`);
  }
  const agent = input.agent as Agent;
  if (!input.task || !input.task.trim()) throw new Error("--task is required");
  const project = getProject(input.project);
  if (!project) throw new Error(`no project named "${input.project}" (see: codec project list)`);
  if (!existsSync(project.path)) throw new Error(`project path no longer exists: ${project.path}`);

  const runId = "run-" + randomBytes(4).toString("hex");
  const branch = `codec/${runId}`;
  const worktree = join(worktreesDir(), project.name, runId);
  const dir = runDir(runId);

  // Worktree creation touches the repo's shared git metadata; serialize it
  // per project so parallel `codec run` calls on one repo can't collide.
  const baseSha = withLock(`project-${project.name}`, () => {
    const head = git(project.path, ["rev-parse", "HEAD"]);
    if (!head.ok) throw new Error(`cannot read HEAD of ${project.path}: ${head.err}`);
    mkdirSync(join(worktreesDir(), project.name), { recursive: true });
    const add = git(project.path, ["worktree", "add", "-q", "-b", branch, worktree, head.out]);
    if (!add.ok) throw new Error(`git worktree add failed: ${add.err}`);
    return head.out;
  });

  const command = agentCommand(agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "task.txt"), input.task);
  writeFileSync(join(dir, "agent.sh"), command + "\n");
  writeFileSync(join(dir, "run.sh"), WRAPPER);

  const record: RunRecord = {
    runId,
    project: project.name,
    projectPath: project.path,
    agent,
    task: input.task,
    branch,
    worktree,
    baseSha,
    command,
    startedAt: new Date().toISOString(),
  };
  writeJsonAtomic(recordFile(runId), record);

  const log = openSync(join(dir, "output.log"), "a");
  let pid: number | undefined;
  try {
    const child = spawn("bash", [join(dir, "run.sh")], {
      cwd: worktree,
      detached: true, // own process group: survives codec exiting, stoppable as a unit
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        CODEC_RUN_ID: runId,
        CODEC_PROJECT: project.name,
        CODEC_AGENT: agent,
        CODEC_WORKTREE: worktree,
        CODEC_RUN_DIR: dir,
        CODEC_TASK_FILE: join(dir, "task.txt"),
        CODEC_EVENTS_FILE: eventsFile(),
      },
    });
    pid = child.pid;
    child.unref();
  } finally {
    closeSync(log);
  }
  if (!pid) throw new Error(`failed to spawn agent for ${runId} (see ${join(dir, "output.log")})`);

  writeJsonAtomic(recordFile(runId), { ...record, pid });
  // Verified registration (from the hive): never report a launch the
  // status view can't see. If the record didn't persist, kill and fail.
  const check = readRecord(runId);
  if (!check || check.pid !== pid) {
    killGroup(pid, "SIGKILL");
    throw new Error(`run ${runId} failed to persist — launch aborted`);
  }

  logEvent("run.start", { runId, project: project.name, agent, branch, worktree, pid });
  return getRunStatus(runId)!;
}

function readRecord(runId: string): RunRecord | undefined {
  try {
    return readJson<RunRecord | undefined>(recordFile(runId), undefined);
  } catch {
    return undefined;
  }
}

function readExitCode(runId: string): number | undefined {
  const f = join(runDir(runId), "exit_code");
  if (!existsSync(f)) return undefined;
  const n = Number(readFileSync(f, "utf-8").trim());
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Is this run's wrapper process still alive? On Linux also confirm the pid
 * is really our wrapper (guards against pid reuse after a reboot, and
 * against zombies, whose cmdline is empty).
 */
function processAlive(rec: RunRecord): boolean {
  if (!rec.pid || !pidAlive(rec.pid)) return false;
  const proc = `/proc/${rec.pid}/cmdline`;
  if (existsSync("/proc/self/cmdline")) {
    try {
      return readFileSync(proc, "utf-8").includes(join(runDir(rec.runId), "run.sh"));
    } catch {
      return false;
    }
  }
  return true;
}

function deriveState(rec: RunRecord, exitCode: number | undefined): RunState {
  if (rec.stoppedAt) return "stopped";
  if (exitCode !== undefined) return exitCode === 0 ? "done" : "failed";
  if (rec.lostAt) return "failed";
  if (processAlive(rec)) return "running";
  if (!rec.pid && Date.now() - Date.parse(rec.startedAt) < START_GRACE_MS) return "running";
  return "failed";
}

export function getRunStatus(runId: string): RunStatus | undefined {
  let rec = readRecord(runId);
  if (!rec) return undefined;
  let exitCode = readExitCode(runId);
  let state = deriveState(rec, exitCode);

  // Died without writing an exit code: record that once, under the run's lock.
  if (state === "failed" && exitCode === undefined && !rec.lostAt) {
    rec = withLock(`run-${runId}`, () => {
      const fresh = readRecord(runId)!;
      if (fresh.lostAt || fresh.stoppedAt || readExitCode(runId) !== undefined) return fresh;
      const updated = { ...fresh, lostAt: new Date().toISOString() };
      writeJsonAtomic(recordFile(runId), updated);
      logEvent("run.lost", { runId, project: fresh.project, pid: fresh.pid });
      return updated;
    });
    exitCode = readExitCode(runId);
    state = deriveState(rec, exitCode);
  }
  return { ...rec, state, exitCode };
}

/** Every run across every project, oldest first. */
export function listRuns(filter?: { project?: string; state?: RunState }): RunStatus[] {
  if (!existsSync(runsDir())) return [];
  const out: RunStatus[] = [];
  for (const id of readdirSync(runsDir())) {
    const s = getRunStatus(id);
    if (!s) continue;
    if (filter?.project && s.project !== filter.project) continue;
    if (filter?.state && s.state !== filter.state) continue;
    out.push(s);
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** Resolve a run by full id, or a unique prefix with or without "run-". */
export function findRun(ref: string): RunStatus {
  const ids = existsSync(runsDir()) ? readdirSync(runsDir()) : [];
  const want = ref.startsWith("run-") ? ref : `run-${ref}`;
  if (ids.includes(want)) return getRunStatus(want)!;
  const matches = ids.filter((id) => id.startsWith(want));
  if (matches.length === 1) return getRunStatus(matches[0])!;
  if (matches.length > 1) throw new Error(`"${ref}" matches several runs: ${matches.join(", ")}`);
  throw new Error(`no run "${ref}" (see: codec status)`);
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

/** Stop a running agent (whole process group: wrapper, agent and children). */
export function stopRun(ref: string): RunStatus {
  const run = findRun(ref);
  if (run.state !== "running") throw new Error(`${run.runId} is not running (state: ${run.state})`);
  if (run.pid) {
    killGroup(run.pid, "SIGTERM");
    const deadline = Date.now() + 5000;
    while (processAlive(run) && Date.now() < deadline) sleepSync(50);
    if (processAlive(run)) killGroup(run.pid, "SIGKILL");
  }
  withLock(`run-${run.runId}`, () => {
    const fresh = readRecord(run.runId)!;
    writeJsonAtomic(recordFile(run.runId), { ...fresh, stoppedAt: new Date().toISOString() });
  });
  logEvent("run.stop", { runId: run.runId, project: run.project });
  return getRunStatus(run.runId)!;
}

/**
 * Remove a finished run's worktree. Refuses while running, and refuses a
 * worktree with uncommitted changes unless `force` (those changes are lost).
 * The branch (and any commits the agent made) is kept unless `deleteBranch`.
 */
export function cleanRun(ref: string, opts: { force?: boolean; deleteBranch?: boolean } = {}): RunStatus {
  const run = findRun(ref);
  if (run.state === "running") throw new Error(`${run.runId} is still running — stop it first`);
  if (run.cleanedAt) throw new Error(`${run.runId} was already cleaned`);
  const repo = run.projectPath;

  withLock(`project-${run.project}`, () => {
    if (existsSync(run.worktree)) {
      const args = ["worktree", "remove", ...(opts.force ? ["--force"] : []), run.worktree];
      const r = git(repo, args);
      if (!r.ok) {
        throw new Error(
          `could not remove worktree: ${r.err}` +
            (opts.force ? "" : "\n(it has uncommitted changes — use --force to discard them)"),
        );
      }
    }
    git(repo, ["worktree", "prune"]);
    if (opts.deleteBranch) {
      const b = git(repo, ["branch", "-D", run.branch]);
      if (!b.ok && !/not found/.test(b.err)) throw new Error(`could not delete branch: ${b.err}`);
    }
  });

  withLock(`run-${run.runId}`, () => {
    const fresh = readRecord(run.runId)!;
    writeJsonAtomic(recordFile(run.runId), { ...fresh, cleanedAt: new Date().toISOString() });
  });
  logEvent("run.clean", { runId: run.runId, project: run.project, deletedBranch: !!opts.deleteBranch });
  return getRunStatus(run.runId)!;
}

/** Last `lines` lines of a run's output. */
export function runOutput(ref: string, lines = 50): string {
  const run = findRun(ref);
  const f = join(runDir(run.runId), "output.log");
  if (!existsSync(f)) return "";
  return readFileSync(f, "utf-8").split("\n").slice(-lines - 1).join("\n");
}
