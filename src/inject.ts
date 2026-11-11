/**
 * inject.ts — give a run exactly its member's skills and instructions.
 *
 * Skills are copied into the run's worktree where each tool looks for them:
 *   claude  .claude/skills/<name>/   (Claude Code project skills)
 *   codex   .agents/skills/<name>/   (Codex CLI's native repo skills)
 * Standing instructions are NOT written into the worktree at all; they are
 * handed to the CLI on its command line (claude --append-system-prompt,
 * codex -c developer_instructions=...). So the project's own CLAUDE.md /
 * AGENTS.md are never touched.
 *
 * Copied skill folders are listed in the repository's info/exclude file
 * (inside a marked block), so `git add -A` in the worktree never picks them
 * up and the agent's commits never contain them. The project's .gitignore is
 * never edited. A skill the project already ships under the same name wins:
 * Codec doesn't overwrite it and records that it came from the project.
 */

import { CodecError } from "./errors.js";
import { S, wording } from "./strings.js";
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { git } from "./registry.js";
import type { ResolvedMember, SkillSource } from "./org.js";
import { getSkill, parseFrontmatter } from "./skills.js";
import type { Agent } from "./tools.js";

export interface GivenSkill {
  name: string;
  source: SkillSource;
  description?: string;
  note?: string;
  /** Skill file when a project uses an older supported directory. */
  path?: string;
}

/** Where each tool reads project skills from (first entry is where Codec writes). */
export const SKILL_DIRS: Record<Agent, string[]> = {
  claude: [".claude/skills"],
  codex: [".agents/skills", ".codex/skills"],
};

const EXCLUDE_START = "# >>> codec: injected agent skills (managed by codec, safe to delete) >>>";
const EXCLUDE_END = "# <<< codec <<<";

/** Skills the project itself ships (committed in the repo) for this tool. */
export function projectSkills(worktree: string, tool: Agent): GivenSkill[] {
  const out: GivenSkill[] = [];
  for (const rel of SKILL_DIRS[tool]) {
    const dir = join(worktree, rel);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const md = join(dir, name, "SKILL.md");
      if (!existsSync(md) || out.some((s) => s.name === name)) continue;
      let description: string | undefined;
      try {
        description = parseFrontmatter(readFileSync(md, "utf-8")).description;
      } catch {
        // malformed project skill: still list it
      }
      out.push({ name, source: "project", description,
        ...(rel !== SKILL_DIRS[tool][0] ? { path: `${rel}/${name}/SKILL.md` } : {}),
      });
    }
  }
  return out;
}

/** Add lines to the repo's info/exclude, inside Codec's marked block, once each. */
export function addExcludes(worktree: string, patterns: string[]): string {
  const r = git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
  if (!r.ok) throw new CodecError("tracking_failed", `cannot locate git exclude file: ${r.err}`);
  const file = resolve(worktree, r.out);
  mkdirSync(dirname(file), { recursive: true });
  const text = existsSync(file) ? readFileSync(file, "utf-8") : "";
  const start = text.indexOf(EXCLUDE_START);
  const end = text.indexOf(EXCLUDE_END, start);
  if (start === -1 || end === -1) {
    const lines = [...new Set(patterns)];
    if (!lines.length) return file;
    appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}${EXCLUDE_START}\n${lines.join("\n")}\n${EXCLUDE_END}\n`);
    return file;
  }
  const block = text.slice(start + EXCLUDE_START.length, end).split("\n").map((l) => l.trim()).filter(Boolean);
  const missing = patterns.filter((p) => !block.includes(p));
  if (!missing.length) return file;
  const merged = [...block, ...new Set(missing)];
  writeFileSync(file, text.slice(0, start) + `${EXCLUDE_START}\n${merged.join("\n")}\n` + text.slice(end));
  return file;
}

/** The text handed to every agent as standing instructions. */
export function instructionsText(m: ResolvedMember | undefined, tool: Agent, skills: GivenSkill[]): string {
  const parts: string[] = [];
  if (skills.length) {
    parts.push([S.helperInstructions.skills, S.helperInstructions[tool], ...skills.map((skill) =>
      `- ${skill.name}: ${skill.description || S.helperInstructions.noDescription}${tool === "codex" ? ` (${skill.path ?? `.agents/skills/${skill.name}/SKILL.md`})` : ""}`)].join("\n"));
  }
  if (m) {
    parts.push(wording(m.kind === "clone" ? S.helperInstructions.role : S.helperInstructions.worker,
      { member: m.member, specialty: m.specialty ?? "", team: m.team, role: m.specialist ?? "" }));
    if (m.instructions) parts.push(`${S.helperInstructions.standing}\n${m.instructions}`);
    parts.push(S.helperInstructions.messages);
    parts.push(S.helperInstructions.sendMessage, S.helperInstructions.reportStatus);
  }
  parts.push(S.helperInstructions.attribution);
  return parts.join("\n\n") + "\n";
}

/**
 * Put the member's skills into the worktree. Returns the exact list of
 * skills the agent can see, each with where it came from.
 */
export function injectSkills(worktree: string, tool: Agent, skills: ResolvedMember["skills"]): GivenSkill[] {
  const given = projectSkills(worktree, tool);
  const projectNames = new Set(given.map((s) => s.name));
  const base = SKILL_DIRS[tool][0];
  const excludes: string[] = [];
  for (const s of skills) {
    const lib = getSkill(s.name);
    if (!lib) throw new CodecError("missing_skill", `skill "${s.name}" is no longer in the library — fix the member's skills and try again`, { name: s.name });
    if (projectNames.has(s.name)) {
      const p = given.find((g) => g.name === s.name)!;
      p.note = `also assigned via ${s.source}; the project's own copy is used`;
      continue;
    }
    cpSync(lib.path, join(worktree, base, s.name), { recursive: true });
    excludes.push(`/${base}/${s.name}/`);
    given.push({ name: s.name, source: s.source, description: lib.description });
  }
  if (excludes.length) addExcludes(worktree, excludes);
  return given;
}
