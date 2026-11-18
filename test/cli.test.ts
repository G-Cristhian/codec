import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "fs";
import { join } from "path";
import { cleanupTemps, cli, makeRepo, useIsolatedHome, waitFor } from "./helpers.js";

/**
 * End-to-end through the real `codec` command. Every cli() call is a brand
 * new process, so each one is effectively a codec restart: whatever it
 * reports came from disk, not memory.
 */
describe("codec CLI (restart recovery)", () => {
  let home: string;
  beforeEach(() => { home = useIsolatedHome(`sleep 2; echo done`); });
  afterEach(cleanupTemps);

  const status = () => JSON.parse(cli(["status", "--json"]).stdout) as Array<Record<string, unknown>>;

  it("keeps runs visible and tracked across separate codec processes", async () => {
    process.env.CODEC_AGENT_COMMAND = 'until [ -f "$CODEC_HOME/finish" ]; do sleep 0.05; done; echo done';
    expect(cli(["project", "add", makeRepo("alpha")]).code).toBe(0);
    expect(cli(["project", "add", makeRepo("beta"), "--name", "beta"]).code).toBe(0);
    expect(cli(["project", "list"]).stdout).toMatch(/alpha[\s\S]*beta/);

    try {
      const r1 = cli(["run", "alpha", "--agent", "claude", "--task", "one"]);
      const r2 = cli(["run", "beta", "--agent", "codex", "--task", "two"]);
      expect(r1.code, r1.stderr).toBe(0);
      expect(r2.code, r2.stderr).toBe(0);

      // The processes that started the runs have exited; a new one still sees both running.
      const runs = status();
      expect(runs.map((r) => [r.project, r.agent, r.state])).toEqual([
        ["alpha", "claude", "running"],
        ["beta", "codex", "running"],
      ]);
      const table = cli(["status"]).stdout;
      expect(table).toContain("2 run(s), 2 running");
    } finally {
      writeFileSync(join(home, "finish"), "");
      await Promise.all(status().map((run) => waitFor(run.runId as string)));
    }

    const runs = status();
    expect(runs.map((r) => r.state)).toEqual(["done", "done"]);

    // Finished runs no longer block removal.
    expect(cli(["project", "remove", "alpha"]).code).toBe(0);
  });

  it("reports errors with a non-zero exit code", () => {
    const r = cli(["run", "ghost", "--agent", "claude", "--task", "x"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no project named "ghost"/);
    expect(cli(["bogus"]).code).toBe(1);
    expect(cli(["help"]).stdout).toContain("codec run <project>");
    expect(cli(["dashboard", "--port", "abc"]).stderr).toMatch(/invalid --port/);
  });

  it("refuses to remove a project with running agents", () => {
    cli(["project", "add", makeRepo("alpha")]);
    process.env.CODEC_AGENT_COMMAND = "sleep 30";
    const started = cli(["run", "alpha", "--agent", "claude", "--task", "x"]);
    const runId = /started (run-[0-9a-f]+)/.exec(started.stdout)![1];
    const r = cli(["project", "remove", "alpha"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/running agent/);
    expect(cli(["stop", runId]).code).toBe(0);
    expect(cli(["project", "remove", "alpha"]).code).toBe(0);
  });
});
