/**
 * cli.ts — the `codec` command.
 */

import { checkTimeLimit, DEFAULT_TIME_LIMIT_MINUTES, formatTimeLimit } from "./limits.js";
import { addProject, listProjects, setProjectMessageLimit } from "./registry.js";
import { startDashboard } from "./dashboard.js";
import { readFileSync } from "fs";
import {
  cleanRun,
  currentHelperRun,
  findRun,
  listRuns,
  removeMemberChecked,
  removeProjectChecked,
  removeTeamChecked,
  reportHelperStatus,
  runOutput,
  skillsUsed,
  startRun,
  stopRun,
  type RunStatus,
} from "./runs.js";
import {
  addMember,
  addSpecialist,
  addTeam,
  clonesOf,
  editSpecialist,
  listSpecialists,
  listTeams,
  removeSkillEverywhere,
  removeSpecialist,
  resolveMember,
  setTeamProjects,
  setTeamMessageLimit,
  skillHolders,
} from "./org.js";
import { importSkill, listSkills } from "./skills.js";
import { codecHome } from "./store.js";
import { postMessage } from "./messages.js";
import { saveIdentity } from "./settings.js";
import { S, wording } from "./strings.js";
import { assignByRole, getCoordinator, helperRef, setupCoordinator } from "./coordinator.js";
import { CodecError } from "./errors.js";

const HELP = `codec — run AI coding agents on many projects at once

Projects
${wording(S.cli.messageLimitHelp, { scope: "project" })}
  codec project add <path> [--name <name>]   register a git repository
  codec project list                         list registered projects
  codec project remove <name>                unregister (the repo is not touched)

Runs
  codec run <project> --member <team>/<member> --task "<text>" [--time-limit <minutes>]
                                             start a team member in a fresh worktree
  codec run <project> --agent claude|codex --task "<text>" [--time-limit <minutes>]
                                             start an unassigned worker
  codec status [--project <name>] [--json]   every run across all projects
  codec logs <run> [--lines N]               show a run's recent output
  codec skills <run>                         skills a run was given and used
  codec stop <run>                           stop a running agent
  codec clean <run> [--force] [--delete-branch]
                                             remove a finished run's worktree

Skills  (folders with a SKILL.md, Claude Code format)
  codec skill add <folder>                   copy a skill into the library
  codec skill list [--json]                  the library and who has each skill
  codec skill remove <name>                  delete it and take it away from everyone

Specialists  (agent templates)
  codec specialist add <name> --specialty <text> --tool claude|codex
        [--model <m>] [--instructions "<text>" | --instructions-file <f>] [--skills a,b] [--time-limit <minutes>]
  codec specialist edit <name> [same options]
  codec specialist list [--json]
  codec specialist remove <name>             refused while it has clones in teams

Teams
${wording(S.cli.messageLimitHelp, { scope: "team" })}
  codec team add <name> --projects a,b       create a team working on these projects
  codec team edit <name> --projects a,b      change its projects
  codec team list [--json]                   teams, projects and members
  codec team remove <name>                   refused while a member is working
  codec team member add <team> --specialist <name> [--name <n>] [--skills a,b] [--time-limit <minutes>]
                                             add a clone of a specialist
  codec team member add <team> --tool claude|codex [--name <n>] [--model <m>] [--skills a,b] [--time-limit <minutes>]
                                             add a plain worker
  codec team member remove <team> <member>   refused while it is working

Dashboard
  codec dashboard [--port N]                 local web page (default port 4777)

${S.cli.identityHelp}

${S.cli.coordinatorHelp}

${S.cli.helperHelp}

Time limits: run > team member > specialist > 60 minutes. Positive minutes, up to 1440; fractions allowed.

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

function timeLimit(flags: Parsed["flags"]): number | undefined {
  const value = str(flags, "time-limit");
  return checkTimeLimit(value === undefined ? undefined : Number(value));
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

function list(flags: Parsed["flags"], key: string): string[] | undefined {
  const v = str(flags, key);
  if (v === undefined) return undefined;
  return v.split(",").map((x) => x.trim()).filter(Boolean);
}

function who(r: RunStatus): string {
  return helperRef(r) === "coordinator" ? S.coordinator.name : helperRef(r) ?? "unassigned worker";
}

function skillList(r: RunStatus): string {
  return r.skills?.length ? r.skills.map((x) => `${x.name} (${x.source})`).join(", ") : "none";
}

function stateLabel(r: RunStatus): string {
  if (r.state === "timed_out") return `Stopped: took longer than ${formatTimeLimit(r.timeLimitMinutes)}`;
  if (r.state === "failed" && r.exitCode !== undefined) return `failed (exit ${r.exitCode})`;
  if (r.state === "failed" && r.lostAt) return "failed (lost)";
  return r.state;
}

export function main(argv: string[]): number {
  // Helper text is positional, including quoted text that starts with a dash.
  let parsed: Parsed;
  if (argv[0] === "assign") {
    const options = parse(argv.slice(3));
    parsed = { positional: argv.slice(0, 3).concat(options.positional), flags: options.flags };
  } else parsed = argv[0] === "message" || argv[0] === "report" ? { positional: argv, flags: {} } : parse(argv);
  const { positional, flags } = parsed;
  const [cmd, sub, ...rest] = positional;
  const out = (s: string) => process.stdout.write(s + "\n");

  if (!cmd || flags.help || cmd === "help") {
    out(HELP);
    return 0;
  }

  switch (cmd) {
    case "coordinator": {
      if (sub === "setup") {
        if (rest.length) throw new Error(S.cli.coordinatorUsage);
        setupCoordinator({ tool: str(flags, "tool") ?? "", model: str(flags, "model"), timeLimitMinutes: timeLimit(flags) });
        out(S.common.saved);
      } else if (sub) throw new Error(S.cli.coordinatorUsage);
      const settings = getCoordinator();
      if (!settings) out(S.coordinator.notSetup);
      else out(wording(S.cli.coordinatorSettings, {
        tool: S.setup[settings.tool], model: settings.model ?? S.common.defaultModel,
        limit: formatTimeLimit(settings.timeLimitMinutes ?? DEFAULT_TIME_LIMIT_MINUTES),
        state: listRuns({ state: "running" }).some((run) => helperRef(run) === "coordinator") ? S.tasks.working : S.home.free,
      }));
      return 0;
    }
    case "assign": {
      let run;
      try { run = currentHelperRun(); } catch { throw new CodecError("coordinator_only", S.errors.coordinator_only); }
      if (helperRef(run) !== "coordinator") throw new CodecError("coordinator_only", S.errors.coordinator_only);
      if (!sub || rest.length !== 1 || Object.keys(flags).some((key) => key !== "project")) throw new Error(S.cli.assignUsage);
      const assigned = assignByRole({ project: str(flags, "project") ?? run.project, role: sub, task: rest[0] });
      out(wording(S.cli.assigned, assigned));
      return 0;
    }
    case "message": {
      const run = currentHelperRun();
      if (!sub || rest.length > 1) throw new Error(S.cli.messageUsage);
      const message = postMessage({ from: helperRef(run)!, to: sub, body: rest[0] ?? "" });
      out(message.declined ? S.coordinator.pmOnly : wording(S.cli.messageSent, { helper: message.to === "coordinator" ? S.coordinator.name : message.to }));
      return 0;
    }
    case "report": {
      if (rest.length > 1) throw new Error(S.cli.reportUsage);
      const status = reportHelperStatus(sub ?? "", rest[0]);
      out(wording(S.cli.statusReported, { state: status.state }));
      return 0;
    }
    case "settings": {
      if (sub !== "identity") throw new Error(S.cli.identityUsage);
      saveIdentity({ name: str(flags, "name") ?? "", email: str(flags, "email") ?? "" });
      out(S.common.saved);
      return 0;
    }
    case "project": {
      if (sub === "message-limit") {
        if (rest.length !== 2) throw new Error(wording(S.cli.messageLimitUsage, { scope: "project" }));
        setProjectMessageLimit(rest[0], rest[1] === "default" ? undefined : Number(rest[1]));
        out(S.common.saved);
      } else if (sub === "add") {
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
        throw new Error("usage: codec project add|list|remove|message-limit");
      }
      return 0;
    }

    case "run": {
      const usage = 'codec run <project> (--member <team>/<member> | --agent claude|codex) --task "<text>"';
      const r = startRun({
        project: need(sub, usage),
        agent: str(flags, "agent"),
        member: str(flags, "member"),
        task: need(str(flags, "task"), usage),
        timeLimitMinutes: timeLimit(flags),
      });
      out(`started ${r.runId}  ${who(r)} (${r.agent}) on ${r.project}`);
      out(`  branch   ${r.branch}`);
      out(`  worktree ${r.worktree}`);
      out(`  skills   ${skillList(r)}`);
      out(`  time limit ${formatTimeLimit(r.timeLimitMinutes)}`);
      return 0;
    }

    case "skill": {
      if (sub === "add") {
        const sk = importSkill(need(rest[0], "codec skill add <folder>"));
        out(`added skill ${sk.name} — ${sk.description}`);
      } else if (sub === "list") {
        const skills = listSkills().map((sk) => ({ ...sk, ...skillHolders(sk.name) }));
        if (flags.json) out(JSON.stringify(skills, null, 2));
        else if (!skills.length) out("no skills yet — add one with: codec skill add <folder>");
        else
          out(
            table([
              ["SKILL", "SPECIALISTS", "MEMBERS (own)", "DESCRIPTION"],
              ...skills.map((sk) => [
                sk.name,
                sk.specialists.join(", ") || "-",
                sk.members.join(", ") || "-",
                sk.description.length > 60 ? sk.description.slice(0, 59) + "…" : sk.description,
              ]),
            ]),
          );
      } else if (sub === "remove") {
        const name = need(rest[0], "codec skill remove <name>");
        const h = removeSkillEverywhere(name);
        const from = [...h.specialists, ...h.members];
        out(`removed skill ${name}${from.length ? ` (taken away from: ${from.join(", ")})` : ""}`);
      } else throw new Error("usage: codec skill add|list|remove");
      return 0;
    }

    case "specialist": {
      const fields = () => ({
        specialty: str(flags, "specialty"),
        tool: str(flags, "tool"),
        model: str(flags, "model"),
        instructions: str(flags, "instructions-file")
          ? readFileSync(str(flags, "instructions-file")!, "utf-8")
          : str(flags, "instructions"),
        skills: list(flags, "skills"),
        timeLimitMinutes: timeLimit(flags),
      });
      if (sub === "add") {
        const sp = addSpecialist({
          name: need(rest[0], "codec specialist add <name> --specialty <text> --tool claude|codex"),
          ...fields(),
        });
        out(`added specialist ${sp.name} (${sp.specialty}, ${sp.tool})`);
      } else if (sub === "edit") {
        const sp = editSpecialist(need(rest[0], "codec specialist edit <name> [options]"), fields());
        out(`updated specialist ${sp.name}`);
      } else if (sub === "list") {
        const specs = listSpecialists().map((sp) => ({ ...sp, clones: clonesOf(sp.name) }));
        if (flags.json) out(JSON.stringify(specs, null, 2));
        else if (!specs.length) out("no specialists yet");
        else
          out(
            table([
              ["SPECIALIST", "SPECIALTY", "TOOL", "MODEL", "SKILLS", "CLONES"],
              ...specs.map((sp) => [
                sp.name,
                sp.specialty,
                sp.tool,
                sp.model ?? "default",
                sp.skills.join(", ") || "-",
                sp.clones.map((c) => `${c.team}/${c.member}`).join(", ") || "-",
              ]),
            ]),
          );
      } else if (sub === "remove") {
        removeSpecialist(need(rest[0], "codec specialist remove <name>"));
        out(`removed specialist ${rest[0]}`);
      } else throw new Error("usage: codec specialist add|edit|list|remove");
      return 0;
    }

    case "team": {
      if (sub === "message-limit") {
        if (rest.length !== 2) throw new Error(wording(S.cli.messageLimitUsage, { scope: "team" }));
        setTeamMessageLimit(rest[0], rest[1] === "default" ? undefined : Number(rest[1]));
        out(S.common.saved);
      } else if (sub === "member") {
        const [action, team, member] = rest;
        const addUsage = "codec team member add <team> (--specialist <name> | --tool claude|codex)";
        const rmUsage = "codec team member remove <team> <member>";
        if (action === "add") {
          const m = addMember(need(team, addUsage), {
            name: str(flags, "name"),
            specialist: str(flags, "specialist"),
            tool: str(flags, "tool"),
            model: str(flags, "model"),
            skills: list(flags, "skills"),
            timeLimitMinutes: timeLimit(flags),
          });
          out(`added ${team}/${m.name} (${m.kind === "clone" ? `clone of ${m.specialist}` : `${m.tool} worker`})`);
        } else if (action === "remove") {
          removeMemberChecked(need(team, rmUsage), need(member, rmUsage));
          out(`removed ${team}/${member}`);
        } else throw new Error("usage: codec team member add|remove");
      } else if (sub === "add") {
        const t = addTeam({ name: need(rest[0], "codec team add <name> --projects a,b"), projects: list(flags, "projects") });
        out(`added team ${t.name} (projects: ${t.projects.join(", ")})`);
      } else if (sub === "edit") {
        const t = setTeamProjects(need(rest[0], "codec team edit <name> --projects a,b"), list(flags, "projects") ?? []);
        out(`team ${t.name} now works on: ${t.projects.join(", ")}`);
      } else if (sub === "list") {
        const teams = listTeams();
        if (flags.json) out(JSON.stringify(teams, null, 2));
        else if (!teams.length) out("no teams yet — create one with: codec team add <name> --projects <project>");
        else {
          const running = listRuns({ state: "running" });
          for (const t of teams) {
            out(`${t.name}  (projects: ${t.projects.join(", ") || "none"})`);
            if (!t.members.length) out("  no members yet");
            for (const m of t.members) {
              const r = resolveMember(t.name, m.name);
              const busy = running.filter((x) => x.team === t.name && x.member === m.name);
              const kind = m.kind === "clone" ? `clone of ${m.specialist}` : "worker";
              out(
                `  ${m.name.padEnd(18)} ${kind.padEnd(22)} ${r.tool.padEnd(7)} skills: ${r.skills.map((x) => x.name).join(", ") || "-"}` +
                  (busy.length ? `   working: ${busy.map((x) => x.runId).join(", ")}` : ""),
              );
            }
          }
        }
      } else if (sub === "remove") {
        removeTeamChecked(need(rest[0], "codec team remove <name>"));
        out(`removed team ${rest[0]}`);
      } else throw new Error("usage: codec team add|edit|list|remove|member");
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
          ["RUN", "PROJECT", "WHO", "AGENT", "STATE", "TIME LIMIT", "STARTED", "WORKTREE"],
          ...runs.map((r) => [
            r.runId,
            r.project,
            who(r),
            r.agent,
            stateLabel(r),
            formatTimeLimit(r.timeLimitMinutes),
            localTime(r.startedAt),
            r.cleanedAt ? "(cleaned)" : r.worktree,
          ]),
        ]),
      );
      const running = runs.filter((r) => r.state === "running").length;
      out(`\n${runs.length} run(s), ${running} running`);
      return 0;
    }

    case "skills": {
      const r = findRun(need(sub, "codec skills <run>"));
      out(`given: ${skillList(r)}`);
      const used = skillsUsed(r.runId);
      const none = r.agent === "codex" ? "none spotted (codex: best-effort guess only)" : "none";
      out(`used:  ${used.length ? used.map((u) => `${u.name}${u.how === "guess" ? " (guess)" : ""}`).join(", ") : none}`);
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
          let closing = false;
          const stop = () => {
            if (closing) return;
            closing = true;
            void d.close().finally(() => {
              process.off("SIGINT", stop);
              process.off("SIGTERM", stop);
            });
          };
          process.on("SIGINT", stop);
          process.on("SIGTERM", stop);
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
