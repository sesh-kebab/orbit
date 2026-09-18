/**
 * Verification for the attention gate: how much Orbit may say into a silence.
 *
 *   npm run verify:attention
 *
 * Built from the interaction log of 17 September 2026, which is reproduced
 * below turn for turn. That day Orbit took 33 turns and Seshi sent 4 messages.
 * Between 10:07 and 14:27 local, Orbit spoke fifteen consecutive times without
 * a single reply, five minutes apart for the first half hour of it, and three
 * of those turns said nothing except that Orbit was being quiet.
 *
 * The first check in this file is that run, replayed, and asserted to be
 * shorter under the gate than it was without it.
 *
 * Pure, so it needs no app and no clock.
 */
import {
    ATTENTION_GRACE,
    QUIET_BASE_MS,
    QUIET_CEILING_MS,
    SILENCE_AFFORDANCE,
    SILENCE_TOKEN,
    decideInterrupt,
    isSilence,
    requiredGapMs,
} from "../src/main/orchestrator/attention.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: unknown): void {
    if (condition) {
        passed += 1;
        return;
    }
    failures.push(`${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// MARK: - The run of fifteen, from the log of 17 September 2026

/** Local clock, the day it happened. */
const at = (hh: number, mm: number): number => Date.UTC(2026, 8, 17, hh + 7, mm);

/**
 * Every turn Orbit took between Seshi's 10:03 message and his 14:43 one, in
 * order. Four of them carried nothing he could act on, three of those being
 * pure announcements of silence; they are marked, because the gate's job is to
 * make the channel that produced them impossible.
 */
const theRun: Array<{ at: number; text: string; empty?: true }> = [
    { at: at(10, 7), text: "Dylan's still blocked on the Garrison hour-pack endpoint. Want me to chase?" },
    { at: at(10, 12), text: "Store Spotlight is worth parking in your head for the 11:00." },
    { at: at(10, 17), text: "Going quiet until the 11:00.", empty: true },
    { at: at(10, 22), text: "Breaking my own silence once, because it's 38 minutes out: section 4." },
    { at: at(10, 27), text: "Nothing further from me before 11:00.", empty: true },
    { at: at(10, 32), text: "Still holding.", empty: true },
    { at: at(11, 15), text: "Lunch: 12:30 to 1:05, 35 minutes. Take it." },
    { at: at(12, 2), text: "Two days, no answer: Dylan's 15 Sep question is still the last message." },
    { at: at(14, 0), text: "That sprint follow-up draft from Sunday is still unsent three days on." },
    { at: at(14, 2), text: "Both remaining pre-read items are about a meeting three hours behind you." },
    { at: at(14, 7), text: "xbox-ads-planning can't merge until you adjudicate the work item map." },
    { at: at(14, 12), text: "Closed the section 4 item myself. Everything else left is git.", empty: true },
    { at: at(14, 17), text: "Michael Kim asked you on 9 Sep to sort the AltVideoPlayer registration." },
    { at: at(14, 22), text: "Tomorrow's Squad Agreement session can't settle AdsAggregator ownership." },
    { at: at(14, 27), text: "Bug 64150443: concurrent browser sessions bypass the Fresno pre-roll queue." },
];

check("the run really was fifteen turns", theRun.length === 15, theRun.length);
check("four of them carried nothing new", theRun.filter((t) => t.empty).length === 4);

/** Replay: how many of those fifteen would the gate have let through? */
function replay(turns: typeof theRun): number[] {
    let unanswered = 0;
    let lastProactiveAt: number | undefined;
    const allowed: number[] = [];
    for (const turn of turns) {
        const verdict = decideInterrupt({ unanswered, lastProactiveAt }, turn.at);
        if (!verdict.speak) continue;
        allowed.push(turn.at);
        unanswered += 1;
        lastProactiveAt = turn.at;
    }
    return allowed;
}

const allowed = replay(theRun);

check("the gate cuts the run of fifteen", allowed.length < theRun.length, allowed.length);
check("it cuts it by more than half", allowed.length <= 7, allowed.length);
check("it does not silence him outright", allowed.length >= 4, allowed.length);
check("the first two go straight through, because grace is two", allowed[0] === at(10, 7) && allowed[1] === at(10, 12));
check(
    "the third is held: 10:17 came five minutes after 10:12",
    !allowed.includes(at(10, 17)),
);
check(
    "the five-minute 10:22, 10:27, 10:32 cluster cannot all survive",
    [at(10, 22), at(10, 27), at(10, 32)].filter((t) => allowed.includes(t)).length <= 1,
);
check(
    "the 14:00 to 14:27 cluster of six is cut to at most two",
    allowed.filter((t) => t >= at(14, 0)).length <= 2,
);

// MARK: - Grace

check("grace is two turns", ATTENTION_GRACE === 2);
check("the first turn is free", requiredGapMs(0) === 0);
check("the second turn is free", requiredGapMs(1) === 0);
check("the third owes the base gap", requiredGapMs(2) === QUIET_BASE_MS);
check("a fresh channel may always speak", decideInterrupt({ unanswered: 0 }, at(9, 0)).speak);
check(
    "a channel in grace may speak however recently it spoke",
    decideInterrupt({ unanswered: 1, lastProactiveAt: at(9, 0) }, at(9, 0) + 1).speak,
);

// MARK: - Doubling, and the ceiling

check("the gap doubles", requiredGapMs(3) === QUIET_BASE_MS * 2);
check("and again", requiredGapMs(4) === QUIET_BASE_MS * 4);
check("and again", requiredGapMs(5) === QUIET_BASE_MS * 8);
check("it holds flat at the ceiling", requiredGapMs(40) === QUIET_CEILING_MS);
check("the ceiling is never exceeded", [...Array(200).keys()].every((n) => requiredGapMs(n) <= QUIET_CEILING_MS));
check("the gap never shrinks as silence lengthens", [...Array(60).keys()].every((n) => requiredGapMs(n + 1) >= requiredGapMs(n)));
check("the ceiling is three hours, not a day", QUIET_CEILING_MS === 3 * HOUR);
check("the base is fifteen minutes, longer than the five-minute chase tick", QUIET_BASE_MS === 15 * MINUTE);

// MARK: - Serving the gap earns the turn back

const owing = decideInterrupt({ unanswered: 4, lastProactiveAt: at(9, 0) }, at(9, 10));
check("a gap not yet served refuses", !owing.speak);
check("and says how much is still owed", /more quiet/.test(owing.because), owing.because);
check("and reports the gap it is enforcing", owing.requiredGapMs === QUIET_BASE_MS * 4);

const served = decideInterrupt({ unanswered: 4, lastProactiveAt: at(9, 0) }, at(10, 1));
check("once the gap is served the turn goes out", served.speak);

check(
    "exactly on the boundary counts as served, not as one millisecond short",
    decideInterrupt({ unanswered: 3, lastProactiveAt: at(9, 0) }, at(9, 0) + QUIET_BASE_MS * 2).speak,
);

// MARK: - A user who comes back resets it completely

const deepInBackoff = decideInterrupt({ unanswered: 12, lastProactiveAt: at(14, 0) }, at(14, 5));
check("twelve unanswered turns is deep in back-off", !deepInBackoff.speak);
check(
    "one message from him and the channel is at full volume again",
    decideInterrupt({ unanswered: 0, lastProactiveAt: at(14, 0) }, at(14, 5)).speak,
);

// MARK: - Nothing to say

check("the token is recognised", isSilence(SILENCE_TOKEN));
check("bare, without the brackets", isSilence("nothing to add"));
check("with whitespace around it", isSilence("  (nothing to add)  \n"));
check("with a full stop", isSilence("(nothing to add)."));
check("wrapped in markdown emphasis", isSilence("*(nothing to add)*"));
check("in a code span, which a model sometimes does", isSilence("`(nothing to add)`"));
check("case-insensitively", isSilence("(Nothing To Add)"));

check("a real turn is not swallowed", !isSilence("Still holding."));
check(
    "nor one that merely ends with the phrase",
    !isSilence("The Fresno call is yours and there is nothing to add"),
);
check(
    "nor one that quotes the token inside a real message",
    !isSilence("I would have said (nothing to add) but the bug is live."),
);
check("nor an empty string", !isSilence(""));
check("nor a lone full stop", !isSilence("."));

// MARK: - The affordance actually reaches the model

check("the affordance names the token", SILENCE_AFFORDANCE.includes(SILENCE_TOKEN));
check(
    "and says silence beats announcing silence, which is the whole lesson of 17 Sep",
    /staying quiet/.test(SILENCE_AFFORDANCE),
);
check("the token itself passes the recogniser", isSilence(SILENCE_TOKEN));

// MARK: - The three turns that started this

for (const text of ["Going quiet until the 11:00.", "Nothing further from me before 11:00.", "Still holding."]) {
    check(`"${text}" is not a silence token, it is a turn`, !isSilence(text));
}

// MARK: - Report

const saved = theRun.length - allowed.length;
console.log(
    `\nReplaying 17 Sep 2026, 10:07 to 14:27 local: Orbit spoke ${theRun.length} times unanswered.` +
        `\n  Under the gate: ${allowed.length} turns, ${saved} held.` +
        `\n  Grace ${ATTENTION_GRACE}, then ${QUIET_BASE_MS / MINUTE}m doubling to a ${
            QUIET_CEILING_MS / HOUR
        }h ceiling, reset by anything he says.`,
);

console.log(`\n${passed} checks passed.`);
if (failures.length > 0) {
    console.error(`${failures.length} failed:`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exit(1);
}
console.log("Attention gate and silence token verified.\n");
