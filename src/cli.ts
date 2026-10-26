/**
 * cli.ts — the `codec` command.
 */

import { addProject, listProjects } from "./registry.js";
import { startDashboard } from "./dashboard.js";
import { cleanRun, listRuns, removeProjectChecked, runOutput, startRun, stopRun, type RunStatus } from "./runs.js";
import { codecHome } from "./store.js";

const HELP = `codec — run AI coding agents on many projects at once

Projects
  codec project add <path> [--name <name>]   register a git repository
  codec project list                         list registered projects
  codec project remove <name>                unregister (the repo is not touched)

Runs
  codec run <project> --agent claude|codex --task "<text>"
                                             start an agent in a fresh worktree
  codec status [--project <name>] [--json]   every run across all projects
  codec logs <run> [--lines N]               show a run's recent output
  codec stop <run>                           stop a running agent
  codec clean <run> [--force] [--delete-branch]
                                             remove a finished run's worktree

Dashboard
  codec dashboard [--port N]                 local web page (default port 4777)

<run> can be the full id (run-1a2b3c4d) or a unique prefix (1a2b).
Data folder: ${codecHome()}  (override with CODEC_HOME)
`;

interface Parsed {
  positional: string[];
  flags: Record<string, string | true>;
}

const BOOLEAN_FLAGS = new Set(["json", "force", "delete-branch", "help"]);

function parse(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") {
      flags.help = true;
    } else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        if (BOOLEAN_FLAGS.has(key)) flags[key] = true;
        else {
          const v = argv[++i];
          if (v === undefined) throw new Error(`--${key} needs a value`);
          flags[key] = v;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function str(flags: Parsed["flags"], key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

function need(value: string | undefined, usage: string): string {
  if (!value) throw new Error(`usage: ${usage}`);
  return value;
}

function table(rows: string[][]): string {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return rows.map((r) => r.map((cell, c) => cell.padEnd(widths[c])).join("  ").trimEnd()).join("\n");
}

function localTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function stateLabel(r: RunStatus): string {
  if (r.state === "failed" && r.exitCode !== undefined) return `failed (exit ${r.exitCode})`;
  if (r.state === "failed" && r.lostAt) return "failed (lost)";
  return r.state;
}

export function main(argv: string[]): number {
  const { positional, flags } = parse(argv);
  const [cmd, sub, ...rest] = positional;
  const out = (s: string) => process.stdout.write(s + "\n");

  if (!cmd || flags.help || cmd === "help") {
    out(HELP);
    return 0;
  }

  switch (cmd) {
    case "project": {
      if (sub === "add") {
        const p = addProject(need(rest[0], "codec project add <path> [--name <name>]"), str(flags, "name"));
        out(`added ${p.name}  ${p.path}`);
      } else if (sub === "list") {
        const ps = listProjects();
        if (flags.json) out(JSON.stringify(ps, null, 2));
        else if (!ps.length) out("no projects yet — add one with: codec project add <path>");
        else {
          const running = listRuns({ state: "running" });
          out(
            table([
              ["NAME", "RUNNING", "PATH"],
              ...ps.map((p) => [p.name, String(running.filter((r) => r.project === p.name).length), p.path]),
            ]),
          );
        }
      } else if (sub === "remove") {
        const name = need(rest[0], "codec project remove <name>");
        removeProjectChecked(name);
        out(`removed ${name} (repository and existing worktrees untouched)`);
      } else {
        throw new Error("usage: codec project add|list|remove");
      }
      return 0;
    }

    case "run": {
      const usage = 'codec run <project> --agent claude|codex --task "<text>"';
      const r = startRun({
        project: need(sub, usage),
        agent: need(str(flags, "agent"), usage),
        task: need(str(flags, "task"), usage),
      });
      out(`started ${r.runId}  ${r.agent} on ${r.project}`);
      out(`  branch   ${r.branch}`);
      out(`  worktree ${r.worktree}`);
      return 0;
    }

    case "status": {
      const runs = listRuns({ project: str(flags, "project") });
      if (flags.json) {
        out(JSON.stringify(runs, null, 2));
        return 0;
      }
      if (!runs.length) {
        out("no runs yet");
        return 0;
      }
      out(
        table([
          ["RUN", "PROJECT", "AGENT", "STATE", "STARTED", "WORKTREE"],
          ...runs.map((r) => [
            r.runId,
            r.project,
            r.agent,
            stateLabel(r),
            localTime(r.startedAt),
            r.cleanedAt ? "(cleaned)" : r.worktree,
          ]),
        ]),
      );
      const running = runs.filter((r) => r.state === "running").length;
      out(`\n${runs.length} run(s), ${running} running`);
      return 0;
    }

    case "logs": {
      const lines = Number(str(flags, "lines") ?? 50);
      out(runOutput(need(sub, "codec logs <run> [--lines N]"), Number.isFinite(lines) ? lines : 50));
      return 0;
    }

    case "stop": {
      const r = stopRun(need(sub, "codec stop <run>"));
      out(`stopped ${r.runId}`);
      return 0;
    }

    case "clean": {
      const r = cleanRun(need(sub, "codec clean <run> [--force] [--delete-branch]"), {
        force: !!flags.force,
        deleteBranch: !!flags["delete-branch"],
      });
      out(`cleaned ${r.runId} — worktree removed; branch ${r.branch} ${flags["delete-branch"] ? "deleted" : "kept"}`);
      return 0;
    }

    case "dashboard": {
      const raw = str(flags, "port") ?? "4777";
      const port = Number(raw);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid --port "${raw}"`);
      startDashboard({ port }).then(
        (d) => {
          out(`Codec dashboard: ${d.url}`);
          out("Local only (127.0.0.1). The link contains a secret token — don't share it. Ctrl+C to stop.");
        },
        (e: unknown) => {
          process.stderr.write(`codec: ${e instanceof Error ? e.message : String(e)}\n`);
          process.exitCode = 1;
        },
      );
      return 0;
    }

    default:
      throw new Error(`unknown command "${cmd}" — run: codec help`);
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`codec: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
}
