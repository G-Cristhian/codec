/** Plain API errors; technical details stay in the local log. */
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { codecHome } from "./store.js";
import { CodecError } from "./errors.js";
import { S, wording, type ErrorCode } from "./strings.js";

/** HTTP validation also uses stable engine codes. */
export class ApiError extends CodecError {
  constructor(status: number, code: ErrorCode, detail: string, options?: ErrorOptions) {
    super(code, detail, {}, status, undefined, options);
  }
}
export interface ErrorEnvelope {
  error: string; code: ErrorCode; links?: { id: string; task: string }[]; params?: Record<string, string | number>; suggestion?: string;
}
export function friendlyError(error: unknown, route: string): { status: number; body: ErrorEnvelope } {
  let detail = error instanceof Error ? error.stack ?? error.message : String(error);
  if (error instanceof Error && error.cause) {
    detail += "\nCaused by: " + (error.cause instanceof Error ? error.cause.stack ?? error.cause.message : String(error.cause));
  }
  const code = error instanceof CodecError ? error.code : "unknown_error";
  const status = error instanceof CodecError ? error.status : 500;
  const params = error instanceof CodecError ? error.params : {};
  try {
    mkdirSync(codecHome(), { recursive: true });
    appendFileSync(join(codecHome(), "codec.log"), JSON.stringify({ ts: new Date().toISOString(), route, code, status, detail }) + "\n");
  } catch { /* A logging failure must not expose the original error. */ }
  return { status, body: {
    error: wording(S.errors[code], params), code,
    ...(error instanceof CodecError && error.links ? { links: error.links } : {}),
    ...(Object.keys(params).length ? { params } : {}),
    ...(error instanceof CodecError && error.suggestion ? { suggestion: error.suggestion } : {}),
  } };
}
