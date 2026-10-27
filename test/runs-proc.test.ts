import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { realOs } from "../src/proc.js";
import { getRunStatus, type RunRecord } from "../src/runs.js";
import { cleanupTemps, useIsolatedHome } from "./helpers.js";

const originalPlatform = realOs.platform;
afterEach(() => {
  vi.restoreAllMocks();
  realOs.platform = originalPlatform;
  cleanupTemps();
});

it.each([true, false])("macOS timeout recovery only signals verified saved groups (owned: %s)", (owned) => {
  const home = useIsolatedHome("");
  const runId = "run-darwin";
  const directory = join(home, "runs", runId);
  mkdirSync(directory, { recursive: true });
  const record: RunRecord = {
    runId, project: "test", projectPath: home, agent: "codex", task: "test",
    branch: "test", worktree: home, baseSha: "test", command: "sleep 120",
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    deadline: new Date(Date.now() - 60_000).toISOString(), timeLimitMinutes: 1,
    pid: 4000,
  };
  writeFileSync(join(directory, "run.json"), JSON.stringify(record));
  writeFileSync(join(directory, "agent_group"), "5000");
  realOs.platform = "darwin";
  let live = true;
  vi.spyOn(realOs, "readFile").mockImplementation(() => { throw new Error("no /proc on macOS"); });
  vi.spyOn(realOs, "exec").mockImplementation((cmd, args) => {
    expect(cmd).toBe("ps");
    if (args[0] === "-A") return live ? "5001 5000 S+\n" : "";
    if (args[0] === "eww") {
      expect(args).toEqual(["eww", "-p", "5001", "-o", "command="]);
      return `sleep 120 CODEC_RUN_DIR=${owned ? directory : "/another/run"}`;
    }
    // The original wrapper has exited; its child remains in the saved group.
    return "";
  });
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    live = false;
    return true;
  });

  expect(getRunStatus(runId)?.state).toBe("timed_out");
  if (owned) {
    expect(kill.mock.calls).toEqual([[-5000, "SIGTERM"]]);
  } else {
    expect(kill).not.toHaveBeenCalled();
  }
});
