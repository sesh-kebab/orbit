import { randomUUID } from "node:crypto";
import type { Cadence, LeavePeriod, Schedule } from "../../shared/types.js";
import {
    describeSuppression,
    hasSuppression,
    nextAllowedRun,
} from "./suppression.js";

/** Next fire time for a cadence, relative to `from`. */
export function nextRun(cadence: Cadence, from = Date.now()): number {
    switch (cadence.kind) {
        case "interval":
            return from + Math.max(1, cadence.minutes) * 60_000;
        case "once":
            return cadence.at;
        case "daily": {
            const [hours, minutes] = parseTime(cadence.time);
            const next = new Date(from);
            next.setSeconds(0, 0);
            next.setHours(hours, minutes);
            if (next.getTime() <= from) next.setDate(next.getDate() + 1);
            return next.getTime();
        }
    }
}

export function parseTime(value: string): [number, number] {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (!match) return [9, 0];
    const hours = Math.min(23, Math.max(0, Number(match[1])));
    const minutes = Math.min(59, Math.max(0, Number(match[2])));
    return [hours, minutes];
}

/** Is this a 24h `HH:MM` time the daily cadence can actually use? */
export function isValidTime(value: string): boolean {
    return /^(\d{1,2}):(\d{2})$/.test(value.trim());
}

export function describeCadence(cadence: Cadence): string {
    switch (cadence.kind) {
        case "interval": {
            const minutes = cadence.minutes;
            if (minutes % 60 === 0 && minutes >= 60) {
                const hours = minutes / 60;
                return `every ${hours}h`;
            }
            return `every ${minutes}m`;
        }
        case "daily":
            return `daily at ${cadence.time}`;
        case "once":
            return `once at ${new Date(cadence.at).toLocaleString([], {
                hour: "2-digit",
                minute: "2-digit",
                month: "short",
                day: "numeric",
            })}`;
    }
}

/** How much of the last report we replay before the agent's context suffers. */
const PREVIOUS_RESULT_CAP = 4000;

/** Consecutive silent runs tolerated before a watcher starts easing off. */
const BACKOFF_AFTER_QUIET_RUNS = 3;

/** However dull a watcher gets, it still checks in this often. */
const BACKOFF_CEILING_MINUTES = 6 * 60;

/**
 * The interval actually in force, once back-off is taken into account.
 *
 * Never faster than the configured cadence: a ceiling below what the user
 * asked for should not accidentally speed a slow watcher up.
 */
export function effectiveCadence(schedule: Schedule): Cadence {
    const { cadence, backoffMinutes } = schedule;
    if (cadence.kind !== "interval" || !backoffMinutes) return cadence;
    return { kind: "interval", minutes: Math.max(cadence.minutes, backoffMinutes) };
}

/** Next fire time for a schedule, respecting any back-off it has earned. */
export function nextRunFor(schedule: Schedule, from = Date.now()): number {
    return nextRun(effectiveCadence(schedule), from);
}

/** Is this watcher currently running slower than the user asked for? */
export function isBackedOff(schedule: Schedule): boolean {
    return (
        schedule.cadence.kind === "interval" &&
        (schedule.backoffMinutes ?? 0) > schedule.cadence.minutes
    );
}

/** Retired but kept. Absent on schedules persisted before archiving existed. */
export function isArchived(schedule: Schedule): boolean {
    return schedule.archived === true;
}

/**
 * A one-off that has already gone off. Its single moment has passed, so it can
 * never legitimately run again however its `enabled` flag is poked afterwards.
 */
export function hasFired(schedule: Schedule): boolean {
    return schedule.cadence.kind === "once" && schedule.runCount > 0;
}

/** Watchers the clock is allowed to fire. */
export function isRunnable(schedule: Schedule): boolean {
    return schedule.enabled && !isArchived(schedule) && !hasFired(schedule);
}

/**
 * How late a missed daily slot may be and still be worth running on launch.
 *
 * A briefing meant for 08:00 is still a briefing at 09:30; the same briefing at
 * 16:00 is noise. Matches the back-off ceiling's spirit — a watcher that has
 * drifted this far from its slot has missed the point of having one.
 */
export const CATCH_UP_GRACE_MS = 2 * 60 * 60 * 1000;

/** Local calendar day as `YYYY-MM-DD`, the key a daily run is deduped on. */
export function localDay(when: number = Date.now()): string {
    const date = new Date(when);
    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0"),
    ].join("-");
}

/**
 * Has this watcher already served the daily slot at `slotAt`?
 *
 * Deliberately per-slot rather than per-day. "Did it run today" is a different
 * question, and answering it in place of this one meant any earlier run that
 * day — a manual nudge at breakfast, a catch-up on launch — cancelled the slot
 * the user actually asked for.
 */
export function ranSlot(schedule: Schedule, slotAt: number): boolean {
    if (schedule.lastSlotAt !== undefined) return schedule.lastSlotAt >= slotAt;
    // Persisted before per-slot tracking: a run at or after the slot covered
    // it, a run before it did not.
    return schedule.lastRunAt !== undefined && schedule.lastRunAt >= slotAt;
}

/** Today's instance of a daily cadence, whether it is past or still ahead. */
export function dailySlotOn(cadence: Cadence, now: number = Date.now()): number | undefined {
    if (cadence.kind !== "daily") return undefined;
    const [hours, minutes] = parseTime(cadence.time);
    const slot = new Date(now);
    slot.setSeconds(0, 0);
    slot.setHours(hours, minutes);
    return slot.getTime();
}

/**
 * What launch should do with a watcher whose stored `nextRunAt` is in the past.
 *
 * Recomputed from the cadence rather than trusted from disk: a `nextRunAt`
 * written days ago says nothing about today, and taking it at face value is
 * what made every daily watcher fire at once on the first launch after a gap —
 * including one whose slot was still hours away.
 */
export function catchUpDecision(
    schedule: Schedule,
    now: number = Date.now(),
): { run: boolean; nextRunAt: number; slotAt?: number } {
    if (schedule.cadence.kind !== "daily") {
        // Intervals never replay a backlog, one-offs are handled by the caller.
        return { run: false, nextRunAt: nextRunFor(schedule, now) };
    }

    const slot = dailySlotOn(schedule.cadence, now)!;
    const day = 24 * 60 * 60 * 1000;

    // Slot still ahead of us today: nothing was missed, just wait for it.
    if (slot > now) return { run: false, nextRunAt: slot, slotAt: slot };

    const missedBy = now - slot;
    const run = missedBy < CATCH_UP_GRACE_MS && !ranSlot(schedule, slot);
    // Having run (or given up on) today's slot, the next one is tomorrow's.
    return { run, nextRunAt: slot + day, slotAt: slot };
}

/** Cadence for display, with the back-off and any silence rules called out. */
export function describeSchedule(schedule: Schedule): string {
    const configured = describeCadence(schedule.cadence);
    const base = !isBackedOff(schedule)
        ? configured
        : `${configured}, backed off to ${describeCadence(effectiveCadence(schedule))} after ${
              schedule.quietRuns ?? 0
          } quiet runs`;
    const silence = describeSuppression(schedule);
    return silence ? `${base} (${silence})` : base;
}

/**
 * Next fire time for a schedule, skipping days it is not allowed to run.
 *
 * Daily watchers keep their slot on whichever day they land on: a briefing due
 * at 08:00 that skips a weekend is wanted at 08:00 on Monday, not at midnight.
 */
export function nextAllowedRunFor(
    schedule: Schedule,
    leave: LeavePeriod[],
    from = Date.now(),
): number {
    const candidate = nextRunFor(schedule, from);
    if (!hasSuppression(schedule)) return candidate;
    const cadence = schedule.cadence;
    return nextAllowedRun(schedule, leave, candidate, (dayStart) =>
        cadence.kind === "daily" ? dailySlotOn(cadence, dayStart)! : dayStart,
    );
}

/**
 * Record a run that found nothing worth saying. A watcher that keeps coming
 * back empty doubles its gap rather than burning tokens forever at a cadence
 * the user picked before they knew how noisy the thing would be.
 *
 * Only interval watchers back off — a daily brief at 08:30 is wanted at 08:30
 * whether or not yesterday was quiet, and a one-off never runs twice.
 *
 * Returns true when the effective interval actually moved.
 */
export function noteQuietRun(schedule: Schedule): boolean {
    schedule.quietRuns = (schedule.quietRuns ?? 0) + 1;
    if (schedule.cadence.kind !== "interval") return false;
    if (schedule.quietRuns < BACKOFF_AFTER_QUIET_RUNS) return false;

    const ceiling = Math.max(BACKOFF_CEILING_MINUTES, schedule.cadence.minutes);
    const current = schedule.backoffMinutes ?? schedule.cadence.minutes;
    const widened = Math.min(ceiling, current * 2);
    if (widened <= current) return false;
    schedule.backoffMinutes = widened;
    return true;
}

/**
 * A run that actually said something, or a cadence the user just changed:
 * back to the configured rhythm immediately, not gradually.
 *
 * Returns true when something was undone.
 */
export function clearBackoff(schedule: Schedule): boolean {
    const changed = (schedule.quietRuns ?? 0) > 0 || schedule.backoffMinutes !== undefined;
    schedule.quietRuns = 0;
    schedule.backoffMinutes = undefined;
    return changed;
}

/**
 * The baseline block handed to a watcher's next run.
 *
 * Every tick spawns a fresh agent, so "tell me what changed" is unanswerable
 * unless the previous report travels with the task. Empty until there is one.
 */
export function previousRunBlock(schedule: Schedule): string {
    const previous = schedule.lastResult?.trim();
    if (!previous) return "";

    const body =
        previous.length > PREVIOUS_RESULT_CAP
            ? `${previous.slice(0, PREVIOUS_RESULT_CAP)}\n…[earlier report truncated]`
            : previous;
    const when = schedule.lastRunAt
        ? `This task last ran at ${new Date(schedule.lastRunAt).toLocaleString()}. Its report was:`
        : "This task has run before. Its last report was:";

    return [
        "<previous_run>",
        when,
        body,
        "",
        "Use this as your baseline: report only what has changed since then. If nothing meaningful has changed, say so briefly.",
        "</previous_run>",
    ].join("\n");
}

export function makeSchedule(input: {
    title: string;
    task: string;
    cadence: Cadence;
    quiet?: boolean;
    runDays?: number[];
    skipOnLeave?: boolean;
}): Schedule {
    return {
        id: randomUUID(),
        title: input.title,
        task: input.task,
        cadence: input.cadence,
        enabled: true,
        createdAt: Date.now(),
        nextRunAt: nextRun(input.cadence),
        runCount: 0,
        quiet: input.quiet ?? false,
        quietRuns: 0,
        archived: false,
        runDays: input.runDays,
        skipOnLeave: input.skipOnLeave,
        // Written with the property already set, so the prose migration has
        // nothing to say about it.
        suppressionDerived: true,
    };
}

/**
 * A daily brief needs a bit more shape than "summarise my day", otherwise the
 * agent invents structure differently every morning.
 */
export const DAILY_BRIEF_TEMPLATE = `
Produce a short executive briefing for the start of the user's day.

Cover, in this order, and skip anything you genuinely cannot check:
1. Anything that needs a decision from the user today.
2. What changed since yesterday in their working directory (recent commits, modified files, branch state).
3. Any scheduled watchers that reported something noteworthy.
4. One suggestion for what to tackle first, and why.

Rules:
- Lead with the single most important thing. No preamble, no greeting.
- Use short lines, at most 8 of them. Facts over adjectives.
- If it was a quiet night, say so in one line rather than padding.
`.trim();
