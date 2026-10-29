import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(() => Object.assign(new EventEmitter(), { kill: vi.fn() })),
  spawnSync: vi.fn(() => ({ status: 1 })),
  statSync: vi.fn(() => ({ uid: 1000, mode: 0o755 })),
  readFileSync: vi.fn(() => "1\n"),
}));
vi.mock("electron", () => ({ default: "/electron/electron" }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn, spawnSync: mocks.spawnSync }));
vi.mock("node:fs", () => ({ statSync: mocks.statSync, readFileSync: mocks.readFileSync }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const listeners = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    for (const listener of process.listeners(signal)) if (!listeners[signal].includes(listener)) process.removeListener(signal, listener);
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it.each([
  ["darwin", "1", []],
  ["darwin", undefined, []],
  ["linux", "0", ["--class=Codec"]],
  ["linux", "1", ["--no-sandbox", "--class=Codec"]],
  ["linux", undefined, ["--no-sandbox", "--class=Codec"]],
] as const)("uses platform flags on %s with sandbox override %s", async (os, override, flags) => {
  Object.defineProperty(process, "platform", { value: os });
  vi.stubEnv("CODEC_NO_SANDBOX", override);
  vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.resetModules();
  const script = "../scripts/run-app.mjs";
  await import(script);
  expect(mocks.spawn).toHaveBeenCalledOnce();
  const [binary, args, options] = mocks.spawn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
  expect(binary).toBe("/electron/electron");
  expect(args.slice(0, -1)).toEqual(flags);
  expect(options.env.CODEC_DESKTOP_NODE).toBe(process.execPath);
  expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  if (os === "darwin") {
    expect(mocks.statSync).not.toHaveBeenCalled();
    expect(mocks.readFileSync).not.toHaveBeenCalled();
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  }
});
