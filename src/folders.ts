/** Local folder browsing and explicit, shell-free tracking setup. */
import { accessSync, constants, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";
import { spawn, spawnSync } from "child_process";
import { CodecError } from "./errors.js";
import { withLock } from "./store.js";
import { ApiError } from "./friendly.js";
import { checkpointIdentity, identityEnvironment } from "./settings.js";
import { S } from "./strings.js";

export function requireFolder(path: string): string {
  if (!isAbsolute(path)) throw new ApiError(400, "invalid_path", "Choose a folder using its full path.");
  const abs = resolve(path);
  try {
    if (!statSync(abs).isDirectory()) throw new ApiError(400, "not_a_folder", "That location is a file. Choose a folder instead.");
    accessSync(abs, constants.R_OK | constants.X_OK);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(404, "folder_not_found", "That folder could not be opened. Choose an existing folder you can access.", { cause: error });
  }
  return abs;
}

function git(path: string, args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync("git", ["-C", path, ...args], { encoding: "utf-8", timeout: 5000, shell: false, env: { ...process.env, ...env } });
}
export function isGitRepo(path: string): boolean {
  if (!isAbsolute(path)) return false;
  const result = git(path, ["rev-parse", "--is-inside-work-tree"]);
  return result.status === 0 && result.stdout.trim() === "true";
}
function hasSkill(path: string): boolean {
  try { return statSync(join(path, "SKILL.md")).isFile(); } catch { return false; }
}
export function listFolders(path = homedir()) {
  const abs = requireFolder(path);
  const folders: { name: string; path: string; isGit: boolean; hasSkill: boolean }[] = [];
  for (const name of readdirSync(abs)) {
    if (name.startsWith(".")) continue;
    const child = join(abs, name);
    try {
      if (!statSync(child).isDirectory()) continue;
      accessSync(child, constants.R_OK | constants.X_OK);
      // Access checks alone can miss directory read failures on some filesystems.
      readdirSync(child);
      folders.push({ name, path: child, isGit: isGitRepo(child), hasSkill: hasSkill(child) });
    } catch { /* Entries can disappear or be unreadable while browsing. */ }
  }
  folders.sort((a, b) => a.name.localeCompare(b.name));
  return { path: abs, parent: dirname(abs) === abs ? null : dirname(abs), isGit: isGitRepo(abs), hasSkill: hasSkill(abs), folders };
}

export function hasCheckpoint(path: string): boolean {
  return git(path, ["rev-parse", "--verify", "--quiet", "HEAD"]).status === 0;
}

export function setUpTracking(path: string): void {
  const abs = requireFolder(path);
  const run = (args: string[], env?: NodeJS.ProcessEnv) => {
    const result = git(abs, args, env);
    if (result.status !== 0) throw new CodecError("tracking_setup_failed", `tracking setup failed: ${result.error?.message ?? result.stderr}`);
    return result;
  };
  withLock("tracking-setup", () => {
    if (!isGitRepo(abs)) run(["init", "-q"]);
    if (hasCheckpoint(abs)) return;
    const identity = checkpointIdentity(abs) ?? { name: S.checkpoints.fallbackName, email: S.checkpoints.fallbackEmail };
    run(["add", "-A"]);
    run(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-q", "-m", S.checkpoints.startingMessage], identityEnvironment(identity));
  });
}

// ---------- Native folder picker ----------

export type FolderChoice = { path: string } | { cancelled: true } | { unavailable: true };
/** Runs one picker command and reports its exit code and output. */
export type PickerRunner = (command: string, args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const runPicker: PickerRunner = (command, args) =>
  new Promise((done) => {
    // No shell: the prompt and start folder are passed as plain arguments.
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => { stdout += c; });
    child.stderr.setEncoding("utf8").on("data", (c: string) => { stderr += c; });
    const timer = setTimeout(() => child.kill(), 10 * 60_000);
    child.on("error", () => { clearTimeout(timer); done({ code: null, stdout, stderr }); });
    child.on("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
  });

/** The AppleScript reads the prompt and optional start folder from argv, never from interpolated text. */
const CHOOSE_FOLDER_SCRIPT = [
  "on run argv",
  "set prompt to item 1 of argv",
  "if (count of argv) > 1 then",
  "return POSIX path of (choose folder with prompt prompt default location (POSIX file (item 2 of argv)))",
  "end if",
  "return POSIX path of (choose folder with prompt prompt)",
  "end run",
];

/**
 * Opens this computer's own folder picker (Finder on macOS, zenity on Linux)
 * and returns the chosen folder. The dashboard only listens on 127.0.0.1, so the
 * picker appears on the owner's own screen.
 */
export async function chooseFolderNatively(start?: string, opts: { platform?: NodeJS.Platform; run?: PickerRunner } = {}): Promise<FolderChoice> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? runPicker;
  let from: string | undefined;
  if (start && isAbsolute(start)) {
    try { if (statSync(start).isDirectory()) from = resolve(start); } catch { /* Start from the default place. */ }
  }
  let result;
  if (platform === "darwin") {
    result = await run("/usr/bin/osascript", [...CHOOSE_FOLDER_SCRIPT.flatMap((line) => ["-e", line]), S.folder.prompt, ...(from ? [from] : [])]);
    if (result.code !== 0) return /-128/.test(result.stderr) ? { cancelled: true } : { unavailable: true };
  } else if (platform === "linux") {
    result = await run("zenity", ["--file-selection", "--directory", "--title", S.folder.prompt, ...(from ? ["--filename", from + "/"] : [])]);
    if (result.code === null) return { unavailable: true };
    if (result.code !== 0) return { cancelled: true };
  } else return { unavailable: true };
  const picked = result.stdout.trim().replace(/(.)\/$/, "$1");
  if (!picked || !isAbsolute(picked)) return { cancelled: true };
  return { path: picked };
}
