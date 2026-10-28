import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { isGitRepo, listFolders, setUpTracking } from "../src/folders.js";
import { cleanupTemps, makeRepo, tempDir, useIsolatedHome } from "./helpers.js";

const git = (path: string, ...args: string[]) => execFileSync("git", ["-C", path, ...args], { encoding: "utf-8" }).trim();
beforeEach(() => useIsolatedHome("true"));
afterEach(() => { vi.unstubAllEnvs(); cleanupTemps(); });

describe("folder browser", () => {
  it("lists sorted visible folders, their git and skill markers, and parent", () => {
    const root = tempDir();
    for (const name of ["zeta", "alpha", ".hidden"]) mkdirSync(join(root, name));
    writeFileSync(join(root, "alpha", "SKILL.md"), "skill");
    writeFileSync(join(root, "file.txt"), "file");
    execFileSync("git", ["init", "-q", join(root, "zeta")]);
    symlinkSync(join(root, "missing"), join(root, "broken"));
    expect(listFolders(root)).toEqual({ path: root, parent: join(root, ".."), isGit: false, hasSkill: false,
      folders: [{ name: "alpha", path: join(root, "alpha"), isGit: false, hasSkill: true }, { name: "zeta", path: join(root, "zeta"), isGit: true, hasSkill: false }] });
    expect(listFolders(join(root, "zeta")).isGit).toBe(true);
  });
  it("uses home by default and has no parent at filesystem root", () => {
    expect(listFolders().path).toBe(homedir());
    expect(listFolders("/").parent).toBeNull();
  });
  it("rejects relative paths and reports missing folders or files", () => {
    expect(() => listFolders("relative")).toThrow("full path");
    expect(() => setUpTracking("relative")).toThrow("full path");
    expect(isGitRepo("relative")).toBe(false);
    const dir = tempDir();
    expect(() => listFolders(join(dir, "missing"))).toThrow(expect.objectContaining({ code: "folder_not_found" }));
    const file = join(dir, "file");
    writeFileSync(file, "file");
    expect(() => listFolders(file)).toThrow(expect.objectContaining({ code: "not_a_folder" }));
  });
  it("skips unreadable children", () => {
    const root = tempDir();
    const child = join(root, "private");
    mkdirSync(child);
    chmodSync(child, 0o000);
    try {
      if (process.getuid?.() !== 0) expect(listFolders(root).folders).toEqual([]);
    } finally { chmodSync(child, 0o700); }
  });
  it("treats shell metacharacters as literal folder names", () => {
    const dir = join(tempDir(), "project; touch INJECTED");
    mkdirSync(dir);
    setUpTracking(dir);
    expect(isGitRepo(dir)).toBe(true);
    expect(existsSync(join(dir, "INJECTED"))).toBe(false);
  });
});

describe("tracking setup", () => {
  function noIdentity() {
    vi.stubEnv("GIT_CONFIG_GLOBAL", join(tempDir(), "no-global-config"));
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    for (const name of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) vi.stubEnv(name, "");
  }
  it("includes existing files in the first checkpoint using fallback identity without persisting it", () => {
    noIdentity();
    // Unset identity variables so git may use its normal config fallback.
    for (const name of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) delete process.env[name];
    const dir = tempDir();
    writeFileSync(join(dir, "important.txt"), "keep me");
    setUpTracking(dir);
    expect(git(dir, "log", "-1", "--format=%an <%ae>")).toBe("Codec <codec@localhost>");
    expect(git(dir, "ls-tree", "--name-only", "HEAD")).toBe("important.txt");
    expect(readFileSync(join(dir, "important.txt"), "utf-8")).toBe("keep me");
    expect(readFileSync(join(dir, ".git", "config"), "utf-8")).not.toMatch(/Codec|codec@localhost/);
    const worktree = join(tempDir(), "worktree");
    git(dir, "worktree", "add", "-q", "-b", "test", worktree);
    expect(statSync(worktree).isDirectory()).toBe(true);
    expect(readFileSync(join(worktree, "important.txt"), "utf-8")).toBe("keep me");
  });
  it("uses existing repo identity, includes staged files in the first checkpoint, and is idempotent", () => {
    const dir = tempDir();
    git(dir, "init", "-q");
    git(dir, "config", "user.name", "Existing Person");
    git(dir, "config", "user.email", "existing@example.invalid");
    writeFileSync(join(dir, "staged.txt"), "staged");
    git(dir, "add", "staged.txt");
    setUpTracking(dir);
    const head = git(dir, "rev-parse", "HEAD");
    expect(git(dir, "log", "-1", "--format=%an <%ae>")).toBe("Existing Person <existing@example.invalid>");
    expect(git(dir, "ls-tree", "--name-only", "HEAD")).toBe("staged.txt");
    expect(git(dir, "diff", "--cached", "--name-only")).toBe("");
    setUpTracking(dir);
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
  });
  it("uses global identity without writing it into local config", () => {
    const config = join(tempDir(), "gitconfig");
    writeFileSync(config, '[user]\n name = Global Person\n email = global@example.invalid\n');
    vi.stubEnv("GIT_CONFIG_GLOBAL", config);
    const dir = tempDir();
    setUpTracking(dir);
    expect(git(dir, "log", "-1", "--format=%an <%ae>")).toBe("Global Person <global@example.invalid>");
    expect(readFileSync(join(dir, ".git", "config"), "utf-8")).not.toContain("Global Person");
  });
  it("leaves a committed repo unchanged", () => {
    const dir = makeRepo();
    const head = git(dir, "rev-parse", "HEAD");
    setUpTracking(dir);
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
  });
});

describe("first saved checkpoint contents", () => {
  it("saves an empty folder as an empty checkpoint", () => {
    const dir = tempDir();
    setUpTracking(dir);
    expect(git(dir, "rev-list", "--count", "HEAD")).toBe("1");
    expect(git(dir, "ls-tree", "--name-only", "HEAD")).toBe("");
    expect(git(dir, "status", "--porcelain")).toBe("");
  });
  it("respects .gitignore and includes existing nested and dot files", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "main.txt"), "existing source");
    writeFileSync(join(dir, ".settings"), "existing settings");
    writeFileSync(join(dir, ".gitignore"), "secret.txt\n");
    writeFileSync(join(dir, "secret.txt"), "keep outside checkpoint");
    setUpTracking(dir);
    expect(git(dir, "ls-tree", "-r", "--name-only", "HEAD").split("\n")).toEqual([".gitignore", ".settings", "src/main.txt"]);
    expect(readFileSync(join(dir, "secret.txt"), "utf-8")).toBe("keep outside checkpoint");
    const workspace = join(tempDir(), "workspace");
    git(dir, "worktree", "add", "-q", "-b", "first-task", workspace);
    expect(readFileSync(join(workspace, "src", "main.txt"), "utf-8")).toBe("existing source");
    expect(existsSync(join(workspace, "secret.txt"))).toBe(false);
  });
});
