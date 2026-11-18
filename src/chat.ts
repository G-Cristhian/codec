/**
 * chat.ts — plain conversations with Claude or Codex, outside any project.
 *
 * Each message runs the CLI once, non-interactively, in a private empty folder
 * and resumes the previous session so the AI remembers the conversation.
 * Claude runs without skipping permissions and Codex in its default read-only
 * sandbox, so a chat can answer questions but can't change files.
 */

import { spawn, type ChildProcess } from "child_process";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { accountCliArgs, accountEnvironment, prepareAccount, resolveAccount } from "./accounts.js";
import { CodecError } from "./errors.js";
import { cleanModel } from "./org.js";
import { redactSecrets } from "./secrets.js";
import { findBinary } from "./setup.js";
import { codecHome, readJson, withLock, writeJsonAtomic } from "./store.js";
import { S } from "./strings.js";
import { checkTool, type Agent } from "./tools.js";
import { randomBytes } from "crypto";
import { cleanLabel, type ProjectArea } from "./planner.js";

interface ChatMessage { role: "user" | "assistant" | "error"; text: string; at: string; model?: string }
export interface ChatSaved {
  id: string; title: string; titled?: boolean; tool: Agent; model?: string; session?: string; messages: ChatMessage[];
  area?: ProjectArea; className?: string; createdAt: string; updatedAt: string;
}
interface ChatStore { current?: string; chats: ChatSaved[] }
export interface ModelChoice { id: string; label: string }
interface ChatSummary { id: string; title: string; tool: Agent; updatedAt: string; area?: ProjectArea; className?: string; preview: string; busy: boolean }
export interface ChatView {
  id: string; title: string; tool: Agent; model?: string; area?: ProjectArea; className?: string;
  models: Record<Agent, ModelChoice[]>; messages: ChatMessage[]; busy: boolean; chats: ChatSummary[];
}
export interface ChatOptions {
  timeoutMs?: number;
  binary?: typeof findBinary;
  spawn?: (command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) => ChildProcess;
}

const MAX_MESSAGE = 20_000;
const MAX_CHATS = 200;
const chatDir = (): string => join(codecHome(), "chat");
const storeFile = (): string => join(chatDir(), "chats.json");
/** Before multiple chats, the one conversation lived here. */
const legacyFile = (): string => join(chatDir(), "chat.json");

const now = () => new Date().toISOString();
function newChat(tool: Agent, model?: string): ChatSaved {
  const at = now();
  return { id: "chat-" + randomBytes(6).toString("hex"), title: S.chat.untitled, tool, ...(model ? { model } : {}), messages: [], createdAt: at, updatedAt: at };
}
function loadStore(): ChatStore {
  const saved = readJson<ChatStore | null>(storeFile(), null);
  if (saved && Array.isArray(saved.chats)) return saved;
  const legacy = readJson<{ tool?: Agent; model?: string; session?: string; messages?: ChatMessage[] } | null>(legacyFile(), null);
  if (!legacy || !legacy.messages?.length) return { chats: [] };
  const chat = { ...newChat(legacy.tool ?? "claude", legacy.model), session: legacy.session, messages: legacy.messages };
  chat.title = titleFrom(chat.messages) ?? chat.title;
  chat.updatedAt = chat.messages[chat.messages.length - 1].at || chat.updatedAt;
  return { current: chat.id, chats: [chat] };
}
function titleFrom(messages: ChatMessage[]): string | undefined {
  const first = messages.find((m) => m.role === "user")?.text.replace(/```[\s\S]*?(```|$)/g, " ").replace(/\s+/g, " ").trim();
  if (!first) return undefined;
  return first.length > 60 ? first.slice(0, 57).trimEnd() + "…" : first;
}
/** The open chat, created (empty) if there is none yet. */
function currentOf(store: ChatStore): ChatSaved {
  let chat = store.chats.find((c) => c.id === store.current);
  if (!chat) {
    chat = store.chats.filter((c) => c.messages.length).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!chat) {
      chat = newChat(store.chats[0]?.tool ?? "claude");
      store.chats.push(chat);
    }
    store.current = chat.id;
  }
  return chat;
}
function update<T>(change: (store: ChatStore) => T): T {
  return withLock("chat", () => {
    const store = loadStore();
    const out = change(store);
    // Keep only chats with messages, plus the open one; drop the oldest past the cap.
    store.chats = store.chats.filter((c) => c.messages.length || c.id === store.current)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_CHATS);
    mkdirSync(chatDir(), { recursive: true, mode: 0o700 });
    writeJsonAtomic(storeFile(), store);
    return out;
  });
}
function find(store: ChatStore, id: string): ChatSaved {
  const chat = store.chats.find((c) => c.id === id);
  if (!chat) throw new CodecError("chat_not_found", S.errors.chat_not_found, {}, 404);
  return chat;
}

/** The CLI arguments for one turn; the message itself goes in on stdin. */
export function chatArgs(tool: Agent, session: string | undefined, accountArgs: string[] = [], model?: string): string[] {
  if (tool === "claude") return ["-p", "--output-format", "json", ...(session ? ["--resume", session] : []), ...(model ? ["--model", model] : [])];
  return [...accountArgs, "exec", "--json", "--skip-git-repo-check", ...(session ? ["resume"] : []), ...(model ? ["-m", model] : []), ...(session ? [session] : []), "-"];
}

// Claude's CLI takes these aliases for its latest models.
const CLAUDE_MODELS: ModelChoice[] = [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }, { id: "haiku", label: "Haiku" }];
/** Codex keeps the models its account can use in models_cache.json; show the listed ones, best first. */
export function codexModels(codexHome: string): ModelChoice[] {
  const cache = readJson<{ models?: { slug?: unknown; display_name?: unknown; visibility?: unknown; priority?: unknown }[] }>(join(codexHome, "models_cache.json"), {});
  if (!Array.isArray(cache.models)) return [];
  return cache.models
    .filter((m) => typeof m.slug === "string" && m.visibility === "list" && /^[A-Za-z0-9._:\/\[\]-]{1,100}$/.test(m.slug))
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0))
    .map((m) => ({ id: m.slug as string, label: typeof m.display_name === "string" && m.display_name.trim() ? m.display_name.trim() : m.slug as string }));
}

/** The reply and session id from one turn's output. */
export function parseChatOutput(tool: Agent, stdout: string): { reply?: string; session?: string; failed?: boolean } {
  if (tool === "claude") {
    try {
      const v = JSON.parse(stdout.trim().split("\n").pop() ?? "");
      return { reply: typeof v.result === "string" ? v.result : undefined, session: typeof v.session_id === "string" ? v.session_id : undefined, failed: v.is_error === true };
    } catch { return {}; }
  }
  // Codex --json prints one event per line; older versions nest them under "msg".
  const out: { reply?: string; session?: string; failed?: boolean } = {};
  for (const line of stdout.split("\n")) {
    let v;
    try { v = JSON.parse(line); } catch { continue; }
    if (v?.type === "thread.started" && typeof v.thread_id === "string") out.session = v.thread_id;
    if (v?.type === "item.completed" && v.item?.type === "agent_message" && typeof v.item.text === "string") out.reply = v.item.text;
    if (v?.type === "turn.failed" || v?.type === "error") out.failed = true;
    if (v?.msg?.type === "session_configured" && typeof v.msg.session_id === "string") out.session = v.msg.session_id;
    if (v?.msg?.type === "agent_message" && typeof v.msg.message === "string") out.reply = v.msg.message;
  }
  return out;
}

export function createChat(options: ChatOptions = {}) {
  let child: ChildProcess | undefined;
  let childChat: string | undefined;
  let closed = false;
  const launch = options.spawn ?? ((command, args, env, cwd) => spawn(command, args, { env, cwd, detached: true, stdio: "pipe" }));

  function models(): Record<Agent, ModelChoice[]> {
    let codex: ModelChoice[] = [];
    try { codex = codexModels(accountEnvironment(resolveAccount("codex")).CODEX_HOME || join(homedir(), ".codex")); } catch { /* No usable Codex account yet. */ }
    return { claude: CLAUDE_MODELS, codex };
  }
  function summary(chat: ChatSaved): ChatSummary {
    const last = chat.messages[chat.messages.length - 1];
    return { id: chat.id, title: chat.title, tool: chat.tool, updatedAt: chat.updatedAt, area: chat.area, className: chat.className,
      preview: last ? last.text.replace(/\s+/g, " ").slice(0, 120) : "", busy: !!child && childChat === chat.id };
  }
  function viewOf(store: ChatStore): ChatView {
    const chat = currentOf(store);
    const chats = store.chats.filter((c) => c.messages.length)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(summary);
    return { id: chat.id, title: chat.title, tool: chat.tool, model: chat.model, area: chat.area, className: chat.className,
      models: models(), messages: chat.messages, busy: !!child && childChat === chat.id, chats };
  }
  /** The open chat, or `id` after opening it. */
  function view(id?: string): ChatView {
    if (id) return update((store) => { find(store, id); store.current = id; return viewOf(store); });
    const store = loadStore();
    const had = store.chats.some((c) => c.id === store.current);
    if (!had) return update(viewOf);
    return viewOf(store);
  }
  function stop(): void {
    const pid = child?.pid;
    child = undefined;
    childChat = undefined;
    if (!pid) return;
    try { process.kill(-pid, "SIGKILL"); } catch { /* Already gone. */ }
  }
  /**
   * Open a fresh chat, optionally with the other tool (its own model list, so its default model).
   * An open chat with no messages is reused rather than piling up empty chats.
   */
  function reset(tool?: string): ChatView {
    const next = tool ? checkTool(tool) : undefined;
    return update((store) => {
      const open = currentOf(store);
      if (!open.messages.length && !(child && childChat === open.id)) {
        if (next && next !== open.tool) { open.tool = next; delete open.model; }
        return viewOf(store);
      }
      const chat = newChat(next ?? open.tool, next && next !== open.tool ? undefined : open.model);
      store.chats.push(chat);
      store.current = chat.id;
      return viewOf(store);
    });
  }
  /** Pick the model for the next replies; the conversation carries on. Blank means the tool's default. */
  function setModel(model?: string): ChatView {
    const clean = cleanModel(model);
    return update((store) => {
      const chat = currentOf(store);
      if (clean) chat.model = clean; else delete chat.model;
      return viewOf(store);
    });
  }
  function rename(id: string, title: unknown): ChatView {
    const clean = cleanLabel(title, 80);
    if (!clean) throw new CodecError("chat_title", S.errors.chat_title, {}, 400);
    return update((store) => { const chat = find(store, id); chat.title = clean; chat.titled = true; return viewOf(store); });
  }
  function tag(id: string, value: { area?: ProjectArea; className?: string }): ChatView {
    return update((store) => {
      const chat = find(store, id);
      delete chat.area; delete chat.className;
      if (value.area) chat.area = value.area;
      if (value.className) chat.className = value.className;
      return viewOf(store);
    });
  }
  function remove(id: string): ChatView {
    if (child && childChat === id) stop();
    return update((store) => {
      find(store, id);
      store.chats = store.chats.filter((c) => c.id !== id);
      if (store.current === id) store.current = undefined;
      return viewOf(store);
    });
  }
  function send(text: string, id?: string): ChatView {
    const message = text.trim();
    if (!message || message.length > MAX_MESSAGE) throw new CodecError("chat_message", S.errors.chat_message, {}, 400);
    if (child || closed) throw new CodecError("chat_busy", S.errors.chat_busy, {}, 409);
    const at = new Date().toISOString();
    const saved = update((store) => {
      if (id) { find(store, id); store.current = id; }
      const chat = currentOf(store);
      const binary = (options.binary ?? findBinary)(chat.tool);
      if (!binary) throw new CodecError("tool_unavailable", S.errors.tool_unavailable, { tool: chat.tool === "claude" ? S.setup.claude : S.setup.codex }, 409);
      chat.messages.push({ role: "user", text: redactSecrets(message), at });
      if (!chat.titled) chat.title = titleFrom(chat.messages) ?? chat.title;
      chat.updatedAt = at;
      return { ...chat, binary };
    });
    const { tool, model, binary } = saved;
    const account = resolveAccount(tool);
    prepareAccount(account);
    const env = accountEnvironment(account);
    mkdirSync(chatDir(), { recursive: true, mode: 0o700 });

    const running = launch(binary, chatArgs(tool, saved.session, accountCliArgs(account), model), env, chatDir());
    child = running;
    childChat = saved.id;
    let stdout = "", stderr = "";
    running.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    running.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    const timer = setTimeout(stop, options.timeoutMs ?? 10 * 60_000);
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Stopped by deleting the chat or by a timeout.
      const current = child === running;
      if (current) { child = undefined; childChat = undefined; }
      const result = parseChatOutput(tool, stdout);
      update((store) => {
        const chat = store.chats.find((c) => c.id === saved.id);
        if (!chat || chat.tool !== tool || !chat.messages.some((m) => m.at === at && m.role === "user")) return;
        if (result.session) chat.session = result.session;
        const ok = current && code === 0 && !result.failed && result.reply;
        const reply: ChatMessage = ok ? { role: "assistant", text: redactSecrets(result.reply!), at: now(), ...(model ? { model } : {}) }
          : { role: "error", text: current ? redactSecrets(result.reply || stderr.trim().split("\n").pop() || S.chat.failed) : S.chat.timedOut, at: now() };
        chat.messages.push(reply);
        chat.updatedAt = reply.at;
      });
    };
    running.on("error", () => finish(null));
    running.on("close", (code) => finish(code));
    running.stdin?.on("error", () => { /* The CLI exited before reading. */ });
    running.stdin?.end(message);
    return view();
  }
  async function close(): Promise<void> { closed = true; stop(); }
  return { view, send, reset, setModel, rename, tag, remove, close };
}
