/** Shared time-limit validation and plain-language duration formatting. */

import { CodecError } from "./errors.js";
export const DEFAULT_TIME_LIMIT_MINUTES = 60;

export function checkTimeLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1440) {
    throw new CodecError("invalid_time_limit", "time limit must be a positive number of minutes, at most 1440 (24 hours)");
  }
  return value;
}

export function formatTimeLimit(minutes: number | undefined): string {
  if (minutes === undefined) return "No time limit";
  const seconds = Number((minutes * 60).toPrecision(8));
  const value = seconds < 60 ? seconds : Number(minutes.toPrecision(8));
  const unit = seconds < 60 ? "second" : "minute";
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}
