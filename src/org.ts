/**
 * org.ts — specialists, teams and team members.
 *
 *   specialist  an agent template: specialty, tool, model, standing
 *               instructions and skills ($CODEC_HOME/specialists.json)
 *   team        a name, the projects it works on, and its members
 *               ($CODEC_HOME/teams.json)
 *   member      either a clone of a specialist (follows the specialist's
 *               settings and skills, plus extra skills of its own) or a
 *               plain worker (tool + optional skills, no specialty)
 *
 * Every write happens under the shared "org" lock (the skill library uses it
 * too), so concurrent commands can't lose each other's changes.
 *
 * Rules that need to know about running agents (removing a team or member
 * while it works) live in runs.ts, next to the run engine.
 */

import { S } from "./strings.js";
import { CodecError, suggestName } from "./errors.js";
import { checkTimeLimit } from "./limits.js";
import { checkMessageLimit } from "./message-limits.js";
import { getProject, PROJECT_NAME_RE } from "./registry.js";
import { logEvent } from "./events.js";
import { deleteSkillFolder, getSkill } from "./skills.js";
import { readJson, specialistsFile, teamsFile, withLock, writeJsonAtomic } from "./store.js";
import { checkTool, type Agent } from "./tools.js";

export interface Specialist {
  name: string;
  specialty: string;
  tool: Agent;
  timeLimitMinutes?: number;
  model?: string;
  instructions: string;
  skills: string[];
  createdAt: string;
}

export interface Member {
  name: string;
  kind: "clone" | "worker";
  specialist?: string; // clones only
  tool?: Agent; // workers only (clones follow their specialist)
  timeLimitMinutes?: number;
  model?: string; // workers only
  skills: string[]; // the member's own skills (for clones: extras on top of the specialist's)
  addedAt: string;
}

export interface Team {
  name: string;
  messageLimit?: number;
  projects: string[];
  members: Member[];
  createdAt: string;
}

export type SkillSource = "specialist" | "member" | "project";

/** Everything needed to start a run as a given team member. */
export interface ResolvedMember {
  team: string;
  member: string;
  kind: Member["kind"];
  specialist?: string;
  specialty?: string;
  tool: Agent;
  timeLimitMinutes?: number;
  model?: string;
  instructions: string;
  skills: { name: string; source: Exclude<SkillSource, "project"> }[];
  projects: string[];
}

const loadSpecialists = (): Specialist[] =>
  readJson<{ specialists: Specialist[] }>(specialistsFile(), { specialists: [] }).specialists;
const saveSpecialists = (specialists: Specialist[]) => writeJsonAtomic(specialistsFile(), { specialists });
const loadTeams = (): Team[] => readJson<{ teams: Team[] }>(teamsFile(), { teams: [] }).teams;
const saveTeams = (teams: Team[]) => writeJsonAtomic(teamsFile(), { teams });

function checkName(kind: string, name: string | undefined, taken: string[]): string {
  const n = (name ?? "").trim();
  if (!PROJECT_NAME_RE.test(n)) throw new CodecError("invalid_name", `invalid ${kind} name "${n}" (letters, digits, . _ - only)`, {}, 400, suggestName(n, taken));
  return n;
}

function checkSkills(skills: string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of skills ?? []) {
    const s = raw.trim();
    if (!s) continue;
    if (!getSkill(s)) throw new CodecError("invalid_skill", `no skill named "${s}" in the library (see: codec skill list)`, { name: s });
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

export function cleanModel(model: string | undefined): string | undefined {
  const m = model?.trim();
  if (!m) return undefined;
  if (!/^[A-Za-z0-9._:\/\[\]-]{1,100}$/.test(m)) throw new CodecError("invalid_model", `invalid model name "${m}"`, { name: m });
  return m;
}

// ---------- specialists ----------

export function listSpecialists(): Specialist[] {
  return loadSpecialists();
}

export function getSpecialist(name: string): Specialist | undefined {
  return loadSpecialists().find((s) => s.name === name);
}

export interface SpecialistInput {
  name?: string;
  specialty?: string;
  tool?: string;
  timeLimitMinutes?: number;
  model?: string;
  instructions?: string;
  skills?: string[];
}

export function addSpecialist(input: SpecialistInput): Specialist {
  const name = checkName("specialist", input.name, loadSpecialists().map((s) => s.name));
  const spec: Specialist = {
    name,
    specialty: (input.specialty ?? "").trim(),
    tool: checkTool(input.tool ?? ""),
    model: cleanModel(input.model),
    timeLimitMinutes: checkTimeLimit(input.timeLimitMinutes),
    instructions: (input.instructions ?? "").trim(),
    skills: checkSkills(input.skills),
    createdAt: new Date().toISOString(),
  };
  if (!spec.specialty) throw new CodecError("missing_specialty", "a specialist needs a specialty (e.g. tester)");
  withLock("org", () => {
    const all = loadSpecialists();
    if (all.some((s) => s.name === name)) throw new CodecError("specialist_exists", `a specialist named "${name}" already exists`, { name });
    all.push(spec);
    saveSpecialists(all);
  });
  logEvent("specialist.add", { specialist: name });
  return spec;
}

/** Change a specialist. Fields left undefined are kept. Clones follow automatically. */
export function editSpecialist(name: string, patch: Omit<SpecialistInput, "name">): Specialist {
  const updated = withLock("org", () => {
    const all = loadSpecialists();
    const i = all.findIndex((s) => s.name === name);
    if (i === -1) throw new CodecError("specialist_not_found", `no specialist named "${name}"`, { name }, 404);
    const cur = all[i];
    const next: Specialist = {
      ...cur,
      timeLimitMinutes: patch.timeLimitMinutes !== undefined ? checkTimeLimit(patch.timeLimitMinutes) : cur.timeLimitMinutes,
      specialty: patch.specialty !== undefined ? patch.specialty.trim() : cur.specialty,
      tool: patch.tool !== undefined ? checkTool(patch.tool) : cur.tool,
      model: patch.model !== undefined ? cleanModel(patch.model) : cur.model,
      instructions: patch.instructions !== undefined ? patch.instructions.trim() : cur.instructions,
      skills: patch.skills !== undefined ? checkSkills(patch.skills) : cur.skills,
    };
    if (!next.specialty) throw new CodecError("missing_specialty", "a specialist needs a specialty (e.g. tester)");
    all[i] = next;
    saveSpecialists(all);
    return next;
  });
  logEvent("specialist.edit", { specialist: name });
  return updated;
}

/** Every team member cloned from this specialist. */
export function clonesOf(specialist: string): { team: string; member: string }[] {
  return loadTeams().flatMap((t) =>
    t.members.filter((m) => m.kind === "clone" && m.specialist === specialist).map((m) => ({ team: t.name, member: m.name })),
  );
}

/** Refused while any team still has a clone of it (remove the clones first). */
export function removeSpecialist(name: string): Specialist {
  const removed = withLock("org", () => {
    const all = loadSpecialists();
    const i = all.findIndex((s) => s.name === name);
    if (i === -1) throw new CodecError("specialist_not_found", `no specialist named "${name}"`, { name }, 404);
    const clones = clonesOf(name);
    if (clones.length) {
      throw new CodecError("specialist_in_use", `${name} still has ${clones.length} clone(s) in teams: ${clones.map((c) => `${c.team}/${c.member}`).join(", ")} — remove them first`, { name, count: clones.length, list: clones.map((c) => `${c.member} (${c.team} team)`).join(", ") });
    }
    const [s] = all.splice(i, 1);
    saveSpecialists(all);
    return s;
  });
  logEvent("specialist.remove", { specialist: name });
  return removed;
}

// ---------- teams ----------

export function listTeams(): Team[] {
  return loadTeams();
}

export function getTeam(name: string): Team | undefined {
  return loadTeams().find((t) => t.name === name);
}

function checkProjects(projects: string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of projects ?? []) {
    const p = raw.trim();
    if (!p) continue;
    if (!getProject(p)) throw new CodecError("project_not_found", `no project named "${p}" (see: codec project list)`, {}, 404);
    if (!out.includes(p)) out.push(p);
  }
  if (!out.length) throw new CodecError("missing_project", "a team needs at least one project");
  return out;
}

export function addTeam(input: { name?: string; projects?: string[] }): Team {
  const name = checkName("team", input.name, loadTeams().map((t) => t.name));
  const team: Team = { name, projects: checkProjects(input.projects), members: [], createdAt: new Date().toISOString() };
  withLock("org", () => {
    const all = loadTeams();
    if (all.some((t) => t.name === name)) throw new CodecError("team_exists", `a team named "${name}" already exists`, { name });
    all.push(team);
    saveTeams(all);
  });
  logEvent("team.add", { team: name, projects: team.projects });
  return team;
}

export function setTeamProjects(name: string, projects: string[]): Team {
  const list = checkProjects(projects);
  const t = withLock("org", () => {
    const all = loadTeams();
    const team = all.find((x) => x.name === name);
    if (!team) throw new CodecError("team_not_found", `no team named "${name}"`, { name }, 404);
    team.projects = list;
    saveTeams(all);
    return team;
  });
  logEvent("team.edit", { team: name, projects: list });
  return t;
}

export function setTeamMessageLimit(name: string, value: number | undefined): Team {
  const messageLimit = checkMessageLimit(value);
  const updated = withLock("org", () => {
    const all = loadTeams();
    const team = all.find((t) => t.name === name);
    if (!team) throw new CodecError("team_not_found", `no team named "${name}"`, { name }, 404);
    if (messageLimit === undefined) delete team.messageLimit;
    else team.messageLimit = messageLimit;
    saveTeams(all);
    return team;
  });
  logEvent("team.edit", { team: name, messageLimit: messageLimit ?? null });
  return updated;
}

/** Unchecked removal — use removeTeamChecked (runs.ts), which refuses while members work. */
export function deleteTeam(name: string): Team {
  const removed = withLock("org", () => {
    const all = loadTeams();
    const i = all.findIndex((t) => t.name === name);
    if (i === -1) throw new CodecError("team_not_found", `no team named "${name}"`, { name }, 404);
    const [t] = all.splice(i, 1);
    saveTeams(all);
    return t;
  });
  logEvent("team.remove", { team: name });
  return removed;
}

/** A project left Codec: take it off every team's list. */
export function dropProjectFromTeams(project: string): void {
  withLock("org", () => {
    const all = loadTeams();
    let changed = false;
    for (const t of all) {
      if (t.projects.includes(project)) {
        t.projects = t.projects.filter((p) => p !== project);
        changed = true;
      }
    }
    if (changed) saveTeams(all);
  });
}

export interface MemberInput {
  name?: string;
  specialist?: string; // set → clone of that specialist
  tool?: string; // plain worker
  timeLimitMinutes?: number;
  model?: string;
  skills?: string[];
}

export function addMember(teamName: string, input: MemberInput): Member {
  const skills = checkSkills(input.skills);
  const timeLimitMinutes = checkTimeLimit(input.timeLimitMinutes);
  const member = withLock("org", () => {
    const all = loadTeams();
    const team = all.find((t) => t.name === teamName);
    if (!team) throw new CodecError("team_not_found", `no team named "${teamName}"`, { name: teamName }, 404);
    let m: Member;
    if (input.specialist) {
      const spec = loadSpecialists().find((s) => s.name === input.specialist);
      if (!spec) throw new CodecError("specialist_not_found", `no specialist named "${input.specialist}"`, { name: input.specialist }, 404);
      if (input.tool && input.tool !== spec.tool) {
        throw new CodecError("role_tool_mismatch", `a clone uses its specialist's tool (${spec.tool}) — edit the specialist to change it`, { name: spec.name, tool: spec.tool === "claude" ? S.setup.claude : S.setup.codex });
      }
      let name = input.name?.trim();
      if (!name) {
        // tester-1, tester-2, ... first free number in this team
        for (let n = 1; ; n++) if (!team.members.some((x) => x.name === `${spec.name}-${n}`)) {
          name = `${spec.name}-${n}`;
          break;
        }
      }
      m = { name: checkName("member", name, team.members.map((m) => m.name)), kind: "clone", specialist: spec.name, skills, addedAt: new Date().toISOString() };
    } else {
      const tool = checkTool(input.tool ?? "");
      let name = input.name?.trim();
      if (!name) {
        for (let n = 1; ; n++) if (!team.members.some((x) => x.name === `${tool}-worker-${n}`)) {
          name = `${tool}-worker-${n}`;
          break;
        }
      }
      m = {
        name: checkName("member", name, team.members.map((m) => m.name)),
        kind: "worker",
        tool,
        model: cleanModel(input.model),
        skills,
        addedAt: new Date().toISOString(),
      };
    }
    if (team.members.some((x) => x.name === m.name)) throw new CodecError("member_exists", `team ${teamName} already has a member named "${m.name}"`, { team: teamName, name: m.name });
    m.timeLimitMinutes = timeLimitMinutes;
    team.members.push(m);
    saveTeams(all);
    return m;
  });
  logEvent("member.add", { team: teamName, member: member.name, kind: member.kind, specialist: member.specialist });
  return member;
}

/** Update a member's extra skills or time limit. Omitted values are kept. */
export function editMember(teamName: string, memberName: string, patch: { timeLimitMinutes?: number; skills?: string[] }): Member {
  const limit = checkTimeLimit(patch.timeLimitMinutes);
  const skills = patch.skills === undefined ? undefined : checkSkills(patch.skills);
  const member = withLock("org", () => {
    const all = loadTeams();
    const team = all.find((t) => t.name === teamName);
    if (!team) throw new CodecError("team_not_found", `no team named "${teamName}"`, { name: teamName }, 404);
    const m = team.members.find((m) => m.name === memberName);
    if (!m) throw new CodecError("member_not_found", `team ${teamName} has no member named "${memberName}"`, {}, 404);
    if (limit !== undefined) m.timeLimitMinutes = limit;
    if (skills !== undefined) m.skills = skills;
    saveTeams(all);
    return m;
  });
  logEvent("member.edit", { team: teamName, member: memberName });
  return member;
}

/** Unchecked removal — use removeMemberChecked (runs.ts). */
export function deleteMember(teamName: string, memberName: string): Member {
  const removed = withLock("org", () => {
    const all = loadTeams();
    const team = all.find((t) => t.name === teamName);
    if (!team) throw new CodecError("team_not_found", `no team named "${teamName}"`, { name: teamName }, 404);
    const i = team.members.findIndex((m) => m.name === memberName);
    if (i === -1) throw new CodecError("member_not_found", `team ${teamName} has no member named "${memberName}"`, {}, 404);
    const [m] = team.members.splice(i, 1);
    saveTeams(all);
    return m;
  });
  logEvent("member.remove", { team: teamName, member: memberName });
  return removed;
}

/** "team/member" → its parts. */
export function parseMemberRef(ref: string): { team: string; member: string } {
  const i = ref.indexOf("/");
  if (i <= 0 || i === ref.length - 1) throw new CodecError("invalid_member", `member must be written as <team>/<member>, got "${ref}"`);
  return { team: ref.slice(0, i), member: ref.slice(i + 1) };
}

export function resolveMember(teamName: string, memberName: string): ResolvedMember {
  const team = getTeam(teamName);
  if (!team) throw new CodecError("team_not_found", `no team named "${teamName}"`, { name: teamName }, 404);
  const m = team.members.find((x) => x.name === memberName);
  if (!m) throw new CodecError("member_not_found", `team ${teamName} has no member named "${memberName}"`, {}, 404);
  const skills: ResolvedMember["skills"] = [];
  const push = (name: string, source: "specialist" | "member") => {
    if (!skills.some((s) => s.name === name)) skills.push({ name, source });
  };
  if (m.kind === "clone") {
    const spec = getSpecialist(m.specialist!);
    if (!spec) throw new CodecError("role_missing", `member ${teamName}/${memberName} is a clone of "${m.specialist}", which no longer exists`, { member: memberName, name: m.specialist! });
    spec.skills.forEach((s) => push(s, "specialist"));
    m.skills.forEach((s) => push(s, "member"));
    return {
      team: team.name,
      member: m.name,
      kind: "clone",
      specialist: spec.name,
      specialty: spec.specialty,
      tool: spec.tool,
      model: spec.model,
      timeLimitMinutes: m.timeLimitMinutes ?? spec.timeLimitMinutes,
      instructions: spec.instructions,
      skills,
      projects: team.projects,
    };
  }
  m.skills.forEach((s) => push(s, "member"));
  return {
    team: team.name,
    member: m.name,
    kind: "worker",
    tool: m.tool!,
    model: m.model,
    timeLimitMinutes: m.timeLimitMinutes,
    instructions: "",
    skills,
    projects: team.projects,
  };
}

/** Who has a skill: specialists directly, members on their own. (Clones also get their specialist's.) */
export function skillHolders(skill: string): { specialists: string[]; members: string[] } {
  return {
    specialists: loadSpecialists()
      .filter((s) => s.skills.includes(skill))
      .map((s) => s.name),
    members: loadTeams().flatMap((t) => t.members.filter((m) => m.skills.includes(skill)).map((m) => `${t.name}/${m.name}`)),
  };
}

/** Delete a skill from the library and take it away from every specialist and member. */
export function removeSkillEverywhere(name: string): { specialists: string[]; members: string[] } {
  const holders = withLock("org", () => {
    const h = skillHolders(name);
    deleteSkillFolder(name);
    const specs = loadSpecialists();
    specs.forEach((s) => (s.skills = s.skills.filter((x) => x !== name)));
    saveSpecialists(specs);
    const teams = loadTeams();
    teams.forEach((t) => t.members.forEach((m) => (m.skills = m.skills.filter((x) => x !== name))));
    saveTeams(teams);
    return h;
  });
  logEvent("skill.remove", { skill: name, unassignedFrom: holders });
  return holders;
}
