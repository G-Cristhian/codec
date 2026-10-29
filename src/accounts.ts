/** Metadata only. CLI-owned credentials stay in private folders, never in API objects. */
import { createHash, randomBytes } from "crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync } from "fs";
import { join, resolve } from "path";
import { userInfo } from "os";
import { spawnSync } from "child_process";
import { CodecError } from "./errors.js";
import { S } from "./strings.js";
import { codecHome, readJson, withLock, writeJsonAtomic } from "./store.js";
import { redactSecrets } from "./secrets.js";
import type { Agent } from "./tools.js";

export interface Account { id: string; name: string; kind: Agent; builtin?: boolean; signedInAt?: string }
export type AccountScope = "helper" | "team" | "project";
export interface AccountStore {
  accounts: Account[];
  defaults: Partial<Record<Agent, string>>;
  choices: Record<string, Partial<Record<Agent, string>>>;
}
const file = () => join(codecHome(), "accounts.json");
export const builtinId = (kind: Agent) => `computer-${kind}`;
export const builtinAccount = (kind: Agent): Account => ({ id: builtinId(kind), name: S.accounts.computer, kind, builtin: true });
export const accountStore = (): AccountStore => readJson(file(), { accounts: [], defaults: {}, choices: {} });
export function listAccounts(): Account[] { return [builtinAccount("claude"), builtinAccount("codex"), ...accountStore().accounts.map(publicAccount)]; }
function publicAccount(a: Account): Account { return { id: a.id, name: redactSecrets(a.name), kind: a.kind, ...(a.signedInAt ? { signedInAt: a.signedInAt } : {}) }; }
export function getAccount(id: string): Account {
  const account = listAccounts().find((a) => a.id === id);
  if (!account) throw new CodecError("account_missing", S.errors.account_missing, {}, 404);
  return account;
}
export function accountFolder(id: string): string {
  if (!/^account-[a-f0-9]{24}$/.test(id)) throw new CodecError("account_missing", S.errors.account_missing, {}, 404);
  return resolve(codecHome(), "accounts", id);
}
export function secureAccountFolder(id: string): string {
  const root = resolve(codecHome(), "accounts");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (lstatSync(root).isSymbolicLink()) throw new CodecError("account_folder", S.errors.account_folder);
  chmodSync(root, 0o700);
  const folder = accountFolder(id);
  mkdirSync(folder, { mode: 0o700, recursive: true });
  if (lstatSync(folder).isSymbolicLink()) throw new CodecError("account_folder", S.errors.account_folder);
  chmodSync(folder, 0o700);
  return folder;
}
export function secureAccountFiles(id: string): void {
  const visit = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isSymbolicLink()) continue;
      chmodSync(path, entry.isDirectory() ? 0o700 : 0o600 | (statSync(path).mode & 0o100));
      if (entry.isDirectory()) visit(path);
    }
  };
  const folder = accountFolder(id);
  if (existsSync(folder)) visit(folder);
}
export function prepareAccount(account: Account): void {
  if (account.builtin) return;
  const folder = secureAccountFolder(account.id);
  if (account.kind === "claude") {
    const settingsFile = join(folder, "settings.json");
    if (existsSync(settingsFile) && lstatSync(settingsFile).isSymbolicLink()) throw new CodecError("account_folder", S.errors.account_folder);
    const saved = readJson<Record<string, unknown>>(settingsFile, {});
    writeJsonAtomic(settingsFile, { ...saved, includeCoAuthoredBy: false, attribution: { commit: "", pr: "" } });
    chmodSync(settingsFile, 0o600);
  }
}
export function addAccount(kind: string, name: string): Account {
  if (kind !== "claude" && kind !== "codex") throw new CodecError("invalid_tool", S.errors.invalid_tool);
  const clean = name.trim();
  if (!clean || clean.length > 80 || /[\x00-\x1f\x7f]/.test(clean) || redactSecrets(clean) !== clean) throw new CodecError("account_name", S.errors.account_name);
  return withLock("accounts", () => {
    const saved = accountStore();
    const account: Account = { id: `account-${randomBytes(12).toString("hex")}`, name: clean, kind };
    prepareAccount(account);
    saved.accounts.push(account);
    writeJsonAtomic(file(), saved);
    chmodSync(file(), 0o600);
    return account;
  });
}
export function setDefaultAccount(kind: Agent, id: string): void {
  withLock("accounts", () => {
    if (getAccount(id).kind !== kind) throw new CodecError("account_kind", S.errors.account_kind);
    const saved = accountStore(); saved.defaults[kind] = id; writeJsonAtomic(file(), saved);
  });
}
export const choiceKey = (scope: AccountScope, name: string) => `${scope}:${name}`;
export function setAccountChoice(scope: AccountScope, name: string, kind: Agent, id?: string): void {
  withLock("accounts", () => {
    if (id && getAccount(id).kind !== kind) throw new CodecError("account_kind", S.errors.account_kind);
    const saved = accountStore(), key = choiceKey(scope, name);
    saved.choices[key] ??= {};
    if (id) saved.choices[key][kind] = id; else delete saved.choices[key][kind];
    writeJsonAtomic(file(), saved);
  });
}
/** A newly recreated project/team/helper starts with Use default. History keeps its snapshot. */
export function clearAccountChoices(scope: AccountScope, name: string): void {
  withLock("accounts", () => {
    const saved = accountStore();
    const keys = Object.keys(saved.choices).filter((key) => key === choiceKey(scope, name) || scope === "team" && key.startsWith(`helper:${name}/`));
    if (!keys.length) return;
    keys.forEach((key) => { delete saved.choices[key]; });
    writeJsonAtomic(file(), saved);
  });
}
export function resolveAccount(kind: Agent, context: { helper?: string; team?: string; project?: string } = {}): Account {
  const saved = accountStore();
  for (const scope of ["helper", "team", "project"] as const) {
    const name = context[scope];
    const id = name && saved.choices[choiceKey(scope, name)]?.[kind];
    if (id) return checkedKind(id, kind);
  }
  return checkedKind(saved.defaults[kind] ?? builtinId(kind), kind);
}
function checkedKind(id: string, kind: Agent): Account {
  const account = getAccount(id);
  if (account.kind !== kind) throw new CodecError("account_kind", S.errors.account_kind);
  return account;
}

/** Built-ins use the machine environment exactly; managed accounts discard inherited auth. */
export function accountEnvironment(account: Account, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  if (account.builtin) return env;
  const folder = accountFolder(account.id);
  if (!existsSync(folder) || lstatSync(folder).isSymbolicLink() || lstatSync(resolve(codecHome(), "accounts")).isSymbolicLink()) throw new CodecError("account_folder", S.errors.account_folder);
  for (const key of Object.keys(env)) {
    if (/^(?:ANTHROPIC_|CLAUDE_CODE_(?:OAUTH|API_KEY|USE_|PROVIDER|CLOUD)|CLAUDE_SECURESTORAGE_CONFIG_DIR$|CLAUDE_CONFIG_DIR$|CODEX_(?:HOME$|API_KEY$|ACCESS_TOKEN$|AUTH)|OPENAI_(?:API_KEY$|ACCESS_TOKEN$|IDENTITY)|AWS_|GOOGLE_APPLICATION_CREDENTIALS$)/.test(key)) delete env[key];
  }
  env[account.kind === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"] = folder;
  return env;
}
export const accountCliArgs = (account: Account) => account.kind === "codex" && !account.builtin ? ["-c", 'cli_auth_credentials_store="file"'] : [];
export function noteAccountSignIn(id: string): void {
  withLock("accounts", () => {
    const saved = accountStore(), account = saved.accounts.find((a) => a.id === id);
    if (!account) return;
    account.signedInAt = new Date().toISOString(); writeJsonAtomic(file(), saved);
  });
}
export function claudeKeychainService(folder: string): string {
  return "Claude Code-credentials-" + createHash("sha256").update(folder.normalize("NFC")).digest("hex").slice(0, 8);
}
export interface RemovalOptions {
  confirmed: boolean;
  running: () => { account?: { id: string }; state: string }[];
  platform?: NodeJS.Platform;
  keychainDelete?: (service: string, user: string) => boolean;
}
export function removeAccount(id: string, options: RemovalOptions): Account {
  return withLock("accounts", () => {
    const account = getAccount(id);
    if (account.builtin) throw new CodecError("account_builtin", S.errors.account_builtin, {}, 409);
    if (!options.confirmed) throw new CodecError("account_confirm", S.errors.account_confirm, {}, 409);
    if (options.running().some((run) => run.state === "running" && run.account?.id === id)) throw new CodecError("account_busy", S.errors.account_busy, {}, 409);
    const folder = accountFolder(id);
    if ((options.platform ?? process.platform) === "darwin" && account.kind === "claude") {
      const candidate = process.env.USER || userInfo().username;
      const user = /^[a-zA-Z0-9._-]+$/.test(candidate) ? candidate : "claude-code-user";
      const remove = options.keychainDelete ?? ((service, user) => {
        const result = spawnSync("security", ["delete-generic-password", "-s", service, "-a", user], { stdio: "ignore", timeout: 5000 });
        return result.status === 0 || result.status === 44;
      });
      if (!remove(claudeKeychainService(folder), user)) throw new CodecError("account_remove", S.errors.account_remove, {}, 409);
    }
    rmSync(folder, { recursive: true, force: true });
    const saved = accountStore();
    saved.accounts = saved.accounts.filter((a) => a.id !== id);
    for (const kind of ["claude", "codex"] as const) if (saved.defaults[kind] === id) delete saved.defaults[kind];
    for (const choices of Object.values(saved.choices)) for (const kind of ["claude", "codex"] as const) if (choices[kind] === id) delete choices[kind];
    writeJsonAtomic(file(), saved);
    return publicAccount(account);
  });
}
