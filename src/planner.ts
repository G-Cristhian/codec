/** Student planner data: classes, tags on tasks and projects, and hand-added calendar events. */
import { randomBytes } from "crypto";
import { join } from "path";
import { CodecError } from "./errors.js";
import { S } from "./strings.js";
import { codecHome, readJson, withLock, writeJsonAtomic } from "./store.js";

/** Tag on a task: what part of life it's for. */
const TASK_AREAS = ["school", "work", "personal"] as const;
export type TaskArea = (typeof TASK_AREAS)[number];

/** Tag on a project: one of the owner's classes, work or personal. */
const PROJECT_AREAS = ["class", "work", "personal"] as const;
export type ProjectArea = (typeof PROJECT_AREAS)[number];

const EVENT_KINDS = ["deadline", "meeting", "interview"] as const;
type EventKind = (typeof EVENT_KINDS)[number];

export interface CalendarEvent {
  id: string;
  title: string;
  /** YYYY-MM-DD, the owner's local day. */
  date: string;
  /** HH:MM, optional. */
  time?: string;
  kind: EventKind;
  createdAt: string;
}

const MAX_CLASSES = 30;
const MAX_EVENTS = 500;
const UNSAFE = /[\x00-\x1f\x7f<>]/;

export function cleanLabel(raw: unknown, max: number): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().replace(/\s+/g, " ");
  if (!v || v.length > max || UNSAFE.test(v)) return undefined;
  return v;
}

/** Class names: trimmed, unique (case-insensitive), at most 30, each 1–40 plain characters. */
export function checkClasses(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new CodecError("invalid_class", S.errors.invalid_class);
  const out: string[] = [];
  for (const item of raw) {
    const v = cleanLabel(item, 40);
    if (!v) throw new CodecError("invalid_class", S.errors.invalid_class);
    if (!out.some((c) => c.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  if (out.length > MAX_CLASSES) throw new CodecError("invalid_class", S.errors.invalid_class);
  return out;
}

export function checkTaskArea(raw: unknown): TaskArea | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "string" && (TASK_AREAS as readonly string[]).includes(raw)) return raw as TaskArea;
  throw new CodecError("invalid_area", S.errors.invalid_area);
}

export function checkProjectTag(area: unknown, className: unknown, classes: string[]): { area?: ProjectArea; className?: string } {
  if (area === undefined || area === null || area === "") return {};
  if (typeof area !== "string" || !(PROJECT_AREAS as readonly string[]).includes(area)) throw new CodecError("invalid_area", S.errors.invalid_area);
  if (area !== "class") return { area: area as ProjectArea };
  const name = cleanLabel(className, 40);
  const match = name && classes.find((c) => c.toLowerCase() === name.toLowerCase());
  if (!match) throw new CodecError("invalid_class", S.errors.invalid_class);
  return { area: "class", className: match };
}

// ---------- Calendar ----------

const calendarFile = () => join(codecHome(), "calendar.json");

function load(): CalendarEvent[] {
  return readJson<{ events: CalendarEvent[] }>(calendarFile(), { events: [] }).events;
}

export function listEvents(): CalendarEvent[] {
  return load().sort((a, b) => (a.date + (a.time ?? "")).localeCompare(b.date + (b.time ?? "")));
}

function validDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function addEvent(input: { title?: unknown; date?: unknown; time?: unknown; kind?: unknown }): CalendarEvent {
  const title = cleanLabel(input.title, 120);
  const date = typeof input.date === "string" && validDate(input.date) ? input.date : undefined;
  const time = input.time === undefined || input.time === "" ? undefined
    : typeof input.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(input.time) ? input.time : null;
  const kind = typeof input.kind === "string" && (EVENT_KINDS as readonly string[]).includes(input.kind) ? (input.kind as EventKind) : undefined;
  if (!title || !date || time === null || !kind) throw new CodecError("invalid_event", S.errors.invalid_event);
  const event: CalendarEvent = { id: "event-" + randomBytes(6).toString("hex"), title, date, ...(time ? { time } : {}), kind, createdAt: new Date().toISOString() };
  withLock("calendar", () => {
    const all = load();
    if (all.length >= MAX_EVENTS) throw new CodecError("invalid_event", S.errors.invalid_event);
    all.push(event);
    writeJsonAtomic(calendarFile(), { events: all });
  });
  return event;
}

export function removeEvent(id: string): CalendarEvent {
  return withLock("calendar", () => {
    const all = load();
    const i = all.findIndex((e) => e.id === id);
    if (i === -1) throw new CodecError("event_not_found", S.errors.event_not_found, {}, 404);
    const [gone] = all.splice(i, 1);
    writeJsonAtomic(calendarFile(), { events: all });
    return gone;
  });
}
