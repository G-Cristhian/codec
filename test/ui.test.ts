import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { S } from "../src/strings.js";
import { renderLocked, renderPage } from "../src/ui.js";

const source = readFileSync(new URL("../src/ui.ts", import.meta.url), "utf8");
const stringsSource = readFileSync(new URL("../src/strings.ts", import.meta.url), "utf8");
const page = renderPage("test-token");
const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const functions = [...scripts[1].matchAll(/^(?:async )?function \w+\([^\n]*\{[^\n]*\}(?=\n)|^(?:async )?function \w+\([^\n]*\{\n[\s\S]*?^}/gm)].map((m) => m[0]).join("\n");

// Exercise the actual inline functions without adding a browser dependency.
function runtime(bindings: Record<string, unknown> = {}) {
  const params = { S, TOKEN: "test-token", setupState: { tools: [], ready: false }, ...bindings };
  return new Function(...Object.keys(params), functions + `\nif (typeof overrides !== "undefined") { if (overrides.h) h = overrides.h; if (overrides.render) render = overrides.render; if (overrides.showDialog) showDialog = overrides.showDialog; if (overrides.api) api = overrides.api; if (overrides.act) act = overrides.act; if (overrides.tell) tell = overrides.tell; }\nreturn {
    api, errorText, sourceText, fmt, limitText, limitValue, stateText, toolOK, toolProblem, snapshot, restore,
    removeItem, showDialog, folderPicker, render, replace, messageContent, stateText, run, project, projectAddForm, skillAddForm, skillUploadForm,
    helperRows, helperStatus, ago, profile, initials, greeting, weekOf, dayKey, homeNotes, teamCard, weekTasks,
    accounts, accountPicker, accountSettings, loginDetails
  };`)(...Object.values(params));
}
describe("dashboard wording and structure", () => {
  it("injects the complete wording object as JSON", () => {
    const injected = scripts[1].match(/const S = (.*);\nconst TOKEN/);
    expect(injected).not.toBeNull();
    expect(JSON.parse(injected![1])).toEqual(S);
    expect(renderLocked()).toContain(S.locked.hint);
  });

  it.each([false, true])("separates board metadata lines (team role: %s)", async (hasRole) => {
    let tree: any[] = [];
    const capture = (spec: string, props: any, ...kids: any[]) => ({
      spec, props, kids: kids.flat(Infinity).filter((kid) => kid != null && kid !== false),
      options: [], addEventListener() {},
    });
    const task = { runId: "task-1", task: "Check workspace", state: "done", reviewStatus: "unsaved",
      startedAt: "2026-10-28T23:12:00Z", ...(hasRole ? { team: "web", member: "builder", specialist: "developer" } : {}) };
    const lanes = { working: [], needsYou: [task], inReview: [], done: [] };
    const { project, fmt } = runtime({
      LANES: Object.keys(lanes).map((lane) => [lane, lane]), messages: new Map(), enc: encodeURIComponent,
      overrides: { h: capture, api: async () => ({ project: { path: "/workspace" }, members: [], lanes }),
        render: (_seq: number, ...kids: any[]) => { tree = kids; } },
    });
    await project(1, "site");
    const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes)
      : node && typeof node === "object" ? [node, ...nodes(node.kids || [])] : [];
    const card = nodes(tree).find((node) => node.props?.["data-testid"] === "task-open");
    const lines = card.kids.filter((node: any) => node.spec === "div.hint");
    const timestamp = new Date(task.startedAt).toLocaleString();
    expect(lines.map((node: any) => node.props.text)).toEqual([
      ...(hasRole ? [fmt(S.wording.teamRole, { team: "web", role: "developer" }) + "\n"] : []),
      S.tasks.unsaved + "\n", timestamp + "\n",
    ]);
    const textContent = (node: any): string => typeof node === "string" ? node
      : (node.props?.text || "") + (node.kids || []).map(textContent).join("");
    expect(textContent(card)).toContain(S.tasks.unsaved + "\n" + timestamp);
    expect(textContent(card)).not.toContain(S.tasks.unsaved + timestamp);
  });

  it("every referenced wording key exists", () => {
    const references = [...source.matchAll(/\bS((?:\.[A-Za-z]\w*)+)/g)];
    expect(references.length).toBeGreaterThan(100);
    for (const ref of references) {
      let value: unknown = S;
      for (const key of ref[1].slice(1).split(".")) {
        expect(value, ref[0]).toBeTypeOf("object");
        value = (value as Record<string, unknown>)[key];
        expect(value, ref[0]).not.toBeUndefined();
      }
    }
  });

  it("has no literal English in visible text properties or helper labels", () => {
    const violations: string[] = [];
    for (const match of source.matchAll(/\b(?:text|label|placeholder|title)\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
      const text = JSON.parse(match[1]);
      if (/[A-Za-z]/.test(text) && text !== "Codec") violations.push(match[0]);
    }
    for (const match of source.matchAll(/\b(?:button|submit|field|disclosure)\(\s*"[^"\n]*"\s*,\s*("(?:[^"\\]|\\.)*")|\b(?:hint|heading|showDialog)\(\s*("(?:[^"\\]|\\.)*")/g)) {
      if (/[A-Za-z]/.test(JSON.parse(match[1] || match[2]))) violations.push(match[0]);
    }
    expect(violations).toEqual([]);
    const markup = source.slice(source.indexOf("export function renderPage"), source.indexOf('<script>\n"use strict";'))
      .replace(/<style>[\s\S]*?<\/style>/g, "").replace(/\$\{[^}]+\}/g, "");
    const text = [...markup.matchAll(/>([^<>]+)</g)].map((m) => m[1].trim()).filter((t) => /[A-Za-z]/.test(t));
    expect(text.every((t) => t === "Codec")).toBe(true);
  });

  it("all inline scripts parse, including hostile token text", () => {
    for (const code of scripts) expect(() => new Function(code)).not.toThrow();
    const hostile = renderPage('</script><script>alert("bad")</script>\u2028');
    const codes = [...hostile.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(codes).toHaveLength(2);
    for (const code of codes) expect(() => new Function(code)).not.toThrow();
    expect(hostile).not.toContain('<script>alert("bad")');
  });

  it("contains the wizard, folder picker and persistent in-page confirmation dialog", () => {
    for (const id of ["setup-wizard", "folder-picker", "folder-current", "folder-up", "folder-entry", "folder-use", "confirm-dialog", "confirm-effects", "confirm-blocked"]) expect(page).toContain(id);
    expect(page).toContain('<dialog id="confirm"');
    expect(page).not.toMatch(/\b(?:window\.)?confirm\s*\(/);
    expect(page).toContain('api("setup?fresh=1")');
    expect(page).toContain('api("remove-preview?kind="');
    expect(page).toContain('setUpTracking: true');
  });

  it("documents stable selectors for every action and field", () => {
    const ids = [
      "project-add-open", "project-name", "project-path", "project-save", "project-remove", "tracking-yes", "tracking-no",
      "specialist-add-open", "specialist-edit-open", "specialist-name", "specialist-specialty", "specialist-tool", "specialist-model", "specialist-limit", "specialist-instructions", "specialist-skill", "specialist-save", "specialist-remove",
      "team-add-open", "team-edit-open", "team-name", "team-project", "team-save", "team-remove",
      "member-add-open", "member-edit-open", "member-kind", "member-name", "member-model", "member-limit", "member-skill", "member-save", "member-remove",
      "skill-add-open", "skill-path", "skill-save", "skill-remove", "skill-upload", "skill-upload-save",
      "folder-browse", "folder-up", "folder-entry", "folder-use", "setup-check", "setup-continue", "setup-copy",
      "task-who", "task-text", "task-limit", "task-start", "task-stop", "task-clean", "task-delete-branch", "confirm-submit", "confirm-cancel",
    ];
    for (const id of ids) {
      expect(stringsSource).toContain(id);
      // Remove buttons use the kind plus "-remove"; paths use the picker prefix.
      if (!/^(project-path|skill-path)|-remove$/.test(id)) expect(page).toContain('"' + id + '"');
    }
    for (const control of scripts[1].matchAll(/h\("(?:button|input|select|textarea|summary)(?:\.[^"]*)?",\s*\{([^}]+)\}/g)) {
      expect(control[1], control[0]).toContain('"data-testid"');
    }
  });

  it("uses DOM text insertion, with no HTML injection or external dependencies", () => {
    expect(source).not.toMatch(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/);
    expect(page).toContain("el.textContent = value");
    expect(page).not.toMatch(/<script\b[^>]*\bsrc=|<link\b|https?:\/\//);
  });
});

describe("helpers overview", () => {
  it("gives every team helper one row with its live or latest task, plus quick helpers that still need attention", () => {
    const LANES = [["working", S.tasks.working], ["needsYou", S.tasks.needsYou], ["inReview", S.tasks.inReview], ["done", S.tasks.done]];
    const { helperRows, helperStatus } = runtime({ LANES, enc: encodeURIComponent });
    const teams = [{ name: "pod", projects: ["site"], members: [
      { member: "scout", tool: "claude", specialty: "Research", projects: ["site"] },
      { member: "writer", tool: "claude", projects: ["site"] },
      { member: "idle", tool: "codex", projects: ["site"] },
      { member: "orphan", error: "role_missing" },
    ] }];
    // Newest first, as /api/state returns them.
    const runs = [
      { runId: "run-4", project: "site", agent: "codex", lane: "needsYou", state: "failed", task: "Quick fix" },
      { runId: "run-5", project: "site", agent: "codex", lane: "done", state: "done", task: "Old quick task" },
      { runId: "run-3", project: "site", team: "pod", member: "writer", lane: "inReview", state: "done", task: "Draft" },
      { runId: "run-2", project: "site", team: "pod", member: "scout", lane: "done", state: "done", task: "Earlier" },
      { runId: "run-1", project: "site", team: "pod", member: "scout", lane: "working", state: "running", task: "Search" },
    ];
    const rows = helperRows(teams, runs);
    expect(rows.map((row: any) => [row.key, helperStatus(row)[0], row.run?.runId])).toEqual([
      ["pod/scout", "working", "run-1"], ["pod/writer", "inReview", "run-3"], ["pod/idle", "idle", undefined],
      ["pod/orphan", "needsYou", undefined], ["run:run-4", "needsYou", "run-4"],
    ]);
    expect(rows[0].sub).toBe("Research");
    expect(rows[1].sub).toBe(S.members.worker);
    expect(helperStatus(rows[3])[1]).toBe(S.helpers.broken);
  });

  it("says how long ago a task started in plain words", () => {
    const { ago } = runtime();
    const before = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
    expect(ago(before(0))).toBe(S.time.now);
    expect(ago(before(5))).toBe("5 min ago");
    expect(ago(before(180))).toBe("3 h ago");
    expect(ago(before(2 * 1440))).toBe("2 d ago");
    expect(ago(undefined)).toBe(S.common.unknown);
  });
});

describe("home dashboard", () => {
  const LANES = [["working", S.tasks.working], ["needsYou", S.tasks.needsYou], ["inReview", S.tasks.inReview], ["done", S.tasks.done]];
  const capture = (spec: string, props: any, ...kids: any[]) => ({ spec, props, kids: kids.flat(Infinity).filter((kid) => kid != null && kid !== false) });
  const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object" ? [node, ...nodes(node.kids || [])] : [];
  const teams = [{ name: "pod", projects: ["site"], members: [
    { member: "scout", tool: "claude", projects: ["site"] }, { member: "writer", tool: "codex", projects: ["site"] }, { member: "orphan", error: "role_missing" },
  ] }];
  const runs = [
    { runId: "run-3", project: "site", team: "pod", member: "writer", agent: "codex", lane: "needsYou", state: "failed", task: "Draft methods", startedAt: "2026-10-29T15:00:00" },
    { runId: "run-2", project: "site", team: "pod", member: "scout", agent: "claude", lane: "working", state: "running", task: "Summarize papers", startedAt: "2026-10-28T09:00:00" },
    { runId: "run-1", project: "site", team: "pod", member: "scout", agent: "claude", lane: "done", state: "done", task: "Earlier", startedAt: "2026-10-20T09:00:00" },
  ];

  it("greets by first name and time of day", () => {
    const { greeting } = runtime();
    expect(greeting(new Date(2026, 9, 29, 8), "Jordan Lee")).toBe("Good morning, Jordan");
    expect(greeting(new Date(2026, 9, 29, 14), "")).toBe(S.home.afternoon);
    expect(greeting(new Date(2026, 9, 29, 20), "Sam")).toBe("Good evening, Sam");
  });

  it("builds a Monday-to-Sunday week", () => {
    const { weekOf, dayKey } = runtime();
    expect(weekOf(new Date(2026, 9, 29, 12)).map(dayKey)).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-1"]);
    expect(dayKey(weekOf(new Date(2026, 10, 1))[0])).toBe("2026-10-26");
  });

  it("lists what needs the user, including tools a team relies on but not unused ones", () => {
    const setupState = { identityReady: false, tools: [{ tool: "claude", installed: true, signedIn: true }, { tool: "codex", installed: true, signedIn: false }] };
    const { helperRows, homeNotes } = runtime({ LANES, enc: encodeURIComponent, setupState });
    const notes = homeNotes(helperRows(teams, runs), runs);
    expect(notes.map((n: any) => n.title)).toEqual([S.home.needsOne, S.home.brokenOne, "Codex isn't ready", S.home.identityTitle]);
    expect(notes[0].href).toBe("#/run/run-3");
    const quiet = runtime({ LANES, enc: encodeURIComponent, setupState: { ...setupState, identityReady: true } });
    expect(quiet.homeNotes(quiet.helperRows([{ ...teams[0], members: [teams[0].members[0]] }], []), [])).toEqual([]);
  });

  it("summarizes a team's helpers and progress", () => {
    const { helperRows, teamCard } = runtime({ LANES, enc: encodeURIComponent, overrides: { h: capture } });
    const all = nodes(teamCard(teams[0], helperRows(teams, runs), runs));
    expect(all.filter((n) => n.spec.startsWith("span.status")).map((n) => [n.spec, n.props.text])).toEqual([
      ["span.status.working", "1 working"], ["span.status.needsYou", "2 need you"],
    ]);
    expect(all.find((n) => n.spec === "p").props.text).toBe("scout is working on “Summarize papers”. writer needs you (Didn't finish). orphan needs fixing.");
    expect(all.find((n) => n.spec === "i").props.style).toBe("width:33%");
  });

  it("shows the selected day in Calendar and the whole week in List", () => {
    const now = new Date(2026, 9, 29, 16);
    const view = (homeMode: string) => {
      const r = runtime({ LANES, enc: encodeURIComponent, homeDay: "", homeMode, overrides: { h: capture } });
      return nodes(r.weekTasks(runs, now));
    };
    const calendar = view("calendar");
    expect(calendar.filter((n) => n.props?.["data-testid"] === "home-day")).toHaveLength(7);
    expect(calendar.find((n) => n.props?.["aria-pressed"] === "true" && n.props?.["data-testid"] === "home-day").props["data-key"]).toBe("2026-10-29");
    expect(calendar.filter((n) => n.props?.["data-testid"] === "home-task").map((n) => n.props["data-key"])).toEqual(["run-3"]);
    expect(view("list").filter((n) => n.props?.["data-testid"] === "home-task").map((n) => n.props["data-key"])).toEqual(["run-3", "run-2"]);
  });
});

describe("inline API behavior", () => {
  it("uses authenticated GET and JSON POST on the contract routes", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ready: true }) });
    const { api } = runtime({ fetch });
    expect(await api("setup?fresh=1")).toEqual({ ready: true });
    expect(fetch).toHaveBeenLastCalledWith("/api/setup?fresh=1", { headers: { "X-Codec-Token": "test-token" } });
    await api("projects", { path: "/chosen", setUpTracking: true });
    expect(fetch).toHaveBeenLastCalledWith("/api/projects", {
      method: "POST", headers: { "X-Codec-Token": "test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/chosen", setUpTracking: true }),
    });
  });

  it("maps known codes to the wording file and preserves the tracking signal internally", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ code: "needs_tracking", error: "Set up this folder now?" }) });
    const { api, errorText } = runtime({ fetch });
    const error = await api("projects", { path: "/chosen" }).catch((e: unknown) => e);
    expect(error.code).toBe("needs_tracking");
    expect(errorText(error)).toBe(S.errors.needs_tracking);
  });

  it("turns network failures into a plain sentence", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("ECONNREFUSED stack detail"));
    const { api, errorText } = runtime({ fetch });
    const error = await api("setup").catch((e: unknown) => e);
    expect(errorText(error)).toBe(S.common.networkError);
    expect(errorText(new Error("private detail"))).toBe(S.common.error);
  });

  it("uses safe fallbacks for non-JSON and missing API error sentences", async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ ok: false, json: async () => { throw new SyntaxError("secret HTML"); } })
      .mockResolvedValueOnce({ ok: false, statusText: "private detail", json: async () => ({ code: "internal_error" }) });
    const { api, errorText } = runtime({ fetch });
    expect(errorText(await api("state").catch((e: unknown) => e))).toBe(S.common.invalidReply);
    expect(errorText(await api("state").catch((e: unknown) => e))).toBe(S.common.error);
  });

  it("only enables an installed tool confirmed signed in", () => {
    const { toolOK, toolProblem } = runtime({ setupState: { tools: [
      { tool: "claude", installed: true, signedIn: true },
      { tool: "codex", installed: true, signedIn: null, problem: "Sign in to Codex." },
    ] } });
    expect(toolOK("claude")).toBe(true);
    expect(toolOK("codex")).toBe(false);
    expect(toolProblem("codex")).toBe("Sign in to Codex.");
    expect(toolOK("missing")).toBe(false);
    expect(toolProblem("missing")).toBe(S.setup.unchecked);
  });

  it("uses plain task states without exposing exit codes", () => {
    const { stateText, limitText } = runtime();
    expect(stateText({ state: "failed", exitCode: 127 })).toBe(S.tasks.failed);
    expect(stateText({ state: "timed_out", stateText: "Stopped: went over its time limit (3 seconds)" })).toBe("Stopped: went over its time limit (3 seconds)");
    expect(stateText({ state: "timed_out", timeLimitMinutes: 3 })).toBe("Stopped: went over its time limit (3 minutes)");
    expect(limitText(0)).toBe(S.common.noLimit);
    expect(limitText(1.5)).toBe("1.5 minutes");
  });

  it("keeps time limits within the API's supported range", () => {
    const { limitValue, errorText } = runtime();
    const form = (value: string) => ({ querySelector: () => ({ value }) });
    expect(limitValue(form(""), "limit")).toBeUndefined();
    expect(limitValue(form("0.05"), "limit")).toBe(0.05);
    for (const value of ["0", "-1", "1441", "bad"]) {
      try { limitValue(form(value), "limit"); throw new Error("unexpected acceptance"); }
      catch (e) { expect(errorText(e)).toBe(S.common.timeInvalid); }
    }
  });
});

describe("refresh preserves editing", () => {
  it("captures typed values, selections, open forms, focus/caret and upload nodes", () => {
    const input = { id: "name", value: "Still typing", checked: false, type: "text", selectionStart: 3, selectionEnd: 7 };
    const checkbox = { id: "skill", value: "review", checked: true, type: "checkbox" };
    const file = { id: "upload", type: "file" };
    const app = { contains: () => true, querySelector: () => null, querySelectorAll: (query: string) => {
      if (query === "details[id]") return [{ id: "edit", open: true }];
      if (query === "input[type=file][id]") return [file];
      return [input, checkbox, file];
    } };
    const { snapshot } = runtime({ app, document: { activeElement: input }, window: { scrollY: 123 } });
    const saved = snapshot();
    expect(saved.fields).toEqual([{ id: "name", value: "Still typing", checked: false }, { id: "skill", value: "review", checked: true }]);
    expect(saved.files).toEqual([file]);
    expect(saved.open).toEqual([["edit", true]]);
    expect(saved.focus).toEqual({ id: "name", start: 3, end: 7 });
    expect(saved.scroll).toBe(123);
  });

  it("restores editing state and moves the original upload input into the refreshed page", () => {
    const input = { tagName: "TEXTAREA", value: "", focus: vi.fn(), setSelectionRange: vi.fn() };
    const checkbox = { type: "checkbox", checked: false };
    const select = { tagName: "SELECT", value: "claude", options: [{ value: "codex", disabled: true }] };
    const details = { open: false };
    const filePlaceholder = { replaceWith: vi.fn() };
    const file = { id: "upload" };
    const elements: Record<string, unknown> = { name: input, skill: checkbox, tool: select, edit: details, upload: filePlaceholder };
    const window = { scrollTo: vi.fn() };
    const { restore } = runtime({ app: { querySelector: () => null }, document: { getElementById: (id: string) => elements[id] }, window });
    restore({ fields: [{ id: "name", value: "Still typing" }, { id: "skill", checked: true }, { id: "tool", value: "codex" }],
      files: [file], open: [["edit", true]], focus: { id: "name", start: 3, end: 7 }, scroll: 123 });
    expect(input.value).toBe("Still typing");
    expect(checkbox.checked).toBe(true);
    expect(select.value).toBe("");
    expect(details.open).toBe(true);
    expect(input.setSelectionRange).toHaveBeenCalledWith(3, 7);
    expect(window.scrollTo).toHaveBeenCalledWith(0, 123);
    expect(filePlaceholder.replaceWith).toHaveBeenCalledWith(file);
  });

  it("keeps the two-second poll and excludes absent children from rendered text", () => {
    expect(page).toContain("setTimeout(refresh, 2000)");
    const element = { replaceChildren: vi.fn() };
    runtime().replace(element, null, undefined, false, ["visible", null]);
    expect(element.replaceChildren).toHaveBeenCalledWith("visible");
  });
});

describe("Wave 2 wording and actions", () => {
  it("maps every server code in the browser and uses fallback text only for unknown codes", () => {
    const { errorText, fmt } = runtime();
    const params = { name: "site", member: "tester", team: "web", project: "site", count: 2, list: "tester", field: "description", path: "/selected" };
    for (const [code, text] of Object.entries(S.errors)) {
      expect(errorText({ code, params, friendly: true, message: "untrusted API detail" })).toBe(fmt(text, params));
    }
    expect(errorText({ code: "future_code", friendly: true, message: "Plain API fallback." })).toBe("Plain API fallback.");
  });

  it("preserves suggestion data through the API client", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ code: "invalid_name", error: "ignored fallback", suggestion: "website-2" }) });
    const { api, errorText } = runtime({ fetch });
    const error = await api("teams", { name: "Website!" }).catch((e: unknown) => e);
    expect(error.suggestion).toBe("website-2");
    expect(errorText(error)).toBe(S.errors.invalid_name);
  });

  it("fills the suggested name with one click and retries skill imports using only a copy name", () => {
    const tell = vi.fn();
    const capture = (spec: string, props: any, ...kids: any[]) => ({ spec, props, kids: kids.flat(Infinity).filter(Boolean) });
    const { messageContent } = runtime({ overrides: { h: capture, tell }, enc: encodeURIComponent });
    const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object" ? [node, ...nodes(node.kids || [])] : [];
    const content = messageContent("team-add", { text: S.errors.invalid_name, error: { code: "invalid_name", suggestion: "website-2" } });
    const use = nodes(content).find((n) => n.props?.["data-testid"] === "use-suggested-name");
    expect(nodes(content).some((n) => n.kids?.includes("Try: website-2"))).toBe(true);
    const input = { value: "Website!", dispatchEvent: vi.fn(), focus: vi.fn() };
    const form = { querySelector: () => input };
    use.props.onclick({ currentTarget: { closest: () => form } });
    expect(input.value).toBe("website-2");
    expect(input.focus).toHaveBeenCalled();
    const skill = { querySelector: () => null, dataset: {} as Record<string, string>, requestSubmit: vi.fn() };
    use.props.onclick({ currentTarget: { closest: () => skill } });
    expect(skill.dataset.skillName).toBe("website-2");
    expect(skill.requestSubmit).toHaveBeenCalledOnce();
  });

  it("Stop opens the in-page confirmation and sends no request until confirmed", async () => {
    const calls: { title: string; effects: string[]; confirm: () => Promise<unknown> }[] = [];
    let tree: any[] = [];
    const record = { runId: "run-secret", task: "Check files", project: "website", agent: "claude", state: "running", branch: "codec/run-secret", worktree: "/private/workspace", skillsGiven: [], skillsUsed: [] };
    const api = vi.fn(async (_path: string, body?: unknown) => body === undefined ? record : { state: "stopped" });
    const capture = (spec: string, props: any, ...kids: any[]) => ({ spec, props, kids: kids.flat(Infinity).filter((k) => k !== undefined && k !== null && k !== false) });
    const overrides = { h: capture, render: (_seq: number, ...kids: any[]) => { tree = kids; }, api,
      showDialog: (title: string, effects: string[], _blocked: unknown, confirm: () => Promise<unknown>) => calls.push({ title, effects, confirm }) };
    const { run } = runtime({ overrides, messages: new Map(), enc: encodeURIComponent });
    await run(1, record.runId);
    const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object" ? [node, ...nodes(node.kids || [])] : [];
    const stop = nodes(tree).find((n) => n.props?.["data-testid"] === "task-stop");
    stop.props.onclick();
    expect(calls).toHaveLength(1);
    expect(calls[0].effects).toEqual([S.tasks.stopEffect]);
    expect(calls[0].effects[0]).toContain("stays in its workspace");
    expect(api).toHaveBeenCalledTimes(1);
    await calls[0].confirm();
    expect(api).toHaveBeenLastCalledWith("runs/run-secret/stop", {});
    const technical = nodes(tree).find((n) => n.spec === "details" && n.props?.id === "task-technical");
    expect(technical).toBeDefined();
    expect(technical.props.open).toBeUndefined();
    expect(JSON.stringify(technical)).toContain("/private/workspace");
    const visibleTree = tree.map((node) => node === technical ? null : node);
    expect(JSON.stringify(visibleTree)).not.toContain('"text":"run-secret"');
    expect(JSON.stringify(visibleTree)).not.toContain('"text":"/private/workspace"');
    expect(JSON.stringify(visibleTree)).not.toContain('"text":"codec/run-secret"');
  });

  it.each([
    [undefined, undefined, "Default"],
    [undefined, "claude-haiku-5-5", "Default (claude-haiku-5-5)"],
    [undefined, "gpt-6.1-sol", "Default (gpt-6.1-sol)"],
    ["chosen-model", "actual-model", "chosen-model"],
  ])("shows the task's model choice %s and detected model %s as %s", async (model, actualModel, expected) => {
    let tree: any[] = [];
    const record = { runId: "run-model", project: "site", task: "Check", agent: "claude", state: "done", cleanedAt: "today", model, actualModel, skillsGiven: [], skillsUsed: [] };
    const capture = (spec: string, props: any, ...kids: any[]) => ({ spec, props, kids: kids.flat(Infinity).filter(Boolean) });
    const { run } = runtime({ messages: new Map(), enc: encodeURIComponent, overrides: { h: capture, render: (_seq: number, ...kids: any[]) => { tree = kids; }, api: async () => record } });
    await run(1, record.runId);
    const kv = tree.find((node) => node?.spec === "div.kv");
    const label = kv.kids.findIndex((node: any) => node.props.text === S.wording.aiModel);
    expect(kv.kids[label + 1].props.text).toBe(expected);
  });

  it("Setup displays missing identity, prefills fields, and saves edits through the settings API", async () => {
    let tree: any[] = [];
    const fields: Record<string, string> = { "identity-name": "Edited Owner", "identity-email": "edited@example.invalid" };
    const capture = (spec: string, props: any, ...kids: any[]) => ({ spec, props, kids: kids.flat(Infinity).filter(Boolean),
      querySelector: (selector: string) => ({ value: fields[selector.match(/identity-(?:name|email)/)![0]] }) });
    const api = vi.fn(async () => ({ identity: { name: "Global Owner", email: "global@example.invalid" } }));
    const { profile } = runtime({ profileReturn: "#/", document: { createElementNS: () => ({ setAttribute() {}, append() {} }), querySelector: () => ({ namespaceURI: "svg" }) },
      messages: new Map(), setupState: { tools: [], ready: true, identityReady: false },
      overrides: { h: capture, render: (_seq: number, ...kids: any[]) => { tree = kids; }, api,
        act: async (_key: string, _trigger: unknown, action: () => Promise<void>) => { await action(); } } });
    await profile(1, "setup");
    const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object" ? [node, ...nodes(node.kids || [])] : [];
    const all = nodes(tree);
    expect(all.find((node) => node.props?.["data-testid"] === "identity-missing").props.text).toBe(S.setup.identityMissing);
    expect(all.find((node) => node.props?.id === "identity-name").props.value).toBe("Global Owner");
    expect(all.find((node) => node.props?.id === "identity-email").props.value).toBe("global@example.invalid");
    const form = all.find((node) => node.props?.["data-testid"] === "identity-form");
    form.props.onsubmit({ preventDefault() {} });
    await Promise.resolve();
    expect(api).toHaveBeenLastCalledWith("settings", { identity: { name: "Edited Owner", email: "edited@example.invalid" } });
  });

  it("Profile opens on the Info tab with name, email and sign-ins, and saves through the settings API", async () => {
    let tree: any[] = [];
    const fields: Record<string, string> = { "identity-name": "Jordan Lee", "identity-email": "jordan@example.invalid" };
    const capture = (spec: string, props: any, ...kids: any[]) => ({ spec, props, kids: kids.flat(Infinity).filter(Boolean),
      querySelector: (selector: string) => ({ value: fields[selector.match(/identity-(?:name|email)/)![0]] }) });
    const api = vi.fn(async () => ({ identity: { name: "Saved Owner", email: "saved@example.invalid" } }));
    const tools = [{ tool: "claude", installed: true, signedIn: true }, { tool: "codex", installed: true, signedIn: false, problem: "Sign in to Codex", fix: "codex login" }];
    const svgNode = () => ({ setAttribute() {}, append() {} });
    const { profile, initials } = runtime({ messages: new Map(), setupState: { tools, ready: true, identityReady: true },
      profileReturn: "#/projects", document: { createElementNS: svgNode, querySelector: () => ({ namespaceURI: "svg" }) },
      overrides: { h: capture, render: (_seq: number, ...kids: any[]) => { tree = kids; }, api,
        act: async (_key: string, _trigger: unknown, action: () => Promise<void>) => { await action(); } } });
    await profile(1, "unknown-tab");
    const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object" ? [node, ...nodes(node.kids || [])] : [];
    const all = nodes(tree);
    const tab = all.find((node) => node.props?.["data-testid"] === "profile-tab");
    expect(tab.props).toMatchObject({ "data-key": "info", "aria-current": "page", href: "#/profile/info" });
    expect(tab.kids).toContain(S.profile.info);
    expect(all.find((node) => node.props?.["data-testid"] === "profile-back").props.href).toBe("#/projects");
    const body = all.find((node) => node.props?.["data-testid"] === "profile-info");
    expect(body.kids[0].props.text).toBe(S.profile.info);
    expect(all.find((node) => node.props?.["data-testid"] === "identity-save").props.text).toBe(S.profile.saveChanges);
    expect(all.find((node) => node.props?.id === "identity-name").props.value).toBe("Saved Owner");
    expect(all.find((node) => node.props?.id === "identity-email").props.value).toBe("saved@example.invalid");
    const cards = all.filter((node) => node.props?.["data-testid"] === "setup-tool");
    expect(cards.map((card) => card.kids[1].props.text)).toEqual([S.profile.signedIn, "Sign in to Codex"]);
    expect(all.find((node) => node.props?.["data-testid"] === "setup-fix").props.text).toBe("codex login");
    all.find((node) => node.props?.["data-testid"] === "identity-form").props.onsubmit({ preventDefault() {} });
    await Promise.resolve();
    expect(api).toHaveBeenLastCalledWith("settings", { identity: { name: "Jordan Lee", email: "jordan@example.invalid" } });
    expect([initials("Jordan Lee"), initials("  ada  "), initials("Mary Ann Smith"), initials(""), initials(undefined)]).toEqual(["JL", "A", "MA", "", ""]);
  });

  it.each([
    [0, false, S.setup.notReady + " " + S.setup.identityNeeded],
    [0, true, S.setup.notReady],
    [1, false, S.setup.identityNeeded],
    [2, false, S.setup.identityNeeded],
    [1, true, S.setup.oneReady.replace("{tool}", S.setup.claude)],
    [2, true, S.setup.ready],
  ])("Setup reports what is needed with %s working services and identity ready %s", async (count, identityReady, expected) => {
    let tree: any[] = [];
    const tools = ["claude", "codex"].map((tool, index) => ({ tool, installed: index < count, signedIn: index < count }));
    const capture = (spec: string, props: any, ...kids: any[]) => ({ spec, props, kids: kids.flat(Infinity).filter(Boolean) });
    const { profile } = runtime({ profileReturn: "#/", document: { createElementNS: () => ({ setAttribute() {}, append() {} }), querySelector: () => ({ namespaceURI: "svg" }) },
      messages: new Map(), setupState: { tools, ready: count > 0, identityReady },
      overrides: { h: capture, render: (_seq: number, ...kids: any[]) => { tree = kids; },
        api: async () => ({ identity: { name: "", email: "" } }) } });
    await profile(1, "setup");
    const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object" ? [node, ...nodes(node.kids || [])] : [];
    const all = nodes(tree);
    expect(all.find((node) => node.props?.["data-testid"] === "setup-status").props.text).toBe(expected);
    if (!identityReady || !count) {
      expect(all.some((node) => node.props?.text === S.setup.ready)).toBe(false);
      expect(all.some((node) => node.props?.text?.startsWith("Codec is usable"))).toBe(false);
    }
  });

  it.each(["setup-continue", "setup-skip"])("%s finishes setup through the authenticated settings API", async (id) => {
    let tree: any[] = [];
    const location = { hash: "#/setup" };
    const api = vi.fn(async () => ({ identity: { name: "", email: "" } }));
    const capture = (spec: string, props: any, ...kids: any[]) => ({ spec, props, kids: kids.flat(Infinity).filter(Boolean) });
    const { profile } = runtime({ location, profileReturn: "#/", document: { createElementNS: () => ({ setAttribute() {}, append() {} }), querySelector: () => ({ namespaceURI: "svg" }) },
      messages: new Map(), setupState: { tools: [], ready: true },
      overrides: { h: capture, render: (_seq: number, ...kids: any[]) => { tree = kids; }, api,
        act: async (_key: string, _trigger: unknown, action: () => Promise<void>) => action() } });
    await profile(1, "setup");
    const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object" ? [node, ...nodes(node.kids || [])] : [];
    const action = nodes(tree).find((node) => node.props?.["data-testid"] === id);
    await action.props.onclick({ currentTarget: {} });
    expect(api).toHaveBeenLastCalledWith("settings", { setupFinished: true });
    expect(location.hash).toBe("#/");
    expect(page).toContain('if (setupState.shouldOpen && location.hash !== "#/profile/setup")');
  });

  it.each([
    ["unsaved", S.tasks.unsaved], ["no_changes", S.tasks.noChanges], ["unavailable", S.tasks.workspaceUnchecked],
  ])("shows the %s task status", (reviewStatus, expected) => {
    const { stateText } = runtime();
    expect(stateText({ state: "done", reviewStatus })).toBe(expected);
  });

  it("shows the saved checkpoint note and unsaved work instructions on the task page", async () => {
    let tree: any[] = [];
    const record = { runId: "run-save", project: "site", task: "Check", agent: "codex", state: "done", autoSaved: true,
      reviewStatus: "unsaved", skillsGiven: [], skillsUsed: [] };
    const capture = (spec: string, props: any, ...kids: any[]) => ({ spec, props, kids: kids.flat(Infinity).filter(Boolean) });
    const { run } = runtime({ messages: new Map(), enc: encodeURIComponent, overrides: { h: capture,
      render: (_seq: number, ...kids: any[]) => { tree = kids; }, api: async () => record } });
    await run(1, record.runId);
    expect(tree).toContainEqual(expect.objectContaining({ props: { "data-testid": "task-auto-saved", text: S.tasks.autoSaved } }));
    expect(tree).toContainEqual(expect.objectContaining({ props: { "data-testid": "task-unsaved", text: S.tasks.unsavedHelp } }));
  });

  it("keeps technical labels whole and names where retained roles and skills live", () => {
    expect(page).toContain(".kv div:nth-child(odd) { color: var(--muted); word-break: normal;");
    expect(page).toContain(".kv div { word-break: break-all; }");
    expect(S.wording.rolesKept).toBe("Roles stay on the Roles page. Skills stay in your skills.");
    expect(S.wording.roleKept).toContain("Roles page");
    const capture = (spec: string, props: any) => ({ spec, props });
    const { messageContent } = runtime({ overrides: { h: capture } });
    expect(messageContent("task", { text: S.errors.identity_missing, error: { code: "identity_missing" } }))
      .toContainEqual({ spec: "a.link", props: { href: "#/profile/setup", text: S.nav.setup } });
  });

  it("uses the exact plain labels, explainers and tooltips", () => {
    expect(S.nav.specialists).toBe("Roles");
    expect(S.tasks.inReview).toBe("Ready to review");
    expect(S.common.tool).toBe("AI service");
    expect(S.tasks.output).toBe("Activity (latest 200 lines)");
    expect(S.wording.workspace).toContain("so your own files aren't touched");
    expect(S.wording.skillsIntro).toBe("Skills are instructions a helper can follow for a specific job.");
    expect(S.wording.usesRole).toBe("Uses the {name} role ({specialty})");
    expect(S.wording.originalKept).toContain("not touched");
    expect(page).toContain(S.wording.memoryHint);
    for (const legacy of [/\bagent\b/i, /\bspecialist\b/i, /\bclone\b/i, /\bworktree\b/i, /\btoken\b/i, /\brepository\b/i]) {
      const visibleWords = JSON.stringify(S);
      expect(visibleWords.replace(/"\w+":/g, "")).not.toMatch(legacy);
    }
  });
});


describe("error support details", () => {
  it("copies the log path and timestamp", async () => {
    const clipboard = { writeText: vi.fn(async () => {}) };
    const tell = vi.fn();
    const capture = (spec: string, props: any, ...kids: any[]) => ({ spec, props, kids });
    const api = vi.fn(async () => ({ logPath: "/codec/codec.log", time: "2026-10-27T00:00:00Z" }));
    const { messageContent } = runtime({ navigator: { clipboard }, overrides: { h: capture, api, tell } });
    const nodes = messageContent("connection", { text: S.errors.unknown_error, error: { code: "unknown_error" } });
    const copy = nodes.find((node: any) => node?.props?.["data-testid"] === "copy-details");
    await copy.props.onclick();
    expect(clipboard.writeText).toHaveBeenCalledWith("/codec/codec.log\n2026-10-27T00:00:00Z");
  });
  it("names the project a skill came with", () => {
    const { sourceText } = runtime();
    expect(sourceText({ source: "project" }, "website")).toBe("Comes with the project (website)");
  });
});

describe("Accounts controls", () => {
  const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object" ? [node, ...nodes(node.kids || [])] : [];
  const capture = (spec: string, props: any, ...kids: any[]) => ({ spec, props, kids: kids.flat(Infinity).filter((kid) => kid != null && kid !== false) });
  it("shows the task's saved account name and the exact limit message with an Accounts action", async () => {
    let tree: any[] = [];
    const record = { runId: "run-account", project: "site", task: "Check", agent: "claude", state: "done", cleanedAt: "today",
      account: { id: "private-id", name: "Work Claude" }, limitHit: true, skillsGiven: [], skillsUsed: [] };
    const { run } = runtime({ messages: new Map(), enc: encodeURIComponent,
      overrides: { h: capture, render: (_seq: number, ...kids: any[]) => { tree = kids; }, api: async () => record } });
    await run(1, record.runId);
    const all = nodes(tree);
    expect(all.some((n) => n.props?.text === "Work Claude")).toBe(true);
    const banner = all.find((n) => n.props?.["data-testid"] === "task-account-limit");
    expect(nodes(banner).some((n) => n.props?.text === "This account hit its limit. Switch accounts?")).toBe(true);
    expect(nodes(banner).find((n) => n.props?.href === "#/accounts").props.text).toBe(S.accounts.open);
    expect(JSON.stringify(tree)).not.toContain("private-id");
  });
  it.each(["helper", "team", "project"])("%s dropdown offers accounts for the same service and saves a manual choice", async (scope) => {
    const api = vi.fn(async () => ({}));
    const { accountPicker } = runtime({ enc: encodeURIComponent, messages: new Map(),
      accountsState: { choices: { [scope + ":web"]: { claude: "work" } }, defaults: {},
        accounts: [{ id: "work", kind: "claude", name: "Work" }, { id: "other", kind: "codex", name: "Codex" }] },
      overrides: { h: capture, api, act: async (_key: string, _trigger: unknown, action: () => Promise<void>) => action() } });
    const picker = accountPicker(scope, "web", "claude"), all = nodes(picker), select = all.find((n) => n.spec === "select");
    expect(select.value).toBe("work");
    expect(all.some((n) => n.props?.text === S.accounts.useDefault)).toBe(true);
    expect(all.some((n) => n.props?.text === "Codex")).toBe(false);
    expect(api).not.toHaveBeenCalled();
    await select.props.onchange({ currentTarget: { value: "" } });
    expect(api).toHaveBeenCalledExactlyOnceWith("account-settings", { scope, name: "web", kind: "claude", accountId: "" });
  });
  it("opens sign-in links in a separate browser tab and shows cancel and device-code instructions", () => {
    const url = "https://auth.openai.com/codex/device";
    const { loginDetails } = runtime({ enc: encodeURIComponent, messages: new Map(), overrides: { h: capture } });
    const tree = loginDetails({ id: "work", login: { state: "waiting", url, code: "ABCD-EFGH" } }), all = nodes(tree);
    expect(all.find((n) => n.props?.["data-testid"] === "account-open-sign-in").props).toMatchObject({ href: url, target: "_blank", rel: "noopener noreferrer", referrerpolicy: "no-referrer", text: S.accounts.openSignIn });
    expect(all.find((n) => n.props?.["data-testid"] === "account-device-code").props.text).toBe("ABCD-EFGH");
    expect(all.some((n) => n.props?.["data-testid"] === "account-cancel")).toBe(true);
  });
  it("removes an account only after the in-page confirmation", async () => {
    let tree: any[] = [], confirm: (() => Promise<void>) | undefined;
    const state = { accounts: [{ id: "work", name: "Work", kind: "claude", status: "signed_in" }], defaults: { claude: "work" }, choices: {} };
    const api = vi.fn(async () => state);
    const { accounts } = runtime({ accountsState: state, enc: encodeURIComponent, messages: new Map(), overrides: { h: capture, api,
      render: (_seq: number, ...kids: any[]) => { tree = kids; }, showDialog: (_title: string, effects: string[], _blocked: unknown, action: () => Promise<void>) => {
        expect(effects).toEqual([S.accounts.removeEffect]); confirm = action;
      } } });
    await accounts(1); nodes(tree).find((n) => n.props?.["data-testid"] === "account-remove").props.onclick();
    expect(api).toHaveBeenCalledTimes(1); expect(confirm).toBeDefined(); await confirm!();
    expect(api).toHaveBeenLastCalledWith("accounts/work/remove", { confirmed: true });
  });
  it("excludes pasted sign-in codes from refresh snapshots", () => {
    const secret = { id: "code", type: "password", value: "synthetic-code#state" }, normal = { id: "name", type: "text", value: "Work" };
    const app = { contains: () => false, querySelector: () => null, querySelectorAll: (query: string) => query === "input[id], textarea[id], select[id]" ? [secret, normal] : [] };
    const { snapshot } = runtime({ app, document: { activeElement: null }, window: { scrollY: 0 } });
    expect(snapshot().fields).toEqual([{ id: "name", value: "Work", checked: undefined }]);
  });
});
