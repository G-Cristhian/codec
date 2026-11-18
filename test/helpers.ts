import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { getRunStatus, type RunStatus } from "../src/runs.js";

const temps: string[] = [];

export function tempDir(prefix = "codec-test-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

export function cleanupTemps(): void {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
}

/** HTTP authentication tests use an isolated page; ui-bundle.test builds the real UI. */
export function makeUiBundle(): string {
  const dir = tempDir("codec-ui-auth-");
  writeFileSync(join(dir, "index.html"), '<!doctype html><html><head><title>Codec</title><meta name="codec-token" content="__CODEC_TOKEN__"></head><body><div id="root"></div></body></html>');
  return dir;
}

/** A fresh git repo with one commit. */
export function makeRepo(name = "repo"): string {
  const dir = join(tempDir(), name);
  execFileSync("git", ["init", "-q", dir]);
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a]);
  g("config", "user.name", "Codec Test");
  g("config", "user.email", "test@example.invalid");
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  g("add", ".");
  g("commit", "-q", "-m", "init");
  return dir;
}

/** Point codec at an isolated data folder and a fake agent. */
export function useIsolatedHome(fakeAgent: string): string {
  const home = tempDir("codec-home-");
  process.env.CODEC_HOME = home;
  process.env.CODEC_AGENT_COMMAND = fakeAgent;
  process.env.CODEC_TEST_COMMAND = "true";
  return home;
}

export async function waitFor(runId: string, timeoutMs = 15_000): Promise<RunStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = getRunStatus(runId)!;
    if (s.state !== "running") return s;
    if (Date.now() > deadline) throw new Error(`${runId} still running after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const ROOT = resolve(import.meta.dirname, "..");

/** Run the real CLI in a separate process (a fresh "restart" every call). */
export function cli(args: string[], env: Record<string, string | undefined> = {}) {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "src/cli.ts"), ...args], {
    cwd: ROOT,
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
