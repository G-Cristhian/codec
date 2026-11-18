import type { PageData, Run, RunChanges } from "../ui/src/lib/api";
import type { ProjectConversation } from "../ui/src/conversation-feed";

export function changesFixture(): RunChanges {
  return { status: "ready", files: [
    { path: "assets/logo.png", change: "added", additions: 0, deletions: 0, binary: true, truncated: false, lines: [] },
    { path: "docs/guide.md", change: "added", additions: 1, deletions: 0, binary: false, truncated: false,
      lines: [{ kind: "hunk", text: "@@ -0,0 +1 @@" }, { kind: "add", text: "+Read this guide", newNo: 1 }] },
    { path: "src/main.ts", change: "modified", additions: 3, deletions: 2, binary: false, truncated: false, lines: [
      { kind: "hunk", text: "@@ -1,3 +1,4 @@" },
      { kind: "context", text: " unchanged", oldNo: 1, newNo: 1 },
      { kind: "remove", text: "-before", oldNo: 2 },
      { kind: "remove", text: "-older", oldNo: 3 },
      { kind: "add", text: "+after", newNo: 2 },
      { kind: "add", text: "+newer", newNo: 3 },
      { kind: "add", text: "+last", newNo: 4 },
    ] },
    { path: "src/zeta.ts", oldPath: "src/old.ts", change: "renamed", additions: 3, deletions: 2, binary: false, truncated: true,
      lines: [{ kind: "hunk", text: "@@ -1 +1 @@" }, { kind: "add", text: "+Second file", newNo: 1 }] },
  ] };
}
const runFixture: Run = {
  runId: "run-demo",
  project: "site",
  task: "Check the website",
  agent: "claude",
  state: "done",
  lane: "inReview",
  reviewStatus: "ready",
  team: "web",
  member: "tester",
  specialist: "reviewer",
  startedAt: "2026-11-10T12:00:00Z",
  deadline: "2026-11-10T13:00:00Z",
  timeLimitMinutes: 60,
  branch: "codec/demo",
  worktree: "/tmp/demo-workspace",
  account: { name: "Work" },
  skillsGiven: [
    { name: "review", source: "specialist", description: "Review carefully" },
  ],
  skillsUsed: [
    { name: "review", how: "detected", evidence: "Read instructions" },
  ],
  log: Array.from({ length: 100 }, (_, i) => "Activity " + i).join("\n"),
};
export function fixture(): PageData & { project: NonNullable<PageData["project"]> & ProjectConversation } {
  return {
    setup: {
      tools: ["claude", "codex"].map((tool) => ({
        tool,
        installed: true,
        signedIn: true,
        version: "1.0",
      })),
      ready: true,
      identityReady: true,
      profileName: "Owner",
    },
    accounts: {
      accounts: [
        {
          id: "builtin-claude",
          name: "This computer's login",
          kind: "claude",
          builtin: true,
          status: "signed_in",
        },
        { id: "work", name: "Work", kind: "codex", status: "signed_in" },
      ],
      defaults: { claude: "builtin-claude", codex: "work" },
      choices: {},
    },
    home: {
      coordinator: { settings: null, running: false },
      projects: [
        {
          name: "site",
          path: "/tmp/site",
          lanes: { working: 0, needsYou: 0, inReview: 1, done: 0 },
        },
      ],
      runs: [structuredClone(runFixture)],
      agentsRunning: 0,
      teamsCount: 1,
      memoryBytes: 0,
    },
    chat: {
      tool: "claude",
      busy: false,
      messages: [],
      models: {
        claude: [{ id: "opus", label: "Opus" }],
        codex: [{ id: "gpt-6-sol", label: "GPT-6-Sol" }],
      },
    },
    settings: { identity: { name: "Owner", email: "owner@example.invalid" } },
    project: {
      project: { name: "site", path: "/tmp/site" },
      messages: [],
      cappedPairs: [],
      messagesError: false,
      helpers: [{ ref: "web/tester", name: "web/tester", running: false }],
      members: [
        {
          ref: "web/tester",
          member: "tester",
          team: "web",
          specialty: "Reviewer",
          tool: "claude",
          label: "tester (web team) · Reviewer · Claude",
        },
      ],
      lanes: {
        working: [],
        needsYou: [],
        inReview: [structuredClone(runFixture)],
        done: [],
      },
    },
    run: structuredClone(runFixture),
    roles: [
      {
        name: "reviewer",
        specialty: "Reviewer",
        tool: "claude",
        skills: ["review"],
        instructions: "Review carefully",
        clones: [{ team: "web", member: "tester" }],
      },
    ],
    teams: [
      {
        name: "web",
        projects: ["site"],
        members: [
          {
            member: "tester",
            tool: "claude",
            specialist: "reviewer",
            specialty: "Reviewer",
            skills: [],
            projects: ["site"],
            working: [],
            runs: [],
          },
        ],
      },
    ],
    member: {
      member: "tester",
      team: "web",
      tool: "claude",
      specialist: "reviewer",
      specialty: "Reviewer",
      skills: [{ name: "review", source: "specialist" }],
      projects: ["site"],
      instructions: "Review carefully",
      working: [],
      runs: [structuredClone(runFixture)],
    },
    skills: {
      skills: [
        {
          name: "review",
          description: "Review carefully",
          specialists: ["reviewer"],
          members: [],
        },
      ],
      grid: {
        skills: ["review"],
        rows: [
          {
            id: "reviewer",
            kind: "specialist",
            label: "reviewer role (Reviewer)",
            tool: "claude",
            skills: { review: "own" },
          },
          {
            id: "web/tester",
            kind: "member",
            label: "tester, web team (reviewer role)",
            tool: "claude",
            skills: { review: "via" },
          },
        ],
      },
    },
  };
}
