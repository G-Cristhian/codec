import { S } from "../../../src/strings";
export { S };
export type { DiffFile, DiffLine, RunChanges, FeedbackResult } from "../../../src/review";
export const enc = encodeURIComponent;
export const fmt = (text: string, values: Record<string, unknown> = {}) =>
  text.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ""));
export class RequestError extends Error {
  code?: string;
  params?: Record<string, unknown>;
  suggestion?: string;
  links?: { id: string; task: string }[];
  replaceSkill?: () => Promise<unknown>;
}
export function errorText(error: unknown): string {
  const e = error as RequestError;
  return e?.code && Object.hasOwn(S.errors, e.code)
    ? fmt(S.errors[e.code as keyof typeof S.errors], e.params)
    : e instanceof RequestError
      ? e.message
      : S.common.error;
}
export async function api<T = unknown>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api/" + path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      signal,
      headers: {
        "X-Codec-Token":
          document.querySelector<HTMLMetaElement>('meta[name="codec-token"]')
            ?.content ?? "",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new RequestError(S.common.networkError);
  }
  let data: T & {
    error?: string;
    code?: string;
    params?: Record<string, unknown>;
    suggestion?: string;
    links?: RequestError["links"];
  };
  try {
    data = await response.json();
  } catch {
    throw new RequestError(S.common.invalidReply);
  }
  if (!response.ok) {
    const e = Object.assign(new RequestError(data.error || S.common.error), {
      code: data.code,
      params: data.params,
      suggestion: data.suggestion,
      links: data.links,
    });
    if (e.code === "skill_exists")
      e.replaceSkill = () => api(path, { ...(body as object), replace: true });
    throw e;
  }
  return data;
}
export type Lane = "working" | "needsYou" | "inReview" | "done";
export const LANES: [Lane, string][] = [
  ["working", S.tasks.working],
  ["needsYou", S.tasks.needsYou],
  ["inReview", S.tasks.inReview],
  ["done", S.tasks.done],
];
export interface Skill {
  name: string;
  description?: string;
  source?: string;
  project?: string;
  how?: string;
  evidence?: string;
  specialists?: string[];
  members?: string[];
}
export interface Run {
  held?: boolean;
  runId: string;
  project: string;
  task: string;
  agent: string;
  state: string;
  stateText?: string;
  team?: string;
  member?: string;
  specialist?: string;
  startedAt?: string;
  deadline?: string;
  timeLimitMinutes?: number;
  lostAt?: string;
  cleanedAt?: string;
  reviewStatus?: string;
  reviewed?: import("../../../src/runs").RunReview;
  area?: TaskArea;
  model?: string;
  actualModel?: string;
  account?: { name: string };
  limitHit?: boolean;
  autoSaved?: boolean;
  checkpointError?: keyof typeof S.errors;
  branch?: string;
  worktree?: string;
  skillsGiven: Skill[];
  skillsUsed: Skill[];
  log?: string;
  lane?: Lane;
}
export interface Member {
  held?: boolean;
  member: string;
  name?: string;
  team?: string;
  specialty?: string;
  specialist?: string;
  tool: string;
  model?: string;
  error?: string;
  timeLimitMinutes?: number;
  skills: Skill[];
  projects: string[];
  instructions?: string;
  /** This agent's own instructions file (for role-based agents: on top of the role's). */
  ownInstructions?: string;
  harness?: Harness;
  /** The agent's own settings folder on this computer. */
  folder?: string;
  working: Run[];
  runs: Run[];
}
export type Access = "full" | "edit" | "read" | "custom";
export interface McpServer {
  name: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  /** Names only; saved values never come back to the page. */
  env?: Record<string, string>;
}
interface Harness {
  access: Access;
  allow: string[];
  deny: string[];
  isolated: boolean;
  mcp: McpServer[];
}
export interface Role {
  name: string;
  specialty: string;
  tool: string;
  model?: string;
  timeLimitMinutes?: number;
  skills: string[];
  instructions: string;
  clones: { team: string; member: string }[];
}
export interface Team {
  messageLimit?: number;
  name: string;
  projects: string[];
  members: Member[];
}
export interface Setup {
  tools: {
    tool: string;
    installed: boolean;
    signedIn: boolean;
    problem?: string;
    fix?: string;
    version?: string;
  }[];
  ready: boolean;
  identityReady: boolean;
  profileName?: string;
}
export interface Account {
  id: string;
  name: string;
  kind: string;
  status: string;
  builtin?: boolean;
  running?: boolean;
  login?: { state: string; url?: string; code?: string; needsCode?: boolean };
}
export interface Accounts {
  accounts: Account[];
  defaults: Record<string, string>;
  choices: Record<string, Record<string, string>>;
}
export type TaskArea = "school" | "work" | "personal";
export type ProjectArea = "class" | "work" | "personal";
export type EventKind = "deadline" | "meeting" | "interview";
export interface CalendarEvent {
  id: string;
  title: string;
  date: string;
  time?: string;
  kind: EventKind;
}
export interface Home {
  classes?: string[];
  events?: CalendarEvent[];
  coordinator?: CoordinatorView;
  projects: { name: string; path: string; lanes: Record<Lane, number>; area?: ProjectArea; className?: string }[];
  runs: Run[];
  agentsRunning: number;
  teamsCount: number;
  memoryBytes: number | null;
}
export interface CoordinatorView {
  settings: { held?: boolean; tool: string; model?: string; timeLimitMinutes?: number; createdAt: string } | null;
  running: boolean;
}
export interface Skills {
  skills: Skill[];
  grid: {
    skills: string[];
    rows: {
      id: string;
      label: string;
      kind: string;
      tool: string;
      skills: Record<string, string>;
    }[];
  };
}
export interface ProjectView {
  project: { name: string; path: string; messageLimit?: number };
  members: {
    ref: string;
    member: string;
    team?: string;
    specialty?: string;
    tool: string;
    label: string;
  }[];
  lanes: Record<Lane, Run[]>;
}
export interface PageData {
  setup: Setup;
  accounts: Accounts;
  home: Home;
  settings?: { identity: { name: string; email: string }; classes?: string[] };
  project?: ProjectView;
  run?: Run;
  teams?: Team[];
  roles?: Role[];
  skills?: Skills;
  member?: Member;
  chat?: ChatView;
}
interface ChatSummary {
  id: string;
  title: string;
  tool: string;
  updatedAt: string;
  area?: ProjectArea;
  className?: string;
  preview: string;
  busy: boolean;
}
export interface ChatView {
  id?: string;
  title?: string;
  area?: ProjectArea;
  className?: string;
  chats?: ChatSummary[];
  tool: string;
  model?: string;
  models: Record<string, { id: string; label: string }[]>;
  messages: {
    role: "user" | "assistant" | "error";
    text: string;
    at?: string;
    model?: string;
  }[];
  busy: boolean;
}
export const toolName = (tool: string) =>
  tool === "claude"
    ? S.setup.claude
    : tool === "codex"
      ? S.setup.codex
      : S.common.unknown;
export const toolOK = (setup: Setup, tool: string) =>
  setup.tools.some(
    (t) => t.tool === tool && t.installed && t.signedIn === true,
  );
export function toolProblem(setup: Setup, tool: string) {
  const t = setup.tools.find((t) => t.tool === tool);
  return t
    ? t.problem || (!t.installed ? S.setup.notInstalled : S.setup.notSignedIn)
    : S.setup.unchecked;
}
export const limitText = (value?: number) =>
  value === undefined || value === 0
    ? S.common.noLimit
    : fmt(S.common.minutes, { value });
export function stateText(r: Run): string {
  if (r.state === "stopped") return S.tasks.stopped;
  if (r.state === "timed_out")
    return (
      r.stateText ||
      fmt(S.tasks.timedOut, { limit: limitText(r.timeLimitMinutes) })
    );
  if (r.state === "failed") return r.lostAt ? S.wording.lost : S.tasks.failed;
  if (r.reviewStatus === "unsaved") return S.tasks.unsaved;
  if (r.reviewStatus === "unavailable") return S.tasks.workspaceUnchecked;
  if (r.reviewStatus === "no_changes") return S.tasks.noChanges;
  if (r.lostAt) return S.wording.lost;
  return (
    (
      {
        running: S.tasks.working,
        done: S.wording.finished,
        failed: S.tasks.failed,
        stopped: S.tasks.stopped,
      } as Record<string, string>
    )[r.state] || S.common.unknown
  );
}
export const whoText = (r: { team?: string; member?: string }) =>
  r.member === "coordinator" && !r.team ? S.coordinator.name : r.team
    ? fmt(S.wording.helperTeam, { team: r.team, member: r.member })
    : S.wording.quick;
export const memberHref = (team: string, member: string) =>
  "#/member/" + enc(team) + "/" + enc(member);
export const when = (iso?: string) =>
  iso ? new Date(iso).toLocaleString() : S.common.unknown;
export function mem(bytes: number | null) {
  return bytes == null
    ? S.wording.dash
    : bytes < 1024 ** 2
      ? (bytes / 1024).toFixed(0) + " " + S.common.kb
      : bytes < 1024 ** 3
        ? (bytes / 1024 ** 2).toFixed(0) + " " + S.common.mb
        : (bytes / 1024 ** 3).toFixed(2) + " " + S.common.gb;
}
export const snippet = (text: string, length = 120) => {
  text = text.replace(/\s+/g, " ").trim();
  return text.length > length ? text.slice(0, length) + "…" : text;
};
export const sourceText = (s: Skill, project?: string) =>
  s.source === "specialist"
    ? S.members.fromSpecialist
    : s.source === "project"
      ? fmt(S.members.fromProject, {
          project: s.project || project || S.tasks.project,
        })
      : S.members.own;
export const laneTone = (lane: Lane | "idle") => {
  if (lane === "needsYou") return "needs";
  if (lane === "inReview") return "review";
  if (lane === "idle") return "muted";
  return lane;
};
export const laneHint = (lane: Lane) =>
  ({
    working: S.wording.workingHint,
    needsYou: S.wording.needsYouHint,
    inReview: S.wording.reviewHint,
    done: S.wording.doneHint,
  })[lane];

export function projectTagText(p: { area?: ProjectArea; className?: string }) {
  if (p.area === "class") return p.className ?? "";
  if (p.area === "work") return S.tags.work;
  if (p.area === "personal") return S.tags.personal;
  return "";
}
