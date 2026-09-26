/**
 * Verification for schedule silence rules — whether a watcher is allowed to run
 * at all today, which used to be a paragraph of prose in each watcher's brief.
 *
 *   npm run verify:suppression
 *
 * Everything under test is pure, so this needs no clock, no calendar and no
 * agent. Dates are built with the local-time constructor on purpose: the rules
 * are about the user's week, not UTC's.
 */
import {
    blindReason,
    CARRIED_CLAIM_RULE,
    clearBlindRuns,
    dailySlotOn,
    isCouldNotCheck,
    isNothingToReport,
    makeSchedule,
    nextAllowedRunFor,
    noteBlindRun,
    noteQuietRun,
    previousRunBlock,
} from "../src/main/orchestrator/schedules.js";
import {
    dayKey,
    deriveSuppression,
    describeDays,
    describeSuppression,
    isDayKey,
    makeLeavePeriod,
    nextAllowedRun,
    onLeave,
    parseRunDays,
    startOfNextDay,
    suppressionAt,
    WEEKDAYS,
} from "../src/main/orchestrator/suppression.js";
import type { LeavePeriod, Schedule } from "../src/shared/types.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: unknown): void {
    if (condition) {
        passed += 1;
        return;
    }
    failures.push(`${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

/** August 2026: the 15th is a Saturday, the 16th a Sunday, the 17th a Monday. */
function at(day: number, hour = 9, minute = 0): number {
    return new Date(2026, 7, day, hour, minute, 0, 0).getTime();
}
const SAT = at(15);
const SUN = at(16);
const MON = at(17);

const NO_LEAVE: LeavePeriod[] = [];
const LEAVE = [makeLeavePeriod("2026-08-21", "2026-09-07", "annual leave")];

// MARK: - Day maths

check("saturday is day 6", new Date(SAT).getDay() === 6);
check("sunday is day 0", new Date(SUN).getDay() === 0);
check("monday is day 1", new Date(MON).getDay() === 1);
check("dayKey is local, not UTC", dayKey(at(15, 23, 30)) === "2026-08-15", dayKey(at(15, 23, 30)));
check("dayKey at midnight", dayKey(at(15, 0, 0)) === "2026-08-15");

const rolled = startOfNextDay(at(15, 23, 30));
check("startOfNextDay is the next local midnight", new Date(rolled).getHours() === 0 && dayKey(rolled) === "2026-08-16", {
    rolled: new Date(rolled).toString(),
});

check("isDayKey accepts a real date", isDayKey("2026-08-21"));
check("isDayKey rejects month 13", !isDayKey("2026-13-01"));
check("isDayKey rejects 31 September", !isDayKey("2026-09-31"));
check("isDayKey rejects free text", !isDayKey("next friday"));

// MARK: - describeDays and parseRunDays

check("weekdays describe as a range", describeDays(WEEKDAYS) === "mon-fri", describeDays(WEEKDAYS));
check("all seven describe as every day", describeDays([0, 1, 2, 3, 4, 5, 6]) === "every day");
check("a gap is listed out", describeDays([1, 5]) === "mon, fri", describeDays([1, 5]));
check("out of order input still sorts", describeDays([5, 1, 3, 2, 4]) === "mon-fri");

const parsed = parseRunDays(["mon", "Tue", "WEDNESDAY", "thu", "fri"]);
check(
    "parseRunDays takes names, cases and long forms",
    !(parsed instanceof Error) && String(parsed) === "1,2,3,4,5",
    parsed,
);
check("parseRunDays dedupes", String(parseRunDays(["mon", "mon"])) === "1");
check("parseRunDays rejects a typo rather than ignoring it", parseRunDays(["mnoday"]) instanceof Error);
check("parseRunDays passes undefined through", parseRunDays(undefined) === undefined);

// MARK: - Leave

check("inside leave", onLeave(LEAVE, at(25))?.note === "annual leave");
check("first day of leave counts", onLeave(LEAVE, at(21, 8, 0)) !== undefined);
check("last day of leave counts", onLeave(LEAVE, new Date(2026, 8, 7, 23, 0).getTime()) !== undefined);
check("day after leave does not", onLeave(LEAVE, new Date(2026, 8, 8, 0, 1).getTime()) === undefined);
check("day before leave does not", onLeave(LEAVE, at(20, 23, 59)) === undefined);
check("no leave on record", onLeave(NO_LEAVE, at(25)) === undefined);
check(
    "a period stored back to front still matches",
    onLeave([{ id: "x", from: "2026-09-07", to: "2026-08-21" }], at(25)) !== undefined,
);

// MARK: - suppressionAt

const weekdayOnly = { runDays: WEEKDAYS, skipOnLeave: true };
const everyDay = { runDays: undefined, skipOnLeave: false };
const weekdayNoLeaveRule = { runDays: WEEKDAYS, skipOnLeave: false };
/** The daily briefing: silent on Saturday, but Sunday is a judgement call it keeps. */
const briefing = { runDays: [0, 1, 2, 3, 4, 5], skipOnLeave: true };

check("weekday watcher is suppressed on Saturday", suppressionAt(weekdayOnly, NO_LEAVE, SAT)?.reason === "day");
check("weekday watcher is suppressed on Sunday", suppressionAt(weekdayOnly, NO_LEAVE, SUN)?.reason === "day");
check("weekday watcher runs on Monday", suppressionAt(weekdayOnly, NO_LEAVE, MON) === undefined);
check("unrestricted watcher runs on Saturday", suppressionAt(everyDay, LEAVE, SAT) === undefined);
check("briefing is suppressed on Saturday", suppressionAt(briefing, NO_LEAVE, SAT)?.reason === "day");
check("briefing still runs on Sunday", suppressionAt(briefing, NO_LEAVE, SUN) === undefined);

check("leave suppresses a weekday", suppressionAt(weekdayOnly, LEAVE, at(25))?.reason === "leave");
check(
    "leave is ignored by a watcher that did not opt in",
    suppressionAt(weekdayNoLeaveRule, LEAVE, at(25)) === undefined,
);
check(
    "the more specific reason wins on a weekend inside leave",
    suppressionAt(weekdayOnly, LEAVE, at(22))?.reason === "day",
    suppressionAt(weekdayOnly, LEAVE, at(22)),
);
check(
    "an empty day list is not a ban",
    suppressionAt({ runDays: [], skipOnLeave: false }, NO_LEAVE, SAT) === undefined,
);

check("describeSuppression reads plainly", describeSuppression(weekdayOnly) === "mon-fri, not on leave");
check("no rules describe as nothing", describeSuppression(everyDay) === "");

// MARK: - nextAllowedRun

const slotAt = (dayStart: number) => dailySlotOn({ kind: "daily", time: "08:00" }, dayStart)!;

const fromSaturday = nextAllowedRun(weekdayOnly, NO_LEAVE, at(15, 8, 0), slotAt);
check(
    "a weekday watcher skipping the weekend lands on Monday at its own slot",
    dayKey(fromSaturday) === "2026-08-17" && new Date(fromSaturday).getHours() === 8,
    new Date(fromSaturday).toString(),
);

const fromLeave = nextAllowedRun(weekdayOnly, LEAVE, at(21, 8, 0), slotAt);
check(
    "eighteen days of leave are cleared in one go, to the first working day after",
    dayKey(fromLeave) === "2026-09-08",
    new Date(fromLeave).toString(),
);
check("and it keeps its slot on the far side", new Date(fromLeave).getHours() === 8);

check("an allowed candidate is returned untouched", nextAllowedRun(weekdayOnly, NO_LEAVE, MON, slotAt) === MON);

const interval = nextAllowedRun(weekdayOnly, NO_LEAVE, at(15, 14, 30));
check(
    "an interval watcher with no slot resumes at midnight on the next allowed day",
    dayKey(interval) === "2026-08-17" && new Date(interval).getHours() === 0,
    new Date(interval).toString(),
);

// MARK: - nextAllowedRunFor, on real schedules

function scheduleWith(
    cadence: Schedule["cadence"],
    rules: { runDays?: number[]; skipOnLeave?: boolean },
): Schedule {
    return makeSchedule({ title: "t", task: "t", cadence, ...rules });
}

const dailyBrief = scheduleWith({ kind: "daily", time: "08:00" }, { runDays: WEEKDAYS, skipOnLeave: true });
const afterFriday = nextAllowedRunFor(dailyBrief, NO_LEAVE, at(14, 9, 0));
check(
    "Friday morning's briefing next runs Monday, not Saturday",
    dayKey(afterFriday) === "2026-08-17" && new Date(afterFriday).getHours() === 8,
    new Date(afterFriday).toString(),
);

const unrestricted = scheduleWith({ kind: "daily", time: "08:00" }, {});
check(
    "a watcher with no rules is unaffected",
    dayKey(nextAllowedRunFor(unrestricted, LEAVE, at(14, 9, 0))) === "2026-08-15",
);

const poller = scheduleWith({ kind: "interval", minutes: 45 }, { runDays: WEEKDAYS, skipOnLeave: true });
check(
    "a 45 minute poller mid-morning on a weekday just takes its next slot",
    nextAllowedRunFor(poller, NO_LEAVE, MON) === MON + 45 * 60_000,
);

// MARK: - Reading the rules back out of the old prose

/**
 * The four briefs already on disk, structurally verbatim with the names, address
 * and subject matter replaced. The parsing surface — numbered silence checks,
 * "respond with exactly", the conditional Sunday, the leave sentence — is what
 * matters here, and it is reproduced exactly.
 */
const LUNCH_BRIEF = `Weekday-only lunch window reminder for the user.

FIRST: check today's day of the week. If it is Saturday or Sunday, respond with exactly: NOTHING TO REPORT
Do not report on weekends under any circumstances, even if the calendar is interesting.

Also check his calendar for a full-day out-of-office or annual leave entry covering today. If he is on leave today, respond with exactly: NOTHING TO REPORT
Note: he is on leave from 2026-08-21 returning around 2026-09-08, so stay silent throughout that period.

OTHERWISE, on a normal working weekday, report the largest genuinely free gap between 11:00 and 14:30.`;

const lunch = deriveSuppression(LUNCH_BRIEF);
check("lunch: weekends come out", String(lunch.runDays) === "1,2,3,4,5", lunch.runDays);
check("lunch: leave comes out", lunch.skipOnLeave === true);
check(
    "lunch: the dates come out",
    lunch.leave?.from === "2026-08-21" && lunch.leave?.to === "2026-09-07",
    lunch.leave,
);

const BRIEFING = `Morning chief-of-staff briefing for the user.

FIRST, SILENCE CHECKS:
1. If today is Saturday, respond with exactly: NOTHING TO REPORT.
2. If today is Sunday, only report if there is something genuinely time-critical for the week ahead, for example an empty sprint starting Monday. Otherwise respond with exactly: NOTHING TO REPORT. Keep any Sunday report to three lines.
3. If he is on out-of-office or annual leave today, respond with exactly: NOTHING TO REPORT. He is on leave from 2026-08-21 returning around 2026-09-08, so stay silent for that whole period.

OTHERWISE, on a working weekday, prepare a decision-first briefing.`;

const brief = deriveSuppression(BRIEFING);
check(
    "briefing: Saturday is dropped but Sunday is kept, because Sunday is conditional",
    String(brief.runDays) === "0,1,2,3,4,5",
    brief.runDays,
);
check("briefing: leave comes out", brief.skipOnLeave === true);
check("briefing: the dates come out", brief.leave?.from === "2026-08-21", brief.leave);

/**
 * The same rules as one long unbroken paragraph, which is how the briefing is
 * actually stored — the numbered items are run together rather than on their
 * own lines, and the parser has to find the same boundaries either way.
 */
const BRIEFING_ONE_LINE =
    "Morning chief-of-staff briefing for the user. FIRST, SILENCE CHECKS: 1. If today is Saturday, respond with exactly: NOTHING TO REPORT. 2. If today is Sunday, only report if there is something genuinely time-critical for the week ahead, for example an empty sprint starting Monday. Otherwise respond with exactly: NOTHING TO REPORT. Keep any Sunday report to three lines. 3. If he is on out-of-office or annual leave today, respond with exactly: NOTHING TO REPORT. He is on leave from 2026-08-21 returning around 2026-09-08, so stay silent for that whole period. OTHERWISE, on a working weekday, prepare a decision-first briefing.";

const oneLine = deriveSuppression(BRIEFING_ONE_LINE);
check(
    "briefing as one paragraph reads exactly the same",
    String(oneLine.runDays) === "0,1,2,3,4,5" && oneLine.skipOnLeave === true,
    oneLine,
);
check(
    "and the trailing 'keep any Sunday report short' does not silence Sundays",
    oneLine.runDays?.includes(0) === true,
    oneLine.runDays,
);
check("one paragraph still yields the leave dates", oneLine.leave?.from === "2026-08-21", oneLine.leave);

const WRAP_UP = `End-of-day wrap-up for the user.

FIRST, TWO SILENCE CHECKS:
1. If today is Saturday or Sunday, respond with exactly: NOTHING TO REPORT. No weekend wrap-ups, ever, even if something did happen.
2. If he is on out-of-office or annual leave today, respond with exactly: NOTHING TO REPORT. He is on leave from 2026-08-21 returning around 2026-09-08.

OTHERWISE, review the working day.`;

const wrap = deriveSuppression(WRAP_UP);
check("wrap-up: weekends come out", String(wrap.runDays) === "1,2,3,4,5", wrap.runDays);
check("wrap-up: leave comes out", wrap.skipOnLeave === true);

/** The one added by hand on 16 August, and the reason this shipped at all. */
const TRACKER = `Track the two unresolved items the user owns from the 13 August 2026 architecture meeting.

FIRST, SILENCE CHECKS:
1. If today is Saturday or Sunday, respond with exactly: NOTHING TO REPORT.
2. If he is on out-of-office or annual leave today, respond with exactly: NOTHING TO REPORT. He is on leave from 2026-08-21 returning around 2026-09-08, so stay silent for that whole period.

THE TWO ITEMS:
1. The call path and latency budget. Current state as of 2026-08-15: still open with no owner.
2. Sensitive queries. Still no owner and no policy.

REPORT ONLY IF SOMETHING ACTUALLY CHANGED. If nothing has changed, respond with exactly: NOTHING TO REPORT. Do not restate the unchanged baseline.`;

const tracker = deriveSuppression(TRACKER);
check("tracker: weekends come out", String(tracker.runDays) === "1,2,3,4,5", tracker.runDays);
check("tracker: leave comes out", tracker.skipOnLeave === true);
check(
    "tracker: the leave dates win over the other dates scattered through the brief",
    tracker.leave?.from === "2026-08-21" && tracker.leave?.to === "2026-09-07",
    tracker.leave,
);

// The failure that matters most: inventing a rule that was never written.
const PLAIN = `Check the build queue every hour and report any red builds with the failing step.
If everything is green, respond with exactly: NOTHING TO REPORT.`;
const plain = deriveSuppression(PLAIN);
check(
    "a brief with no silence rules yields none",
    plain.runDays === undefined && plain.skipOnLeave === undefined,
    plain,
);

const MENTIONS_SATURDAY = `Summarise weekend deployment risk. Saturday releases need extra care.

Separately: if there are no releases queued, respond with exactly: NOTHING TO REPORT.`;
check(
    "a day named in a sentence of its own, far from any silence instruction, is still read carefully",
    deriveSuppression(MENTIONS_SATURDAY).skipOnLeave === undefined,
    deriveSuppression(MENTIONS_SATURDAY),
);

const CONDITIONAL_WEEKEND = `Watch the incident channel.
At weekends, only report if there is a live sev 2. Otherwise respond with exactly: NOTHING TO REPORT.`;
check(
    "a conditional weekend rule is left alone",
    deriveSuppression(CONDITIONAL_WEEKEND).runDays === undefined,
    deriveSuppression(CONDITIONAL_WEEKEND),
);

const RETURNING_BRIEF = `Stay quiet while he is away. If he is on leave today, respond with exactly: NOTHING TO REPORT.
He is on leave from 2026-08-21 returning around 2026-09-08.`;
const returning = deriveSuppression(RETURNING_BRIEF);
check(
    "'returning around' names the first day back, so leave ends the day before",
    returning.leave?.to === "2026-09-07",
    returning.leave,
);
check("and the first day away is unchanged", returning.leave?.from === "2026-08-21");

const THROUGH_BRIEF = `If he is on annual leave today, respond with exactly: NOTHING TO REPORT.
He is on leave from 2026-08-21 to 2026-09-07 inclusive.`;
check(
    "a plain 'to' range keeps both ends",
    deriveSuppression(THROUGH_BRIEF).leave?.to === "2026-09-07",
    deriveSuppression(THROUGH_BRIEF).leave,
);

const NO_DATES = `Stay quiet if he is on annual leave: respond with exactly: NOTHING TO REPORT.`;
const noDates = deriveSuppression(NO_DATES);
check("leave with no dates still sets the flag", noDates.skipOnLeave === true);
check("but invents no period", noDates.leave === undefined, noDates.leave);

// MARK: - What it costs, replayed over a real fortnight

/**
 * The honest measure: how many times each watcher actually spawns an agent
 * between Saturday 15 August and Tuesday 8 September, a stretch containing two
 * full weekends and the eighteen day leave. Before this change every daily
 * watcher fired on all 25 days and paid an agent to read its own prose and then
 * say nothing.
 */
function countRuns(schedule: Schedule, leave: LeavePeriod[]): number {
    let runs = 0;
    for (let day = 15; day <= 39; day += 1) {
        const when = new Date(2026, 7, day, 8, 0, 0, 0).getTime();
        if (!suppressionAt(schedule, leave, when)) runs += 1;
    }
    return runs;
}

const DAYS = 25;
const lunchSchedule = scheduleWith({ kind: "daily", time: "11:15" }, { runDays: WEEKDAYS, skipOnLeave: true });
const briefingSchedule = scheduleWith(
    { kind: "daily", time: "08:00" },
    { runDays: [0, 1, 2, 3, 4, 5], skipOnLeave: true },
);

const lunchRuns = countRuns(lunchSchedule, LEAVE);
const briefingRuns = countRuns(briefingSchedule, LEAVE);
const unrestrictedRuns = countRuns(unrestricted, LEAVE);

check("an unrestricted watcher still runs every day", unrestrictedRuns === DAYS, unrestrictedRuns);
check("the weekday watcher drops to the five working days outside leave", lunchRuns === 5, lunchRuns);
check("the briefing keeps its Sundays, so runs a little more", briefingRuns > lunchRuns && briefingRuns < DAYS, {
    briefingRuns,
    lunchRuns,
});

const saved = (DAYS - lunchRuns) * 3 + (DAYS - briefingRuns);
check("the four live watchers save sixty-odd pointless agent runs over the stretch", saved > 60, { saved });

console.log(`\nOver 25 days: unrestricted ${unrestrictedRuns}, weekday-only ${lunchRuns}, briefing ${briefingRuns}.`);
console.log(`Agent runs avoided across the four live watchers: ${saved}.`);

// MARK: - The empty-run sentinel

/**
 * The four live watchers on 22 August all had "reply with exactly NOTHING TO
 * REPORT" typed into their task, and `quiet: false`. Every one of them answered
 * with the sentinel, and every one of them still reached the chat, because the
 * old test only looked at the flag. Orbit narrated "Nothing." three times into
 * an empty room, having said at 08:45 that it would stop.
 */
check("the bare sentinel", isNothingToReport("NOTHING TO REPORT"));
check("lower case", isNothingToReport("nothing to report"));
check("mixed case", isNothingToReport("Nothing To Report"));
check("a trailing full stop — what the Search Ads watcher actually sent", isNothingToReport("NOTHING TO REPORT."));
check("leading and trailing whitespace", isNothingToReport("  NOTHING TO REPORT\n"));
check("a bolded sentinel", isNothingToReport("**NOTHING TO REPORT**"));
check("a code-fenced sentinel", isNothingToReport("`NOTHING TO REPORT`"));
check("an italicised sentinel", isNothingToReport("_Nothing to report_"));
check("a quoted sentinel", isNothingToReport("> Nothing to report"));
check("an exclaimed sentinel", isNothingToReport("Nothing to report!"));
check("an elided sentinel", isNothingToReport("Nothing to report…"));

// The half that matters: a real report is never swallowed for containing the
// phrase. The old substring test failed every one of these on a quiet watcher.
check(
    "a report that merely opens with the phrase is still a report",
    !isNothingToReport("Nothing to report on the migration, but Becca is still waiting on your BAMI approval."),
);
check(
    "a report that mentions the phrase mid-sentence survives",
    !isNothingToReport("Two things. The nightly job said nothing to report, which is itself the bug."),
);
check("an empty reply is not the sentinel", !isNothingToReport(""));
check("a missing reply is not the sentinel", !isNothingToReport(undefined));
check("whitespace alone is not the sentinel", !isNothingToReport("   \n  "));
check("a near miss is not the sentinel", !isNothingToReport("nothing to report yet"));
check("a different sentence is not the sentinel", !isNothingToReport("All clear."));

/**
 * The behaviour the fix is really for, stated exactly as the orchestrator
 * states it: a watcher goes quiet when the *reply* is the sentinel and the run
 * actually finished. The `quiet` flag is no longer part of the test.
 */
function staysSilent(status: "done" | "failed" | "cancelled", result: string): boolean {
    return status === "done" && isNothingToReport(result);
}

check("a quiet watcher returning the sentinel stays silent, as before", staysSilent("done", "NOTHING TO REPORT"));
check(
    "a watcher that asked for the sentinel in its task prose now stays silent too",
    staysSilent("done", "NOTHING TO REPORT."),
);
check("a watcher with something to say still speaks", !staysSilent("done", "Becca is waiting on you."));
check(
    "a failed run is never mistaken for a quiet one, whatever it printed",
    !staysSilent("failed", "NOTHING TO REPORT"),
);
check("a cancelled run is not a quiet one either", !staysSilent("cancelled", "NOTHING TO REPORT"));

/**
 * Replaying 22 August: four watchers fired, all four answered with the
 * sentinel, all four reached the chat. Under the fix, none of them does.
 */
const AUG_22_REPLIES = [
    "NOTHING TO REPORT.", // Search Ads open questions, 08:45
    "NOTHING TO REPORT", // Tear down Bastion, 10:00
    "NOTHING TO REPORT", // Lunch window reminder, 11:15
    "NOTHING TO REPORT.", // End-of-day wrap-up, 16:45
];
const silencedOnAug22 = AUG_22_REPLIES.filter((reply) => isNothingToReport(reply)).length;
check("all four of 22 August's empty runs are silenced", silencedOnAug22 === 4, silencedOnAug22);

console.log(`\nEmpty watcher runs on 22 Aug that now stay out of the chat: ${silencedOnAug22} of ${AUG_22_REPLIES.length}.`);

// MARK: - Telling a blind watcher from a quiet one

/**
 * The calendar's lesson, generalised. Twenty-eight scans of a dead account
 * returned `[]`, `[]` means "your day is clear", and so Orbit was reassuring
 * about a day it could not see. A watcher has the identical hole: asked only
 * for NOTHING TO REPORT, an agent whose tool is missing has no other phrase.
 */
check("the bare blind sentinel", isCouldNotCheck("COULD NOT CHECK"));
check("lower case", isCouldNotCheck("could not check"));
check("with a reason after a dash", isCouldNotCheck("COULD NOT CHECK — no mail account is signed in."));
check("with a reason after a colon", isCouldNotCheck("Could not check: the Graph token was rejected."));
check("with a reason after a full stop", isCouldNotCheck("Could not check. There is no calendar tool available."));
check("dressed in bold, as models do", isCouldNotCheck("**COULD NOT CHECK** — the search errored."));
check("quoted", isCouldNotCheck("> Could not check — no ADO access."));

check("a normal report is not blind", !isCouldNotCheck("Becca is still waiting on your approval."));
check("silence is not blindness", !isCouldNotCheck("NOTHING TO REPORT"));
check("an empty reply is not blind", !isCouldNotCheck(""));
check("a missing reply is not blind", !isCouldNotCheck(undefined));
check(
    "the phrase mid-sentence does not make a report blind",
    !isCouldNotCheck("I could not check the second repo, but the first one is clean and Becca is waiting."),
);
check(
    "a longer verb phrase is not the sentinel",
    !isCouldNotCheck("Could not checkpoint the branch, so I left it alone."),
);

check("the reason is carried through", blindReason("COULD NOT CHECK — no mail account is signed in.") === "no mail account is signed in.");
check("a bare sentinel carries no reason", blindReason("COULD NOT CHECK") === undefined);
check("a report carries no reason", blindReason("All clear.") === undefined);

/**
 * The bookkeeping, which is where the real damage was. A quiet run earns a
 * back-off; if a blind run counted as a quiet one, a watcher that had gone
 * completely dark would be asked less and less often *because* it was broken,
 * and the failure would fade out instead of surfacing.
 */
const blindWatcher = makeSchedule({
    title: "Watch the mail",
    task: "Watch it.",
    cadence: { kind: "interval", minutes: 45 },
    quiet: true,
});

check("the first blind run is worth announcing", noteBlindRun(blindWatcher));
check("the second is the same sentence again", !noteBlindRun(blindWatcher));
check("and the third", !noteBlindRun(blindWatcher));
check("blind runs never earn a back-off", blindWatcher.backoffMinutes === undefined);
check("nor do they count as quiet", (blindWatcher.quietRuns ?? 0) === 0);
check("recovery is detected", clearBlindRuns(blindWatcher));
check("and only once", !clearBlindRuns(blindWatcher));
check("a recovered watcher can announce again", noteBlindRun(blindWatcher));

/** A quiet watcher, for contrast, does still ease off exactly as before. */
const quietWatcher = makeSchedule({
    title: "Watch something dull",
    task: "Watch it.",
    cadence: { kind: "interval", minutes: 45 },
    quiet: true,
});
for (let i = 0; i < 6; i += 1) noteQuietRun(quietWatcher);
check("a genuinely quiet watcher still backs off", quietWatcher.backoffMinutes !== undefined);

/**
 * And the blind reply must not become the next run's baseline. "Report only
 * what has changed since COULD NOT CHECK" invites "no change", which is how a
 * broken source quietly becomes the status quo.
 */
const blinded = makeSchedule({
    title: "Watch the mail",
    task: "Watch it.",
    cadence: { kind: "interval", minutes: 45 },
});
blinded.lastRunAt = Date.now();
blinded.lastResult = "COULD NOT CHECK — no mail account is signed in.";
check("a blind run is not handed on as a baseline", previousRunBlock(blinded) === "");
blinded.lastResult = "Becca is waiting on your approval.";
check("a real run still is", previousRunBlock(blinded).includes("Becca"));

/**
 * A baseline that says "report only what has changed" and stops there tells the
 * next run that everything it does not disprove is still true. That is the
 * 13 August briefing, which carried "Dorian is out sick" and "Zach is waiting
 * on you" into a second morning when both had expired, and was believed because
 * a briefing is acted on rather than checked.
 *
 * So the block must carry the re-check rule with it, and must carry it in the
 * same breath as the delta instruction: the two arriving separately is how the
 * delta instruction won for six weeks.
 */
const carried = previousRunBlock(blinded);
check("the baseline carries the re-check rule", carried.includes(CARRIED_CLAIM_RULE));
check("and the rule sits inside the block, not after it", carried.trimEnd().endsWith("</previous_run>"));
check(
    "the delta instruction is still there, because that is why the block exists",
    carried.includes("report only what has changed since then"),
);
check(
    "the rule says to re-check before repeating, not merely to be careful",
    /check it against its source again this run before you repeat it/.test(CARRIED_CLAIM_RULE),
);
check(
    "it demands the source's date and origin, so a repeated claim is auditable",
    CARRIED_CLAIM_RULE.replace(/\s+/g, " ").includes("say when and where that source was"),
);
check(
    "an unverifiable claim is dropped rather than hedged",
    CARRIED_CLAIM_RULE.includes("drop it rather") && CARRIED_CLAIM_RULE.includes("hedging it"),
);
check(
    "it names what decays, rather than asking for everything to be re-derived",
    ["a person", "a pending decision", "still open"].every((what) => CARRIED_CLAIM_RULE.includes(what)),
);
check("no em-dashes reach the user's agents", !CARRIED_CLAIM_RULE.includes("—"));

/**
 * And a run with no baseline gets no rule: there is nothing to carry forward,
 * so the instruction would be furniture in a first-run prompt.
 */
const firstRun = makeSchedule({
    title: "Fresh watcher",
    task: "Watch it.",
    cadence: { kind: "interval", minutes: 45 },
});
check("a watcher that has never run carries no rule", previousRunBlock(firstRun) === "");

/** The orchestrator's decision, stated as it states it. */
function speaks(status: "done" | "failed" | "cancelled", result: string, firstBlind = true): boolean {
    if (status === "cancelled") return false;
    if (status === "done" && isCouldNotCheck(result)) return firstBlind;
    if (status === "done" && isNothingToReport(result)) return false;
    return true;
}

check("a blind watcher speaks up the first time", speaks("done", "COULD NOT CHECK — no mail tool."));
check("but not the thirtieth", !speaks("done", "COULD NOT CHECK — no mail tool.", false));
check("a quiet watcher still says nothing", !speaks("done", "NOTHING TO REPORT"));
check("a watcher with news still speaks", speaks("done", "Becca is waiting."));

// MARK: - Report

console.log(`\n${passed} checks passed.`);
if (failures.length > 0) {
    console.error(`${failures.length} failed:`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exit(1);
}
console.log("Silence rules verified.\n");
