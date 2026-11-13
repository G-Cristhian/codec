import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { request } from "http";
import { addProject } from "../src/registry.js";
import {
  addMember,
  addSpecialist,
  addTeam,
  clonesOf,
  editSpecialist,
  listSpecialists,
  listTeams,
  removeSkillEverywhere,
  removeSpecialist,
  resolveMember,
  setTeamProjects,
  skillHolders,
} from "../src/org.js";
import { importSkill, importSkillFiles, listSkills, parseFrontmatter, validateSkillFolder } from "../src/skills.js";
import { addExcludes, injectSkills } from "../src/inject.js";
import {
  findRun,
  listRuns,
  removeMemberChecked,
  removeProjectChecked,
  removeTeamChecked,
  runOutput,
  skillsUsed,
  startRun,
  stopRun,
} from "../src/runs.js";
import { renderClaudeStream, skillCallsFromClaudeStream } from "../src/claude-stream.js";
import { startDashboard, type Dashboard } from "../src/dashboard.js";
import { cleanupTemps, cli, makeRepo, tempDir, useIsolatedHome, waitFor } from "./helpers.js";

const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf-8" });

function makeSkill(name: string, description = `the ${name} skill`, body = "Do the thing.\n", extra: Record<string, string> = {}): string {
  const dir = join(tempDir("codec-skill-"), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`);
  for (const [f, c] of Object.entries(extra)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), c);
  }
  return dir;
}

/** Org with project "alpha", skills s1/s2/s3, specialist "tester" (claude, s1), team "red". */
function setupOrg() {
  const repo = makeRepo("alpha");
  addProject(repo);
  importSkill(makeSkill("s1"));
  importSkill(makeSkill("s2"));
  importSkill(makeSkill("s3"));
  addSpecialist({ name: "tester", specialty: "QA tester", tool: "claude", instructions: "Always test.", skills: ["s1"] });
  addTeam({ name: "red", projects: ["alpha"] });
  return repo;
}

describe("skills library", () => {
  beforeEach(() => useIsolatedHome("true"));
  afterEach(() => cleanupTemps());

  it("parses frontmatter including block values and quotes", () => {
    expect(parseFrontmatter(`---\nname: x\ndescription: "a: b"\n---\nbody`)).toMatchObject({ name: "x", description: "a: b" });
    expect(parseFrontmatter(`---\nname: x\ndescription: |\n  line one\n  line two\n---\n`).description).toContain("line one");
  });

  it("validates skill folders", () => {
    const empty = tempDir();
    expect(() => validateSkillFolder(empty)).toThrow(/SKILL\.md/);
    const noDesc = tempDir();
    writeFileSync(join(noDesc, "SKILL.md"), `---\nname: x\n---\nhi`);
    expect(() => validateSkillFolder(noDesc)).toThrow(/description/);
    const noFront = tempDir();
    writeFileSync(join(noFront, "SKILL.md"), `just text`);
    expect(() => validateSkillFolder(noFront)).toThrow();
    const badName = makeSkill("Bad_Name");
    expect(() => validateSkillFolder(badName)).toThrow(/name/);
    const link = makeSkill("linky");
    symlinkSync("/etc/hostname", join(link, "evil"));
    expect(() => validateSkillFolder(link)).toThrow(/symlink|link/i);
  });

  it("imports, lists, rejects duplicates, copies extra files", () => {
    const sk = importSkill(makeSkill("helper", "helps", "body", { "scripts/run.sh": "echo hi" }));
    expect(sk.name).toBe("helper");
    expect(listSkills().map((s) => s.name)).toEqual(["helper"]);
    expect(existsSync(join(process.env.CODEC_HOME!, "skills", "helper", "scripts", "run.sh"))).toBe(true);
    expect(() => importSkill(makeSkill("helper"))).toThrow(/already exists/);
  });

  it("imports an uploaded folder and refuses path traversal", () => {
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    const sk = importSkillFiles(
      [
        { path: "up/SKILL.md", content: b64(`---\nname: uploaded\ndescription: from the browser\n---\nx`) },
        { path: "up/ref/notes.md", content: b64("notes") },
      ],
      tempDir(),
    );
    expect(sk.name).toBe("uploaded");
    expect(sk.files.sort()).toEqual(["SKILL.md", "ref/notes.md"]);
    expect(() =>
      importSkillFiles([{ path: "../../evil/SKILL.md", content: b64("x") }, { path: "a/b", content: b64("x") }], tempDir()),
    ).toThrow(/invalid file path/);
  });
});

describe("specialists, teams, members", () => {
  beforeEach(() => useIsolatedHome("true"));
  afterEach(() => cleanupTemps());

  it("creates, edits and deletes specialists", () => {
    setupOrg();
    expect(() => addSpecialist({ name: "tester", specialty: "x", tool: "claude" })).toThrow(/already/);
    expect(() => addSpecialist({ name: "nope", specialty: "x", tool: "gpt" })).toThrow(/unknown tool/);
    expect(() => addSpecialist({ name: "nope", specialty: "x", tool: "claude", skills: ["missing"] })).toThrow(/missing/);
    expect(() => addSpecialist({ name: "nope", tool: "claude" })).toThrow(/specialty/);
    const e = editSpecialist("tester", { model: "opus", skills: ["s1", "s2"], instructions: "New." });
    expect(e).toMatchObject({ model: "opus", skills: ["s1", "s2"], instructions: "New.", specialty: "QA tester" });
    removeSpecialist("tester");
    expect(listSpecialists()).toEqual([]);
  });

  it("clones follow their specialist and keep their own extra skills", () => {
    setupOrg();
    const c = addMember("red", { specialist: "tester", skills: ["s3"] });
    expect(c.name).toBe("tester-1");
    const c2 = addMember("red", { specialist: "tester", name: "tester-2" });
    const w = addMember("red", { tool: "codex", skills: ["s2"] });
    expect(w.name).toBe("codex-worker-1");
    expect(() => addMember("red", { name: "tester-2", specialist: "tester" })).toThrow(/already/);
    expect(() => addMember("red", { specialist: "ghost" })).toThrow(/ghost/);
    expect(() => addMember("red", {})).toThrow();
    expect(clonesOf("tester")).toEqual([
      { team: "red", member: "tester-1" },
      { team: "red", member: c2.name },
    ]);

    let r = resolveMember("red", "tester-1");
    expect(r).toMatchObject({ kind: "clone", specialist: "tester", tool: "claude", instructions: "Always test." });
    expect(r.skills).toEqual([
      { name: "s1", source: "specialist" },
      { name: "s3", source: "member" },
    ]);
    editSpecialist("tester", { skills: ["s2"], instructions: "Changed." });
    r = resolveMember("red", "tester-1");
    expect(r.instructions).toBe("Changed.");
    expect(r.skills.map((s) => s.name)).toEqual(["s2", "s3"]);
    expect(resolveMember("red", w.name)).toMatchObject({ kind: "worker", tool: "codex", skills: [{ name: "s2", source: "member" }] });

    expect(skillHolders("s2")).toEqual({ specialists: ["tester"], members: ["red/codex-worker-1"] });
  });

  it("refuses to delete a specialist that still has clones", () => {
    setupOrg();
    addMember("red", { specialist: "tester" });
    expect(() => removeSpecialist("tester")).toThrow(/clone/);
    removeMemberChecked("red", "tester-1");
    expect(removeSpecialist("tester").name).toBe("tester");
  });

  it("teams may start without projects but only list real ones; removing a project drops it from teams", () => {
    setupOrg();
    expect(addTeam({ name: "blue", projects: [] }).projects).toEqual([]);
    expect(setTeamProjects("blue", []).projects).toEqual([]);
    expect(() => addTeam({ name: "blue", projects: ["ghost"] })).toThrow(/ghost/);
    expect(() => addTeam({ name: "red", projects: ["alpha"] })).toThrow(/already/);
    addProject(makeRepo("beta"));
    expect(setTeamProjects("red", ["alpha", "beta"]).projects).toEqual(["alpha", "beta"]);
    removeProjectChecked("beta");
    expect(listTeams()[0].projects).toEqual(["alpha"]);
  });

  it("removing a skill unassigns it everywhere", () => {
    setupOrg();
    addMember("red", { specialist: "tester", skills: ["s1", "s3"] });
    const h = removeSkillEverywhere("s1");
    expect(h.specialists).toEqual(["tester"]);
    expect(h.members).toEqual(["red/tester-1"]);
    expect(listSkills().map((s) => s.name)).toEqual(["s2", "s3"]);
    expect(resolveMember("red", "tester-1").skills).toEqual([{ name: "s3", source: "member" }]);
    expect(() => removeSkillEverywhere("s1")).toThrow(/no skill/);
  });
});

describe("runs with team members", () => {
  afterEach(() => {
    for (const r of listRuns({ state: "running" })) stopRun(r.runId);
    cleanupTemps();
  });

  it("only team members of a project's teams can run there", () => {
    useIsolatedHome("true");
    setupOrg();
    addProject(makeRepo("beta"));
    addMember("red", { specialist: "tester" });
    expect(() => startRun({ project: "beta", member: "red/tester-1", task: "x" })).toThrow(/doesn't work on beta/);
    expect(() => startRun({ project: "alpha", member: "red/ghost", task: "x" })).toThrow(/ghost/);
    expect(() => startRun({ project: "alpha", member: "red/tester-1", agent: "codex", task: "x" })).toThrow();
    expect(() => startRun({ project: "alpha", task: "x" })).toThrow(/--member/);
  });

  it("refuses to remove a working member or its team, in the engine", async () => {
    useIsolatedHome("sleep 30");
    setupOrg();
    addMember("red", { specialist: "tester" });
    const run = startRun({ project: "alpha", member: "red/tester-1", task: "x" });
    expect(() => removeMemberChecked("red", "tester-1")).toThrow(/running/);
    expect(() => removeTeamChecked("red")).toThrow(/running/);
    stopRun(run.runId);
    removeTeamChecked("red");
    expect(listTeams()).toEqual([]);
  });

  for (const tool of ["claude", "codex"] as const) {
    it(`${tool}: instruction files require applicable skills first, with names, descriptions and role wording`, async () => {
      useIsolatedHome("true");
      setupOrg();
      editSpecialist("tester", { tool });
      addMember("red", { specialist: "tester", skills: ["s3"] });
      const run = startRun({ project: "alpha", member: "red/tester-1", task: "test" });
      await waitFor(run.runId);
      const dir = join(process.env.CODEC_HOME!, "runs", run.runId);
      const instructions = readFileSync(join(dir, "instructions.md"), "utf-8");
      expect(JSON.parse(readFileSync(join(dir, "instructions.toml"), "utf-8"))).toBe(instructions);
      expect(instructions).toContain("Before doing anything else");
      expect(instructions).toContain("every");
      expect(instructions).toContain("could apply to this task and follow it");
      expect(instructions).toContain("override your default habits for file content and naming");
      expect(instructions).toContain("s1: the s1 skill");
      expect(instructions).toContain("s3: the s3 skill");
      expect(instructions).toContain("tester-1 uses the tester role");
      expect(instructions).not.toMatch(/copy of|specialist/);
      expect(instructions.indexOf("Before doing anything else")).toBeLessThan(instructions.indexOf("Always test."));
      if (tool === "claude") expect(instructions).toContain("use the Skill tool");
      else for (const name of ["s1", "s3"]) expect(instructions).toContain(`.agents/skills/${name}/SKILL.md`);
    });
    it(`${tool}: omits the skills block when none are given, keeping role instructions`, async () => {
      useIsolatedHome("true");
      setupOrg();
      editSpecialist("tester", { tool, skills: [] });
      addMember("red", { specialist: "tester" });
      const run = startRun({ project: "alpha", member: "red/tester-1", task: "test" });
      await waitFor(run.runId);
      const dir = join(process.env.CODEC_HOME!, "runs", run.runId);
      const instructions = readFileSync(join(dir, "instructions.md"), "utf-8");
      expect(JSON.parse(readFileSync(join(dir, "instructions.toml"), "utf-8"))).toBe(instructions);
      expect(instructions).toContain("Always test.");
      expect(instructions).not.toMatch(/Skills given|Before doing anything else|SKILL.md|Skill tool/);
    });
    it(`${tool}: attribution instructions also apply to a quick helper without skills`, async () => {
      useIsolatedHome("true");
      setupOrg();
      const run = startRun({ project: "alpha", agent: tool, task: "test" });
      await waitFor(run.runId);
      const dir = join(process.env.CODEC_HOME!, "runs", run.runId);
      const instructions = readFileSync(join(dir, "instructions.md"), "utf-8");
      expect(instructions).toContain("do not add any Co-Authored-By or AI attribution lines");
      expect(JSON.parse(readFileSync(join(dir, "instructions.toml"), "utf-8"))).toBe(instructions);
    });
  }

  it("claude: injects only the member's skills, passes instructions, commits nothing injected", async () => {
    // The fake agent records what it sees, then commits everything it can.
    useIsolatedHome(
      `ls .claude/skills > seen.txt 2>&1; cat "$CODEC_RUN_DIR/instructions.md" > instr.txt; ` +
        `git add -A && git -c user.name=a -c user.email=a@b.c commit -qm agent-work; git show --name-only --format= HEAD`,
    );
    const repo = setupOrg();
    // The project already has a CLAUDE.md and a .gitignore; neither may change.
    writeFileSync(join(repo, "CLAUDE.md"), "# project rules\n");
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "project files");

    addMember("red", { specialist: "tester", skills: ["s3"] });
    const run = startRun({ project: "alpha", member: "red/tester-1", task: "test it" });
    const done = await waitFor(run.runId);
    expect(done.state).toBe("done");

    expect(readFileSync(join(run.worktree, "seen.txt"), "utf-8").trim().split("\n")).toEqual(["s1", "s3"]);
    expect(readFileSync(join(run.worktree, "instr.txt"), "utf-8")).toContain("Always test.");
    const committed = git(run.worktree, "show", "--name-only", "--format=", "HEAD").trim().split("\n");
    expect(committed.sort()).toEqual(["instr.txt", "seen.txt"]);
    expect(git(run.worktree, "status", "--porcelain").trim()).toBe("");
    expect(readFileSync(join(run.worktree, "CLAUDE.md"), "utf-8")).toBe("# project rules\n");
    expect(readFileSync(join(run.worktree, ".gitignore"), "utf-8")).toBe("node_modules/\n");

    const rec = findRun(run.runId);
    expect(rec).toMatchObject({ team: "red", member: "tester-1", specialist: "tester", agent: "claude" });
    expect(rec.skills).toEqual([
      { name: "s1", source: "specialist", description: "the s1 skill" },
      { name: "s3", source: "member", description: "the s3 skill" },
    ]);
  });

  it("codex: native .agents/skills, project skills reported and never overwritten", async () => {
    useIsolatedHome(`find .agents/skills -name SKILL.md | sort > seen.txt; git add -A; git status --porcelain > status.txt`);
    const repo = setupOrg();
    // The project ships its own skill named s2 plus another one.
    for (const n of ["s2", "house-style"]) {
      mkdirSync(join(repo, ".agents/skills", n), { recursive: true });
      writeFileSync(join(repo, ".agents/skills", n, "SKILL.md"), `---\nname: ${n}\ndescription: project ${n}\n---\nproject copy`);
    }
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "project skills");

    addMember("red", { tool: "codex", skills: ["s2", "s3"] });
    const run = startRun({ project: "alpha", member: "red/codex-worker-1", task: "x" });
    await waitFor(run.runId);
    expect(readFileSync(join(run.worktree, "seen.txt"), "utf-8").trim().split("\n")).toEqual([
      ".agents/skills/house-style/SKILL.md",
      ".agents/skills/s2/SKILL.md",
      ".agents/skills/s3/SKILL.md",
    ]);
    expect(readFileSync(join(run.worktree, ".agents/skills/s2/SKILL.md"), "utf-8")).toContain("project copy");
    // Only the agent's own files are staged; the injected s3 is invisible to git.
    const staged = readFileSync(join(run.worktree, "status.txt"), "utf-8");
    expect(staged).toContain("seen.txt");
    expect(staged).not.toContain("s3");
    const given = findRun(run.runId).skills!;
    expect(given.map((g) => [g.name, g.source])).toEqual([
      ["house-style", "project"],
      ["s2", "project"],
      ["s3", "member"],
    ]);
    expect(given.find((g) => g.name === "s2")!.note).toMatch(/project's own copy/);
  });

  it("keeps the exclude block idempotent and leaves other lines alone", () => {
    useIsolatedHome("true");
    const repo = makeRepo("x");
    const file = join(repo, ".git", "info", "exclude");
    writeFileSync(file, "# mine\n*.log\n");
    addExcludes(repo, ["/.claude/skills/a/"]);
    addExcludes(repo, ["/.claude/skills/a/", "/.claude/skills/b/"]);
    const text = readFileSync(file, "utf-8");
    expect(text.startsWith("# mine\n*.log\n")).toBe(true);
    expect(text.match(/\.claude\/skills\/a\//g)).toHaveLength(1);
    expect(text).toContain("/.claude/skills/b/");
    expect(text.match(/>>> codec/g)).toHaveLength(1);
  });

  it("injectSkills fails clearly when a library skill vanished", () => {
    useIsolatedHome("true");
    const repo = makeRepo("x");
    expect(() => injectSkills(repo, "claude", [{ name: "gone", source: "member" }])).toThrow(/no longer in the library/);
  });

  it("detects claude Skill calls from stream-json and renders readable logs", async () => {
    const lines = [
      { type: "system", subtype: "init", model: "claude-test" },
      { type: "assistant", message: { content: [{ type: "text", text: "Using a skill." }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "s1" } }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "a.txt" } }] } },
      { type: "result", duration_ms: 3000 },
    ];
    const raw = lines.map((l) => JSON.stringify(l)).join("\n");
    expect(skillCallsFromClaudeStream(raw)).toEqual(["s1"]);
    const text = renderClaudeStream(raw + "\nnot json\n");
    expect(text).toContain("[Claude started — AI model claude-test]");
    expect(text).toContain("→ Skill: s1");
    expect(text).toContain("→ Write: a.txt");
    expect(text).toContain("not json");

    useIsolatedHome(`printf '%s\\n' '${lines.map((l) => JSON.stringify(l)).join("' '")}'`);
    setupOrg();
    addMember("red", { specialist: "tester" });
    const run = startRun({ project: "alpha", member: "red/tester-1", task: "x" });
    await waitFor(run.runId);
    expect(skillsUsed(run.runId)).toEqual([{ name: "s1", how: "detected", evidence: expect.any(String) }]);
    expect(runOutput(run.runId)).toContain("→ Skill: s1");
  });

  it("codex skill use is only ever a labelled guess", async () => {
    useIsolatedHome(`echo "reading .agents/skills/s2/SKILL.md"`);
    setupOrg();
    addMember("red", { tool: "codex", skills: ["s2", "s3"] });
    const run = startRun({ project: "alpha", member: "red/codex-worker-1", task: "x" });
    await waitFor(run.runId);
    expect(skillsUsed(run.runId)).toEqual([{ name: "s2", how: "guess", evidence: expect.any(String) }]);
  });

  it("an unassigned worker still runs and records the project's own skills", async () => {
    useIsolatedHome("true");
    const repo = setupOrg();
    mkdirSync(join(repo, ".claude/skills/proj"), { recursive: true });
    writeFileSync(join(repo, ".claude/skills/proj/SKILL.md"), `---\nname: proj\ndescription: p\n---\n`);
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "p");
    const run = startRun({ project: "alpha", agent: "claude", task: "x" });
    await waitFor(run.runId);
    const rec = findRun(run.runId);
    expect(rec.team).toBeUndefined();
    expect(rec.skills!.map((s) => [s.name, s.source])).toEqual([["proj", "project"]]);
    const instructions = readFileSync(join(process.env.CODEC_HOME!, "runs", run.runId, "instructions.md"), "utf-8");
    expect(instructions).toContain("use the Skill tool");
    expect(instructions).toContain("proj: p");
  });

  it("a quick Codex helper gets skill-first instructions for native and older project skill folders", async () => {
    useIsolatedHome("true");
    const repo = setupOrg();
    for (const [base, name] of [[".agents/skills", "native"], [".codex/skills", "legacy"]]) {
      mkdirSync(join(repo, base, name), { recursive: true });
      writeFileSync(join(repo, base, name, "SKILL.md"), `---\nname: ${name}\ndescription: Project ${name} rules\n---\n`);
    }
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "skills");
    const run = startRun({ project: "alpha", agent: "codex", task: "check" });
    await waitFor(run.runId);
    const instructions = readFileSync(join(process.env.CODEC_HOME!, "runs", run.runId, "instructions.md"), "utf-8");
    expect(instructions).toContain("Before doing anything else");
    expect(instructions).toContain("native: Project native rules (.agents/skills/native/SKILL.md)");
    expect(instructions).toContain("legacy: Project legacy rules (.codex/skills/legacy/SKILL.md)");
  });
});

describe("CLI for teams and skills", () => {
  beforeEach(() => useIsolatedHome("true"));
  afterEach(() => cleanupTemps());

  it("drives the whole flow from the command line", () => {
    const env = { CODEC_HOME: process.env.CODEC_HOME };
    const repo = makeRepo("alpha");
    expect(cli(["project", "add", repo], env).code).toBe(0);
    expect(cli(["skill", "add", makeSkill("s1")], env).stdout).toContain("added skill s1");
    expect(cli(["skill", "add", makeSkill("s1")], env).stderr).toContain("already exists");
    expect(cli(["specialist", "add", "tester", "--specialty", "QA", "--tool", "claude", "--skills", "s1"], env).code).toBe(0);
    expect(cli(["team", "add", "red", "--projects", "alpha"], env).code).toBe(0);
    expect(cli(["team", "member", "add", "red", "--specialist", "tester"], env).stdout).toContain("red/tester-1");
    expect(cli(["team", "member", "add", "red", "--tool", "codex"], env).stdout).toContain("codex-worker-1");
    const list = cli(["team", "list"], env).stdout;
    expect(list).toContain("tester-1");
    expect(list).toContain("clone of tester");
    expect(cli(["specialist", "list"], env).stdout).toContain("red/tester-1");
    const skl = cli(["skill", "list"], env).stdout;
    expect(skl).toMatch(/s1\s+tester/);
    expect(cli(["specialist", "remove", "tester"], env).stderr).toContain("clone");
    expect(cli(["skill", "remove", "s1"], env).stdout).toContain("taken away from");
    expect(cli(["team", "member", "remove", "red", "tester-1"], env).code).toBe(0);
    expect(cli(["specialist", "remove", "tester"], env).code).toBe(0);
    expect(cli(["team", "remove", "red"], env).code).toBe(0);
  });
});

// ---------- API ----------
function call(d: Dashboard, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { Host: `127.0.0.1:${d.port}`, "X-Codec-Token": d.token };
  const payload = body === undefined ? undefined : JSON.stringify(body);
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: d.port, method, path, headers }, (res) => {
      let b = "";
      res.setEncoding("utf-8");
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode!, json: b ? JSON.parse(b) : undefined }));
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe("dashboard API for teams and skills", () => {
  let d: Dashboard;
  beforeEach(async () => {
    useIsolatedHome(`echo "reading .agents/skills/s2/SKILL.md"`);
    d = await startDashboard({ port: 0 });
  });
  afterEach(async () => {
    await d.close();
    for (const r of listRuns({ state: "running" })) stopRun(r.runId);
    cleanupTemps();
  });

  it("manages skills, specialists, teams and member runs", async () => {
    const repo = makeRepo("alpha");
    addProject(repo);
    expect((await call(d, "POST", "/api/skills", { path: makeSkill("s1") })).status).toBe(201);
    const up = await call(d, "POST", "/api/skills", {
      files: [{ path: "s2/SKILL.md", content: Buffer.from(`---\nname: s2\ndescription: two\n---\n`).toString("base64") }],
    });
    expect(up.status).toBe(201);
    expect((await call(d, "POST", "/api/skills", { path: makeSkill("s1") })).json.code).toBe("skill_exists");

    expect((await call(d, "POST", "/api/specialists", { name: "tester", specialty: "QA", tool: "claude", skills: ["s1"] })).status).toBe(201);
    expect((await call(d, "POST", "/api/specialists/tester/edit", { instructions: "Be careful." })).json.instructions).toBe("Be careful.");
    expect((await call(d, "POST", "/api/teams", { name: "red", projects: ["alpha"] })).status).toBe(201);
    expect((await call(d, "POST", "/api/teams/red/members", { specialist: "tester", skills: ["s2"] })).json.name).toBe("tester-1");
    expect((await call(d, "POST", "/api/teams/red/members", { tool: "codex", skills: ["s2"] })).json.name).toBe("codex-worker-1");

    const state = await call(d, "GET", "/api/state");
    expect(state.json.teamsCount).toBe(1);
    const proj = await call(d, "GET", "/api/projects/alpha");
    expect(proj.json.members.map((m: any) => m.ref)).toEqual(["red/tester-1", "red/codex-worker-1"]);

    const teams = (await call(d, "GET", "/api/teams")).json;
    expect(teams[0].members[0].skills.map((s: any) => [s.name, s.source])).toEqual([
      ["s1", "specialist"],
      ["s2", "member"],
    ]);
    const specs = (await call(d, "GET", "/api/specialists")).json;
    expect(specs[0].clones).toEqual([{ team: "red", member: "tester-1" }]);
    const skills = (await call(d, "GET", "/api/skills")).json;
    expect(skills.skills.find((s: any) => s.name === "s2").members).toEqual(["red/tester-1", "red/codex-worker-1"]);
    expect(skills.grid.rows.map((r: any) => r.id)).toEqual(["tester", "red/tester-1", "red/codex-worker-1"]);
    expect(skills.grid.rows[1].skills).toEqual({ s1: "via specialist", s2: "own" });

    const started = await call(d, "POST", "/api/projects/alpha/runs", { member: "red/codex-worker-1", task: "go" });
    expect(started.status).toBe(201);
    expect(started.json).toMatchObject({ team: "red", member: "codex-worker-1" });
    expect((await call(d, "POST", "/api/projects/alpha/runs", { task: "go" })).status).toBe(400);
    await waitFor(started.json.runId);
    const rv = (await call(d, "GET", `/api/runs/${started.json.runId}`)).json;
    expect(rv.skillsGiven.map((s: any) => [s.name, s.source])).toEqual([["s2", "member"]]);
    expect(rv.skillsUsed).toEqual([{ name: "s2", how: "guess", evidence: expect.any(String) }]);

    const mp = (await call(d, "GET", "/api/members/red/codex-worker-1")).json;
    expect(mp.runs.map((r: any) => r.runId)).toEqual([started.json.runId]);
    expect(mp.projects).toEqual(["alpha"]);
    expect((await call(d, "GET", "/api/members/red/ghost")).status).toBe(404);

    expect((await call(d, "POST", "/api/specialists/tester/remove", {})).json.code).toBe("specialist_in_use");
    const rm = await call(d, "POST", "/api/skills/s2/remove", {});
    expect(rm.json.members).toEqual(["red/tester-1", "red/codex-worker-1"]);
    expect((await call(d, "POST", "/api/teams/red/members/tester-1/remove", {})).status).toBe(200);
    expect((await call(d, "POST", "/api/teams/red/remove", {})).status).toBe(200);
    expect((await call(d, "GET", "/api/teams")).json).toEqual([]);
  });

  it("keeps the stage 2 security rules on the new routes", async () => {
    const noToken = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: d.port, method: "POST", path: "/api/teams", headers: { Host: `127.0.0.1:${d.port}`, "Content-Type": "application/json" } },
        (res) => { res.resume(); resolve(res.statusCode!); },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ name: "x", projects: ["a"] }));
    });
    expect(noToken).toBe(401);
    expect((await call(d, "GET", "/api/skills")).status).toBe(200);
  });
});
