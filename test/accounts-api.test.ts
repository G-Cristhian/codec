import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { request } from "http";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { startDashboard, type Dashboard } from "../src/dashboard.js";
import { accountFolder, accountStore } from "../src/accounts.js";
import { addProject } from "../src/registry.js";
import { addMember, addTeam } from "../src/org.js";
import { listRuns, stopRun } from "../src/runs.js";
import { cleanupTemps, makeRepo, useIsolatedHome, waitFor } from "./helpers.js";

let home: string, dashboard: Dashboard, signed: Set<string>, children: ChildProcess[];
const synthetic = "sk-test-" + "SyntheticOnly123".repeat(4);
const authUrl = "https://claude.com/cai/oauth/authorize?code=true&state=example-state&code_challenge=example-challenge";
function call(method: string, path: string, body?: unknown, authorized = true) {
  return new Promise<{ status: number; json: any; text: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: dashboard.port, path: "/api/" + path, method,
      headers: { "Content-Type": "application/json", ...(authorized ? { "X-Codec-Token": dashboard.token } : {}) } }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(text), text }));
    }); req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const get = (path: string) => call("GET", path);
const post = (path: string, body: unknown = {}) => call("POST", path, body);
async function add(kind = "claude", name = "Work") {
  const response = await post("accounts", { kind, name }); expect(response.status).toBe(201); return response.json as { id: string; name: string; kind: string };
}
beforeEach(async () => {
  home = useIsolatedHome("true"); signed = new Set(); children = [];
  dashboard = await startDashboard({ port: 0,
    setup: { findBinary: (tool) => tool, runner: async (_command, args) => ({ status: args[0] === "--version" ? 0 : 1, stdout: args[0] === "--version" ? "test-version" : '{"loggedIn":false}' }) },
    accounts: { binary: (tool) => tool,
      status: async (command, _args, env) => {
        const ok = signed.has(env.CLAUDE_CONFIG_DIR ?? env.CODEX_HOME ?? "");
        return { status: ok ? 0 : 1, stdout: command === "claude" ? JSON.stringify({ loggedIn: ok, access_token: synthetic }) : ok ? "Logged in using an API key - " + synthetic : "Not logged in" };
      },
      spawn: (_command, _args, env, cwd) => {
        const child = spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(authUrl + "\naccess_token=" + synthetic + "\nPaste code here if prompted > ")}); process.stdin.on('data', () => process.exit(0)); setInterval(() => {}, 1000);`], { env, cwd, detached: true, stdio: "pipe" });
        children.push(child); return child;
      },
    },
  });
});
afterEach(async () => {
  await dashboard.close();
  for (const run of listRuns({ state: "running" })) stopRun(run.runId);
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }
  vi.unstubAllEnvs(); cleanupTemps();
});

describe("Accounts API", () => {
  it("uses the existing authenticated API guards and presents both built-ins without secrets", async () => {
    expect((await call("GET", "accounts", undefined, false)).status).toBe(401);
    expect((await call("POST", "accounts", { kind: "claude", name: "Work" }, false)).status).toBe(401);
    const list = await get("accounts");
    expect(list.json.accounts).toHaveLength(2); expect(list.json.defaults).toEqual({ claude: "computer-claude", codex: "computer-codex" });
    expect(list.text).not.toContain(synthetic); expect(list.text).not.toContain("access_token");
  });
  it("starts login in the background, returns only sign-in instructions and cancels without completion", async () => {
    const a = await add();
    expect((await post(`accounts/${a.id}/login`)).json.state).toBe("waiting");
    await vi.waitFor(async () => expect((await get(`accounts/${a.id}/login`)).json.url).toBe(authUrl));
    const list = await get("accounts"); expect(list.text).not.toContain(synthetic); expect(list.text).not.toContain("access_token");
    expect(list.json.accounts.find((x: any) => x.id === a.id).login).toMatchObject({ url: authUrl, needsCode: true });
    expect((await post(`accounts/${a.id}/cancel`)).json).toMatchObject({ state: "canceled" });
    await vi.waitFor(() => expect(children[0].signalCode).not.toBeNull());
    expect((await get(`accounts/${a.id}/login`)).json.url).toBeUndefined();
    expect(accountStore().accounts[0].signedInAt).toBeUndefined();
    expect(existsSync(join(home, "codec.log"))).toBe(false);
  });
  it("forwards a fallback code without echoing or logging it and confirms sign-in status", async () => {
    const a = await add(); await post(`accounts/${a.id}/login`);
    await vi.waitFor(async () => expect((await get(`accounts/${a.id}/login`)).json.needsCode).toBe(true));
    signed.add(accountFolder(a.id));
    const code = "synthetic-code#synthetic-state";
    const reply = await post(`accounts/${a.id}/code`, { code }); expect(reply.json).toEqual({ ok: true }); expect(reply.text).not.toContain(code);
    await vi.waitFor(async () => expect((await get(`accounts/${a.id}/login`)).json.state).toBe("signed_in"));
    expect(JSON.stringify(accountStore())).not.toContain(code);
    if (existsSync(join(home, "codec.log"))) expect(readFileSync(join(home, "codec.log"), "utf8")).not.toContain(code);
  });
  it("allows setup and task creation using a managed sign-in when the machine account is signed out", async () => {
    addProject(makeRepo("site"));
    expect((await get("setup")).json.ready).toBe(false);
    const a = await add(); signed.add(accountFolder(a.id)); await post(`accounts/${a.id}/default`);
    expect((await get("setup?fresh=1")).json.ready).toBe(true);
    const response = await post("projects/site/runs", { agent: "claude", task: "Check" });
    expect(response.status).toBe(201); expect(response.json.account).toEqual({ id: a.id, name: "Work" });
    await waitFor(response.json.runId);
  });
  it("supports all selection scopes and refuses the wrong service or missing scope target", async () => {
    addProject(makeRepo("site")); addTeam({ name: "web", projects: ["site"] }); addMember("web", { name: "builder", tool: "claude" });
    const a = await add(), b = await add("codex", "Codex");
    for (const [scope, name] of [["project", "site"], ["team", "web"], ["helper", "web/builder"]]) expect((await post("account-settings", { scope, name, kind: "claude", accountId: a.id })).status).toBe(200);
    expect((await get("accounts")).json.choices).toEqual({ "project:site": { claude: a.id }, "team:web": { claude: a.id }, "helper:web/builder": { claude: a.id } });
    expect((await post("account-settings", { scope: "helper", name: "web/builder", kind: "claude", accountId: b.id })).json.code).toBe("account_kind");
    expect((await post("account-settings", { scope: "project", name: "missing", kind: "claude", accountId: a.id })).status).toBe(404);
    expect((await post("account-settings", { scope: "unknown", name: "site", kind: "claude", accountId: a.id })).status).toBe(400);
    await post("account-settings", { scope: "helper", name: "web/builder", kind: "claude", accountId: "" });
    expect((await get("accounts")).json.choices["helper:web/builder"]).toEqual({});
  });
  it("protects built-ins and requires explicit removal confirmation", async () => {
    const a = await add();
    expect((await post(`accounts/${a.id}/remove`)).json.code).toBe("account_confirm");
    expect((await post("accounts/computer-claude/remove", { confirmed: true })).json.code).toBe("account_builtin");
    expect((await post(`accounts/${a.id}/remove`, { confirmed: true })).status).toBe(200);
    expect(existsSync(accountFolder(a.id))).toBe(false);
  });
  it("refuses removal and re-login while a task uses the account", async () => {
    process.env.CODEC_AGENT_COMMAND = "sleep 30"; addProject(makeRepo("site"));
    const a = await add(); signed.add(accountFolder(a.id)); await post(`accounts/${a.id}/default`);
    const task = await post("projects/site/runs", { agent: "claude", task: "Wait" }); expect(task.status).toBe(201);
    expect((await post(`accounts/${a.id}/remove`, { confirmed: true })).json.code).toBe("account_busy");
    expect((await post(`accounts/${a.id}/login`)).json.code).toBe("account_busy");
    expect(existsSync(accountFolder(a.id))).toBe(true);
    stopRun(task.json.runId);
    expect((await post(`accounts/${a.id}/remove`, { confirmed: true })).status).toBe(200);
    expect((await get(`runs/${task.json.runId}`)).json.account.name).toBe("Work");
  });
  it("makes a detected limit visible on the task and account, with no retry or automatic default change", async () => {
    process.env.CODEC_AGENT_COMMAND = "printf '%s\n' 'You’ve hit your usage limit.'"; addProject(makeRepo("site"));
    const a = await add("codex", "Codex Work"); signed.add(accountFolder(a.id)); await post(`accounts/${a.id}/default`);
    const task = await post("projects/site/runs", { agent: "codex", task: "Check" }); expect(task.status).toBe(201);
    await waitFor(task.json.runId);
    expect((await get(`runs/${task.json.runId}`)).json).toMatchObject({ limitHit: true, account: { name: "Codex Work" } });
    const list = await get("accounts"); expect(list.json.accounts.find((x: any) => x.id === a.id).status).toBe("limit");
    expect(list.json.defaults.codex).toBe(a.id); expect(listRuns()).toHaveLength(1);
  });
  it("redacts unexpected token-looking data in API responses and error logs", async () => {
    const a = await add(); signed.add(accountFolder(a.id));
    const saved = accountStore(); (saved.accounts[0] as any).access_token = synthetic;
    writeFileSync(join(home, "accounts.json"), JSON.stringify(saved));
    expect((await get("accounts?fresh=1")).text).not.toContain(synthetic);
    const result = await post("accounts", { kind: "claude", name: synthetic });
    expect(result.status).toBe(400); expect(result.text).not.toContain(synthetic);
    expect(readFileSync(join(home, "codec.log"), "utf8")).not.toContain(synthetic);
  });
});
