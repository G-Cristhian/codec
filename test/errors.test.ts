import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodecError, suggestName } from "../src/errors.js";
import { friendlyError } from "../src/friendly.js";
import { PROJECT_NAME_RE } from "../src/registry.js";
import { SKILL_NAME_RE } from "../src/skills.js";
import { S, wording, type ErrorCode } from "../src/strings.js";
import { cleanupTemps, useIsolatedHome } from "./helpers.js";

beforeEach(() => useIsolatedHome("true"));
afterEach(cleanupTemps);
const params = { name: "website", member: "tester", team: "web", project: "site", count: 2, list: "tester, writer", path: "/selected/project", field: "description" };

describe("coded errors", () => {
  for (const code of Object.keys(S.errors) as ErrorCode[]) {
    it(`${code} has a plain API fallback independent of technical detail`, () => {
      const { status, body } = friendlyError(new CodecError(code, "EIO: private-stack exit 127", params), "/api/example");
      expect(status).toBe(400);
      expect(body).toEqual({ code, error: wording(S.errors[code], params), params });
      expect(body.error).not.toMatch(/private-stack|EIO|exit 127|\{\w+\}/);
      expect(body.error.length).toBeGreaterThan(15);
    });
  }
  it("every code explicitly emitted by the engine or API has wording", () => {
    const sources = readdirSync(new URL("../src/", import.meta.url)).filter((f) => f.endsWith(".ts") && f !== "strings.ts")
      .map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf-8")).join("\n");
    const emitted = [...sources.matchAll(/new (?:CodecError|ApiError)\((?:\d+,\s*)?["']([a-z_]+)["']/g)].map((m) => m[1]);
    expect(new Set(emitted).size).toBeGreaterThan(45);
    for (const code of emitted) expect(Object.hasOwn(S.errors, code), code).toBe(true);
    // These are the only dynamic code sites, selected from typed values.
    for (const code of ["project_busy", "team_busy", "member_busy", "missing_task", "missing_path"]) expect(Object.hasOwn(S.errors, code)).toBe(true);
  });
  it("has no matching against error message text, including command stderr", () => {
    const forbidden = [
      /\.(?:includes|match|matchAll|search|startsWith|endsWith)\([^\n]*(?:\.message|\.err\b)/,
      /(?:\.message|\.err\b)\s*\.(?:includes|match|matchAll|search|startsWith|endsWith)/,
      /\.(?:test|exec)\([^\n]*(?:\.message|\.err\b)/,
      /new RegExp\([^\n]*\.message/,
      /const\s+\w+\s*=\s*\w+\s+instanceof Error\s*\?\s*\w+\.message/,
    ];
    for (const file of readdirSync(new URL("../src/", import.meta.url)).filter((f) => f.endsWith(".ts"))) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf-8");
      for (const pattern of forbidden) expect(source, `${file}: ${pattern}`).not.toMatch(pattern);
      if (!["ui.ts", "cli.ts"].includes(file)) expect(source, file).not.toContain("new Error(");
    }
  });
  it("logs status, stack, technical detail and causes without exposing them", () => {
    const error = new CodecError("workspace_failed", "private workspace detail", {}, 409, undefined, { cause: new Error("private cause") });
    const result = friendlyError(error, "/api/runs/test");
    expect(result.status).toBe(409);
    expect(result.body.error).not.toContain("private");
    const log = JSON.parse(readFileSync(join(process.env.CODEC_HOME!, "codec.log"), "utf-8"));
    expect(log).toMatchObject({ code: "workspace_failed", status: 409, route: "/api/runs/test", ts: expect.any(String) });
    expect(log.detail).toContain("private workspace detail");
    expect(log.detail).toContain("private cause");
    expect(log.detail).toContain("at ");
  });
});

describe("name suggestions", () => {
  it.each([
    ["My Project!", "my-project"], ["   Nice   Team   ", "nice-team"], ["@@@", "helper"],
    ["..Example_1", "example_1"], ["A/B$C", "abc"], ["a".repeat(100), "a".repeat(64)],
  ])("derives a valid lowercase name from %s", (input, expected) => {
    expect(suggestName(input)).toBe(expected);
    expect(PROJECT_NAME_RE.test(suggestName(input))).toBe(true);
  });
  it("selects an unused suffix and trims to make room for it", () => {
    expect(suggestName("My Project!", ["my-project", "my-project-2"])).toBe("my-project-3");
    const input = "x".repeat(90);
    const taken = ["x".repeat(64), "x".repeat(62) + "-2"];
    expect(suggestName(input, taken)).toBe("x".repeat(62) + "-3");
  });
  it.each(["MY Skill...!", "---", "My_Skill", "x".repeat(63) + "---", "## Unicode 😃"])("uses skill-specific rules for %s", (input) => {
    const candidate = suggestName(input, [], true);
    expect(SKILL_NAME_RE.test(candidate)).toBe(true);
    expect(candidate).toBe(candidate.toLowerCase());
    expect(suggestName(input, [candidate, candidate.slice(0, 62) + "-2"], true)).not.toBe(candidate);
  });
});
