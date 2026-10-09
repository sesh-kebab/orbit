import type { AgentView, Board, OrbitState, ThreadLane } from "../shared/types.js";

/**
 * The roster: who is on the rail, in what order, and which of them the rail has
 * room to draw.
 *
 * Kept as a pure module with no React in it because the two rules that matter
 * here are safety rules, not drawing rules. "Nothing urgent is ever folded
 * away" and "the overflow puck admits what it is hiding" are claims the rail
 * makes to someone who is deciding whether they can look away, and a claim like
 * that should be testable without a renderer.
 */

/**
 * The six faces a thread can wear.
 *
 * Six drawn states cover eight real ones, and the two collapses are deliberate:
 *
 * `working` eats `queued` because Orbit refuses the ninth agent rather than
 * queueing it, so a queued agent is a thing the user will almost never see and
 * is indistinguishable from a running one in every way they would act on.
 *
 * `severed` does not collapse into `stopped`, which is the collapse that looks
 * most tempting and is the one that would lie. A stopped agent failed. A
 * severed agent was killed by Orbit restarting itself, and drawing Orbit's
 * housekeeping as the agent's failure would send the user looking for a bug in
 * their own task. The recovery differs too: one wants reading, the other wants
 * running again.
 *
 * Only `working`, `needs-you` and `new` carry colour. The rest are desaturated,
 * so a rail at rest is grey and a glance at colour is a glance at everything
 * that is actually moving.
 */
export type PuckState = "working" | "needs-you" | "new" | "resting" | "stopped" | "severed";

/** One face on the rail. */
export interface RosterThread {
    /** The agent id. Threads are agents today; this is the seam if that changes. */
    id: string;
    title: string;
    /** Two letters, drawn inside the puck. The portable identity. */
    monogram: string;
    hue: number;
    lane: ThreadLane;
    state: PuckState;
    /** Ties inside a lane break on this. */
    at: number;
    agent: AgentView;
}

/** What the rail will draw, after the roster has been fitted to the space. */
export interface RosterLayout {
    shown: RosterThread[];
    hidden: RosterThread[];
    /**
     * Present only when something is folded. `state` is the worst state among
     * the hidden, so the puck can wear it: a rail that hides a failure while
     * looking calm is worse than no rail.
     */
    overflow?: { count: number; state: PuckState; hidden: RosterThread[] };
}

/**
 * Display order. Not recency.
 *
 * Recency answers "what happened last", and the rail is asked "what should I
 * look at". Those are the same question only by accident. This is the board's
 * own lane judgement, which is already the thing that decides what is on the
 * user, reused rather than re-derived so the rail and the board can never
 * disagree about what is urgent.
 */
const LANE_ORDER: ThreadLane[] = ["you", "stuck", "others", "running", "landed"];

/**
 * Lanes whose threads can never be folded into the overflow puck, however many
 * agents are running. Both mean a human is the blocker.
 */
const PINNED_LANES: ThreadLane[] = ["you", "stuck"];

/**
 * Which state wins when the overflow puck has to pick one to wear. Worst first.
 * `severed` ranks below `new` because it is Orbit's own doing and never a
 * surprise: it only ever appears immediately after a restart the user asked for.
 */
const STATE_SEVERITY: PuckState[] = ["needs-you", "stopped", "new", "severed", "working", "resting"];

/** First two letters, upper case. Falls back to a dash so a puck is never blank. */
export function monogram(title: string): string {
    const letters = title.replace(/[^\p{L}\p{N}]/gu, "");
    if (letters.length === 0) return "--";
    return letters.slice(0, 2).toUpperCase();
}

/**
 * The face an agent wears, from its record and whether its output has been
 * looked at.
 */
export function puckState(agent: AgentView, hasUnopenedOutput: boolean): PuckState {
    if (agent.severed) return "severed";
    switch (agent.status) {
        case "needs-input":
            return "needs-you";
        case "queued":
        case "running":
            return "working";
        case "failed":
        case "cancelled":
            return "stopped";
        case "done":
            return hasUnopenedOutput ? "new" : "resting";
    }
}

/**
 * Where a thread sits when the board has no opinion about it.
 *
 * The board is the authority and usually has one. This covers the gap between
 * an agent being spawned and the next board refresh, and the restart case,
 * where severed agents exist before the board has seen them.
 */
function fallbackLane(agent: AgentView): ThreadLane {
    if (agent.severed) return "stuck";
    switch (agent.status) {
        case "needs-input":
            return "you";
        case "failed":
            return "stuck";
        case "queued":
        case "running":
            return "running";
        case "cancelled":
        case "done":
            return "landed";
    }
}

/**
 * Build the roster from live state.
 *
 * Joins the agent records, which carry identity and status, to the board, which
 * carries the judgement. Neither alone is enough: the board knows a thread is on
 * you but not what colour it is, and the agent knows its hue but not whether
 * anybody is blocked on it.
 */
export function buildRoster(state: Pick<OrbitState, "agents" | "board">): RosterThread[] {
    const board: Board | undefined = state.board;
    const laneByAgent = new Map<string, ThreadLane>();
    for (const thread of board?.threads ?? []) {
        if (thread.agentId) laneByAgent.set(thread.agentId, thread.lane);
    }

    // An artifact nobody has opened is the difference between "done" and "done,
    // and there is something here for you". It is the only honest signal Orbit
    // has: it cannot know he read the result in the transcript, but it does know
    // whether he ever opened the file.
    const unopened = new Set<string>();
    for (const artifact of board?.artifacts ?? []) {
        if (!artifact.opened) unopened.add(artifact.id);
    }
    const producedUnopened = new Set<string>();
    for (const thread of board?.threads ?? []) {
        if (!thread.agentId) continue;
        if ((thread.artifacts ?? []).some((artifact) => unopened.has(artifact.id))) {
            producedUnopened.add(thread.agentId);
        }
    }

    return state.agents.map((agent) => ({
        id: agent.id,
        title: agent.title,
        monogram: monogram(agent.title),
        hue: agent.hue,
        lane: laneByAgent.get(agent.id) ?? fallbackLane(agent),
        state: puckState(agent, producedUnopened.has(agent.id)),
        at: agent.lastActivityAt,
        agent,
    }));
}

/** Lane first, most recent first inside a lane. */
export function sortRoster(threads: RosterThread[]): RosterThread[] {
    return [...threads].sort((a, b) => {
        const lane = LANE_ORDER.indexOf(a.lane) - LANE_ORDER.indexOf(b.lane);
        if (lane !== 0) return lane;
        return b.at - a.at;
    });
}

/** The worst state in a set, by the severity order above. */
export function worstState(threads: RosterThread[]): PuckState {
    let worst: PuckState = "resting";
    for (const thread of threads) {
        if (STATE_SEVERITY.indexOf(thread.state) < STATE_SEVERITY.indexOf(worst)) {
            worst = thread.state;
        }
    }
    return worst;
}

/**
 * Fit the roster to the faces the rail has room for.
 *
 * Three things are guaranteed visible, in this order of stubbornness:
 *
 *   1. Anything in `on you` or `stuck`. These mean a person is the blocker, and
 *      a rail that folds the one thing waiting on you has failed at its only
 *      job. If there are more of those than there is room for, they are all
 *      drawn anyway and the rail gets taller: overflowing the panel is a far
 *      smaller harm than hiding a block.
 *   2. The thread currently open, whatever its lane and however old. Folding
 *      away the thing being read would be absurd.
 *   3. Everything else, in display order, until the space runs out.
 *
 * When anything is folded, one face is spent on the overflow puck, which wears
 * the worst state it hides. That is what lets the rail be glanced at: grey means
 * grey all the way down, including the part you cannot see.
 */
export function layoutRoster(
    threads: RosterThread[],
    capacity: number,
    activeId?: string,
): RosterLayout {
    const sorted = sortRoster(threads);
    if (capacity <= 0) {
        return sorted.length === 0
            ? { shown: [], hidden: [] }
            : { shown: [], hidden: sorted, overflow: { count: sorted.length, state: worstState(sorted), hidden: sorted } };
    }
    if (sorted.length <= capacity) return { shown: sorted, hidden: [] };

    const mustShow = new Set<string>();
    for (const thread of sorted) {
        if (PINNED_LANES.includes(thread.lane)) mustShow.add(thread.id);
    }
    if (activeId && sorted.some((thread) => thread.id === activeId)) mustShow.add(activeId);

    // One slot goes to the overflow puck itself, since we already know something
    // is being folded.
    const faces = capacity - 1;
    const shown: RosterThread[] = sorted.filter((thread) => mustShow.has(thread.id));
    for (const thread of sorted) {
        if (shown.length >= faces) break;
        if (!mustShow.has(thread.id)) shown.push(thread);
    }

    const shownIds = new Set(shown.map((thread) => thread.id));
    const hidden = sorted.filter((thread) => !shownIds.has(thread.id));
    if (hidden.length === 0) return { shown: sortRoster(shown), hidden: [] };

    return {
        shown: sortRoster(shown),
        hidden,
        overflow: { count: hidden.length, state: worstState(hidden), hidden },
    };
}
