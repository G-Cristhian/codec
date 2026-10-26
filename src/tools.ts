/** tools.ts — the coding CLIs Codec can drive. */
export const AGENTS = ["claude", "codex"] as const;
export type Agent = (typeof AGENTS)[number];

export function checkTool(tool: string): Agent {
  if (!(AGENTS as readonly string[]).includes(tool)) throw new Error(`unknown tool "${tool}" (use: ${AGENTS.join(", ")})`);
  return tool as Agent;
}
