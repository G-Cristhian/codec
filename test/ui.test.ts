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
import { changesFixture, fixture } from "./ui-fixtures";
import type { ConversationMessage } from "../ui/src/conversation-feed";
let data: ReturnType<typeof fixture>;
let handler:
  | ((path: string, body: Record<string, unknown>) => Response | Promise<Response> | undefined)
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
  sessionStorage.clear();
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
      if (path === "runs/run-demo/changes") return response(changesFixture());
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
              : path === "chat" || path.startsWith("chat?id=")
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
describe("project conversation", () => {
  const note = (id: string, extra: Partial<ConversationMessage> = {}): ConversationMessage => ({
    id, senderName: "web/tester", senderKind: "helper", recipientName: "web/tester",
    body: "Helper update " + id, sentAt: "2026-11-11T12:00:00.000Z", waiting: false, ...extra,
  });
  const conversation = () => screen.getByRole("tab", { name: /^Conversation/ });
  const board = () => screen.getByRole("tab", { name: S.conversation.board });
  const compose = () => screen.getByRole("textbox", { name: S.conversation.message }) as HTMLTextAreaElement;
  const sends = () => calls.filter((call) => call.path === "projects/site/messages");
  async function open() {
    await mount("#/project/site", false);
    await userEvent.click(conversation());
  }
  async function poll() {
    const before = calls.filter((call) => call.path === "projects/site").length;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2200)); });
    expect(calls.filter((call) => call.path === "projects/site").length).toBeGreaterThan(before);
  }
  async function chooseHelper() {
    await userEvent.click(screen.getByRole("combobox", { name: S.conversation.to }));
    await userEvent.click(await screen.findByRole("option", { name: "web/tester (stopped)" }));
  }

  it("keeps the aside in both tabs, gives tasks only on Board, and renders flat chronological rows", async () => {
    data.project.messages = [note("first"), note("second", {
      senderName: S.conversation.you, senderKind: "owner", body: "Please check this\nThen report back", waiting: true,
      sentAt: "2026-11-11T12:01:00.000Z",
    })];
    await mount("#/project/site", false);
    expect(board().getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: S.wording.giveTask })).toBeTruthy();
    expect(within(conversation()).queryByLabelText(/unread/)).toBeNull();
    const aside = screen.getByRole("heading", { name: S.projects.team });
    await userEvent.click(conversation());
    expect(screen.getByRole("heading", { name: S.projects.team })).toBe(aside);
    expect(screen.queryByRole("button", { name: S.wording.giveTask })).toBeNull();
    const rows = screen.getAllByTestId("conversation-message");
    expect(rows.map((row) => row.querySelector("p")?.textContent)).toEqual(data.project.messages.map((message) => message.body));
    expect(within(rows[0]).getByText("web/tester")).toBeTruthy();
    expect(within(rows[1]).getByText(S.conversation.you)).toBeTruthy();
    expect(rows[0].className).toContain("bg-background");
    expect(rows[1].className).toContain("bg-muted/40");
    for (const [index, row] of rows.entries()) {
      expect(row.querySelector("time")?.dateTime).toBe(data.project.messages[index].sentAt);
      expect(row.querySelector("time")?.textContent).toBe(new Date(data.project.messages[index].sentAt).toLocaleString());
    }
    expect(within(rows[0]).queryByText(S.conversation.waiting)).toBeNull();
    expect(within(rows[1]).getByText(S.conversation.waiting).className).toContain("text-status-needs");
    await userEvent.click(screen.getByRole("button", { name: S.projects.newTask }));
    expect(board().getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("task-text")).toBeTruthy();
  });

  it("shows the empty state and leaves compose available for stopped helpers", async () => {
    await open();
    expect(screen.getByText(S.conversation.empty)).toBeTruthy();
    expect(screen.getByRole("combobox", { name: S.conversation.to }).textContent).toBe(S.conversation.all);
    await chooseHelper();
    await userEvent.type(compose(), "Please check");
    expect((screen.getByRole("button", { name: S.conversation.send }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("renders coordinator rows like helper rows and sends directly to the coordinator", async () => {
    data.project.helpers.push({ ref: "coordinator", name: S.coordinator.name, running: true });
    data.project.messages = [note("coordinator", {
      senderName: S.coordinator.name, senderKind: "coordinator", body: "Team update for the owner", recipientName: S.conversation.you,
    })];
    await open();
    const row = screen.getByTestId("conversation-message");
    expect(within(row).getByText(S.coordinator.name)).toBeTruthy();
    expect(row.className).toContain("bg-background");
    await userEvent.click(screen.getByRole("combobox", { name: S.conversation.to }));
    await userEvent.click(await screen.findByRole("option", { name: S.coordinator.name }));
    await userEvent.type(compose(), "Please check the teams{Enter}");
    await waitFor(() => expect(sends()).toEqual([{ path: "projects/site/messages", body: { to: "coordinator", body: "Please check the teams" } }]));
  });

  it("shows the no-helpers notice and prevents both Send and Enter from posting", async () => {
    data.project.helpers = [];
    data.project.members = [];
    await open();
    expect(screen.getByText(S.conversation.noHelpers)).toBeTruthy();
    await userEvent.type(compose(), "Hello{Enter}");
    expect((screen.getByRole("button", { name: S.conversation.send }) as HTMLButtonElement).disabled).toBe(true);
    expect(sends()).toEqual([]);
  });

  it("sends on Enter, inserts Shift+Enter, clears text and retains the picker across sends and remounts", async () => {
    await open();
    await chooseHelper();
    const input = compose();
    await userEvent.type(input, "First line{Shift>}{Enter}{/Shift}Second line");
    expect(input.value).toBe("First line\nSecond line");
    expect(sends()).toEqual([]);
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(input.value).toBe(""));
    expect(sends()).toEqual([{ path: "projects/site/messages", body: { to: "web/tester", body: "First line\nSecond line" } }]);
    expect(screen.getByRole("combobox", { name: S.conversation.to }).textContent).toBe("web/tester (stopped)");
    expect(document.activeElement).toBe(input);
    cleanup();
    await open();
    expect(screen.getByRole("combobox", { name: S.conversation.to }).textContent).toBe("web/tester (stopped)");
  });

  it("sends All helpers in one request and guards against duplicate submissions while in flight", async () => {
    await open();
    const fetchBefore = globalThis.fetch;
    let finish!: () => void;
    const sent = vi.fn();
    vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
      if (url === "/api/projects/site/messages") {
        sent(JSON.parse(String(options.body)));
        await new Promise<void>((resolve) => { finish = resolve; });
        return response([]);
      }
      return fetchBefore(url, options);
    });
    await userEvent.type(compose(), "Everyone, check in");
    const send = screen.getByRole("button", { name: S.conversation.send }) as HTMLButtonElement;
    await userEvent.click(send);
    expect(send.disabled).toBe(true);
    fireEvent.keyDown(compose(), { key: "Enter" });
    fireEvent.submit(send.closest("form")!);
    expect(sent).toHaveBeenCalledExactlyOnceWith({ to: "all", body: "Everyone, check in" });
    await act(async () => { finish(); });
    await waitFor(() => expect(compose().value).toBe(""));
  });

  it("retains the draft and recipient when a send fails and ignores composition Enter", async () => {
    handler = (path) => path === "projects/site/messages"
      ? response({ code: "message_helper_not_on_project", error: S.errors.message_helper_not_on_project }, 400) : undefined;
    await open();
    await chooseHelper();
    await userEvent.type(compose(), "Keep this draft");
    fireEvent.keyDown(compose(), { key: "Enter", isComposing: true });
    expect(sends()).toEqual([]);
    await userEvent.keyboard("{Enter}");
    await screen.findByText(S.errors.message_helper_not_on_project);
    expect(compose().value).toBe("Keep this draft");
    expect(screen.getByRole("combobox", { name: S.conversation.to }).textContent).toBe("web/tester (stopped)");
    expect((screen.getByRole("button", { name: S.conversation.send }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("counts only new ids on Board, clears on opening Conversation and does not count delivery updates", async () => {
    data.project.messages = [note("existing", { waiting: true })];
    await mount("#/project/site", false);
    expect(within(conversation()).queryByLabelText(/unread/)).toBeNull();
    data.project.messages.push(note("new-one"), note("new-two"));
    await poll();
    expect(within(conversation()).getByLabelText("2 unread messages").textContent).toBe("2");
    data.project.messages[0].waiting = false;
    await poll();
    expect(within(conversation()).getByLabelText("2 unread messages").textContent).toBe("2");
    await userEvent.click(conversation());
    expect(within(conversation()).queryByLabelText(/unread/)).toBeNull();
    expect(screen.queryByText(S.conversation.waiting)).toBeNull();
    data.project.messages.push(note("while-reading"));
    await poll();
    expect(within(conversation()).queryByLabelText(/unread/)).toBeNull();
    await userEvent.click(board());
    data.project.messages.push(note("later"));
    await poll();
    expect(within(conversation()).getByLabelText("1 unread messages").textContent).toBe("1");
  });

  it("preserves draft, picker, focus, selection and tab while the 2s poll appends messages", async () => {
    await open();
    await chooseHelper();
    const input = compose();
    await userEvent.type(input, "Keep typing here");
    input.setSelectionRange(5, 11);
    const picker = screen.getByRole("combobox", { name: S.conversation.to });
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    data.project.messages.push(note("new"));
    await poll();
    expect(compose()).toBe(input);
    expect(input.value).toBe("Keep typing here");
    expect(input.selectionStart).toBe(5);
    expect(input.selectionEnd).toBe(11);
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole("combobox", { name: S.conversation.to })).toBe(picker);
    expect(picker.textContent).toBe("web/tester (stopped)");
    expect(conversation().getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Helper update new")).toBeTruthy();
    expect(scroll).toHaveBeenCalled();
  });

  it("shows the review's load error and retries without losing the draft", async () => {
    data.project.messagesError = true;
    await open();
    expect(screen.getByText(S.conversation.loadError).closest("[role=alert]")?.className).toContain("text-destructive");
    await userEvent.type(compose(), "Keep this through retry");
    data.project.messagesError = false;
    data.project.messages.push(note("recovered"));
    await userEvent.click(screen.getByRole("button", { name: S.conversation.retry }));
    await screen.findByText("Helper update recovered");
    expect(screen.queryByText(S.conversation.loadError)).toBeNull();
    expect(compose().value).toBe("Keep this through retry");
  });
});
describe("review changes panel", () => {
  const path = "runs/run-demo/changes";
  const fileButtons = () => within(screen.getByLabelText(S.diffViewer.files)).getAllByRole("button");
  async function open(route = "#/run/run-demo") {
    await mount(route, false);
    expect(calls.filter((call) => call.path === path)).toHaveLength(0);
    await userEvent.click(screen.getByTestId("task-review"));
    await screen.findByText("+after");
  }

  async function comment(lineText = "+after", text = "Handle empty input.") {
    await userEvent.click(screen.getByText(lineText));
    await userEvent.type(screen.getByRole("textbox", { name: S.diffViewer.comment }), text);
    await userEvent.click(screen.getByRole("button", { name: S.diffViewer.saveComment }));
  }

  it("opens directly below a line and saves, cancels, edits and deletes a comment", async () => {
    await open();
    expect(screen.queryByRole("button", { name: /Send feedback/ })).toBeNull();
    await userEvent.click(screen.getByText("+after"));
    const box = screen.getByRole("textbox", { name: S.diffViewer.comment }) as HTMLTextAreaElement;
    expect(box.closest("div")!.previousElementSibling).toBe(screen.getByText("+after").closest("[data-kind]"));
    expect(document.activeElement).toBe(box);
    await userEvent.type(box, "  Handle empty input.  ");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(screen.queryByRole("textbox")).toBeNull();
    const note = screen.getByText("Handle empty input.");
    expect(note.className).toContain("text-muted-foreground");
    expect(screen.getByText("+after").closest("[data-kind]")!.querySelector("svg")).toBeTruthy();
    await userEvent.click(screen.getByText("+after"));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Handle empty input.");
    await userEvent.clear(screen.getByRole("textbox"));
    await userEvent.type(screen.getByRole("textbox"), "Cancelled edit");
    await userEvent.click(screen.getByRole("button", { name: S.diffViewer.cancelComment }));
    expect(screen.getByText("Handle empty input.")).toBeTruthy();
    await userEvent.click(screen.getByText("+after"));
    await userEvent.clear(screen.getByRole("textbox"));
    await userEvent.type(screen.getByRole("textbox"), "Add a test.");
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    expect(screen.getByText("Add a test.")).toBeTruthy();
    await userEvent.click(screen.getByText("+after"));
    await userEvent.click(screen.getByRole("button", { name: S.diffViewer.deleteComment }));
    expect(screen.queryByText("Add a test.")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Send feedback/ })).toBeNull();
  });

  it.each([[true, "#/run/run-demo"], [false, "#/project/site"]] as const)("batches ids and text, clears comments and shows delivery=%s at %s", async (delivered, route) => {
    await open(route);
    const board = structuredClone(data.project.lanes);
    await comment();
    await userEvent.click(fileButtons()[2]);
    await comment("+Read this guide", "Explain setup.");
    expect(within(fileButtons()[0]).getByText("1 comment")).toBeTruthy();
    expect(within(fileButtons()[2]).getByText("1 comment")).toBeTruthy();
    handler = (request) => request === "runs/run-demo/feedback" ? response({ delivered, messageId: "message-1" }) : undefined;
    await userEvent.click(screen.getByRole("button", { name: "Send feedback (2)" }));
    expect(await screen.findByText(delivered ? "Feedback sent to web/tester." : "Feedback will reach web/tester when it starts its next task.")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(calls.find((call) => call.path === "runs/run-demo/feedback")?.body).toEqual({ head: "fixture-head", comments: [
      { line: "2:4", text: "Handle empty input." }, { line: "1:1", text: "Explain setup." },
    ] });
    expect(screen.queryByRole("button", { name: /Send feedback/ })).toBeNull();
    expect(screen.queryByText("Explain setup.")).toBeNull();
    await userEvent.click(fileButtons()[0]);
    expect(screen.queryByText("Handle empty input.")).toBeNull();
    expect(screen.queryByText("1 comment")).toBeNull();
    expect(data.project.lanes).toEqual(board);
    expect(data.run!.reviewed).toBeUndefined();
  });

  it("keeps comments and shows errorText when feedback fails", async () => {
    await open();
    await comment();
    handler = (request) => request === "runs/run-demo/feedback" ? response({ code: "changes_stale", error: "Internal detail" }, 409) : undefined;
    await userEvent.click(screen.getByRole("button", { name: "Send feedback (1)" }));
    expect(await within(screen.getByRole("dialog")).findByText(S.errors.changes_stale)).toBeTruthy();
    expect(screen.getByText("Handle empty input.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Send feedback (1)" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText("Internal detail")).toBeNull();
  });

  it("disables sending and comment edits until the pending send completes", async () => {
    await open();
    await comment();
    let complete!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { complete = resolve; });
    handler = (request) => request === "runs/run-demo/feedback" ? pending : undefined;
    await userEvent.click(screen.getByRole("button", { name: "Send feedback (1)" }));
    expect((screen.getByRole("button", { name: "Send feedback (1)" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByText("+after"));
    expect(screen.queryByRole("textbox")).toBeNull();
    await act(async () => complete(await response({ delivered: true, messageId: "message-1" })));
    await screen.findByText("Feedback sent to web/tester.");
  });

  it.each(["#/run/run-demo", "#/project/site"])("keeps comments across polling and close/reopen at %s", async (route) => {
    await open(route);
    await comment();
    await userEvent.click(screen.getByText("+after"));
    const box = screen.getByRole("textbox");
    const before = calls.filter((call) => call.path === "state").length;
    data.run = { ...data.run!, log: "More activity" };
    data.project = structuredClone(data.project);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2200)); });
    expect(calls.filter((call) => call.path === "state").length).toBeGreaterThan(before);
    expect(screen.getByRole("textbox")).toBe(box);
    expect(document.activeElement).toBe(box);
    await userEvent.click(screen.getByRole("button", { name: S.diffViewer.close }));
    await userEvent.click(screen.getByTestId("task-review"));
    expect(await screen.findByText("Handle empty input.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send feedback (1)" })).toBeTruthy();
  });

  it("clears unsent comments with a notice when a fresh diff has a different head", async () => {
    await open();
    await comment();
    await userEvent.click(screen.getByRole("button", { name: S.diffViewer.close }));
    handler = (request) => request === path ? response({ ...changesFixture(), head: "new-head" }) : undefined;
    await userEvent.click(screen.getByTestId("task-review"));
    expect(await screen.findByText(S.diffViewer.commentsCleared)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Send feedback/ })).toBeNull();
    expect(screen.queryByText("Handle empty input.")).toBeNull();
  });

  it("ignores hunk checkbox clicks, roves with arrows, opens with Enter, and confines Escape to the editor", async () => {
    await open();
    await userEvent.click(screen.getByRole("checkbox"));
    expect(screen.queryByRole("textbox")).toBeNull();
    const pane = screen.getByTestId("diff-pane");
    const lines = pane.querySelectorAll<HTMLElement>('[data-kind][role="button"]');
    expect([...lines].filter((line) => line.tabIndex === 0)).toHaveLength(1);
    expect(lines[0].getAttribute("aria-label")).toBe("Comment on line 1 of src/main.ts");
    lines[0].focus();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByRole("textbox").closest("div")!.previousElementSibling).toBe(lines[1]);
    await userEvent.type(screen.getByRole("textbox"), "Draft");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.activeElement).toBe(lines[1]);
    expect([...lines].filter((line) => line.tabIndex === 0)).toHaveLength(1);
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(lines[0]);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each(["apply", "discard"] as const)("confirms loss of unsent comments before %s and preserves them on cancel", async (action) => {
    await open();
    await comment();
    const label = action === "apply" ? S.diffViewer.apply : S.diffViewer.discard;
    await userEvent.click(screen.getByRole("button", { name: label }));
    expect(await screen.findByText(S.diffViewer.loseCommentsEffect)).toBeTruthy();
    expect(calls.some((call) => call.path === `runs/run-demo/${action}`)).toBe(false);
    await userEvent.click(screen.getByTestId("confirm-cancel"));
    expect(screen.getByText("Handle empty input.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: label }));
    await userEvent.click(screen.getByTestId("confirm-submit"));
    await screen.findByText(action === "apply" ? S.diffViewer.applySuccess : S.diffViewer.discardSuccess);
    expect(calls.filter((call) => call.path === `runs/run-demo/${action}`)).toHaveLength(1);
    if (action === "apply") await userEvent.click(screen.getByRole("button", { name: S.diffViewer.close }));
    await userEvent.click(screen.getByTestId("task-review"));
    await screen.findByText("+after");
    expect(screen.queryByRole("button", { name: /Send feedback/ })).toBeNull();
  });

  it.each(["quick", "running", "reviewed"])("hides line feedback for a %s task", async (kind) => {
    if (kind === "quick") { delete data.run!.member; delete data.run!.team; }
    if (kind === "running") data.run!.state = "running";
    if (kind === "reviewed") data.run!.reviewed = { action: "discarded", at: "now" };
    await open();
    await userEvent.click(screen.getByText("+after"));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByTestId("diff-pane").querySelector('[data-kind][role="button"]')).toBeNull();
  });

  it("allows the coordinator to receive line feedback", async () => {
    delete data.run!.team;
    data.run!.member = "coordinator";
    await open();
    await comment();
    handler = (request) => request === "runs/run-demo/feedback" ? response({ delivered: false, messageId: "message-1" }) : undefined;
    await userEvent.click(screen.getByRole("button", { name: "Send feedback (1)" }));
    expect(await screen.findByText("Feedback will reach coordinator when it starts its next task.")).toBeTruthy();
  });

  for (const route of ["#/run/run-demo", "#/project/site"]) {
    it.each([
      ["ready", "done", "inReview", true],
      ["no_changes", "done", "done", true],
      [undefined, "running", "working", false],
      ["unsaved", "done", "needsYou", false],
      [undefined, "failed", "needsYou", false],
      ["unavailable", "done", "needsYou", false],
      [undefined, "done", "done", false],
    ] as const)(`shows the button only for reviewable tasks at ${route}: %s / %s`, async (reviewStatus, state, lane, visible) => {
      const run = { ...data.run!, reviewStatus, state, lane };
      data.run = run;
      data.project.lanes = { working: [], needsYou: [], inReview: [], done: [], [lane]: [run] };
      await mount(route, false);
      expect(!!screen.queryByRole("button", { name: S.diffViewer.button })).toBe(visible);
      expect(calls.filter((call) => call.path === path)).toHaveLength(0);
      if (route.startsWith("#/project/")) {
        const link = screen.getByTestId("task-open");
        expect(link.tagName).toBe("A");
        expect(link.getAttribute("href")).toBe("#/run/run-demo");
        expect(link.getAttribute("data-key")).toBe("run-demo");
        expect(link.querySelector("button")).toBeNull();
        if (visible) expect(screen.getByTestId("task-review").parentElement).toBe(link.parentElement);
      }
    });

    it(`dismisses by Close, Escape and overlay without writes, navigation or board changes at ${route}`, async () => {
      const board = structuredClone(data.project.lanes);
      await open(route);
      const link = screen.queryByTestId("task-open");
      for (const method of ["close", "escape", "overlay"]) {
        const dialog = screen.getByRole("dialog");
        expect(within(dialog).getAllByRole("button", { name: S.diffViewer.close })).toHaveLength(1);
        if (method === "close") await userEvent.click(within(dialog).getByRole("button", { name: S.diffViewer.close }));
        else if (method === "escape") await userEvent.keyboard("{Escape}");
        else await userEvent.click(document.querySelector('[data-slot="dialog-overlay"]')!);
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        expect(location.hash).toBe(route);
        expect(vi.mocked(fetch).mock.calls.filter(([, options]) => options?.method === "POST")).toEqual([]);
        expect(data.project.lanes).toEqual(board);
        expect(screen.queryByTestId("task-open")).toBe(link);
        expect(document.activeElement).toBe(screen.getByTestId("task-review"));
        if (method !== "overlay") {
          await userEvent.click(screen.getByTestId("task-review"));
          await screen.findByText("+after");
        }
      }
      expect(calls.filter((call) => call.path === path)).toHaveLength(3);
    });

    it(`keeps the dialog, selection, focus and both scroll positions through polling at ${route}`, async () => {
      await open(route);
      await userEvent.click(fileButtons()[1]);
      const dialog = screen.getByRole("dialog");
      const pane = screen.getByTestId("diff-pane");
      const list = screen.getByLabelText(S.diffViewer.files);
      const selected = fileButtons()[1];
      await userEvent.click(within(pane).getByRole("checkbox", { name: S.diffViewer.keepHunk }));
      selected.focus();
      pane.scrollTop = 120;
      pane.scrollLeft = 80;
      list.scrollTop = 40;
      const before = calls.filter((call) => call.path === "state").length;
      data.run = { ...data.run!, log: "Updated activity" };
      data.project = structuredClone(data.project);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2200)); });
      expect(calls.filter((call) => call.path === "state").length).toBeGreaterThan(before);
      expect(calls.filter((call) => call.path === path)).toHaveLength(1);
      expect(screen.getByRole("dialog")).toBe(dialog);
      expect(screen.getByTestId("diff-pane")).toBe(pane);
      expect(pane.scrollTop).toBe(120);
      expect(pane.scrollLeft).toBe(80);
      expect(screen.getByLabelText(S.diffViewer.files)).toBe(list);
      expect(list.scrollTop).toBe(40);
      expect(selected.getAttribute("aria-pressed")).toBe("true");
      expect(document.activeElement).toBe(selected);
      expect(screen.getByText("+Second file")).toBeTruthy();
      expect(within(pane).getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
      expect(screen.getByText("3 of 4 hunks selected")).toBeTruthy();
    });

    it(`opens the no-changes empty state at ${route}`, async () => {
      data.run!.reviewStatus = "no_changes";
      data.run!.lane = "done";
      data.project.lanes.inReview = [];
      data.project.lanes.done = [data.run!];
      handler = (request) => request === path ? response({ status: "no_changes", files: [] }) : undefined;
      await mount(route, false);
      await userEvent.click(screen.getByTestId("task-review"));
      const pane = await screen.findByTestId("diff-pane");
      expect(await within(pane).findByText(S.diffViewer.noChanges)).toBeTruthy();
      expect(within(pane).getByText(S.diffViewer.noChangesHint)).toBeTruthy();
      expect(pane.querySelector("svg")).toBeTruthy();
      expect(pane.querySelector("pre")).toBeNull();
      expect(screen.queryByRole("button", { name: S.diffViewer.apply })).toBeNull();
      expect(screen.queryByRole("button", { name: S.diffViewer.discard })).toBeNull();
      expect(within(pane).queryByRole("alert")).toBeNull();
    });
  }

  it("orders files by most changes then path, selects the first, and switches files with Tab/Enter", async () => {
    await open();
    const buttons = fileButtons();
    expect(buttons.map((button) => button.title)).toEqual(["src/main.ts", "src/zeta.ts", "docs/guide.md", "assets/logo.png"]);
    expect(buttons[0].getAttribute("aria-pressed")).toBe("true");
    expect(buttons[0].className).toContain("bg-accent");
    expect(within(buttons[0]).getByText("src").className).toContain("text-muted-foreground");
    expect(within(buttons[0]).getByText("+3").className).toContain("text-green-800");
    expect(within(buttons[0]).getByText("-2").className).toContain("text-red-800");
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(data.run!.task)).toBeTruthy();
    expect(within(dialog).getByText("4 files changed")).toBeTruthy();
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    buttons[0].focus();
    await userEvent.keyboard("{Tab}{Enter}");
    expect(buttons[1].getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("+Second file")).toBeTruthy();
    expect(screen.queryByText("+after")).toBeNull();
    expect(screen.getByText(S.diffViewer.truncated)).toBeTruthy();
    await userEvent.click(buttons[2]);
    expect(screen.getByText("+Read this guide")).toBeTruthy();
    await userEvent.click(buttons[3]);
    expect(screen.getByText(S.diffViewer.binary)).toBeTruthy();
    expect(screen.getByTestId("diff-pane").querySelector("pre")).toBeNull();
    expect(buttons[3].querySelector('[data-slot="badge"]')).toBeNull();
  });

  it.each(["light", "dark"])("uses the exact design line colors and non-wrapping horizontal scrolling in %s mode", async (theme) => {
    localStorage.setItem("codec-theme", theme);
    await open();
    expect(document.documentElement.getAttribute("data-theme")).toBe(theme);
    const pane = screen.getByTestId("diff-pane");
    const classes = {
      add: "bg-green-50 dark:bg-green-950/30 text-green-800 dark:text-green-200",
      remove: "bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-200",
      context: "text-foreground",
      hunk: "bg-muted text-muted-foreground italic",
    };
    for (const [kind, expected] of Object.entries(classes)) {
      const line = pane.querySelector(`[data-kind="${kind}"]`)!;
      for (const token of expected.split(" ")) expect(line.classList.contains(token)).toBe(true);
    }
    expect(pane.className).toContain("overflow-x-auto");
    expect(pane.querySelector("pre")!.className).toContain("whitespace-pre");
    expect(pane.parentElement!.className).toContain("min-h-0");
  });

  it("shows loading and a plain friendly error, then fetches again when reopened", async () => {
    handler = (request) => request === path ? response({ code: "changes_unavailable", error: "Internal detail" }, 409) : undefined;
    await mount("#/run/run-demo");
    fireEvent.click(screen.getByTestId("task-review"));
    expect(screen.getByText(S.diffViewer.loading)).toBeTruthy();
    expect(await screen.findByText(S.errors.changes_unavailable)).toBeTruthy();
    expect(screen.getByText(S.diffViewer.error)).toBeTruthy();
    expect(screen.queryByText("Internal detail")).toBeNull();
    expect(within(screen.getByRole("dialog")).queryByRole("alert")).toBeNull();
    await userEvent.keyboard("{Escape}");
    handler = undefined;
    await userEvent.click(screen.getByTestId("task-review"));
    await screen.findByText("+after");
    expect(calls.filter((call) => call.path === path)).toHaveLength(2);
  });

  it("starts checked, counts across files, disables Apply at zero and resets on reopening", async () => {
    await open();
    expect(screen.getByText("4 of 4 hunks selected")).toBeTruthy();
    const apply = screen.getByRole("button", { name: S.diffViewer.apply }) as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
    for (const file of fileButtons()) {
      await userEvent.click(file);
      const checkbox = within(screen.getByTestId("diff-pane")).getByRole("checkbox", { name: S.diffViewer.keepHunk });
      expect(checkbox.getAttribute("aria-checked")).toBe("true");
      await userEvent.click(checkbox);
      expect(within(file).getByText("0/1")).toBeTruthy();
    }
    expect(screen.getByText("0 of 4 hunks selected")).toBeTruthy();
    expect(apply.disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: S.diffViewer.close }));
    await userEvent.click(screen.getByTestId("task-review"));
    await screen.findByText("4 of 4 hunks selected");
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
  });

  it.each(["#/run/run-demo", "#/project/site"])("sends only pinned head and checked ids, stays open through testing and lane changes at %s", async (route) => {
    await open(route);
    await userEvent.click(screen.getByRole("checkbox"));
    const before = calls.filter((call) => call.path === "state").length;
    handler = (request) => {
      if (request !== "runs/run-demo/apply") return;
      data.run = { ...data.run!, reviewed: { action: "applied", at: "now", commit: "saved", hunks: 3, total: 4, tests: { state: "queued" } }, lane: "inReview" };
      data.project.lanes.inReview = [data.run];
      return response(data.run);
    };
    await userEvent.click(screen.getByRole("button", { name: S.diffViewer.apply }));
    await screen.findByText(S.diffViewer.applySuccess);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(await screen.findByText(S.tests.queued)).toBeTruthy();
    expect(calls.find((call) => call.path === "runs/run-demo/apply")?.body).toEqual({ head: "fixture-head", hunks: ["0:0", "1:0", "3:0"] });
    await waitFor(() => expect(calls.filter((call) => call.path === "state").length).toBeGreaterThan(before));
    const dialog = screen.getByRole("dialog");
    data.run = { ...data.run!, reviewed: { ...data.run!.reviewed as Extract<NonNullable<Run["reviewed"]>, { action: "applied" }>, tests: { state: "passed" } }, lane: "done" };
    data.project.lanes.inReview = [];
    data.project.lanes.done = [data.run];
    await screen.findByText(S.tests.passed, {}, { timeout: 5000 });
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(await screen.findByText(S.tests.passedMessage)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: S.tests.showChanges }));
    await screen.findByText("Applied 3 of 4 hunks");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: S.diffViewer.apply })).toBeNull();
    expect(screen.queryByRole("button", { name: S.diffViewer.discard })).toBeNull();
  });

  it("keeps selection and the diff visible after an apply error", async () => {
    await open();
    await userEvent.click(screen.getByRole("checkbox"));
    handler = (request) => request === "runs/run-demo/apply" ? response({ code: "changes_stale", error: "Internal detail" }, 409) : undefined;
    await userEvent.click(screen.getByRole("button", { name: S.diffViewer.apply }));
    expect(await screen.findByText(S.errors.changes_stale)).toBeTruthy();
    expect(screen.getByText("+after")).toBeTruthy();
    expect(screen.getByText("3 of 4 hunks selected")).toBeTruthy();
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
    expect((screen.getByRole("button", { name: S.diffViewer.apply }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables decisions and checkboxes while saving", async () => {
    await open();
    let complete!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { complete = resolve; });
    handler = (request) => request === "runs/run-demo/apply" ? pending : undefined;
    await userEvent.click(screen.getByRole("button", { name: S.diffViewer.apply }));
    expect((screen.getByRole("button", { name: S.diffViewer.apply }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: S.diffViewer.discard }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => complete(await response({})));
    await screen.findByText(S.diffViewer.applySuccess);
  });

  it("asks before discarding, supports cancel, then closes and shows success", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: S.diffViewer.discard }));
    expect(await screen.findByText(S.diffViewer.discardTitle)).toBeTruthy();
    expect(screen.getByText(S.diffViewer.discardEffect)).toBeTruthy();
    expect(calls.some((call) => call.path === "runs/run-demo/discard")).toBe(false);
    await userEvent.click(screen.getByTestId("confirm-cancel"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: S.diffViewer.discard }));
    handler = (request) => {
      if (request !== "runs/run-demo/discard") return;
      data.run = { ...data.run!, reviewed: { action: "discarded", at: "now" }, reviewStatus: undefined, lane: "done" };
      return response(data.run);
    };
    await userEvent.click(screen.getByTestId("confirm-submit"));
    await screen.findByText(S.diffViewer.discardSuccess);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.find((call) => call.path === "runs/run-demo/discard")?.body).toEqual({});
    await waitFor(() => expect(screen.queryByTestId("task-review")).toBeNull());
  });

  it("shows discard errors in the review panel and preserves selection", async () => {
    await open();
    await userEvent.click(screen.getByRole("checkbox"));
    handler = (request) => request === "runs/run-demo/discard" ? response({ code: "changes_unavailable" }, 409) : undefined;
    await userEvent.click(screen.getByRole("button", { name: S.diffViewer.discard }));
    await userEvent.click(screen.getByTestId("confirm-submit"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(within(screen.getByRole("dialog")).getByText(S.errors.changes_unavailable)).toBeTruthy();
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("3 of 4 hunks selected")).toBeTruthy();
  });

  it("renders every hidden hunk header as a checked unit and sends those ids too", async () => {
    const changes = changesFixture();
    changes.files[2].hunks.push({ id: "2:1", header: "@@ -5000 +5000 @@", firstLine: 5000 });
    changes.files[2].truncated = true;
    changes.files[3].lines = [];
    handler = (request) => request === path ? response(changes) : undefined;
    await open();
    expect(screen.getByText("5 of 5 hunks selected")).toBeTruthy();
    expect(screen.getByText("@@ -5000 +5000 @@")).toBeTruthy();
    expect(screen.getByText(S.diffViewer.hiddenHunk)).toBeTruthy();
    expect(screen.getAllByRole("checkbox").map((checkbox) => checkbox.getAttribute("aria-checked"))).toEqual(["true", "true"]);
    await userEvent.click(fileButtons()[1]);
    expect(screen.getByText("@@ -1 +1 @@")).toBeTruthy();
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: S.diffViewer.apply }));
    expect(calls.find((call) => call.path === "runs/run-demo/apply")?.body).toEqual({ head: "fixture-head", hunks: ["0:0", "1:0", "2:0", "2:1", "3:0"] });
  });

  it("uses singular file count wording", async () => {
    const changes = changesFixture();
    changes.files = [changes.files[2]];
    handler = (request) => request === path ? response(changes) : undefined;
    await open();
    expect(screen.getByText(S.diffViewer.fileChanged)).toBeTruthy();
  });
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
  it("hides the project form behind Add until asked, then closes it after adding", async () => {
    data.home.projects = [];
    await mount();
    expect(screen.queryByTestId("project-add-form")).toBeNull();
    expect(screen.getByTestId("projects-empty").textContent).toBe(S.projects.emptyAdd);
    fireEvent.click(screen.getByTestId("project-add-open"));
    const f = await screen.findByTestId("project-add-form");
    fireEvent.change(within(f).getByTestId("project-path"), {
      target: { value: "/tmp/new" },
    });
    fireEvent.submit(f);
    await waitFor(() => expect(screen.queryByTestId("project-add-form")).toBeNull());
    expect(calls).toContainEqual({ path: "projects", body: { path: "/tmp/new" } });
    expect(screen.getByTestId("project-add-open").getAttribute("aria-expanded")).toBe("false");
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
    fireEvent.click(screen.getByTestId("project-add-open"));
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
    fireEvent.click(screen.getByTestId("project-add-open"));
    fireEvent.submit(screen.getByTestId("project-add-form"));
    fireEvent.click(await screen.findByTestId("use-suggested-name"));
    expect((screen.getByTestId("project-name") as HTMLInputElement).value).toBe(
      "new-name",
    );
  });
  it("opens this computer's folder chooser from Browse and fills in the chosen folder", async () => {
    data.home.projects = [];
    handler = (p) => (p === "folders/choose" ? response({ path: "/Users/me/CS 477" }) : undefined);
    await mount();
    fireEvent.click(screen.getByTestId("project-add-open"));
    fireEvent.click(await screen.findByTestId("folder-browse"));
    await waitFor(() => expect((screen.getByTestId("project-path") as HTMLInputElement).value).toBe("/Users/me/CS 477"));
    expect(screen.queryByTestId("folder-panel")).toBeNull();
    handler = (p) => (p === "folders/choose" ? response({ cancelled: true }) : undefined);
    fireEvent.click(screen.getByTestId("folder-browse"));
    await waitFor(() => expect(calls.filter((c) => c.path === "folders/choose")).toHaveLength(2));
    expect(calls.at(-1)!.body).toEqual({ path: "/Users/me/CS 477" });
    expect(screen.queryByTestId("folder-panel")).toBeNull();
  });
  it("uses the folder picker and closes it when a folder is chosen", async () => {
    data.home.projects = [];
    await mount();
    fireEvent.click(screen.getByTestId("project-add-open"));
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
    fireEvent.click(screen.getByTestId("project-add-open"));
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
  it("creates a team even with no projects, and drops Roles from the sidebar", async () => {
    data.home.projects = [];
    await mount("#/teams");
    expect(screen.queryByTestId("nav-specialists")).toBeNull();
    fireEvent.click(screen.getByTestId("team-add-open"));
    expect(await screen.findByText(S.agents.noProjects)).toBeTruthy();
    fireEvent.change(screen.getByTestId("team-name"), { target: { value: "study" } });
    fireEvent.submit(screen.getByTestId("team-add-form"));
    await waitFor(() => expect(calls).toContainEqual({ path: "teams", body: { name: "study", projects: [] } }));
  });
  it("builds an agent from a template with its own instructions, rules, settings and MCP servers", async () => {
    await mount("#/teams");
    fireEvent.click(document.querySelector('[data-testid="agent-add-open"][data-key="web"]')!);
    const dialog = await screen.findByTestId("agent-add-open-dialog");
    fireEvent.change(within(dialog).getByTestId("agent-template"), { target: { value: "reviewer" } });
    expect((within(dialog).getByTestId("agent-instructions") as HTMLTextAreaElement).value).toBe("Review carefully");
    expect((within(dialog).getByTestId("agent-job") as HTMLInputElement).value).toBe("Reviewer");
    fireEvent.change(within(dialog).getByTestId("agent-name"), { target: { value: "checker" } });
    fireEvent.click(within(dialog).getAllByTestId("agent-access").find((r) => (r as HTMLInputElement).value === "custom")!);
    fireEvent.change(within(dialog).getByTestId("agent-allow"), { target: { value: "Read\nBash(npm test:*)" } });
    fireEvent.click(within(dialog).getByTestId("mcp-add"));
    fireEvent.change(within(dialog).getByTestId("mcp-name"), { target: { value: "github" } });
    fireEvent.change(within(dialog).getByTestId("mcp-command"), { target: { value: "npx" } });
    fireEvent.change(within(dialog).getByTestId("mcp-args"), { target: { value: "-y\n@modelcontextprotocol/server-github" } });
    fireEvent.change(within(dialog).getByTestId("mcp-env"), { target: { value: "GITHUB_TOKEN=ghp_x" } });
    fireEvent.submit(within(dialog).getByTestId("agent-add-form"));
    await waitFor(() => expect(calls.some((c) => c.path === "teams/web/members")).toBe(true));
    expect(calls.find((c) => c.path === "teams/web/members")!.body).toMatchObject({
      name: "checker",
      tool: "claude",
      specialty: "Reviewer",
      instructions: "Review carefully",
      skills: ["review"],
      access: "custom",
      allow: "Read\nBash(npm test:*)",
      isolated: true,
      mcp: [{ name: "github", type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "ghp_x" } }],
    });
    await waitFor(() => expect(screen.queryByTestId("agent-add-open-dialog")).toBeNull());
  });
  it("shows an agent's harness and settings folder, and edits it without sending saved secrets back", async () => {
    Object.assign(data.member!, {
      ownInstructions: "Be brief",
      folder: "/Users/me/.codec/agents/web/tester",
      harness: { access: "read", allow: [], deny: [], isolated: true, mcp: [{ name: "docs", type: "http", url: "https://docs.example/mcp", env: { API_KEY: "" } }] },
    });
    await mount("#/member/web/tester");
    const card = screen.getByTestId("agent-harness");
    expect(card.textContent).toContain(S.agents.accessRead);
    expect(card.textContent).toContain("docs (https://docs.example/mcp)");
    expect(screen.getByTestId("agent-folder").textContent).toBe("/Users/me/.codec/agents/web/tester");
    fireEvent.click(screen.getByTestId("member-edit-open"));
    const dialog = await screen.findByTestId("member-edit-open-dialog");
    expect((within(dialog).getByTestId("mcp-env") as HTMLTextAreaElement).value).toBe("API_KEY=");
    fireEvent.submit(within(dialog).getByTestId("agent-edit-form"));
    await waitFor(() => expect(calls.some((c) => c.path === "teams/web/members/tester/edit")).toBe(true));
    const body = calls.find((c) => c.path === "teams/web/members/tester/edit")!.body;
    expect(body).toMatchObject({ access: "read", instructions: "Be brief", mcp: [{ name: "docs", type: "http", url: "https://docs.example/mcp", env: { API_KEY: "" } }] });
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
              : "member-account-open",
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
  it("shows a coordinator setup card and saves the chosen tool, model and time limit", async () => {
    handler = (path, body) => {
      if (path === "coordinator") {
        data.home.coordinator = { settings: { tool: String(body.tool), model: String(body.model), timeLimitMinutes: Number(body.timeLimitMinutes), createdAt: "2026-11-11T12:00:00Z" }, running: false };
        return response(data.home.coordinator);
      }
    };
    await mount("#/helpers");
    const card = screen.getByTestId("coordinator-card");
    expect(within(card).getByText(S.coordinator.explanation)).toBeTruthy();
    await userEvent.click(within(card).getByRole("combobox", { name: S.common.tool }));
    await userEvent.click(await screen.findByRole("option", { name: S.setup.codex }));
    await userEvent.type(screen.getByTestId("coordinator-model"), "test-model");
    await userEvent.type(screen.getByTestId("coordinator-limit"), "15");
    await userEvent.click(within(card).getByRole("button", { name: S.common.save }));
    await waitFor(() => expect(calls).toContainEqual({ path: "coordinator", body: { tool: "codex", model: "test-model", timeLimitMinutes: 15 } }));
    await screen.findByRole("button", { name: S.coordinator.change });
    expect(card.textContent).toContain("Codex · test-model · Free");
  });

  it("keeps coordinator settings drafts and focus through polls and shows live running state", async () => {
    data.home.coordinator = { settings: { tool: "claude", model: "opus", createdAt: "2026-11-11T12:00:00Z" }, running: false };
    await mount("#/helpers");
    const card = screen.getByTestId("coordinator-card");
    expect(card.textContent).toContain("Claude · opus · Free");
    await userEvent.click(within(card).getByRole("button", { name: S.coordinator.change }));
    const input = screen.getByTestId("coordinator-model") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "draft-model");
    data.home.coordinator.running = true;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2200)); });
    expect(screen.getByTestId("coordinator-model")).toBe(input);
    expect(input.value).toBe("draft-model");
    expect(document.activeElement).toBe(input);
    expect(card.textContent).toContain("Claude · opus · Working");
  });

  it("starts the coordinator from the project's Give task picker without a team", async () => {
    data.project.members = [{ ref: "coordinator", member: "coordinator", tool: "codex", label: S.coordinator.name }];
    await mount("#/project/site");
    expect(screen.getByTestId("task-who").textContent).toBe(S.coordinator.name);
    fireEvent.change(screen.getByTestId("task-text"), { target: { value: "Coordinate all teams" } });
    fireEvent.submit(screen.getByTestId("task-form"));
    await waitFor(() => expect(calls).toContainEqual({ path: "projects/site/runs", body: { member: "coordinator", task: "Coordinate all teams" } }));
  });

  it("keeps one coordinator in the helpers list when free and preserves its task draft on completion", async () => {
    data.home.coordinator = { settings: { tool: "claude", createdAt: "2026-11-11T12:00:00Z" }, running: true };
    data.home.runs.unshift({ ...data.run!, runId: "coordinator-run", team: undefined, member: "coordinator", state: "running", lane: "working" });
    await mount("#/helpers");
    const row = document.querySelector('[data-testid="helper-row"][data-key="coordinator"]')!;
    expect(within(row as HTMLElement).getByText(S.coordinator.name)).toBeTruthy();
    const input = screen.getByTestId("helper-task-text") as HTMLInputElement;
    await userEvent.type(input, "Next coordination task");
    data.home.runs[0].state = "done";
    data.home.runs[0].lane = "done";
    data.home.coordinator.running = false;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2200)); });
    expect(screen.getByTestId("helper-task-text")).toBe(input);
    expect(input.value).toBe("Next coordination task");
    expect(document.activeElement).toBe(input);
    expect(document.querySelectorAll('[data-testid="helper-row"][data-key="coordinator"]')).toHaveLength(1);
    expect(row.textContent).toContain(S.members.idle);
  });

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
  it("lays out the dashboard and opens the project form from Home", async () => {
    await mount("#/");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Owner");
    const grid = screen.getByTestId("home-start").parentElement!;
    expect([...grid.children].map((c) => c.getAttribute("data-testid"))).toEqual([
      "home-start",
      "home-week",
      "home-accounts",
      "home-projects",
      "home-approvals",
    ]);
    expect(screen.queryByTestId("home-summary")).toBeNull();
    fireEvent.click(screen.getByTestId("home-new-project"));
    await screen.findByTestId("project-add-form");
    expect(location.hash).toBe("#/projects");
    expect(screen.getByTestId("project-add-open").getAttribute("aria-expanded")).toBe("true");
  });
  it("starts a tagged task from Home", async () => {
    await mount("#/");
    fireEvent.click(document.querySelector('[data-testid="home-start-area"][data-key="work"]')!);
    fireEvent.change(screen.getByTestId("home-start-text"), { target: { value: "Summarize my shift notes" } });
    fireEvent.click(screen.getByTestId("home-start-run"));
    await waitFor(() => expect(location.hash).toBe("#/run/run-demo"));
    const call = calls.find((c) => c.path === "projects/site/runs")!;
    expect(call.body).toMatchObject({ task: "Summarize my shift notes", area: "work" });
    expect(call.body.member ?? call.body.agent).toBeTruthy();
  });
  it("tags projects by class, work or personal and shows each helper's latest state", async () => {
    data.home.classes = ["CS 422"];
    data.home.projects[0].area = "class";
    data.home.projects[0].className = "CS 422";
    data.home.runs = [
      { ...data.run!, runId: "r2", member: "scout", lane: "working", state: "running" },
      { ...data.run!, runId: "r1", member: "scout", lane: "done" },
    ];
    await mount("#/");
    const row = document.querySelector('[data-testid="home-project"][data-key="site"]')!;
    const select = within(row as HTMLElement).getByTestId("project-tag") as HTMLSelectElement;
    expect(select.value).toBe("class:CS 422");
    expect(within(row as HTMLElement).getAllByTestId("home-project-helper")).toHaveLength(1);
    fireEvent.change(select, { target: { value: "personal" } });
    await waitFor(() => expect(calls.some((c) => c.path === "projects/site/tag")).toBe(true));
    expect(calls.find((c) => c.path === "projects/site/tag")!.body).toEqual({ area: "personal" });
  });
  it("shows dated events by tag in Calendar and List, and adds and removes dates", async () => {
    const days = weekOf(new Date());
    const iso = (d: Date) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    data.home.events = [
      { id: "e1", title: "Exam", date: iso(new Date()), kind: "deadline" },
      { id: "e2", title: "Standup", date: iso(days[0]), time: "09:00", kind: "meeting" },
      { id: "e3", title: "Old", date: "2020-01-01", kind: "interview" },
    ];
    data.home.runs = [{ ...data.run!, runId: "today", startedAt: new Date().toISOString(), area: "school" }];
    await mount("#/");
    expect(screen.getAllByTestId("home-day")).toHaveLength(7);
    expect(document.querySelector('[data-testid="home-day"][aria-pressed="true"]')!.getAttribute("data-key")).toBe(iso(new Date()));
    const shown = () => screen.queryAllByTestId("home-event").map((r) => r.getAttribute("data-key"));
    expect(shown()).toContain("e1");
    expect(screen.getAllByTestId("home-task").map((r) => r.getAttribute("data-key"))).toEqual(["today"]);
    fireEvent.click(document.querySelector('[data-testid="home-mode"][data-key="list"]')!);
    expect(shown().sort()).toEqual(["e1", "e2"]);
    fireEvent.click(screen.getByTestId("home-add-event"));
    fireEvent.change(screen.getByTestId("event-title"), { target: { value: "Interview at Acme" } });
    fireEvent.click(document.querySelector('[data-testid="event-kind"][data-key="interview"]')!);
    fireEvent.submit(screen.getByTestId("home-event-form"));
    await waitFor(() => expect(calls.some((c) => c.path === "calendar")).toBe(true));
    expect(calls.find((c) => c.path === "calendar")!.body).toMatchObject({ title: "Interview at Acme", kind: "interview", date: iso(new Date()) });
    fireEvent.click(screen.getByLabelText(S.home.removeEvent.replace("{title}", "Exam")));
    await waitFor(() => expect(calls.some((c) => c.path === "calendar/e1/remove")).toBe(true));
  });
  it("lists pending approvals as Decision, PR and Review, and tags AI accounts", async () => {
    data.home.runs = [
      { ...data.run!, runId: "rev", lane: "needsYou", state: "failed" },
      { ...data.run!, runId: "pr", lane: "inReview", state: "done" },
      { ...data.run!, runId: "dec", lane: "needsYou", state: "running" },
      { ...data.run!, runId: "fin", lane: "done", state: "done" },
    ];
    await mount("#/");
    expect(screen.getAllByTestId("home-approval").map((a) => a.getAttribute("data-key"))).toEqual(["decision", "pr", "review"]);
    const account = screen.getAllByTestId("home-account")[0];
    expect(account.textContent).toContain(S.tags.subscription);
    expect(account.textContent).toMatch(new RegExp(S.tags.loggedIn + "|" + S.tags.loggedOut));
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
  it("keeps the sidebar expanded and moves the theme to Profile > Appearance", async () => {
    await mount("#/");
    expect(screen.queryByTestId("sidebar-toggle")).toBeNull();
    expect(screen.queryByTestId("theme")).toBeNull();
    expect(screen.getByTestId("app-topbar").textContent).toBe(
      S.checkpoints.fallbackName,
    );
    cleanup();
    await mount("#/profile/appearance");
    await screen.findByTestId("profile-appearance");
    const light = screen.getByRole("radio", { name: S.theme.light });
    expect(light.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: S.theme.dark }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("codec-theme")).toBe("dark");
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
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(S.chat.newChat);
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
  it("lists saved chats with search, and renames, tags and deletes the open chat", async () => {
    data.home.classes = ["CS 422"];
    Object.assign(data.chat!, {
      id: "chat-a",
      title: "Debugging Naive Bayes",
      area: "class",
      className: "CS 422",
      messages: [
        { role: "user", text: "Why is accuracy higher on training data?", at: "2026-11-12T21:23:00Z" },
        { role: "assistant", text: "Overfitting.", at: "2026-11-12T21:24:00Z" },
      ],
      chats: [
        { id: "chat-a", title: "Debugging Naive Bayes", tool: "codex", updatedAt: "2026-11-12T21:24:00Z", preview: "Overfitting.", busy: false },
        { id: "chat-b", title: "Geology exam review", tool: "claude", updatedAt: "2026-11-11T10:00:00Z", preview: "Igneous rocks", busy: false },
      ],
    });
    await mount("#/chat/chat-a");
    expect(calls.some((c) => c.path === "chat?id=chat-a")).toBe(true);
    expect(screen.getByTestId("chat-title").textContent).toBe("Debugging Naive Bayes");
    expect(document.querySelector('[data-testid="chat-item"][aria-current="page"]')!.getAttribute("data-key")).toBe("chat-a");
    expect((screen.getByTestId("chat-tag") as HTMLSelectElement).value).toBe("class:CS 422");
    fireEvent.change(screen.getByTestId("chat-search"), { target: { value: "igneous" } });
    expect(screen.getAllByTestId("chat-item").map((a) => a.getAttribute("data-key"))).toEqual(["chat-b"]);
    fireEvent.change(screen.getByTestId("chat-search"), { target: { value: "nothing like this" } });
    expect(screen.getByText(S.chat.noMatches)).toBeTruthy();
    fireEvent.change(screen.getByTestId("chat-tag"), { target: { value: "work" } });
    await waitFor(() => expect(calls).toContainEqual({ path: "chat/chat-a/tag", body: { area: "work" } }));
    fireEvent.click(screen.getByTestId("chat-more"));
    fireEvent.click(screen.getByTestId("chat-rename"));
    fireEvent.change(screen.getByTestId("chat-title-input"), { target: { value: "NB overfitting" } });
    fireEvent.click(screen.getByTestId("chat-title-save"));
    await waitFor(() => expect(calls).toContainEqual({ path: "chat/chat-a/rename", body: { title: "NB overfitting" } }));
    fireEvent.click(screen.getByTestId("chat-more"));
    fireEvent.click(screen.getByTestId("chat-remove"));
    fireEvent.click(await screen.findByTestId("confirm-submit"));
    await waitFor(() => expect(calls).toContainEqual({ path: "chat/chat-a/remove", body: {} }));
    await waitFor(() => expect(location.hash).toBe("#/chat"));
  });
  it("sends to the open chat by id and attaches a text file to the draft", async () => {
    Object.assign(data.chat!, { id: "chat-a", title: "Split", messages: [{ role: "user", text: "Hi" }] });
    await mount("#/chat/chat-a");
    const input = screen.getByTestId("chat-text") as HTMLTextAreaElement;
    const picked = new File(["x = 1\n"], "train.py", { type: "text/x-python" });
    Object.defineProperty(picked, "text", { value: async () => "x = 1\n" });
    fireEvent.change(screen.getByTestId("chat-file"), { target: { files: [picked] } });
    await waitFor(() => expect(input.value).toBe("```train.py\nx = 1\n```\n"));
    fireEvent.change(input, { target: { value: "Check this" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls).toContainEqual({ path: "chat", body: { text: "Check this", id: "chat-a" } }));
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

describe("message limit settings and holds", () => {
  it.each(["project", "team"])("shows and saves the %s limit, including default reset", async (scope) => {
    data.project.project.messageLimit = 7;
    data.teams![0].messageLimit = 4;
    await mount(scope === "project" ? "#/project/site" : "#/teams", false);
    fireEvent.click(screen.getByTestId(scope === "project" ? "project-account-settings" : "team-edit-open"));
    const input = screen.getByRole("spinbutton", { name: S.messageLimit.label }) as HTMLInputElement;
    expect(input.value).toBe(scope === "project" ? "7" : "4");
    expect(input.min).toBe("1");
    expect(input.max).toBe("100");
    expect(input.step).toBe("1");
    expect(screen.getByText(S.messageLimit.hint)).toBeTruthy();
    await userEvent.clear(input);
    await userEvent.type(input, "12");
    await userEvent.click(screen.getByTestId(scope + "-message-limit-save"));
    const path = scope === "project" ? "projects/site/message-limit" : "teams/web/message-limit";
    await waitFor(() => expect(calls).toContainEqual({ path, body: { messageLimit: 12 } }));
    await userEvent.click(screen.getByRole("button", { name: S.messageLimit.resetDefault }));
    await waitFor(() => expect(input.value).toBe(""));
    expect(calls).toContainEqual({ path, body: {} });
    await userEvent.click(screen.getByTestId(scope + "-message-limit-save"));
    await waitFor(() => expect(calls.filter((call) => call.path === path && !Object.hasOwn(call.body, "messageLimit"))).toHaveLength(2));
  });

  it.each(["project", "team"])("preserves the %s limit draft and focus during a poll", async (scope) => {
    data.project.project.messageLimit = 7;
    data.teams![0].messageLimit = 4;
    await mount(scope === "project" ? "#/project/site" : "#/teams", false);
    const toggle = screen.getByTestId(scope === "project" ? "project-account-settings" : "team-edit-open");
    fireEvent.click(toggle);
    const input = screen.getByRole("spinbutton", { name: S.messageLimit.label }) as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "23");
    data.project.project.messageLimit = 8;
    data.teams![0].messageLimit = 8;
    const before = calls.filter((call) => call.path === "state").length;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2200)); });
    expect(calls.filter((call) => call.path === "state").length).toBeGreaterThan(before);
    expect(screen.getByRole("spinbutton", { name: S.messageLimit.label })).toBe(input);
    expect(input.value).toBe("23");
    expect(document.activeElement).toBe(input);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the default field empty and retains the draft when saving fails", async () => {
    handler = (path) => path === "projects/site/message-limit"
      ? response({ code: "invalid_message_limit", error: S.errors.invalid_message_limit }, 400) : undefined;
    await mount("#/project/site", false);
    fireEvent.click(screen.getByTestId("project-account-settings"));
    const input = screen.getByRole("spinbutton", { name: S.messageLimit.label }) as HTMLInputElement;
    expect(input.value).toBe("");
    await userEvent.type(input, "5");
    await userEvent.click(screen.getByTestId("project-message-limit-save"));
    await screen.findByText(S.errors.invalid_message_limit);
    expect(input.value).toBe("5");
  });

  it("renders Codec system rows and lets a capped pair continue through the reset route", async () => {
    data.project.messages = [{
      id: "system-note", senderName: "Codec", senderKind: "system", recipientName: "web/tester",
      body: S.messageLimit.reached, sentAt: "2026-11-11T12:00:00Z", waiting: false,
    }];
    data.project.cappedPairs = [{ key: "coordinator|web/tester", a: "coordinator", b: "web/tester", limit: 10 }];
    handler = (path) => {
      if (path === "projects/site/message-limits/reset") {
        data.project.cappedPairs = [];
        return response({ ok: true });
      }
    };
    await mount("#/project/site", false);
    await userEvent.click(screen.getByRole("tab", { name: /^Conversation/ }));
    const row = screen.getByTestId("conversation-message");
    expect(within(row).getByText("Codec")).toBeTruthy();
    expect(within(row).getByText(S.messageLimit.reached)).toBeTruthy();
    expect(row.className).toContain("bg-background");
    expect(screen.getByText("Coordinator and web/tester reached the message limit.")).toBeTruthy();
    const composer = screen.getByRole("textbox", { name: S.conversation.message }) as HTMLTextAreaElement;
    await userEvent.type(composer, "Keep this draft");
    await userEvent.click(screen.getByRole("button", { name: S.messageLimit.continue }));
    await waitFor(() => expect(calls).toContainEqual({ path: "projects/site/message-limits/reset", body: { pairKey: "coordinator|web/tester" } }));
    await waitFor(() => expect(screen.queryByText("Coordinator and web/tester reached the message limit.")).toBeNull());
    expect(composer.value).toBe("Keep this draft");
  });

  it("keeps the capped-pair control visible after a failed reset", async () => {
    data.project.cappedPairs = [{ key: "web/tester|web/writer", a: "web/tester", b: "web/writer" }];
    handler = (path) => path.endsWith("message-limits/reset")
      ? response({ code: "message_pair_not_found", error: S.errors.message_pair_not_found }, 404) : undefined;
    await mount("#/project/site", false);
    await userEvent.click(screen.getByRole("tab", { name: /^Conversation/ }));
    await userEvent.click(screen.getByRole("button", { name: S.messageLimit.continue }));
    await screen.findByText(S.errors.message_pair_not_found);
    expect((screen.getByRole("button", { name: S.messageLimit.continue }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows held helpers without tasks under Needs you on Helpers", async () => {
    data.home.runs = [];
    data.teams![0].members[0].held = true;
    data.home.coordinator = { settings: { tool: "codex", held: true, createdAt: "2026-11-11T12:00:00Z" }, running: false };
    const rows = helperRows(data.teams!, [], ["site"], data.home.coordinator.settings);
    expect(rows.map(helperStatus)).toEqual([["needsYou", S.tasks.needsYou], ["needsYou", S.tasks.needsYou]]);
    await mount("#/helpers");
    for (const row of screen.getAllByTestId("helper-row")) expect(within(row).getByText(S.tasks.needsYou)).toBeTruthy();
  });
});

describe("test results after keeping changes", () => {
  type Tests = NonNullable<Extract<NonNullable<Run["reviewed"]>, { action: "applied" }>["tests"]>;
  const base = "runs/run-demo/tests";
  function result(tests: Tests, lane: Run["lane"] = "inReview", who: Partial<Run> = {}) {
    data.run = { ...data.run!, ...who, reviewed: { action: "applied", at: "now", commit: "abcdef0", hunks: 4, total: 4, tests }, lane };
    data.project.lanes = { working: [], needsYou: [], inReview: [], done: [] };
    data.project.lanes[lane!] = [data.run];
    return data.run;
  }
  const failed: Tests = { state: "failed", failures: [{ name: "Cart > adds items", file: "test/cart.test.ts" }], changedFiles: ["src/cart.ts"], outputFile: "tests.log" };
  async function open(route = "#/project/site") {
    await mount(route, false);
    await userEvent.click(screen.getByTestId("task-review"));
    return screen.getByRole("dialog");
  }
  it("shows failure names and files on the card and panel, and lazily loads plain text output", async () => {
    result(failed);
    handler = (path) => path === base + "/output" ? new Response("Full test diagnostics\n", { headers: { "Content-Type": "text/plain" } }) : undefined;
    const dialog = await open();
    const panel = within(dialog);
    expect(panel.getByText("1 tests failed")).toBeTruthy();
    expect(panel.getByText("Cart > adds items")).toBeTruthy();
    expect(panel.getByText("test/cart.test.ts")).toBeTruthy();
    expect(screen.getAllByText("Cart > adds items")).toHaveLength(2);
    expect(screen.getByText(S.tests.failedBadge)).toBeTruthy();
    expect(panel.getByText(S.tests.changedFiles)).toBeTruthy();
    expect(panel.getByText("src/cart.ts")).toBeTruthy();
    for (const label of ["Send back to tester", S.tests.rerun, S.tests.done]) expect(panel.getByRole("button", { name: label })).toBeTruthy();
    expect(calls.some((call) => call.path === base + "/output")).toBe(false);
    await userEvent.click(panel.getByText(S.tests.output));
    expect(await panel.findByText("Full test diagnostics")).toBeTruthy();
    await userEvent.click(panel.getByRole("button", { name: S.diffViewer.close }));
    await userEvent.click(screen.getByTestId("task-review"));
    expect(within(screen.getByRole("dialog")).getByText("Cart > adds items")).toBeTruthy();
  });
  it.each([true, false])("sends back and shows delivered=%s feedback across the move to Working", async (delivered) => {
    result(failed);
    handler = (path) => {
      if (path !== base + "/send-back") return;
      result({ ...failed, sentBack: { at: "now", messageId: "msg", to: "web/tester" } }, "working", { testsFollowup: { waiting: !delivered, finished: false } });
      return response({ delivered, messageId: "msg" });
    };
    const dialog = await open();
    await userEvent.click(within(dialog).getByRole("button", { name: "Send back to tester" }));
    expect(await screen.findByText(delivered ? "Sent to tester." : "It will reach tester when it starts its next task.")).toBeTruthy();
    expect(calls.find((call) => call.path === base + "/send-back")?.body).toEqual({});
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(screen.getByText("Sent back to tester")).toBeTruthy();
    if (!delivered) expect(screen.getByText(S.conversation.waiting)).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Send back to tester" })).toBeNull();
  });
  it.each(["queued", "running"] as const)("shows %s progress and a spinning card badge", async (state) => {
    result({ state });
    const dialog = await open();
    expect(within(dialog).getByText(state === "queued" ? S.tests.queued : S.tests.running)).toBeTruthy();
    expect(screen.getByText(S.tests.testing).querySelector(".animate-spin")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: S.tests.rerun })).toBeNull();
  });
  it("keeps results after closing while tests run, then reopening from Done", async () => {
    result({ state: "running" });
    await open();
    await userEvent.click(screen.getByRole("button", { name: S.diffViewer.close }));
    result({ state: "passed" }, "done");
    await screen.findByText(S.tests.passedBadge, {}, { timeout: 5000 });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText(S.tests.passedMessage)).toBeTruthy();
    await userEvent.click(screen.getByTestId("task-review"));
    expect(within(screen.getByRole("dialog")).getByText(S.tests.passed)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: S.tests.showChanges }));
    await screen.findByText("+after");
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
  it.each(["skipped", "error", "interrupted"] as const)("shows the %s explanation", async (state) => {
    const note = state === "error" ? S.tests.startError : S.tests.interrupted;
    result({ state, note }, state === "skipped" ? "done" : "inReview");
    const dialog = await open();
    expect(within(dialog).getByText(state === "skipped" ? S.tests.skipped : note)).toBeTruthy();
    if (state !== "skipped") expect(within(dialog).getByText(S.tests.unparsed)).toBeTruthy();
    if (state !== "error") expect(within(dialog).queryByRole("button", { name: "Send back to tester" })).toBeNull();
  });
  it("offers rerun and done for quick helpers without a send-back button", async () => {
    result(failed, "inReview", { team: undefined, member: undefined });
    const dialog = await open();
    expect(within(dialog).queryByRole("button", { name: /Send back/ })).toBeNull();
    expect(within(dialog).getByRole("button", { name: S.tests.rerun })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: S.tests.done })).toBeTruthy();
  });
  it.each(["", "/done"] as const)("posts the %s test action and updates results", async (suffix) => {
    result(failed);
    handler = (path) => path === base + suffix ? response(result(suffix ? { ...failed, closedAt: "now" } : { state: "queued" }, suffix ? "done" : "inReview")) : undefined;
    const dialog = await open();
    await userEvent.click(within(dialog).getByRole("button", { name: suffix ? S.tests.done : S.tests.rerun }));
    await waitFor(() => expect(calls.some((call) => call.path === base + suffix)).toBe(true));
    if (!suffix) expect(await within(dialog).findByText(S.tests.queued)).toBeTruthy();
    expect(screen.getByRole("dialog")).toBe(dialog);
  });
  it("shows plain text state errors without losing the results", async () => {
    result(failed);
    handler = (path) => path === base + "/send-back" ? new Response(S.errors.tests_unavailable, { status: 409, headers: { "Content-Type": "text/plain" } }) : undefined;
    const dialog = await open();
    await userEvent.click(within(dialog).getByRole("button", { name: "Send back to tester" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", S.errors.tests_unavailable);
    expect(within(dialog).getByText("Cart > adds items")).toBeTruthy();
  });
});
