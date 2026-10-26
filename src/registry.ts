/**
 * registry.ts — the list of projects Codec manages.
 * Stored in $CODEC_HOME/projects.json; every write happens under a lock so
 * two `codec project add` commands at once can't lose each other's entry.
 */

import { spawnSync } from "child_process";
import { existsSync, statSync } from "fs";
import { basename, resolve } from "path";
import { logEvent } from "./events.js";
import { projectsFile, readJson, withLock, writeJsonAtomic } from "./store.js";

export interface Project {
  name: string;
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
    throw new Error(`not a directory: ${abs}`);
  }
  const top = git(abs, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) throw new Error(`not a git repository: ${abs}`);
  if (!git(top.out, ["rev-parse", "--verify", "--quiet", "HEAD"]).ok) {
    throw new Error(`repository has no commits yet (agents branch from HEAD): ${top.out}`);
  }
  const projectName = name ?? basename(top.out).replace(/[^A-Za-z0-9._-]/g, "-");
  if (!PROJECT_NAME_RE.test(projectName)) {
    throw new Error(`invalid project name "${projectName}" (letters, digits, . _ - only)`);
  }

  const project: Project = { name: projectName, path: top.out, addedAt: new Date().toISOString() };
  withLock("projects", () => {
    const all = load();
    if (all.some((p) => p.name === projectName)) {
      throw new Error(`a project named "${projectName}" already exists`);
    }
    const dup = all.find((p) => p.path === top.out);
    if (dup) throw new Error(`${top.out} is already registered as "${dup.name}"`);
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

/** Removes the project from Codec only — the repository itself is untouched. */
export function removeProject(name: string): Project {
  const removed = withLock("projects", () => {
    const all = load();
    const idx = all.findIndex((p) => p.name === name);
    if (idx === -1) throw new Error(`no project named "${name}"`);
    const [p] = all.splice(idx, 1);
    save(all);
    return p;
  });
  logEvent("project.remove", { project: name });
  return removed;
}
