/**
 * skills.ts — the skill library.
 *
 * A skill is a folder with a SKILL.md in the Claude Code format:
 *
 *   ---
 *   name: my-skill
 *   description: what it does and when to use it
 *   ---
 *   instructions...
 *
 * It may contain extra files. Codec keeps its own copy of every imported
 * skill in $CODEC_HOME/skills/<name>/, so later edits to the original folder
 * don't silently change what agents get.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join, normalize, resolve, sep } from "path";
import { randomBytes } from "crypto";
import { logEvent } from "./events.js";
import { skillsDir, withLock } from "./store.js";

export interface SkillInfo {
  name: string;
  description: string;
  path: string; // folder holding SKILL.md
  files: string[]; // relative paths of every file in the skill
}

/** Claude Code's rule for skill names. */
export const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_SKILL_BYTES = 5 * 1024 * 1024;
const MAX_SKILL_FILES = 200;

/**
 * Parse the YAML frontmatter of a SKILL.md. Supports the subset skills use:
 * `key: value`, quoted values, and `key: |` / `key: >` blocks.
 */
export function parseFrontmatter(text: string): Record<string, string> {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") throw new Error("SKILL.md must start with a '---' frontmatter block");
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end === -1) throw new Error("SKILL.md frontmatter is not closed with '---'");
  const out: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let value = m[2].trim();
    if (value === "|" || value === ">" || value === "|-" || value === ">-" || value === "") {
      const block: string[] = [];
      while (i + 1 < end && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) block.push(lines[++i].trim());
      value = block.join(value.startsWith("|") ? "\n" : " ").trim();
    } else if (/^(["']).*\1$/.test(value)) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      const r = rel ? `${rel}/${entry}` : entry;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) throw new Error(`skills may not contain symbolic links (${r})`);
      if (st.isDirectory()) walk(abs, r);
      else if (st.isFile()) out.push(r);
    }
  };
  walk(root, "");
  return out.sort();
}

/** Check a folder is a valid skill; returns its name and description. */
export function validateSkillFolder(folder: string): { name: string; description: string; files: string[] } {
  const abs = resolve(folder);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`not a folder: ${abs}`);
  const md = join(abs, "SKILL.md");
  if (!existsSync(md)) throw new Error(`no SKILL.md in ${abs}`);
  const fm = parseFrontmatter(readFileSync(md, "utf-8"));
  const name = fm.name?.trim();
  const description = fm.description?.trim();
  if (!name) throw new Error("SKILL.md frontmatter needs a 'name'");
  if (!description) throw new Error("SKILL.md frontmatter needs a 'description'");
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(`invalid skill name "${name}" (lowercase letters, digits and hyphens, up to 64 characters)`);
  }
  const files = listFiles(abs);
  if (files.length > MAX_SKILL_FILES) throw new Error(`skill has too many files (${files.length}, max ${MAX_SKILL_FILES})`);
  const size = files.reduce((n, f) => n + statSync(join(abs, f)).size, 0);
  if (size > MAX_SKILL_BYTES) throw new Error(`skill is too large (${size} bytes, max ${MAX_SKILL_BYTES})`);
  return { name, description, files };
}

export function getSkill(name: string): SkillInfo | undefined {
  if (!SKILL_NAME_RE.test(name)) return undefined;
  const path = join(skillsDir(), name);
  if (!existsSync(join(path, "SKILL.md"))) return undefined;
  try {
    const v = validateSkillFolder(path);
    return { name, description: v.description, path, files: v.files };
  } catch {
    return undefined;
  }
}

export function listSkills(): SkillInfo[] {
  if (!existsSync(skillsDir())) return [];
  return readdirSync(skillsDir())
    .filter((n) => !n.startsWith("."))
    .map((n) => getSkill(n))
    .filter((s): s is SkillInfo => !!s)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Copy a skill folder into the library. Refuses invalid skills and duplicates. */
export function importSkill(folder: string): SkillInfo {
  const src = resolve(folder);
  const v = validateSkillFolder(src);
  if (src === join(skillsDir(), v.name) || src.startsWith(skillsDir() + sep)) {
    throw new Error("that folder is already inside the Codec skill library");
  }
  return withLock("org", () => {
    const dest = join(skillsDir(), v.name);
    if (existsSync(dest)) throw new Error(`a skill named "${v.name}" already exists — remove it first to replace it`);
    mkdirSync(skillsDir(), { recursive: true });
    const tmp = join(skillsDir(), `.import-${randomBytes(4).toString("hex")}`);
    try {
      cpSync(src, tmp, { recursive: true });
      renameSync(tmp, dest);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    logEvent("skill.add", { skill: v.name, from: src });
    return getSkill(v.name)!;
  });
}

/** Import from uploaded files ({path, content(base64)}) — used by the dashboard. */
export function importSkillFiles(files: { path: string; content: string }[], stagingRoot: string): SkillInfo {
  if (!files.length) throw new Error("no files uploaded");
  if (files.length > MAX_SKILL_FILES) throw new Error(`too many files (max ${MAX_SKILL_FILES})`);
  // Browsers send "<folder>/<file>"; strip a shared top folder.
  const parts = files.map((f) => f.path.replace(/\\/g, "/").replace(/^\/+/, "").split("/"));
  const top = parts[0][0];
  const strip = parts.every((p) => p.length > 1 && p[0] === top) ? 1 : 0;
  const dir = join(stagingRoot, `upload-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  try {
    files.forEach((f, i) => {
      const rel = parts[i].slice(strip).join("/");
      const target = normalize(join(dir, rel));
      if (!rel || !target.startsWith(dir + sep) || rel.split("/").includes("..")) {
        throw new Error(`invalid file path in upload: ${f.path}`);
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(f.content, "base64"));
    });
    return importSkill(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Delete a skill from the library folder (callers also unassign it — see org.ts). */
export function deleteSkillFolder(name: string): void {
  if (!getSkill(name)) throw new Error(`no skill named "${name}"`);
  rmSync(join(skillsDir(), name), { recursive: true, force: true });
}
