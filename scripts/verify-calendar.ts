/**
 * Verification for reading a calendar scan — and, more to the point, for
 * telling "your day is clear" apart from "I cannot see your day".
 *
 *   npm run verify:calendar
 *
 * Everything under test is pure, so this needs no calendar, which is fitting.
 */
import {
    calendarUnavailableMessage,
    describesNoCalendarAccess,
    parseMeetingPlan,
    readMeetingPlan,
    type Meeting,
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

/** A fixed "now" so the past/future filter is decided, not observed. */
const NOW = new Date(2026, 7, 23, 9, 0, 0, 0).getTime();
const iso = (hour: number, minute = 0): string =>
    new Date(2026, 7, 23, hour, minute, 0, 0).toISOString();

function meetingsOf(reply: string): Meeting[] {
    const plan = readMeetingPlan(reply, NOW);
    return plan.ok ? plan.meetings : [];
}

// MARK: - The happy path still works

const ONE = JSON.stringify([
    { id: "a", subject: "1:1 with Dorian", start: iso(11), end: iso(11, 30), others: ["Dorian Co"] },
]);

const plainList = readMeetingPlan(ONE, NOW);
check("a bare array is a plan", plainList.ok);
check("its meetings come through", meetingsOf(ONE).length === 1, meetingsOf(ONE).length);
check("the attendee survives", meetingsOf(ONE)[0]?.others[0] === "Dorian Co");

const fenced = readMeetingPlan("```json\n" + ONE + "\n```", NOW);
check("a fenced array is a plan", fenced.ok && fenced.meetings.length === 1);

const empty = readMeetingPlan("[]", NOW);
check("a bare [] is a clear day, not a failure", empty.ok && empty.meetings.length === 0);
check("[] with whitespace is still a clear day", readMeetingPlan("  []\n", NOW).ok);
check("[] in a fence is still a clear day", readMeetingPlan("```json\n[]\n```", NOW).ok);

// Ordering, past-filtering and junk-dropping are unchanged behaviour.
const MIXED = JSON.stringify([
    { id: "late", subject: "Late", start: iso(16), others: [] },
    { id: "past", subject: "Already gone", start: iso(8), others: [] },
    { id: "soon", subject: "Soon", start: iso(10), others: [] },
    { id: "junk", start: "not a date", others: [] },
]);
const mixed = meetingsOf(MIXED);
check("past meetings are dropped", mixed.every((m) => m.start >= NOW), mixed.map((m) => m.subject));
check("unparseable entries are dropped", mixed.length === 2, mixed.length);
check("meetings come back in time order", mixed[0]?.subject === "Soon" && mixed[1]?.subject === "Late");

// MARK: - 23 August, replayed exactly

/**
 * The real reply, at 06:16 local. The agent refused to say `[]` and explained
 * why — and the old parser scraped the `[]` out of that very explanation and
 * recorded a clear day.
 */
const AUG_23_REPLY = [
    "No calendar tool is available, so I can't return a valid result (returning `[]` would",
    'falsely imply "no meetings").',
    "Tried and failed:",
    "- **Outlook desktop**: AppleScript works but no account is signed in (empty 4 MB HxStore, 0 events).",
    "- **Apple Calendar**: no local store; AppleScript times out.",
    "- **Microsoft Graph via `az`**: token blocked — `AADSTS530084` conditional access token protection.",
    "**Action needed:** sign into Microsoft Outlook.app, or connect a calendar MCP/integration for Orbit.",
].join("\n");

/** What the old parser did: outermost brackets, anywhere in the reply. */
function legacyExtract(reply: string): string | undefined {
    const text = reply.trim();
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end <= start) return undefined;
    return text.slice(start, end + 1);
}
check(
    "the old parser really did read that reply as an empty day",
    legacyExtract(AUG_23_REPLY) === "[]",
    legacyExtract(AUG_23_REPLY),
);

const aug23 = readMeetingPlan(AUG_23_REPLY, NOW);
check("23 August's reply is no longer a plan", !aug23.ok);
check("it is diagnosed as having no calendar", !aug23.ok && aug23.problem === "no-calendar", aug23);
check(
    "the detail names the problem in one sentence",
    !aug23.ok && aug23.detail.startsWith("No calendar tool is available"),
    !aug23.ok ? aug23.detail : undefined,
);
check("the detail is short enough for an open item", !aug23.ok && aug23.detail.length <= 200);

// MARK: - Other ways a calendar goes missing

const UNAVAILABLE = [
    "I have no calendar tool, so I cannot list meetings.",
    "Outlook is not signed in — please sign in to Outlook and try again.",
    "Microsoft Graph returned AADSTS530084, so the token was blocked.",
    "Unable to access the calendar: conditional access denied the request.",
    "Authentication failed; the calendar is not available.",
    "There is no calendar MCP server configured for me to call.",
];
for (const reply of UNAVAILABLE) {
    const plan = readMeetingPlan(reply, NOW);
    check(`recognised as no-calendar: "${reply.slice(0, 42)}..."`, !plan.ok && plan.problem === "no-calendar", plan);
}

// MARK: - The lines that must NOT be mistaken for a broken calendar

const NOT_A_PROBLEM = ["[]", "```json\n[]\n```", ONE];
for (const reply of NOT_A_PROBLEM) {
    check(`a real answer is never called broken: ${reply.slice(0, 24)}`, readMeetingPlan(reply, NOW).ok);
}
check("plain data is not read as an excuse", !describesNoCalendarAccess(ONE));
check("an empty array is not read as an excuse", !describesNoCalendarAccess("[]"));

// Garbage that is not an explanation is unreadable, not a diagnosis.
const shrug = readMeetingPlan("Sure thing!", NOW);
check("unexplained nonsense is unreadable, not no-calendar", !shrug.ok && shrug.problem === "unreadable", shrug);
const blank = readMeetingPlan("   ", NOW);
check("an empty reply is unreadable", !blank.ok && blank.problem === "unreadable");
const broken = readMeetingPlan("[{ not json", NOW);
check("malformed JSON is unreadable", !broken.ok && broken.problem === "unreadable", broken);

// MARK: - Prose around real meetings is still data

const CHATTY = `Here is what I found for the rest of today:\n${ONE}\nLet me know if you need more.`;
const chatty = readMeetingPlan(CHATTY, NOW);
check("prose wrapped around real meetings is still a plan", chatty.ok && chatty.meetings.length === 1, chatty);
check(
    "prose wrapped around an empty array is not",
    !readMeetingPlan("I couldn't reach the calendar, so: []", NOW).ok,
);

// MARK: - The compatibility shim

check("parseMeetingPlan still returns meetings", parseMeetingPlan(ONE, NOW).length === 1);
check("parseMeetingPlan is empty for a broken calendar", parseMeetingPlan(AUG_23_REPLY, NOW).length === 0);

// MARK: - What the user is told

const message = calendarUnavailableMessage("Outlook is not signed in.");
check("the message admits the day is unknown, not clear", /unknown rather than clear/i.test(message), message);
check("the message says how to fix it", /sign in to outlook/i.test(message), message);
check("the message carries the detail", message.includes("Outlook is not signed in."), message);
check("the message recovers on its own", /on their own/i.test(message), message);

// MARK: - The polling arithmetic

const SCANS_ON_AUG_23 = 29;
const perDayBefore = Math.floor((24 * 60) / 45);
const perDayAfter = Math.floor((24 * 60) / (6 * 60));
check("the old cadence explains 23 August's scan count", Math.abs(perDayBefore - SCANS_ON_AUG_23) <= 4, {
    perDayBefore,
    SCANS_ON_AUG_23,
});
check("the blind cadence is far cheaper", perDayAfter <= 4, perDayAfter);

console.log(
    `\nBlind calendar scans per day: ${perDayBefore} before, ${perDayAfter} after.` +
        `\n23 August's honest reply is now read as "${!aug23.ok ? aug23.problem : "a plan"}" rather than a clear day.`,
);

// MARK: - Report

console.log(`\n${passed} checks passed.`);
if (failures.length > 0) {
    console.error(`${failures.length} failed:`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exit(1);
}
console.log("Calendar reading verified.\n");
