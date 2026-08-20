import { randomUUID } from "node:crypto";
import type { LeavePeriod, Schedule } from "../../shared/types.js";

/**
 * When a watcher is allowed to speak, expressed as data rather than as prose in
 * its brief.
 *
 * Every rule here started life as a paragraph pasted into a schedule's prompt by
 * hand: "if today is Saturday, respond with exactly: NOTHING TO REPORT", and a
 * hard-coded pair of leave dates underneath it. That worked, in the narrow sense
 * that the agent did stay quiet — but it still spawned, still cost a run, still
 * counted against the watcher's back-off, and had to be pasted again into every
 * new schedule by someone who remembered. By the fourth copy the dates had been
 * duplicated four times and would expire silently.
 *
 * Everything below is pure: no clock of its own, no store, no agent. `now` is
 * always passed in, and days are computed in local time on purpose — the rules
 * are about the user's week, not UTC's.
 */

export const SUNDAY = 0;
export const SATURDAY = 6;

/** Monday to Friday, the common case. */
export const WEEKDAYS = [1, 2, 3, 4, 5];

/** Day names accepted from tools and shown back to the user. */
export const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type DayName = (typeof DAY_NAMES)[number];

/** How far ahead we will search for a day a suppressed watcher may run. */
const MAX_SKIP_DAYS = 400;

export function dayIndexOf(name: string): number | undefined {
    const index = DAY_NAMES.indexOf(name.trim().slice(0, 3).toLowerCase() as DayName);
    return index === -1 ? undefined : index;
}

/** `[1,2,3,4,5]` → `"mon-fri"`, and anything less tidy listed out. */
export function describeDays(days: number[]): string {
    const unique = [...new Set(days)].filter((day) => day >= 0 && day <= 6).sort((a, b) => a - b);
    if (unique.length === 0) return "never";
    if (unique.length === 7) return "every day";
    const contiguous = unique.every((day, index) => index === 0 || day === unique[index - 1] + 1);
    if (contiguous && unique.length > 2) {
        return `${DAY_NAMES[unique[0]]}-${DAY_NAMES[unique[unique.length - 1]]}`;
    }
    return unique.map((day) => DAY_NAMES[day]).join(", ");
}

/** Local calendar day as `YYYY-MM-DD`. Matches `localDay` in schedules.ts. */
export function dayKey(when: number): string {
    const date = new Date(when);
    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0"),
    ].join("-");
}

/** Is `YYYY-MM-DD` a date we can actually use? */
export function isDayKey(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return false;
    const [year, month, day] = value.trim().split("-").map(Number);
    if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    const date = new Date(year, month - 1, day);
    return date.getMonth() === month - 1 && date.getDate() === day;
}

/**
 * The leave period covering `when`, if there is one.
 *
 * Compared as day strings rather than timestamps: leave is a run of calendar
 * days in the user's own timezone, and "am I off today" should not turn on what
 * hour it is or which side of UTC midnight the machine happens to be.
 */
export function onLeave(leave: LeavePeriod[], when: number): LeavePeriod | undefined {
    const today = dayKey(when);
    return leave.find((period) => {
        // Tolerate a period stored back to front rather than silently ignoring it.
        const from = period.from <= period.to ? period.from : period.to;
        const to = period.from <= period.to ? period.to : period.from;
        return today >= from && today <= to;
    });
}

export type SuppressionReason = "day" | "leave";

export interface Suppression {
    reason: SuppressionReason;
    /** One short phrase for the log and for telling the user why nothing ran. */
    detail: string;
}

/**
 * Why this watcher must not run at `when`, or undefined if it may.
 *
 * Day rules are checked before leave purely so the message is the more specific
 * one: a Saturday inside a fortnight off reads better as "does not run sat".
 */
export function suppressionAt(
    schedule: Pick<Schedule, "runDays" | "skipOnLeave">,
    leave: LeavePeriod[],
    when: number,
): Suppression | undefined {
    const days = schedule.runDays;
    if (days && days.length > 0 && !days.includes(new Date(when).getDay())) {
        return { reason: "day", detail: `only runs ${describeDays(days)}` };
    }
    if (schedule.skipOnLeave) {
        const period = onLeave(leave, when);
        if (period) {
            return { reason: "leave", detail: `on leave ${period.from} to ${period.to}` };
        }
    }
    return undefined;
}

/** Does this watcher carry any suppression rules at all? */
export function hasSuppression(schedule: Pick<Schedule, "runDays" | "skipOnLeave">): boolean {
    return (schedule.runDays !== undefined && schedule.runDays.length > 0) || schedule.skipOnLeave === true;
}

/** Local midnight at the start of the day after `when`. */
export function startOfNextDay(when: number): number {
    const date = new Date(when);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + 1);
    return date.getTime();
}

/**
 * The first moment at or after `candidate` that this watcher is allowed to run.
 *
 * Suppressed candidates jump to the start of the next day rather than stepping
 * by the cadence: a 15 minute watcher facing an 18 day leave would otherwise
 * need seventeen hundred steps to find its way out, and the answer is the same.
 * `slotFor` puts a daily watcher back on its own slot once it lands on a day it
 * may run, so a briefing due at 08:00 does not come back at midnight.
 */
export function nextAllowedRun(
    schedule: Pick<Schedule, "runDays" | "skipOnLeave">,
    leave: LeavePeriod[],
    candidate: number,
    slotFor?: (dayStart: number) => number,
): number {
    let at = candidate;
    for (let guard = 0; guard < MAX_SKIP_DAYS; guard += 1) {
        if (!suppressionAt(schedule, leave, at)) return at;
        const dayStart = startOfNextDay(at);
        at = slotFor ? slotFor(dayStart) : dayStart;
    }
    // Suppressed for more than a year: something is wrong with the rules, and
    // silently looping forever would be worse than one late run.
    return at;
}

/** The suppression rules in one phrase, for the schedule list. Empty when none. */
export function describeSuppression(schedule: Pick<Schedule, "runDays" | "skipOnLeave">): string {
    const parts: string[] = [];
    if (schedule.runDays && schedule.runDays.length > 0) parts.push(describeDays(schedule.runDays));
    if (schedule.skipOnLeave) parts.push("not on leave");
    return parts.join(", ");
}

/**
 * Day names from a tool call turned into indices.
 *
 * Returns an `Error` rather than throwing or quietly dropping a typo: a
 * misspelt day that silently became "every day" would look like the rule was
 * applied when it was not, which is the failure mode that is hardest to notice.
 */
export function parseRunDays(days: string[] | undefined): number[] | undefined | Error {
    if (days === undefined) return undefined;
    const parsed: number[] = [];
    for (const name of days) {
        const index = dayIndexOf(name);
        if (index === undefined) {
            return new Error(`"${name}" is not a day. Use ${DAY_NAMES.join(", ")}.`);
        }
        parsed.push(index);
    }
    return [...new Set(parsed)].sort((a, b) => a - b);
}

export function makeLeavePeriod(from: string, to: string, note?: string): LeavePeriod {    const ordered = from <= to ? [from, to] : [to, from];
    return { id: randomUUID(), from: ordered[0], to: ordered[1], note };
}

// MARK: - Migrating the prose

/**
 * What a brief was trying to say before suppression was a property.
 *
 * The four schedules already on disk each carry some variant of "FIRST, SILENCE
 * CHECKS: 1. If today is Saturday, respond with exactly: NOTHING TO REPORT",
 * and shipping the property without reading them would leave the old prose in
 * charge — which is to say, would ship nothing at all for the schedules that
 * actually motivated this.
 */
export interface DerivedSuppression {
    runDays?: number[];
    skipOnLeave?: boolean;
    /** Leave dates found in the prose, so they survive being deleted from it. */
    leave?: { from: string; to: string };
}

/** Words that turn a day mention into a judgement call rather than a rule. */
const CONDITIONAL = /\b(only report if|only if|unless|except|if there is something|genuinely time-critical)\b/i;

const LEAVE_WORDS = /\b(on leave|annual leave|out[- ]of[- ]office|out of office|oof|vacation|pto)\b/i;

const DAY_PATTERNS: Array<{ day: number; test: RegExp }> = [
    { day: SATURDAY, test: /\bsaturdays?\b/i },
    { day: SUNDAY, test: /\bsundays?\b/i },
];

/** "the weekend" as a whole, which the prose also uses. */
const WEEKEND = /\bweekends?\b/i;

const SILENCE = /NOTHING TO REPORT/gi;

/**
 * Where one instruction ends and the next begins: a newline, or the start of a
 * new numbered item. These briefs come in both shapes — some are written as a
 * numbered list on separate lines, some as a single long paragraph with "1. …
 * 2. … 3. …" run together — and the rule has to survive both.
 */
const INSTRUCTION_BREAK = /\n+|(?<=[.!])\s+(?=\d+[.)]\s)/;

/**
 * Read a brief's silence rules back out as data.
 *
 * Works by looking at the instruction immediately *before* each "NOTHING TO
 * REPORT", which is where its condition always sits. Each window stops at the
 * previous match so two rules cannot bleed into one another, and is then cut
 * back to its final instruction — without that last step the daily briefing's
 * trailing "Keep any Sunday report to three lines" was read as part of the
 * *next* rule and silenced Sundays, which is precisely backwards.
 *
 * Deliberately conservative: a day is only suppressed when its mention is an
 * unconditional instruction to say nothing. The briefing's "if today is Sunday,
 * only report if there is something genuinely time-critical" must keep running
 * on Sundays, and it does.
 */
export function deriveSuppression(task: string): DerivedSuppression {
    const derived: DerivedSuppression = {};
    const suppressed = new Set<number>();

    let cursor = 0;
    SILENCE.lastIndex = 0;
    for (let match = SILENCE.exec(task); match; match = SILENCE.exec(task)) {
        const segments = task.slice(cursor, match.index).split(INSTRUCTION_BREAK);
        const window = segments[segments.length - 1] ?? "";
        cursor = match.index + match[0].length;
        if (CONDITIONAL.test(window)) continue;

        if (WEEKEND.test(window)) {
            suppressed.add(SATURDAY);
            suppressed.add(SUNDAY);
        }
        for (const { day, test } of DAY_PATTERNS) {
            if (test.test(window)) suppressed.add(day);
        }
        if (LEAVE_WORDS.test(window)) derived.skipOnLeave = true;
    }

    if (suppressed.size > 0) {
        derived.runDays = [0, 1, 2, 3, 4, 5, 6].filter((day) => !suppressed.has(day));
    }

    const leave = findLeaveDates(task);
    if (derived.skipOnLeave && leave) derived.leave = leave;

    return derived;
}

/**
 * The two dates bounding a stated leave period.
 *
 * Anchored to the phrase that introduces them rather than taking the first two
 * ISO dates in the brief: these prompts are full of other dates — the meeting
 * they are tracking, the sprint they belong to — and any of them could sort
 * ahead of the ones that matter.
 */
function findLeaveDates(task: string): { from: string; to: string } | undefined {
    const anchored = /on leave from[^.\n]*?(\d{4}-\d{2}-\d{2})([^.\n]*?)(\d{4}-\d{2}-\d{2})/i.exec(task);
    const pair = anchored ?? followingLeaveWord(task);
    if (!pair) return undefined;
    const [, from, between, second] = pair;
    if (!isDayKey(from) || !isDayKey(second)) return undefined;
    // "returning around 2026-09-08" names the first day back, not the last day
    // away. Taking it literally silenced every watcher on his first morning in,
    // which is the one morning the briefing is worth most.
    const to = RETURNING.test(between ?? "") ? dayBefore(second) : second;
    if (from > to) return undefined;
    return { from, to };
}

/** Wording that makes the second date a return, not the last day away. */
const RETURNING = /\b(return|returns|returning|back on|back at|back in)\b/i;

/** The local calendar day before `key`, as `YYYY-MM-DD`. */
function dayBefore(key: string): string {
    const [year, month, day] = key.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    date.setDate(date.getDate() - 1);
    return dayKey(date.getTime());
}

/** Fallback: the first two dates appearing after any mention of being away. */
function followingLeaveWord(task: string): RegExpExecArray | undefined {
    const mention = LEAVE_WORDS.exec(task);
    if (!mention) return undefined;
    const rest = task.slice(mention.index);
    return /(\d{4}-\d{2}-\d{2})([^.\n]*?)(\d{4}-\d{2}-\d{2})/.exec(rest) ?? undefined;
}
