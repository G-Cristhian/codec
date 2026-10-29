import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { createSetupChecker, findBinary, runCommand, type CommandRunner } from "../src/setup.js";
import { cleanupTemps, tempDir } from "./helpers.js";

const ok: CommandRunner = async (_command, args) => ({ status: 0, stdout: args[0] === "--version" ? "v1.2.3\n" : '{"loggedIn":true}' });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); cleanupTemps(); });

describe("setup checks", () => {
  for (const tool of ["claude", "codex"] as const) {
    const finder = (candidate: string) => candidate === tool ? `/tools/${tool}` : undefined;
    it(`${tool}: installed and signed in`, async () => {
      const runner = vi.fn<CommandRunner>(ok);
      const status = await createSetupChecker({ runner, findBinary: finder })();
      expect(status.ready).toBe(true);
      expect(status.tools.find((entry) => entry.tool === tool)).toEqual({ tool, installed: true, signedIn: true, version: "v1.2.3" });
      expect(runner).toHaveBeenCalledWith(`/tools/${tool}`, tool === "claude" ? ["auth", "status"] : ["login", "status"], 5000);
    });
    it(`${tool}: binary missing`, async () => {
      const runner = vi.fn<CommandRunner>(ok);
      const status = await createSetupChecker({ runner, findBinary: () => undefined })();
      const entry = status.tools.find((entry) => entry.tool === tool)!;
      expect(entry).toMatchObject({ installed: false, signedIn: null, problem: `${tool === "claude" ? "Claude" : "Codex"} isn't installed.` });
      expect(entry.fix).toBe(`Install ${tool === "claude" ? "Claude" : "Codex"}, then press Check again.`);
      expect(status.ready).toBe(false);
      expect(runner).not.toHaveBeenCalled();
    });
    it(`${tool}: signed out`, async () => {
      const runner: CommandRunner = async (_command, args) => args[0] === "--version" ? { status: 0, stdout: "v1" } : { status: 1, stdout: tool === "claude" ? '{"loggedIn":false}' : "Not logged in" };
      const status = await createSetupChecker({ runner, findBinary: finder })();
      expect(status.tools.find((entry) => entry.tool === tool)).toMatchObject({ installed: true, signedIn: false,
        problem: `${tool === "claude" ? "Claude" : "Codex"} isn't signed in.`, fix: `Open ${tool === "claude" ? "Claude" : "Codex"} and sign in, then press Check again.` });
      expect(status.ready).toBe(false);
    });
    it(`${tool}: version timeout cannot hang a check`, async () => {
      vi.useFakeTimers();
      const check = createSetupChecker({ runner: () => new Promise(() => {}), findBinary: finder });
      const pending = check();
      await vi.advanceTimersByTimeAsync(5000);
      expect((await pending).tools.find((entry) => entry.tool === tool)).toMatchObject({ installed: false, signedIn: null });
    });
    it(`${tool}: auth timeout leaves installed tool signed out`, async () => {
      vi.useFakeTimers();
      const runner: CommandRunner = async (_command, args) => args[0] === "--version" ? { status: 0, stdout: "v1" } : new Promise(() => {});
      const pending = createSetupChecker({ runner, findBinary: finder })();
      await vi.advanceTimersByTimeAsync(5000);
      expect((await pending).tools.find((entry) => entry.tool === tool)).toMatchObject({ installed: true, signedIn: false });
    });
    it(`${tool}: version failure and rejected command are handled`, async () => {
      for (const runner of [async () => ({ status: 1, stdout: "bad" }), async () => { throw new Error("failed to execute"); }]) {
        const result = await createSetupChecker({ runner, findBinary: finder })();
        expect(result.tools.find((entry) => entry.tool === tool)?.installed).toBe(false);
      }
    });
  }
  it("reads Claude's loggedIn flag instead of trusting successful exit", async () => {
    for (const stdout of ['{"loggedIn":false}', "not JSON", '{"loggedIn":"true"}']) {
      const check = createSetupChecker({ findBinary: (tool) => tool === "claude" ? tool : undefined,
        runner: async (_cmd, args) => ({ status: 0, stdout: args[0] === "--version" ? "v1" : stdout }) });
      expect((await check()).ready).toBe(false);
    }
  });
  it("recognizes Codex's Logged in message on stderr", async () => {
    const check = createSetupChecker({ findBinary: (tool) => tool === "codex" ? tool : undefined,
      runner: async (_cmd, args) => ({ status: args[0] === "--version" ? 0 : 1, stdout: "v1", stderr: "Logged in using ChatGPT" }) });
    expect((await check()).ready).toBe(true);
  });
  it("caches for at most five seconds and supports fresh checks", async () => {
    vi.useFakeTimers();
    const runner = vi.fn<CommandRunner>(ok);
    const check = createSetupChecker({ runner, findBinary: (tool) => tool });
    await check();
    await check();
    expect(runner).toHaveBeenCalledTimes(4);
    await check(true);
    expect(runner).toHaveBeenCalledTimes(8);
    await vi.advanceTimersByTimeAsync(5000);
    await check();
    expect(runner).toHaveBeenCalledTimes(12);
  });
  it("uses the explicit engine command override without running shell text", async () => {
    vi.stubEnv("CODEC_AGENT_COMMAND", "sleep 30; echo fake");
    const result = await createSetupChecker()();
    expect(result.ready).toBe(true);
    expect(result.tools.every((tool) => tool.installed && tool.signedIn)).toBe(true);
  });
  it("finds executable files on PATH, skipping nonexecutables and directories", () => {
    const dir = tempDir();
    vi.stubEnv("PATH", dir);
    writeFileSync(join(dir, "claude"), "test");
    mkdirSync(join(dir, "codex"));
    expect(findBinary("claude")).toBeUndefined();
    expect(findBinary("codex")).toBeUndefined();
    chmodSync(join(dir, "claude"), 0o700);
    expect(findBinary("claude")).toBe(join(dir, "claude"));
  });
  it("real command runner returns output, errors, and kills timed out commands", async () => {
    expect(await runCommand(process.execPath, ["--version"], 5000)).toMatchObject({ status: 0, stdout: expect.stringMatching(/^v/) });
    expect((await runCommand("/missing/codec-command", [], 5000)).status).toBeNull();
    const start = Date.now();
    expect((await runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], 30)).status).toBeNull();
    expect(Date.now() - start).toBeLessThan(2000);
  });
  it("aborts a desktop-owned check when the app shuts down", async () => {
    const controller = new AbortController();
    const pending = runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], 30_000, controller.signal);
    controller.abort();
    expect((await pending).status).toBeNull();
  });
});
