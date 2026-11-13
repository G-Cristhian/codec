/**
 * harness.ts — each team agent's own harness, kept in its own folder:
 *
 *   $CODEC_HOME/agents/<team>/<agent>/instructions.md   its standing instructions
 *   $CODEC_HOME/agents/<team>/<agent>/harness.json      access, permission rules,
 *                                                       settings isolation, MCP servers
 *
 * The folder is the source of truth: Codec reads it at the start of every task,
 * so editing the files by hand works too. MCP environment values can hold tokens,
 * so the folder and files are private to the owner (0700 / 0600).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { CodecError } from "./errors.js";
import { S } from "./strings.js";
import { codecHome, readJson, writeJsonAtomic } from "./store.js";

/** full: anything (today's behaviour) · edit: files + commands, no web · read: read + web only · custom: owner's rules. */
const ACCESS_LEVELS = ["full", "edit", "read", "custom"] as const;
export type Access = (typeof ACCESS_LEVELS)[number];

interface McpServer {
  name: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}
export interface Harness {
  access: Access;
  /** Claude permission rules, e.g. "Bash(npm test:*)"; used with access "custom". */
  allow: string[];
  deny: string[];
  /** Claude only: ignore the owner's personal Claude settings, hooks and MCP servers. */
  isolated: boolean;
  mcp: McpServer[];
}
export const DEFAULT_HARNESS: Harness = { access: "full", allow: [], deny: [], isolated: false, mcp: [] };

export const agentDir = (team: string, member: string): string => join(codecHome(), "agents", team, member);
const harnessFile = (team: string, member: string) => join(agentDir(team, member), "harness.json");
const instructionsFile = (team: string, member: string) => join(agentDir(team, member), "instructions.md");

export function readHarness(team: string, member: string): Harness {
  let saved: Partial<Harness> = {};
  try { saved = readJson<Partial<Harness>>(harnessFile(team, member), {}) ?? {}; } catch { /* A hand-edited file that isn't valid JSON: use the defaults. */ }
  return {
    access: (ACCESS_LEVELS as readonly string[]).includes(saved.access as string) ? (saved.access as Access) : "full",
    allow: Array.isArray(saved.allow) ? saved.allow.filter((x) => typeof x === "string") : [],
    deny: Array.isArray(saved.deny) ? saved.deny.filter((x) => typeof x === "string") : [],
    isolated: saved.isolated === true,
    mcp: Array.isArray(saved.mcp) ? saved.mcp.filter((s) => s && typeof s.name === "string") : [],
  };
}
export function readInstructions(team: string, member: string): string {
  try { return readFileSync(instructionsFile(team, member), "utf8").trim(); } catch { return ""; }
}

// ---------- validation ----------

const RULE_RE = /^[A-Za-z_][A-Za-z0-9_]*(\([^\n()]{1,200}\))?$/;
const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function rules(raw: unknown): string[] {
  if (raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split("\n") : null;
  if (!list) throw new CodecError("invalid_harness", S.errors.invalid_harness);
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") throw new CodecError("invalid_harness", S.errors.invalid_harness);
    const v = item.trim();
    if (!v) continue;
    if (!RULE_RE.test(v)) throw new CodecError("invalid_rule", S.errors.invalid_rule, { rule: v });
    if (!out.includes(v)) out.push(v);
  }
  return out.slice(0, 100);
}

/** Checks MCP servers; a blank env value keeps the value already saved (so tokens never round-trip to the page). */
function servers(raw: unknown, before: McpServer[]): McpServer[] {
  if (raw === undefined) return before;
  if (!Array.isArray(raw)) throw new CodecError("invalid_harness", S.errors.invalid_harness);
  const out: McpServer[] = [];
  for (const item of raw.slice(0, 20)) {
    const o = (item ?? {}) as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!MCP_NAME_RE.test(name) || out.some((s) => s.name === name)) throw new CodecError("invalid_mcp", S.errors.invalid_mcp, { name });
    const type = o.type === "http" ? "http" : "stdio";
    const server: McpServer = { name, type };
    if (type === "http") {
      const url = typeof o.url === "string" ? o.url.trim() : "";
      if (!/^https?:\/\/[^\s]+$/.test(url)) throw new CodecError("invalid_mcp", S.errors.invalid_mcp, { name });
      server.url = url;
    } else {
      const command = typeof o.command === "string" ? o.command.trim() : "";
      if (!command || command.length > 500 || /[\n\0]/.test(command)) throw new CodecError("invalid_mcp", S.errors.invalid_mcp, { name });
      server.command = command;
      const args = Array.isArray(o.args) ? o.args : typeof o.args === "string" ? o.args.split("\n") : [];
      server.args = args.map((a) => (typeof a === "string" ? a.trim() : "")).filter(Boolean).slice(0, 50);
      if (server.args.some((a) => a.length > 1000 || a.includes("\0"))) throw new CodecError("invalid_mcp", S.errors.invalid_mcp, { name });
    }
    const old = before.find((s) => s.name === name)?.env ?? {};
    const env: Record<string, string> = {};
    if (o.env && typeof o.env === "object") {
      for (const [k, v] of Object.entries(o.env as Record<string, unknown>)) {
        if (!ENV_KEY_RE.test(k) || typeof v !== "string" || v.length > 4000 || v.includes("\0")) throw new CodecError("invalid_mcp", S.errors.invalid_mcp, { name });
        env[k] = v === "" && k in old ? old[k] : v;
      }
    }
    if (Object.keys(env).length) server.env = env;
    out.push(server);
  }
  return out;
}

export interface HarnessInput {
  instructions?: unknown;
  access?: unknown;
  allow?: unknown;
  deny?: unknown;
  isolated?: unknown;
  mcp?: unknown;
}

/** Validate a change against what's saved. Undefined fields are kept. Nothing is written. */
export function checkHarness(team: string, member: string, input: HarnessInput): { harness: Harness; instructions?: string } {
  const before = readHarness(team, member);
  if (input.access !== undefined && !(ACCESS_LEVELS as readonly string[]).includes(input.access as string)) {
    throw new CodecError("invalid_harness", S.errors.invalid_harness);
  }
  if (input.instructions !== undefined && (typeof input.instructions !== "string" || input.instructions.length > 50_000)) {
    throw new CodecError("invalid_harness", S.errors.invalid_harness);
  }
  return {
    harness: {
      access: (input.access as Access | undefined) ?? before.access,
      allow: input.allow === undefined ? before.allow : rules(input.allow),
      deny: input.deny === undefined ? before.deny : rules(input.deny),
      isolated: input.isolated === undefined ? before.isolated : input.isolated === true,
      mcp: servers(input.mcp, before.mcp),
    },
    instructions: input.instructions === undefined ? undefined : (input.instructions as string).trim(),
  };
}

export function writeHarness(team: string, member: string, change: { harness: Harness; instructions?: string }): void {
  const dir = agentDir(team, member);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeJsonAtomic(harnessFile(team, member), change.harness);
  chmodSync(harnessFile(team, member), 0o600);
  if (change.instructions !== undefined) writeFileSync(instructionsFile(team, member), change.instructions ? change.instructions + "\n" : "", { mode: 0o600 });
}

export function removeAgentDir(team: string, member?: string): void {
  const dir = member ? agentDir(team, member) : join(codecHome(), "agents", team);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/** What the page may see: env values are never sent back, only their names. */
export function publicHarness(h: Harness) {
  return { ...h, mcp: h.mcp.map((s) => ({ ...s, env: Object.fromEntries(Object.keys(s.env ?? {}).map((k) => [k, ""])) })) };
}

// ---------- applying it to a run ----------

/** Codec's own helper commands, which every agent must be able to run to message and report. */
const CODEC_COMMANDS = ['Bash("$CODEC_NODE" "$CODEC_CLI" message:*)', 'Bash("$CODEC_NODE" "$CODEC_CLI" report:*)'];
const PRESETS: Record<Exclude<Access, "full" | "custom">, { allow: string[]; deny: string[] }> = {
  edit: { allow: ["Read", "Glob", "Grep", "LS", "Edit", "MultiEdit", "Write", "NotebookEdit", "Bash", "TodoWrite", "Task", "Skill"], deny: ["WebFetch", "WebSearch"] },
  read: { allow: ["Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "TodoWrite", "Skill", ...CODEC_COMMANDS], deny: ["Edit", "MultiEdit", "Write", "NotebookEdit"] },
};

/** Claude: the permission rules for its --settings file. */
export function claudePermissions(h: Harness): { allow: string[]; deny: string[] } | undefined {
  if (h.access === "full") return undefined;
  const base = h.access === "custom" ? { allow: [...h.allow, ...CODEC_COMMANDS], deny: h.deny } : PRESETS[h.access];
  return { allow: [...new Set([...base.allow, ...h.mcp.map((s) => `mcp__${s.name}`)])], deny: base.deny };
}

/** Claude's --mcp-config file contents. */
export function claudeMcpConfig(h: Harness) {
  return {
    mcpServers: Object.fromEntries(h.mcp.map((s) => [s.name, s.type === "http"
      ? { type: "http", url: s.url, ...(s.env ? { headers: s.env } : {}) }
      : { type: "stdio", command: s.command, args: s.args ?? [], ...(s.env ? { env: s.env } : {}) }])),
  };
}

/** Codex `-c key=value` overrides, as [key, TOML value] pairs. JSON strings and arrays are valid TOML. */
export function codexOverrides(h: Harness): [string, string][] {
  const out: [string, string][] = [];
  for (const s of h.mcp) {
    const key = `mcp_servers.${s.name}`;
    if (s.type === "http") out.push([`${key}.url`, JSON.stringify(s.url)]);
    else {
      out.push([`${key}.command`, JSON.stringify(s.command)], [`${key}.args`, JSON.stringify(s.args ?? [])]);
      if (s.env) out.push([`${key}.env`, "{ " + Object.entries(s.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", ") + " }"]);
    }
  }
  return out;
}

/** The Codex sandbox for an access level (Codex has no per-tool rules). */
export function codexSandbox(access: Access): "full" | "workspace-write" | "read-only" {
  return access === "full" || access === "custom" ? "full" : access === "edit" ? "workspace-write" : "read-only";
}
