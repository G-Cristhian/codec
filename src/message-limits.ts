import { CodecError } from "./errors.js";
import { S } from "./strings.js";

export const DEFAULT_MESSAGE_LIMIT = 10;

export function checkMessageLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) {
    throw new CodecError("invalid_message_limit", S.errors.invalid_message_limit);
  }
  return value;
}
