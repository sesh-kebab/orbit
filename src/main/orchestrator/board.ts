/**
 * The board, and the judgement laid over it.
 *
 * Two halves of one complaint: "it is difficult to see multiple threads I'm
 * tracking with you... I wonder if there's a better way to at a glance see all
 * parallel threads and then separately, what you're tracking from my point of
 * view... But not just a todo list, how are you thinking as a chief of staff and
 * anticipating what I need."
 *
 * The first half is flattening. Agents, watchers, open decisions and the
 * activity ledger are four separate stores, each reachable one tool call at a
 * time, and all of it scrolls away. `deriveThreads` puts them in one shape and
 * sorts them into five lanes.
 *
 * The second half is the harder one, and it is a different job. A list of
 * threads is inventory. What he asked for is judgement: what decays, what one
 * thing frees the most, what is coming that nobody has mentioned. `deriveCalls`
 * is a handful of small generators, each of which looks for one shape of
 * trouble, says what it found and says how sure it is. They are small and
 * separate on purpose: a generator that fires wrongly can be found, understood
 * and deleted without disturbing the others.
 *
 * Two rules hold the whole thing up, and both are checked in verify-board.ts:
 *
 * 1. *Nothing inferred from prose is ever `certain`.* Timestamp arithmetic and
 *    links the data model actually carries earn `certain`. Matching a person's
 *    name against the text of a decision does not, however obviously right it
 *    looks in the one case you tested it on.
 * 2. *An unreadable source is named, never omitted.* An empty lane must not be
 *    able to mean "nothing is wrong" and "nothing could be seen" at the same
 *    time. That is what `blindSpots` is for.
 *
 * Everything here is pure and takes `now`. No clock, no disk, no Electron.
 */
import type {
    ActivityEntry,
    AgentView,
    Board,
    BoardArtifact,
    BoardThread,
    CallKind,
    ChiefCall,
    Confidence,
    LeavePeriod,
    OpenItem,
    PendingRequest,
    Schedule,
    ThreadLane,
} from "../../shared/types.js";
import { isLive } from "../../shared/types.js";
import type { Meeting } from "./meetings.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long a finished thread stays on the board before the log owns it. */
export const LANDED_WINDOW_MS = 12 * HOUR;

/** A request closer to its auto-deny than this is an exposure worth raising. */
export const DENY_WARN_MS = 30 * MINUTE;

/** An agent closer to its hard cap than this will be killed mid-thought. */
export const TIMEOUT_WARN_MS = 10 * MINUTE;

/** A decision older than this has stopped being deferred and started rotting. */
export const DECISION_STALE_MS = 3 * DAY;

/** A finished result nobody has touched by now is describing a world that moved. */
export const RESULT_STALE_MS = 8 * HOUR;

/** How far ahead anticipation looks. Past this it is trivia, not a heads-up. */
export const LOOKAHEAD_MS = 4 * HOUR;

/** Leave inside this window is close enough to plan around. */
export const LEAVE_LOOKAHEAD_MS = 3 * DAY;

/** Orbit's own ceiling on concurrent agents, mirrored so capacity can be judged. */
export const MAX_LIVE_AGENTS = 8;

/**
 * How many artifacts cross the wire.
 *
 * A cap rather than everything, because the point of the list is finding the
 * thing he half remembers from last week, and nothing about scrolling to page
 * four serves that. The ledger keeps the rest, and it is searchable by tool.
 */
export const ARTIFACT_LIMIT = 40;

/** Files shown on a single thread row. Beyond this it is a directory listing. */
export const ARTIFACTS_PER_THREAD = 3;

/**
 * How long something can sit unopened before it is worth a word.
 *
 * A full day, so it never fires on something delivered this morning that he is
 * simply going to read after standup.
 */
export const UNOPENED_STALE_MS = 24 * HOUR;

/** Everything the board is derived from, with no opinion about where it came from. */
export interface BoardFacts {
    agents: AgentView[];
    requests: PendingRequest[];
    schedules: Schedule[];
    openItems: OpenItem[];
    activity: ActivityEntry[];
    /** Today's meetings, when the calendar could be read. */
    meetings: Meeting[];
    /**
     * Why the calendar could not be read, if it could not. A present string is
     * the difference between "no meetings today" and "no idea about today", and
     * those must never render the same.
     */
    calendarProblem?: string;
    leave: LeavePeriod[];
    /** Minutes before an unanswered request is auto-denied. 0 disables. */
    requestTimeoutMinutes: number;
    /** Minutes before a running agent is killed. 0 disables. */
    agentTimeoutMinutes: number;
}

// MARK: - The board

export function deriveBoard(facts: BoardFacts, now: number): Board {
    const threads = deriveThreads(facts, now);
    const artifacts = deriveArtifacts(facts, threads);
    attachArtifacts(threads, artifacts);
    return {
        at: now,
        threads,
        artifacts,
        calls: deriveCalls(facts, threads, artifacts, now),
        blindSpots: deriveBlindSpots(facts, threads, artifacts),
    };
}

// MARK: - Half one, the threads

/**
 * Every parallel thread, flattened and laned.
 *
 * The one subtlety is double counting. A watcher that is mid-run is already on
 * the board as the agent running it, and showing both made two rows out of one
 * thing and put the same work in two lanes. The agent wins, because it is the
 * one carrying the live detail, and the row keeps the watcher's id so the link
 * is not lost.
 */
export function deriveThreads(facts: BoardFacts, now: number): BoardThread[] {
    const threads: BoardThread[] = [
        ...agentThreads(facts, now),
        ...watcherThreads(facts, now),
        ...decisionThreads(facts),
        ...deliveryThreads(facts, now),
    ];
    return threads.sort(byLaneThenUrgency);
}

function agentThreads(facts: BoardFacts, now: number): BoardThread[] {
    const threads: BoardThread[] = [];
    for (const agent of facts.agents) {
        // A cancelled agent is a thread somebody deliberately ended. It is in
        // the log, and putting it on the board makes deliberate choices look
        // like unfinished business.
        if (agent.status === "cancelled") continue;
        if (agent.status === "done" && (agent.endedAt ?? agent.lastActivityAt) < now - LANDED_WINDOW_MS) {
            continue;
        }

        const request = facts.requests.find((candidate) => candidate.agentId === agent.id);
        const base = {
            id: `agent:${agent.id}`,
            kind: "agent" as const,
            title: agent.title,
            hue: agent.hue,
            agentId: agent.id,
            scheduleId: agent.scheduleId,
        };

        if (request) {
            threads.push({
                ...base,
                lane: "you",
                requestId: request.id,
                detail: request.title,
                since: request.createdAt,
            });
            continue;
        }
        if (agent.status === "failed") {
            threads.push({
                ...base,
                lane: "stuck",
                detail: firstLine(agent.error) ?? "Failed without saying why.",
                since: agent.endedAt ?? agent.lastActivityAt,
            });
            continue;
        }
        if (agent.status === "done") {
            threads.push({
                ...base,
                lane: "landed",
                detail: firstLine(agent.result) ?? "Finished.",
                since: agent.endedAt ?? agent.lastActivityAt,
            });
            continue;
        }
        threads.push({
            ...base,
            lane: "running",
            detail: agent.currentStep ?? `${agent.toolCalls} step${agent.toolCalls === 1 ? "" : "s"} so far`,
            since: agent.startedAt ?? agent.createdAt,
        });
    }
    return threads;
}

function watcherThreads(facts: BoardFacts, now: number): BoardThread[] {
    const threads: BoardThread[] = [];
    for (const schedule of facts.schedules) {
        if (schedule.archived) continue;
        // Mid-run: the agent row is this thread, with better detail on it.
        if (schedule.activeAgentId && facts.agents.some((a) => a.id === schedule.activeAgentId && isLive(a))) {
            continue;
        }
        // Paused is a choice the user made and can see in the watchers tab.
        if (!schedule.enabled) continue;

        const base = {
            id: `watcher:${schedule.id}`,
            kind: "watcher" as const,
            title: schedule.title,
            scheduleId: schedule.id,
        };

        // A watcher reporting blind is the worst thing on this board, because
        // it is the only failure that looks exactly like success from outside:
        // it runs, it reports, and it has not been able to see for a week.
        const blind = schedule.blindRuns ?? 0;
        if (blind > 0) {
            threads.push({
                ...base,
                lane: "stuck",
                detail: `Could not see on the last ${blind} run${blind === 1 ? "" : "s"}.`,
                since: schedule.lastRunAt ?? schedule.createdAt,
            });
            continue;
        }
        if (schedule.lastStatus === "failed") {
            threads.push({
                ...base,
                lane: "stuck",
                detail: "Last run failed.",
                since: schedule.lastRunAt ?? schedule.createdAt,
            });
            continue;
        }
        threads.push({
            ...base,
            lane: "running",
            detail: `Next ${describeWhen(schedule.nextRunAt, now)}.`,
            since: schedule.nextRunAt,
        });
    }
    return threads;
}

function decisionThreads(facts: BoardFacts): BoardThread[] {
    return facts.openItems
        .filter((item) => !item.resolved)
        .map((item) => ({
            id: `decision:${item.id}`,
            kind: "decision" as const,
            lane: "you" as const,
            title: item.text,
            detail: item.source ? `From ${item.source}.` : "Waiting on your answer.",
            since: item.createdAt,
            openItemId: item.id,
        }));
}

function deliveryThreads(facts: BoardFacts, now: number): BoardThread[] {
    const threads: BoardThread[] = [];
    for (const entry of facts.activity) {
        const lane = deliveryLane(entry, now);
        if (!lane) continue;
        threads.push({
            id: `delivery:${entry.id}`,
            kind: "delivery",
            lane,
            title: entry.description,
            detail: deliveryDetail(entry, lane),
            since: entry.statusChangedAt ?? entry.at,
            activityId: entry.id,
            agentId: entry.agentId,
        });
    }
    return threads;
}

/**
 * `waitingOn` is checked before the status, and only on unfinished work.
 *
 * Something recorded as owed by another person is in `others` whether Orbit
 * filed it as awaiting him or as stalled: who it is waiting on is the more
 * specific fact, and it is the distinction the lane exists to make.
 */
function deliveryLane(entry: ActivityEntry, now: number): ThreadLane | undefined {
    const unfinished = entry.status === "awaiting_seshi" || entry.status === "stalled";
    if (unfinished && entry.waitingOn) return "others";
    if (entry.status === "awaiting_seshi") return "you";
    if (entry.status === "stalled") return "stuck";
    if (entry.status === "delivered" && entry.at >= now - LANDED_WINDOW_MS) return "landed";
    return undefined;
}

function deliveryDetail(entry: ActivityEntry, lane: ThreadLane): string {
    if (lane === "others") return `Waiting on ${entry.waitingOn}.`;
    if (entry.note) return entry.note;
    if (lane === "you") return "Sitting with you.";
    if (lane === "stuck") return "Stopped, and nobody chose to stop it.";
    // Not the path, even though there usually is one. The artifact hangs off
    // this row already and carries the path as its own clickable line, so
    // repeating it here printed the same string twice under one title.
    return "Delivered.";
}

/**
 * Lanes in reading order, then most urgent first inside each.
 *
 * "Urgent" is not one thing across lanes, which is why it is decided per lane
 * rather than by one timestamp comparison. In `you` and `stuck` the oldest
 * matters most, because age is the damage. In `running` the soonest matters
 * most, because that is what is about to happen. In `landed` the newest, because
 * old news is not news.
 */
const LANE_ORDER: ThreadLane[] = ["you", "stuck", "others", "running", "landed"];

function byLaneThenUrgency(a: BoardThread, b: BoardThread): number {
    const lanes = LANE_ORDER.indexOf(a.lane) - LANE_ORDER.indexOf(b.lane);
    if (lanes !== 0) return lanes;
    if (a.lane === "landed") return b.since - a.since;
    return a.since - b.since;
}

export function threadsInLane(threads: BoardThread[], lane: ThreadLane): BoardThread[] {
    return threads.filter((thread) => thread.lane === lane);
}

// MARK: - Half one and a half, the things it made

/**
 * Every file Orbit produced, newest first.
 *
 * The complaint this answers is not that artifacts go unrecorded. The ledger has
 * been recording each one with an absolute path, the request behind it, a day
 * and a status all along. The failure was that the only pointer a human ever saw
 * was a path inside a chat message, which stops existing the moment the
 * conversation scrolls. So nothing new is stored here and nothing is inferred:
 * this is the ledger, read in the one order that helps when he cannot remember
 * which piece of work produced the thing he is looking for.
 *
 * Abandoned work is excluded. Its file may well still be on disk, but offering
 * it next to live output invites him to act on something already dropped.
 */
export function deriveArtifacts(facts: BoardFacts, threads: BoardThread[]): BoardArtifact[] {
    const artifacts: BoardArtifact[] = [];
    for (const entry of facts.activity) {
        if (!entry.location) continue;
        if (entry.status === "abandoned") continue;

        const external = /^https?:\/\//i.test(entry.location);
        artifacts.push({
            id: entry.id,
            title: entry.description,
            location: entry.location,
            shortLocation: external ? entry.location : shortLocation(entry.location),
            external,
            at: entry.at,
            kind: entry.kind,
            request: entry.request,
            opened: entry.openedAt !== undefined,
            threadId: threadFor(entry, threads),
        });
    }
    return artifacts.sort((a, b) => b.at - a.at).slice(0, ARTIFACT_LIMIT);
}

/**
 * Which thread produced an artifact, when one is still on the board.
 *
 * The entry's own delivery row is the better answer where it exists, because it
 * is the row describing this exact piece of work. Falling back to the agent is
 * what links a report to the code review that wrote it once the delivery row has
 * aged out of the lanes.
 */
function threadFor(entry: ActivityEntry, threads: BoardThread[]): string | undefined {
    const own = threads.find((thread) => thread.activityId === entry.id);
    if (own) return own.id;
    if (!entry.agentId) return undefined;
    return threads.find((thread) => thread.kind === "agent" && thread.agentId === entry.agentId)?.id;
}

/**
 * Hang each artifact off the thread that made it.
 *
 * A thread has two halves and he needs both from one row: where it got to, and
 * what came out of it. Capped per thread because a row that unfolds into twenty
 * files is a directory listing, and he has one of those already.
 */
function attachArtifacts(threads: BoardThread[], artifacts: BoardArtifact[]): void {
    for (const artifact of artifacts) {
        if (!artifact.threadId) continue;
        const thread = threads.find((candidate) => candidate.id === artifact.threadId);
        if (!thread) continue;
        thread.artifacts ??= [];
        if (thread.artifacts.length < ARTIFACTS_PER_THREAD) thread.artifacts.push(artifact);
    }
}

// MARK: - Half two, the judgement

/**
 * Run every generator, then order by weight.
 *
 * Weight is not a score of importance so much as a running order: what would be
 * unforgivable to have buried. Anything on a timer outranks anything merely
 * old, because the timer will fire whether or not he looks.
 */
export function deriveCalls(
    facts: BoardFacts,
    threads: BoardThread[],
    artifacts: BoardArtifact[],
    now: number,
): ChiefCall[] {
    return [
        ...exposureCalls(facts, threads, now),
        ...decayCalls(threads, now),
        ...unopenedCalls(artifacts, now),
        ...leverageCalls(facts, threads, now),
        ...anticipationCalls(facts, threads, now),
        ...capacityCalls(facts, now),
    ].sort((a, b) => b.weight - a.weight || a.headline.localeCompare(b.headline));
}

function call(input: {
    id: string;
    kind: CallKind;
    headline: string;
    because: string[];
    confidence: Confidence;
    basis: string;
    weight: number;
    minutes?: number;
    unblocks?: string[];
    threadId?: string;
}): ChiefCall {
    return { ...input, unblocks: input.unblocks ?? [] };
}

/**
 * Things that will happen on a timer whether or not he acts.
 *
 * This is the one category that is worth interrupting for, and the one Orbit was
 * worst at: a permission request quietly auto-denies after ten minutes and the
 * agent is told it was refused, which is indistinguishable, from the agent's
 * side, from a considered no.
 */
function exposureCalls(facts: BoardFacts, threads: BoardThread[], now: number): ChiefCall[] {
    const calls: ChiefCall[] = [];

    if (facts.requestTimeoutMinutes > 0) {
        for (const request of facts.requests) {
            const deniesAt = request.createdAt + facts.requestTimeoutMinutes * MINUTE;
            const left = deniesAt - now;
            if (left <= 0 || left > DENY_WARN_MS) continue;
            const agent = facts.agents.find((candidate) => candidate.id === request.agentId);
            calls.push(
                call({
                    id: `exposure:request:${request.id}`,
                    kind: "exposure",
                    headline: `Answer "${clip(request.title, 60)}" before it denies itself`,
                    because: [
                        `It auto-denies in ${describeSpan(left)}.`,
                        agent
                            ? `${agent.title} is stopped until then, and will be told you refused.`
                            : "The agent that asked will be told you refused.",
                    ],
                    confidence: "certain",
                    basis: "Counted off the request's own timeout, which the app enforces.",
                    minutes: 1,
                    unblocks: agent ? [agent.title] : [],
                    threadId: `agent:${request.agentId}`,
                    weight: 1000 - left / MINUTE,
                }),
            );
        }
    }

    if (facts.agentTimeoutMinutes > 0) {
        for (const agent of facts.agents) {
            if (!isLive(agent)) continue;
            const startedAt = agent.startedAt ?? agent.createdAt;
            const left = startedAt + facts.agentTimeoutMinutes * MINUTE - now;
            if (left <= 0 || left > TIMEOUT_WARN_MS) continue;
            calls.push(
                call({
                    id: `exposure:timeout:${agent.id}`,
                    kind: "exposure",
                    headline: `${clip(agent.title, 50)} is about to be cut off`,
                    because: [
                        `It hits the ${facts.agentTimeoutMinutes} minute cap in ${describeSpan(left)}.`,
                        "Whatever it has not reported by then is lost.",
                    ],
                    confidence: "certain",
                    basis: "Counted off the agent's start time against the configured cap.",
                    minutes: 2,
                    threadId: `agent:${agent.id}`,
                    weight: 900 - left / MINUTE,
                }),
            );
        }
    }

    // A blind watcher is exposure rather than decay: he is acting on the belief
    // that something is being watched, and it is not. The longer it runs the
    // more confident the wrong belief gets.
    for (const thread of threads) {
        if (thread.kind !== "watcher" || thread.lane !== "stuck") continue;
        const schedule = facts.schedules.find((candidate) => candidate.id === thread.scheduleId);
        const blind = schedule?.blindRuns ?? 0;
        if (blind < 1) continue;
        calls.push(
            call({
                id: `exposure:blind:${thread.scheduleId}`,
                kind: "exposure",
                headline: `${clip(thread.title, 50)} has not been able to look`,
                because: [
                    `The last ${blind} run${blind === 1 ? "" : "s"} ended without seeing anything.`,
                    "Silence from it means nothing right now, in either direction.",
                ],
                confidence: "certain",
                basis: "Counted from the watcher's own record of blind runs.",
                minutes: 5,
                threadId: thread.id,
                weight: 700 + Math.min(blind, 20),
            }),
        );
    }

    return calls;
}

/**
 * Things that cost more the longer they sit.
 *
 * Each shape decays differently, so each gets its own rule rather than one age
 * threshold pretending to fit all of them. What is common is that the copy
 * states the measurement and stops. "This is getting expensive" is an opinion
 * dressed as a fact; "this has sat 6 days" is the fact, and he can price it.
 */
/*
 * Decay reads only the threads. Everything it needs is already flattened onto
 * them, and taking the facts as well would invite a rule that quietly depends on
 * a store the lane sorting has already had its say about.
 */
function decayCalls(threads: BoardThread[], now: number): ChiefCall[] {
    const calls: ChiefCall[] = [];

    for (const thread of threads) {
        if (thread.kind === "decision") {
            const age = now - thread.since;
            if (age < DECISION_STALE_MS) continue;
            calls.push(
                call({
                    id: `decay:decision:${thread.openItemId}`,
                    kind: "decay",
                    headline: `Settle or drop "${clip(thread.title, 55)}"`,
                    because: [
                        `It has waited ${describeSpan(age)} without an answer.`,
                        "Orbit will keep raising it until it is closed either way.",
                    ],
                    confidence: "certain",
                    basis: "Measured from when the decision was raised.",
                    minutes: 5,
                    threadId: thread.id,
                    weight: 400 + Math.min(age / DAY, 30),
                }),
            );
            continue;
        }

        // A finished result is a description of the world at the moment it
        // finished. Saying it "may be stale" is honest; saying what changed
        // would not be, because nothing here re-checked anything.
        if (thread.kind === "agent" && thread.lane === "landed") {
            const age = now - thread.since;
            if (age < RESULT_STALE_MS) continue;
            calls.push(
                call({
                    id: `decay:result:${thread.agentId}`,
                    kind: "decay",
                    headline: `Read or bin ${clip(thread.title, 45)} before it is worthless`,
                    because: [
                        `It finished ${describeSpan(age)} ago and nothing has been done with it.`,
                        "It describes how things were then, and has not been re-checked since.",
                    ],
                    confidence: "likely",
                    basis: "The age is measured; whether the answer has actually moved is not checked.",
                    minutes: 5,
                    threadId: thread.id,
                    weight: 250 + Math.min(age / HOUR, 40),
                }),
            );
            continue;
        }

        if (thread.kind === "delivery" && thread.lane === "stuck") {
            const age = now - thread.since;
            if (age < DECISION_STALE_MS) continue;
            calls.push(
                call({
                    id: `decay:delivery:${thread.activityId}`,
                    kind: "decay",
                    headline: `Restart or abandon "${clip(thread.title, 50)}"`,
                    because: [
                        `It has been stopped for ${describeSpan(age)}.`,
                        "Nobody decided to stop it, so nobody will decide to restart it.",
                    ],
                    confidence: "certain",
                    basis: "Measured from when the entry last changed status.",
                    minutes: 10,
                    threadId: thread.id,
                    weight: 300 + Math.min(age / DAY, 20),
                }),
            );
        }
    }

    return calls;
}

/**
 * Work he asked for, delivered, and apparently never looked at.
 *
 * This is the decay case the artifact list makes visible for the first time.
 * Something he requested was produced and then went unread, which means the time
 * spent making it bought nothing, and the longer it sits the less true it gets.
 *
 * It is `likely` and can never be better, because `openedAt` only records opens
 * that went through Orbit. If he opened the file straight from his editor there
 * is no trace, and the call would be wrong. The copy says so rather than hiding
 * it, and the threshold is a full day so that this never fires on something he
 * simply has not got to yet this morning.
 */
function unopenedCalls(artifacts: BoardArtifact[], now: number): ChiefCall[] {
    const forgotten = artifacts.filter(
        (artifact) => !artifact.opened && now - artifact.at >= UNOPENED_STALE_MS,
    );
    if (forgotten.length === 0) return [];

    const oldest = forgotten.reduce((a, b) => (a.at <= b.at ? a : b));
    const age = now - oldest.at;
    const others = forgotten.length - 1;
    return [
        call({
            id: "decay:unopened",
            kind: "decay",
            headline:
                others > 0
                    ? `Open "${clip(oldest.title, 40)}" and ${others} other unread thing${others === 1 ? "" : "s"}`
                    : `Open "${clip(oldest.title, 50)}", made for you ${describeSpan(age)} ago`,
            because: [
                `You asked for this and it has sat unopened for ${describeSpan(age)}.`,
                "It is in the made-for-you list below, one click from here.",
                "Orbit only sees opens that go through it, so this may already be read.",
            ],
            confidence: "likely",
            basis: "Opens made from Orbit are recorded; opens made in your editor are invisible to it.",
            minutes: 5,
            weight: 260 + Math.min(age / DAY, 20) + Math.min(others * 4, 20),
        }),
    ];
}

/**
 * The ten-minute question: which single item frees the most.
 *
 * Only structural links are counted. A request belongs to an agent, an agent may
 * belong to a watcher, a ledger entry names the agent that produced it: those
 * are edges the data model actually carries, and counting them is arithmetic.
 * Guessing that two things are related because their descriptions share a word
 * is how a chief of staff loses the room, so it is not done. The cost of that
 * discipline is a real one and it is stated in `blindSpots`: work that is
 * genuinely connected but never recorded as connected counts as zero here.
 *
 * One call, not a ranked list. He asked which one item, and a leaderboard of
 * leverage is just the todo list again with extra arithmetic.
 */
function leverageCalls(facts: BoardFacts, threads: BoardThread[], now: number): ChiefCall[] {
    const blocking = threads.filter((thread) => thread.lane === "you");
    if (blocking.length < 2) return [];

    let best: { thread: BoardThread; freed: string[] } | undefined;
    for (const thread of blocking) {
        const freed = downstreamOf(thread, facts, threads);
        if (!best || freed.length > best.freed.length) best = { thread, freed };
    }
    if (!best || best.freed.length === 0) return [];

    const { thread, freed } = best;
    return [
        call({
            id: `leverage:${thread.id}`,
            kind: "leverage",
            headline: `Ten minutes on "${clip(thread.title, 45)}" frees ${freed.length} other thing${
                freed.length === 1 ? "" : "s"
            }`,
            because: [
                `${blocking.length} things are waiting on you; this one is holding the most.`,
                `Freed by it: ${freed.slice(0, 3).join(", ")}${freed.length > 3 ? ", and more" : ""}.`,
            ],
            confidence: "certain",
            basis: "Counted only links the records carry, never similarity between descriptions.",
            minutes: 10,
            unblocks: freed,
            threadId: thread.id,
            weight: 500 + freed.length * 10 + Math.min((now - thread.since) / DAY, 10),
        }),
    ];
}

/** Threads that this one is demonstrably holding up. Titles, deduped. */
function downstreamOf(thread: BoardThread, facts: BoardFacts, threads: BoardThread[]): string[] {
    const freed = new Set<string>();

    // A request stops its agent, and if that agent is a watcher's run, the
    // watcher too. Both edges are in the records.
    if (thread.requestId && thread.agentId) {
        const agent = facts.agents.find((candidate) => candidate.id === thread.agentId);
        if (agent?.scheduleId) {
            const schedule = facts.schedules.find((candidate) => candidate.id === agent.scheduleId);
            if (schedule) freed.add(schedule.title);
        }
        for (const entry of facts.activity) {
            if (entry.agentId === thread.agentId && (entry.status === "awaiting_seshi" || entry.status === "stalled")) {
                freed.add(entry.description);
            }
        }
    }

    // Everything else this agent produced that has not landed.
    if (thread.agentId) {
        for (const other of threads) {
            if (other.id === thread.id) continue;
            if (other.agentId === thread.agentId) freed.add(other.title);
        }
    }

    // A decision raised by a watcher or an agent is holding that source up. The
    // source is a recorded field, not a phrase found in the text.
    if (thread.openItemId) {
        const item = facts.openItems.find((candidate) => candidate.id === thread.openItemId);
        const source = item?.source;
        if (source) {
            for (const schedule of facts.schedules) {
                if (!schedule.archived && schedule.title === source) freed.add(schedule.title);
            }
            for (const agent of facts.agents) {
                if (agent.title === source && isLive(agent)) freed.add(agent.title);
            }
        }
    }

    freed.delete(thread.title);
    return [...freed];
}

/**
 * What is coming that he has not been asked about.
 *
 * The test each of these has to pass is that it is news: something on the
 * calendar or the clock that is going to land, and that nothing has yet put in
 * front of him. A reminder of something he has already been told is noise, and
 * noise here costs more than a miss, because the whole surface gets ignored.
 */
function anticipationCalls(facts: BoardFacts, threads: BoardThread[], now: number): ChiefCall[] {
    const calls: ChiefCall[] = [];
    const waiting = threads.filter((thread) => thread.lane === "you");

    // A decision whose subject is in the room shortly. This is the one place
    // prose matching earns its keep, and it is labelled accordingly: a name from
    // the attendee list found in the text of an open decision. Useful when it
    // hits, harmless when it misses, and never dressed up as certainty.
    for (const meeting of facts.meetings) {
        const until = meeting.start - now;
        if (until <= 0 || until > LOOKAHEAD_MS) continue;
        const related = waiting.filter((thread) => mentionsAnyName(thread.title, meeting.others));
        if (related.length === 0) continue;
        const subject = related[0];
        calls.push(
            call({
                id: `anticipation:meeting:${meeting.id}:${meeting.start}`,
                kind: "anticipation",
                headline: `Decide "${clip(subject.title, 40)}" before ${clip(meeting.subject, 30)}`,
                because: [
                    `That meeting starts in ${describeSpan(until)}.`,
                    `${meeting.others.slice(0, 2).join(" and ")} will be in it, and ${
                        related.length === 1 ? "this is" : `${related.length} open items are`
                    } about them.`,
                ],
                confidence: "guess",
                basis: "Matched attendee names against the wording of open items. It can easily be wrong.",
                minutes: 10,
                threadId: subject.id,
                weight: 600 - until / MINUTE,
            }),
        );
    }

    // A watcher that is about to report. Worth knowing when it is a daily brief
    // landing shortly, and not worth a word when it is a thirty minute poller.
    for (const schedule of facts.schedules) {
        if (schedule.archived || !schedule.enabled) continue;
        if (schedule.cadence.kind === "interval") continue;
        const until = schedule.nextRunAt - now;
        if (until <= 0 || until > LOOKAHEAD_MS) continue;
        calls.push(
            call({
                id: `anticipation:watcher:${schedule.id}:${schedule.nextRunAt}`,
                kind: "anticipation",
                headline: `${clip(schedule.title, 45)} reports in ${describeSpan(until)}`,
                because: [
                    `It is set to run ${describeWhen(schedule.nextRunAt, now)}.`,
                    schedule.quiet
                        ? "It stays silent unless it finds something, so no news is real news."
                        : "It will say something either way.",
                ],
                confidence: "certain",
                basis: "Read straight off the watcher's next scheduled run.",
                threadId: `watcher:${schedule.id}`,
                weight: 200 - until / HOUR,
            }),
        );
    }

    // Leave, which changes what everything else means. A decision left open over
    // a week away is not deferred, it is skipped.
    for (const period of facts.leave) {
        const startsAt = startOfDay(period.from);
        if (startsAt === undefined) continue;
        const until = startsAt - now;
        if (until <= 0 || until > LEAVE_LOOKAHEAD_MS) continue;
        const quietened = facts.schedules.filter((s) => s.skipOnLeave && s.enabled && !s.archived).length;
        calls.push(
            call({
                id: `anticipation:leave:${period.id}`,
                kind: "anticipation",
                headline: `Clear ${waiting.length} open thing${waiting.length === 1 ? "" : "s"} before leave on ${period.from}`,
                because: [
                    `Leave starts in ${describeSpan(until)}.`,
                    `${quietened} watcher${quietened === 1 ? "" : "s"} go quiet, so nothing will chase these while you are away.`,
                ],
                confidence: "certain",
                basis: "Read off the recorded leave dates and the watchers set to skip them.",
                minutes: 15,
                weight: 450 - until / DAY,
            }),
        );
    }

    return calls;
}

/** The ceiling nobody thinks about until a spawn silently queues behind seven others. */
function capacityCalls(facts: BoardFacts, now: number): ChiefCall[] {
    const live = facts.agents.filter(isLive);
    if (live.length < MAX_LIVE_AGENTS) return [];
    const oldest = live.slice().sort((a, b) => (a.startedAt ?? a.createdAt) - (b.startedAt ?? b.createdAt))[0];
    return [
        call({
            id: "capacity:agents",
            kind: "capacity",
            headline: `All ${MAX_LIVE_AGENTS} agent slots are busy`,
            because: [
                "Anything asked for now waits for one of them to finish.",
                `The oldest, ${clip(oldest.title, 40)}, has been going ${describeSpan(
                    now - (oldest.startedAt ?? oldest.createdAt),
                )}.`,
            ],
            confidence: "certain",
            basis: "Counted live agents against Orbit's own concurrency limit.",
            minutes: 2,
            threadId: `agent:${oldest.id}`,
            weight: 350,
        }),
    ];
}

// MARK: - Honesty

/**
 * Everything the board could not see, said out loud.
 *
 * An empty lane is ambiguous and the ambiguity is dangerous, so each one that
 * could be empty for the wrong reason gets a line here. The `others` lane is the
 * clearest case: it is empty on a fresh install because nothing has ever
 * recorded who is owed what, and that reads identically to nobody owing him
 * anything.
 */
export function deriveBlindSpots(
    facts: BoardFacts,
    threads: BoardThread[],
    artifacts: BoardArtifact[],
): string[] {
    const spots: string[] = [];

    if (facts.calendarProblem) {
        spots.push(`No calendar: ${clip(facts.calendarProblem, 90)} Nothing here anticipates your day.`);
    } else if (facts.meetings.length === 0) {
        spots.push("No meetings loaded, so nothing here is timed against your calendar.");
    }

    if (threadsInLane(threads, "others").length === 0) {
        spots.push("Nobody is recorded as owing you anything. Say who owes what and it will be tracked.");
    }

    // The leverage rule is deliberately blind to unrecorded links, and a number
    // derived from a partial graph must say that it is partial.
    if (threadsInLane(threads, "you").length > 1) {
        spots.push("Leverage counts only links Orbit has recorded, so real ones it was never told about score zero.");
    }

    const blindWatchers = facts.schedules.filter((s) => !s.archived && (s.blindRuns ?? 0) > 0).length;
    if (blindWatchers > 0) {
        spots.push(`${blindWatchers} watcher${blindWatchers === 1 ? " is" : "s are"} reporting blind, so their silence proves nothing.`);
    }

    // The read markers are the weakest claim on the board, so the moment any of
    // them is being shown, their limit is stated. Without this line a row with
    // no dot reads as "you have read this", which Orbit has no way of knowing.
    if (artifacts.some((artifact) => !artifact.opened)) {
        spots.push("Unread marks count only opens made from Orbit. Files opened in your editor still look unread.");
    }

    return spots;
}

// MARK: - Wording

/** Rough, human spans. Precision would be false and would read as false. */
export function describeSpan(ms: number): string {
    const minutes = Math.max(Math.round(ms / MINUTE), 1);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    const hours = Math.round(minutes / 60);
    if (hours < 36) return `${hours} hour${hours === 1 ? "" : "s"}`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? "" : "s"}`;
}

/** A moment, relative to now, in the fewest words that are still true. */
export function describeWhen(at: number, now: number): string {
    const delta = at - now;
    if (delta <= 0) return "now";
    return `in ${describeSpan(delta)}`;
}

/**
 * Does this text name any of these people?
 *
 * Matched on name parts of three characters or more so "Priya" finds a decision
 * about "Priya Raman", without a two-letter initial matching half the alphabet.
 * The same shape the memory lookup uses, kept separate because this one feeds a
 * judgement that is explicitly labelled a guess.
 */
export function mentionsAnyName(text: string, names: string[]): boolean {
    const haystack = text.toLowerCase();
    return names.some((name) =>
        name
            .toLowerCase()
            .split(/[\s,]+/)
            .filter((part) => part.length >= 3)
            .some((part) => haystack.includes(part)),
    );
}

/** Local midnight of a `YYYY-MM-DD` day, or undefined if it is not one. */
function startOfDay(day: string): number | undefined {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
    if (!match) return undefined;
    const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
    return Number.isFinite(at) ? at : undefined;
}

function firstLine(text: string | undefined): string | undefined {
    if (!text) return undefined;
    const line = text.split("\n").find((candidate) => candidate.trim().length > 0);
    return line ? clip(line.trim(), 90) : undefined;
}

/**
 * The tail of a path, with one directory of context.
 *
 * A bare file name is not enough to tell two `review.md` files apart, and he has
 * several repositories with the same folder layout. The parent directory is
 * almost always the disambiguating half, and it is the most that fits.
 */
function shortLocation(location: string): string {
    const parts = location.replace(/\/+$/, "").split("/").filter(Boolean);
    if (parts.length === 0) return location;
    return parts.slice(-2).join("/");
}

export function clip(text: string, max: number): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}
