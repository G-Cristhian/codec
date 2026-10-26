/**
 * claude-stream.ts — read Claude Code's `--output-format stream-json` output.
 *
 * Claude runs write one JSON event per line. Codec keeps that raw file (so
 * Skill tool calls can be detected exactly) and turns it into readable text
 * whenever it is shown (`codec logs`, the run page). Lines that aren't JSON
 * (e.g. a crash message) are shown as they are.
 */

interface Block {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  is_error?: boolean;
  content?: unknown;
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  model?: string;
  message?: { content?: Block[] | string };
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
  num_turns?: number;
}

function parse(line: string): StreamEvent | undefined {
  const t = line.trim();
  if (!t.startsWith("{")) return undefined;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" ? (v as StreamEvent) : undefined;
  } catch {
    return undefined;
  }
}

const short = (s: string, n = 160) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
};

/** The skill a Skill tool call asked for (the input key has varied across versions). */
function skillName(input: Record<string, unknown> | undefined): string | undefined {
  for (const k of ["skill", "command", "name"]) {
    const v = input?.[k];
    if (typeof v === "string" && v.trim()) return v.trim().replace(/^\//, "");
  }
  return undefined;
}

function describeTool(b: Block): string {
  const input = b.input ?? {};
  if (b.name === "Skill") return `→ Skill: ${skillName(input) ?? "?"}`;
  const pick = ["command", "file_path", "path", "pattern", "url", "description", "prompt"].find(
    (k) => typeof input[k] === "string",
  );
  return `→ ${b.name}${pick ? `: ${short(String(input[pick]))}` : ""}`;
}

export function renderClaudeStream(raw: string): string {
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const ev = parse(line);
    if (!ev || !ev.type) {
      out.push(line);
      continue;
    }
    if (ev.type === "system" && ev.subtype === "init") {
      out.push(`[claude started${ev.model ? ` — model ${ev.model}` : ""}]`);
    } else if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
      for (const b of ev.message!.content as Block[]) {
        if (b.type === "text" && b.text?.trim()) out.push(b.text.trimEnd());
        else if (b.type === "tool_use") out.push(describeTool(b));
      }
    } else if (ev.type === "user" && Array.isArray(ev.message?.content)) {
      for (const b of ev.message!.content as Block[]) {
        if (b.type === "tool_result" && b.is_error) {
          const c = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
          out.push(`  ✗ ${short(c)}`);
        }
      }
    } else if (ev.type === "result") {
      const secs = ev.duration_ms !== undefined ? ` in ${Math.round(ev.duration_ms / 1000)}s` : "";
      out.push(`[claude finished${ev.is_error ? " with an error" : ""}${secs}]`);
      if (ev.is_error && ev.result) out.push(ev.result);
    }
  }
  return out.join("\n") + (out.length ? "\n" : "");
}

/** Names of every skill Claude invoked via its Skill tool, in order, without repeats. */
export function skillCallsFromClaudeStream(raw: string): string[] {
  const names: string[] = [];
  for (const line of raw.split("\n")) {
    const ev = parse(line);
    if (ev?.type !== "assistant" || !Array.isArray(ev.message?.content)) continue;
    for (const b of ev.message!.content as Block[]) {
      if (b.type === "tool_use" && b.name === "Skill") {
        const n = skillName(b.input);
        if (n && !names.includes(n)) names.push(n);
      }
    }
  }
  return names;
}
