import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { checkpointIdentity, getSettings, saveIdentity } from "../src/settings.js";
import { addProject, git } from "../src/registry.js";
import { setUpTracking } from "../src/folders.js";
import { getRunStatus, listRuns, startRun, stopRun } from "../src/runs.js";
import { modelFromClaudeStream } from "../src/claude-stream.js";
import { cleanupTemps, cli, makeRepo, tempDir, useIsolatedHome, waitFor } from "./helpers.js";

let home: string;
let globalConfig: string;
const owner = { name: "Project Owner", email: "owner@example.invalid" };
beforeEach(() => {
  home = useIsolatedHome("true");
  globalConfig = join(tempDir(), "global-config");
  vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});
afterEach(() => {
  for (const run of listRuns({ state: "running" })) stopRun(run.runId);
  vi.unstubAllEnvs();
  cleanupTemps();
});

describe("checkpoint identity", () => {
  it("prefills from global config and persists an edited identity across CLI invocations", () => {
    writeFileSync(globalConfig, "[user]\nname = Global Owner\nemail = global@example.invalid\n");
    expect(getSettings().identity).toEqual({ name: "Global Owner", email: "global@example.invalid" });
    expect(cli(["settings", "identity", "--name", owner.name, "--email", owner.email]).code).toBe(0);
    expect(getSettings()).toEqual({ identity: owner, setupFinished: false, classes: [] });
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf-8"))).toEqual({ identity: owner });
    writeFileSync(globalConfig, "[user]\nname = Other\nemail = other@example.invalid\n");
    expect(getSettings().identity).toEqual(owner);
  });
  it("rejects incomplete or invalid settings without replacing the saved identity", () => {
    saveIdentity(owner);
    for (const identity of [{ name: "", email: owner.email }, { name: owner.name, email: "missing" }, { name: "A\nB", email: owner.email }]) {
      expect(() => saveIdentity(identity)).toThrowError(expect.objectContaining({ code: "invalid_identity" }));
    }
    expect(getSettings().identity).toEqual(owner);
  });
  for (const agent of ["claude", "codex"] as const) {
    it(`${agent}: supplies all four identity variables and uses them for the helper's checkpoint`, async () => {
      process.env.CODEC_AGENT_COMMAND = 'env > identity.txt; echo saved > saved.txt; git add saved.txt; git -c commit.gpgSign=false -c core.hooksPath=/dev/null commit -qm saved';
      for (const key of ["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"]) vi.stubEnv(key, "Wrong Owner");
      for (const key of ["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"]) vi.stubEnv(key, "wrong@example.invalid");
      const repo = makeRepo("project");
      addProject(repo);
      saveIdentity(owner);
      const run = startRun({ project: "project", agent, task: "Save a file" });
      expect((await waitFor(run.runId)).state).toBe("done");
      const env = readFileSync(join(run.worktree, "identity.txt"), "utf-8").split("\n");
      for (const kind of ["AUTHOR", "COMMITTER"]) {
        expect(env).toContain(`GIT_${kind}_NAME=${owner.name}`);
        expect(env).toContain(`GIT_${kind}_EMAIL=${owner.email}`);
      }
      expect(git(run.worktree, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"]).out)
        .toBe(`${owner.name} <${owner.email}>|${owner.name} <${owner.email}>`);
    });
  }
  it("falls back to the project's own identity without saving or inventing one", async () => {
    process.env.CODEC_AGENT_COMMAND = 'printf "%s <%s>" "$GIT_AUTHOR_NAME" "$GIT_AUTHOR_EMAIL"';
    const repo = makeRepo("local");
    addProject(repo);
    expect(checkpointIdentity(repo)).toEqual({ name: "Codec Test", email: "test@example.invalid" });
    const run = startRun({ project: "local", agent: "codex", task: "Check" });
    expect((await waitFor(run.runId)).state).toBe("done");
    expect(readFileSync(join(home, "runs", run.runId, "output.log"), "utf-8")).toContain("Codec Test <test@example.invalid>");
    expect(getSettings().identity).toEqual({ name: "", email: "" });
  });
  it("fails with identity_missing before creating any workspace or run", () => {
    const repo = makeRepo("missing");
    addProject(repo);
    git(repo, ["config", "--unset", "user.name"]);
    git(repo, ["config", "--unset", "user.email"]);
    expect(() => startRun({ project: "missing", agent: "claude", task: "Check" }))
      .toThrowError(expect.objectContaining({ code: "identity_missing", status: 409 }));
    expect(listRuns()).toEqual([]);
    expect(readdirSync(home)).not.toContain("worktrees");
  });
  it("uses the saved owner for the first checkpoint, overriding local and inherited identity", () => {
    const dir = tempDir();
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.name", "Local Name"]);
    git(dir, ["config", "user.email", "local@example.invalid"]);
    vi.stubEnv("GIT_AUTHOR_NAME", "Wrong Name");
    vi.stubEnv("GIT_COMMITTER_EMAIL", "wrong@example.invalid");
    saveIdentity(owner);
    writeFileSync(join(dir, "README.md"), "keep");
    setUpTracking(dir);
    expect(git(dir, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"]).out)
      .toBe(`${owner.name} <${owner.email}>|${owner.name} <${owner.email}>`);
    expect(git(dir, ["config", "--local", "user.name"]).out).toBe("Local Name");
  });
});

describe("model actually used", () => {
  it("records Claude's initialization model durably while retaining the default model choice", async () => {
    process.env.CODEC_AGENT_COMMAND = `printf '%s\n' '{"type":"system","subtype":"init","model":"claude-haiku-5-5"}'`;
    addProject(makeRepo("model"));
    const run = startRun({ project: "model", agent: "claude", task: "Check" });
    const done = await waitFor(run.runId);
    expect(done.model).toBeUndefined();
    expect(done.actualModel).toBe("claude-haiku-5-5");
    expect(JSON.parse(readFileSync(join(home, "runs", run.runId, "run.json"), "utf-8")).actualModel).toBe("claude-haiku-5-5");
    writeFileSync(join(home, "runs", run.runId, "output.log"), "");
    expect(getRunStatus(run.runId)?.actualModel).toBe("claude-haiku-5-5");
  });
  it("ignores non-init, incomplete, malformed, empty, and non-string model events", () => {
    const raw = 'plain\n{"type":"assistant","model":"guess"}\n{"type":"system","subtype":"init","model":123}\n{"type":"system","subtype":"init","model":""}\n{"type":';
    expect(modelFromClaudeStream(raw)).toBeUndefined();
  });
});
