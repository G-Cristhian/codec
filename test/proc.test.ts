import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { isOurProcess, ownsProcessGroup, procInfo, type ProcOs } from "../src/proc.js";

const pid = 1234;
const needle = "/tmp/codec-run/run.sh";

function linux(command = `bash\0${needle}\0`, state = "S", comm = "bash"): ProcOs {
  const files: Record<string, string> = {
    [`/proc/${pid}/cmdline`]: command,
    [`/proc/${pid}/stat`]: `${pid} (${comm}) ${state} 1 2 3 4 5`,
  };
  return {
    platform: "linux",
    exists: (path) => path in files,
    readFile: (path) => {
      if (!(path in files)) throw new Error("ENOENT");
      return files[path];
    },
    exec: () => { throw new Error("unexpected exec"); },
  };
}

function darwin(output: string | Error): ProcOs {
  return {
    platform: "darwin",
    exists: () => false,
    readFile: () => { throw new Error("unexpected read"); },
    exec: (cmd, args) => {
      expect(cmd).toBe("ps");
      expect(args).toEqual(["-o", "stat=", "-o", "lstart=", "-o", "command=", "-p", String(pid)]);
      if (output instanceof Error) throw output;
      return output;
    },
  };
}

describe("Linux process inspection", () => {
  it("matches a live process and joins NUL-separated arguments", () => {
    const os = linux();
    expect(procInfo(pid, os)).toEqual({ alive: true, zombie: false, command: `bash ${needle}` });
    expect(isOurProcess(pid, needle, os)).toBe(true);
  });

  it("rejects a reused PID with a different command", () => {
    expect(isOurProcess(pid, needle, linux("other\0command\0"))).toBe(false);
  });

  it("rejects a zombie even when its command matches", () => {
    const os = linux(`bash\0${needle}\0`, "Z");
    expect(procInfo(pid, os)?.zombie).toBe(true);
    expect(isOurProcess(pid, needle, os)).toBe(false);
  });

  it("returns undefined and false for a missing process", () => {
    expect(procInfo(pid + 1, linux())).toBeUndefined();
    expect(isOurProcess(pid + 1, needle, linux())).toBe(false);
  });

  it("parses the state after a comm containing closing parentheses", () => {
    const os = linux(`bash\0${needle}\0`, "S", "worker) Z (nested)");
    expect(procInfo(pid, os)?.zombie).toBe(false);
    expect(isOurProcess(pid, needle, os)).toBe(true);
    expect(isOurProcess(pid, needle, linux("", "Z", "worker) S (nested)"))).toBe(false);
  });
});

describe("macOS process inspection", () => {
  it("matches a live process in realistic ps output", () => {
    const os = darwin(`Ss   Tue Oct 27 09:12:34 2026 /bin/bash ${needle}\n`);
    expect(isOurProcess(pid, needle, os)).toBe(true);
    expect(procInfo(pid, os)).toEqual({
      alive: true, zombie: false, command: `/bin/bash ${needle}`,
      startedAt: new Date("Tue Oct 27 09:12:34 2026").getTime(),
    });
  });

  it("rejects a reused PID", () => {
    expect(isOurProcess(pid, needle, darwin("S    Tue Oct  6 09:12:34 2026 /usr/bin/other\n"))).toBe(false);
  });

  it("rejects a zombie with additional stat flags", () => {
    const os = darwin(`Z+   Tue Oct 27 09:12:34 2026 /bin/bash ${needle}\n`);
    expect(procInfo(pid, os)?.zombie).toBe(true);
    expect(isOurProcess(pid, needle, os)).toBe(false);
  });

  it("handles ps exiting non-zero", () => {
    const os = darwin(new Error("ps exited with status 1"));
    expect(procInfo(pid, os)).toBeUndefined();
    expect(isOurProcess(pid, needle, os)).toBe(false);
  });

  it("handles empty ps output", () => {
    expect(procInfo(pid, darwin(" \n"))).toBeUndefined();
    expect(isOurProcess(pid, needle, darwin(" \n"))).toBe(false);
  });
});

describe("input validation and platform fallback", () => {
  it.each([0, -1, NaN, Infinity, 1.5])("rejects invalid PID %s", (invalid) => {
    expect(procInfo(invalid, linux())).toBeUndefined();
    expect(isOurProcess(invalid, needle, linux())).toBe(false);
  });

  it("uses liveness when the platform cannot inspect commands", () => {
    const os: ProcOs = { ...linux(), platform: "win32" };
    expect(procInfo(process.pid, os)).toEqual({ alive: true, zombie: false, command: "" });
    expect(isOurProcess(process.pid, "unknown command", os)).toBe(true);
    expect(isOurProcess(2_147_483_647, needle, os)).toBe(false);
  });
});

describe("saved process group ownership", () => {
  const directory = "/tmp/codec run";
  const group = 2000;
  function groupOs(table: string, environment: string | Error, platform: "linux" | "darwin" = "darwin"): ProcOs {
    return {
      platform,
      exists: () => false,
      readFile: (path) => {
        expect(path).toBe("/proc/2001/environ");
        if (environment instanceof Error) throw environment;
        return environment;
      },
      exec: vi.fn((cmd, args) => {
        expect(cmd).toBe("ps");
        if (args[0] === "-A") {
          expect(args).toEqual(["-A", "-o", "pid=,pgid=,stat="]);
          return table;
        }
        expect(args).toEqual(["eww", "-p", "2001", "-o", "command="]);
        if (environment instanceof Error) throw environment;
        return environment;
      }),
    };
  }

  it("finds a live macOS descendant after its group leader has exited", () => {
    const os = groupOs("  2001  2000 S+\n", `sleep 120 CODEC_RUN_DIR=${directory} PATH=/bin\n`);
    expect(ownsProcessGroup(group, directory, os)).toBe(true);
  });

  it.each([
    [" 2001 2000 Z+\n", `sleep CODEC_RUN_DIR=${directory}`],
    [" 2001 3000 S\n", `sleep CODEC_RUN_DIR=${directory}`],
    [" 2001 2000 S\n", "sleep CODEC_RUN_DIR=/another/run"],
    [" 2001 2000 S\n", `sleep CODEC_RUN_DIR=${directory}-other`],
    [" 2001 2000 S\n", `sleep OTHER_CODEC_RUN_DIR=${directory}`],
    [" 2001 2000 S\n", new Error("environment unavailable")],
    ["", ""],
    ["malformed output", ""],
  ])("rejects unverified macOS group members (%s)", (table, environment) => {
    expect(ownsProcessGroup(group, directory, groupOs(table as string, environment))).toBe(false);
  });

  it("fails closed when macOS ps fails", () => {
    const os = groupOs("", "");
    os.exec = () => { throw new Error("ps failed"); };
    expect(ownsProcessGroup(group, directory, os)).toBe(false);
  });

  it("uses exact NUL-delimited environment entries on Linux", () => {
    const os = groupOs("2001 2000 S\n", `PATH=/bin\0CODEC_RUN_DIR=${directory}\0`, "linux");
    expect(ownsProcessGroup(group, directory, os)).toBe(true);
    expect(os.exec).toHaveBeenCalledTimes(1);
    expect(ownsProcessGroup(group, directory, groupOs("2001 2000 S\n", new Error("denied"), "linux"))).toBe(false);
  });

  it.each([0, 1, -1, NaN, 1.5])("rejects unsafe group %s without inspecting processes", (invalid) => {
    const os = groupOs("", "");
    expect(ownsProcessGroup(invalid, directory, os)).toBe(false);
    expect(os.exec).not.toHaveBeenCalled();
  });
});

it.skipIf(process.platform !== "linux")("inspects a real sleep process and detects its exit", async () => {
  const uniqueArg = `codec-proc-${randomUUID()}`;
  // argv0 supplies a unique command-line argument without passing an invalid
  // duration to sleep. The process still runs sleep 30 directly.
  const child = spawn("sleep", ["30"], { argv0: uniqueArg, stdio: "ignore" });
  const exited = once(child, "exit");
  try {
    await once(child, "spawn");
    expect(isOurProcess(child.pid!, uniqueArg)).toBe(true);
    expect(isOurProcess(child.pid!, "nope")).toBe(false);
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
  expect(procInfo(child.pid!)).toBeUndefined();
  expect(isOurProcess(child.pid!, uniqueArg)).toBe(false);
});
