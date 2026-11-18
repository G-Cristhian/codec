import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "child_process";
import { accessSync, constants, statSync } from "fs";
import { delimiter, join } from "path";
import { CodecError } from "./errors.js";
import { S } from "./strings.js";

export interface Keychain {
  available(): boolean;
  set(account: string, secret: string): void;
  get(account: string): string | undefined;
  delete(account: string): void;
}

const SERVICE = "codec-connections";
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
export const keychainUnavailable = () => new CodecError("keychain_unavailable", S.errors.keychain_unavailable, {}, 409);

function onPath(command: string): boolean {
  return (process.env.PATH ?? "").split(delimiter).some((directory) => {
    try {
      const file = join(directory, command);
      accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    }
    catch { return false; }
  });
}

type Spawn = (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) =>
  Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr" | "error" | "signal">;

/** Injection is for command-builder tests; they never execute a system keychain tool. */
export function createSystemKeychain(options: {
  platform?: NodeJS.Platform; spawn?: Spawn; onPath?: (command: string) => boolean;
} = {}): Keychain {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? spawnSync;
  const executable = options.onPath ?? onPath;
  const command = platform === "linux" ? "secret-tool" : "security";
  const available = () => (platform === "linux" || platform === "darwin") && executable(command);
  function check(value: string) {
    if (!value || CONTROL.test(value)) throw keychainUnavailable();
  }
  // security's interactive command parser accepts quoted arguments. No shell is used.
  const quote = (value: string) => '"' + value.replace(/["\\]/g, "\\$&") + '"';
  function run(account: string, operation: "set" | "get" | "delete", secret?: string): string | undefined {
    check(account);
    if (secret !== undefined) check(secret);
    if (!available()) throw keychainUnavailable();
    let args: string[];
    let input: string | undefined;
    if (platform === "linux") {
      const attributes = ["service", SERVICE, "account", account];
      args = operation === "set"
        ? ["store", "--label", `Codec ${account.replace(/\/([^/]*)$/, " $1")}`, ...attributes]
        : [operation === "get" ? "lookup" : "clear", ...attributes];
      if (operation === "set") input = secret;
    } else if (operation === "set") {
      args = ["-i"];
      input = `add-generic-password -U -s ${SERVICE} -a ${quote(account)} -w ${quote(secret!)}\n`;
    } else {
      args = [operation === "get" ? "find-generic-password" : "delete-generic-password", "-s", SERVICE, "-a", account];
      if (operation === "get") args.push("-w");
    }
    try {
      const result = spawn(command, args, { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024, input });
      if (result.error || result.signal) throw keychainUnavailable();
      if (operation !== "set" && (platform === "darwin" ? result.status === 44
        : result.status === 1 && !result.stderr && !result.stdout)) return undefined;
      if (result.status !== 0) throw keychainUnavailable();
      return operation === "get" ? result.stdout.replace(/\r?\n$/, "") : undefined;
    } catch {
      // Child-process errors may contain args, input or tool output. Never propagate them.
      throw keychainUnavailable();
    }
  }
  return { available, set: (account, secret) => { run(account, "set", secret); },
    get: (account) => run(account, "get"), delete: (account) => { run(account, "delete"); } };
}

const systemKeychain = createSystemKeychain();
let testKeychain: Keychain | undefined;
export function setKeychainForTests(fake: Keychain | undefined): void { testKeychain = fake; }
export function keychain(): Keychain { return testKeychain ?? systemKeychain; }
