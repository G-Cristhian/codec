import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, statSync } from "fs";
import { join } from "path";
import { addProject } from "../src/registry.js";
import { addMember, addTeam, resolveMember } from "../src/org.js";
import {
  agentDir,
  checkHarness,
  claudeMcpConfig,
  claudePermissions,
  codexOverrides,
  publicHarness,
  readHarness,
  writeHarness,
  DEFAULT_HARNESS,
} from "../src/harness.js";
import { agentCommand, removeMemberChecked, startRun, stopRun } from "../src/runs.js";
import { cleanupTemps, makeRepo, useIsolatedHome, waitFor } from "./helpers.js";

beforeEach(() => useIsolatedHome("true"));
afterEach(() => cleanupTemps());

const github = { name: "github", type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "ghp_secret" } };

describe("agent harness", () => {
  it("saves instructions and the harness in the agent's own private folder, and resolves them", () => {
    addProject(makeRepo("alpha"));
    addTeam({ name: "study", projects: [] });
    addMember("study", { name: "researcher", tool: "claude", specialty: "Finds sources" });
    writeHarness("study", "researcher", checkHarness("study", "researcher", { instructions: "  Cite every source.  ", access: "read", mcp: [github] }));
    const dir = agentDir("study", "researcher");
    expect(readFileSync(join(dir, "instructions.md"), "utf8")).toBe("Cite every source.\n");
    expect(statSync(join(dir, "harness.json")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const r = resolveMember("study", "researcher");
    expect(r).toMatchObject({ specialty: "Finds sources", instructions: "Cite every source.", projects: [], harness: { access: "read", isolated: false } });
    expect(r.harness.mcp[0].env).toEqual({ GITHUB_TOKEN: "ghp_secret" });
    removeMemberChecked("study", "researcher");
    expect(() => statSync(dir)).toThrow();
  });
  it("never sends MCP secrets back, and a blank value keeps the saved one", () => {
    writeHarness("t", "a", checkHarness("t", "a", { mcp: [github] }));
    expect(publicHarness(readHarness("t", "a")).mcp[0].env).toEqual({ GITHUB_TOKEN: "" });
    writeHarness("t", "a", checkHarness("t", "a", { mcp: [{ ...github, env: { GITHUB_TOKEN: "", OTHER: "x" } }] }));
    expect(readHarness("t", "a").mcp[0].env).toEqual({ GITHUB_TOKEN: "ghp_secret", OTHER: "x" });
  });
  it("rejects rules and servers it can't apply safely", () => {
    expect(() => checkHarness("t", "a", { access: "root" })).toThrow(expect.objectContaining({ code: "invalid_harness" }));
    expect(() => checkHarness("t", "a", { access: "custom", allow: "Bash(rm -rf /)\nnot a rule!" })).toThrow(expect.objectContaining({ code: "invalid_rule" }));
    expect(() => checkHarness("t", "a", { mcp: [{ name: "bad name", command: "x" }] })).toThrow(expect.objectContaining({ code: "invalid_mcp" }));
    expect(() => checkHarness("t", "a", { mcp: [{ name: "web", type: "http", url: "ftp://x" }] })).toThrow(expect.objectContaining({ code: "invalid_mcp" }));
    expect(() => checkHarness("t", "a", { mcp: [{ name: "a", command: "x" }, { name: "a", command: "y" }] })).toThrow(expect.objectContaining({ code: "invalid_mcp" }));
    expect(checkHarness("t", "a", { access: "custom", allow: "Read\nBash(npm test:*)\n\nRead" }).harness.allow).toEqual(["Read", "Bash(npm test:*)"]);
  });
  it("turns access levels into Claude rules that always allow Codec's own message and report commands", () => {
    expect(claudePermissions(DEFAULT_HARNESS)).toBeUndefined();
    const read = claudePermissions({ ...DEFAULT_HARNESS, access: "read", mcp: [{ name: "docs", type: "http", url: "https://x" }] })!;
    expect(read.deny).toEqual(expect.arrayContaining(["Edit", "Write"]));
    expect(read.allow).toEqual(expect.arrayContaining(["Read", "WebSearch", "mcp__docs", 'Bash("$CODEC_NODE" "$CODEC_CLI" report:*)']));
    expect(claudePermissions({ ...DEFAULT_HARNESS, access: "edit" })!.deny).toEqual(["WebFetch", "WebSearch"]);
    const custom = claudePermissions({ ...DEFAULT_HARNESS, access: "custom", allow: ["Read"], deny: ["Bash(git push:*)"] })!;
    expect(custom).toEqual({ allow: ["Read", 'Bash("$CODEC_NODE" "$CODEC_CLI" message:*)', 'Bash("$CODEC_NODE" "$CODEC_CLI" report:*)'], deny: ["Bash(git push:*)"] });
  });
  it("writes MCP servers in each tool's own format", () => {
    const h = { ...DEFAULT_HARNESS, mcp: [github as never, { name: "docs", type: "http" as const, url: "https://docs.example/mcp" }] };
    expect(claudeMcpConfig(h)).toEqual({ mcpServers: {
      github: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "ghp_secret" } },
      docs: { type: "http", url: "https://docs.example/mcp" } } });
    expect(codexOverrides(h)).toEqual([
      ["mcp_servers.github.command", '"npx"'],
      ["mcp_servers.github.args", '["-y","@modelcontextprotocol/server-github"]'],
      ["mcp_servers.github.env", '{ GITHUB_TOKEN = "ghp_secret" }'],
      ["mcp_servers.docs.url", '"https://docs.example/mcp"'],
    ]);
  });
  it("builds restricted, isolated commands without splicing any of the owner's text into the shell", () => {
    delete process.env.CODEC_AGENT_COMMAND;
    const claude = agentCommand("claude", { harness: { access: "read", isolated: true, mcp: true } });
    expect(claude).toContain("claude --permission-mode dontAsk -p");
    expect(claude).not.toContain("--dangerously-skip-permissions");
    expect(claude).toContain("--setting-sources project,local");
    expect(claude).toContain('--mcp-config "$CODEC_RUN_DIR/mcp.json" --strict-mcp-config');
    expect(agentCommand("claude", { harness: { access: "full" } })).toContain("--dangerously-skip-permissions");
    const codex = agentCommand("codex", { harness: { access: "edit", codexKeys: ["mcp_servers.github.command"] } });
    expect(codex).toContain(`codex exec --sandbox workspace-write -c approval_policy='"never"'`);
    expect(codex).toContain(`-c "mcp_servers.github.command=$(cat "$CODEC_RUN_DIR/codex-0.toml")"`);
    expect(agentCommand("codex", { harness: { access: "read" } })).toContain("exec --sandbox read-only");
    expect(agentCommand("codex", { harness: { access: "full" } })).toContain("exec --yolo");
  });
  it("gives each run its agent's settings, rules and private MCP file", async () => {
    addProject(makeRepo("alpha"));
    addTeam({ name: "study", projects: ["alpha"] });
    addMember("study", { name: "reviewer", tool: "claude" });
    writeHarness("study", "reviewer", checkHarness("study", "reviewer", { access: "custom", allow: ["Read"], isolated: true, mcp: [github] }));
    process.env.CODEC_AGENT_COMMAND = "true";
    const run = startRun({ project: "alpha", member: "study/reviewer", task: "check" });
    try {
      const dir = join(run.worktree, "..", "..", "..", "runs", run.runId);
      const settings = JSON.parse(readFileSync(join(dir, "claude-settings.json"), "utf8"));
      expect(settings.permissions.allow).toEqual(expect.arrayContaining(["Read", "mcp__github"]));
      expect(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")).mcpServers.github.env.GITHUB_TOKEN).toBe("ghp_secret");
      expect(statSync(join(dir, "mcp.json")).mode & 0o777).toBe(0o600);
    } finally {
      await waitFor(run.runId).catch(() => stopRun(run.runId));
    }
  });
});
