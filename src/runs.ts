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

import { S, wording } from "./strings.js";
import { checkpointIdentity, identityEnvironment } from "./settings.js";
import { CodecError } from "./errors.js";
import { checkTimeLimit, DEFAULT_TIME_LIMIT_MINUTES } from "./limits.js";
import { isOurProcess, ownsProcessGroup } from "./proc.js";
import { spawn } from "child_process";
import { helperNodeExecutable } from "./runtime.js";
import { existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
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
import { receiveMessages } from "./messages.js";
import { helperRef, requireCoordinator } from "./coordinator.js";
import { modelFromClaudeStream, renderClaudeStream, skillCallsFromClaudeStream } from "./claude-stream.js";
import { modelFromCodexOutput } from "./codex-output.js";
import { COMMIT_ATTRIBUTION_SCRIPT } from "./commit-attribution.js";
import { ACTIVITY_SCRIPT } from "./activity.js";
import { accountCliArgs, accountEnvironment, clearAccountChoices, prepareAccount, resolveAccount } from "./accounts.js";
import { redactSecrets, redactValue } from "./secrets.js";
import {
  codecHome,
  eventsFile,
  readJson,
  runsDir,
  sleepSync,
  withLock,
  worktreesDir,
  writeJsonAtomic,
} from "./store.js";

import { AGENTS, type Agent } from "./tools.js";
import type { TaskArea } from "./planner.js";
import { claudeMcpConfig, claudePermissions, codexOverrides, codexSandbox, type Access, type Harness } from "./harness.js";
export { type Agent };
export type RunState = "running" | "done" | "failed" | "stopped" | "timed_out";

export interface HelperStatus {
  state: "progress" | "stuck" | "done";
  note: string;
  at: string;
}

export type RunReview =
  | { action: "applied"; at: string; commit: string; hunks: number; total: number }
  | { action: "discarded"; at: string };

export interface RunRecord {
  reviewed?: RunReview;
  helperStatus?: HelperStatus;
  /** Home tag chosen when the task was started. */
  area?: TaskArea;
  account?: { id: string; name: string };
  limitHit?: boolean;
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
  timeLimitMinutes?: number;
  deadline?: string;
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
  actualModel?: string;
  autoSaved?: boolean;
  coAuthorStripped?: number;
  checkpointError?: "checkpoint_save_failed";
  /** Exactly the skills the agent could see, with where each came from. */
  skills?: GivenSkill[];
  /** How output.log is written: plain text, or Claude Code's stream-json (rendered on read). */
  outputFormat?: "text" | "claude-stream";
}

export interface RunStatus extends RunRecord {
  state: RunState;
  exitCode?: number;
  reviewStatus?: "ready" | "unsaved" | "no_changes" | "unavailable";
}

/** A run with no pid yet is "starting"; past this it's considered lost. */
const START_GRACE_MS = 10_000;

const runDir = (runId: string): string => join(runsDir(), runId);
const recordFile = (runId: string): string => join(runDir(runId), "run.json");

/** The built CLI runs directly; source runs need a loader resolved outside the worktree. */
function helperCli(dir: string): string {
  if (!import.meta.url.endsWith(".ts")) return fileURLToPath(new URL("./cli.js", import.meta.url));
  const launcher = join(dir, "helper-cli.mjs");
  writeFileSync(launcher, `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))};
register();
await import(${JSON.stringify(new URL("./cli.ts", import.meta.url).href)});
`);
  return launcher;
}

/**
 * The CLI command for each agent. Both run headless and fully autonomous
 * inside their own worktree, reading the task from $CODEC_TASK_FILE.
 * CODEC_AGENT_COMMAND overrides it (used by tests and demos with a fake agent).
 */
export interface CommandHarness {
  access: Access;
  /** Claude: ignore the owner's personal settings and MCP servers. */
  isolated?: boolean;
  /** Claude: $CODEC_RUN_DIR/mcp.json holds this agent's MCP servers. */
  mcp?: boolean;
  /** Codex: `-c <key>=<value>` overrides whose values sit in $CODEC_RUN_DIR/codex-<n>.toml. */
  codexKeys?: string[];
}
export function agentCommand(agent: Agent, opts: { model?: string; instructions?: boolean; accountArgs?: string[]; harness?: CommandHarness } = {}): string {
  const override = process.env.CODEC_AGENT_COMMAND;
  if (override) return override;
  const prompt = `"$(cat "$CODEC_TASK_FILE")"`;
  // Model names are validated (org.ts) to a shell-safe character set.
  const model = opts.model ? `'${opts.model.replace(/'/g, "")}'` : "";
  const h = opts.harness;
  if (agent === "claude") {
    return [
      // Restricted agents can't be asked anything, so tools outside their rules are simply refused.
      !h || h.access === "full" ? "claude --dangerously-skip-permissions -p" : "claude --permission-mode dontAsk -p",
      prompt,
      "--output-format stream-json --verbose", // structured, so Skill tool calls can be detected
      `--settings "$CODEC_RUN_DIR/claude-settings.json"`,
      h?.isolated && "--setting-sources project,local",
      (h?.mcp || h?.isolated) && `--mcp-config "$CODEC_RUN_DIR/mcp.json" --strict-mcp-config`,
      model && `--model ${model}`,
      opts.instructions && `--append-system-prompt "$(cat "$CODEC_RUN_DIR/instructions.md")"`,
    ]
      .filter(Boolean)
      .join(" ");
  }
  const sandbox = h ? codexSandbox(h.access) : "full";
  return [
    "codex" + (opts.accountArgs?.length ? " " + opts.accountArgs.map((arg) => "'" + arg.replace(/'/g, "'\\''") + "'").join(" ") : "") +
      (sandbox === "full" ? " exec --yolo" : ` exec --sandbox ${sandbox} -c approval_policy='"never"'`),
    // Keys are built from validated names; values are read from files, never spliced in.
    ...(h?.codexKeys ?? []).map((key, i) => `-c "${key}=$(cat "$CODEC_RUN_DIR/codex-${i}.toml")"`),
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
# Separate jobs let the wrapper record the result after ending the agent's group.
set -m
umask 077
exec 8> >(exec "$CODEC_NODE" "$CODEC_RUN_DIR/capture.cjs")
capture_pid=$!
exec 1>&8 2>&1
exec 8>&-
agent_pid=
timer_pid=
cleanup_timer() {
  if [ -n "$timer_pid" ]; then
    exec 9>&-
    wait "$timer_pid" 2>/dev/null || true
    timer_pid=
  fi
}
finish() {
  trap '' USR1 TERM INT HUP
  cleanup_timer
  result=$1
  if ! "$CODEC_NODE" "$CODEC_RUN_DIR/strip-attribution.cjs"; then
    if [ "$result" -eq 0 ]; then result=98; fi
  fi
  set -- "$result"
  # Finish writing redacted activity and limit markers before publishing completion.
  exec 1>&- 2>&-
  wait "$capture_pid" 2>/dev/null || true
  printf '%s\\n' "$1" > "$CODEC_RUN_DIR/exit_code.tmp" && mv -f "$CODEC_RUN_DIR/exit_code.tmp" "$CODEC_RUN_DIR/exit_code"
  printf '{"ts":"%s","kind":"run.finish","runId":"%s","project":"%s","agent":"%s","exitCode":%s}\\n' \\
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$CODEC_RUN_ID" "$CODEC_PROJECT" "$CODEC_AGENT" "$1" >> "$CODEC_EVENTS_FILE"
  exit "$1"
}
end_agent() {
  [ -n "$agent_pid" ] || return
  kill -TERM -- "-$agent_pid" 2>/dev/null || true
  for ((i=0; i<50; i++)); do
    kill -0 -- "-$agent_pid" 2>/dev/null || break
    sleep 0.1
  done
  kill -KILL -- "-$agent_pid" 2>/dev/null || true
  wait "$agent_pid" 2>/dev/null || true
}
timeout_run() {
  kill -0 "$agent_pid" 2>/dev/null || return
  trap '' USR1 TERM INT HUP
  cleanup_timer
  if (set -C; printf '%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$CODEC_RUN_DIR/timed_out") 2>/dev/null; then
    printf '{"ts":"%s","kind":"run.timeout","runId":"%s","project":"%s","timeLimitMinutes":%s}\\n' \\
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$CODEC_RUN_ID" "$CODEC_PROJECT" "$CODEC_TIME_LIMIT_MINUTES" >> "$CODEC_EVENTS_FILE"
  fi
  end_agent
  finish 124
}
stop_run() {
  trap '' USR1 TERM INT HUP
  cleanup_timer
  end_agent
  if [ -f "$CODEC_RUN_DIR/timed_out" ]; then finish 124; else finish 143; fi
}
trap stop_run TERM INT HUP
trap timeout_run USR1
if cd "$CODEC_WORKTREE"; then
  bash "$CODEC_RUN_DIR/agent.sh" &
  agent_pid=$!
  printf '%s\\n' "$agent_pid" > "$CODEC_RUN_DIR/agent_group"
  wrapper_pid=$$
  # Fixed fd + Node timer also work with Apple's Bash 3.2. Closing the pipe
  # (including wrapper death) cancels the timer without leaving a sleep behind.
  exec 9> >(exec "$CODEC_NODE" -e '
    const timer = setTimeout(() => {
      try { process.kill(Number(process.argv[1]), "SIGUSR1"); } catch {}
      process.stdin.destroy();
    }, Number(process.argv[2]) * 1000);
    process.stdin.resume();
    process.stdin.on("end", () => clearTimeout(timer));
  ' "$wrapper_pid" "$CODEC_TIME_LIMIT_SECONDS")
  timer_pid=$!
  printf '%s\\n' "$timer_pid" > "$CODEC_RUN_DIR/timer_pid"
  wait "$agent_pid"
  code=$?
  cleanup_timer
  if [ "$code" -eq 0 ]; then
    if changes=$(git status --porcelain --untracked-files=normal); then
      if [ -n "$changes" ]; then
        if git add -A && git -c commit.gpgSign=false commit -m "$CODEC_CHECKPOINT_MESSAGE"; then
          printf '{"autoSaved":true}\\n' > "$CODEC_RUN_DIR/checkpoint.json.tmp"
        else
          printf '{"checkpointError":"checkpoint_save_failed"}\\n' > "$CODEC_RUN_DIR/checkpoint.json.tmp"
        fi
        mv -f "$CODEC_RUN_DIR/checkpoint.json.tmp" "$CODEC_RUN_DIR/checkpoint.json"
      fi
    else
      printf '{"checkpointError":"checkpoint_save_failed"}\\n' > "$CODEC_RUN_DIR/checkpoint.json.tmp"
      mv -f "$CODEC_RUN_DIR/checkpoint.json.tmp" "$CODEC_RUN_DIR/checkpoint.json"
    fi
  fi
else
  code=97
fi
finish "$code"
`;

export interface StartInput {
  project: string;
  /** claude | codex. Required for an unassigned quick run; optional (must match) with a member. */
  agent?: string;
  task: string;
  /** "team/member", or the install-wide "coordinator". */
  member?: string;
  timeLimitMinutes?: number;
  area?: TaskArea;
}

export function startRun(input: StartInput): RunStatus {
  return withLock("accounts", () => startAccountRun(input));
}

function prepareRunHarness(agent: Agent, harness: Harness | undefined, dir: string): CommandHarness | undefined {
  let commandHarness: CommandHarness | undefined;
  if (harness) {
    commandHarness = { access: harness.access };
    if (agent === "claude") {
      commandHarness.isolated = harness.isolated;
      if (harness.mcp.length || harness.isolated) {
        // MCP env values can be tokens: keep the file private to the owner.
        writeFileSync(join(dir, "mcp.json"), JSON.stringify(claudeMcpConfig(harness), null, 2), { mode: 0o600 });
        commandHarness.mcp = true;
      }
    } else {
      const pairs = codexOverrides(harness);
      // A sandboxed Codex agent still needs to write Codec's inbox to message and report.
      if (codexSandbox(harness.access) === "workspace-write") pairs.push(["sandbox_workspace_write.writable_roots", JSON.stringify([codecHome()])]);
      pairs.forEach(([, value], i) => writeFileSync(join(dir, `codex-${i}.toml`), value, { mode: 0o600 }));
      commandHarness.codexKeys = pairs.map(([key]) => key);
    }
  }
  if (agent === "claude") {
    const permissions = harness ? claudePermissions(harness) : undefined;
    writeJsonAtomic(join(dir, "claude-settings.json"), {
      includeCoAuthoredBy: false,
      attribution: { commit: "", pr: "" },
      ...(permissions ? { permissions } : {}),
    });
  }
  return commandHarness;
}

function startAccountRun(input: StartInput): RunStatus {
  if (!input.task || !input.task.trim()) throw new CodecError("missing_task", "--task is required");
  const requestedLimit = checkTimeLimit(input.timeLimitMinutes);
  const project = getProject(input.project);
  if (!project) throw new CodecError("project_not_found", `no project named "${input.project}" (see: codec project list)`, {}, 404);

  let who: ResolvedMember | undefined;
  const coordinator = input.member === "coordinator" ? requireCoordinator() : undefined;
  if (coordinator) {
    // startRun holds the install-wide accounts lock through launch and record creation.
    if (listRuns({ state: "running" }).some((run) => helperRef(run) === "coordinator")) {
      throw new CodecError("coordinator_busy", S.errors.coordinator_busy, {}, 409);
    }
    if (input.agent && input.agent !== coordinator.tool) {
      const params = { member: S.coordinator.name, tool: S.setup[coordinator.tool], requested: input.agent };
      throw new CodecError("tool_mismatch", wording(S.errors.tool_mismatch, params), params);
    }
  } else if (input.member) {
    const ref = parseMemberRef(input.member);
    who = resolveMember(ref.team, ref.member);
    if (!who.projects.includes(project.name)) {
      throw new CodecError("project_not_assigned", `team ${who.team} doesn't work on ${project.name} (its projects: ${who.projects.join(", ") || "none"})`, { team: who.team, project: project.name });
    }
    if (input.agent && input.agent !== who.tool) {
      throw new CodecError("tool_mismatch", `${who.team}/${who.member} uses ${who.tool}, not ${input.agent}`, { member: who.member, tool: who.tool === "claude" ? S.setup.claude : S.setup.codex, requested: input.agent === "claude" ? S.setup.claude : input.agent === "codex" ? S.setup.codex : input.agent });
    }
  } else if (!input.agent) {
    throw new CodecError("missing_tool", "choose a team member (--member <team>/<member>) or a tool for an unassigned worker (--agent claude|codex)");
  }
  const agentName = coordinator?.tool ?? who?.tool ?? input.agent!;
  if (!(AGENTS as readonly string[]).includes(agentName)) {
    throw new CodecError("invalid_tool", `unknown agent "${agentName}" (use: ${AGENTS.join(", ")})`, { name: agentName });
  }
  const agent = agentName as Agent;
  const account = resolveAccount(agent, { helper: input.member, team: who?.team, project: project.name });
  const environment = accountEnvironment(account);
  prepareAccount(account);
  if (!existsSync(project.path)) throw new CodecError("project_missing", `project path no longer exists: ${project.path}`, { path: project.path });

  const timeLimitMinutes = (coordinator ? coordinator.timeLimitMinutes : requestedLimit ?? who?.timeLimitMinutes) ?? DEFAULT_TIME_LIMIT_MINUTES;
  const startedAt = new Date().toISOString();
  const deadline = new Date(Date.parse(startedAt) + timeLimitMinutes * 60_000).toISOString();
  const runId = "run-" + randomBytes(4).toString("hex");
  const branch = `codec/${runId}`;
  const worktree = join(worktreesDir(), project.name, runId);
  const dir = runDir(runId);

  // Worktree creation touches the repo's shared git metadata; serialize it
  // per project so parallel `codec run` calls on one repo can't collide.
  const { baseSha, identity } = withLock(`project-${project.name}`, () => {
    const head = git(project.path, ["rev-parse", "HEAD"]);
    if (!head.ok) throw new CodecError("tracking_failed", `cannot read HEAD of ${project.path}: ${head.err}`);
    const identity = checkpointIdentity(project.path);
    if (!identity) throw new CodecError("identity_missing", S.errors.identity_missing, {}, 409);
    mkdirSync(join(worktreesDir(), project.name), { recursive: true });
    const add = git(project.path, ["worktree", "add", "-q", "-b", branch, worktree, head.out]);
    if (!add.ok) throw new CodecError("workspace_failed", `git worktree add failed: ${add.err}`);
    return { baseSha: head.out, identity };
  });

  mkdirSync(dir, { recursive: true });
  // A team agent brings its own harness; quick helpers and the coordinator keep full access.
  const commandHarness = prepareRunHarness(agent, who?.harness, dir);
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
  const instructions = instructionsText(who, agent, skills, !!coordinator);
  if (instructions) {
    writeFileSync(join(dir, "instructions.md"), instructions);
    // A TOML basic string for `codex -c developer_instructions=...`; JSON string escapes are valid TOML.
    writeFileSync(join(dir, "instructions.toml"), JSON.stringify(instructions));
  }
  const model = coordinator?.model ?? who?.model;
  const command = agentCommand(agent, { model, instructions: !!instructions, accountArgs: accountCliArgs(account), harness: commandHarness });
  writeFileSync(join(dir, "task.txt"), input.task);
  writeFileSync(join(dir, "agent.sh"), command + "\n");
  writeFileSync(join(dir, "run.sh"), WRAPPER);
  writeFileSync(join(dir, "strip-attribution.cjs"), COMMIT_ATTRIBUTION_SCRIPT);
  writeFileSync(join(dir, "capture.cjs"), ACTIVITY_SCRIPT);
  const cli = helperCli(dir);

  const record: RunRecord = {
    account: { id: account.id, name: account.name },
    runId,
    project: project.name,
    projectPath: project.path,
    agent,
    task: redactSecrets(input.task),
    branch,
    worktree,
    baseSha,
    command,
    startedAt,
    timeLimitMinutes,
    deadline,
    ...(input.area ? { area: input.area } : {}),
    team: who?.team,
    member: coordinator ? "coordinator" : who?.member,
    specialist: who?.specialist,
    specialty: who?.specialty,
    model,
    skills,
    outputFormat: agent === "claude" ? "claude-stream" : "text",
  };
  writeJsonAtomic(recordFile(runId), redactValue(record));
  try {
    if (input.member) receiveMessages(input.member, runId);
  } catch (error) {
    // Delivery failed before launch; don't leave a task looking like it is starting.
    withLock(`run-${runId}`, () => {
      writeJsonAtomic(recordFile(runId), redactValue({ ...record, lostAt: new Date().toISOString() }));
    });
    throw error;
  }

  const log = openSync(join(dir, "output.log"), "a", 0o600);
  let pid: number | undefined;
  try {
    const child = spawn("bash", [join(dir, "run.sh")], {
      cwd: worktree,
      detached: true, // own process group: survives codec exiting, stoppable as a unit
      stdio: ["ignore", log, log],
      env: {
        ...environment,
        ...identityEnvironment(identity),
        CODEC_TIME_LIMIT_MINUTES: String(timeLimitMinutes),
        CODEC_TIME_LIMIT_SECONDS: String(Math.max(0.001, (Date.parse(deadline) - Date.now()) / 1000)),
        CODEC_RUN_ID: runId,
        CODEC_PROJECT: project.name,
        CODEC_AGENT: agent,
        CODEC_NODE: helperNodeExecutable(),
        CODEC_CLI: cli,
        CODEC_WORKTREE: worktree,
        CODEC_RUN_DIR: dir,
        CODEC_TASK_FILE: join(dir, "task.txt"),
        CODEC_CHECKPOINT_MESSAGE: wording(S.tasks.checkpointMessage, { id: runId.slice(4), task: redactSecrets(input.task.split(/\r?\n/, 1)[0].trim().slice(0, 100)) }),
        CODEC_EVENTS_FILE: eventsFile(),
      },
    });
    pid = child.pid;
    child.unref();
  } finally {
    closeSync(log);
  }
  if (!pid) throw new CodecError("spawn_failed", `failed to spawn agent for ${runId} (see ${join(dir, "output.log")})`, { tool: agent === "claude" ? S.setup.claude : S.setup.codex });

  withLock(`run-${runId}`, () => {
    writeJsonAtomic(recordFile(runId), redactValue({ ...readRecord(runId)!, pid }));
  });
  // Verified registration (from the hive): never report a launch the
  // status view can't see. If the record didn't persist, kill and fail.
  const check = readRecord(runId);
  if (!check || check.pid !== pid) {
    killGroup(pid, "SIGKILL");
    throw new CodecError("persist_failed", `run ${runId} failed to persist — launch aborted`);
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
 * Is this run's wrapper still alive? On Linux and macOS, verify its command
 * and state to guard against reused process ids and zombies.
 */
function processAlive(rec: RunRecord): boolean {
  if (!rec.pid) return false;
  return isOurProcess(rec.pid, join(runDir(rec.runId), "run.sh"));
}

function deriveState(rec: RunRecord, exitCode: number | undefined): RunState {
  if (existsSync(join(runDir(rec.runId), "timed_out"))) return "timed_out";
  if (rec.stoppedAt) return "stopped";
  if (exitCode !== undefined) return exitCode === 0 ? "done" : "failed";
  if (rec.lostAt) return "failed";
  if (processAlive(rec)) return "running";
  if (!rec.pid && Date.now() - Date.parse(rec.startedAt) < START_GRACE_MS) return "running";
  return "failed";
}

/** Only a full task id from the wrapper can identify the calling helper. */
export function currentHelperRun(): RunRecord & { member: string } {
  const runId = process.env.CODEC_RUN_ID;
  const run = runId && /^run-[a-f0-9]{8}$/.test(runId) ? readRecord(runId) : undefined;
  if (!run || !run.member || !helperRef(run) || deriveState(run, readExitCode(run.runId)) !== "running") {
    throw new CodecError("helper_task_required", S.errors.helper_task_required);
  }
  return { ...run, team: run.team, member: run.member };
}

/** Reports describe the helper's work; the wrapper still owns task completion. */
export function reportHelperStatus(state: string, note = ""): HelperStatus {
  const run = currentHelperRun();
  if (state !== "progress" && state !== "stuck" && state !== "done") {
    throw new CodecError("invalid_helper_status", S.errors.invalid_helper_status);
  }
  if (state === "stuck" && !note.trim()) {
    throw new CodecError("missing_stuck_note", S.errors.missing_stuck_note);
  }
  return withLock(`run-${run.runId}`, () => {
    const fresh = currentHelperRun();
    const helperStatus: HelperStatus = { state, note: redactSecrets(note), at: new Date().toISOString() };
    writeJsonAtomic(recordFile(run.runId), { ...fresh, helperStatus });
    return helperStatus;
  });
}

/** Merge wrapper results into the latest record while holding the run's lock. */
function updateRecord(runId: string, patch: Partial<RunRecord>): RunRecord {
  return withLock(`run-${runId}`, () => {
    const updated = { ...readRecord(runId)!, ...patch };
    writeJsonAtomic(recordFile(runId), updated);
    return updated;
  });
}

/** Store the owner's decision without overwriting concurrent run metadata. */
export function recordReview(runId: string, reviewed: RunReview): RunStatus {
  updateRecord(runId, { reviewed });
  return readRunStatus(runId)!;
}

function reviewStatusOf(rec: RunRecord, state: RunState): RunStatus["reviewStatus"] {
  if (state === "running" || rec.cleanedAt || !existsSync(rec.worktree)) return undefined;
  // Always recheck: a helper or the owner can leave work after the process exits.
  const status = git(rec.worktree, ["status", "--porcelain", "--untracked-files=normal"]);
  if (!status.ok) return "unavailable";
  if (status.out) return "unsaved";
  if (state !== "done") return undefined;
  const checkpoints = git(rec.worktree, ["rev-list", "--count", `${rec.baseSha}..HEAD`]);
  if (!checkpoints.ok) return "unavailable";
  return Number(checkpoints.out) > 0 ? "ready" : "no_changes";
}

/** Inspect a task without recovery, record updates, or process termination. */
export function readRunStatus(runId: string): RunStatus | undefined {
  if (!/^run-[a-f0-9]{8}$/.test(runId)) return undefined;
  const rec = readRecord(runId);
  if (!rec) return undefined;
  const exitCode = readExitCode(runId);
  const state = deriveState(rec, exitCode);
  return { ...rec, state, exitCode, reviewStatus: reviewStatusOf(rec, state) };
}

export function getRunStatus(runId: string): RunStatus | undefined {
  let rec = readRecord(runId);
  if (!rec) return undefined;
  if (!rec.limitHit && existsSync(join(runDir(runId), "limit_hit"))) {
    rec = updateRecord(runId, { limitHit: true });
  }
  const attribution = readJson<{ coAuthorStripped?: number }>(join(runDir(runId), "attribution.json"), {});
  if (attribution.coAuthorStripped && attribution.coAuthorStripped !== rec.coAuthorStripped) {
    rec = updateRecord(runId, attribution);
  }
  // The standalone wrapper writes this result even while Codec is closed.
  const checkpoint = readJson<{ autoSaved?: boolean; checkpointError?: "checkpoint_save_failed" }>(join(runDir(runId), "checkpoint.json"), {});
  if ((checkpoint.autoSaved && !rec.autoSaved) || (checkpoint.checkpointError && !rec.checkpointError)) {
    rec = updateRecord(runId, checkpoint);
  }
  if (!rec.actualModel) {
    let model: string | undefined;
    try {
      const raw = readFileSync(join(runDir(runId), "output.log"), "utf-8");
      model = rec.agent === "codex" ? modelFromCodexOutput(raw) : rec.outputFormat === "claude-stream" ? modelFromClaudeStream(raw) : undefined;
    }
    catch { /* The helper may not have opened its activity file yet. */ }
    if (model) rec = withLock(`run-${runId}`, () => {
      const fresh = readRecord(runId)!;
      if (fresh.actualModel) return fresh;
      const updated = { ...fresh, actualModel: model };
      writeJsonAtomic(recordFile(runId), updated);
      return updated;
    });
  }
  // Also recover overdue runs whose wrapper was lost while the machine slept.
  if (rec.timeLimitMinutes !== undefined && rec.deadline && Date.now() > Date.parse(rec.deadline) + 30_000 &&
      !rec.stoppedAt && !rec.lostAt && readExitCode(runId) === undefined &&
      !existsSync(join(runDir(runId), "timed_out"))) {
    withLock(`run-${runId}`, () => {
      const fresh = readRecord(runId)!;
      if (fresh.stoppedAt || fresh.lostAt || readExitCode(runId) !== undefined || existsSync(join(runDir(runId), "timed_out"))) return;
      try {
        writeFileSync(join(runDir(runId), "timed_out"), new Date().toISOString() + "\n", { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
        throw error;
      }
      terminateRun(fresh);
      logEvent("run.timeout", { runId, project: fresh.project, timeLimitMinutes: fresh.timeLimitMinutes });
    });
  }
  let exitCode = readExitCode(runId);
  let state = deriveState(rec, exitCode);

  // Died without writing an exit code: record that once, under the run's lock.
  if (state === "failed" && exitCode === undefined && !rec.lostAt) {
    rec = withLock(`run-${runId}`, () => {
      const fresh = readRecord(runId)!;
      if (fresh.lostAt || fresh.stoppedAt || readExitCode(runId) !== undefined) return fresh;
      terminateRun(fresh);
      const updated = { ...fresh, lostAt: new Date().toISOString() };
      writeJsonAtomic(recordFile(runId), updated);
      logEvent("run.lost", { runId, project: fresh.project, pid: fresh.pid });
      return updated;
    });
    exitCode = readExitCode(runId);
    state = deriveState(rec, exitCode);
  }
  const reviewStatus = reviewStatusOf(rec, state);
  return { ...rec, state, exitCode, reviewStatus };
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
  if (matches.length > 1) throw new CodecError("run_not_found", `"${ref}" matches several runs: ${matches.join(", ")}`, {}, 404);
  throw new CodecError("run_not_found", `no run "${ref}" (see: codec status)`, {}, 404);
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

/** Confirm a saved group still contains this run before signaling it after a restart. */
function ownsAgentGroup(rec: RunRecord, group: number): boolean {
  return ownsProcessGroup(group, runDir(rec.runId));
}

/** End the wrapper and its separate agent/timer jobs, including after wrapper loss. */
function terminateRun(rec: RunRecord): void {
  const groups = ["agent_group"].flatMap((name) => {
    try {
      const id = Number(readFileSync(join(runDir(rec.runId), name), "utf-8").trim());
      return Number.isSafeInteger(id) && id > 1 && ownsAgentGroup(rec, id) ? [id] : [];
    } catch { return []; }
  });
  groups.forEach((id) => killGroup(id, "SIGTERM"));
  if (rec.pid && processAlive(rec)) killGroup(rec.pid, "SIGTERM");
  const until = Date.now() + 5000;
  const groupsExist = () => groups.some((id) => ownsAgentGroup(rec, id));
  while (((rec.pid && processAlive(rec)) || groupsExist()) && Date.now() < until) sleepSync(50);
  // Descendants can outlive their parent, so escalation must not depend on the wrapper.
  groups.filter((id) => ownsAgentGroup(rec, id)).forEach((id) => killGroup(id, "SIGKILL"));
  if (rec.pid && processAlive(rec)) killGroup(rec.pid, "SIGKILL");
  // Give the operating system a chance to finish ending the remaining jobs.
  if (groups.length) sleepSync(50);
}

/** Stop a running agent (whole process group: wrapper, agent and children). */
export function stopRun(ref: string): RunStatus {
  const run = findRun(ref);
  if (run.state !== "running") throw new CodecError("run_not_running", `${run.runId} is not running (state: ${run.state})`);
  terminateRun(run);
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
  if (run.state === "running") throw new CodecError("run_busy", `${run.runId} is still running — stop it first`);
  if (run.cleanedAt) throw new CodecError("already_cleaned", `${run.runId} was already cleaned`);
  const repo = run.projectPath;

  withLock(`project-${run.project}`, () => {
    if (existsSync(run.worktree)) {
      if (!opts.force) {
        const status = git(run.worktree, ["status", "--porcelain", "--untracked-files=all"]);
        if (!status.ok) throw new CodecError("workspace_remove_failed", status.err);
        if (status.out) throw new CodecError("uncommitted_changes", `unsaved changes in ${run.worktree}`);
      }
      const args = ["worktree", "remove", ...(opts.force ? ["--force"] : []), run.worktree];
      const r = git(repo, args);
      if (!r.ok) {
        throw new CodecError("workspace_remove_failed", `could not remove worktree: ${r.err}`,);
      }
    }
    git(repo, ["worktree", "prune"]);
    if (opts.deleteBranch) {
      if (git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${run.branch}`]).ok) {
        const b = git(repo, ["branch", "-D", run.branch]);
        if (!b.ok) throw new CodecError("branch_remove_failed", `could not delete branch: ${b.err}`);
      }
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
  return redactSecrets(text.split("\n").slice(-lines - 1).join("\n"));
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
    return skillCallsFromClaudeStream(raw).map((name) => ({ name, how: "detected" as const, evidence: S.wording.skillCall }));
  }
  const out: SkillUse[] = [];
  for (const s of run.skills ?? []) {
    const esc = s.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`skills/${esc}/SKILL\\.md`).test(raw)) {
      out.push({ name: s.name, how: "guess", evidence: S.wording.skillFile });
    } else if (new RegExp(`(^|[^A-Za-z0-9-])${esc}([^A-Za-z0-9-]|$)`).test(raw)) {
      out.push({ name: s.name, how: "guess", evidence: S.wording.skillMention });
    }
  }
  return out;
}

// ---------- removals that depend on running agents ----------

function refuseIfRunning(what: string, running: RunStatus[], code: "project_busy" | "team_busy" | "member_busy"): void {
  if (running.length) {
    const error = new CodecError(code, `${what} has ${running.length} running agent(s): ${running.map((r) => r.runId).join(", ")} — stop them first`, { count: running.length });
    error.links = running.map((run) => ({ id: run.runId, task: run.task }));
    throw error;
  }
}

/** Remove a team, refusing while any of its members is working. */
export function removeTeamChecked(name: string): Team {
  if (!getTeam(name)) throw new CodecError("team_not_found", `no team named "${name}"`, { name }, 404);
  refuseIfRunning(`team ${name}`, listRuns({ state: "running" }).filter((r) => r.team === name), "team_busy");
  const team = deleteTeam(name);
  clearAccountChoices("team", name);
  return team;
}

/** Remove a team member, refusing while it is working. */
export function removeMemberChecked(team: string, member: string): Member {
  refuseIfRunning(
    `${team}/${member}`,
    listRuns({ state: "running" }).filter((r) => r.team === team && r.member === member),
    "member_busy",
  );
  const removed = deleteMember(team, member);
  clearAccountChoices("helper", `${team}/${member}`);
  return removed;
}

/**
 * Unregister a project, refusing while agents are still running on it.
 * Shared by `codec project remove` and the dashboard.
 */
export function removeProjectChecked(name: string): Project {
  if (!getProject(name)) throw new CodecError("project_not_found", `no project named "${name}"`, {}, 404);
  refuseIfRunning(name, listRuns({ project: name, state: "running" }), "project_busy");
  const p = removeProject(name);
  dropProjectFromTeams(name);
  clearAccountChoices("project", name);
  return p;
}
