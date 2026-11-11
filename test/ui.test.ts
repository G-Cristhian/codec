// @vitest-environment jsdom
import { createElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../ui/src/App";
import {
  S,
  stateText,
  errorText,
  RequestError,
  sourceText,
  type PageData,
  type Run,
} from "../ui/src/lib/api";
import {
  ago,
  dayKey,
  greeting,
  helperRows,
  helperStatus,
  homeNotes,
  initials,
  weekOf,
} from "../ui/src/overview";
import { Markdown } from "../ui/src/chat";
import { fixture } from "./ui-fixtures";
let data: PageData;
let handler:
  | ((path: string, body: Record<string, unknown>) => Response | undefined)
  | undefined;
let calls: { path: string; body: Record<string, unknown> }[];
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
async function mount(route = "#/projects", openTask = true) {
  location.hash = route;
  render(createElement(App));
  await waitFor(() => expect(screen.queryByTestId("page-loading")).toBeNull());
  if (route.startsWith("#/project/") && openTask)
    fireEvent.click(screen.getByTestId("task-new"));
}
function message(key: string) {
  return document.querySelector('[data-message-key="' + key + '"]')!;
}
beforeEach(() => {
  data = fixture();
  handler = undefined;
  calls = [];
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  HTMLElement.prototype.scrollIntoView = () => {};
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit = {}) => {
      const path = url.replace("/api/", "");
      const body = options.body ? JSON.parse(String(options.body)) : {};
      calls.push({ path, body });
      const custom = handler?.(path, body);
      if (custom) return custom;
      if (options.method === "POST")
        return response(
          path === "projects/site/runs" ? { runId: "run-demo" } : {},
        );
      if (path.startsWith("remove-preview"))
        return response({
          effects: [
            { what: S.wording.roleRemoved, kind: "lost" },
            { what: S.wording.skillsKept, kind: "kept" },
          ],
          blocked: false,
        });
      if (path.startsWith("folders"))
        return response({
          path: "/tmp/site",
          parent: "/tmp",
          isGit: true,
          hasSkill: false,
          folders: [{ name: "child", path: "/tmp/site/child" }],
        });
      if (path === "error-details")
        return response({ logPath: "/tmp/codec.log", time: "now" });
      return response(
        path.startsWith("setup")
          ? data.setup
          : path.startsWith("accounts")
            ? data.accounts
            : path === "state"
              ? data.home
              : path === "chat"
                ? data.chat
                : path === "settings"
                  ? data.settings
                  : path === "projects/site"
                    ? data.project
                    : path === "runs/run-demo"
                      ? data.run
                      : path === "teams"
                        ? data.teams
                        : path === "specialists"
                          ? data.roles
                          : path === "skills"
                            ? data.skills
                            : path === "members/web/tester"
                              ? data.member
                              : {},
      );
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("React screens and routes", () => {
  it.each([
    ["#/projects", S.projects.title],
    ["#/project/site", "site"],
    ["#/run/run-demo", S.tasks.details],
    ["#/teams", S.teams.title],
    ["#/member/web/tester", "tester (web team)"],
    ["#/specialists", S.specialists.title],
    ["#/skills", S.skills.title],
    ["#/accounts", S.accounts.title],
    ["#/profile/setup", S.setup.title],
  ])("renders %s with the approved heading", async (route, title) => {
    await mount(route);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      title,
    );
    expect(screen.getByTestId("nav-projects").getAttribute("href")).toBe(
      "#/projects",
    );
  });
  it("keeps Home on first run and finishes Setup only when opened", async () => {
    data.setup.identityReady = false;
    await mount("#/");
    expect(screen.queryByTestId("setup-wizard")).toBeNull();
    fireEvent.click(screen.getByTestId("profile-open"));
    await screen.findByTestId("profile-info");
    fireEvent.click(
      document.querySelector('[data-testid="profile-tab"][data-key="setup"]')!,
    );
    await screen.findByTestId("setup-wizard");
    fireEvent.click(screen.getByTestId("setup-continue"));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "settings",
        body: { setupFinished: true },
      }),
    );
  });
  it("opens an empty project form automatically and keeps success inline", async () => {
    data.home.projects = [];
    await mount();
    const f = screen.getByTestId("project-add-form");
    fireEvent.change(within(f).getByTestId("project-path"), {
      target: { value: "/tmp/new" },
    });
    fireEvent.submit(f);
    await waitFor(() =>
      expect(message("project-add").textContent).toContain(S.common.added),
    );
    expect(
      (within(f).getByTestId("project-path") as HTMLInputElement).value,
    ).toBe("");
    expect(
      screen.getByTestId("project-add-open").getAttribute("aria-expanded"),
    ).toBe("true");
  });
  it("answers the tracking question with the same request and explicit consent", async () => {
    data.home.projects = [];
    let n = 0;
    handler = (path) =>
      path === "projects" && n++ === 0
        ? response(
            { code: "needs_tracking", error: S.errors.needs_tracking },
            400,
          )
        : undefined;
    await mount();
    const f = screen.getByTestId("project-add-form");
    fireEvent.change(within(f).getByTestId("project-name"), {
      target: { value: "new" },
    });
    fireEvent.change(within(f).getByTestId("project-path"), {
      target: { value: "/tmp/new" },
    });
    fireEvent.submit(f);
    await screen.findByTestId("project-tracking");
    fireEvent.click(screen.getByTestId("tracking-yes"));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "projects",
        body: { name: "new", path: "/tmp/new", setUpTracking: true },
      }),
    );
  });
  it("offers name suggestions next to the submitting form", async () => {
    data.home.projects = [];
    handler = (p) =>
      p === "projects"
        ? response(
            {
              code: "invalid_project_name",
              suggestion: "new-name",
              params: {},
              error: S.wording.nameRules,
            },
            400,
          )
        : undefined;
    await mount();
    fireEvent.submit(screen.getByTestId("project-add-form"));
    fireEvent.click(await screen.findByTestId("use-suggested-name"));
    expect((screen.getByTestId("project-name") as HTMLInputElement).value).toBe(
      "new-name",
    );
  });
  it("uses the folder picker and closes it when a folder is chosen", async () => {
    data.home.projects = [];
    await mount();
    fireEvent.click(screen.getByTestId("folder-browse"));
    await screen.findByTestId("folder-current");
    expect(screen.getByTestId("folder-entry").getAttribute("data-key")).toBe(
      "/tmp/site/child",
    );
    fireEvent.click(screen.getByTestId("folder-use"));
    expect((screen.getByTestId("project-path") as HTMLInputElement).value).toBe(
      "/tmp/site",
    );
    expect(screen.queryByTestId("folder-panel")).toBeNull();
  });
  it("preserves forms, typing, focus, disclosures, folder state, and dialogs across the 2s poll", async () => {
    await mount("#/project/site");
    const input = screen.getByTestId("task-text") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Keep this draft" } });
    input.focus();
    input.setSelectionRange(5, 8);
    fireEvent.click(screen.getByTestId("project-account-settings"));
    const account = screen.getAllByTestId("project-account")[0];
    fireEvent.click(screen.getByTestId("project-remove"));
    await screen.findByTestId("confirm-dialog");
    const dialog = screen.getByTestId("confirm-dialog");
    const cancel = screen.getByTestId("confirm-cancel");
    cancel.focus();
    const before = calls.filter((c) => c.path === "state").length;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2200));
    });
    expect(calls.filter((c) => c.path === "state").length).toBeGreaterThan(
      before,
    );
    expect(screen.getByTestId("task-text")).toBe(input);
    expect(input.value).toBe("Keep this draft");
    expect(input.selectionStart).toBe(5);
    expect(screen.getAllByTestId("project-account")[0]).toBe(account);
    expect(screen.getByTestId("confirm-dialog")).toBe(dialog);
    expect(document.activeElement).toBe(cancel);
    expect(screen.queryByTestId("page-loading")).toBeNull();
    fireEvent.click(cancel);
    await waitFor(() =>
      expect(screen.queryByTestId("confirm-dialog")).toBeNull(),
    );
    input.focus();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2200));
    });
    expect(document.activeElement).toBe(input);
  });
  it("keeps an open folder panel and its input through a poll", async () => {
    data.home.projects = [];
    await mount();
    fireEvent.change(screen.getByTestId("project-name"), {
      target: { value: "draft" },
    });
    fireEvent.click(screen.getByTestId("folder-browse"));
    await screen.findByTestId("folder-current");
    const panel = screen.getByTestId("folder-panel");
    const input = screen.getByTestId("project-name");
    input.focus();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2200));
    });
    expect(screen.getByTestId("folder-panel")).toBe(panel);
    expect(screen.getByTestId("project-name")).toBe(input);
    expect(document.activeElement).toBe(input);
  });
  it("keeps the log node and scroll position when a poll appends activity", async () => {
    await mount("#/run/run-demo");
    const log = screen.getByTestId("task-log");
    Object.defineProperties(log, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 1000 },
    });
    log.scrollTop = 150;
    fireEvent.scroll(log);
    data.run!.log += "\nMore activity";
    fireEvent.click(screen.getByTestId("task-technical"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2200));
    });
    expect(screen.getByTestId("task-log")).toBe(log);
    expect(log.scrollTop).toBe(150);
    expect(log.textContent).toContain("More activity");
    expect(
      screen.getByTestId("task-technical").getAttribute("aria-expanded"),
    ).toBe("true");
    log.scrollTop = 900;
    fireEvent.scroll(log);
    data.run!.log += "\nAt bottom";
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2200));
    });
    expect(log.scrollTop).toBe(1000);
  });
  it("starts a task using the selected helper and fractional time limit", async () => {
    await mount("#/project/site");
    fireEvent.change(screen.getByTestId("task-text"), {
      target: { value: "Review" },
    });
    fireEvent.change(screen.getByTestId("task-limit"), {
      target: { value: "0.5" },
    });
    fireEvent.submit(screen.getByTestId("task-form"));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "projects/site/runs",
        body: { task: "Review", member: "web/tester", timeLimitMinutes: 0.5 },
      }),
    );
  });
  it.each([
    ["unsaved", S.tasks.unsaved],
    ["unavailable", S.tasks.workspaceUnchecked],
    ["no_changes", S.tasks.noChanges],
  ])("renders %s task status", async (status, text) => {
    data.run!.reviewStatus = status;
    await mount("#/run/run-demo");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      text,
    );
  });
  it.each([
    ["stopped", S.tasks.stopped],
    ["timed_out", S.tasks.timedOut.replace("{limit}", "1 minutes")],
    ["failed", S.tasks.failed],
  ] as const)("renders the %s outcome with the unsaved note", async (state, text) => {
    Object.assign(data.run!, { state, reviewStatus: "unsaved", timeLimitMinutes: 1 });
    await mount("#/run/run-demo");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(text);
    expect(screen.getAllByText(text).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId("task-unsaved").textContent).toBe(S.tasks.unsavedHelp);
  });
  it("renders account limit, checkpoint and unsaved notices", async () => {
    Object.assign(data.run!, {
      limitHit: true,
      autoSaved: true,
      checkpointError: "checkpoint_save_failed",
      reviewStatus: "unsaved",
    });
    await mount("#/run/run-demo");
    expect(screen.getByTestId("task-account-limit").textContent).toContain(
      S.accounts.limitMessage,
    );
    expect(
      within(screen.getByTestId("task-account-limit")).getByRole("link")
        .textContent,
    ).toBe(S.accounts.open);
    expect(screen.getByTestId("task-auto-saved").textContent).toBe(
      S.tasks.autoSaved,
    );
    expect(screen.getByTestId("task-checkpoint-error").textContent).toBe(
      S.errors.checkpoint_save_failed,
    );
    expect(screen.getByTestId("task-unsaved").textContent).toBe(
      S.tasks.unsavedHelp,
    );
    expect(document.body.textContent).toContain("Work");
  });
  it("keeps technical task identifiers collapsed", async () => {
    await mount("#/run/run-demo");
    expect(document.body.textContent).not.toContain("/tmp/demo-workspace");
    fireEvent.click(screen.getByTestId("task-technical"));
    expect(document.body.textContent).toContain("/tmp/demo-workspace");
  });
  it("renders a shadcn helper select with trigger testid and keyed items", async () => {
    await mount("#/project/site");
    const user = userEvent.setup();
    await user.click(screen.getByTestId("task-who"));
    expect(
      screen.getByRole("option", { name: /tester/ }).getAttribute("data-key"),
    ).toBe("m:web/tester");
    await user.click(
      screen.getByRole("option", {
        name: S.wording.quickUsing.replace("{tool}", S.setup.codex),
      }),
    );
    expect(screen.getByTestId("task-who").textContent).toContain(S.setup.codex);
  });
  it("shows unavailable services and links to Setup", async () => {
    data.setup.tools.forEach((t) => (t.installed = false));
    await mount("#/project/site");
    expect(document.body.textContent).toContain(S.setup.notInstalled);
    expect(
      document.querySelector('main a[href="#/profile/setup"]'),
    ).not.toBeNull();
  });
  it("saves a role with its skills using the shared strings and selectors", async () => {
    await mount("#/specialists");
    fireEvent.click(screen.getByTestId("specialist-add-open"));
    const f = screen.getByTestId("specialist-add-form");
    fireEvent.change(within(f).getByTestId("specialist-name"), {
      target: { value: "writer" },
    });
    fireEvent.change(within(f).getByTestId("specialist-specialty"), {
      target: { value: "Writes" },
    });
    fireEvent.click(within(f).getByTestId("specialist-skill"));
    fireEvent.submit(f);
    await waitFor(() =>
      expect(
        calls.find((c) => c.path === "specialists" && c.body.name === "writer")
          ?.body,
      ).toMatchObject({
        specialty: "Writes",
        tool: "claude",
        skills: ["review"],
      }),
    );
  });
  it("saves team projects and edits member skills without changing the role", async () => {
    await mount("#/teams");
    fireEvent.click(screen.getByTestId("team-edit-open"));
    fireEvent.submit(screen.getByTestId("team-edit-form"));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "teams/web/projects",
        body: { projects: ["site"] },
      }),
    );
  });
  it.each(["project", "team", "helper"])(
    "saves the %s account picker on change",
    async (scope) => {
      await mount(
        scope === "project"
          ? "#/project/site"
          : scope === "team"
            ? "#/teams"
            : "#/member/web/tester",
      );
      fireEvent.click(
        screen.getByTestId(
          scope === "project"
            ? "project-account-settings"
            : scope === "team"
              ? "team-edit-open"
              : "member-edit-open",
        ),
      );
      const user = userEvent.setup();
      await user.click(screen.getAllByTestId(scope + "-account")[0]);
      await user.click(
        screen.getByRole("option", { name: S.accounts.computer }),
      );
      await waitFor(() =>
        expect(
          calls.some(
            (c) =>
              c.path === "account-settings" &&
              c.body.scope === scope &&
              c.body.accountId === "builtin-claude",
          ),
        ).toBe(true),
      );
    },
  );
  it("displays sign-in steps, code and secure new-tab link", async () => {
    data.accounts.accounts[1].login = {
      state: "waiting",
      url: "https://auth.openai.com/codex/device",
      code: "ABCD-EFGH",
      needsCode: true,
    };
    await mount("#/accounts");
    const link = screen.getByTestId("account-open-sign-in");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(screen.getByTestId("account-device-code").textContent).toBe(
      "ABCD-EFGH",
    );
    fireEvent.change(screen.getByTestId("account-code-work"), {
      target: { value: "secret" },
    });
    fireEvent.submit(screen.getByTestId("account-code-form"));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "accounts/work/code",
        body: { code: "secret" },
      }),
    );
    expect(
      (screen.getByTestId("account-code-work") as HTMLInputElement).value,
    ).toBe("");
  });
  it.each(["canceled", "failed", "timed_out", "signed_in"])(
    "shows account sign-in state %s",
    async (state) => {
      data.accounts.accounts[1].login = { state };
      await mount("#/accounts");
      expect(screen.getByTestId("account-login-state").textContent).toBe(
        state === "signed_in"
          ? S.accounts.signedIn
          : S.accounts[state as "failed"],
      );
    },
  );
  it("disables account sign-in and removal while it is in use", async () => {
    data.accounts.accounts[1].running = true;
    await mount("#/accounts");
    expect(
      (screen.getByTestId("account-remove") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("account-sign-in-again") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
  it("removes an account only after an explicit confirmation", async () => {
    await mount("#/accounts");
    fireEvent.click(screen.getByTestId("account-remove"));
    expect(calls.some((c) => c.path === "accounts/work/remove")).toBe(false);
    fireEvent.click(screen.getByTestId("confirm-submit"));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "accounts/work/remove",
        body: { confirmed: true },
      }),
    );
  });
  it("shows a connection error and clears it on the next good poll", async () => {
    handler = (p) =>
      p === "state"
        ? response({ error: "expired", code: "unauthorized" }, 401)
        : undefined;
    location.hash = "#/";
    render(createElement(App));
    await screen.findByTestId("connection-message");
    expect(screen.getByTestId("connection-message").textContent).toBe(
      S.errors.unauthorized,
    );
    handler = undefined;
    await waitFor(
      () => expect(screen.queryByTestId("connection-message")).toBeNull(),
      { timeout: 4000 },
    );
  });
});
describe("skill folder uploads", () => {
  it("uploads relative file paths and base64 content through the existing API", async () => {
    await mount("#/skills");
    fireEvent.click(screen.getByTestId("skill-add-open"));
    fireEvent.mouseDown(screen.getByRole("tab", { name: S.skills.upload }), {
      button: 0,
      ctrlKey: false,
    });
    const input = await screen.findByTestId("skill-upload");
    const file = new File(["Read carefully"], "SKILL.md", {
      type: "text/markdown",
    });
    Object.defineProperty(file, "webkitRelativePath", {
      value: "review/SKILL.md",
    });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.submit(screen.getByTestId("skill-upload-form"));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "skills",
        body: {
          files: [{ path: "review/SKILL.md", content: btoa("Read carefully") }],
        },
      }),
    );
  });
});

describe("confirmations", () => {
  it("focuses Cancel, shows effect kinds, ignores outside clicks, cancels with Escape and returns focus", async () => {
    await mount("#/project/site");
    const trigger = screen.getByTestId("project-remove");
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByTestId("confirm-dialog");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("confirm-cancel")),
    );
    expect(screen.getByTestId("confirm-effects").textContent).toContain(
      "⚠" + S.wording.roleRemoved,
    );
    expect(screen.getByTestId("confirm-effects").textContent).toContain(
      "✓" + S.wording.skillsKept,
    );
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId("confirm-dialog")).not.toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("confirm-dialog")).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
  it("blocks confirmation when preview is blocked", async () => {
    handler = (p) =>
      p.startsWith("remove-preview")
        ? response({
            effects: [],
            blocked: true,
            blockedReason: S.wording.busy,
          })
        : undefined;
    await mount("#/project/site");
    fireEvent.click(screen.getByTestId("project-remove"));
    await screen.findByTestId("confirm-blocked");
    expect(screen.queryByTestId("confirm-submit")).toBeNull();
  });
  it("keeps errors in the open dialog and disables both buttons during a request", async () => {
    handler = (p) =>
      p === "projects/site/remove"
        ? response(
            { error: "busy", code: "project_busy", params: { count: 1 } },
            400,
          )
        : undefined;
    await mount("#/project/site");
    fireEvent.click(screen.getByTestId("project-remove"));
    fireEvent.click(await screen.findByTestId("confirm-submit"));
    expect(
      (screen.getByTestId("confirm-cancel") as HTMLButtonElement).disabled,
    ).toBe(true);
    await waitFor(() => expect(message("dialog").textContent).toContain("1"));
    expect(screen.queryByTestId("confirm-dialog")).not.toBeNull();
  });
  it("stops only after confirmation", async () => {
    data.run!.state = "running";
    await mount("#/run/run-demo");
    fireEvent.click(screen.getByTestId("task-stop"));
    expect(calls.some((c) => c.path.endsWith("/stop"))).toBe(false);
    fireEvent.click(screen.getByTestId("confirm-submit"));
    await waitFor(() =>
      expect(calls).toContainEqual({ path: "runs/run-demo/stop", body: {} }),
    );
  });
  it("requires a fresh force confirmation and carries over delete-saved-changes", async () => {
    let count = 0;
    handler = (p) =>
      p === "runs/run-demo/clean" && count++ === 0
        ? response(
            {
              code: "uncommitted_changes",
              error: S.errors.uncommitted_changes,
            },
            409,
          )
        : undefined;
    await mount("#/run/run-demo");
    fireEvent.click(screen.getByTestId("task-clean"));
    fireEvent.click(screen.getByTestId("task-delete-branch"));
    fireEvent.click(screen.getByTestId("confirm-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("confirm-dialog").textContent).toContain(
        S.tasks.forceTitle,
      ),
    );
    expect(
      screen.getByTestId("task-delete-branch").getAttribute("data-state"),
    ).toBe("checked");
    expect(calls.filter((c) => c.path.endsWith("/clean"))).toHaveLength(1);
    fireEvent.click(screen.getByTestId("confirm-submit"));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "runs/run-demo/clean",
        body: { force: true, deleteBranch: true },
      }),
    );
  });
  it("replaces an existing skill through a confirmation", async () => {
    let count = 0;
    handler = (p, b) =>
      p === "skills" && b.path && count++ === 0
        ? response(
            {
              code: "skill_exists",
              params: { name: "review" },
              error: S.errors.skill_exists,
            },
            409,
          )
        : undefined;
    await mount("#/skills");
    fireEvent.click(screen.getByTestId("skill-add-open"));
    fireEvent.change(screen.getByTestId("skill-path"), {
      target: { value: "/tmp/review" },
    });
    fireEvent.submit(screen.getByTestId("skill-add-form"));
    fireEvent.click(await screen.findByTestId("skill-replace"));
    expect(calls.some((c) => c.body.replace)).toBe(false);
    fireEvent.click(screen.getByTestId("confirm-submit"));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "skills",
        body: { path: "/tmp/review", replace: true },
      }),
    );
  });
});
describe("shared data presentation", () => {
  it.each([
    [undefined, "actual", "Default (actual)"],
    ["chosen", "actual", "chosen"],
  ])(
    "shows selected and detected model %s/%s",
    async (model, actualModel, expected) => {
      Object.assign(data.run!, { model, actualModel });
      await mount("#/run/run-demo");
      expect(document.querySelector("dl")!.textContent).toContain(expected);
    },
  );
  it("uses the server time-limit status and original skill source", () => {
    expect(
      stateText({ ...data.run!, state: "timed_out", stateText: "3 seconds" }),
    ).toBe("3 seconds");
    expect(sourceText({ name: "s", source: "project" }, "site")).toBe(
      S.members.fromProject.replace("{project}", "site"),
    );
  });
  it("maps coded errors and uses the friendly fallback", () => {
    expect(
      errorText(
        Object.assign(new RequestError("raw"), { code: "identity_missing" }),
      ),
    ).toBe(S.errors.identity_missing);
    expect(errorText(new Error("raw"))).toBe(S.common.error);
  });
});

describe("owner's Home, Helpers, Profile and Chat port", () => {
  it("greets by first name and time of day, and builds a Monday-to-Sunday week", () => {
    expect(greeting(new Date(2026, 9, 29, 8), "Jordan Lee")).toBe(
      "Good morning, Jordan",
    );
    expect(greeting(new Date(2026, 9, 29, 14), "")).toBe(S.home.afternoon);
    expect(greeting(new Date(2026, 9, 29, 20), "Sam")).toBe(
      "Good evening, Sam",
    );
    expect(weekOf(new Date(2026, 9, 29, 12)).map(dayKey)).toEqual([
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-1",
    ]);
    expect(dayKey(weekOf(new Date(2026, 10, 1))[0])).toBe("2026-10-26");
    expect([
      initials("Jordan Lee"),
      initials("  ada  "),
      initials("Mary Ann Smith"),
      initials(""),
      initials(undefined),
    ]).toEqual(["JL", "A", "MA", "", ""]);
  });
  it("gives every helper its live or latest task, retaining quick helpers that need attention", () => {
    data.teams![0].members = ["scout", "writer", "idle", "orphan"].map(
      (member, i) => ({
        ...data.member!,
        member,
        specialty: i === 0 ? "Research" : undefined,
        error: i === 3 ? "role_missing" : undefined,
      }),
    );
    const run = (
      runId: string,
      member: string | undefined,
      lane: Run["lane"],
      state = "done",
    ) => ({
      ...data.run!,
      runId,
      team: member ? "web" : undefined,
      member,
      lane,
      state,
    });
    const runs = [
      run("run-4", undefined, "needsYou", "failed"),
      run("run-5", undefined, "done"),
      run("run-3", "writer", "inReview"),
      run("run-2", "scout", "done"),
      run("run-1", "scout", "working", "running"),
    ];
    const rows = helperRows(data.teams!, runs);
    expect(
      rows.map((row) => [row.key, helperStatus(row)[0], row.run?.runId]),
    ).toEqual([
      ["web/scout", "working", "run-1"],
      ["web/writer", "inReview", "run-3"],
      ["web/idle", "idle", undefined],
      ["web/orphan", "needsYou", undefined],
      ["run:run-4", "needsYou", "run-4"],
    ]);
    expect(rows[0].sub).toBe("Research");
    expect(rows[1].sub).toBe(S.members.worker);
    expect(helperStatus(rows[3])[1]).toBe(S.helpers.broken);
    const before = (minutes: number) =>
      new Date(Date.now() - minutes * 60000).toISOString();
    expect([
      ago(before(0)),
      ago(before(5)),
      ago(before(180)),
      ago(before(2 * 1440)),
      ago(undefined),
    ]).toEqual([
      S.time.now,
      "5 min ago",
      "3 h ago",
      "2 d ago",
      S.common.unknown,
    ]);
  });
  it("lists tasks, broken helpers, required tools and identity gaps, excluding unused tools", () => {
    data.setup.identityReady = false;
    data.setup.tools[1].signedIn = false;
    const member = {
      ...data.member!,
      member: "orphan",
      tool: "codex",
      error: "role_missing",
    };
    data.teams![0].members.push(member);
    data.home.runs[0].lane = "needsYou";
    const notes = homeNotes(
      helperRows(data.teams!, data.home.runs),
      data.home.runs,
      data.setup,
    );
    expect(notes.map((n) => n.title)).toEqual([
      S.home.needsOne,
      S.home.brokenOne,
      "Codex isn't ready",
      S.home.identityTitle,
    ]);
    expect(notes[0].href).toBe("#/run/run-demo");
    data.setup.identityReady = true;
    data.teams![0].members.pop();
    expect(homeNotes(helperRows(data.teams!, []), [], data.setup)).toEqual([]);
  });
  it("puts the week before equal-height Teams and Important and opens the project form from Home", async () => {
    await mount("#/");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      "Owner",
    );
    const grid = screen.getByTestId("home-teams").parentElement!;
    expect(grid.firstElementChild!.textContent).toContain(S.home.week);
    expect(screen.getByTestId("home-summary").textContent).toContain(
      S.home.itemOne,
    );
    fireEvent.click(screen.getByTestId("home-new-project"));
    await screen.findByTestId("project-add-form");
    expect(location.hash).toBe("#/projects");
    expect(
      screen.getByTestId("project-add-open").getAttribute("aria-expanded"),
    ).toBe("true");
  });
  it("summarizes team helper states and progress and filters Helpers when its team is clicked", async () => {
    const member = data.teams![0].members[0];
    data.teams![0].members = [
      { ...member, member: "scout" },
      { ...member, member: "writer" },
      { ...member, member: "orphan", error: "role_missing" },
    ];
    data.home.runs = [
      {
        ...data.run!,
        runId: "r3",
        member: "writer",
        task: "Draft methods",
        lane: "needsYou",
        state: "failed",
      },
      {
        ...data.run!,
        runId: "r2",
        member: "scout",
        task: "Summarize papers",
        lane: "working",
        state: "running",
      },
      { ...data.run!, runId: "r1", member: "scout", lane: "done" },
    ];
    await mount("#/");
    const team = screen.getByTestId("home-team");
    expect(team.textContent).toContain("1 working");
    expect(team.textContent).toContain("2 need you");
    expect(team.querySelector(":scope > p")!.textContent).toBe(
      "scout is working on “Summarize papers”. writer needs you (Didn't finish). orphan needs fixing.",
    );
    expect(team.querySelector<HTMLElement>(".progress i")!.style.width).toBe(
      "33%",
    );
    fireEvent.click(team);
    await screen.findByTestId("helper-detail");
    expect(
      document
        .querySelector('[data-testid="helpers-team"][data-key="web"]')!
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
  it("shows the selected day in Calendar and the whole week in List, retaining mode across polls", async () => {
    const days = weekOf(new Date());
    data.home.runs = [
      { ...data.run!, runId: "today", startedAt: new Date().toISOString() },
      { ...data.run!, runId: "monday", startedAt: days[0].toISOString() },
      {
        ...data.run!,
        runId: "old",
        startedAt: new Date(2020, 0, 1).toISOString(),
      },
    ];
    await mount("#/");
    expect(screen.getAllByTestId("home-day")).toHaveLength(7);
    const today = document.querySelector(
      '[data-testid="home-day"][aria-pressed="true"]',
    )!;
    expect(today.getAttribute("data-key")).toBe(dayKey(new Date()));
    expect(
      screen.getAllByTestId("home-task").map((r) => r.getAttribute("data-key")),
    ).toContain("today");
    fireEvent.click(
      document.querySelector('[data-testid="home-mode"][data-key="list"]')!,
    );
    expect(
      screen.getAllByTestId("home-task").map((r) => r.getAttribute("data-key")),
    ).toEqual(["today", "monday"]);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2200));
    });
    expect(screen.queryByTestId("home-day")).toBeNull();
  });
  it("opens New task without changing the selected project", async () => {
    await mount("#/project/site", false);
    expect(screen.queryByTestId("task-form")).toBeNull();
    fireEvent.click(screen.getByTestId("task-new"));
    expect(screen.getByTestId("task-form")).toBeTruthy();
    expect(location.hash).toBe("#/project/site");
    expect(screen.getByText(S.projects.team)).toBeTruthy();
  });
  it("opens Info for an unknown Profile tab, saves identity, rechecks sign-ins and returns to the original page", async () => {
    data.setup.tools[1].signedIn = false;
    data.setup.tools[1].problem = "Sign in to Codex";
    data.setup.tools[1].fix = "codex login";
    await mount("#/projects");
    fireEvent.click(screen.getByTestId("profile-open"));
    await screen.findByTestId("profile-info");
    expect(screen.getByTestId("profile-back").getAttribute("href")).toBe(
      "#/projects",
    );
    expect(screen.getByTestId("identity-save").textContent).toBe(
      S.profile.saveChanges,
    );
    expect(
      (screen.getByTestId("identity-name") as HTMLInputElement).value,
    ).toBe("Owner");
    expect(screen.getAllByTestId("setup-tool")[0].textContent).toContain(
      S.profile.signedIn,
    );
    expect(screen.getAllByTestId("setup-tool")[1].textContent).toContain(
      "Sign in to Codex",
    );
    expect(screen.getByTestId("setup-fix").textContent).toBe("codex login");
    fireEvent.change(screen.getByTestId("identity-name"), {
      target: { value: "Jordan Lee" },
    });
    fireEvent.change(screen.getByTestId("identity-email"), {
      target: { value: "jordan@example.invalid" },
    });
    fireEvent.submit(screen.getByTestId("identity-form"));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "settings",
        body: {
          identity: { name: "Jordan Lee", email: "jordan@example.invalid" },
        },
      }),
    );
    fireEvent.click(screen.getByTestId("profile-check"));
    await waitFor(() =>
      expect(calls.some((c) => c.path === "setup?fresh=1")).toBe(true),
    );
    await act(async () => {
      location.hash = "#/profile/unknown-tab";
      fireEvent(window, new HashChangeEvent("hashchange"));
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="profile-tab"][data-key="info"]'),
      ).not.toBeNull(),
    );
    expect(
      document
        .querySelector('[data-testid="profile-tab"][data-key="info"]')!
        .getAttribute("aria-current"),
    ).toBe("page");
    fireEvent.click(
      document.querySelector('[data-testid="profile-tab"][data-key="setup"]')!,
    );
    await screen.findByTestId("setup-wizard");
    expect(screen.getByTestId("profile-back").getAttribute("href")).toBe(
      "#/projects",
    );
    fireEvent.click(screen.getByTestId("profile-back"));
    await screen.findByTestId("project-add-open");
  });
  it.each([
    [0, false, S.setup.notReady + " " + S.setup.identityNeeded],
    [0, true, S.setup.notReady],
    [1, false, S.setup.identityNeeded],
    [2, false, S.setup.identityNeeded],
    [1, true, S.setup.oneReady.replace("{tool}", S.setup.claude)],
    [2, true, S.setup.ready],
  ])(
    "Setup explains readiness with %s services and identity %s",
    async (count, identityReady, expected) => {
      data.setup.tools.forEach((t, i) => {
        t.installed = i < count;
        t.signedIn = i < count;
      });
      data.setup.ready = count > 0;
      data.setup.identityReady = identityReady;
      await mount("#/profile/setup");
      expect(screen.getByTestId("setup-status").textContent).toContain(
        expected,
      );
    },
  );
  it("keeps the old Setup link working and saves Skip through settings", async () => {
    await mount("#/setup");
    await screen.findByTestId("profile-setup");
    expect(location.hash).toBe("#/profile/setup");
    fireEvent.click(screen.getByTestId("setup-skip"));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "settings",
        body: { setupFinished: true },
      }),
    );
  });
  it("starts helper tasks on the chosen project and stops them only after confirmation", async () => {
    data.home.runs[0].lane = "working";
    data.home.runs[0].state = "running";
    await mount("#/helpers");
    await screen.findByTestId("helper-task-form");
    fireEvent.change(screen.getByTestId("helper-task-text"), {
      target: { value: "Review changes" },
    });
    fireEvent.submit(screen.getByTestId("helper-task-form"));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "projects/site/runs",
        body: { member: "web/tester", task: "Review changes" },
      }),
    );
    expect(message("helper-web/tester").textContent).toContain(
      S.helpers.started,
    );
    fireEvent.click(screen.getByTestId("helper-stop"));
    expect(calls.some((c) => c.path.endsWith("/stop"))).toBe(false);
    fireEvent.click(await screen.findByTestId("confirm-submit"));
    await waitFor(() =>
      expect(calls).toContainEqual({ path: "runs/run-demo/stop", body: {} }),
    );
  });
  it("keeps the selected helper's draft when its task finishes during a poll", async () => {
    data.teams![0].members.push({ ...data.member!, member: "writer" });
    data.home.runs.push({
      ...data.run!,
      runId: "writer-run",
      member: "writer",
      state: "running",
      lane: "working",
    });
    await mount("#/helpers");
    const input = screen.getByTestId("helper-task-text") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Keep this helper draft" } });
    input.focus();
    data.home.runs[0].lane = "done";
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2200));
    });
    expect(screen.getByTestId("helper-task-text")).toBe(input);
    expect(input.value).toBe("Keep this helper draft");
    expect(document.activeElement).toBe(input);
    expect(
      document
        .querySelector('[data-testid="helper-row"][data-key="web/tester"]')!
        .getAttribute("aria-selected"),
    ).toBe("true");
  });
  it("persists sidebar collapse through a remount", async () => {
    await mount("#/");
    fireEvent.click(screen.getByTestId("sidebar-toggle"));
    expect(localStorage.getItem("codec-sidebar")).toBe("collapsed");
    cleanup();
    await mount("#/");
    expect(
      screen.getByTestId("sidebar-toggle").getAttribute("aria-expanded"),
    ).toBe("false");
    expect(document.documentElement.getAttribute("data-sidebar")).toBe(
      "collapsed",
    );
  });
  it("shows who said what, model labels, errors and thinking, and selects models and services", async () => {
    Object.assign(data.chat!, {
      tool: "codex",
      model: "gpt-6-sol",
      busy: true,
      messages: [
        { role: "user", text: "Hi" },
        { role: "assistant", text: "Hello!", model: "gpt-6-sol" },
        { role: "error", text: S.chat.failed },
      ],
    });
    await mount("#/chat");
    expect(
      screen
        .getAllByTestId("chat-message")
        .map((m) => m.getAttribute("data-key")),
    ).toEqual(["user", "assistant", "error"]);
    expect(screen.getByTestId("chat-thinking").getAttribute("aria-label")).toBe(
      "Codex is thinking…",
    );
    expect(screen.getByTestId("chat-send").hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByTestId("chat-copy")).toHaveLength(1);
    expect(document.querySelector(".chat-meta .hint")!.textContent).toBe(
      "GPT-6-Sol",
    );
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    fireEvent.click(screen.getByTestId("chat-model"));
    expect(
      (
        await screen.findByRole("option", { name: S.chat.defaultModel })
      ).getAttribute("data-key"),
    ).toBe("");
    fireEvent.click(
      await screen.findByRole("option", { name: S.chat.defaultModel }),
    );
    await waitFor(() =>
      expect(calls).toContainEqual({ path: "chat/model", body: { model: "" } }),
    );
    fireEvent.click(screen.getByTestId("chat-tool"));
    const item = await screen.findByRole("option", { name: S.setup.claude });
    expect(item.getAttribute("data-key")).toBe("claude");
    fireEvent.click(item);
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "chat/new",
        body: { tool: "claude" },
      }),
    );
  });
  it("keeps a saved unlisted model selectable, and New chat clears through the existing endpoint", async () => {
    data.chat!.model = "older-model";
    data.chat!.messages = [{ role: "assistant", text: "saved" }];
    await mount("#/chat");
    fireEvent.click(screen.getByTestId("chat-model"));
    expect(
      (await screen.findByRole("option", { name: "older-model" })).getAttribute(
        "data-key",
      ),
    ).toBe("older-model");
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    fireEvent.click(screen.getByTestId("chat-new"));
    await waitFor(() =>
      expect(calls).toContainEqual({ path: "chat/new", body: {} }),
    );
  });
  it("sends trimmed messages with Enter, keeps Shift+Enter and composition for typing, and shows existing error strings", async () => {
    await mount("#/chat");
    const input = screen.getByTestId("chat-text") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "  What's new?  " } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(calls.filter((c) => c.path === "chat" && c.body.text)).toHaveLength(
      0,
    );
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "chat",
        body: { text: "What's new?" },
      }),
    );
    await waitFor(() => expect(input.value).toBe(""));
    handler = (p, body) =>
      p === "chat" && body.text
        ? response({ code: "chat_busy" }, 409)
        : undefined;
    fireEvent.change(input, { target: { value: "Retry" } });
    fireEvent.submit(screen.getByTestId("chat-form"));
    await waitFor(() =>
      expect(message("chat").textContent).toContain(S.errors.chat_busy),
    );
    expect(input.value).toBe("Retry");
  });
  it("preserves the composer, focus, selection and reader scroll while polls append and update replies", async () => {
    data.chat!.messages = [{ role: "assistant", text: "Partial" }];
    await mount("#/chat");
    const input = screen.getByTestId("chat-text") as HTMLTextAreaElement,
      log = screen.getByTestId("chat-log"),
      reply = screen.getByTestId("chat-message");
    Object.defineProperties(log, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 1000 },
    });
    log.scrollTop = 150;
    fireEvent.scroll(log);
    fireEvent.change(input, { target: { value: "Keep my draft" } });
    input.focus();
    input.setSelectionRange(5, 8);
    data.chat!.messages[0].text = "Completed reply";
    data.chat!.messages.push({ role: "assistant", text: "Another reply" });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2200));
    });
    expect(screen.getByTestId("chat-text")).toBe(input);
    expect(screen.getByTestId("chat-log")).toBe(log);
    expect(screen.getAllByTestId("chat-message")[0]).toBe(reply);
    expect(reply.textContent).toContain("Completed reply");
    expect(log.textContent).toContain("Another reply");
    expect(input.value).toBe("Keep my draft");
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([5, 8]);
    expect(log.scrollTop).toBe(150);
    log.scrollTop = 900;
    fireEvent.scroll(log);
    data.chat!.messages.push({ role: "assistant", text: "At bottom" });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2200));
    });
    expect(log.scrollTop).toBe(1000);
  });
  it("renders the owner's Markdown subset with escaped HTML and safe links", () => {
    const fence = "```";
    const { container } = render(
      createElement(Markdown, {
        text:
          "**Root cause:** the `.topbar` rule\n\n1. one\n2. two\n\n- a\n- [docs](https://example.com)\n\n" +
          fence +
          "js\n<b>x</b>\n" +
          fence +
          "\n<img src=x onerror=alert(1)>",
      }),
    );
    expect([...container.children].map((el) => el.tagName)).toEqual([
      "P",
      "OL",
      "UL",
      "PRE",
      "P",
    ]);
    expect(container.querySelector("strong")!.textContent).toBe("Root cause:");
    expect(container.querySelector("code")!.textContent).toBe(".topbar");
    expect(container.querySelectorAll("ol li")).toHaveLength(2);
    expect(container.querySelector("a")!.getAttribute("href")).toBe(
      "https://example.com",
    );
    expect(container.querySelector("a")!.getAttribute("rel")).toBe(
      "noopener noreferrer",
    );
    expect(container.querySelector("pre code")!.textContent).toBe("<b>x</b>");
    expect(container.querySelector("img")).toBeNull();
    cleanup();
    const unsafe = render(
      createElement(Markdown, { text: "[bad](javascript:alert(1))" }),
    );
    expect(unsafe.container.querySelector("a")).toBeNull();
    expect(unsafe.container.textContent).toBe("[bad](javascript:alert(1))");
  });
});
