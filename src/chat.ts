/**
 * chat.ts — one plain conversation with Claude or Codex, outside any project.
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

export interface ChatMessage { role: "user" | "assistant" | "error"; text: string; at: string; model?: string }
export interface ChatSaved { tool: Agent; model?: string; session?: string; messages: ChatMessage[] }
export interface ModelChoice { id: string; label: string }
export interface ChatView { tool: Agent; model?: string; models: Record<Agent, ModelChoice[]>; messages: ChatMessage[]; busy: boolean }
export interface ChatOptions {
  timeoutMs?: number;
  binary?: typeof findBinary;
  spawn?: (command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) => ChildProcess;
}

const MAX_MESSAGE = 20_000;
const chatDir = (): string => join(codecHome(), "chat");
const chatFile = (): string => join(chatDir(), "chat.json");
const load = (): ChatSaved => readJson<ChatSaved>(chatFile(), { tool: "claude", messages: [] });
function update(change: (saved: ChatSaved) => void): ChatSaved {
  return withLock("chat", () => {
    const saved = load();
    change(saved);
    writeJsonAtomic(chatFile(), saved);
    return saved;
  });
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
  let closed = false;
  const launch = options.spawn ?? ((command, args, env, cwd) => spawn(command, args, { env, cwd, detached: true, stdio: "pipe" }));

  function models(): Record<Agent, ModelChoice[]> {
    let codex: ModelChoice[] = [];
    try { codex = codexModels(accountEnvironment(resolveAccount("codex")).CODEX_HOME || join(homedir(), ".codex")); } catch { /* No usable Codex account yet. */ }
    return { claude: CLAUDE_MODELS, codex };
  }
  function view(): ChatView {
    const saved = load();
    return { tool: saved.tool, model: saved.model, models: models(), messages: saved.messages, busy: !!child };
  }
  function stop(): void {
    const pid = child?.pid;
    child = undefined;
    if (!pid) return;
    try { process.kill(-pid, "SIGKILL"); } catch { /* Already gone. */ }
  }
  /** Start over, optionally with the other tool (its own model list, so back to its default model). */
  function reset(tool?: string): ChatView {
    const next = tool ? checkTool(tool) : undefined;
    stop();
    update((saved) => {
      if (next && next !== saved.tool) { saved.tool = next; saved.model = undefined; }
      saved.session = undefined; saved.messages = [];
    });
    return view();
  }
  /** Pick the model for the next replies; the conversation carries on. Blank means the tool's default. */
  function setModel(model?: string): ChatView {
    const clean = cleanModel(model);
    update((saved) => { saved.model = clean; });
    return view();
  }
  function send(text: string): ChatView {
    const message = text.trim();
    if (!message || message.length > MAX_MESSAGE) throw new CodecError("chat_message", S.errors.chat_message, {}, 400);
    if (child || closed) throw new CodecError("chat_busy", S.errors.chat_busy, {}, 409);
    const saved = load();
    const { tool, model } = saved;
    const binary = (options.binary ?? findBinary)(tool);
    if (!binary) throw new CodecError("tool_unavailable", S.errors.tool_unavailable, { tool: tool === "claude" ? S.setup.claude : S.setup.codex }, 409);
    const account = resolveAccount(tool);
    prepareAccount(account);
    const env = accountEnvironment(account);
    mkdirSync(chatDir(), { recursive: true, mode: 0o700 });
    const at = new Date().toISOString();
    update((s) => { s.messages.push({ role: "user", text: redactSecrets(message), at }); });

    const running = launch(binary, chatArgs(tool, saved.session, accountCliArgs(account), model), env, chatDir());
    child = running;
    let stdout = "", stderr = "";
    running.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    running.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    const timer = setTimeout(stop, options.timeoutMs ?? 10 * 60_000);
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Stopped by "New chat" or a timeout: the chat it belonged to is gone or abandoned.
      const current = child === running;
      if (current) child = undefined;
      const result = parseChatOutput(tool, stdout);
      update((s) => {
        if (s.tool !== tool || !s.messages.some((m) => m.at === at && m.role === "user")) return;
        if (result.session) s.session = result.session;
        const ok = current && code === 0 && !result.failed && result.reply;
        s.messages.push(ok ? { role: "assistant", text: redactSecrets(result.reply!), at: new Date().toISOString(), ...(model ? { model } : {}) }
          : { role: "error", text: current ? redactSecrets(result.reply || stderr.trim().split("\n").pop() || S.chat.failed) : S.chat.timedOut, at: new Date().toISOString() });
      });
    };
    running.on("error", () => finish(null));
    running.on("close", (code) => finish(code));
    running.stdin?.on("error", () => { /* The CLI exited before reading. */ });
    running.stdin?.end(message);
    return view();
  }
  async function close(): Promise<void> { closed = true; stop(); }
  return { view, send, reset, setModel, close };
}
