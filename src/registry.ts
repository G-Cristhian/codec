/**
 * registry.ts — the list of projects Codec manages.
 * Stored in $CODEC_HOME/projects.json; every write happens under a lock so
 * two `codec project add` commands at once can't lose each other's entry.
 */

import { CodecError, suggestName } from "./errors.js";
import { spawnSync } from "child_process";
import { existsSync, statSync } from "fs";
import { basename, resolve } from "path";
import { logEvent } from "./events.js";
import { checkMessageLimit } from "./message-limits.js";
import { projectsFile, readJson, withLock, writeJsonAtomic } from "./store.js";
import type { ProjectArea } from "./planner.js";

export interface Project {
  name: string;
  messageLimit?: number;
  /** Home tag: one of the owner's classes, work or personal. */
  area?: ProjectArea;
  className?: string;
  path: string; // absolute path to the repo's top level
  addedAt: string;
}

/** Names end up in paths, branch names and the event log — keep them plain. */
export const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function load(): Project[] {
  return readJson<{ projects: Project[] }>(projectsFile(), { projects: [] }).projects;
}

function save(projects: Project[]): void {
  writeJsonAtomic(projectsFile(), { projects });
}

export function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

export function addProject(path: string, name?: string): Project {
  const abs = resolve(path);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new CodecError("not_a_folder", `not a directory: ${abs}`);
  }
  const top = git(abs, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) throw new CodecError("needs_tracking", `not a git repository: ${abs}`, {}, 409);
  if (!git(top.out, ["rev-parse", "--verify", "--quiet", "HEAD"]).ok) {
    throw new CodecError("needs_checkpoint", `repository has no commits yet (agents branch from HEAD): ${top.out}`, {}, 409);
  }
  const projectName = name ?? basename(top.out).replace(/[^A-Za-z0-9._-]/g, "-");
  if (!PROJECT_NAME_RE.test(projectName)) {
    throw new CodecError("invalid_project_name", `invalid project name "${projectName}" (letters, digits, . _ - only)`, { name: projectName }, 400, suggestName(projectName, load().map((p) => p.name)));
  }

  const project: Project = { name: projectName, path: top.out, addedAt: new Date().toISOString() };
  withLock("projects", () => {
    const all = load();
    if (all.some((p) => p.name === projectName)) {
      throw new CodecError("project_exists", `a project named "${projectName}" already exists`, { name: projectName });
    }
    const dup = all.find((p) => p.path === top.out);
    if (dup) throw new CodecError("project_registered", `${top.out} is already registered as "${dup.name}"`, { name: dup.name });
    all.push(project);
    save(all);
  });
  logEvent("project.add", { project: projectName, path: top.out });
  return project;
}

export function listProjects(): Project[] {
  return load();
}

export function getProject(name: string): Project | undefined {
  return load().find((p) => p.name === name);
}

export function setProjectMessageLimit(name: string, value: number | undefined): Project {
  const messageLimit = checkMessageLimit(value);
  const updated = withLock("projects", () => {
    const all = load();
    const project = all.find((p) => p.name === name);
    if (!project) throw new CodecError("project_not_found", `no project named "${name}"`, { name }, 404);
    if (messageLimit === undefined) delete project.messageLimit;
    else project.messageLimit = messageLimit;
    save(all);
    return project;
  });
  logEvent("project.edit", { project: name, messageLimit: messageLimit ?? null });
  return updated;
}

export function setProjectTag(name: string, tag: { area?: ProjectArea; className?: string }): Project {
  return withLock("projects", () => {
    const all = load();
    const project = all.find((p) => p.name === name);
    if (!project) throw new CodecError("project_not_found", `no project named "${name}"`, { name }, 404);
    delete project.area;
    delete project.className;
    if (tag.area) project.area = tag.area;
    if (tag.className) project.className = tag.className;
    save(all);
    return project;
  });
}

/** Removes the project from Codec only — the repository itself is untouched. */
export function removeProject(name: string): Project {
  const removed = withLock("projects", () => {
    const all = load();
    const idx = all.findIndex((p) => p.name === name);
    if (idx === -1) throw new CodecError("project_not_found", `no project named "${name}"`, {}, 404);
    const [p] = all.splice(idx, 1);
    save(all);
    return p;
  });
  logEvent("project.remove", { project: name });
  return removed;
}
