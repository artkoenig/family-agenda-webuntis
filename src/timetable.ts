import { statedTextLimits, type SourceRecord } from "@family-agenda/plugin-contract";

export type JsonObject = Record<string, unknown>;

type Stated = Extract<SourceRecord["content"], { kind: "stated" }>["stated"];
type StatedLesson = Extract<Stated, { kind: "lesson" }>;

/** A Lesson of the days read, on the Family's day it takes place. */
export type SeenLesson = { day: string; lesson: StatedLesson };

/** The Lessons of a Timetable, which Untis calls periods, with their Timetable Changes, by their ids. */
export function seenIn(result: JsonObject, timeZone: string): [string, SeenLesson][] {
  const master = isObject(result.masterData) ? result.masterData : {};
  const named = (list: unknown, name: (entry: JsonObject) => string | null) =>
    new Map(
      (Array.isArray(list) ? list : []).filter(isObject).flatMap((entry) => {
        const value = name(entry);
        return typeof entry.id === "number" && value ? [[entry.id, value] as const] : [];
      }),
    );
  const subjects = named(master.subjects, (subject) => text(subject.longName) ?? text(subject.name));
  const rooms = named(master.rooms, (room) => text(room.name) ?? text(room.longName));
  const teachers = named(master.teachers, (teacher) => {
    const full = [text(teacher.firstName), text(teacher.lastName)].filter(Boolean).join(" ");
    return full || text(teacher.name);
  });
  const timetable = isObject(result.timetable) ? result.timetable : {};
  const periods = (Array.isArray(timetable.periods) ? timetable.periods : []).filter(isObject);
  return periods.flatMap((period): [string, SeenLesson][] => {
    const start = instantOf(period.startDateTime, timeZone);
    const end = instantOf(period.endDateTime, timeZone);
    const elements = (Array.isArray(period.elements) ? period.elements : []).filter(isObject);
    const element = (type: string) => elements.find((candidate) => candidate.type === type);
    const nameOf = (type: string, names: Map<number, string>) => namesOf(element(type), names);
    const subject = nameOf("SUBJECT", subjects);
    if (typeof period.id !== "number" || !start || !end || end <= start || !subject.name) return [];
    const room = nameOf("ROOM", rooms);
    const teacher = nameOf("TEACHER", teachers);
    const flags = flagsOf(period.is);
    const change = changeOf(flags, { teacher, subject, room });
    const periodText = isObject(period.text) ? period.text : {};
    const lesson: StatedLesson = {
      kind: "lesson",
      subject: clip(subject.name),
      span: { allDay: false, start: start.toISOString(), end: end.toISOString() },
      room: clipOrNull(room.name),
      teacher: clipOrNull(teacher.name),
      change,
      previousRoom: change ? clipOrNull(room.previous) : null,
      previousTeacher: change ? clipOrNull(teacher.previous) : null,
      note: change ? clipOrNull(text(periodText.substitution) ?? text(periodText.info)) : null,
    };
    return [[String(period.id), { day: localDate(start, timeZone), lesson }]];
  });
}

type Names = { name: string | null; previous: string | null };

/** How a Lesson deviates from the Timetable: the flags Untis sets, or an element it substituted. */
function changeOf(flags: string[], elements: { teacher: Names; subject: Names; room: Names }): StatedLesson["change"] {
  if (flags.includes("CANCELLED")) return "cancellation";
  if (elements.teacher.previous || elements.subject.previous || flags.includes("SUBSTITUTION")) return "substitution";
  if (elements.room.previous || flags.includes("ROOM_SUBSTITUTION")) return "room-change";
  return null;
}

/** The element's name now, and before if it was substituted; Untis keeps the original's id as `orgId`. */
function namesOf(found: JsonObject | undefined, names: Map<number, string>): { name: string | null; previous: string | null } {
  const id = numberOf(found?.id);
  // An `orgId` of 0 means the element was not substituted.
  const orgId = numberOf(found?.orgId) || id;
  const nameFor = (key: number | null) => (key === null ? null : (names.get(key) ?? null));
  return { name: nameFor(id), previous: orgId === id ? null : nameFor(orgId) };
}

const numberOf = (value: unknown): number | null => (typeof value === "number" ? value : null);

/** What Untis says a Lesson is, such as `CANCELLED` or `IRREGULAR`, as a list or as flags. */
function flagsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((flag): flag is string => typeof flag === "string").map((flag) => flag.toUpperCase());
  if (isObject(value)) return Object.keys(value).filter((flag) => value[flag] === true).map((flag) => flag.toUpperCase());
  return [];
}

/** A text trimmed and cut to what a Lesson keeps. */
function clip(value: string): string {
  const trimmed = value.trim();
  const limit = statedTextLimits.lesson;
  return trimmed.length <= limit ? trimmed : trimmed.slice(0, limit).trimEnd();
}

const clipOrNull = (value: string | null): string | null => (value === null ? null : clip(value));

/**
 * The instant of a Lesson's time. Untis Mobile writes the school's wall-clock time with a `Z`, as
 * `2026-09-15T08:00Z`, whatever its offset from UTC, so the time is read in the Family's time zone.
 */
function instantOf(value: unknown, timeZone: string): Date | null {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value) : null;
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const wallClock = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (instant: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
      })
        .formatToParts(instant)
        .map((part) => [part.type, Number(part.value)]),
    ) as Record<string, number>;
    return Date.UTC(parts.year ?? 0, (parts.month ?? 1) - 1, parts.day, parts.hour, parts.minute) - instant;
  };
  // The offset at the wall-clock time read as UTC is right except near a change of offset,
  // where the offset at the first guess is.
  const guess = wallClock - offsetAt(wallClock);
  return new Date(wallClock - offsetAt(guess));
}

/** The date an instant shows in a time zone, as `YYYY-MM-DD`. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** The parameters of `getTimetable2017` for a child's Timetable of `days` days from `today` (`YYYY-MM-DD`). */
export function timetableRequest(childId: number, today: string, days: number): JsonObject {
  const untisDate = (date: string) => Number(date.replaceAll("-", ""));
  return {
    id: childId,
    type: "STUDENT",
    startDate: untisDate(today),
    endDate: untisDate(addDays(today, days - 1)),
    masterDataTimestamp: 0,
    timetableTimestamp: 0,
    timetableTimestamps: [],
  };
}

function addDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

export function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
