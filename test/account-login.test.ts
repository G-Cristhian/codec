import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { spawn, type ChildProcess } from "child_process";
import { accountFolder, addAccount, builtinAccount, getAccount } from "../src/accounts.js";
import { createAccountLogins, parseLoginOutput, type AccountLoginOptions } from "../src/account-login.js";
import { cleanupTemps, useIsolatedHome } from "./helpers.js";

const claudeUrl = "https://claude.com/cai/oauth/authorize?code=true&state=example-state&code_challenge=example-challenge";
const codexUrl = "https://auth.openai.com/oauth/authorize?client_id=example&state=example";
const deviceUrl = "https://auth.openai.com/codex/device";
type Manager = ReturnType<typeof createAccountLogins>;
let managers: Manager[];
beforeEach(() => { useIsolatedHome("true"); managers = []; });
afterEach(async () => { await Promise.all(managers.map((manager) => manager.close())); vi.unstubAllEnvs(); cleanupTemps(); });
function manager(options: AccountLoginOptions) { const login = createAccountLogins(options); managers.push(login); return login; }
function fixture(status: AccountLoginOptions["status"] = async (command) => ({ status: 0, stdout: command === "claude" ? '{"loggedIn":true}' : "Logged in using ChatGPT" })) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    pid: undefined, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null });
  const launch = vi.fn((_command: string, _args: string[], _env: NodeJS.ProcessEnv, _cwd: string) => child as unknown as ChildProcess);
  const login = manager({ binary: (tool) => tool, spawn: launch, status });
  const end = (code: number) => { child.exitCode = code; child.emit("close", code, null); };
  return { login, child, launch, end };
}

describe("background login instruction parser", () => {
  it.each([claudeUrl, codexUrl])("extracts an authorization URL with terminal hyperlinks: %s", (url) => {
    const output = `If the browser didn't open, visit: \x1b]8;;${url}\x07${url}\x1b]8;;\x07\nPaste code here if prompted > `;
    expect(parseLoginOutput(output)).toEqual({ url, needsCode: true });
  });
  it("extracts the actual Codex ANSI device prompt and one-time code", () => {
    expect(parseLoginOutput(`1. Open this link in your browser\n   \x1b[94m${deviceUrl}\x1b[0m\n\n2. Enter this one-time code (expires in 15 minutes)\n   \x1b[94mABCD-EFGHI\x1b[0m\n`)).toEqual({ url: deviceUrl, code: "ABCD-EFGHI" });
  });
  it("extracts an inline labeled device code", () => {
    expect(parseLoginOutput(`${deviceUrl}\nDevice code: ABCD-EFGH\n`)).toEqual({ url: deviceUrl, code: "ABCD-EFGH" });
  });
  it.each(["https://evil.example/oauth/authorize", "http://localhost:1455", "https://auth.openai.com/oauth/authorize?access_token=synthetic", "https://claude.com/cai/oauth/authorize?refresh_token=synthetic"])("ignores unsafe or credential-bearing URL %s", (url) => {
    expect(parseLoginOutput(`Visit ${url}\naccess_token=synthetic-secret\n`)).toEqual({});
  });
  it("does not publish an unfinished URL at a chunk boundary", () => {
    expect(parseLoginOutput("Visit " + claudeUrl)).toEqual({});
    expect(parseLoginOutput("Visit " + claudeUrl + "\n")).toEqual({ url: claudeUrl });
  });
  it("does not confuse a localhost callback or API key with a device code", () => {
    expect(parseLoginOutput(`http://localhost:1455/auth/callback\nAPI key: ABCD-EFGH\n`)).toEqual({});
    expect(parseLoginOutput(`${claudeUrl}\nDevice code: ABCD-EFGH\n`)).toEqual({ url: claudeUrl });
  });
});

describe("CLI status checks", () => {
  it.each(["claude", "codex"] as const)("%s checks the chosen folder with the CLI's status command", async (kind) => {
    const a = addAccount(kind, "Work");
    const status = vi.fn(async () => ({ status: 0, stdout: kind === "claude" ? '{"loggedIn":true,"access_token":"synthetic-not-returned"}' : "Logged in using an API key - sk-test-SyntheticOnly123456789" }));
    const f = fixture(status);
    expect(await f.login.signedIn(a.id)).toBe(true);
    const [command, args, env] = status.mock.calls[0] as unknown as [string, string[], NodeJS.ProcessEnv];
    expect(command).toBe(kind);
    expect(args).toEqual(kind === "claude" ? ["auth", "status", "--json"] : ["-c", 'cli_auth_credentials_store="file"', "login", "status"]);
    expect(env[kind === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]).toBe(accountFolder(a.id));
    expect(JSON.stringify(await f.login.accountsView())).not.toContain("synthetic-not-returned");
    expect(JSON.stringify(await f.login.accountsView())).not.toContain("sk-test-");
  });
  it.each([
    ["claude", 1, '{"loggedIn":true}', false], ["claude", 0, "invalid JSON", false], ["claude", 0, '{"loggedIn":false}', false],
    ["codex", 0, "Not logged in", false], ["codex", 1, "Logged in using ChatGPT", false], ["codex", 0, "Logged in using ChatGPT", true],
  ] as const)("%s exit %s output %s yields %s", async (kind, code, stdout, expected) => {
    const a = addAccount(kind, "Work"), f = fixture(async () => ({ status: code, stdout }));
    expect(await f.login.signedIn(a.id)).toBe(expected);
  });
  it("caches status, supports fresh checks and treats errors as needing sign-in", async () => {
    const a = addAccount("claude", "Work"), status = vi.fn(async () => { throw new Error("synthetic-private-error"); });
    const f = fixture(status);
    expect(await f.login.signedIn(a.id)).toBe(false); expect(await f.login.signedIn(a.id)).toBe(false); expect(status).toHaveBeenCalledOnce();
    expect(await f.login.signedIn(a.id, true)).toBe(false); expect(status).toHaveBeenCalledTimes(2);
  });
});

describe("background sign-in lifecycle", () => {
  it.each(["claude", "codex"] as const)("%s uses pipes and the isolated env, and confirms status after exit 0", async (kind) => {
    const a = addAccount(kind, "Work"), f = fixture();
    const mask = process.umask();
    expect(f.login.start(a.id)).toMatchObject({ state: "waiting", accountId: a.id });
    expect(process.umask()).toBe(mask);
    const [binary, args, env, cwd] = f.launch.mock.calls[0];
    expect(binary).toBe(kind); expect(cwd).toBe(accountFolder(a.id));
    expect(args).toEqual(kind === "claude" ? ["auth", "login", "--claudeai"] : ["-c", 'cli_auth_credentials_store="file"', "login", "--device-auth"]);
    expect(env.BROWSER).toBe("/usr/bin/true");
    f.child.stdout.write(`${kind === "claude" ? claudeUrl : deviceUrl}\n`);
    expect(f.login.view(a.id)?.url).toBe(kind === "claude" ? claudeUrl : deviceUrl);
    f.end(0); await vi.waitFor(() => expect(f.login.view(a.id)?.state).toBe("signed_in"));
    expect(getAccount(a.id).signedInAt).toBeDefined(); expect(f.login.view(a.id)?.url).toBeUndefined();
  });
  it("offers the Codex browser fallback", () => {
    const a = addAccount("codex", "Work"), f = fixture(); f.login.start(a.id, "browser");
    expect(f.launch.mock.calls[0][1]).toEqual(["-c", 'cli_auth_credentials_store="file"', "login"]); f.end(1);
  });
  it("handles chunked output and never returns unexpected login output", () => {
    const a = addAccount("claude", "Work"), f = fixture(); f.login.start(a.id);
    f.child.stdout.write("Visit " + claudeUrl.slice(0, 35)); expect(f.login.view(a.id)?.url).toBeUndefined();
    f.child.stdout.write(claudeUrl.slice(35) + "\naccess_token=synthetic-must-stay-private\n");
    expect(f.login.view(a.id)?.url).toBe(claudeUrl); expect(JSON.stringify(f.login.view(a.id))).not.toContain("synthetic-must-stay-private"); f.end(1);
  });
  it("requires status success as well as exit 0, even if CLI prints success", async () => {
    const a = addAccount("claude", "Work"), f = fixture(async () => ({ status: 1, stdout: '{"loggedIn":false}' }));
    f.login.start(a.id); f.child.stdout.write("Login successful.\n"); f.end(0);
    await vi.waitFor(() => expect(f.login.view(a.id)?.state).toBe("failed")); expect(getAccount(a.id).signedInAt).toBeUndefined();
  });
  it("cancellation wins over a late successful exit and prevents callback-port collisions", () => {
    const a = addAccount("claude", "A"), b = addAccount("codex", "B"), f = fixture();
    f.login.start(a.id); expect(() => f.login.start(b.id)).toThrowError(expect.objectContaining({ code: "account_login_busy" }));
    f.child.stdout.write(`${claudeUrl}\n`); expect(f.login.cancel(a.id)).toMatchObject({ state: "canceled" });
    f.end(0); expect(f.login.view(a.id)?.state).toBe("canceled"); expect(f.login.view(a.id)?.url).toBeUndefined();
  });
  it.each(["canceled", "timed_out", "failed"] as const)("clears a %s result when a later status check confirms sign-in", async (state) => {
    const a = addAccount("claude", "Work");
    let signedIn = false;
    const f = fixture(async () => ({ status: 0, stdout: JSON.stringify({ loggedIn: signedIn }) }));
    f.login.start(a.id);
    if (state === "failed") f.end(1);
    else { f.login.cancel(a.id, state); f.end(1); }
    expect((await f.login.accountsView()).find((x) => x.id === a.id)).toMatchObject({ status: "needs_sign_in", login: { state } });

    signedIn = true;
    const account = (await f.login.accountsView([], true)).find((x) => x.id === a.id);
    expect(account).toMatchObject({ status: "signed_in", login: { state: "signed_in" } });
    expect(f.login.view(a.id)?.state).toBe("signed_in");
  });
  it.each(["canceled", "timed_out", "failed"] as const)("replaces a %s result when another sign-in attempt starts", (state) => {
    const a = addAccount("claude", "Work"), f = fixture();
    f.login.start(a.id);
    if (state === "failed") f.end(1);
    else { f.login.cancel(a.id, state); f.end(1); }
    expect(f.login.view(a.id)?.state).toBe(state);
    expect(f.login.start(a.id)).toMatchObject({ state: "waiting" });
    expect(f.login.view(a.id)?.state).toBe("waiting");
    f.end(1);
  });
  it("clears canceled text even when the signed-in status is cached", async () => {
    const a = addAccount("claude", "Work"), f = fixture();
    f.login.start(a.id);
    expect(await f.login.signedIn(a.id)).toBe(true);
    f.login.cancel(a.id); f.end(1);
    expect(f.login.view(a.id)?.state).toBe("canceled");
    expect((await f.login.accountsView()).find((x) => x.id === a.id)).toMatchObject({ status: "signed_in", login: { state: "signed_in" } });
  });
  it("accepts a Claude fallback code over stdin without exposing or retaining it", () => {
    const a = addAccount("claude", "A"), f = fixture(); f.login.start(a.id); f.child.stdout.write(`${claudeUrl}\nPaste code here if prompted > `);
    let input = ""; f.child.stdin.on("data", (chunk) => { input += chunk; });
    f.login.submitCode(a.id, "synthetic-code#synthetic-state");
    expect(input).toBe("synthetic-code#synthetic-state\n"); expect(JSON.stringify(f.login.view(a.id))).not.toContain("synthetic-code");
    expect(() => f.login.submitCode(a.id, "unsafe\ninput")).toThrowError(expect.objectContaining({ code: "account_code" })); f.end(1);
  });
  it("refuses starting login for the machine default", () => {
    expect(() => fixture().login.start(builtinAccount("claude").id)).toThrowError(expect.objectContaining({ code: "account_builtin" }));
  });
  it("keeps limit status until a newer successful sign-in", async () => {
    const a = addAccount("claude", "Work"), f = fixture();
    const runs = [{ state: "failed", startedAt: "2020-01-01", limitHit: true, account: a }];
    expect((await f.login.accountsView(runs)).find((x) => x.id === a.id)?.status).toBe("limit");
    f.login.start(a.id); f.end(0); await vi.waitFor(() => expect(f.login.view(a.id)?.state).toBe("signed_in"));
    expect((await f.login.accountsView(runs)).find((x) => x.id === a.id)?.status).toBe("signed_in");
  });
  it.each(["cancel", "timeout", "close"] as const)("%s ends a real fake-login process without signing in", async (action) => {
    const a = addAccount("claude", "Work"); let child: ChildProcess | undefined;
    const f = manager({ binary: (tool) => tool, timeoutMs: action === "timeout" ? 500 : 5000,
      spawn: (_command, _args, env, cwd) => child = spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(claudeUrl + "\n")}); setInterval(() => {}, 1000);`], { env, cwd, detached: true, stdio: "pipe" }),
      status: async () => ({ status: 1, stdout: "" }) });
    f.start(a.id);
    await vi.waitFor(() => expect(f.view(a.id)?.url).toBe(claudeUrl));
    if (action === "cancel") f.cancel(a.id); else if (action === "close") await f.close();
    await vi.waitFor(() => expect(f.view(a.id)?.state).toBe(action === "timeout" ? "timed_out" : "canceled"));
    await vi.waitFor(() => expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true));
    expect(getAccount(a.id).signedInAt).toBeUndefined();
  });
});
