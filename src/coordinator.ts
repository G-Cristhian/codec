/** One coordinator for the install; cross-team helper messages go through it via PM helpers. */
import { CodecError } from "./errors.js";
import { checkTimeLimit } from "./limits.js";
import { postMessage } from "./messages.js";
import { cleanModel, listTeams, resolveMember } from "./org.js";
import { getProject } from "./registry.js";
import { listRuns, startRun } from "./runs.js";
import { coordinatorFile, readJson, withLock, writeJsonAtomic } from "./store.js";
import { S, wording } from "./strings.js";
import { checkTool, type Agent } from "./tools.js";

export interface Coordinator {
  tool: Agent;
  model?: string;
  timeLimitMinutes?: number;
  createdAt: string;
}

export function getCoordinator(): Coordinator | undefined {
  return readJson<Coordinator | undefined>(coordinatorFile(), undefined);
}

export function requireCoordinator(): Coordinator {
  const settings = getCoordinator();
  if (!settings) throw new CodecError("coordinator_not_setup", S.errors.coordinator_not_setup);
  return settings;
}

export function setupCoordinator(input: { tool: string; model?: string; timeLimitMinutes?: number }): Coordinator {
  const tool = checkTool(input.tool);
  const model = cleanModel(input.model);
  const timeLimitMinutes = checkTimeLimit(input.timeLimitMinutes);
  return withLock("coordinator", () => {
    const settings = { tool, model, timeLimitMinutes, createdAt: getCoordinator()?.createdAt ?? new Date().toISOString() };
    writeJsonAtomic(coordinatorFile(), settings);
    return settings;
  });
}

/** Only the member name counts; a team or role named PM grants no authority. */
export function isPmHelper(ref: string): boolean {
  const parts = ref.split("/");
  return parts.length === 2 && !!parts[0] && /pm/i.test(parts[1]);
}

export function helperRef(run: { team?: string; member?: string }): string | undefined {
  return run.member === "coordinator" && !run.team ? "coordinator"
    : run.team && run.member ? `${run.team}/${run.member}` : undefined;
}

export function assignByRole(input: { project: string; role: string; task: string }): { helper: string; runId: string } {
  requireCoordinator();
  if (!getProject(input.project)) throw new CodecError("project_not_found", S.errors.project_not_found, {}, 404);
  if (!input.task.trim()) throw new CodecError("missing_task", S.errors.missing_task);
  // Serialize assignments so two commands from the coordinator cannot pick the same free helper.
  return withLock("coordinator-assign", () => {
    const role = input.role.trim().toLowerCase();
    const clones = listTeams().filter((team) => team.projects.includes(input.project))
      .flatMap((team) => team.members.filter((member) => member.kind === "clone")
        .map((member) => resolveMember(team.name, member.name)));
    const exact = clones.filter((member) => member.specialist?.toLowerCase() === role);
    const candidates = !role ? [] : exact.length ? exact
      : clones.filter((member) => member.specialty?.toLowerCase().includes(role));
    if (!candidates.length) throw new CodecError("coordinator_no_role", wording(S.errors.coordinator_no_role, { role: input.role }), { role: input.role });
    const busy = new Set(listRuns({ state: "running" }).map(helperRef));
    const chosen = candidates.find((member) => !busy.has(helperRef(member)));
    if (!chosen) throw new CodecError("coordinator_role_busy", wording(S.errors.coordinator_role_busy, { role: input.role }), { role: input.role });
    const member = helperRef(chosen)!;
    postMessage({ from: "coordinator", to: member, body: wording(S.coordinator.assigned, { task: input.task }) });
    const run = startRun({ project: input.project, member, task: input.task });
    return { helper: member, runId: run.runId };
  });
}
