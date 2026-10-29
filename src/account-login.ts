/** Background CLI sign-in. Only parsed public instructions ever leave this module. */
import { execFile, spawn, type ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import { accountCliArgs, accountEnvironment, accountFolder, getAccount, listAccounts, noteAccountSignIn, prepareAccount, secureAccountFiles } from "./accounts.js";
import { CodecError } from "./errors.js";
import { S } from "./strings.js";
import { findBinary } from "./setup.js";
import { safeSignInUrl } from "./secrets.js";

function privateSpawn<T>(launch: () => T): T {
  const mask = process.umask(0o077);
  try { return launch(); } finally { process.umask(mask); }
}

export interface LoginInstructions { url?: string; code?: string; needsCode?: boolean }
export function parseLoginOutput(output: string): LoginInstructions {
  const plain = output.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const url = [...plain.matchAll(/https:\/\/[^\s<>"'\x00-\x1f]+(?=[\s<>"'\x00-\x1f])/g)].map((match) => match[0].replace(/[),.;]+$/, "")).find(safeSignInUrl);
  const code = plain.match(/(?:one-time code|device code|user code)[^\n]*\n\s*([A-Z0-9]{4,6}-[A-Z0-9]{4,6})\b/i)?.[1] ??
    plain.match(/(?:one-time code|device code|user code)\s*:\s*([A-Z0-9]{4,6}-[A-Z0-9]{4,6})\b/i)?.[1];
  return { ...(url ? { url } : {}), ...(code && url?.includes("/codex/device") ? { code } : {}),
    ...(plain.includes("Paste code here") ? { needsCode: true } : {}) };
}

export type LoginState = "waiting" | "signed_in" | "canceled" | "timed_out" | "failed";
export interface LoginView extends LoginInstructions { accountId: string; state: LoginState; expiresAt: string }
export interface AuthResult { status: number | null; stdout: string; stderr?: string }
export interface AccountLoginOptions {
  timeoutMs?: number;
  statusTimeoutMs?: number;
  binary?: typeof findBinary;
  spawn?: (command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) => ChildProcess;
  status?: (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<AuthResult>;
}
interface Flow { view: LoginView; child: ChildProcess; timer: ReturnType<typeof setTimeout>; buffer: string }
export function createAccountLogins(options: AccountLoginOptions = {}) {
  const flows = new Map<string, Flow>();
  const cached = new Map<string, { at: number; value: boolean; pending?: Promise<boolean> }>();
  const children = new Set<ChildProcess>();
  let closed = false;
  const commandStatus = options.status ?? ((command, args, env) => new Promise<AuthResult>((resolve) => {
    const child = privateSpawn(() => execFile(command, args, { env, cwd: env.CLAUDE_CONFIG_DIR || env.CODEX_HOME, encoding: "utf8", timeout: options.statusTimeoutMs ?? 5000,
      killSignal: "SIGKILL", maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      children.delete(child);
      resolve({ stdout, stderr, status: error ? (typeof error.code === "number" ? error.code : null) : 0 });
    }));
    children.add(child);
  }));
  async function signedIn(id: string, fresh = false): Promise<boolean> {
    const account = getAccount(id);
    function confirmed(value: boolean): boolean {
      const flow = flows.get(id);
      if (value && flow && (flow.view.state === "canceled" || flow.view.state === "timed_out" || flow.view.state === "failed")) {
        finish(flow, "signed_in");
      }
      return value;
    }
    const previous = cached.get(id);
    if (!fresh && previous && Date.now() - previous.at < 15_000) return confirmed(await (previous.pending ?? previous.value));
    if (process.env.CODEC_AGENT_COMMAND && !options.status && !options.binary) return confirmed(true);
    const binary = (options.binary ?? findBinary)(account.kind);
    if (!binary || closed) return false;
    const entry = { at: Date.now(), value: false, pending: undefined as Promise<boolean> | undefined };
    const check = async () => {
      try {
        const result = await commandStatus(binary, [...accountCliArgs(account), ...(account.kind === "claude" ? ["auth", "status", "--json"] : ["login", "status"])], accountEnvironment(account));
        entry.value = result.status === 0 && (account.kind === "claude" ? JSON.parse(result.stdout).loggedIn === true : /^\s*Logged in\b/im.test(result.stdout + "\n" + (result.stderr ?? "")));
      } catch { entry.value = false; }
      entry.pending = undefined;
      return confirmed(entry.value);
    };
    entry.pending = check(); cached.set(id, entry); return entry.pending;
  }
  function terminate(flow: Flow): void {
    clearTimeout(flow.timer);
    const pid = flow.child.pid;
    if (!pid) return;
    try { process.kill(-pid, "SIGTERM"); } catch { try { flow.child.kill("SIGTERM"); } catch { /* Already gone. */ } }
    const timer = setTimeout(() => {
      try { process.kill(-pid, "SIGKILL"); } catch { /* Already gone. */ }
    }, 1000);
    flow.child.once("close", () => clearTimeout(timer)); timer.unref();
  }
  function finish(flow: Flow, state: LoginState): void {
    clearTimeout(flow.timer);
    flow.view = { accountId: flow.view.accountId, state, expiresAt: flow.view.expiresAt };
    flow.buffer = "";
    try { secureAccountFiles(flow.view.accountId); } catch { /* Account may have been removed. */ }
  }
  function cancel(id: string, state: "canceled" | "timed_out" = "canceled"): LoginView | undefined {
    const flow = flows.get(id);
    if (flow?.view.state === "waiting") { finish(flow, state); terminate(flow); }
    return view(id);
  }
  function view(id: string): LoginView | undefined { const current = flows.get(id); return current ? { ...current.view } : undefined; }
  async function stop(id: string): Promise<void> {
    const flow = flows.get(id);
    if (!flow) return;
    const ended = flow.child.exitCode !== null || flow.child.signalCode !== null;
    const done = ended ? Promise.resolve() : new Promise<void>((resolve) => {
      flow.child.once("close", () => resolve());
      setTimeout(resolve, 1500).unref();
    });
    cancel(id); await done;
    if (flow.child.exitCode === null && flow.child.signalCode === null) throw new CodecError("account_login_busy", S.errors.account_login_busy, {}, 409);
    flows.delete(id); cached.delete(id);
  }
  function start(id: string, method: "device" | "browser" = "device"): LoginView {
    const account = getAccount(id);
    if (account.builtin) throw new CodecError("account_builtin", S.errors.account_builtin, {}, 409);
    if (closed) throw new CodecError("account_login", S.errors.account_login);
    if ([...flows.values()].some((flow) => flow.view.state === "waiting" || flow.child.exitCode === null && flow.child.signalCode === null)) throw new CodecError("account_login_busy", S.errors.account_login_busy, {}, 409);
    const binary = (options.binary ?? findBinary)(account.kind);
    if (!binary) throw new CodecError("tool_unavailable", S.errors.tool_unavailable, { tool: account.kind === "claude" ? S.setup.claude : S.setup.codex }, 409);
    const env = accountEnvironment(account);
    prepareAccount(account);
    // Browser opening stays under the owner's explicit button click. Disable CLI debug logging.
    Object.assign(env, { BROWSER: "/usr/bin/true", RUST_LOG: "off", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
    delete env.DEBUG; delete env.CLAUDE_CODE_DEBUG_LOGS_DIR;
    const args = [...accountCliArgs(account), ...(account.kind === "claude" ? ["auth", "login", "--claudeai"] : ["login", ...(method === "device" ? ["--device-auth"] : [])])];
    const child = privateSpawn(() => (options.spawn ?? ((command, args, env, cwd) => spawn(command, args, { env, cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] })))(binary, args, env, accountFolder(id)));
    const timeoutMs = options.timeoutMs ?? 10 * 60_000;
    const flow: Flow = { view: { accountId: id, state: "waiting", expiresAt: new Date(Date.now() + timeoutMs).toISOString() }, child,
      buffer: "", timer: setTimeout(() => cancel(id, "timed_out"), timeoutMs) };
    flows.set(id, flow); cached.delete(id);
    // A browser callback can close stdin just as the owner submits a fallback code.
    child.stdin?.on("error", () => {});
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder("utf8");
      stream?.on("data", (chunk: Buffer) => {
        if (flow.view.state !== "waiting") return;
        flow.buffer = (flow.buffer + decoder.write(chunk)).slice(-64 * 1024);
        flow.view = { ...flow.view, ...parseLoginOutput(flow.buffer) };
      });
    }
    child.on("error", () => { if (flow.view.state === "waiting") finish(flow, "failed"); });
    child.on("close", (code) => {
      if (flow.view.state !== "waiting") return;
      if (code !== 0) { finish(flow, "failed"); return; }
      void signedIn(id, true).then((ok) => {
        if (flow.view.state !== "waiting" || closed) return;
        if (ok) noteAccountSignIn(id);
        finish(flow, ok ? "signed_in" : "failed");
      }).catch(() => { if (flow.view.state === "waiting") finish(flow, "failed"); });
    });
    return view(id)!;
  }
  function submitCode(id: string, code: string): void {
    const flow = flows.get(id);
    if (!flow || flow.view.state !== "waiting" || !flow.child.stdin?.writable || getAccount(id).kind !== "claude" || !flow.view.needsCode || !/^[A-Za-z0-9_-]{4,2048}#[A-Za-z0-9_-]{4,2048}$/.test(code)) throw new CodecError("account_code", S.errors.account_code);
    flow.child.stdin?.write(code + "\n");
  }
  async function accountsView(limits: { account?: { id: string }; limitHit?: boolean; startedAt: string; state: string }[] = [], fresh = false) {
    return Promise.all(listAccounts().map(async (account) => ({
      id: account.id, name: account.name, kind: account.kind, builtin: !!account.builtin,
      status: limits.some((r) => r.account?.id === account.id && r.limitHit && r.startedAt >= (account.signedInAt ?? "")) ? "limit" : await signedIn(account.id, fresh) ? "signed_in" : "needs_sign_in",
      running: limits.some((r) => r.account?.id === account.id && r.state === "running"),
      login: view(account.id),
    })));
  }
  async function close(): Promise<void> {
    closed = true;
    const active = [...flows.values()].filter((f) => f.child.exitCode === null && f.child.signalCode === null);
    const waits = active.map((flow) => new Promise<void>((resolve) => {
      if (flow.child.exitCode !== null || flow.child.signalCode !== null) return resolve();
      flow.child.once("close", () => resolve());
      setTimeout(resolve, 1500).unref();
    }));
    active.forEach((flow) => { if (flow.view.state === "waiting") cancel(flow.view.accountId); else terminate(flow); });
    children.forEach((child) => child.kill("SIGKILL"));
    await Promise.all(waits);
  }
  return { start, view, cancel, stop, submitCode, signedIn, accountsView, close };
}
