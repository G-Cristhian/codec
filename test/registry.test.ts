import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { addProject, getProject, listProjects, removeProject } from "../src/registry.js";
import { readEvents } from "../src/events.js";
import { cleanupTemps, makeRepo, tempDir, useIsolatedHome } from "./helpers.js";

describe("project registry", () => {
  beforeEach(() => useIsolatedHome("true"));
  afterEach(cleanupTemps);

  it("adds, lists and removes projects", () => {
    const a = makeRepo("alpha");
    const b = makeRepo("beta");
    addProject(a);
    addProject(b, "custom-beta");
    expect(listProjects().map((p) => p.name)).toEqual(["alpha", "custom-beta"]);
    expect(getProject("alpha")!.path).toBe(a);

    removeProject("alpha");
    expect(listProjects().map((p) => p.name)).toEqual(["custom-beta"]);
    expect(readEvents().map((e) => e.kind)).toEqual(["project.add", "project.add", "project.remove"]);
  });

  it("resolves a subdirectory to the repository top level", () => {
    const repo = makeRepo("gamma");
    mkdirSync(join(repo, "src"));
    expect(addProject(join(repo, "src")).path).toBe(repo);
  });

  it("rejects duplicates, bad names, non-repos and empty repos", () => {
    const repo = makeRepo("delta");
    addProject(repo);
    expect(() => addProject(makeRepo("delta"))).toThrow(/already exists/);
    expect(() => addProject(repo, "other")).toThrow(/already registered/);
    expect(() => addProject(makeRepo("x"), "bad name!")).toThrow(/invalid project name/);
    expect(() => addProject(tempDir())).toThrow(/not a git repository/);
    const empty = tempDir();
    execFileSync("git", ["init", "-q", empty]);
    expect(() => addProject(empty)).toThrow(/no commits/);
    expect(() => removeProject("nope")).toThrow(/no project/);
  });

  it("persists across module state (it lives on disk)", () => {
    addProject(makeRepo("eps"));
    // Nothing is cached in memory; a fresh read sees the same list.
    expect(listProjects()).toHaveLength(1);
  });
});
