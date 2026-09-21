/**
 * Verification for daily dormancy — a daily watcher easing off after a run of
 * days with nothing to say.
 *
 *   npm run verify:dormancy
 *
 * This exists because for weeks the easing-off was real for interval watchers
 * and entirely imaginary for daily ones. `quietRuns` was counted on every
 * cadence and acted on for exactly one of them, so a daily watcher accumulated
 * a number nobody read. Every schedule on the user's machine is daily, which
 * made the whole mechanism dead code in practice, and the tool description told
 * the model the opposite: "a watcher that keeps finding nothing eases off on
 * its own".
 *
 * The concrete casualty was "Tear down Bastion", a one-off mis-encoded as a
 * daily whose own brief said to run only on Thursday 20 August and to answer
 * `NOTHING TO REPORT` on every other day. It did exactly that, ten times in a
 * row, spawning an agent every morning to say nothing.
 *
 * Everything under test is pure: no clock, no agent, no disk. Times are built
 * with the local-time constructor on purpose, because slots are wall-clock.
 */
import {
    catchUpDecision,
    clearBackoff,
    describeSchedule,
    dormancyAllows,
    dormantDays,
    isBackedOff,
    makeSchedule,
    nextRunFor,
    noteQuietRun,
    retirementCase,
    RETIRE_AFTER_QUIET_RUNS,
} from "../src/main/orchestrator/schedules.js";
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

const DAY = 24 * 60 * 60 * 1000;

/** A daily watcher at `time`, as if it last ran at `lastRunAt`. */
function daily(time: string, lastRunAt?: number): Schedule {
    const schedule = makeSchedule({
        title: "Tear down Bastion",
        task: "Only run on Thursday 20 August.",
        cadence: { kind: "daily", time },
    });
    schedule.lastRunAt = lastRunAt;
    return schedule;
}

/** Local wall-clock helper, so a slot means what the user thinks it means. */
function at(year: number, month: number, day: number, hours: number, minutes = 0): number {
    return new Date(year, month - 1, day, hours, minutes, 0, 0).getTime();
}

console.log("\nPatience before a daily eases off at all");

const patient = daily("10:00", at(2026, 9, 19, 10));
for (let i = 0; i < 4; i += 1) noteQuietRun(patient);
check("four quiet days do not stretch a daily watcher", patient.backoffDays === undefined);
check("four quiet days leave it reading as not backed off", !isBackedOff(patient));
check("a daily watcher gets more patience than an interval's three", patient.quietRuns === 4);

noteQuietRun(patient);
check("the fifth quiet day stretches it to every 2 days", patient.backoffDays === 2);
check("and it now reads as backed off", isBackedOff(patient));

noteQuietRun(patient);
check("the sixth doubles it to every 4 days", patient.backoffDays === 4);
noteQuietRun(patient);
check("the seventh reaches the weekly ceiling", patient.backoffDays === 7);
noteQuietRun(patient);
check("and stops there rather than growing forever", patient.backoffDays === 7);
check("a run at the ceiling reports no further change", noteQuietRun(patient) === false);

console.log("\nThe stretch only ever delays");

const stretched = daily("10:00", at(2026, 9, 19, 10));
stretched.backoffDays = 3;
const next = nextRunFor(stretched, at(2026, 9, 19, 10, 1));
check("a 3-day stretch lands three days after the last run", next === at(2026, 9, 22, 10));
check("and keeps the slot the user asked for", new Date(next).getHours() === 10);

const normal = daily("10:00", at(2026, 9, 19, 10));
check(
    "an unstretched daily still runs tomorrow",
    nextRunFor(normal, at(2026, 9, 19, 10, 1)) === at(2026, 9, 20, 10),
);

/**
 * The gap is measured from the last *run*, not from the moment of asking.
 * Measuring from `now` would let any incidental recalculation — a leave edit, a
 * suppression check, an enable toggle — restart the clock, and a watcher whose
 * clock is restarted often enough never eases off at all.
 */
const recalculated = daily("10:00", at(2026, 9, 19, 10));
recalculated.backoffDays = 3;
check(
    "asking again the next day does not push the run further out",
    nextRunFor(recalculated, at(2026, 9, 20, 9)) === at(2026, 9, 22, 10),
);

/** A watcher that has never run has no last run to measure a stretch from. */
const neverRan = daily("10:00", undefined);
neverRan.backoffDays = 4;
check(
    "a watcher that has never run is not held back by a stored stretch",
    nextRunFor(neverRan, at(2026, 9, 19, 10, 1)) === at(2026, 9, 20, 10),
);

console.log("\nA dormant watcher is not woken by the slot it is skipping");

/**
 * The regression that makes the whole thing work. `tickSchedules` fires a daily
 * when its slot has passed and was not served. A dormant watcher's slot passes
 * every single day and is never served, so without an explicit check the
 * dormancy would be undone by the very next tick.
 */
const skipping = daily("10:00", at(2026, 9, 19, 10));
skipping.backoffDays = 3;
check(
    "the day after a run is not this watcher's turn",
    !dormancyAllows(skipping, at(2026, 9, 20, 10)),
);
check(
    "nor is the day after that",
    !dormancyAllows(skipping, at(2026, 9, 21, 10)),
);
check("the third day is", dormancyAllows(skipping, at(2026, 9, 22, 10)));
check("and so is any day beyond it", dormancyAllows(skipping, at(2026, 9, 23, 10)));

const decision = catchUpDecision(skipping, at(2026, 9, 20, 10, 5));
check("catch-up refuses to run a dormant watcher on a skipped day", decision.run === false);
check("and rolls it forward to its real next day", decision.nextRunAt === at(2026, 9, 22, 10));

const dueDecision = catchUpDecision(skipping, at(2026, 9, 22, 10, 5));
check("catch-up does run it on the day it is due", dueDecision.run === true);

/** A watcher at its normal rhythm must be unaffected by any of this. */
const everyday = daily("08:00", at(2026, 9, 19, 8));
check("dormancy permits every slot for an unstretched watcher", dormancyAllows(everyday, at(2026, 9, 20, 8)));
check("and it reports no dormancy", dormantDays(everyday) === undefined);

console.log("\nNews restores the configured rhythm at once");

const reawakened = daily("10:00", at(2026, 9, 19, 10));
reawakened.backoffDays = 7;
reawakened.quietRuns = 9;
check("a run that says something undoes the stretch", clearBackoff(reawakened) === true);
check("the stretch is gone", reawakened.backoffDays === undefined);
check("and the quiet tally with it", reawakened.quietRuns === 0);
check("so it is back to daily", nextRunFor(reawakened, at(2026, 9, 19, 10, 1)) === at(2026, 9, 20, 10));
check("and reads as not backed off", !isBackedOff(reawakened));

console.log("\nThe cadence it reports is the cadence it keeps");

const described = daily("10:00", at(2026, 9, 19, 10));
described.backoffDays = 4;
described.quietRuns = 6;
const label = describeSchedule(described);
check("a stretched daily says so", label.includes("every 4 days"));
check("and says what earned it", label.includes("6 quiet runs"));
check("while keeping the configured slot visible", label.includes("daily at 10:00"));
check("an unstretched daily says only its cadence", describeSchedule(daily("10:00")) === "daily at 10:00");

console.log("\nOther cadences are untouched");

const interval = makeSchedule({
    title: "Watch the mail",
    task: "Watch it.",
    cadence: { kind: "interval", minutes: 30 },
});
for (let i = 0; i < 3; i += 1) noteQuietRun(interval);
check("an interval watcher still backs off in minutes", interval.backoffMinutes === 60);
check("and grows no day-stretch", interval.backoffDays === undefined);
check("an interval reports no dormancy", dormantDays(interval) === undefined);

const once = makeSchedule({
    title: "Remind me",
    task: "Once.",
    cadence: { kind: "once", at: at(2026, 9, 20, 9) },
});
for (let i = 0; i < 8; i += 1) noteQuietRun(once);
check("a one-off never grows a stretch, having nothing to stretch", once.backoffDays === undefined);
check("and never reads as backed off", !isBackedOff(once));

console.log("\nThe watcher that caused this");

/**
 * Replay of "Tear down Bastion" as it actually stood tonight: a daily at 10:00,
 * eighteen runs, ten of them consecutively silent, and `backedOff: false`.
 */
const bastion = daily("10:00", at(2026, 9, 19, 10));
bastion.runCount = 18;
bastion.quietRuns = 10;
check("as it stands tonight, the old code left it unstretched", bastion.backoffDays === undefined);
noteQuietRun(bastion);
check("its next silent run stretches it immediately", bastion.backoffDays === 2);
noteQuietRun(bastion);
noteQuietRun(bastion);
check("and three silent runs take it to weekly", bastion.backoffDays === 7);
check(
    "which is 52 agent runs a year rather than 365",
    nextRunFor(bastion, at(2026, 9, 19, 10, 1)) === at(2026, 9, 26, 10),
);

console.log("\nRetiring a watcher rather than only slowing it down");

// Easing off is what a watcher does to itself. Retiring is what something else
// does to it, so the bar is higher and the refusals are the important half.

const stillWorking = daily("08:00", at(2026, 9, 19, 8));
stillWorking.quietRuns = 0;
check("a watcher that is still finding things cannot be retired", !retirementCase(stillWorking).retirable);
check(
    "and the refusal says what it would take",
    retirementCase(stillWorking).because.includes(String(RETIRE_AFTER_QUIET_RUNS)),
);

const easingOff = daily("10:00", at(2026, 9, 19, 10));
for (let i = 0; i < 5; i += 1) noteQuietRun(easingOff);
check("the back-off threshold alone does not earn retirement", isBackedOff(easingOff));
check("five quiet runs is still not enough to retire", !retirementCase(easingOff).retirable);
check("retiring asks for more evidence than easing off does", RETIRE_AFTER_QUIET_RUNS > 5);

noteQuietRun(easingOff);
check("the sixth quiet run earns it", retirementCase(easingOff).retirable);
check("and the record says how it was earned", retirementCase(easingOff).because.includes("6 runs running"));

// A watcher that cannot look is broken, not dull. Burying it would hide the
// fault, so `noteBlindRun` leaves `quietRuns` alone and this must refuse.
const blind = daily("10:00", at(2026, 9, 19, 10));
blind.quietRuns = 0;
blind.blindRuns = 30;
check("a blind watcher is never retired, however long it has been blind", !retirementCase(blind).retirable);
check("and it is named as a fault to report", retirementCase(blind).because.includes("fault"));

const paused = daily("10:00", at(2026, 9, 19, 10));
paused.enabled = false;
check("a paused watcher can be tidied away", retirementCase(paused).retirable);

const oneOff = makeSchedule({
    title: "Remind me once",
    task: "Say the thing.",
    cadence: { kind: "once", at: at(2026, 9, 1, 9) },
});
oneOff.runCount = 1;
check("a one-off that already fired can be retired", retirementCase(oneOff).retirable);

const alreadyGone = daily("10:00", at(2026, 9, 19, 10));
alreadyGone.quietRuns = 40;
alreadyGone.archived = true;
check("an already-retired watcher is not retired twice", !retirementCase(alreadyGone).retirable);

// The case this was built for. Bastion's own brief expired on 20 August; by
// tonight it stood at eleven consecutive silent runs out of nineteen.
const deadBastion = daily("10:00", at(2026, 9, 20, 10));
deadBastion.runCount = 19;
deadBastion.quietRuns = 11;
check("Bastion, as it stands tonight, can finally be retired", retirementCase(deadBastion).retirable);
check(
    "which is the seven-day-old open item nothing could act on",
    retirementCase(deadBastion).because === "it has found nothing 11 runs running",
);

if (failures > 0) {
    console.error(`\n${failures} check(s) failed.\n`);
    process.exit(1);
}
console.log("\nAll dormancy checks passed.\n");
