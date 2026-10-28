/** Stable engine failures. The technical message remains useful to the CLI and log. */
import type { ErrorCode } from "./strings.js";
export class CodecError extends Error {
  readonly detail: string;
  links?: { id: string; task: string }[];
  constructor(
    public readonly code: ErrorCode,
    detail: string,
    public readonly params: Record<string, string | number> = {},
    public readonly status = 400,
    public readonly suggestion?: string,
    options?: ErrorOptions,
  ) {
    super(detail, options);
    this.name = "CodecError";
    this.detail = detail;
  }
}

/** Derive a safe name and reserve room for collision suffixes. */
export function suggestName(input: string, taken: Iterable<string> = [], skill = false): string {
  const used = new Set(taken);
  let base = input.toLowerCase().trim().replace(/\s+/g, "-")
    .replace(skill ? /[^a-z0-9-]/g : /[^a-z0-9._-]/g, "")
    .replace(/^[^a-z0-9]+/, "").slice(0, 64);
  if (skill) base = base.replace(/-+$/, "");
  if (!base) base = skill ? "skill" : "helper";
  let candidate = base;
  for (let n = 2; used.has(candidate); n++) {
    const suffix = `-${n}`;
    candidate = base.slice(0, 64 - suffix.length).replace(/-+$/, "") + suffix;
  }
  return candidate;
}
