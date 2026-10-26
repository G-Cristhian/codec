# Codec

Run AI coding agents (Claude Code or Codex) on several projects at the same time.
Every agent works in its own git worktree on its own branch, so agents never
overwrite each other's work or your own checkout.

Everything runs locally. Nothing listens on a network port.

## Setup

```sh
npm install
npm run build
npm link        # optional: puts `codec` on your PATH
```

Requires Node 20+, git, and the `claude` and/or `codex` CLI for real runs.

## Commands

| Command | What it does |
|---|---|
| `codec project add <path> [--name <name>]` | Register a git repository (it needs at least one commit). |
| `codec project list` | List projects and how many agents are running on each. |
| `codec project remove <name>` | Unregister a project. The repository is not touched. Refused while agents are running on it. |
| `codec run <project> --agent claude\|codex --task "<text>"` | Create a fresh worktree + branch `codec/<run>` and start the agent there in the background. |
| `codec status [--project <name>] [--json]` | Every run across all projects: project, agent, state, start time, worktree. |
| `codec logs <run> [--lines N]` | Recent output from a run. |
| `codec stop <run>` | Stop a running agent (and anything it started). |
| `codec clean <run> [--force] [--delete-branch]` | Remove a finished run's worktree. `--force` discards uncommitted changes; the branch is kept unless `--delete-branch`. |

`<run>` is the run id (`run-1a2b3c4d`) or any unique prefix of it (`1a2b`).

Run states: `running`, `done` (exit 0), `failed` (non-zero exit, or the agent
died without reporting, e.g. after a reboot), `stopped`.

## How it works

- State lives in `~/.codec/` (override with `CODEC_HOME`):
  `projects.json`, `runs/<run>/` (record, task, output log, exit code),
  `worktrees/<project>/<run>/`, and `events.jsonl`, an append-only log of
  project and run lifecycle events.
- Agents run as detached background processes, so they keep going after the
  `codec` command exits. Status is worked out fresh from disk every time, so
  closing the terminal or restarting `codec` loses nothing.
- Runs on different projects, and multiple runs on one project, all run in
  parallel.
- Agent commands: `claude --dangerously-skip-permissions -p "<task>"` and
  `codex exec --yolo "<task>"`. Set `CODEC_AGENT_COMMAND` to replace them
  (the task file is at `$CODEC_TASK_FILE`). The tests use this for a fake agent.

## Tests

```sh
npm test            # vitest
npm run typecheck
```
