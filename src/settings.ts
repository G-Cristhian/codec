/** Owner identity for saved checkpoints, kept in CODEC_HOME. */
import { spawnSync } from "child_process";
import { join } from "path";
import { CodecError } from "./errors.js";
import { S } from "./strings.js";
import { codecHome, readJson, withLock, writeJsonAtomic } from "./store.js";

export interface Identity { name: string; email: string }
export interface Settings { identity: Identity }
const settingsFile = () => join(codecHome(), "settings.json");

function configIdentity(path?: string): Identity {
  const read = (key: string) => {
    const result = spawnSync("git", [...(path ? ["-C", path] : []), "config", path ? "--local" : "--global", "--get", key],
      { encoding: "utf-8", timeout: 5000 });
    return result.status === 0 ? result.stdout.trim() : "";
  };
  return { name: read("user.name"), email: read("user.email") };
}
function valid(identity: Identity): boolean {
  return !!identity.name && !/[\x00-\x1f\x7f<>]/.test(identity.name) &&
    /^[^\s<>@]+@[^\s<>@]+$/.test(identity.email);
}
export function getSettings(): Settings {
  const saved = readJson<Partial<Settings>>(settingsFile(), {});
  return { identity: saved.identity ?? configIdentity() };
}
export function saveIdentity(input: Identity): Settings {
  const identity = { name: input.name.trim(), email: input.email.trim() };
  if (!valid(identity)) throw new CodecError("invalid_identity", S.errors.invalid_identity);
  return withLock("settings", () => {
    const settings = { ...readJson<Partial<Settings>>(settingsFile(), {}), identity };
    writeJsonAtomic(settingsFile(), settings);
    return settings;
  });
}
export function checkpointIdentity(projectPath?: string): Identity | undefined {
  const identity = getSettings().identity;
  if (valid(identity)) return identity;
  if (projectPath) {
    const local = configIdentity(projectPath);
    if (valid(local)) return local;
  }
  return undefined;
}
export function identityEnvironment(identity: Identity): NodeJS.ProcessEnv {
  return { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email };
}
