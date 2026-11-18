/**
 * store.ts — where Codec keeps its state, plus the small file primitives
 * every other module builds on (atomic JSON writes, a cross-process lock,
 * pid liveness).
 *
 * Everything lives under one data folder: $CODEC_HOME, default ~/.codec/.
 * Each `codec` invocation is a short-lived process, so nothing is held in
 * memory between commands — disk is the only source of truth, which is what
 * makes state survive a restart.
 */

import { CodecError } from "./errors.js";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { randomBytes } from "crypto";

export function codecHome(): string {
  return process.env.CODEC_HOME || join(homedir(), ".codec");
}
export const projectsFile = (): string => join(codecHome(), "projects.json");
export const eventsFile = (): string => join(codecHome(), "events.jsonl");
export const runsDir = (): string => join(codecHome(), "runs");
export const worktreesDir = (): string => join(codecHome(), "worktrees");
const locksDir = (): string => join(codecHome(), "locks");
export const skillsDir = (): string => join(codecHome(), "skills");
export const specialistsFile = (): string => join(codecHome(), "specialists.json");
export const teamsFile = (): string => join(codecHome(), "teams.json");
export const coordinatorFile = (): string => join(codecHome(), "coordinator.json");
export const messagesDir = (): string => join(codecHome(), "messages");
export const messageLimitsFile = (): string => join(codecHome(), "message-limits.json");
export const coordinatorInboxFile = (): string => join(messagesDir(), "_coordinator.json");
export const ownerInboxFile = (): string => join(messagesDir(), "_owner.json");
export const inboxFile = (team: string, member: string): string => join(messagesDir(), team, `${member}.json`);

export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

/**
 * Atomic save: write a uniquely named temp file then rename over the target.
 * A crash mid-write can never leave a truncated file, and two processes
 * writing at once can't interleave bytes (from the hive's task registry).
 */
export function writeJsonAtomic(file: string, data: unknown, mode?: number): void {
  writeTextAtomic(file, JSON.stringify(data, null, 2) + "\n", mode);
}

/** The same atomic replacement for plain-text files. Callers hold the relevant lock. */
export function writeTextAtomic(file: string, text: string, mode?: number): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text, { mode });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** True if a process with this pid exists (zombies included). */
export function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const STALE_LOCK_MS = 2000;

/**
 * Run `fn` while holding a named lock shared by every codec process.
 * The lock is a file created with O_EXCL holding the owner's pid. A lock
 * whose owner died (and that is older than STALE_LOCK_MS, so a lock still
 * being written is never mistaken for stale) is broken automatically.
 */
export function withLock<T>(name: string, fn: () => T, timeoutMs = 30_000): T {
  mkdirSync(locksDir(), { recursive: true });
  const file = join(locksDir(), `${name}.lock`);
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        const owner = Number(readFileSync(file, "utf-8"));
        const age = Date.now() - statSync(file).mtimeMs;
        if (owner && !pidAlive(owner) && age > STALE_LOCK_MS) {
          rmSync(file, { force: true });
          continue;
        }
      } catch {
        // Lock vanished between checks — just retry.
      }
      if (Date.now() - start > timeoutMs) {
        throw new CodecError("lock_busy", `timed out waiting for lock "${name}" (${file})`);
      }
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(file, { force: true });
  }
}
