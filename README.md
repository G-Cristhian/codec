# Codec

Run AI coding agents (Claude Code or Codex) on several projects at the same time.
Every agent works in its own git worktree on its own branch, so agents never
overwrite each other's work or your own checkout.

Everything runs locally. The only network listener is the optional dashboard,
which is reachable from this computer only (see below).

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

| `codec dashboard [--port N]` | Open a local web page (default port 4777) showing every project and run, with live updates. |

`<run>` is the run id (`run-1a2b3c4d`) or any unique prefix of it (`1a2b`).

Run states: `running`, `done` (exit 0), `failed` (non-zero exit, or the agent
died without reporting, e.g. after a reboot), `stopped`.

## Dashboard

`codec dashboard` prints a link like `http://127.0.0.1:4777/?token=…` and keeps
running until you press Ctrl+C. Open the link in a browser to:

- see how many agents are running and how much memory they use (Linux; "n/a"
  elsewhere), every project with its run counts, and every run;
- open a project board with four lanes: **Working** (running), **Needs you**
  (failed or stopped), **In review** (finished, worktree still there) and
  **Done** (worktree cleaned);
- start an agent (claude or codex) on a project, open a run to read its full
  task and live output, stop it, or clean its worktree;
- add or remove projects.

The page refreshes itself every 2 seconds. It is a view over the same `~/.codec`
data and calls the same code as the commands above, so the CLI and the page can
be used side by side.

Because the page can start agents that have full permissions, it is locked down:

- it listens on `127.0.0.1` only, never on your network;
- requests whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` are
  refused, so a malicious website can't reach it through DNS tricks;
- a new random token is created each time it starts and is part of the printed
  link. Every API call needs it, and anything that changes state must be a
  `POST` carrying the token in a header, so other websites can't trigger
  actions. Don't share the link.

## Run on your Mac

Install **Node.js 22.12 or newer**, **Homebrew**, and **tmux** first (in Terminal,
run `brew install tmux`). Install **Claude Code and/or Codex** and sign in to
whichever you want to use. You also need git; opening git once in Terminal will
prompt you to install Apple's command line tools if they are missing.

After `git pull`, open Terminal in your Codec folder and run these commands,
one at a time:

```sh
npm install
npm run build
npm run install-launcher
```

In Finder, open your home folder's **Applications** folder and double-click
**Codec**. If macOS says it is from an unidentified developer, right-click
**Codec**, choose **Open**, and confirm **Open**. If that doesn't work, open
**System Settings → Privacy & Security**, scroll down, and click **Open Anyway**
next to the Codec message, then double-click **Codec** again and confirm **Open**.
This is a local app launcher,
with a Codec icon, rather than a signed installer. Keep the Codec folder where
it is; run `npm run install-launcher` again if you move it or replace Node.js.

Your Mac saves Codec's data in `~/.codec`. Clicking the Dock icon brings the
window forward. Closing the window stops Codec's dashboard and quits the app;
helpers already working keep going. You can also start Codec from Terminal
with `npm run app`.

## Desktop app (macOS and Linux, Stage B0)

With Node 22.12+ and the development dependencies installed, run:

```sh
npm run app
```

This builds the TypeScript code and opens **Codec** in its own window. The app
starts the same dashboard on an OS-assigned loopback port, independently of any
`codec dashboard` on port 4777. It passes authentication directly to the window
as an HttpOnly cookie in a memory-only session; no private link is printed or
shown. Outside web links open in your system browser. Clicking the launcher
again restores and shows the existing window and asks the desktop to focus it.
GNOME Wayland can refuse window activation while the session is locked; unlock
the desktop before bringing Codec forward.

Closing the window stops its dashboard server, cancels temporary tool checks,
and exits Electron. Helpers keep
running as detached background processes, just as they do when the CLI dashboard
stops. The app uses the same `CODEC_HOME` data and setup wizard as the CLI;
it does not bundle Node, git, tmux, Claude Code, or Codex.

On Linux, install this machine's app-menu entry after installing dependencies:

```sh
npm run install-launcher
```

This builds the app and writes `~/.local/share/applications/codec.desktop`,
using absolute paths to this checkout, its icon, and the current Node executable.
The launcher sets `CODEC_HOME=/home/cristhian/projects/codec-home`; installing it
does not create or modify that data folder. Choose **Codec** in GNOME's app menu
to launch. It inherits the desktop session's display variables. Reinstall the
launcher if the checkout or Node executable moves. For a different home from a
terminal, use `CODEC_HOME=/path/to/home npm run app`.

On this Ubuntu machine, AppArmor restricts unprivileged user namespaces, and
the development Electron `chrome-sandbox` is not a root-owned setuid helper.
The app runner checks those conditions and probes `unshare -Ur true`; if the
probe fails, it adds **`--no-sandbox` for this app launch only** and prints a
short notice. This is the B0 workaround: Chromium's OS sandbox is disabled,
while Node integration remains off and context isolation stays on. Navigation
stays within the local dashboard; outside HTTP(S) links go to the system browser.
No system AppArmor policy, sysctl, or file ownership is changed. See Chromium's
[AppArmor explanation](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md).
This workaround and the Linux window-class flag apply only on Linux; macOS
uses Electron’s default sandbox even if `CODEC_NO_SANDBOX` is set.
Use `CODEC_NO_SANDBOX=0 npm run app` to require sandboxing after an administrator
configures it, or `CODEC_NO_SANDBOX=1 npm run app` to explicitly select the workaround.

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
