import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export interface ProcInfo {
  alive: boolean;
  zombie: boolean;
  command: string;
  /** Epoch milliseconds, if known. */
  startedAt?: number;
}

export interface ProcOs {
  platform: NodeJS.Platform;
  readFile(path: string): string;
  exists(path: string): boolean;
  exec(cmd: string, args: string[]): string;
}

export const realOs: ProcOs = {
  platform: process.platform,
  readFile: (path) => readFileSync(path, "utf8"),
  exists: existsSync,
  exec: (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
};

export function procInfo(pid: number, os: ProcOs = realOs): ProcInfo | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;

  try {
    if (os.platform === "linux") {
      const stat = os.readFile(`/proc/${pid}/stat`);
      // comm may itself contain spaces and closing parentheses.
      const end = stat.lastIndexOf(")");
      if (end < 0) return undefined;
      const state = stat.slice(end + 1).trim().split(/\s+/)[0];
      if (!state) return undefined;
      const command = os.readFile(`/proc/${pid}/cmdline`).replace(/\0+$/, "").replace(/\0/g, " ");
      return { alive: true, zombie: state === "Z", command };
    }

    if (os.platform === "darwin") {
      const output = os.exec("ps", ["-o", "stat=", "-o", "lstart=", "-o", "command=", "-p", String(pid)]);
      const match = output.trim().match(/^(\S+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+([\s\S]*)$/);
      if (!match) return undefined;
      const startedAt = Date.parse(match[2]);
      return {
        alive: true,
        zombie: match[1].startsWith("Z"),
        command: match[3],
        ...(Number.isFinite(startedAt) ? { startedAt } : {}),
      };
    }

    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") return undefined;
    }
    return { alive: true, zombie: false, command: "" };
  } catch {
    return undefined;
  }
}

/** True only if pid exists, is not a zombie, and its command line contains needle. */
export function isOurProcess(pid: number, needle: string, os: ProcOs = realOs): boolean {
  try {
    const info = procInfo(pid, os);
    if (!info?.alive || info.zombie) return false;
    // Other platforms have no command inspection: preserve kill(pid, 0)
    // liveness, accepting the risk of PID reuse when the command is unknown.
    if (os.platform !== "linux" && os.platform !== "darwin") return true;
    return info.command.includes(needle);
  } catch {
    return false;
  }
}

/** Verify a saved process group using a live member's run environment, even if its leader exited. */
export function ownsProcessGroup(group: number, runDirectory: string, os: ProcOs = realOs): boolean {
  if (!Number.isSafeInteger(group) || group <= 1) return false;
  if (os.platform !== "linux" && os.platform !== "darwin") return false;
  const tag = `CODEC_RUN_DIR=${runDirectory}`;
  try {
    const table = os.exec("ps", ["-A", "-o", "pid=,pgid=,stat="]);
    return table.split("\n").some((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/);
      if (!match || Number(match[1]) <= 1 || Number(match[2]) !== group || match[3].startsWith("Z")) return false;
      try {
        if (os.platform === "linux") {
          return os.readFile(`/proc/${match[1]}/environ`).split("\0").includes(tag);
        }
        const command = os.exec("ps", ["eww", "-p", match[1], "-o", "command="]).trim();
        return (` ${command} `).includes(` ${tag} `);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}
