import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { accountCliArgs, accountEnvironment, accountFolder, accountStore, addAccount, builtinAccount, claudeKeychainService, getAccount,
  listAccounts, prepareAccount, removeAccount, resolveAccount, setAccountChoice, setDefaultAccount } from "../src/accounts.js";
import { accountLimitHit } from "../src/account-limits.js";
import { redactSecrets, redactValue, safeSignInUrl } from "../src/secrets.js";
import { friendlyError } from "../src/friendly.js";
import { logEvent, readEvents } from "../src/events.js";
import { addProject } from "../src/registry.js";
import { addMember, addTeam } from "../src/org.js";
import { saveAccountSettings } from "../src/settings.js";
import { agentCommand, getRunStatus, listRuns, removeMemberChecked, removeProjectChecked, removeTeamChecked, runOutput, startRun, stopRun } from "../src/runs.js";
import { cleanupTemps, makeRepo, tempDir, useIsolatedHome, waitFor } from "./helpers.js";

let home: string;
beforeEach(() => { home = useIsolatedHome("true"); });
afterEach(() => {
  for (const run of listRuns({ state: "running" })) stopRun(run.runId);
  vi.unstubAllEnvs(); cleanupTemps();
});

describe("account storage and resolution", () => {
  it("keeps both machine logins as the defaults without creating or changing sign-in folders", () => {
    expect(listAccounts()).toEqual([builtinAccount("claude"), builtinAccount("codex")]);
    expect(resolveAccount("claude")).toEqual(builtinAccount("claude"));
    expect(resolveAccount("codex")).toEqual(builtinAccount("codex"));
    const env = { CODEX_HOME: "/machine/codex", CLAUDE_CONFIG_DIR: "/machine/claude", ANTHROPIC_API_KEY: "synthetic" };
    expect(accountEnvironment(builtinAccount("claude"), env)).toEqual(env);
    expect(existsSync(join(home, "accounts"))).toBe(false);
  });
  it("creates private independent folders and stores only metadata", () => {
    const a = addAccount("claude", "Work"), b = addAccount("claude", "Personal");
    expect(a.id).not.toBe(b.id);
    for (const path of [join(home, "accounts"), accountFolder(a.id), accountFolder(b.id)]) expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "accounts.json")).mode & 0o777).toBe(0o600);
    expect(accountStore().accounts).toEqual([a, b]);
    expect(Object.keys(a).sort()).toEqual(["id", "kind", "name"]);
  });
  it.each(["", "   ", "a\nb", "x".repeat(81), "sk-ant-" + "SyntheticSecret".repeat(3)])("rejects invalid or secret-looking account name %s", (name) => {
    expect(() => addAccount("claude", name)).toThrowError(expect.objectContaining({ code: "account_name" }));
  });
  it("resolves helper > team > project > default, independently per AI service", () => {
    const [helper, team, project, fallback] = ["Helper", "Team", "Project", "Default"].map((name) => addAccount("claude", name));
    const codex = addAccount("codex", "Codex");
    const context = { helper: "web/builder", team: "web", project: "site" };
    setDefaultAccount("claude", fallback.id); setDefaultAccount("codex", codex.id);
    expect(resolveAccount("claude", context).id).toBe(fallback.id);
    setAccountChoice("project", "site", "claude", project.id);
    expect(resolveAccount("claude", context).id).toBe(project.id);
    setAccountChoice("team", "web", "claude", team.id);
    expect(resolveAccount("claude", context).id).toBe(team.id);
    setAccountChoice("helper", "web/builder", "claude", helper.id);
    expect(resolveAccount("claude", context).id).toBe(helper.id);
    expect(resolveAccount("codex", context).id).toBe(codex.id);
    setAccountChoice("helper", "web/builder", "claude");
    expect(resolveAccount("claude", context).id).toBe(team.id);
  });
  it("rejects stale choices and mismatched service accounts", () => {
    const a = addAccount("claude", "Claude");
    expect(() => setDefaultAccount("codex", a.id)).toThrowError(expect.objectContaining({ code: "account_kind" }));
    expect(() => setAccountChoice("team", "web", "codex", a.id)).toThrowError(expect.objectContaining({ code: "account_kind" }));
    const store = accountStore(); store.defaults.claude = "missing";
    writeFileSync(join(home, "accounts.json"), JSON.stringify(store));
    expect(() => resolveAccount("claude")).toThrowError(expect.objectContaining({ code: "account_missing" }));
  });
  it("validates project, team and helper settings before saving", () => {
    const a = addAccount("claude", "Work");
    expect(() => saveAccountSettings("project", "missing", "claude", a.id)).toThrow();
    expect(() => saveAccountSettings("team", "missing", "claude", a.id)).toThrow();
    addProject(makeRepo("site")); addTeam({ name: "web", projects: ["site"] }); addMember("web", { name: "builder", tool: "claude" });
    saveAccountSettings("helper", "web/builder", "claude", a.id);
    expect(resolveAccount("claude", { helper: "web/builder" }).id).toBe(a.id);
    expect(() => saveAccountSettings("helper", "web/builder", "codex")).toThrowError(expect.objectContaining({ code: "account_kind" }));
  });
  it("clears scope choices when projects, teams and helpers are removed", () => {
    const a = addAccount("claude", "Work");
    addProject(makeRepo("site")); addTeam({ name: "web", projects: ["site"] }); addMember("web", { name: "builder", tool: "claude" });
    setAccountChoice("helper", "web/builder", "claude", a.id);
    removeMemberChecked("web", "builder");
    expect(accountStore().choices["helper:web/builder"]).toBeUndefined();
    addMember("web", { name: "builder", tool: "claude" });
    setAccountChoice("helper", "web/builder", "claude", a.id); setAccountChoice("team", "web", "claude", a.id); setAccountChoice("project", "site", "claude", a.id);
    removeTeamChecked("web");
    expect(accountStore().choices).toEqual({ "project:site": { claude: a.id } });
    removeProjectChecked("site"); expect(accountStore().choices).toEqual({});
  });
  it.each(["claude", "codex"] as const)("%s: overrides inherited credentials only for managed accounts", (kind) => {
    const a = addAccount(kind, "Work");
    const env = accountEnvironment(a, { PATH: "/bin", USER: "owner", CODEX_HOME: "/machine", CLAUDE_CONFIG_DIR: "/machine",
      ANTHROPIC_API_KEY: "synthetic", ANTHROPIC_AUTH_TOKEN: "synthetic", CLAUDE_CODE_OAUTH_TOKEN: "synthetic", CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "synthetic",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "", OPENAI_API_KEY: "synthetic", CODEX_API_KEY: "synthetic", CODEX_ACCESS_TOKEN: "synthetic", OPENAI_IDENTITY_TOKEN_FILE: "/machine/token", CLAUDE_CODE_USE_BEDROCK: "1" });
    expect(env).toEqual({ PATH: "/bin", USER: "owner", [kind === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]: accountFolder(a.id) });
    expect(accountCliArgs(a)).toEqual(kind === "codex" ? ["-c", 'cli_auth_credentials_store="file"'] : []);
    expect(accountCliArgs(builtinAccount(kind))).toEqual([]);
  });
  it("refuses missing/symlinked folders instead of falling back to the machine login", () => {
    const a = addAccount("claude", "Work"); rmSync(accountFolder(a.id), { recursive: true });
    expect(() => accountEnvironment(a)).toThrowError(expect.objectContaining({ code: "account_folder" }));
    const other = tempDir(); symlinkSync(other, accountFolder(a.id));
    expect(() => accountEnvironment(a)).toThrowError(expect.objectContaining({ code: "account_folder" }));
    expect(() => prepareAccount(a)).toThrow();
    expect(() => accountFolder("../../escape")).toThrow();
  });
});

describe("removing managed accounts", () => {
  it("requires confirmation, refuses built-ins and running tasks, and retains the folder on refusal", () => {
    const a = addAccount("claude", "Work");
    expect(() => removeAccount(a.id, { confirmed: false, running: () => [] })).toThrowError(expect.objectContaining({ code: "account_confirm" }));
    expect(() => removeAccount("computer-claude", { confirmed: true, running: () => [] })).toThrowError(expect.objectContaining({ code: "account_builtin" }));
    expect(() => removeAccount(a.id, { confirmed: true, running: () => [{ state: "running", account: a }] })).toThrowError(expect.objectContaining({ code: "account_busy" }));
    expect(existsSync(accountFolder(a.id))).toBe(true);
  });
  it("deletes only its folder and clears its default/choices", () => {
    const a = addAccount("claude", "A"), b = addAccount("claude", "B");
    setDefaultAccount("claude", a.id); setAccountChoice("project", "site", "claude", a.id);
    writeFileSync(join(accountFolder(a.id), ".credentials.json"), '{"example":"synthetic-only"}');
    removeAccount(a.id, { confirmed: true, running: () => [], platform: "linux" });
    expect(existsSync(accountFolder(a.id))).toBe(false); expect(existsSync(accountFolder(b.id))).toBe(true);
    expect(resolveAccount("claude", { project: "site" }).builtin).toBe(true);
  });
  it("macOS: removes only the directory-hashed OAuth entry", () => {
    vi.stubEnv("USER", "test-owner");
    const a = addAccount("claude", "Mac"), remove = vi.fn((_service: string, _user: string) => true), folder = accountFolder(a.id);
    expect(claudeKeychainService(folder)).toBe("Claude Code-credentials-" + createHash("sha256").update(folder).digest("hex").slice(0, 8));
    removeAccount(a.id, { confirmed: true, running: () => [], platform: "darwin", keychainDelete: remove });
    expect(remove).toHaveBeenCalledExactlyOnceWith(claudeKeychainService(folder), "test-owner");
    expect(remove.mock.calls[0][0]).not.toBe("Claude Code-credentials");
  });
  it("macOS: keeps the account when its Keychain entry could not be deleted", () => {
    const a = addAccount("claude", "Mac");
    expect(() => removeAccount(a.id, { confirmed: true, running: () => [], platform: "darwin", keychainDelete: () => false })).toThrowError(expect.objectContaining({ code: "account_remove" }));
    expect(getAccount(a.id)).toEqual(a); expect(existsSync(accountFolder(a.id))).toBe(true);
  });
  it.each(["linux", "darwin"] as const)("%s: Codex removal needs no keyring operation because it uses file storage", (platform) => {
    const a = addAccount("codex", "Codex"), remove = vi.fn(() => false);
    removeAccount(a.id, { confirmed: true, running: () => [], platform, keychainDelete: remove });
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("task account snapshots", () => {
  it.each(["claude", "codex"] as const)("%s: default changes affect new tasks and preserve running tasks", async (agent) => {
    const a = addAccount(agent, "A"), b = addAccount(agent, "B"); addProject(makeRepo("site"));
    const variable = agent === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
    process.env.CODEC_AGENT_COMMAND = `printf '%s' "$${variable}" > chosen.txt; sleep 0.3`;
    setDefaultAccount(agent, a.id);
    const first = startRun({ project: "site", agent, task: "First" });
    expect(first.state).toBe("running"); setDefaultAccount(agent, b.id);
    const second = startRun({ project: "site", agent, task: "Second" });
    expect(getRunStatus(first.runId)?.account).toEqual({ id: a.id, name: "A" });
    expect(second.account).toEqual({ id: b.id, name: "B" });
    await Promise.all([waitFor(first.runId), waitFor(second.runId)]);
    expect(getRunStatus(first.runId)?.autoSaved).toBe(true);
    expect(readFileSync(join(first.worktree, "chosen.txt"), "utf8")).toBe(accountFolder(a.id));
    expect(readFileSync(join(second.worktree, "chosen.txt"), "utf8")).toBe(accountFolder(b.id));
    expect(JSON.parse(readFileSync(join(home, "runs", first.runId, "run.json"), "utf8")).account).toEqual({ id: a.id, name: "A" });
  });
  it("keeps Claude attribution disabled in both per-account config and per-task settings", async () => {
    const a = addAccount("claude", "Work");
    writeFileSync(join(accountFolder(a.id), "settings.json"), JSON.stringify({ attribution: { commit: "wrong" }, theme: "dark" }));
    addProject(makeRepo("site")); setDefaultAccount("claude", a.id);
    const run = startRun({ project: "site", agent: "claude", task: "Check" }); await waitFor(run.runId);
    const config = JSON.parse(readFileSync(join(accountFolder(a.id), "settings.json"), "utf8"));
    expect(config).toEqual({ theme: "dark", includeCoAuthoredBy: false, attribution: { commit: "", pr: "" } });
    expect(JSON.parse(readFileSync(join(home, "runs", run.runId, "claude-settings.json"), "utf8"))).toMatchObject({ includeCoAuthoredBy: false, attribution: { commit: "", pr: "" } });
    vi.stubEnv("CODEC_AGENT_COMMAND", "");
    expect(agentCommand("claude")).toContain('--settings "$CODEC_RUN_DIR/claude-settings.json"');
    expect(agentCommand("codex", { accountArgs: accountCliArgs(addAccount("codex", "Codex")) })).toContain('cli_auth_credentials_store="file"');
  });
  it("redacts split secrets before disk and detects limits without switching or retrying", async () => {
    const a = addAccount("codex", "Work"); setDefaultAccount("codex", a.id); addProject(makeRepo("site"));
    const synthetic = "sk-test-" + "OnlySynthetic123".repeat(3);
    process.env.CODEC_AGENT_COMMAND = `printf '%s' 'sk-test-'; sleep 0.05; printf '%s\n' '${synthetic.slice(8)}'; printf '%s\n' 'You’ve hit your usage limit.'`;
    const run = startRun({ project: "site", agent: "codex", task: "Handle " + synthetic });
    const finished = await waitFor(run.runId);
    expect(finished.limitHit).toBe(true); expect(finished.account?.id).toBe(a.id); expect(listRuns()).toHaveLength(1);
    for (const file of [join(home, "runs", run.runId, "run.json"), join(home, "runs", run.runId, "output.log"), join(home, "events.jsonl")]) expect(readFileSync(file, "utf8")).not.toContain(synthetic);
    expect(runOutput(run.runId)).toContain("[redacted]"); expect(accountStore().defaults.codex).toBe(a.id);
  });
  it("detects a split limit message while its helper is still running, without waiting for a newline", async () => {
    addProject(makeRepo("site"));
    process.env.CODEC_AGENT_COMMAND = "printf '%s' 'You’ve hit your '; sleep 0.05; printf '%s' 'usage limit.'; sleep 30";
    const run = startRun({ project: "site", agent: "codex", task: "Wait" });
    await vi.waitFor(() => expect(getRunStatus(run.runId)).toMatchObject({ state: "running", limitHit: true }));
    expect(listRuns()).toHaveLength(1); stopRun(run.runId);
  });
});

describe("limit error families", () => {
  it.each(["You've hit your limit · resets 4pm", "You’ve hit your usage limit.", "You've reached your weekly limit", "You're out of extra usage", "You're out of usage credits", "Your org is out of usage · add funds to continue", "Your workspace is out of credits. Add credits to continue.",
    '{"type":"rate_limit_error"}', '{"code":"usage_limit_exceeded"}', '{"code":"rate_limit_exceeded"}', '{"code":"workspace_owner_usage_limit_reached"}', '{"code":"workspace_member_credits_depleted"}', "Quota exceeded. Check your plan and billing details.", "rate limit exceeded: too many requests", "API Error: 429", "HTTP 429 Too Many Requests", "credit balance is too low", "Your usage allocation has been disabled by your admin"])("detects %s", (message) => {
    expect(accountLimitHit(message)).toBe(true);
  });
  it.each(["Used 429 tokens", "Read src/429.ts", "The context window limit is 128k", "Rate limits are documented here", "Limit is 3 minutes", "Task limit reached", "Token limit exceeded", "You're close to your usage limit", "Now using extra usage"])("does not flag %s", (message) => expect(accountLimitHit(message)).toBe(false));
});

describe("secrets at API and log boundaries", () => {
  it("redacts credential shapes while preserving file paths and Git object IDs", () => {
    const token = "sk-ant-" + "TestOnly123".repeat(5);
    const jwt = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.testSignature";
    const text = redactSecrets(`access_token=synthetic-opaque refresh_token:other-secret Bearer opaque-bearer ${token} ${jwt}`);
    for (const secret of [token, jwt, "synthetic-opaque", "other-secret", "opaque-bearer"]) expect(text).not.toContain(secret);
    const path = "/tmp/codec-home-test/worktrees/site/run-12345678", sha = "a1".repeat(20);
    expect(redactSecrets(path + " " + sha)).toBe(path + " " + sha);
    expect(redactValue({ api_key: "opaque", nested: [{ token }] })).toEqual({ api_key: "[redacted]", nested: [{ token: "[redacted]" }] });
  });
  it("never records secrets in errors or lifecycle logs", () => {
    const token = "sk-test-" + "TestOnly123".repeat(4);
    friendlyError(new Error("access_token=" + token), "/api/accounts"); logEvent("run.start", { detail: token });
    expect(readFileSync(join(home, "codec.log"), "utf8")).not.toContain(token);
    expect(JSON.stringify(readEvents())).not.toContain(token);
  });
  it("allows sign-in instructions and rejects callbacks, secret-bearing and unrelated links", () => {
    const url = "https://claude.com/cai/oauth/authorize?code=true&state=" + "State123".repeat(10) + "&code_challenge=" + "Challenge123".repeat(6);
    expect(safeSignInUrl(url)).toBe(true); expect(redactValue({ url })).toEqual({ url });
    for (const value of ["javascript:alert(1)", "https://evil.example/oauth/authorize", "http://localhost:1455/auth/callback?code=secret", "https://auth.openai.com/oauth/authorize?access_token=opaque", "https://claude.com/cai/oauth/authorize?code=secret", "https://auth.openai.com/codex/device#access_token=opaque"]) expect(safeSignInUrl(value)).toBe(false);
  });
});
