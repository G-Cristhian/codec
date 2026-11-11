import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { laneOf, projectView } from "../src/dashboard.js";
import { listMessages, type MessageRecord } from "../src/messages.js";
import { addMember, addSpecialist, addTeam } from "../src/org.js";
import { addProject } from "../src/registry.js";
import { cleanRun, getRunStatus, listRuns, runOutput, startRun, stopRun, type RunRecord } from "../src/runs.js";
import { inboxFile, readJson } from "../src/store.js";
import { S, wording } from "../src/strings.js";
import { cleanupTemps, cli, makeRepo, useIsolatedHome, waitFor } from "./helpers.js";

const command = '"$CODEC_NODE" "$CODEC_CLI"';
const quote = (text: string) => "'" + text.replace(/'/g, "'\\''") + "'";
const start = (member = "red/writer") => startRun({ project: "alpha", member, task: "Coordinate with the helpers" });
let home: string;

beforeEach(() => {
  home = useIsolatedHome("true");
  addProject(makeRepo("alpha"));
  addTeam({ name: "red", projects: ["alpha"] });
  addMember("red", { name: "reader", tool: "codex" });
  addMember("red", { name: "writer", tool: "claude" });
});

afterEach(() => {
  for (const run of listRuns({ state: "running" })) stopRun(run.runId);
  cleanupTemps();
});

describe("commands inside helper tasks", () => {
  it.each(["red/writer", "red/reader"])("delivers a message from running %s to another running helper", async (member) => {
    const target = member === "red/writer" ? "red/reader" : "red/writer";
    process.env.CODEC_AGENT_COMMAND = "sleep 60";
    const recipient = start(target);
    const body = "Please check the tests.\n\nKeep 'quotes', $variables, `backticks`, and {braces}.";
    process.env.CODEC_AGENT_COMMAND = `${command} message ${target} ${quote(body)} && sleep 60`;
    const sender = start(member);

    await vi.waitFor(() => expect(runOutput(sender.runId))
      .toContain(wording(S.cli.messageSent, { helper: target })), { timeout: 10_000 });
    expect(listMessages({ to: target })).toHaveLength(1);
    const [message] = listMessages({ to: target });
    expect(message).toMatchObject({
      from: member, to: target, body, runId: recipient.runId, deliveredAt: expect.any(String), read: false,
    });
    expect(getRunStatus(sender.runId)?.state).toBe("running");
    expect(getRunStatus(recipient.runId)?.state).toBe("running");
    expect(readFileSync(join(recipient.worktree, "messages.md"), "utf-8"))
      .toContain(`From ${member} — ${message.sentAt}\n\n${body}`);
  });

  it("queues a helper's message and delivers it before the recipient's next task starts", async () => {
    // Leading dashes are message text, not CLI options.
    process.env.CODEC_AGENT_COMMAND = `${command} message red/reader "--help"`;
    const sender = start();
    expect((await waitFor(sender.runId)).state).toBe("done");
    const queued = readJson<MessageRecord[]>(inboxFile("red", "reader"), []);
    expect(queued).toEqual([expect.objectContaining({ from: "red/writer", to: "red/reader", body: "--help", read: false })]);
    expect(queued[0].deliveredAt).toBeUndefined();
    expect(queued[0].runId).toBeUndefined();

    process.env.CODEC_AGENT_COMMAND = 'cat messages.md > "$CODEC_RUN_DIR/seen-messages.md"';
    const recipient = start("red/reader");
    expect((await waitFor(recipient.runId)).state).toBe("done");
    expect(readFileSync(join(home, "runs", recipient.runId, "seen-messages.md"), "utf-8"))
      .toContain(`From red/writer — ${queued[0].sentAt}\n\n--help`);
    expect(listMessages({ to: "red/reader" })).toEqual([
      { ...queued[0], runId: recipient.runId, deliveredAt: expect.any(String) },
    ]);
  });

  it("moves stuck work to Needs you and clears it with progress or done while the helper keeps running", async () => {
    process.env.CODEC_AGENT_COMMAND = `set -e
${command} report stuck "Please choose the expected behavior."
until [ -f "$CODEC_RUN_DIR/resume" ]; do sleep 0.05; done
${command} report progress
until [ -f "$CODEC_RUN_DIR/ask-again" ]; do sleep 0.05; done
${command} report stuck "Please review the final choice."
until [ -f "$CODEC_RUN_DIR/finish" ]; do sleep 0.05; done
${command} report done
until [ -f "$CODEC_RUN_DIR/exit" ]; do sleep 0.05; done`;
    const run = start();
    const dir = join(home, "runs", run.runId);
    const reported = async (state: string, note: string, lane: "needsYou" | "working") => {
      await vi.waitFor(() => expect(getRunStatus(run.runId)?.helperStatus).toMatchObject({ state, note }), { timeout: 10_000 });
      const status = getRunStatus(run.runId)!;
      expect(status.state).toBe("running");
      expect(laneOf(status)).toBe(lane);
      expect(Number.isNaN(Date.parse(status.helperStatus!.at))).toBe(false);
      expect(projectView("alpha").lanes[lane]).toEqual([
        expect.objectContaining({ runId: run.runId, state: "running", helperStatus: status.helperStatus }),
      ]);
      expect(readJson<RunRecord | undefined>(join(dir, "run.json"), undefined))
        .toMatchObject({ pid: run.pid, team: "red", member: "writer", helperStatus: status.helperStatus });
      return status.helperStatus;
    };

    await reported("stuck", "Please choose the expected behavior.", "needsYou");
    writeFileSync(join(dir, "resume"), "");
    await reported("progress", "", "working");
    writeFileSync(join(dir, "ask-again"), "");
    await reported("stuck", "Please review the final choice.", "needsYou");
    writeFileSync(join(dir, "finish"), "");
    const last = await reported("done", "", "working");
    expect(existsSync(join(dir, "exit_code"))).toBe(false);
    writeFileSync(join(dir, "exit"), "");
    expect((await waitFor(run.runId)).state).toBe("done");
    const restarted = cli(["status", "--json"]);
    expect(restarted.code).toBe(0);
    expect(JSON.parse(restarted.stdout)).toEqual([expect.objectContaining({ helperStatus: last, state: "done" })]);
  });

  it.each(["progress", "done"])("saves an optional %s note verbatim", async (state) => {
    const note = "--help\nKeep {the choice} and 'quotes'.";
    process.env.CODEC_AGENT_COMMAND = `${command} report ${state} ${quote(note)}`;
    const run = start();
    expect((await waitFor(run.runId)).helperStatus).toMatchObject({ state, note });
    expect(getRunStatus(run.runId)?.state).toBe("done");
  });

  it.each([
    ["exit 0", "done", "inReview"],
    ["exit 3", "failed", "needsYou"],
    ["sleep 60", "stopped", "needsYou"],
  ] as const)("keeps the existing lane rules when a stuck helper finishes with %s", async (ending, state, lane) => {
    process.env.CODEC_AGENT_COMMAND = `${command} report stuck "Please review this." && echo work > change.txt; ${ending}`;
    const run = start();
    if (state === "stopped") {
      await vi.waitFor(() => expect(getRunStatus(run.runId)?.helperStatus?.state).toBe("stuck"), { timeout: 10_000 });
      stopRun(run.runId);
    }
    const finished = await waitFor(run.runId);
    expect(finished).toMatchObject({ state, helperStatus: { state: "stuck", note: "Please review this." } });
    expect(laneOf(finished)).toBe(lane);
    expect(laneOf(cleanRun(run.runId, { force: true }))).toBe("done");
  });

  it.each(["red/writer", "red/reader", "red/reviewer"])("gives %s both commands and the existing inbox instructions", async (member) => {
    addSpecialist({ name: "reviewer", specialty: "reviews", tool: "codex" });
    addMember("red", { name: "reviewer", specialist: "reviewer" });
    process.env.CODEC_AGENT_COMMAND = 'cat "$CODEC_RUN_DIR/instructions.md"; test -f "$CODEC_CLI"';
    const run = start(member);
    expect((await waitFor(run.runId)).state).toBe("done");
    const instructions = runOutput(run.runId);
    expect(instructions).toContain(S.helperInstructions.messages);
    expect(instructions).toContain(`${command} message <team/helper> "<text>"`);
    expect(instructions).toContain(`${command} report progress "<note>"`);
    expect(instructions).toContain(`${command} report stuck "<what you need>"`);
    expect(instructions).toContain(`${command} report done "<note>"`);
  });
});

describe("helper command errors", () => {
  it.each([undefined, "run-ffffffff", "../outside", "run-"])("rejects both commands outside a helper task (%s)", (runId) => {
    for (const args of [["message", "red/reader", "Hello"], ["report", "progress"]]) {
      const result = cli(args, { CODEC_RUN_ID: runId });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(S.errors.helper_task_required);
    }
    expect(listMessages()).toEqual([]);
  });

  it.each(["message red/reader Hello", "report progress"])("rejects %s in an unassigned task", async (args) => {
    process.env.CODEC_AGENT_COMMAND = `${command} ${args}`;
    const run = startRun({ project: "alpha", agent: "codex", task: "Unassigned task" });
    expect((await waitFor(run.runId)).exitCode).toBe(1);
    expect(runOutput(run.runId)).toContain(S.errors.helper_task_required);
    expect(getRunStatus(run.runId)?.helperStatus).toBeUndefined();
    expect(listMessages()).toEqual([]);
  });

  it("rejects both commands after a helper task has ended", async () => {
    const run = start();
    await waitFor(run.runId);
    for (const args of [["message", "red/reader", "Hello"], ["report", "done"]]) {
      const result = cli(args, { CODEC_RUN_ID: run.runId });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(S.errors.helper_task_required);
    }
    expect(getRunStatus(run.runId)?.helperStatus).toBeUndefined();
    expect(listMessages()).toEqual([]);
  });

  it.each([
    ['message red/missing "Hello"', S.errors.member_not_found],
    ['message missing/reader "Hello"', wording(S.errors.team_not_found, { name: "missing" })],
    ['message red/reader ""', S.errors.missing_message],
    ['message red/reader "   "', S.errors.missing_message],
    ["message red/reader", S.errors.missing_message],
    ["message", S.cli.messageUsage],
    ['message red/reader "Hi" extra', S.cli.messageUsage],
    ['report unknown "A note"', S.errors.invalid_helper_status],
    ["report", S.errors.invalid_helper_status],
    ["report stuck", S.errors.missing_stuck_note],
    ['report stuck "   "', S.errors.missing_stuck_note],
    ['report progress "Note" extra', S.cli.reportUsage],
  ])("rejects %s without saving a message or status", async (args, error) => {
    process.env.CODEC_AGENT_COMMAND = `${command} ${args}`;
    const run = start();
    expect((await waitFor(run.runId)).exitCode).toBe(1);
    expect(runOutput(run.runId)).toContain(error);
    expect(getRunStatus(run.runId)?.helperStatus).toBeUndefined();
    expect(listMessages()).toEqual([]);
  });
});
