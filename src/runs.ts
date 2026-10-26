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
import { getProject, git, removeProject, type Project } from "./registry.js";
import {
  deleteMember,
  deleteTeam,
  dropProjectFromTeams,
  getTeam,
  parseMemberRef,
  resolveMember,
  type Member,
  type ResolvedMember,
  type Team,
} from "./org.js";
import { injectSkills, instructionsText, projectSkills, type GivenSkill } from "./inject.js";
import { renderClaudeStream, skillCallsFromClaudeStream } from "./claude-stream.js";
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

import { AGENTS, type Agent } from "./tools.js";
export { AGENTS, type Agent };
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
  // Stage 3: who ran it. Absent on "unassigned worker" quick runs.
  team?: string;
  member?: string;
  specialist?: string;
  specialty?: string;
  model?: string;
  /** Exactly the skills the agent could see, with where each came from. */
  skills?: GivenSkill[];
  /** How output.log is written: plain text, or Claude Code's stream-json (rendered on read). */
  outputFormat?: "text" | "claude-stream";
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
export function agentCommand(agent: Agent, opts: { model?: string; instructions?: boolean } = {}): string {
  const override = process.env.CODEC_AGENT_COMMAND;
  if (override) return override;
  const prompt = `"$(cat "$CODEC_TASK_FILE")"`;
  // Model names are validated (org.ts) to a shell-safe character set.
  const model = opts.model ? `'${opts.model.replace(/'/g, "")}'` : "";
  if (agent === "claude") {
    return [
      "claude --dangerously-skip-permissions -p",
      prompt,
      "--output-format stream-json --verbose", // structured, so Skill tool calls can be detected
      model && `--model ${model}`,
      opts.instructions && `--append-system-prompt "$(cat "$CODEC_RUN_DIR/instructions.md")"`,
    ]
      .filter(Boolean)
      .join(" ");
  }
  return [
    "codex exec --yolo",
    model && `-m ${model}`,
    opts.instructions && `-c "developer_instructions=$(cat "$CODEC_RUN_DIR/instructions.toml")"`,
    prompt,
  ]
    .filter(Boolean)
    .join(" ");
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

export interface StartInput {
  project: string;
  /** claude | codex. Required for an unassigned quick run; optional (must match) with a member. */
  agent?: string;
  task: string;
  /** "team/member" — run as that team member, with its skills and instructions. */
  member?: string;
}

export function startRun(input: StartInput): RunStatus {
  if (!input.task || !input.task.trim()) throw new Error("--task is required");
  const project = getProject(input.project);
  if (!project) throw new Error(`no project named "${input.project}" (see: codec project list)`);

  let who: ResolvedMember | undefined;
  if (input.member) {
    const ref = parseMemberRef(input.member);
    who = resolveMember(ref.team, ref.member);
    if (!who.projects.includes(project.name)) {
      throw new Error(
        `team ${who.team} doesn't work on ${project.name} (its projects: ${who.projects.join(", ") || "none"})`,
      );
    }
    if (input.agent && input.agent !== who.tool) {
      throw new Error(`${who.team}/${who.member} uses ${who.tool}, not ${input.agent}`);
    }
  } else if (!input.agent) {
    throw new Error("choose a team member (--member <team>/<member>) or a tool for an unassigned worker (--agent claude|codex)");
  }
  const agentName = who ? who.tool : input.agent!;
  if (!(AGENTS as readonly string[]).includes(agentName)) {
    throw new Error(`unknown agent "${agentName}" (use: ${AGENTS.join(", ")})`);
  }
  const agent = agentName as Agent;
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

  mkdirSync(dir, { recursive: true });
  let skills: GivenSkill[];
  try {
    skills = who ? injectSkills(worktree, agent, who.skills) : projectSkills(worktree, agent);
  } catch (e) {
    // Don't leave a half-prepared worktree behind.
    withLock(`project-${project.name}`, () => {
      git(project.path, ["worktree", "remove", "--force", worktree]);
      git(project.path, ["branch", "-D", branch]);
    });
    throw e;
  }
  const instructions = instructionsText(who);
  if (instructions) {
    writeFileSync(join(dir, "instructions.md"), instructions);
    // A TOML basic string for `codex -c developer_instructions=...`; JSON string escapes are valid TOML.
    writeFileSync(join(dir, "instructions.toml"), JSON.stringify(instructions));
  }
  const command = agentCommand(agent, { model: who?.model, instructions: !!instructions });
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
    team: who?.team,
    member: who?.member,
    specialist: who?.specialist,
    specialty: who?.specialty,
    model: who?.model,
    skills,
    outputFormat: agent === "claude" ? "claude-stream" : "text",
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

  logEvent("run.start", {
    runId,
    project: project.name,
    agent,
    branch,
    worktree,
    pid,
    team: who?.team,
    member: who?.member,
    skills: skills.map((s) => `${s.name}:${s.source}`),
  });
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

function rawOutput(runId: string): string {
  const f = join(runDir(runId), "output.log");
  return existsSync(f) ? readFileSync(f, "utf-8") : "";
}

/** Last `lines` lines of a run's output, as readable text. */
export function runOutput(ref: string, lines = 50): string {
  const run = findRun(ref);
  let text = rawOutput(run.runId);
  if (run.outputFormat === "claude-stream") text = renderClaudeStream(text);
  return text.split("\n").slice(-lines - 1).join("\n");
}

export interface SkillUse {
  name: string;
  /** "detected": the agent really called the skill (Claude's Skill tool). "guess": inferred from text. */
  how: "detected" | "guess";
  evidence: string;
}

/**
 * Which skills the agent used.
 * claude: exact — every Skill tool call in its structured output.
 * codex: best-effort guess — it read the skill's SKILL.md, or named the skill.
 */
export function skillsUsed(ref: string): SkillUse[] {
  const run = findRun(ref);
  const raw = rawOutput(run.runId);
  if (run.outputFormat === "claude-stream") {
    return skillCallsFromClaudeStream(raw).map((name) => ({ name, how: "detected" as const, evidence: "Skill tool call" }));
  }
  const out: SkillUse[] = [];
  for (const s of run.skills ?? []) {
    const esc = s.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`skills/${esc}/SKILL\\.md`).test(raw)) {
      out.push({ name: s.name, how: "guess", evidence: "its SKILL.md appears in the agent's output (likely read it)" });
    } else if (new RegExp(`(^|[^A-Za-z0-9-])${esc}([^A-Za-z0-9-]|$)`).test(raw)) {
      out.push({ name: s.name, how: "guess", evidence: "the skill's name appears in the agent's output" });
    }
  }
  return out;
}

// ---------- removals that depend on running agents ----------

function refuseIfRunning(what: string, running: RunStatus[]): void {
  if (running.length) {
    throw new Error(
      `${what} has ${running.length} running agent(s): ${running.map((r) => r.runId).join(", ")} — stop them first`,
    );
  }
}

/** Remove a team, refusing while any of its members is working. */
export function removeTeamChecked(name: string): Team {
  if (!getTeam(name)) throw new Error(`no team named "${name}"`);
  refuseIfRunning(`team ${name}`, listRuns({ state: "running" }).filter((r) => r.team === name));
  return deleteTeam(name);
}

/** Remove a team member, refusing while it is working. */
export function removeMemberChecked(team: string, member: string): Member {
  refuseIfRunning(
    `${team}/${member}`,
    listRuns({ state: "running" }).filter((r) => r.team === team && r.member === member),
  );
  return deleteMember(team, member);
}

/**
 * Unregister a project, refusing while agents are still running on it.
 * Shared by `codec project remove` and the dashboard.
 */
export function removeProjectChecked(name: string): Project {
  if (!getProject(name)) throw new Error(`no project named "${name}"`);
  refuseIfRunning(name, listRuns({ project: name, state: "running" }));
  const p = removeProject(name);
  dropProjectFromTeams(name);
  return p;
}
