import { execFile, execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { promisify } from "util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodecError } from "../src/errors.js";
import { listMessages, markRead, postMessage, receiveMessages, type MessageRecord } from "../src/messages.js";
import { addMember, addTeam, deleteMember } from "../src/org.js";
import { addProject } from "../src/registry.js";
import { listRuns, runOutput, startRun, stopRun } from "../src/runs.js";
import * as store from "../src/store.js";
import { S } from "../src/strings.js";
import { cleanupTemps, makeRepo, useIsolatedHome, waitFor } from "./helpers.js";

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8" }).trim();
const send = (body: string, to = "red/reader", from = "owner") => postMessage({ from, to, body });
const inbox = () => store.readJson<MessageRecord[]>(store.inboxFile("red", "reader"), []);
const start = (member = "red/reader") => startRun({ project: "alpha", member, task: "Check messages" });
let home: string;
let project: string;

beforeEach(() => {
  home = useIsolatedHome("true");
  project = makeRepo("alpha");
  addProject(project);
  addTeam({ name: "red", projects: ["alpha"] });
  addMember("red", { name: "reader", tool: "codex" });
  addMember("red", { name: "writer", tool: "claude" });
  addTeam({ name: "blue", projects: ["alpha"] });
  addMember("blue", { name: "reader", tool: "codex" });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const run of listRuns({ state: "running" })) stopRun(run.runId);
  cleanupTemps();
});

describe("helper messages", () => {
  it("queues a durable unread record for a helper without a task", () => {
    expect(listMessages()).toEqual([]);
    const message = send("Please check the tests.", "red/reader", "red/writer");
    expect(message).toEqual({
      id: expect.any(String), from: "red/writer", to: "red/reader", body: "Please check the tests.",
      sentAt: expect.any(String), read: false,
    });
    expect(Number.isNaN(Date.parse(message.sentAt))).toBe(false);
    expect(store.inboxFile("red", "reader")).toBe(join(home, "messages", "red", "reader.json"));
    expect(inbox()).toEqual([message]);
    expect(listMessages()).toEqual([message]);
  });

  it("delivers to a running helper immediately and preserves earlier entries", async () => {
    process.env.CODEC_AGENT_COMMAND = "until grep -q 'Second note' messages.md; do sleep 0.05; done; cat messages.md";
    const run = start();
    const first = send("First note", "red/reader", "red/writer");
    const second = send("Second note");
    expect(first).toMatchObject({ runId: run.runId, deliveredAt: expect.any(String), read: false });
    expect(second).toMatchObject({ runId: run.runId, deliveredAt: expect.any(String), read: false });
    expect(inbox()).toEqual([first, second]);
    const text = readFileSync(join(run.worktree, "messages.md"), "utf-8");
    expect(text).toContain(`From red/writer — ${first.sentAt}`);
    expect(text).toContain(`From owner — ${second.sentAt}`);
    expect(text.indexOf(first.body)).toBeLessThan(text.indexOf(second.body));
    expect((await waitFor(run.runId)).state).toBe("done");
    expect(runOutput(run.runId)).toContain(text.trim());
    expect(git(run.worktree, "rev-parse", "HEAD")).toBe(run.baseSha);
    expect(git(run.worktree, "status", "--porcelain")).toBe("");
    expect(git(run.worktree, "check-ignore", "messages.md", "messages.md.123.abc.tmp").split("\n"))
      .toEqual(["messages.md", "messages.md.123.abc.tmp"]);
    markRead([first.id]);
    expect(inbox()).toEqual([{ ...first, read: true }, second]);
  });

  it.each(["red/reader", "red/writer"])("delivers the inbox before %s starts and gives it message instructions", async (member) => {
    const first = send("Read this before working.", member);
    const second = send("Keep the line breaks.\n\nAnd {literal braces}.", member, "blue/reader");
    process.env.CODEC_AGENT_COMMAND = 'cat messages.md > "$CODEC_RUN_DIR/seen-messages.md"; cat "$CODEC_RUN_DIR/instructions.md" > "$CODEC_RUN_DIR/seen-instructions.md"';
    const run = start(member);
    expect((await waitFor(run.runId)).state).toBe("done");
    const text = readFileSync(join(home, "runs", run.runId, "seen-messages.md"), "utf-8");
    expect(text).toContain(first.body);
    expect(text).toContain(second.body);
    expect(readFileSync(join(home, "runs", run.runId, "seen-instructions.md"), "utf-8"))
      .toContain(S.helperInstructions.messages);
    expect(listMessages({ to: member })).toEqual([
      expect.objectContaining({ id: second.id, runId: run.runId, deliveredAt: expect.any(String), read: false }),
      expect.objectContaining({ id: first.id, runId: run.runId, deliveredAt: expect.any(String), read: false }),
    ]);
  });

  it("queues after a helper stops and delivers only new messages on its next task", async () => {
    process.env.CODEC_AGENT_COMMAND = "sleep 60";
    const firstRun = start();
    const old = send("Already delivered");
    stopRun(firstRun.runId);
    const queued = send("For the next task");
    expect(queued.deliveredAt).toBeUndefined();
    expect(readFileSync(join(firstRun.worktree, "messages.md"), "utf-8")).not.toContain(queued.body);
    process.env.CODEC_AGENT_COMMAND = "cat messages.md";
    const nextRun = start();
    await waitFor(nextRun.runId);
    expect(runOutput(nextRun.runId)).toContain(queued.body);
    expect(runOutput(nextRun.runId)).not.toContain(old.body);
    expect(inbox().map((message) => message.runId)).toEqual([firstRun.runId, nextRun.runId]);
  });

  it("keeps quick tasks and other helpers' tasks out of a queued inbox", async () => {
    const message = send("Only red/reader should see this");
    const quick = startRun({ project: "alpha", agent: "codex", task: "Quick task" });
    const other = start("blue/reader");
    await Promise.all([waitFor(quick.runId), waitFor(other.runId)]);
    expect(existsSync(join(quick.worktree, "messages.md"))).toBe(false);
    expect(readFileSync(join(home, "runs", quick.runId, "instructions.md"), "utf-8"))
      .not.toContain(S.helperInstructions.messages);
    expect(readFileSync(join(other.worktree, "messages.md"), "utf-8")).not.toContain(message.body);
    expect(inbox()).toEqual([message]);
  });

  it("uses the newest running task when a helper has several tasks", () => {
    process.env.CODEC_AGENT_COMMAND = "sleep 60";
    const older = start();
    const newer = start();
    const message = send("For the newest task");
    expect(message.runId).toBe(newer.runId);
    expect(readFileSync(join(older.worktree, "messages.md"), "utf-8")).not.toContain(message.body);
    expect(readFileSync(join(newer.worktree, "messages.md"), "utf-8")).toContain(message.body);
    stopRun(newer.runId);
    expect(send("For the remaining task").runId).toBe(older.runId);
  });

  it("lists newest first with helper, direction and unread filters and persists read flags", () => {
    vi.spyOn(Date.prototype, "toISOString")
      .mockReturnValueOnce("2026-01-01T00:00:00.000Z")
      .mockReturnValueOnce("2026-01-02T00:00:00.000Z")
      .mockReturnValueOnce("2026-01-03T00:00:00.000Z");
    const first = send("One");
    const second = send("Two", "red/writer", "red/reader");
    const third = send("Three", "blue/reader");
    expect(listMessages()).toEqual([third, second, first]);
    expect(listMessages({ helper: "red/reader" })).toEqual([second, first]);
    expect(listMessages({ to: "red/reader" })).toEqual([first]);
    expect(listMessages({ from: "red/reader" })).toEqual([second]);
    markRead([first.id, third.id, "unknown-id"]);
    markRead([first.id]);
    expect(listMessages({ unread: true })).toEqual([second]);
    expect(listMessages({ helper: "red/reader", unread: true })).toEqual([second]);
    expect(inbox()).toEqual([{ ...first, read: true }]);
    expect(inbox()[0].deliveredAt).toBeUndefined();
    deleteMember("red", "reader");
    expect(listMessages({ to: "red/reader" })).toEqual([{ ...first, read: true }]);
  });

  it("receives idempotently and preserves a read flag when delivering a queued message", () => {
    const queued = send("Already read in the inbox");
    markRead([queued.id]);
    process.env.CODEC_AGENT_COMMAND = "sleep 60";
    const run = start();
    const before = readFileSync(join(run.worktree, "messages.md"), "utf-8");
    expect(receiveMessages("red/reader", run.runId)).toEqual([]);
    expect(readFileSync(join(run.worktree, "messages.md"), "utf-8")).toBe(before);
    expect(inbox()[0]).toMatchObject({ read: true, runId: run.runId, deliveredAt: expect.any(String) });
  });

  it.each([
    [{ from: "owner", to: "red/missing", body: "Hi" }, "member_not_found"],
    [{ from: "owner", to: "missing/reader", body: "Hi" }, "team_not_found"],
    [{ from: "red/missing", to: "red/reader", body: "Hi" }, "member_not_found"],
    [{ from: "missing/writer", to: "red/reader", body: "Hi" }, "team_not_found"],
    [{ from: "owner", to: "reader", body: "Hi" }, "invalid_member"],
    [{ from: "owner", to: "red/../../escape", body: "Hi" }, "invalid_member"],
    [{ from: "owner", to: "red/reader", body: " \n\t" }, "missing_message"],
    [{ from: "owner", to: "red/reader", body: "" }, "missing_message"],
  ])("rejects invalid input %j before saving", (input, code) => {
    expect(() => postMessage(input)).toThrowError(CodecError);
    expect(() => postMessage(input)).toThrowError(expect.objectContaining({ code }));
    expect(listMessages()).toEqual([]);
    expect(existsSync(store.messagesDir())).toBe(false);
  });

  it("refuses delivery to a missing, stopped or mismatched task", () => {
    process.env.CODEC_AGENT_COMMAND = "sleep 60";
    const run = start("blue/reader");
    const queued = send("Stay queued");
    expect(() => receiveMessages("red/reader", run.runId)).toThrowError(expect.objectContaining({ code: "message_run_mismatch" }));
    expect(() => receiveMessages("red/reader", "../missing")).toThrowError(expect.objectContaining({ code: "run_not_found" }));
    stopRun(run.runId);
    expect(() => receiveMessages("blue/reader", run.runId)).toThrowError(expect.objectContaining({ code: "run_not_running" }));
    expect(inbox()).toEqual([queued]);
  });

  it("keeps a message queued if delivery fails and retries without duplicating entries", () => {
    process.env.CODEC_AGENT_COMMAND = "sleep 60";
    const run = start();
    const save = store.writeJsonAtomic;
    const write = vi.spyOn(store, "writeJsonAtomic").mockImplementation((file, value) => {
      if (file === store.inboxFile("red", "reader") && (value as MessageRecord[]).some((message) => message.deliveredAt)) {
        throw new Error("Simulated failed inbox save");
      }
      save(file, value);
    });
    expect(() => send("Retry this once")).toThrow("Simulated failed inbox save");
    expect(inbox()[0].deliveredAt).toBeUndefined();
    write.mockRestore();
    const received = receiveMessages("red/reader", run.runId);
    expect(received).toEqual([expect.objectContaining({ body: "Retry this once", runId: run.runId })]);
    expect(readFileSync(join(run.worktree, "messages.md"), "utf-8").split("Retry this once")).toHaveLength(2);
    expect(receiveMessages("red/reader", run.runId)).toEqual([]);
  });

  it("refuses to overwrite a project's tracked messages.md", () => {
    writeFileSync(join(project, "messages.md"), "Project documentation\n");
    git(project, "add", "messages.md");
    git(project, "commit", "-m", "Add project documentation");
    const queued = send("Keep queued");
    expect(() => start()).toThrowError(expect.objectContaining({ code: "message_file_conflict" }));
    expect(listRuns()[0]).toMatchObject({ state: "failed", lostAt: expect.any(String) });
    expect(listRuns()[0].pid).toBeUndefined();
    expect(readFileSync(join(listRuns()[0].worktree, "messages.md"), "utf-8")).toBe("Project documentation\n");
    expect(inbox()).toEqual([queued]);
  });

  it("serializes posting, receiving and marking read across separate processes", async () => {
    process.env.CODEC_AGENT_COMMAND = "sleep 60";
    const run = start();
    const initial = send("Initial note");
    const source = `import { postMessage, receiveMessages, markRead } from ${JSON.stringify(new URL("../src/messages.ts", import.meta.url).href)};
      const [worker, runId, initial] = process.argv.slice(1);
      for (let n = 0; n < 4; n++) postMessage({ from: "red/writer", to: "red/reader", body: worker + ":" + n });
      receiveMessages("red/reader", runId);
      markRead([initial]);`;
    await Promise.all(["a", "b", "c"].map((worker) => promisify(execFile)(process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source, worker, run.runId, initial.id], { env: { ...process.env } })));
    const messages = listMessages();
    expect(messages).toHaveLength(13);
    expect(new Set(messages.map((message) => message.id)).size).toBe(13);
    expect(messages.every((message) => message.runId === run.runId && message.deliveredAt)).toBe(true);
    expect(messages.find((message) => message.id === initial.id)?.read).toBe(true);
    const text = readFileSync(join(run.worktree, "messages.md"), "utf-8");
    for (const message of messages) expect(text.split(message.body)).toHaveLength(2);
    expect(listMessages({ unread: true })).toHaveLength(12);
  });
});
