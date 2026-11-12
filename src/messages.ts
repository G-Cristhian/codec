/** Persistent helper inboxes. All inbox and delivery writes share the messages lock. */
import { randomUUID } from "crypto";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { CodecError } from "./errors.js";
import { helperRef, isPmHelper, requireCoordinator } from "./coordinator.js";
import { addExcludes } from "./inject.js";
import { getTeam, parseMemberRef } from "./org.js";
import { getProject, git, PROJECT_NAME_RE } from "./registry.js";
import { DEFAULT_MESSAGE_LIMIT } from "./message-limits.js";
import { listRuns, type RunStatus } from "./runs.js";
import { coordinatorInboxFile, inboxFile, messageLimitsFile, messagesDir, ownerInboxFile, readJson, withLock, writeJsonAtomic, writeTextAtomic } from "./store.js";
import { S, wording } from "./strings.js";

export interface MessageRecord {
  id: string;
  from: string;
  to: string;
  body: string;
  sentAt: string;
  read: boolean;
  deliveredAt?: string;
  runId?: string;
  declined?: boolean;
}

export interface MessageFilter {
  /** Messages sent to or from this helper. */
  helper?: string;
  to?: string;
  from?: string;
  unread?: boolean;
}

interface PairLimit {
  count: number;
  cappedAt?: string;
  limit?: number;
}
type MessageLimits = Record<string, PairLimit>;
const pairKey = (a: string, b: string): string => [a, b].sort().join("|");
// These two primitives are only used while holding the messages lock.
const loadLimits = (): MessageLimits => readJson(messageLimitsFile(), {});
const saveLimits = (limits: MessageLimits): void => writeJsonAtomic(messageLimitsFile(), limits);

export function cappedMessagePairs(): { key: string; a: string; b: string; limit?: number }[] {
  return withLock("messages", () => Object.entries(loadLimits())
    .filter(([, pair]) => pair.cappedAt)
    .map(([key, pair]) => {
      const [a, b] = key.split("|");
      return { key, a, b, limit: pair.limit };
    }));
}

export function isHelperHeld(ref: string | undefined): boolean {
  return !!ref && cappedMessagePairs().some((pair) => pair.a === ref || pair.b === ref);
}

export function resetMessageLimit(key: string): void {
  withLock("messages", () => {
    const limits = loadLimits();
    if (!limits[key]?.cappedAt) throw new CodecError("message_pair_not_found", S.errors.message_pair_not_found, {}, 404);
    limits[key] = { count: 0 };
    saveLimits(limits);
  });
}

function resolvedLimit(from: string, to: string): number {
  const teams = [from, to].filter((ref) => ref !== "coordinator")
    .map((ref) => getTeam(parseMemberRef(ref).team)!);
  const teamLimits = teams.flatMap((team) => team.messageLimit === undefined ? [] : [team.messageLimit]);
  if (teamLimits.length) return Math.min(...teamLimits);
  const senderRun = listRuns({ state: "running" }).reverse().find((run) => helperRef(run) === from);
  const projects = senderRun ? [senderRun.project]
    : teams[0].projects.filter((project) => teams.every((team) => team.projects.includes(project)));
  const projectLimits = projects.flatMap((name) => {
    const limit = getProject(name)?.messageLimit;
    return limit === undefined ? [] : [limit];
  });
  return projectLimits.length ? Math.min(...projectLimits) : DEFAULT_MESSAGE_LIMIT;
}

function helper(ref: string): { team?: string; member: string } {
  if (ref === "coordinator") {
    requireCoordinator();
    return { member: ref };
  }
  const parts = parseMemberRef(ref);
  if (!PROJECT_NAME_RE.test(parts.team) || !PROJECT_NAME_RE.test(parts.member)) {
    throw new CodecError("invalid_member", S.errors.invalid_member);
  }
  const team = getTeam(parts.team);
  if (!team) throw new CodecError("team_not_found", wording(S.errors.team_not_found, { name: parts.team }), { name: parts.team }, 404);
  if (!team.members.some((member) => member.name === parts.member)) {
    throw new CodecError("member_not_found", S.errors.member_not_found, {}, 404);
  }
  return parts;
}

function messageFile(ref: string): string {
  if (ref === "coordinator") return coordinatorInboxFile();
  if (ref === "owner") return ownerInboxFile();
  const { team, member } = parseMemberRef(ref);
  return inboxFile(team, member);
}

/** Called only with the messages lock held. Delivery does not imply the helper read it. */
function deliver(file: string, messages: MessageRecord[], run: RunStatus): MessageRecord[] {
  const tracked = git(run.worktree, ["ls-files", "--", "messages.md"]);
  if (!tracked.ok) throw new CodecError("tracking_failed", S.errors.tracking_failed);
  if (tracked.out) throw new CodecError("message_file_conflict", S.errors.message_file_conflict, {}, 409);
  withLock(`project-${run.project}`, () => {
    // Atomic replacements have temporary siblings; exclude those from checkpoints too.
    addExcludes(run.worktree, ["/messages.md", "/messages.md.*.tmp"]);
  });
  const deliveredAt = new Date().toISOString();
  const delivered: MessageRecord[] = [];
  const next = messages.map((message) => {
    if (message.deliveredAt || message.declined) return message;
    const entry = { ...message, deliveredAt, runId: run.runId };
    delivered.push(entry);
    return entry;
  });
  // Rebuild this run's view so retrying after a failed inbox save cannot duplicate entries.
  const entries = next.filter((message) => !message.declined && message.runId === run.runId)
    .map((message) => wording(S.messages.entry, { from: message.from, sentAt: message.sentAt, body: message.body }));
  writeTextAtomic(join(run.worktree, "messages.md"), [S.messages.title, ...entries].join("\n\n") + "\n");
  if (delivered.length) writeJsonAtomic(file, next);
  return delivered;
}

export function postMessage(input: { from: string; to: string; body: string }): MessageRecord {
  if (input.from === "coordinator" && input.to === "coordinator") {
    throw new CodecError("coordinator_self_message", S.errors.coordinator_self_message);
  }
  if (input.to === "owner") {
    if (input.from !== "coordinator") throw new CodecError("coordinator_owner_only", S.errors.coordinator_owner_only);
  } else helper(input.to);
  if (input.from !== "owner") helper(input.from);
  if (!input.body.trim()) throw new CodecError("missing_message", S.errors.missing_message);
  return withLock("messages", () => postLocked(input));
}

/** Caller holds the messages lock, including declined messages and their replies. */
function postLocked(input: { from: string; to: string; body: string }): MessageRecord {
  const limits = loadLimits();
  const key = input.from !== "owner" && input.from !== "codec" && input.to !== "owner" && input.from !== input.to
    ? pairKey(input.from, input.to) : undefined;
  if (key && limits[key]?.cappedAt) throw new CodecError("message_limit_reached", S.messageLimit.reached, {}, 409);
  const limit = key ? resolvedLimit(input.from, input.to) : undefined;
  const message = storeMessage(input);
  const pending = [message];
  if (key) {
    const pair: PairLimit = limits[key] = { count: (limits[key]?.count ?? 0) + 1, limit };
    if (pair.count >= limit!) pair.cappedAt = message.sentAt;
    saveLimits(limits);
    if (pair.cappedAt) {
      // Queue both notices before attempting delivery, even if a task's folder is unavailable.
      for (const to of [input.from, input.to]) pending.push(storeMessage({ from: "codec", to, body: S.messageLimit.reached }));
    }
  } else if (input.from === "owner") {
    let changed = false;
    for (const [key, pair] of Object.entries(limits)) {
      if (pair.cappedAt && key.split("|").includes(input.to)) {
        limits[key] = { count: 0 };
        changed = true;
      }
    }
    if (changed) saveLimits(limits);
  }
  let result = message;
  let deliveryError: unknown;
  for (const entry of pending) {
    try {
      const delivered = deliverMessage(entry);
      if (entry.id === message.id) result = delivered;
    } catch (error) { deliveryError ??= error; }
  }
  if (deliveryError) throw deliveryError;
  // A declined message can use the final slot. Its auto-reply must obey the same cap.
  if (message.declined && !limits[key!]?.cappedAt) {
    postLocked({ from: "coordinator", to: input.from, body: S.coordinator.pmOnly });
  }
  return result;
}

function storeMessage(input: { from: string; to: string; body: string }): MessageRecord {
  const file = messageFile(input.to);
  const messages = readJson<MessageRecord[]>(file, []);
  const message: MessageRecord = {
    id: randomUUID(), from: input.from, to: input.to, body: input.body,
    sentAt: new Date().toISOString(), read: false,
  };
  if (input.to === "coordinator" && input.from !== "owner" && input.from !== "codec" && !isPmHelper(input.from)) {
    message.declined = true;
    message.deliveredAt = message.sentAt;
  } else if (input.to === "owner") {
    message.deliveredAt = message.sentAt;
  }
  messages.push(message);
  // Persist first: a failed delivery leaves a recoverable message in the inbox.
  writeJsonAtomic(file, messages);
  return message;
}

function deliverMessage(message: MessageRecord): MessageRecord {
  if (message.declined || message.to === "owner") return message;
  // A helper can have several tasks. Its most recently started running task receives messages.
  const run = listRuns({ state: "running" }).reverse().find((run) => helperRef(run) === message.to);
  if (!run) return message;
  const file = messageFile(message.to);
  const messages = readJson<MessageRecord[]>(file, []);
  deliver(file, messages, run);
  // A preceding delivery in this batch may already have delivered this entry.
  return readJson<MessageRecord[]>(file, []).find((entry) => entry.id === message.id)!;
}

/** Drain queued messages before launch, or retry delivery to a running helper. */
export function receiveMessages(helperRef: string, runId: string): MessageRecord[] {
  const recipient = helper(helperRef);
  return withLock("messages", () => {
    // Accept only full saved ids, never a path or a run belonging to another helper.
    const run = listRuns().find((run) => run.runId === runId);
    if (!run) throw new CodecError("run_not_found", S.errors.run_not_found, {}, 404);
    if (run.team !== recipient.team || run.member !== recipient.member) {
      throw new CodecError("message_run_mismatch", S.errors.message_run_mismatch);
    }
    if (run.state !== "running") throw new CodecError("run_not_running", S.errors.run_not_running);
    const file = messageFile(helperRef);
    return deliver(file, readJson<MessageRecord[]>(file, []), run);
  });
}

function inboxes(): string[] {
  if (!existsSync(messagesDir())) return [];
  const helpers = readdirSync(messagesDir(), { withFileTypes: true }).filter((team) => team.isDirectory())
    .flatMap((team) => readdirSync(join(messagesDir(), team.name), { withFileTypes: true })
      .filter((file) => file.isFile() && file.name.endsWith(".json"))
      .map((file) => join(messagesDir(), team.name, file.name)));
  return [...helpers, ...[coordinatorInboxFile(), ownerInboxFile()].filter(existsSync)];
}

/** Read history from disk, including helpers since removed from a team. */
export function listMessages(filter: MessageFilter = {}): MessageRecord[] {
  return inboxes().flatMap((file) => readJson<MessageRecord[]>(file, []))
    .filter((message) => (!filter.helper || message.to === filter.helper || message.from === filter.helper)
      && (!filter.to || message.to === filter.to)
      && (!filter.from || message.from === filter.from)
      && (!filter.unread || !message.read))
    .reverse().sort((a, b) => b.sentAt.localeCompare(a.sentAt));
}

/** Mark known ids as read; repeated calls and unknown ids are harmless. */
export function markRead(ids: string[]): void {
  const wanted = new Set(ids);
  if (!wanted.size) return;
  withLock("messages", () => {
    for (const file of inboxes()) {
      const messages = readJson<MessageRecord[]>(file, []);
      let changed = false;
      for (const message of messages) {
        if (!message.read && wanted.has(message.id)) {
          message.read = true;
          changed = true;
        }
      }
      if (changed) writeJsonAtomic(file, messages);
    }
  });
}
