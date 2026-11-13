import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { type ChildProcess } from "child_process";
import { writeFileSync } from "fs";
import { join } from "path";
import { chatArgs, codexModels, createChat, parseChatOutput, type ChatOptions } from "../src/chat.js";
import { tempDir } from "./helpers.js";
import { cleanupTemps, useIsolatedHome } from "./helpers.js";

type Chat = ReturnType<typeof createChat>;
let chats: Chat[];
beforeEach(() => { useIsolatedHome("true"); chats = []; });
afterEach(async () => { await Promise.all(chats.map((chat) => chat.close())); cleanupTemps(); });

function fixture(options: ChatOptions = {}) {
  const children: { child: any; input: string; reply: (stdout: string, code?: number) => void }[] = [];
  const launch = vi.fn((_command: string, _args: string[], _env: NodeJS.ProcessEnv, _cwd: string) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: undefined });
    const entry = { child, input: "", reply: (stdout: string, code = 0) => { child.stdout.end(stdout); setImmediate(() => child.emit("close", code)); } };
    child.stdin.setEncoding("utf8").on("data", (chunk: string) => { entry.input += chunk; });
    children.push(entry);
    return child as unknown as ChildProcess;
  });
  const chat = createChat({ binary: (tool) => tool, spawn: launch, ...options });
  chats.push(chat);
  return { chat, launch, children };
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("chat command line", () => {
  it("asks Claude for JSON and resumes its session", () => {
    expect(chatArgs("claude", undefined)).toEqual(["-p", "--output-format", "json"]);
    expect(chatArgs("claude", "abc")).toEqual(["-p", "--output-format", "json", "--resume", "abc"]);
  });
  it("runs Codex exec outside a repository, reading the message from stdin, and resumes its thread", () => {
    expect(chatArgs("codex", undefined)).toEqual(["exec", "--json", "--skip-git-repo-check", "-"]);
    expect(chatArgs("codex", "t1", ["-c", "x"])).toEqual(["-c", "x", "exec", "--json", "--skip-git-repo-check", "resume", "t1", "-"]);
  });
  it("passes the chosen model, including when resuming", () => {
    expect(chatArgs("claude", "abc", [], "opus")).toEqual(["-p", "--output-format", "json", "--resume", "abc", "--model", "opus"]);
    expect(chatArgs("codex", undefined, [], "gpt-6-sol")).toEqual(["exec", "--json", "--skip-git-repo-check", "-m", "gpt-6-sol", "-"]);
    expect(chatArgs("codex", "t1", [], "gpt-6-sol")).toEqual(["exec", "--json", "--skip-git-repo-check", "resume", "-m", "gpt-6-sol", "t1", "-"]);
  });
  it("lists Codex's visible models best first from its cache", () => {
    const dir = tempDir("codex-home-");
    expect(codexModels(dir)).toEqual([]);
    writeFileSync(join(dir, "models_cache.json"), JSON.stringify({ models: [
      { slug: "b", display_name: "B", visibility: "list", priority: 2 }, { slug: "hidden", visibility: "hide", priority: 0 },
      { slug: "a", display_name: "A", visibility: "list", priority: 1 }, { slug: "bad name; rm", visibility: "list", priority: 3 }, { slug: "c", visibility: "list", priority: 4 }] }));
    expect(codexModels(dir)).toEqual([{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "c" }]);
  });
  it("reads the reply and session from each tool's output", () => {
    expect(parseChatOutput("claude", '{"type":"result","result":"Hi","session_id":"s1","is_error":false}\n')).toEqual({ reply: "Hi", session: "s1", failed: false });
    expect(parseChatOutput("claude", "not json")).toEqual({});
    const codex = ['{"type":"thread.started","thread_id":"t1"}', '{"type":"item.completed","item":{"type":"reasoning","text":"hmm"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Hello"}}', '{"type":"turn.completed"}'].join("\n");
    expect(parseChatOutput("codex", codex)).toEqual({ session: "t1", reply: "Hello" });
    expect(parseChatOutput("codex", '{"msg":{"type":"session_configured","session_id":"old"}}\n{"msg":{"type":"agent_message","message":"Yo"}}')).toEqual({ session: "old", reply: "Yo" });
  });
});

describe("chat conversation", () => {
  it("sends a message, shows it while waiting, then keeps the reply and resumes the session", async () => {
    const { chat, launch, children } = fixture();
    const busy = chat.send("  Hello there  ");
    expect(busy).toMatchObject({ tool: "claude", busy: true, messages: [{ role: "user", text: "Hello there" }] });
    expect(children[0].input).toBe("Hello there");
    expect(() => chat.send("again")).toThrow(expect.objectContaining({ code: "chat_busy" }));
    children[0].reply('{"result":"Hi! How can I help?","session_id":"s1"}');
    await settled();
    expect(chat.view()).toMatchObject({ busy: false, messages: [{ role: "user" }, { role: "assistant", text: "Hi! How can I help?" }] });

    chat.send("Second");
    expect(launch.mock.calls[1][1]).toContain("--resume");
    expect(launch.mock.calls[1][1]).toContain("s1");
    children[1].reply('{"result":"Sure","session_id":"s1"}');
    await settled();
    // A new chat object (e.g. after Codec restarts) still sees the saved conversation.
    expect(createChat().view().messages.map((m) => m.text)).toEqual(["Hello there", "Hi! How can I help?", "Second", "Sure"]);
  });
  it("keeps the conversation when the model changes and labels replies with their model", async () => {
    const { chat, launch, children } = fixture();
    chat.send("Hi");
    children[0].reply('{"result":"Hello","session_id":"s1"}');
    await settled();
    expect(chat.setModel(" sonnet ")).toMatchObject({ model: "sonnet", messages: [{ role: "user" }, { role: "assistant" }] });
    chat.send("Again");
    expect(launch.mock.calls[1][1]).toEqual(["-p", "--output-format", "json", "--resume", "s1", "--model", "sonnet"]);
    children[1].reply('{"result":"Hi again","session_id":"s1"}');
    await settled();
    expect(chat.view().messages.map((m) => m.model)).toEqual([undefined, undefined, undefined, "sonnet"]);
    expect(() => chat.setModel("bad name; rm -rf")).toThrow(expect.objectContaining({ code: "invalid_model" }));
    expect(chat.setModel("").model).toBeUndefined();
    chat.setModel("opus");
    expect(chat.reset().model).toBe("opus");
    expect(chat.reset("codex").model).toBeUndefined();
    expect(chat.view().models.claude.map((m) => m.id)).toEqual(["opus", "sonnet", "haiku"]);
  });
  it("shows a failed reply as an error the user can read", async () => {
    const { chat, children } = fixture();
    chat.send("Hi");
    children[0].child.stderr.write("Not logged in · Please run /login\n");
    children[0].reply("", 1);
    await settled();
    expect(chat.view().messages[1]).toMatchObject({ role: "error", text: "Not logged in · Please run /login" });
  });
  it("New chat clears the conversation, can switch tools, and drops a reply that arrives late", async () => {
    const { chat, launch, children } = fixture();
    chat.send("Hi");
    expect(chat.reset("codex")).toMatchObject({ tool: "codex", busy: false, messages: [] });
    children[0].reply('{"result":"late","session_id":"s1"}');
    await settled();
    expect(chat.view().messages).toEqual([]);
    chat.send("Hey Codex");
    expect(launch.mock.calls[1][0]).toBe("codex");
    expect(launch.mock.calls[1][1]).not.toContain("resume");
    expect(() => chat.reset("gpt")).toThrow(expect.objectContaining({ code: "invalid_tool" }));
  });
  it("stops a reply that takes too long", async () => {
    const { chat, children } = fixture({ timeoutMs: 5 });
    chat.send("Hi");
    await settled();
    expect(chat.view().busy).toBe(false);
    children[0].reply("", 1);
    await settled();
    expect(chat.view().messages[1].role).toBe("error");
  });
  it("rejects empty messages and a missing tool", () => {
    const { chat } = fixture();
    expect(() => chat.send("   ")).toThrow(expect.objectContaining({ code: "chat_message" }));
    const missing = createChat({ binary: () => undefined });
    chats.push(missing);
    expect(() => missing.send("Hi")).toThrow(expect.objectContaining({ code: "tool_unavailable" }));
    expect(missing.view().messages).toEqual([]);
  });
});

describe("chat API", () => {
  it("sends through the dashboard and returns the reply on a later read", async () => {
    const { startDashboard } = await import("../src/dashboard.js");
    const { request } = await import("http");
    const { spawn } = await import("child_process");
    const dashboard = await startDashboard({ port: 0, chat: { binary: (tool) => tool,
      spawn: (_command, _args, env, cwd) => spawn(process.execPath, ["-e", `let t = ""; process.stdin.on("data", (c) => t += c).on("end", () => console.log(JSON.stringify({ result: "echo: " + t, session_id: "s1" })));`], { env, cwd, stdio: "pipe" }) } });
    const call = (method: string, path: string, body?: unknown) => new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: dashboard.port, path: "/api/" + path, method, headers: { "Content-Type": "application/json", "X-Codec-Token": dashboard.token } }, (res) => {
        let text = ""; res.setEncoding("utf8"); res.on("data", (c) => { text += c; }); res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(text) }));
      }); req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    try {
      expect((await call("POST", "chat", { text: "ping" })).status).toBe(202);
      let view: any;
      for (let i = 0; i < 100; i++) { view = (await call("GET", "chat")).json; if (!view.busy) break; await new Promise((r) => setTimeout(r, 50)); }
      expect(view.messages.map((m: any) => m.text)).toEqual(["ping", "echo: ping"]);
      expect((await call("POST", "chat", { text: "" })).json.code).toBe("chat_message");
      expect((await call("POST", "chat/model", { model: "opus" })).json).toMatchObject({ model: "opus" });
      expect((await call("POST", "chat/new", { tool: "codex" })).json).toMatchObject({ tool: "codex", busy: false, messages: [] });
    } finally { await dashboard.close(); }
  });
});

describe("saved chats", () => {
  it("keeps several chats, opens any of them, and reuses an empty open chat for New chat", async () => {
    const { chat, children } = fixture();
    chat.send("Why is Naive Bayes overfitting on my training data?");
    children[0].reply('{"result":"Leakage","session_id":"s1"}');
    await settled();
    const first = chat.view();
    expect(first.title).toBe("Why is Naive Bayes overfitting on my training data?");
    const second = chat.reset("codex");
    expect(second.id).not.toBe(first.id);
    expect(chat.reset("claude").id).toBe(second.id);
    chat.send("Geology exam review");
    children[1].reply('{"result":"Sure","session_id":"s2"}');
    await settled();
    expect(chat.view().chats.map((c) => c.title)).toEqual(["Geology exam review", "Why is Naive Bayes overfitting on my training data?"]);
    expect(chat.view(first.id)).toMatchObject({ id: first.id, messages: [{ text: expect.stringContaining("Naive") }, { text: "Leakage" }] });
    expect(chat.view().id).toBe(first.id);
    expect(() => chat.view("chat-missing")).toThrow(expect.objectContaining({ code: "chat_not_found" }));
  });
  it("renames, tags and deletes chats", async () => {
    const { chat, children } = fixture();
    chat.send("Hi");
    children[0].reply('{"result":"Hello","session_id":"s1"}');
    await settled();
    const { id } = chat.view();
    expect(chat.rename(id, "  CS 422 help ").title).toBe("CS 422 help");
    expect(() => chat.rename(id, "")).toThrow(expect.objectContaining({ code: "chat_title" }));
    expect(chat.tag(id, { area: "class", className: "CS 422" })).toMatchObject({ area: "class", className: "CS 422" });
    chat.send("More");
    children[1].reply('{"result":"Ok","session_id":"s1"}');
    await settled();
    expect(chat.view().title).toBe("CS 422 help");
    const after = chat.remove(id);
    expect(after.id).not.toBe(id);
    expect(after.messages).toEqual([]);
    expect(after.chats).toEqual([]);
  });
  it("brings the old single conversation over as the first saved chat", async () => {
    const { mkdirSync } = await import("fs");
    const { codecHome } = await import("../src/store.js");
    mkdirSync(join(codecHome(), "chat"), { recursive: true });
    writeFileSync(join(codecHome(), "chat", "chat.json"), JSON.stringify({ tool: "codex", session: "t9",
      messages: [{ role: "user", text: "Old question", at: "2026-11-01T10:00:00Z" }, { role: "assistant", text: "Old answer", at: "2026-11-01T10:01:00Z" }] }));
    const { chat, launch } = fixture();
    expect(chat.view()).toMatchObject({ tool: "codex", title: "Old question", messages: [{ text: "Old question" }, { text: "Old answer" }] });
    chat.send("Follow up");
    expect(launch.mock.calls[0][1]).toContain("t9");
  });
});
