import { afterEach, describe, expect, it, vi } from "vitest";
import { chooseFolderNatively, type PickerRunner } from "../src/folders.js";
import { S } from "../src/strings.js";
import { cleanupTemps, tempDir } from "./helpers.js";

afterEach(() => cleanupTemps());
const runner = (result: { code: number | null; stdout?: string; stderr?: string }) =>
  vi.fn<PickerRunner>(async () => ({ stdout: "", stderr: "", ...result }));

describe("native folder picker", () => {
  it("opens Finder's folder chooser on macOS without a shell and returns the folder", async () => {
    const start = tempDir();
    const run = runner({ code: 0, stdout: "/Users/me/School/CS 477/\n" });
    expect(await chooseFolderNatively(start, { platform: "darwin", run })).toEqual({ path: "/Users/me/School/CS 477" });
    const [command, args] = run.mock.calls[0];
    expect(command).toBe("/usr/bin/osascript");
    expect(args.slice(-2)).toEqual([S.folder.prompt, start]);
    expect(args.filter((a) => a !== "-e").join("\n")).not.toContain(start + "\"");
  });
  it("treats Cancel as cancelled and other failures as unavailable", async () => {
    expect(await chooseFolderNatively(undefined, { platform: "darwin", run: runner({ code: 1, stderr: "execution error: User canceled. (-128)" }) })).toEqual({ cancelled: true });
    expect(await chooseFolderNatively(undefined, { platform: "darwin", run: runner({ code: 1, stderr: "not allowed" }) })).toEqual({ unavailable: true });
  });
  it("ignores a start folder that doesn't exist", async () => {
    const run = runner({ code: 0, stdout: "/tmp/x/" });
    await chooseFolderNatively("/no/such/folder", { platform: "darwin", run });
    expect(run.mock.calls[0][1].at(-1)).toBe(S.folder.prompt);
  });
  it("uses zenity on Linux, and reports no picker elsewhere", async () => {
    const run = runner({ code: 0, stdout: "/home/me/notes\n" });
    expect(await chooseFolderNatively(undefined, { platform: "linux", run })).toEqual({ path: "/home/me/notes" });
    expect(run.mock.calls[0][0]).toBe("zenity");
    expect(await chooseFolderNatively(undefined, { platform: "linux", run: runner({ code: null }) })).toEqual({ unavailable: true });
    expect(await chooseFolderNatively(undefined, { platform: "linux", run: runner({ code: 1 }) })).toEqual({ cancelled: true });
    expect(await chooseFolderNatively(undefined, { platform: "win32", run })).toEqual({ unavailable: true });
  });
});
