/** Owner identity for saved checkpoints, kept in CODEC_HOME. */
import { spawnSync } from "child_process";
import { join } from "path";
import { CodecError } from "./errors.js";
import { S } from "./strings.js";
import { codecHome, projectsFile, readJson, specialistsFile, teamsFile, withLock, writeJsonAtomic } from "./store.js";

export interface Identity { name: string; email: string }
export interface Settings { identity: Identity; setupFinished: boolean }
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
  const existingInstall = saved.setupFinished === undefined && (
    readJson<{ projects: unknown[] }>(projectsFile(), { projects: [] }).projects.length > 0 ||
    readJson<{ specialists: unknown[] }>(specialistsFile(), { specialists: [] }).specialists.length > 0 ||
    readJson<{ teams: { members: unknown[] }[] }>(teamsFile(), { teams: [] }).teams.some((team) => team.members.length > 0));
  if (existingInstall) return saveSettings({ setupFinished: true });
  return { identity: saved.identity ?? configIdentity(), setupFinished: saved.setupFinished ?? false };
}
export function saveIdentity(input: Identity): Settings {
  return saveSettings({ identity: input });
}
export function saveSettings(input: { identity?: Identity; setupFinished?: boolean }): Settings {
  const identity = input.identity ? { name: input.identity.name.trim(), email: input.identity.email.trim() } : undefined;
  if (identity && !valid(identity)) throw new CodecError("invalid_identity", S.errors.invalid_identity);
  return withLock("settings", () => {
    const saved = readJson<Partial<Settings>>(settingsFile(), {});
    const settings = { ...saved, ...(identity ? { identity } : {}), ...(input.setupFinished !== undefined ? { setupFinished: input.setupFinished } : {}) };
    writeJsonAtomic(settingsFile(), settings);
    return { identity: settings.identity ?? configIdentity(), setupFinished: settings.setupFinished ?? false };
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
