/**
 * Verification for the roster rail's two promises.
 *
 *   npm run verify:rail
 *
 * The rail makes exactly two claims to someone deciding whether they can look
 * away from it, and both of them are safety claims rather than drawing ones:
 *
 *   1. Nothing waiting on a human is ever folded away. If the rail is full and
 *      one agent is blocked on an approval, the blocked one is drawn and
 *      something quieter is folded instead.
 *   2. The overflow puck wears the worst state it hides. A calm "+3" sitting on
 *      top of a failure is how a glance at a grey rail becomes a wrong answer.
 *
 * A rail that breaks either of those is worse than no rail, because it has
 * taught the user that grey means nothing needs them. So both are tested here,
 * against the pure module, with no renderer involved.
 */
import {
    buildRoster,
    layoutRoster,
    monogram,
    puckState,
    sortRoster,
    worstState,
    type RosterThread,
} from "../src/renderer/roster.js";
import type { AgentView, Board, OrbitState, ThreadLane } from "../src/shared/types.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: unknown): void {
    if (condition) {
        passed += 1;
        return;
    }
    failures.push(`${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const EPOCH = 1_760_000_000_000;

function agent(id: string, patch: Partial<AgentView> = {}): AgentView {
    return {
        id,
        title: `Agent ${id}`,
        task: "do a thing",
        status: "running",
        cwd: "/tmp",
        hue: 0.5,
        createdAt: EPOCH,
        lastActivityAt: EPOCH,
        toolCalls: 0,
        steps: [],
        inputTokens: 0,
        outputTokens: 0,
        ...patch,
    };
}

function board(
    lanes: Record<string, ThreadLane>,
    artifacts: Array<{ id: string; agentId: string; opened: boolean }> = [],
): Board {
    return {
        at: EPOCH,
        threads: Object.entries(lanes).map(([agentId, lane]) => ({
            id: `t-${agentId}`,
            kind: "agent",
            lane,
            title: `Agent ${agentId}`,
            detail: "",
            since: EPOCH,
            agentId,
            artifacts: artifacts
                .filter((artifact) => artifact.agentId === agentId)
                .map((artifact) => ({
                    id: artifact.id,
                    title: "output",
                    location: "/tmp/out.md",
                    shortLocation: "out.md",
                    external: false,
                    at: EPOCH,
                    kind: "artifact_written",
                    opened: artifact.opened,
                })),
        })),
        artifacts: artifacts.map((artifact) => ({
            id: artifact.id,
            title: "output",
            location: "/tmp/out.md",
            shortLocation: "out.md",
            external: false,
            at: EPOCH,
            kind: "artifact_written",
            opened: artifact.opened,
        })),
    } as unknown as Board;
}

function state(agents: AgentView[], b: Board): Pick<OrbitState, "agents" | "board"> {
    return { agents, board: b };
}

function thread(id: string, lane: ThreadLane, at: number, patch: Partial<RosterThread> = {}): RosterThread {
    return {
        id,
        title: id,
        monogram: monogram(id),
        hue: 0.5,
        lane,
        state: "working",
        at,
        agent: agent(id),
        ...patch,
    };
}

// ── Monograms ────────────────────────────────────────────────────────────────

check("a monogram is two capitals", monogram("checkout migration") === "CH", monogram("checkout migration"));
check("punctuation is skipped", monogram("· ·payments") === "PA", monogram("· ·payments"));
check("a blank title still draws something", monogram("···") === "--", monogram("···"));

// ── Puck states ──────────────────────────────────────────────────────────────

check("a blocked agent needs you", puckState(agent("a", { status: "needs-input" }), false) === "needs-you");
check("a queued agent is drawn as working", puckState(agent("a", { status: "queued" }), false) === "working");
check("a failure is stopped", puckState(agent("a", { status: "failed" }), false) === "stopped");
check(
    "a finished agent with unopened output is new",
    puckState(agent("a", { status: "done" }), true) === "new",
);
check(
    "a finished agent whose output was opened is resting",
    puckState(agent("a", { status: "done" }), false) === "resting",
);
check(
    "severed beats the status it was left with",
    puckState(agent("a", { status: "cancelled", severed: true }), false) === "severed",
    puckState(agent("a", { status: "cancelled", severed: true }), false),
);
check(
    "a severed agent is not drawn as a failure",
    puckState(agent("a", { status: "cancelled", severed: true }), false) !== "stopped",
);

// ── Building from live state ─────────────────────────────────────────────────

const built = buildRoster(
    state(
        [agent("a", { status: "done" }), agent("b", { status: "running" })],
        board({ a: "landed", b: "running" }, [{ id: "art-1", agentId: "a", opened: false }]),
    ),
);
check("the board's lane wins over the fallback", built.find((t) => t.id === "a")?.lane === "landed");
check(
    "an unopened artifact makes a finished thread new",
    built.find((t) => t.id === "a")?.state === "new",
    built.find((t) => t.id === "a")?.state,
);

const noBoard = buildRoster(state([agent("z", { status: "needs-input" })], board({})));
check(
    "an agent the board has not seen yet still gets a lane",
    noBoard[0]?.lane === "you",
    noBoard[0]?.lane,
);

// ── Lane sort, not recency ───────────────────────────────────────────────────

const mixed = [
    thread("newest-but-finished", "landed", EPOCH + 9000),
    thread("blocked", "you", EPOCH),
    thread("running", "running", EPOCH + 5000),
    thread("failed", "stuck", EPOCH + 1000),
];
const sorted = sortRoster(mixed);
check(
    "the thread waiting on you sorts first even though it is the oldest",
    sorted[0]?.id === "blocked",
    sorted.map((t) => t.id),
);
check("stuck comes second", sorted[1]?.id === "failed", sorted.map((t) => t.id));
check(
    "the most recent thing is last when its lane is last",
    sorted.at(-1)?.id === "newest-but-finished",
    sorted.map((t) => t.id),
);

const sameLane = sortRoster([
    thread("older", "running", EPOCH),
    thread("newer", "running", EPOCH + 1000),
]);
check("recency breaks ties inside a lane", sameLane[0]?.id === "newer", sameLane.map((t) => t.id));

// ── Overflow: what is folded ─────────────────────────────────────────────────

const crowded = [
    thread("blocked", "you", EPOCH, { state: "needs-you" }),
    thread("r1", "running", EPOCH + 1),
    thread("r2", "running", EPOCH + 2),
    thread("r3", "running", EPOCH + 3),
    thread("r4", "running", EPOCH + 4),
];
const tight = layoutRoster(crowded, 3);
check("the overflow puck appears when there is not room", tight.overflow !== undefined);
check(
    "the thread waiting on you is never folded away",
    tight.shown.some((t) => t.id === "blocked"),
    tight.shown.map((t) => t.id),
);
check(
    "one slot is spent on the overflow puck itself",
    tight.shown.length === 2,
    tight.shown.map((t) => t.id),
);
check(
    "everything not shown is counted",
    tight.overflow?.count === crowded.length - tight.shown.length,
    { count: tight.overflow?.count, shown: tight.shown.length },
);
check(
    "nothing is both shown and hidden",
    tight.hidden.every((h) => !tight.shown.some((s) => s.id === h.id)),
);

const manyBlocked = layoutRoster(
    [
        thread("b1", "you", EPOCH + 1, { state: "needs-you" }),
        thread("b2", "you", EPOCH + 2, { state: "needs-you" }),
        thread("b3", "stuck", EPOCH + 3, { state: "stopped" }),
        thread("q1", "landed", EPOCH + 4, { state: "resting" }),
    ],
    2,
);
check(
    "more blocked threads than slots overflows the rail rather than hiding one",
    ["b1", "b2", "b3"].every((id) => manyBlocked.shown.some((t) => t.id === id)),
    manyBlocked.shown.map((t) => t.id),
);
check(
    "the quiet thread is the one that gets folded",
    manyBlocked.hidden.map((t) => t.id).join() === "q1",
    manyBlocked.hidden.map((t) => t.id),
);

const withActive = layoutRoster(
    [
        thread("b1", "you", EPOCH + 5, { state: "needs-you" }),
        thread("r1", "running", EPOCH + 4),
        thread("r2", "running", EPOCH + 3),
        thread("old", "landed", EPOCH, { state: "resting" }),
    ],
    3,
    "old",
);
check(
    "the thread being read is never folded, however old and quiet",
    withActive.shown.some((t) => t.id === "old"),
    withActive.shown.map((t) => t.id),
);

check("nothing folds when everything fits", layoutRoster(crowded, 8).overflow === undefined);
check("an empty roster draws no overflow puck", layoutRoster([], 5).overflow === undefined);
check(
    "the shown list stays in display order after the pinning pass",
    layoutRoster(crowded, 4).shown[0]?.id === "blocked",
    layoutRoster(crowded, 4).shown.map((t) => t.id),
);

// ── Overflow: what it wears ──────────────────────────────────────────────────

check(
    "the overflow puck wears the worst thing it hides",
    worstState([
        thread("a", "landed", EPOCH, { state: "resting" }),
        thread("b", "stuck", EPOCH, { state: "stopped" }),
        thread("c", "running", EPOCH, { state: "working" }),
    ]) === "stopped",
);
check(
    "needs-you outranks everything",
    worstState([
        thread("a", "stuck", EPOCH, { state: "stopped" }),
        thread("b", "you", EPOCH, { state: "needs-you" }),
    ]) === "needs-you",
);
check(
    "a failure outranks unread output",
    worstState([
        thread("a", "landed", EPOCH, { state: "new" }),
        thread("b", "stuck", EPOCH, { state: "stopped" }),
    ]) === "stopped",
);
check(
    "severed is quieter than a failure, because Orbit caused it",
    worstState([
        thread("a", "stuck", EPOCH, { state: "severed" }),
        thread("b", "stuck", EPOCH, { state: "stopped" }),
    ]) === "stopped",
);
check("all-quiet folds as resting", worstState([thread("a", "landed", EPOCH, { state: "resting" })]) === "resting");

const hidingTrouble = layoutRoster(
    [
        thread("r1", "running", EPOCH + 9),
        thread("r2", "running", EPOCH + 8),
        thread("r3", "running", EPOCH + 7),
        thread("broke", "landed", EPOCH, { state: "stopped" }),
    ],
    3,
);
check(
    "a rail hiding a failure does not look calm",
    hidingTrouble.overflow?.state === "stopped",
    hidingTrouble.overflow?.state,
);
check(
    "the overflow puck can name what it is hiding",
    (hidingTrouble.overflow?.hidden.length ?? 0) === hidingTrouble.overflow?.count,
);

// ── Degenerate capacities ────────────────────────────────────────────────────

const noRoom = layoutRoster(crowded, 0);
check("zero capacity still admits what exists", noRoom.overflow?.count === crowded.length);
check("zero capacity draws no faces", noRoom.shown.length === 0);

// ── Report ───────────────────────────────────────────────────────────────────

if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed:`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exit(1);
}
console.log(`rail: ${passed} checks passed.`);
