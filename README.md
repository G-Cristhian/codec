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

Requires Node 20.19+ or 22.12+, git, and the `claude` and/or `codex` CLI for real runs.

## Commands

| Command | What it does |
|---|---|
| `codec project add <path> [--name <name>]` | Register a git repository (it needs at least one commit). |
| `codec project message-limit <project> <1-100\|default>` | Set how many messages two helpers can exchange before they need you to continue. Default: 10. |
| `codec team message-limit <team> <1-100\|default>` | Set a team message limit. The lower team limit wins over project settings. |
| `codec project list` | List projects and how many agents are running on each. |
| `codec project remove <name>` | Unregister a project. The repository is not touched. Refused while agents are running on it. |
| `codec run <project> --agent claude\|codex --task "<text>"` | Create a fresh worktree + branch `codec/<run>` and start the agent there in the background. |
| `codec coordinator` | Show the coordinator's settings and whether it is working. |
| `codec coordinator setup --tool claude\|codex [--model <m>] [--time-limit <min>]` | Set up or change the one coordinator for all your projects. |
| `codec run <project> --member coordinator --task "<text>"` | Start the coordinator on any registered project, using its saved tool, model and time limit. Only one coordinator task can run at a time. |
| `codec assign <role> "<task>" [--project <name>]` | Inside a coordinator task, give work to the first free helper with that role on the chosen project. Defaults to the coordinator's current project. |
| `codec status [--project <name>] [--json]` | Every run across all projects: project, agent, state, start time, worktree. |
| `codec message <team/helper> "<text>"` | From inside a helper task, send a message to a helper on your own team. The coordinator can message any team's helpers. It arrives now if they are working, or waits in their inbox for their next task. |
| `codec message coordinator "<text>"` | From inside a PM helper's task, send direction to the coordinator. Other helpers get “Pass this along through your PM.” |
| `codec message owner "<text>"` | Inside a coordinator task, report to the owner in every project's conversation feed. |
| `codec report progress\|stuck\|done ["<note>"]` | From inside a helper task, report progress, ask for a person, or say the work is finished. Stuck needs a note and moves the task to Needs you. |
| `codec logs <run> [--lines N]` | Recent output from a run. |
| `codec stop <run>` | Stop a running agent (and anything it started). |
| `codec clean <run> [--force] [--delete-branch]` | Remove a finished run's worktree. `--force` discards uncommitted changes; the branch is kept unless `--delete-branch`. |

| `codec dashboard [--port N]` | Open a local web page (default port 4777) showing every project and run, with live updates. |

`<run>` is the run id (`run-1a2b3c4d`) or any unique prefix of it (`1a2b`).

Run states: `running`, `done` (exit 0), `failed` (non-zero exit, or the agent
died without reporting, e.g. after a reboot), `stopped`.

Set up the coordinator once, here or on the Helpers page. Its settings live in
`<codecHome>/coordinator.json`. It takes direction from you through the conversation
feed and from helpers whose member name contains “pm” (case-insensitive).
Helpers message each other directly only within their own team. For another team,
PM helpers message the coordinator; other helpers pass the message to their PM.
“All helpers” in a project's conversation means that project's team helpers; choose Coordinator
to message it. Your conversation with the coordinator appears on every project.
For assignments, role names match first, then role descriptions if no name matches;
general helpers do not match. Helpers are chosen in team order, then member order.

## Dashboard

`codec dashboard` prints a link like `http://127.0.0.1:4777/?token=…` and keeps
running until you press Ctrl+C. Open the link in a browser to:

- start on **Home**: a greeting with how many items need you, each team's
  helpers and progress, an **Important** list (tasks to fix or review, broken
  helpers, tools that aren't signed in) and this week's tasks by day, as a
  calendar or a list;
- open **Chat**: one conversation with Claude or Codex (pick which at the
  top; switching or **New chat** starts over). It isn't tied to a project and
  can't change files: Claude runs without extra permissions and Codex in its
  read-only sandbox. The conversation is kept in `~/.codec/chat/`;
- open **Helpers**: every team member (and any quick run that still needs
  attention) in one table with its status, current task and project, plus
  counts of working / ready to review / free / needs you. Select a helper to
  see its latest output, open or stop its run, or give it a new task;
- see how many agents are running and how much memory they use (Linux; "n/a"
  elsewhere) in the sidebar;
- open **Projects**: the project list with progress bars beside a board with
  four lanes: **Working** (running), **Needs you** (failed or stopped),
  **In review** (finished, worktree still there) and **Done** (worktree
  cleaned), and the project's helpers in a side panel;
- open your **Profile** from the button at the bottom of the sidebar. Its
  **Info** tab is where you edit the name and email used for saved checkpoints,
  and see whether Claude and Codex are signed in (with the command to sign in
  if they aren't);
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

The React dashboard is served at `/` after opening the printed link. `/next`
remains an authenticated alias. `npm run build` builds both the server and the
UI into `dist/`; if the UI is missing, the page explains how to build it.
`npm run build`, `npm run app`, and `npm run install-launcher`
automatically run `npm install` when installed packages are out of date after
a pull. There is one root package manifest and lockfile for both server and UI.

For UI development, start a dashboard on an unused port, then pass its printed
link to the Vite proxy in a second terminal:

```sh
CODEC_DASHBOARD_URL='http://127.0.0.1:<port>/?token=<token>' npm run dev:ui
```

Open `http://127.0.0.1:5173`. The development proxy supplies the token to the
page only while serving it; production builds retain an empty placeholder for
the dashboard to fill. `npm run typecheck` checks both server/tests and UI.
The base components in `ui/src/components/ui` use shadcn/ui's
[manual setup](https://ui.shadcn.com/docs/installation/manual) and official
`new-york-v4` registry sources, with local `cn` imports. The registry components
are checked in so they can be adapted when the screens are ported.

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

This builds the server and React UI and opens **Codec** in its own window. The app
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
