/** Bounded tool checks with per-dashboard caching and injectable commands. */
import { S, wording } from "./strings.js";
import { execFile } from "child_process";
import { accessSync, constants, statSync } from "fs";
import { delimiter, isAbsolute, join } from "path";
import type { Agent } from "./tools.js";

export interface CommandResult { stdout: string; stderr?: string; status: number | null }
export type CommandRunner = (command: string, args: string[], timeoutMs: number) => Promise<CommandResult>;
export interface SetupOptions {
  runner?: CommandRunner;
  findBinary?: (tool: Agent) => string | undefined;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface ToolSetup {
  tool: Agent; installed: boolean; signedIn: boolean | null; version?: string; problem?: string; fix?: string;
}
export interface SetupStatus { tools: ToolSetup[]; ready: boolean }
export const runCommand = (command: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<CommandResult> => new Promise((resolve) => {
  execFile(command, args, { timeout: timeoutMs, signal, killSignal: "SIGKILL", maxBuffer: 256 * 1024, encoding: "utf-8" }, (error, stdout, stderr) => {
    resolve({ stdout, stderr, status: error ? (typeof error.code === "number" ? error.code : null) : 0 });
  });
});
export function findBinary(tool: Agent): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const file = join(dir || ".", tool);
    try {
      accessSync(file, constants.X_OK);
      if (statSync(file).isFile()) return isAbsolute(file) ? file : join(process.cwd(), file);
    } catch { /* Keep looking. */ }
  }
  return undefined;
}

export function createSetupChecker(options: SetupOptions = {}) {
  let cached: { at: number; status: SetupStatus } | undefined;
  let pending: Promise<SetupStatus> | undefined;
  const timeoutMs = options.timeoutMs ?? 5000;
  const runner = options.runner ?? ((command, args, timeoutMs) => runCommand(command, args, timeoutMs, options.signal));
  async function command(binary: string, args: string[]) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => runner(binary, args, timeoutMs)),
        new Promise<CommandResult>((resolve) => { timer = setTimeout(() => resolve({ stdout: "", status: null }), timeoutMs); }),
      ]);
    } catch { return { stdout: "", status: null }; }
    finally { clearTimeout(timer); }
  }
  async function check(tool: Agent): Promise<ToolSetup> {
    // The engine's explicit fake-command override is used by tests and demos.
    if (process.env.CODEC_AGENT_COMMAND && !options.runner && !options.findBinary) return { tool, installed: true, signedIn: true, version: S.wording.commandOverride };
    const label = tool === "claude" ? S.setup.claude : S.setup.codex;
    const binary = (options.findBinary ?? findBinary)(tool);
    const version = binary ? await command(binary, ["--version"]) : undefined;
    if (!version || version.status !== 0) return {
      tool, installed: false, signedIn: null, problem: wording(S.wording.setupMissing, { tool: label }),
      fix: wording(S.wording.setupInstall, { tool: label }),
    };
    const auth = await command(binary!, tool === "claude" ? ["auth", "status"] : ["login", "status"]);
    let signedIn = false;
    if (tool === "claude") {
      try { signedIn = auth.status === 0 && JSON.parse(auth.stdout).loggedIn === true; } catch { /* Not signed in. */ }
    } else signedIn = auth.status === 0 || /^\s*Logged in\b/im.test(auth.stdout + "\n" + (auth.stderr ?? ""));
    return { tool, installed: true, signedIn, version: version.stdout.trim() || version.stderr?.trim(),
      ...(!signedIn ? { problem: wording(S.wording.setupSignIn, { tool: label }), fix: wording(S.wording.setupLogin, { tool: label }) } : {}),
    };
  }
  return async (fresh = false): Promise<SetupStatus> => {
    if (!fresh && cached && Date.now() - cached.at < 5000) return cached.status;
    if (pending) return pending;
    pending = Promise.all([check("claude"), check("codex")]).then((tools) => {
      const status = { tools, ready: tools.some((tool) => tool.installed && tool.signedIn === true) };
      cached = { at: Date.now(), status };
      return status;
    });
    try { return await pending; } finally { pending = undefined; }
  };
}
