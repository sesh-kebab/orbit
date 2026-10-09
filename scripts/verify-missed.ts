/**
 * Verification for missed daily slots — a slot that passed with nothing
 * running to serve it.
 *
 *   npm run verify:missed
 *
 * This exists because declining a stale slot was correct and silent, and the
 * second half undid the first. `catchUpDecision` refuses to run an 08:00
 * briefing at 18:15, which is right: a briefing written for the start of the
 * day is noise at the end of it. It then rolled `nextRunAt` to tomorrow and
 * said nothing, so the slot left no trace anywhere.
 *
 * The concrete casualty: Orbit was not running between 28 and 30 September
 * 2026. Two days of the 08:00 briefing and the 16:45 check-in came and went,
 * all four declines were correct, and the only evidence the user had that his
 * assistant had been dark for 44 hours was an absence of messages. An absence
 * of messages is also what a quiet day looks like, so the two states were
 * indistinguishable from outside.
 *
 * Everything under test is pure: no clock, no agent, no disk. Times are built
 * with the local-time constructor on purpose, because slots are wall-clock.
 */
import {
    CATCH_UP_GRACE_MS,
    catchUpDecision,
    clearMissedSlots,
    describeSchedule,
    describeMissedSlots,
    makeSchedule,
    noteMissedSlot,
} from "../src/main/orchestrator/schedules.js";
import { makeLeavePeriod } from "../src/main/orchestrator/suppression.js";
import type { Schedule } from "../src/shared/types.js";

let failures = 0;

function check(what: string, ok: boolean): void {
    if (ok) {
        console.log(`  ok   ${what}`);
        return;
    }
    console.error(`  FAIL ${what}`);
    failures += 1;
}

const MINUTE = 60 * 1000;

/** A daily watcher at `time`, never yet run. */
function daily(time: string): Schedule {
    return makeSchedule({
        title: "Morning briefing",
        task: "Brief me on the day.",
        cadence: { kind: "daily", time },
    });
}

/** Local wall-clock instant on 30 September 2026. */
function at(hours: number, minutes: number): number {
    return new Date(2026, 8, 30, hours, minutes, 0, 0).getTime();
}

console.log("missed slots");

// The case that started it: an 08:00 briefing first looked at in the evening.
{
    const schedule = daily("08:00");
    const decision = catchUpDecision(schedule, at(18, 15));
    check("a slot ten hours stale is not run", decision.run === false);
    check("and is reported as missed", decision.missed === true);
    check("with the slot it missed", decision.slotAt === at(8, 0));
}

// Still inside the grace window: served, not mourned.
{
    const schedule = daily("08:00");
    const decision = catchUpDecision(schedule, at(8, 0) + CATCH_UP_GRACE_MS - MINUTE);
    check("a slot inside the grace window runs", decision.run === true);
    check("and is not counted as missed", !decision.missed);
}

// A slot that has not arrived yet is not a slot anybody failed to serve.
{
    const schedule = daily("16:45");
    const decision = catchUpDecision(schedule, at(9, 0));
    check("a slot still ahead today is not missed", !decision.missed);
    check("and is not run early", decision.run === false);
}

// Already served. The commonest path, and the one that must stay silent.
{
    const schedule = daily("08:00");
    schedule.lastSlotAt = at(8, 0);
    const decision = catchUpDecision(schedule, at(18, 15));
    check("a slot already served is not missed", !decision.missed);
}

// A watcher easing off was never due, so it has lost nothing.
{
    const schedule = daily("08:00");
    schedule.quietRuns = 12;
    schedule.backoffDays = 4;
    schedule.lastRunAt = at(8, 0) - 24 * 60 * MINUTE;
    const decision = catchUpDecision(schedule, at(18, 15));
    check("a dormant watcher's skipped slot is not missed", !decision.missed);
}

// Counting.
{
    const schedule = daily("08:00");
    check("the first miss is worth announcing", noteMissedSlot(schedule, at(8, 0)) === true);
    check("it is counted", schedule.missedSlots === 1);
    const second = new Date(2026, 9, 1, 8, 0, 0, 0).getTime();
    check("the second is not announced again", noteMissedSlot(schedule, second) === false);
    check("but is still counted", schedule.missedSlots === 2);
}

// Launch and the tick straight after it both see the same unserved slot.
{
    const schedule = daily("08:00");
    noteMissedSlot(schedule, at(8, 0));
    noteMissedSlot(schedule, at(8, 0));
    check("the same slot seen twice counts once", schedule.missedSlots === 1);
}

// A run of any kind proves something is running.
{
    const schedule = daily("08:00");
    noteMissedSlot(schedule, at(8, 0));
    check("a run ends the outage", clearMissedSlots(schedule) === true);
    check("and resets the count", (schedule.missedSlots ?? 0) === 0);
    check("a run with no outage reports none", clearMissedSlots(schedule) === false);
}

// Missing a slot must never be mistaken for being dull: the back-off is the
// mechanism that would widen the very gap that caused the miss.
{
    const schedule = daily("08:00");
    noteMissedSlot(schedule, at(8, 0));
    check("a missed slot is not a quiet run", (schedule.quietRuns ?? 0) === 0);
    check("and does not stretch the cadence", schedule.backoffDays === undefined);
}

// It has to actually reach a reader.
{
    const schedule = daily("08:00");
    check("a healthy watcher says nothing about misses", describeMissedSlots(schedule) === undefined);
    noteMissedSlot(schedule, at(8, 0));
    const one = describeMissedSlots(schedule) ?? "";
    check("one miss reads as singular", one.includes("its last slot"));
    noteMissedSlot(schedule, new Date(2026, 9, 1, 8, 0, 0, 0).getTime());
    const two = describeMissedSlots(schedule) ?? "";
    check("two misses read as plural", two.includes("its last 2 slots"));
    check("and say why", two.includes("nothing was running"));
    check("the cadence description carries it", describeSchedule(schedule).includes("missed its last 2 slots"));
}

// A watcher that is fine must not gain noise.
{
    const schedule = daily("08:00");
    check("a healthy cadence is unchanged", describeSchedule(schedule) === "daily at 08:00");
}

// MARK: - The next run it advertises

// `nextRunAt` is read in two registers. The clock treats it as "wake and look",
// and a suppressed watcher waking to be turned away is harmless. Every reading
// surface treats it as a statement of fact, and that statement used to be
// wrong: catch-up rolled the field forward by a day without consulting the
// silence rules. On 8 Oct 2026 a Thursday-only watcher sat with a Friday
// nextRunAt, so orbit_list_schedules reported it as running tomorrow and the
// board offered the user a card promising the same. Neither could happen.
{
    // Thursday-only. 30 Sep 2026 is a Wednesday, so "tomorrow" is its day and
    // the naive roll-forward is accidentally right: start from its own day.
    const schedule = daily("08:00");
    schedule.runDays = [4];
    const thursday = new Date(2026, 9, 1, 18, 15, 0, 0).getTime();
    const decision = catchUpDecision(schedule, thursday);
    const next = new Date(decision.nextRunAt);
    check("a Thursday-only watcher does not advertise Friday", next.getDay() === 4);
    check("it advertises the Thursday a week on", next.getDate() === 8);
    check("at its own slot, not midnight", next.getHours() === 8 && next.getMinutes() === 0);
}

// The same field, read before the slot rather than after it.
{
    const schedule = daily("08:00");
    schedule.runDays = [4];
    const friday = new Date(2026, 9, 2, 6, 0, 0, 0).getTime();
    const decision = catchUpDecision(schedule, friday);
    check("a slot ahead today on a barred day is pushed on", new Date(decision.nextRunAt).getDay() === 4);
}

// Leave is the other half of the same rule, and the case that mattered on the
// night: the user away 9-11 Oct with a watcher due at 08:00 each morning.
{
    const schedule = daily("08:00");
    schedule.skipOnLeave = true;
    const leave = [makeLeavePeriod("2026-10-09", "2026-10-11", "Office move")];
    const thursdayEvening = new Date(2026, 9, 8, 21, 30, 0, 0).getTime();
    const decision = catchUpDecision(schedule, thursdayEvening, leave);
    const next = new Date(decision.nextRunAt);
    check("a leave-respecting watcher does not advertise a leave day", next.getDate() === 12);
    check("it waits for the first working morning back", next.getHours() === 8);
}

// Suppression must not be charged to watchers that have none.
{
    const schedule = daily("08:00");
    const decision = catchUpDecision(schedule, at(18, 15));
    const next = new Date(decision.nextRunAt);
    check("a watcher with no silence rules still runs tomorrow", next.getDate() === 1);
}

if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
}
console.log("\nall checks passed");
