/**
 * events.ts — append-only JSONL log of lifecycle events (adapted from the
 * hive's events log). One line per event in $CODEC_HOME/events.jsonl.
 *
 * Never throws: the log observes the engine, it must not break it.
 * Note: `run.finish` lines are written by the run's own wrapper script
 * (see runs.ts), not by this module, because the codec process that started
 * the run is usually long gone by the time the agent finishes.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname } from "path";
import { eventsFile } from "./store.js";
import { redactValue } from "./secrets.js";

export type EventKind =
  | "project.add"
  | "project.remove"
  | "project.edit"
  | "run.start" // worktree created + agent spawned
  | "run.finish" // agent exited on its own (fields: exitCode)
  | "run.timeout" // time limit reached
  | "run.stop" // user stopped the run
  | "run.lost" // agent died without recording an exit code (killed, reboot)
  | "run.apply" // selected changes committed to the project branch
  | "run.discard" // review dismissed, branch kept
  | "run.clean" // worktree removed
  | "skill.add"
  | "skill.remove"
  | "specialist.add"
  | "specialist.edit"
  | "specialist.remove"
  | "team.add"
  | "team.edit"
  | "team.remove"
  | "member.edit"
  | "member.add"
  | "member.remove";

export interface CodecEvent {
  ts: string;
  kind: EventKind;
  [key: string]: unknown;
}

let warnedOnce = false;

export function logEvent(kind: EventKind, fields: Record<string, unknown> = {}): void {
  try {
    const file = eventsFile();
    mkdirSync(dirname(file), { recursive: true });
    const event: CodecEvent = { ts: new Date().toISOString(), kind, ...fields };
    appendFileSync(file, JSON.stringify(redactValue(event)) + "\n");
  } catch (e) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn(`[codec] failed to write event log (further failures silent):`, e);
    }
  }
}

/** Read every event; malformed lines are skipped rather than fatal. */
export function readEvents(): CodecEvent[] {
  const file = eventsFile();
  if (!existsSync(file)) return [];
  const out: CodecEvent[] = [];
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as CodecEvent);
    } catch {
      // skip
    }
  }
  return out;
}
