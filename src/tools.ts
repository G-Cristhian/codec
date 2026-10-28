/** tools.ts — the coding CLIs Codec can drive. */

import { CodecError } from "./errors.js";
export const AGENTS = ["claude", "codex"] as const;
export type Agent = (typeof AGENTS)[number];

export function checkTool(tool: string): Agent {
  if (!(AGENTS as readonly string[]).includes(tool)) throw new CodecError("invalid_tool", `unknown tool "${tool}" (use: ${AGENTS.join(", ")})`, { name: tool });
  return tool as Agent;
}
