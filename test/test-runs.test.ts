import { execFileSync } from "child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { laneOf } from "../src/dashboard.js";
import { readEvents } from "../src/events.js";
import { addProject } from "../src/registry.js";
import { applyChanges, runChanges } from "../src/review.js";
import { listRuns, readRunStatus, recordReview, recordTests, startRun, stopRun } from "../src/runs.js";
import { MAX_TEST_OUTPUT_BYTES, parseTestFailures, rerunTests, testsOutput, waitForTests } from "../src/test-runs.js";
import { S } from "../src/strings.js";
import { cleanupTemps, makeRepo, tempDir, useIsolatedHome, waitFor } from "./helpers.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const tests = (id: string) => {
  const review = readRunStatus(id)!.reviewed;
  if (review?.action !== "applied") throw new Error("Missing applied review");
  return review.tests!;
};
function command(source: string): string {
  const file = join(tempDir(), "tests.cjs");
  writeFileSync(file, source);
  return `'${process.execPath}' '${file}'`;
}
async function prepare(repo = makeRepo("site"), file = "feature.txt") {
  addProject(repo);
  process.env.CODEC_AGENT_COMMAND = `echo kept > ${file}`;
  const run = await waitFor(startRun({ project: "site", agent: "claude", task: "Fix a feature" }).runId);
  return { run, repo, changes: await runChanges(run.runId) };
}
async function apply(commandText: string) {
  const fixture = await prepare();
  process.env.CODEC_TEST_COMMAND = commandText;
  const updated = applyChanges(fixture.run.runId, { head: fixture.changes.head, hunks: ["0:0"] });
  return { ...fixture, updated };
}

beforeEach(() => useIsolatedHome("true"));
afterEach(async () => {
  await Promise.all(listRuns().map((run) => waitForTests(run.runId)));
  for (const run of listRuns({ state: "running" })) stopRun(run.runId);
  vi.unstubAllEnvs();
  cleanupTemps();
});

describe("failure reporters", () => {
  it("parses vitest detailed and compact failures, deduplicating and limiting to 50", () => {
    expect(parseTestFailures("FAIL  test/cart.test.ts > cart > adds items\nFAIL  test/cart.test.ts > cart > adds items")).toEqual([
      { name: "cart > adds items", file: "test/cart.test.ts" },
    ]);
    expect(parseTestFailures("❯ test/cart.test.ts (2 tests | 1 failed)\n × adds items 12ms")).toEqual([
      { name: "adds items", file: "test/cart.test.ts" },
    ]);
    expect(parseTestFailures("❯ test/cart.test.ts (1 test | 1 failed)\n × adds items\nFAIL test/cart.test.ts > cart > adds items\nFAIL test/cart.test.ts > cart > adds items")).toEqual([{ name: "cart > adds items", file: "test/cart.test.ts" }]);
    expect(parseTestFailures(Array.from({ length: 60 }, (_, i) => `not ok ${i} - case ${i}`).join("\n"))).toHaveLength(50);
  });
  it("parses jest files and suite names, stripping ANSI colors", () => {
    expect(parseTestFailures("\x1b[31mFAIL test/cart.test.js\x1b[0m\n ● Cart › adds items\nFAIL test/other.test.js\n ● saves")).toEqual([
      { name: "Cart › adds items", file: "test/cart.test.js" }, { name: "saves", file: "test/other.test.js" },
    ]);
  });
  it("parses node:test names and diagnostic locations", () => {
    expect(parseTestFailures("not ok 2 - adds items\n  ---\n  location: '/tmp/cart.test.js:10:2'\nnot ok 3 - saves")).toEqual([
      { name: "adds items", file: "/tmp/cart.test.js" }, { name: "saves" },
    ]);
  });
  it("parses mocha only in the failing section", () => {
    expect(parseTestFailures("1) Not a failure yet\n 2 failing\n 1) Cart\n      adds items:\n AssertionError: false\n at Context.<anonymous> (test/cart.js:4:7)\n 2) saves:\n Error: oh no")).toEqual([
      { name: "Cart adds items", file: "test/cart.js" }, { name: "saves" },
    ]);
  });
  it("returns no invented names for unparseable output", () => {
    expect(parseTestFailures("Oops. An unexpected error happened.\n")).toEqual([]);
  });
});

describe("project test runner", () => {
  it("returns queued before tests finish, passes in CI in the project folder and logs transitions", async () => {
    const { run, repo, updated } = await apply(command("setTimeout(() => console.log(process.cwd(), process.env.CI), 150);"));
    expect(updated.reviewed).toMatchObject({ tests: { state: "queued" } });
    expect(tests(run.runId).state).not.toBe("passed");
    expect(laneOf(updated)).toBe("inReview");
    await waitForTests(run.runId);
    expect(tests(run.runId)).toMatchObject({ state: "passed", exitCode: 0 });
    expect(laneOf(readRunStatus(run.runId)!)).toBe("done");
    expect(testsOutput(run.runId)).toContain(`${repo} true`);
    expect(tests(run.runId).outputFile).toBe(join(process.env.CODEC_HOME!, "runs", run.runId, "tests.log"));
    expect(existsSync(join(repo, "tests.log"))).toBe(false);
    expect(readEvents().filter((e) => e.kind === "run.tests").map((e) => [e.phase, e.state])).toEqual([["start", "running"], ["finish", "passed"]]);
  });
  it("records failed names, files and applied files mentioned anywhere in output", async () => {
    const { run } = await apply(command("console.log('FAIL test/cart.test.js\\n ● Cart › adds items\\nfeature.txt:12'); process.exitCode = 1;"));
    await waitForTests(run.runId);
    expect(tests(run.runId)).toMatchObject({ state: "failed", failures: [{ name: "Cart › adds items", file: "test/cart.test.js" }], changedFiles: ["feature.txt"] });
    expect(laneOf(readRunStatus(run.runId)!)).toBe("inReview");
  });
  it.each([undefined, {}, { scripts: {} }, { scripts: { test: 'echo "Error: no test specified" && exit 1' } }])("skips missing and placeholder test scripts: %j", async (pkg) => {
    const repo = makeRepo("site");
    if (pkg) { writeFileSync(join(repo, "package.json"), JSON.stringify(pkg)); git(repo, "add", "."); git(repo, "commit", "-qm", "Fixture package"); }
    const { run, changes } = await prepare(repo);
    delete process.env.CODEC_TEST_COMMAND; // Only skip cases omit the fake command; no command may run.
    applyChanges(run.runId, { head: changes.head, hunks: ["0:0"] });
    await waitForTests(run.runId);
    expect(tests(run.runId)).toMatchObject({ state: "skipped", note: S.tests.skipNote });
    expect(laneOf(readRunStatus(run.runId)!)).toBe("done");
    expect(readEvents().filter((e) => e.kind === "run.tests" && e.phase === "start")).toEqual([]);
  });
  it("reports a spawn error in plain language", async () => {
    const { run, repo, changes } = await prepare();
    process.env.CODEC_TEST_COMMAND = command("console.log('should not run')");
    applyChanges(run.runId, { head: changes.head, hunks: ["0:0"] });
    rmSync(repo, { recursive: true }); // The queued command's cwd disappears before spawning.
    await waitForTests(run.runId);
    expect(tests(run.runId)).toMatchObject({ state: "error", note: S.tests.startError });
  });
  it("kills the whole process group on timeout", async () => {
    const { run } = await apply(command("process.exitCode = 1"));
    await waitForTests(run.runId);
    const pids = join(tempDir(), "pids.json");
    process.env.CODEC_TEST_COMMAND = command(`const {spawn} = require('child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'}); require('fs').writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, child.pid])); setInterval(() => {}, 1000);`);
    rerunTests(run.runId, { timeoutMs: 700 });
    await waitForTests(run.runId);
    expect(tests(run.runId)).toMatchObject({ state: "error", note: S.tests.timedOut });
    const ids: number[] = JSON.parse(readFileSync(pids, "utf8"));
    for (const pid of ids) {
      // On Linux an orphan can briefly be a zombie until the container's init reaps it.
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch { /* gone */ }
      if (alive && process.platform === "linux") expect(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0]).toBe("Z");
      else expect(alive).toBe(false);
    }
  });
  it("redacts split secrets, captures both streams and caps output keeping the tail", async () => {
    const fakeSecret = "sk-fixtureSecret123456789";
    const { run } = await apply(command(`process.stdout.write('BEGIN\\n' + 'x'.repeat(${MAX_TEST_OUTPUT_BYTES}) + '\\n'); process.stderr.write('stderr detail\\n'); process.stdout.write('sk-fixture'); setTimeout(() => { process.stdout.write('Secret123456789\\nTAIL\\n'); }, 30);`));
    await waitForTests(run.runId);
    const output = testsOutput(run.runId, true);
    expect(output).not.toContain("BEGIN");
    expect(output).not.toContain(fakeSecret);
    expect(output).toContain("[redacted]");
    expect(output).toContain("stderr detail");
    expect(output).toContain("TAIL");
    expect(statSync(tests(run.runId).outputFile!).size).toBeLessThanOrEqual(MAX_TEST_OUTPUT_BYTES);
  });
  it("shows only the last 2,000 lines to the panel", async () => {
    const { run } = await apply(command("console.log(Array.from({length: 2100}, (_, i) => 'line ' + i).join('\\n'));"));
    await waitForTests(run.runId);
    expect(testsOutput(run.runId)).toBe(S.tests.outputTrimmed + "\n\n" + Array.from({ length: 2000 }, (_, i) => `line ${i + 100}`).join("\n"));
    expect(testsOutput(run.runId, true)).toContain("line 0\n");
  });
  it("serializes two applies in the same project folder", async () => {
    const { run: first, repo, changes } = await prepare();
    process.env.CODEC_AGENT_COMMAND = "echo second > second.txt";
    const second = await waitFor(startRun({ project: "site", agent: "claude", task: "Second task" }).runId);
    const secondChanges = await runChanges(second.runId);
    const trace = join(tempDir(), "trace");
    process.env.CODEC_TEST_COMMAND = command(`const fs = require('fs'); fs.appendFileSync(${JSON.stringify(trace)}, 'start\\n'); setTimeout(() => fs.appendFileSync(${JSON.stringify(trace)}, 'end\\n'), 200);`);
    applyChanges(first.runId, { head: changes.head, hunks: ["0:0"] });
    applyChanges(second.runId, { head: secondChanges.head, hunks: ["0:0"] });
    await vi.waitFor(() => expect(tests(first.runId).state).toBe("running"));
    expect(tests(second.runId).state).toBe("queued");
    await Promise.all([waitForTests(first.runId), waitForTests(second.runId)]);
    expect(readFileSync(trace, "utf8")).toBe("start\nend\nstart\nend\n");
    expect(git(repo, "status", "--porcelain")).toBe("");
  });
  it.each(["running", "queued"] as const)("reports stale %s as interrupted and persists it on the next write", async (state) => {
    const { run } = await prepare();
    recordReview(run.runId, { action: "applied", at: "now", commit: run.baseSha, hunks: 1, total: 1, tests: { state } });
    const record = join(process.env.CODEC_HOME!, "runs", run.runId, "run.json");
    expect(JSON.parse(readFileSync(record, "utf8")).reviewed.tests.state).toBe(state);
    expect(tests(run.runId)).toMatchObject({ state: "interrupted", note: S.tests.interrupted });
    recordTests(run.runId, (value) => ({ ...value, closedAt: "now" }));
    expect(JSON.parse(readFileSync(record, "utf8")).reviewed.tests.state).toBe("interrupted");
  });
});
