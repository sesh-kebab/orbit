/**
 * Verification for *when* the calendar is read again.
 *
 *   npm run verify:meetings
 *
 * This suite exists twice. It was written on 15 August against a Saturday that
 * cost twenty-nine scans of an empty calendar, shipped on a branch, and then
 * lost: the branch was deleted without ever being merged while the proposal
 * that tracked it was marked "shipped". On 11 September the scan ran thirty
 * times at a flat forty-six minutes, twelve of them between midnight and eight
 * in the morning, which is how the loss was noticed. So the replay at the
 * bottom is the point of the file: it puts a number on the regression, and the
 * number is what would have gone red.
 *
 * Everything under test is pure, so this needs no clock, calendar or agent.
 */
import {
    ACTIVE_RESCAN_MS,
    IDLE_RESCAN_MS,
    MIN_RESCAN_MS,
    WEEKEND_RESCAN_MS,
    headsUpAt,
    inQuietHours,
    isWeekend,
    nextCalendarScanDelay,
    quietWindowEnd,
    type Meeting,
    type MeetingPlan,
} from "../src/main/orchestrator/meetings.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: unknown): void {
    if (condition) {
        passed += 1;
        return;
    }
    failures.push(`${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

/** Matches the orchestrator's own horizon and blind cadence. */
const HORIZON_MS = 4 * 60 * 60 * 1000;
const BLIND_MS = 6 * 60 * 60 * 1000;

const MINUTE = 60 * 1000;

/** Thursday 10 September 2026 is a weekday; Saturday 12 September is not. */
const weekdayAt = (hour: number, minute = 0): number =>
    new Date(2026, 8, 10, hour, minute, 0, 0).getTime();
const weekendAt = (hour: number, minute = 0): number =>
    new Date(2026, 8, 12, hour, minute, 0, 0).getTime();

function meeting(at: number, id = "m"): Meeting {
    return { id, subject: "A meeting", start: at, others: ["Someone"] };
}

const plan = (meetings: Meeting[]): MeetingPlan => ({ ok: true, meetings });
const blind: MeetingPlan = { ok: false, problem: "no-calendar", detail: "nothing signed in" };
const unreadable: MeetingPlan = { ok: false, problem: "unreadable", detail: "not a list" };

const delay = (now: number, p: MeetingPlan): number =>
    nextCalendarScanDelay(now, p, HORIZON_MS, BLIND_MS);

// MARK: - The windows themselves

check("22:00 is quiet", inQuietHours(weekdayAt(22)));
check("02:00 is quiet", inQuietHours(weekdayAt(2)));
check("06:29 is still quiet", inQuietHours(weekdayAt(6, 29)));
check("06:30 is not quiet", !inQuietHours(weekdayAt(6, 30)));
check("09:00 is not quiet", !inQuietHours(weekdayAt(9)));
check("21:59 is not quiet", !inQuietHours(weekdayAt(21, 59)));

check("Saturday is a weekend", isWeekend(weekendAt(9)));
check("Thursday is not", !isWeekend(weekdayAt(9)));

check(
    "quiet window ends at 06:30 the same morning",
    quietWindowEnd(weekdayAt(2)) === weekdayAt(6, 30),
);
check(
    "quiet window from 23:00 ends at 06:30 the next morning",
    quietWindowEnd(weekdayAt(23)) === weekdayAt(6, 30) + 24 * 60 * MINUTE,
);
check("quiet window end is strictly ahead", quietWindowEnd(weekdayAt(6, 30)) > weekdayAt(6, 30));

// MARK: - A day with meetings still in it keeps the frequent cadence

{
    const now = weekdayAt(9);
    const d = delay(now, plan([meeting(weekdayAt(17))]));
    check("a weekday with a meeting far ahead keeps 45 minutes", d === ACTIVE_RESCAN_MS, d / MINUTE);
}

// MARK: - A day that has run out backs off

{
    const now = weekdayAt(18);
    const d = delay(now, plan([meeting(weekdayAt(9))]));
    check("a weekday with nothing left backs off to two hours", d === IDLE_RESCAN_MS, d / MINUTE);
}
{
    const d = delay(weekdayAt(12), plan([]));
    check("an empty weekday backs off to two hours", d === IDLE_RESCAN_MS, d / MINUTE);
}
{
    const d = delay(weekendAt(12), plan([]));
    check("an empty weekend backs off to four hours", d === WEEKEND_RESCAN_MS, d / MINUTE);
}
{
    const now = weekendAt(9);
    const d = delay(now, plan([meeting(weekendAt(20))]));
    check(
        "a weekend with a meeting is slower than a weekday but not four hours",
        d === ACTIVE_RESCAN_MS * 2,
        d / MINUTE,
    );
}

// MARK: - Overnight is skipped

{
    const now = weekdayAt(0, 5);
    const d = delay(now, plan([]));
    check("midnight on an empty day sleeps until 06:30", now + d === weekdayAt(6, 30), d / MINUTE);
}
{
    const now = weekdayAt(23);
    const d = delay(now, plan([]));
    check(
        "11pm sleeps until 06:30 the next morning",
        now + d === weekdayAt(6, 30) + 24 * 60 * MINUTE,
        d / MINUTE,
    );
}
{
    // A meeting genuinely inside the quiet window must not be slept through.
    const early = weekdayAt(7);
    const now = weekdayAt(2);
    const d = delay(now, plan([meeting(early)]));
    check("an 07:00 meeting is still scanned for overnight", now + d < weekdayAt(6, 30), d / MINUTE);
    check(
        "and that scan is early enough to arm it",
        now + d <= headsUpAt({ start: early }) - HORIZON_MS,
        d / MINUTE,
    );
}

// MARK: - Backing off can never drop a heads-up

{
    // The cap only has work to do when the meeting is not yet armable. Here it
    // is: a weekend would otherwise wait 90 minutes and miss the 12:55 moment.
    const soon = weekendAt(17);
    const now = weekendAt(12);
    const armableAt = headsUpAt({ start: soon }) - HORIZON_MS;
    const d = delay(now, plan([meeting(soon)]));
    check("the cap has work to do here", armableAt > now && armableAt - now < ACTIVE_RESCAN_MS * 2);
    check(
        "the next scan never lands after the meeting becomes armable",
        now + d === armableAt,
        { delay: d / MINUTE, armableIn: (armableAt - now) / MINUTE },
    );
}
{
    // And when the meeting is already armable the cap is moot: its timer is set,
    // so the cadence is free to be the ordinary one.
    const now = weekdayAt(12);
    const d = delay(now, plan([meeting(weekdayAt(13))]));
    check("an already-armable meeting keeps the ordinary cadence", d === ACTIVE_RESCAN_MS, d / MINUTE);
}
{
    // Already armable: the cap has passed, so the floor is what protects us.
    const now = weekdayAt(12);
    const d = delay(now, plan([meeting(weekdayAt(12, 30))]));
    check("an imminent meeting does not produce a zero delay", d >= MIN_RESCAN_MS, d / MINUTE);
}
{
    const now = weekdayAt(12);
    const d = delay(now, plan([meeting(weekdayAt(12, 1))]));
    check("nor does one in the past-ish", d >= MIN_RESCAN_MS, d / MINUTE);
}
{
    const now = weekdayAt(9);
    const past = plan([meeting(weekdayAt(8))]);
    check("a meeting already over does not hold the cadence open", delay(now, past) === IDLE_RESCAN_MS);
}

// MARK: - A blind scan is not an empty day

{
    const d = delay(weekdayAt(12), blind);
    check("a calendar that cannot be read retries on the blind cadence", d === BLIND_MS, d / MINUTE);
}
{
    const d = delay(weekdayAt(2), blind);
    check("and is not stretched further by the quiet window", d === BLIND_MS, d / MINUTE);
}
{
    const d = delay(weekendAt(12), unreadable);
    check("an unreadable reply is treated the same way", d === BLIND_MS, d / MINUTE);
}
{
    check(
        "a blind scan never backs off further than a quiet one would",
        delay(weekdayAt(12), blind) >= IDLE_RESCAN_MS,
    );
}

// MARK: - Full-day replay, which is the whole point

/**
 * Walk a day the way the orchestrator does: scan, ask when to scan next, jump
 * there. Returns the local times it would have fired.
 */
function replay(dayStart: number, meetings: Meeting[]): string[] {
    const end = dayStart + 24 * 60 * MINUTE;
    const fired: string[] = [];
    let now = dayStart;
    // Midnight rolls the day over and schedules rather than scans.
    if (inQuietHours(now)) now = quietWindowEnd(now);
    while (now < end && fired.length < 200) {
        fired.push(new Date(now).toTimeString().slice(0, 5));
        now += delay(now, plan(meetings));
    }
    return fired;
}

const fiveMeetingWeekday = [9, 11, 13, 15, 16].map((hour, index) =>
    meeting(weekdayAt(hour), `m${index}`),
);

const saturday = replay(weekendAt(0), []);
const emptyWeekday = replay(weekdayAt(0), []);
const busyWeekday = replay(weekdayAt(0), fiveMeetingWeekday);

check("an empty Saturday costs few scans", saturday.length <= 5, saturday);
check("an empty weekday costs few scans", emptyWeekday.length <= 9, emptyWeekday);
check("a five-meeting weekday is still watched closely", busyWeekday.length >= 15, busyWeekday.length);
check("but never more than the old flat cadence", busyWeekday.length <= 32, busyWeekday.length);
check("no scan happens before 06:30 on any of them", [saturday, emptyWeekday, busyWeekday].every((day) => day.every((time) => time >= "06:30")));
check(
    "every meeting on the busy day is armed by some scan",
    fiveMeetingWeekday.every((m) => {
        const armable = headsUpAt(m) - HORIZON_MS;
        return busyWeekday.some((time) => {
            const [h, min] = time.split(":").map(Number);
            const at = weekdayAt(h, min);
            return at >= armable && at <= headsUpAt(m);
        });
    }),
    busyWeekday,
);

// The flat cadence this replaces, for the record: 24h / 46m.
const FLAT_SCANS_OBSERVED = 30;

console.log(
    `\nScans per day — empty Saturday: ${saturday.length}, empty weekday: ${emptyWeekday.length},` +
        ` five-meeting weekday: ${busyWeekday.length}.` +
        `\nObserved on 11 September under the flat cadence: ${FLAT_SCANS_OBSERVED}, twelve of them before 08:00.`,
);

// MARK: - Report

console.log(`\n${passed} checks passed.`);
if (failures.length > 0) {
    console.error(`${failures.length} failed:`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exit(1);
}
console.log("Calendar scan cadence verified.\n");
