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
    removeItem, showDialog, folderPicker, render, replace, messageContent, stateText, run, setup, projectAddForm, skillAddForm, skillUploadForm
  };`)(...Object.values(params));
}
describe("dashboard wording and structure", () => {
  it("injects the complete wording object as JSON", () => {
    const injected = scripts[1].match(/const S = (.*);\nconst TOKEN/);
    expect(injected).not.toBeNull();
    expect(JSON.parse(injected![1])).toEqual(S);
    expect(renderLocked()).toContain(S.locked.hint);
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
    const { setup } = runtime({ messages: new Map(), setupState: { tools: [], ready: true, identityReady: false },
      overrides: { h: capture, render: (_seq: number, ...kids: any[]) => { tree = kids; }, api,
        act: async (_key: string, _trigger: unknown, action: () => Promise<void>) => { await action(); } } });
    await setup(1);
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

  it("keeps technical labels whole and names where retained roles and skills live", () => {
    expect(page).toContain(".kv div:nth-child(odd) { color: var(--muted); word-break: normal;");
    expect(page).toContain(".kv div { word-break: break-all; }");
    expect(S.wording.rolesKept).toBe("Roles stay on the Roles page. Skills stay in your skills.");
    expect(S.wording.roleKept).toContain("Roles page");
    const capture = (spec: string, props: any) => ({ spec, props });
    const { messageContent } = runtime({ overrides: { h: capture } });
    expect(messageContent("task", { text: S.errors.identity_missing, error: { code: "identity_missing" } }))
      .toContainEqual({ spec: "a.link", props: { href: "#/setup", text: S.nav.setup } });
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
