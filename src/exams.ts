import { statedTextLimits } from "@family-agenda/plugin-contract";
import { addDays, instantOf, isObject, localDate, text, type JsonObject, type MasterNames, type Stated } from "./timetable";

type StatedEvent = Extract<Stated, { kind: "event" }>;

/** An exam of the days read, as the event it is to the Family, on the day it takes place. */
export type SeenExam = { day: string; event: StatedEvent };

/** The parameters of `getExams2017` for a child's exams of `days` days from `today` (`YYYY-MM-DD`). */
export function examsRequest(childId: number, today: string, days: number): JsonObject {
  return { id: childId, type: "STUDENT", startDate: today, endDate: addDays(today, days - 1) };
}

/**
 * The exams Untis lists, such as a Klassenarbeit, each as an event titled by its subject and name,
 * in its room, by the id Untis gives the exam. An exam the school calls off is gone from the list.
 */
export function examsIn(result: JsonObject, names: MasterNames, timeZone: string): [string, SeenExam][] {
  const exams = (Array.isArray(result.exams) ? result.exams : []).filter(isObject);
  return exams.flatMap((exam): [string, SeenExam][] => {
    const start = instantOf(exam.startDateTime, timeZone);
    const end = instantOf(exam.endDateTime, timeZone);
    if (typeof exam.id !== "number" || !start || !end || end <= start) return [];
    const nameOf = (ids: unknown, from: Map<number, string>) =>
      (Array.isArray(ids) ? ids : []).flatMap((id) => (typeof id === "number" ? (from.get(id) ?? []) : []));
    const subject = typeof exam.subjectId === "number" ? (names.subjects.get(exam.subjectId) ?? null) : null;
    const name = text(exam.name) ?? text(exam.examType) ?? "Prüfung";
    const title = [subject ? `${subject}: ${name}` : name, text(exam.text)].filter(Boolean).join(" – ");
    const rooms = nameOf(exam.roomIds, names.rooms);
    const event: StatedEvent = {
      kind: "event",
      title: clip(title),
      span: { allDay: false, start: start.toISOString(), end: end.toISOString() },
      place: rooms.length === 0 ? null : clip(rooms.join(", ")),
      cancelled: false,
    };
    return [[`exam:${exam.id}`, { day: localDate(start, timeZone), event }]];
  });
}

/** A text cut to what an event keeps. */
function clip(value: string): string {
  const limit = statedTextLimits.event;
  return value.length <= limit ? value : value.slice(0, limit).trimEnd();
}
