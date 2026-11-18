import { describe, expect, it, vi } from "vitest";
import { createSystemKeychain } from "../src/keychain.js";
import { S } from "../src/strings.js";

function fixture(platform: NodeJS.Platform = "linux") {
  type Spawn = NonNullable<NonNullable<Parameters<typeof createSystemKeychain>[0]>["spawn"]>;
  const spawn = vi.fn<Spawn>(() => ({
    status: 0, stdout: "", stderr: "", signal: null,
  }));
  const onPath = vi.fn(() => true);
  return { chain: createSystemKeychain({ platform, spawn, onPath }), spawn, onPath };
}

describe("system keychain command builders (spawn is always stubbed)", () => {
  const secret = "ghp_testOnlyNeverARealToken1234";
  const account = "My project/github";

  it("uses Linux stdin for store and exact service/account attributes for lookup and clear", () => {
    const { chain, spawn, onPath } = fixture();
    expect(chain.available()).toBe(true);
    expect(onPath).toHaveBeenCalledWith("secret-tool");
    chain.set(account, secret);
    spawn.mockReturnValueOnce({ status: 0, stdout: secret + "\n", stderr: "", signal: null });
    expect(chain.get(account)).toBe(secret);
    chain.delete(account);
    expect(spawn.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ["secret-tool", ["store", "--label", "Codec My project github", "service", "codec-connections", "account", account]],
      ["secret-tool", ["lookup", "service", "codec-connections", "account", account]],
      ["secret-tool", ["clear", "service", "codec-connections", "account", account]],
    ]);
    expect(spawn.mock.calls[0][2].input).toBe(secret);
    for (const [, args, options] of spawn.mock.calls) {
      expect(JSON.stringify(args)).not.toContain(secret);
      expect(options.env).toBeUndefined();
      expect(options.shell).toBeUndefined();
      expect(options.timeout).toBe(10_000);
    }
  });

  it("uses macOS interactive stdin for set and argument arrays for lookup/delete", () => {
    const { chain, spawn } = fixture("darwin");
    chain.set(account, secret);
    spawn.mockReturnValueOnce({ status: 0, stdout: secret + "\n", stderr: "", signal: null });
    expect(chain.get(account)).toBe(secret);
    chain.delete(account);
    expect(spawn.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ["security", ["-i"]],
      ["security", ["find-generic-password", "-s", "codec-connections", "-a", account, "-w"]],
      ["security", ["delete-generic-password", "-s", "codec-connections", "-a", account]],
    ]);
    expect(spawn.mock.calls[0][2].input).toBe(`add-generic-password -U -s codec-connections -a "${account}" -w "${secret}"\n`);
    for (const [, args, options] of spawn.mock.calls) {
      expect(JSON.stringify(args)).not.toContain(secret);
      expect(options.env).toBeUndefined();
      expect(options.shell).toBeUndefined();
      expect(options.timeout).toBe(10_000);
    }
  });

  it.each(["linux", "darwin"] as const)("keeps spaces, quotes, backslashes and shell syntax literal on %s", (platform) => {
    const { chain, spawn } = fixture(platform);
    const name = 'A "quoted" \\ project; $(touch nope)\'s/github';
    const value = 'fake"token\\with\'quotes';
    chain.set(name, value);
    const [, args, options] = spawn.mock.calls[0];
    if (platform === "linux") {
      expect(args.at(-1)).toBe(name);
      expect(options.input).toBe(value);
    } else {
      expect(args).toEqual(["-i"]);
      expect(options.input).toBe('add-generic-password -U -s codec-connections -a "A \\"quoted\\" \\\\ project; $(touch nope)\'s/github" -w "fake\\"token\\\\with\'quotes"\n');
    }
  });

  it.each(["linux", "darwin"] as const)("rejects control characters before spawning on %s", (platform) => {
    const { chain, spawn } = fixture(platform);
    for (const control of ["\n", "\r", "\0", "\t", "\x7f", "\x85"]) {
      expect(() => chain.set(`project${control}/github`, secret)).toThrow(expect.objectContaining({ code: "keychain_unavailable" }));
      expect(() => chain.set(account, `fake${control}token`)).toThrow(expect.objectContaining({ code: "keychain_unavailable" }));
      expect(() => chain.get(`project${control}/github`)).toThrow();
      expect(() => chain.delete(`project${control}/github`)).toThrow();
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["get", "delete"] as const)("accepts macOS exit 44 for missing %s", (operation) => {
    const { chain, spawn } = fixture("darwin");
    spawn.mockReturnValue({ status: 44, stdout: "", stderr: "item not found", signal: null });
    expect(chain[operation](account)).toBeUndefined();
  });

  it.each(["get", "delete"] as const)("accepts Linux exit 1 without output for missing %s", (operation) => {
    const { chain, spawn } = fixture();
    spawn.mockReturnValue({ status: 1, stdout: "", stderr: "", signal: null });
    expect(chain[operation](account)).toBeUndefined();
  });

  it.each(["win32", "freebsd"] as const)("is unavailable on %s", (platform) => {
    const { chain, spawn, onPath } = fixture(platform);
    expect(chain.available()).toBe(false);
    expect(() => chain.set(account, secret)).toThrow(expect.objectContaining({ code: "keychain_unavailable", status: 409 }));
    expect(onPath).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("is unavailable when secret-tool is absent from PATH", () => {
    const { chain, onPath, spawn } = fixture();
    onPath.mockReturnValue(false);
    expect(chain.available()).toBe(false);
    expect(() => chain.get(account)).toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["linux", "darwin"] as const)("sanitizes tool failures, thrown errors and timeouts on %s", (platform) => {
    const { chain, spawn } = fixture(platform);
    for (const operation of [() => chain.set(account, secret), () => chain.get(account), () => chain.delete(account)]) {
      for (const failure of [
        () => ({ status: 1, stdout: secret, stderr: "private stderr " + secret, signal: null }),
        () => ({ status: null, stdout: "", stderr: secret, signal: "SIGTERM" as const, error: new Error(secret) }),
        () => { throw new Error("private stderr " + secret); },
      ]) {
        spawn.mockImplementationOnce(failure);
        try { operation(); expect.fail("must fail"); } catch (error) {
          expect(error).toMatchObject({ code: "keychain_unavailable", status: 409, params: {}, message: S.errors.keychain_unavailable });
          expect(String(error) + JSON.stringify(error)).not.toContain(secret);
          expect(String(error) + JSON.stringify(error)).not.toContain("private stderr");
        }
      }
    }
  });
});
