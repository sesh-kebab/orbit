/**
 * Checks for the board and the judgement laid over it.
 *
 *   npm run verify:board
 *
 * No clock, no filesystem, no Electron: every case below is a plain struct of
 * records handed to `deriveBoard`, which is the whole reason the rules were put
 * in a module of their own rather than on the orchestrator.
 *
 * The two invariants at the bottom are the important part of this file. The
 * individual generators can be argued with case by case, and probably will be;
 * the rules that nothing inferred from prose is ever called `certain`, and that
 * no call ships without a basis, are what make the surface worth reading at all.
 * They are checked against every call the fixtures can produce rather than
 * against the handful written out by hand, so a generator added later cannot
 * quietly break them.
 */
import {
    DECISION_STALE_MS,
    DENY_WARN_MS,
    LANDED_WINDOW_MS,
    MAX_LIVE_AGENTS,
    RESULT_STALE_MS,
    clip,
    deriveBlindSpots,
    deriveBoard,
    deriveThreads,
    describeSpan,
    describeWhen,
    mentionsAnyName,
    threadsInLane,
    type BoardFacts,
} from "../src/main/orchestrator/board.js";
import type {
    ActivityEntry,
    AgentView,
    Board,
    ChiefCall,
    OpenItem,
    PendingRequest,
    Schedule,
} from "../src/shared/types.js";

let passed = 0;
const failures: string[] = [];

function check(what: string, actual: unknown, expected: unknown): void {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a === b) {
        passed++;
        return;
    }
    failures.push(`${what}\n    expected ${b}\n    actual   ${a}`);
}

function ok(what: string, condition: boolean): void {
    check(what, condition, true);
}

const NOW = new Date(2026, 8, 10, 14, 0).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// MARK: - Fixtures

function agent(patch: Partial<AgentView> = {}): AgentView {
    return {
        id: "agent-1",
        title: "Draft the Q3 headcount case",
        task: "Write it up.",
        status: "running",
        cwd: "/repo",
        hue: 0.4,
        createdAt: NOW - HOUR,
        startedAt: NOW - HOUR,
        lastActivityAt: NOW - MINUTE,
        toolCalls: 12,
        steps: [],
        inputTokens: 0,
        outputTokens: 0,
        ...patch,
    };
}

function schedule(patch: Partial<Schedule> = {}): Schedule {
    return {
        id: "sch-1",
        title: "Watch the deploy pipeline",
        task: "Check it.",
        cadence: { kind: "interval", minutes: 30 },
        enabled: true,
        createdAt: NOW - 30 * DAY,
        nextRunAt: NOW + 20 * MINUTE,
        runCount: 40,
        quiet: true,
        ...patch,
    };
}

function request(patch: Partial<PendingRequest> = {}): PendingRequest {
    return {
        id: "req-1",
        agentId: "agent-1",
        kind: "permission",
        title: "wants to push to origin",
        options: [],
        allowFreeform: false,
        createdAt: NOW - 5 * MINUTE,
        ...patch,
    };
}

function openItem(patch: Partial<OpenItem> = {}): OpenItem {
    return {
        id: "open-1",
        text: "Shall I retire the nightly dependency watcher?",
        createdAt: NOW - HOUR,
        resolved: false,
        ...patch,
    };
}

function entry(patch: Partial<ActivityEntry> = {}): ActivityEntry {
    return {
        id: "act-1",
        at: NOW - DAY,
        day: "2026-09-09",
        kind: "draft_composed",
        description: "Promo packet for Rahul",
        status: "awaiting_seshi",
        ...patch,
    };
}

function facts(patch: Partial<BoardFacts> = {}): BoardFacts {
    return {
        agents: [],
        requests: [],
        schedules: [],
        openItems: [],
        activity: [],
        meetings: [],
        leave: [],
        requestTimeoutMinutes: 10,
        agentTimeoutMinutes: 60,
        ...patch,
    };
}

function board(patch: Partial<BoardFacts> = {}): Board {
    return deriveBoard(facts(patch), NOW);
}

function callKinds(result: Board): string[] {
    return result.calls.map((call) => call.kind);
}

function headlines(result: Board): string {
    return result.calls.map((call) => call.headline).join(" | ");
}

// MARK: - Laning

check("an empty world has no threads", deriveThreads(facts(), NOW).length, 0);

check(
    "a running agent is in flight",
    deriveThreads(facts({ agents: [agent()] }), NOW)[0].lane,
    "running",
);
check(
    "an agent with a question outstanding is blocked on him",
    deriveThreads(facts({ agents: [agent({ status: "needs-input" })], requests: [request()] }), NOW)[0]
        .lane,
    "you",
);
check(
    "and the row says what it is actually asking",
    deriveThreads(facts({ agents: [agent({ status: "needs-input" })], requests: [request()] }), NOW)[0]
        .detail,
    "wants to push to origin",
);
check(
    "a failed agent is stuck",
    deriveThreads(facts({ agents: [agent({ status: "failed", endedAt: NOW - MINUTE, error: "boom" })] }), NOW)[0]
        .lane,
    "stuck",
);
check(
    "a finished agent has landed",
    deriveThreads(facts({ agents: [agent({ status: "done", endedAt: NOW - HOUR, result: "Done." })] }), NOW)[0]
        .lane,
    "landed",
);
check(
    "an old finished agent leaves the board to the log",
    deriveThreads(
        facts({ agents: [agent({ status: "done", endedAt: NOW - LANDED_WINDOW_MS - HOUR, result: "Done." })] }),
        NOW,
    ).length,
    0,
);
// A thread somebody deliberately ended is not unfinished business, and showing
// it as such makes every deliberate choice look like a loose end.
check(
    "a cancelled agent is off the board entirely",
    deriveThreads(facts({ agents: [agent({ status: "cancelled", endedAt: NOW - MINUTE })] }), NOW).length,
    0,
);

check(
    "an enabled watcher is running unattended",
    deriveThreads(facts({ schedules: [schedule()] }), NOW)[0].lane,
    "running",
);
check(
    "a paused watcher is nowhere: it is paused on purpose",
    deriveThreads(facts({ schedules: [schedule({ enabled: false })] }), NOW).length,
    0,
);
check(
    "an archived watcher is nowhere either",
    deriveThreads(facts({ schedules: [schedule({ archived: true })] }), NOW).length,
    0,
);
check(
    "a blind watcher is stuck, not running",
    deriveThreads(facts({ schedules: [schedule({ blindRuns: 3, lastRunAt: NOW - HOUR })] }), NOW)[0].lane,
    "stuck",
);

// The double-count that made two rows out of one piece of work: a watcher
// mid-run is already on the board as the agent running it.
const midRun = deriveThreads(
    facts({
        schedules: [schedule({ activeAgentId: "agent-1" })],
        agents: [agent({ id: "agent-1", scheduleId: "sch-1" })],
    }),
    NOW,
);
check("a watcher mid-run is one thread, not two", midRun.length, 1);
check("and it is the agent that carries it", midRun[0].kind, "agent");
check("with the watcher's id kept on it", midRun[0].scheduleId, "sch-1");

check(
    "an unresolved decision is blocked on him",
    deriveThreads(facts({ openItems: [openItem()] }), NOW)[0].lane,
    "you",
);
check(
    "a settled one is gone",
    deriveThreads(facts({ openItems: [openItem({ resolved: true })] }), NOW).length,
    0,
);

check(
    "a delivery sitting with him is blocked on him",
    deriveThreads(facts({ activity: [entry()] }), NOW)[0].lane,
    "you",
);
check(
    "a stalled delivery is stuck",
    deriveThreads(facts({ activity: [entry({ status: "stalled" })] }), NOW)[0].lane,
    "stuck",
);
// The distinction the lane exists to make, and the reason `waitingOn` is a
// recorded field rather than something read out of the description.
check(
    "a delivery someone else owes is on others, not on him",
    deriveThreads(facts({ activity: [entry({ waitingOn: "the data platform team" })] }), NOW)[0].lane,
    "others",
);
check(
    "and it names who",
    deriveThreads(facts({ activity: [entry({ waitingOn: "the data platform team" })] }), NOW)[0].detail,
    "Waiting on the data platform team.",
);
check(
    "who owes it beats what its status happens to say",
    deriveThreads(facts({ activity: [entry({ status: "stalled", waitingOn: "Priya" })] }), NOW)[0].lane,
    "others",
);
check(
    "an abandoned delivery is not a thread",
    deriveThreads(facts({ activity: [entry({ status: "abandoned" })] }), NOW).length,
    0,
);

// MARK: - Ordering

const mixed = deriveThreads(
    facts({
        agents: [
            agent({ id: "a-run" }),
            agent({ id: "a-done", status: "done", endedAt: NOW - MINUTE, result: "Done." }),
        ],
        openItems: [openItem()],
        activity: [entry({ status: "stalled" })],
    }),
    NOW,
);
check("what is on him comes first", mixed[0].lane, "you");
check("then what is stuck", mixed[1].lane, "stuck");
check("then what is running", mixed[2].lane, "running");
check("and what landed comes last", mixed[3].lane, "landed");

// Age is the damage in the blocked lanes, so the oldest is the one to look at.
const twoWaiting = deriveThreads(
    facts({
        openItems: [
            openItem({ id: "new", text: "Recent", createdAt: NOW - HOUR }),
            openItem({ id: "old", text: "Ancient", createdAt: NOW - 9 * DAY }),
        ],
    }),
    NOW,
);
check("the oldest thing waiting on him is first", twoWaiting[0].title, "Ancient");

// MARK: - Exposure

const denying = board({
    agents: [agent({ status: "needs-input" })],
    requests: [request({ createdAt: NOW - 6 * MINUTE })],
    requestTimeoutMinutes: 10,
});
ok("a request about to auto-deny is raised", callKinds(denying).includes("exposure"));
ok("and it says so plainly", headlines(denying).includes("denies itself"));
check(
    "auto-deny is arithmetic, so it is certain",
    denying.calls.find((call) => call.id.startsWith("exposure:request"))!.confidence,
    "certain",
);
ok(
    "and it names what is stopped until then",
    denying.calls
        .find((call) => call.id.startsWith("exposure:request"))!
        .unblocks.includes("Draft the Q3 headcount case"),
);
check(
    "a request with plenty of time left is not an exposure yet",
    callKinds(
        board({
            agents: [agent({ status: "needs-input" })],
            requests: [request({ createdAt: NOW - MINUTE })],
            requestTimeoutMinutes: 120,
        }),
    ).filter((kind) => kind === "exposure").length,
    0,
);
check(
    "with the timeout switched off nothing denies itself",
    callKinds(
        board({
            agents: [agent({ status: "needs-input" })],
            requests: [request({ createdAt: NOW - 6 * MINUTE })],
            requestTimeoutMinutes: 0,
        }),
    ).filter((kind) => kind === "exposure").length,
    0,
);

check(
    "the warning window is exactly where DENY_WARN_MS puts it",
    callKinds(
        board({
            agents: [agent({ status: "needs-input" })],
            requests: [request({ createdAt: NOW - MINUTE })],
            requestTimeoutMinutes: (DENY_WARN_MS + 2 * MINUTE) / MINUTE,
        }),
    ).filter((kind) => kind === "exposure").length,
    0,
);

const capping = board({
    agents: [agent({ startedAt: NOW - 55 * MINUTE })],
    agentTimeoutMinutes: 60,
});
ok("an agent near its cap is raised", headlines(capping).includes("about to be cut off"));

// The invisible failure, and the reason it is exposure rather than decay: he is
// acting on a belief that something is being watched, and it is not.
const blind = board({ schedules: [schedule({ blindRuns: 4, lastRunAt: NOW - HOUR })] });
ok("a blind watcher is raised", headlines(blind).includes("has not been able to look"));
ok(
    "and the copy refuses to let its silence mean anything",
    blind.calls.some((call) => call.because.some((line) => line.includes("means nothing"))),
);

// MARK: - Decay

const oldDecision = board({ openItems: [openItem({ createdAt: NOW - 9 * DAY })] });
ok("a decision left for days is raised", callKinds(oldDecision).includes("decay"));
ok("and the wording offers dropping it, not just doing it", headlines(oldDecision).includes("Settle or drop"));
check(
    "a decision raised this morning is not decaying yet",
    callKinds(board({ openItems: [openItem({ createdAt: NOW - HOUR })] })).filter((k) => k === "decay").length,
    0,
);
check(
    "the threshold is where it says it is",
    callKinds(board({ openItems: [openItem({ createdAt: NOW - DECISION_STALE_MS - MINUTE })] })).filter(
        (k) => k === "decay",
    ).length,
    1,
);

// A finished result describes the world as it was. Saying it may have moved is
// honest; saying what moved would not be, because nothing re-checked anything.
const staleResult = board({
    agents: [agent({ status: "done", endedAt: NOW - RESULT_STALE_MS - HOUR, result: "All green." })],
});
const resultCall = staleResult.calls.find((call) => call.id.startsWith("decay:result"))!;
ok("an untouched result is raised", resultCall !== undefined);
check("but staleness is inferred, so it is only likely", resultCall.confidence, "likely");
ok("and the basis admits nothing was re-checked", resultCall.basis.includes("not checked"));

// MARK: - Leverage

// One request, one agent, and that agent is a watcher's run: two structural
// edges, both of them in the records rather than in anybody's reading of them.
const leverage = board({
    agents: [agent({ id: "agent-1", status: "needs-input", scheduleId: "sch-1" })],
    requests: [request({ agentId: "agent-1", createdAt: NOW - 2 * DAY })],
    schedules: [schedule({ id: "sch-1", activeAgentId: "agent-1" })],
    openItems: [openItem()],
    requestTimeoutMinutes: 0,
});
const leverageCall = leverage.calls.find((call) => call.kind === "leverage");
ok("the one item holding the most is picked out", leverageCall !== undefined);
ok("and the watcher it is holding up is named", leverageCall!.unblocks.includes("Watch the deploy pipeline"));
check("counting real edges is arithmetic, so it is certain", leverageCall!.confidence, "certain");
ok("the basis rules out similarity between descriptions", leverageCall!.basis.includes("never similarity"));
check("it offers one item, never a leaderboard", leverage.calls.filter((c) => c.kind === "leverage").length, 1);

// He asked which one item. With one thing waiting there is no choice to make,
// and a "leverage" call about it would be ceremony.
check(
    "with only one thing on him there is no leverage to talk about",
    board({ openItems: [openItem()] }).calls.filter((c) => c.kind === "leverage").length,
    0,
);
// Two unrelated things waiting: a board that invented a link here would be
// exactly the failure this rule exists to avoid.
check(
    "unrelated things waiting produce no invented link",
    board({
        openItems: [openItem({ id: "o1", text: "One" }), openItem({ id: "o2", text: "Two" })],
    }).calls.filter((c) => c.kind === "leverage").length,
    0,
);

// MARK: - Anticipation

const meetingSoon = board({
    openItems: [openItem({ id: "o1", text: "Approve Priya Raman's transfer" })],
    meetings: [
        {
            id: "m1",
            subject: "1:1 Priya",
            start: NOW + 40 * MINUTE,
            others: ["Priya Raman"],
        },
    ],
});
const meetingCall = meetingSoon.calls.find((call) => call.id.startsWith("anticipation:meeting"))!;
ok("a decision about someone you are about to see is surfaced", meetingCall !== undefined);
// The one place prose matching earns its keep, and it is labelled for it.
check("matching a name in prose is never better than a guess", meetingCall.confidence, "guess");
ok("and the basis says it can be wrong", meetingCall.basis.toLowerCase().includes("wrong"));
check(
    "a meeting with nobody relevant in it says nothing",
    board({
        openItems: [openItem({ id: "o1", text: "Renew the datacentre contract" })],
        meetings: [{ id: "m1", subject: "1:1 Priya", start: NOW + 40 * MINUTE, others: ["Priya Raman"] }],
    }).calls.filter((call) => call.id.startsWith("anticipation:meeting")).length,
    0,
);

const dailySoon = board({
    schedules: [schedule({ cadence: { kind: "daily", time: "16:00" }, nextRunAt: NOW + 2 * HOUR })],
});
ok("a daily watcher about to report is worth a word", headlines(dailySoon).includes("reports in 2 hours"));
// A thirty minute poller firing shortly is not news, it is the weather.
check(
    "an interval watcher firing shortly is not news",
    board({ schedules: [schedule({ nextRunAt: NOW + 5 * MINUTE })] }).calls.filter((call) =>
        call.id.startsWith("anticipation:watcher"),
    ).length,
    0,
);

const beforeLeave = board({
    leave: [{ id: "l1", from: localDayOf(NOW + 2 * DAY), to: localDayOf(NOW + 9 * DAY) }],
    openItems: [openItem()],
    schedules: [schedule({ skipOnLeave: true })],
});
ok("leave coming up is anticipated", headlines(beforeLeave).includes("before leave"));
ok(
    "and it says nothing will chase these while he is away",
    beforeLeave.calls.some((call) => call.because.some((line) => line.includes("go quiet"))),
);
check(
    "leave months away is not today's problem",
    board({ leave: [{ id: "l1", from: localDayOf(NOW + 40 * DAY), to: localDayOf(NOW + 50 * DAY) }] }).calls
        .length,
    0,
);

// MARK: - Capacity

const full = board({
    agents: Array.from({ length: MAX_LIVE_AGENTS }, (_, index) =>
        agent({ id: `a${index}`, title: `Agent ${index}`, startedAt: NOW - (index + 1) * HOUR }),
    ),
    agentTimeoutMinutes: 0,
});
ok("a full slate of agents is called out", callKinds(full).includes("capacity"));
ok("and the oldest is named, because it is the one to cancel", headlines(full).includes("slots are busy"));
check(
    "one slot free is not worth mentioning",
    board({
        agents: Array.from({ length: MAX_LIVE_AGENTS - 1 }, (_, i) => agent({ id: `a${i}` })),
        agentTimeoutMinutes: 0,
    }).calls.filter((call) => call.kind === "capacity").length,
    0,
);

// MARK: - Ordering of the judgement

// Anything on a timer outranks anything merely old: the timer fires whether or
// not he looks, and the old thing will still be there afterwards.
const competing = board({
    agents: [agent({ status: "needs-input" })],
    requests: [request({ createdAt: NOW - 8 * MINUTE })],
    openItems: [openItem({ createdAt: NOW - 30 * DAY })],
    requestTimeoutMinutes: 10,
});
check("what is on a timer is read first", competing.calls[0].kind, "exposure");

// MARK: - Blind spots, which is the honesty

check(
    "an unreadable calendar is said out loud",
    deriveBlindSpots(facts({ calendarProblem: "No account is signed in." }), []).some((spot) =>
        spot.includes("No calendar"),
    ),
    true,
);
// The dangerous ambiguity: an empty lane means both "nothing is wrong" and
// "nothing could be looked at", and only one of those is good news.
ok(
    "an empty others lane is explained rather than left to speak for itself",
    deriveBlindSpots(facts(), []).some((spot) => spot.includes("owing you")),
);
ok(
    "a board that counted leverage admits the graph is partial",
    board({
        openItems: [openItem({ id: "o1", text: "One" }), openItem({ id: "o2", text: "Two" })],
    }).blindSpots.some((spot) => spot.includes("only links Orbit has recorded")),
);
ok(
    "blind watchers are named as a gap as well as a call",
    board({ schedules: [schedule({ blindRuns: 2, lastRunAt: NOW - HOUR })] }).blindSpots.some((spot) =>
        spot.includes("proves nothing"),
    ),
);
ok(
    "once somebody owes him something the others lane stops being explained",
    !board({ activity: [entry({ waitingOn: "Priya" })] }).blindSpots.some((spot) =>
        spot.includes("owing you"),
    ),
);

// MARK: - The invariants

/**
 * Every call any fixture here can produce, gathered in one place.
 *
 * The point of collecting them rather than asserting case by case is that a
 * generator written next month is covered by these two rules the moment it
 * fires once, without anybody remembering to come back and add a check.
 */
const everyCall: ChiefCall[] = [
    denying,
    capping,
    blind,
    oldDecision,
    staleResult,
    leverage,
    meetingSoon,
    dailySoon,
    beforeLeave,
    full,
    competing,
].flatMap((result) => result.calls);

ok("the fixtures actually exercise the generators", everyCall.length >= 10);
check(
    "no call ever ships without a basis",
    everyCall.filter((call) => !call.basis || call.basis.trim().length === 0).length,
    0,
);
check(
    "every call leads with something to do",
    everyCall.filter((call) => call.headline.trim().length === 0).length,
    0,
);
check(
    "no call reasons in prose where a numbered list belongs",
    everyCall.filter((call) => call.because.length === 0).length,
    0,
);
// The rule the whole surface rests on. A guess presented as a fact is the one
// failure that makes everything else here worthless.
check(
    "nothing read out of prose is ever called certain",
    everyCall.filter((call) => call.id.startsWith("anticipation:meeting") && call.confidence === "certain")
        .length,
    0,
);
check(
    "every confidence is one of the three we know how to render",
    everyCall.filter((call) => !["certain", "likely", "guess"].includes(call.confidence)).length,
    0,
);
check(
    "ids are unique within a board, so a row cannot move under the cursor",
    competing.calls.length,
    new Set(competing.calls.map((call) => call.id)).size,
);
check(
    "thread ids are unique too",
    mixed.length,
    new Set(mixed.map((thread) => thread.id)).size,
);
// A judgement about a thread that is not on the board is a dangling pointer,
// and it renders as a row that cannot be clicked.
check(
    "every call that names a thread names one that exists",
    everyCall
        .filter((call) => call.threadId)
        .filter((call) => {
            const source = [denying, capping, blind, oldDecision, staleResult, leverage, meetingSoon, dailySoon, full, competing].find(
                (result) => result.calls.some((candidate) => candidate.id === call.id),
            );
            return !source!.threads.some((thread) => thread.id === call.threadId);
        }).length,
    0,
);

// MARK: - Wording

check("minutes", describeSpan(5 * MINUTE), "5 minutes");
check("a single minute is not plural", describeSpan(MINUTE), "1 minute");
check("sub-minute spans still read as a minute", describeSpan(20_000), "1 minute");
check("hours", describeSpan(3 * HOUR), "3 hours");
check("long spans switch to days", describeSpan(4 * DAY), "4 days");
check("a moment already past is now", describeWhen(NOW - HOUR, NOW), "now");
check("and one ahead is relative", describeWhen(NOW + 2 * HOUR, NOW), "in 2 hours");

check("short text is left alone", clip("Fine as it is", 40), "Fine as it is");
check("long text is cut", clip("x".repeat(50), 10).length, 10);
check("whitespace is flattened, because a row is one line", clip("two\n  lines", 40), "two lines");

ok("a full name matches a first name", mentionsAnyName("Approve Priya's transfer", ["Priya Raman"]));
ok("and the other way round", mentionsAnyName("Chase Raman about the review", ["Priya Raman"]));
// Two-letter fragments would match half the alphabet, which is how a "guess"
// becomes noise rather than a hint.
ok("short fragments do not match everything", !mentionsAnyName("the budget is approved", ["Al Wu"]));
ok("an empty attendee list matches nothing", !mentionsAnyName("anything at all", []));

// MARK: - Helpers

/** Local `YYYY-MM-DD`, matching how leave periods are written down. */
function localDayOf(at: number): string {
    const date = new Date(at);
    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0"),
    ].join("-");
}

// MARK: - Report

const shape = board({
    agents: [agent({ status: "needs-input" })],
    requests: [request({ createdAt: NOW - 7 * MINUTE })],
    schedules: [schedule(), schedule({ id: "sch-2", title: "Inbox triage", blindRuns: 2, lastRunAt: NOW - HOUR })],
    openItems: [openItem({ createdAt: NOW - 9 * DAY })],
    activity: [entry(), entry({ id: "act-2", waitingOn: "the data platform team" })],
});
console.log("");
console.log("A board with something in every lane:");
for (const lane of ["you", "stuck", "others", "running", "landed"] as const) {
    const rows = threadsInLane(shape.threads, lane);
    console.log(`  ${lane.padEnd(8)} ${rows.length}  ${rows.map((row) => clip(row.title, 30)).join(" · ")}`);
}
console.log("");
for (const call of shape.calls.slice(0, 3)) {
    console.log(`  [${call.confidence}] ${call.headline}`);
}
console.log("");
for (const spot of shape.blindSpots) console.log(`  not seen: ${spot}`);
console.log("");

if (failures.length > 0) {
    console.error(`${failures.length} check(s) failed:\n`);
    for (const failure of failures) console.error(`  ${failure}\n`);
    process.exit(1);
}
console.log(`${passed} checks passed.`);
console.log("Board and chief-of-staff rules verified.");
