/**
 * The roster rail: everything in flight, and the six places to look.
 *
 * It replaces a horizontal bar of five section tabs. The bar was the right
 * answer while the rail only held sections, because width is the scarce axis in
 * a 440px panel and a vertical rail spent 58px of it on five words. It stops
 * being the right answer the moment the rail also has to hold threads, because
 * threads are a list that grows and a horizontal list that grows has nowhere to
 * go. So the rail is vertical again at 52px, and it now earns those pixels by
 * being the one place that answers "what is happening" without opening anything.
 *
 * Two independent marks are lit at once and they mean different things, which
 * is the part most worth getting right:
 *
 *   The identity bar, a 2px line down the left edge of a puck in that thread's
 *   own hue, means "this is the thread you are in". It survives looking at the
 *   board, the log, the settings, anything. It is about what you are working on.
 *
 *   The section fill, the tinted tab background, means "this is the surface on
 *   screen". It is about where you are looking right now.
 *
 * One of each is lit at all times and never two of either. Collapsing them into
 * one mark was the original design, and it made reading the log look like
 * leaving the thread.
 */
import { useEffect, useRef, useState } from "react";
import type { DeckSection, OrbitState } from "../../shared/types.js";
import type { PuckState, RosterLayout, RosterThread } from "../roster.js";
import { Icon, type IconName } from "./Icon.js";

export interface SectionDef {
    id: DeckSection;
    label: string;
    icon: IconName;
    help: string;
}

export const SECTIONS: SectionDef[] = [
    {
        id: "board",
        label: "board",
        icon: "deck",
        help: "Every parallel thread at once, and what Orbit thinks you should do about them",
    },
    {
        id: "work",
        label: "work",
        icon: "run",
        help: "Everything Orbit is doing for you: delegated tasks, and the watchers that run on a schedule",
    },
    {
        id: "memory",
        label: "memory",
        icon: "book",
        help: "What Orbit remembers about you, what it is proposing about itself, and anything waiting on you",
    },
    {
        id: "read",
        label: "read",
        icon: "file",
        help: "Whatever Orbit last made you, rendered here rather than in a browser",
    },
    {
        id: "log",
        label: "log",
        icon: "clock",
        help: "An append-only timeline of everything that has happened",
    },
];

/** Not one of the five. It is how the panel looks, not what Orbit is doing. */
export const LOOK: SectionDef = {
    id: "look",
    label: "look",
    icon: "sliders",
    help: "Change how the panel looks, and everything else Orbit lets you set",
};

/**
 * What the rail says about a section without being opened.
 *
 * `attention` is the only number drawn in red, and it means the same thing
 * everywhere: this will not move until he does something. `count` is context
 * and is drawn quietly. A section with neither gets nothing, because a badge
 * reading zero teaches him to stop reading badges.
 */
export interface RailState {
    attention?: number;
    count?: number;
    /** Something worth a glance that has no useful number. */
    dot?: boolean;
    /** Spoken, for the tooltip and for anything that cannot see colour. */
    why?: string;
}

export function railState(state: OrbitState, id: DeckSection): RailState {
    switch (id) {
        case "board": {
            // Only what is on him. A count of everything in flight would be a
            // number he can do nothing with.
            const onYou = state.board.threads.filter((thread) => thread.lane === "you").length;
            const unopened = state.board.artifacts.filter((artifact) => !artifact.opened).length;
            if (onYou > 0) {
                return {
                    attention: onYou,
                    why: `${onYou} thread${onYou === 1 ? "" : "s"} waiting on you`,
                };
            }
            if (unopened > 0) {
                return { dot: true, why: `${unopened} thing${unopened === 1 ? "" : "s"} Orbit made you, unopened` };
            }
            return {};
        }
        case "work": {
            // A permission request is an agent stopped dead until he answers,
            // which is the one thing in here that is genuinely on him.
            const blocked = state.requests.length;
            const live = state.agents.filter((agent) => agent.status === "running").length;
            const watchers = state.schedules.filter((s) => s.enabled && !s.archived).length;
            if (blocked > 0) {
                return {
                    attention: blocked,
                    why: `${blocked} agent${blocked === 1 ? "" : "s"} waiting for your approval`,
                };
            }
            if (live > 0) return { count: live, why: `${live} running` };
            if (watchers > 0) return { count: watchers, why: `${watchers} watcher${watchers === 1 ? "" : "s"} on duty` };
            return {};
        }
        case "memory": {
            const waiting = state.openItems.filter((item) => !item.resolved).length;
            const proposed = state.proposals.filter((proposal) => proposal.status === "proposed").length;
            if (waiting > 0) {
                return { attention: waiting, why: `${waiting} decision${waiting === 1 ? "" : "s"} waiting on you` };
            }
            // Quiet, because a proposal is Orbit asking for its own benefit and
            // must never shout in the same voice as his own blocked work.
            if (proposed > 0) {
                return {
                    dot: true,
                    why: `${proposed} thing${proposed === 1 ? "" : "s"} Orbit is proposing about itself`,
                };
            }
            return {};
        }
        // The log is a record, appearance is never urgent, and the viewer is
        // a place rather than a queue: the board already counts what is unread.
        case "read":
        case "log":
        case "look":
            return {};
    }
}

/** Height of one labelled roster item, including the gap below it. */
const ROSTER_ITEM = 40;
/** The same item with its label dropped, which is the first thing to go. */
const ROSTER_ITEM_BARE = 31;
/**
 * The rail never draws more than this many thread faces, even in a tall panel.
 * It matches the live-agent ceiling, so a full house of running work always
 * fits and the overflow puck only appears once finished threads have piled up
 * behind it. Twenty faces would be a list, and a list belongs in the work
 * section where it can have full names and elapsed times.
 */
const MAX_FACES = 8;
/** Below this many labelled slots the labels are not worth their height. */
const LABEL_FLOOR = 4;

export function NavRail({
    state,
    section,
    open,
    layout,
    activeThreadId,
    onSelect,
    onSelectThread,
    onMeasure,
}: {
    state: OrbitState;
    section: DeckSection;
    /**
     * Whether the pane below is showing. A rail button is only drawn as current
     * when the section it names is actually on screen, otherwise the permanent
     * rail claims a pane is open when the panel is nothing but transcript.
     */
    open: boolean;
    layout: RosterLayout;
    /** The thread being worked in, which is not the same as the surface shown. */
    activeThreadId?: string;
    onSelect(id: DeckSection): void;
    /** Undefined clears the active thread and goes back to talking to Orbit. */
    onSelectThread(id: string | undefined): void;
    /** Reports how many faces this rail has room for, once measured. */
    onMeasure(capacity: number): void;
}): React.JSX.Element {
    const railRef = useRef<HTMLElement | null>(null);
    const navRef = useRef<HTMLDivElement | null>(null);
    const [labelled, setLabelled] = useState(true);

    // Capacity is measured rather than assumed. The panel resizes down to a
    // 660px floor and the arithmetic that holds at the floor does not hold at
    // 1200px, so a constant would mean either wasting half a tall rail or
    // folding threads away in one that had room for them.
    useEffect(() => {
        const rail = railRef.current;
        const nav = navRef.current;
        if (!rail || !nav) return;

        const measure = (): void => {
            const space = rail.clientHeight - nav.offsetHeight;
            const withLabels = Math.floor(space / ROSTER_ITEM) - 1;
            const bare = Math.floor(space / ROSTER_ITEM_BARE) - 1;
            // Labels go before faces do. A nameless puck is still a thread you
            // can see and click; a folded one is a thread you cannot.
            const keepLabels = withLabels >= LABEL_FLOOR;
            setLabelled(keepLabels);
            onMeasure(Math.max(1, Math.min(MAX_FACES, keepLabels ? withLabels : bare)));
        };

        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(rail);
        return () => observer.disconnect();
    }, [onMeasure]);

    const faces = layout.shown.length + (layout.overflow ? 1 : 0);

    return (
        <nav
            className={`deck-rail column ${labelled ? "labelled" : "bare"}`}
            aria-label="Threads and sections"
            ref={railRef}
        >
            <div className="rail-roster">
                <OrbitPuck
                    active={activeThreadId === undefined}
                    busy={state.orbitBusy}
                    labelled={labelled}
                    onSelect={() => onSelectThread(undefined)}
                />
                {layout.shown.map((thread) => (
                    <ThreadPuck
                        key={thread.id}
                        thread={thread}
                        active={thread.id === activeThreadId}
                        labelled={labelled}
                        onSelect={() => onSelectThread(thread.id)}
                    />
                ))}
                {layout.overflow && (
                    <OverflowPuck
                        count={layout.overflow.count}
                        state={layout.overflow.state}
                        hidden={layout.overflow.hidden}
                        labelled={labelled}
                        onSelect={() => onSelect("work")}
                    />
                )}
            </div>

            {/*
             * One conditional, and it is the difference between a rail that
             * looks designed on day one and a rail with an empty compartment in
             * it. A divider separates two groups. Below two pucks there is only
             * one group, so there is nothing to separate and the line would be
             * drawn around nothing.
             */}
            {faces >= 2 && <span className="rail-divide" />}

            <div className="rail-sections" ref={navRef}>
                {SECTIONS.map((entry) => (
                    <RailButton
                        key={entry.id}
                        entry={entry}
                        on={open && section === entry.id}
                        rail={railState(state, entry.id)}
                        labelled={labelled}
                        onSelect={() => onSelect(entry.id)}
                    />
                ))}
                <span className="rail-spacer" />
                <RailButton
                    entry={LOOK}
                    on={open && section === LOOK.id}
                    rail={railState(state, LOOK.id)}
                    labelled={labelled}
                    onSelect={() => onSelect(LOOK.id)}
                />
            </div>
        </nav>
    );
}

/**
 * Orbit's own face, always first and never folded.
 *
 * It is on the rail for the same reason the thread pucks are: going back to
 * talking to Orbit is something you do constantly, and without a face for it
 * the only way back out of a thread would be a close button somewhere else.
 * With it, Orbit and four agents are five things of the same kind in one
 * column, which is what makes switching cost one click from anywhere.
 */
function OrbitPuck({
    active,
    busy,
    labelled,
    onSelect,
}: {
    active: boolean;
    busy: boolean;
    labelled: boolean;
    onSelect(): void;
}): React.JSX.Element {
    return (
        <button
            className={`rail-puck orbit ${active ? "active" : ""} ${busy ? "busy" : ""}`}
            title={active ? "You are talking to Orbit" : "Go back to talking to Orbit"}
            aria-label={busy ? "Orbit, thinking" : "Orbit"}
            aria-current={active ? "true" : undefined}
            onClick={onSelect}
        >
            <span className="puck-face orbit-face" />
            {labelled && <span className="puck-label">orbit</span>}
        </button>
    );
}

/** Spoken form of each face, for the tooltip and for anything without colour. */
const STATE_WORD: Record<PuckState, string> = {
    working: "working",
    "needs-you": "needs you",
    new: "done, something to open",
    resting: "resting",
    stopped: "stopped",
    severed: "cut off by a restart",
};

/** The three faces that carry colour. Everything else is desaturated. */
function isLit(state: PuckState): boolean {
    return state === "working" || state === "needs-you" || state === "new";
}

function ThreadPuck({
    thread,
    active,
    labelled,
    onSelect,
}: {
    thread: RosterThread;
    active: boolean;
    labelled: boolean;
    onSelect(): void;
}): React.JSX.Element {
    return (
        <button
            className={`rail-puck thread ${thread.state} ${active ? "active" : ""}`}
            // The hue is the thread's identity everywhere it appears, so it is
            // handed over as a variable rather than baked into a class: one
            // value drives the face, the identity bar, the shelf pill and the
            // speech bubble.
            style={{ ["--puck-hue" as string]: String(Math.round(thread.hue * 360)) }}
            title={`${thread.title}\n\n${STATE_WORD[thread.state]}`}
            aria-label={`${thread.title}, ${STATE_WORD[thread.state]}`}
            aria-current={active ? "true" : undefined}
            onClick={onSelect}
        >
            <span className={`puck-face ${isLit(thread.state) ? "lit" : ""}`}>{thread.monogram}</span>
            {/*
             * The label is a rail affordance and nothing more. It is the first
             * thing dropped when the panel is short, and a long name is cut
             * with a tail ellipsis rather than shrunk further: the full name is
             * already a glance away in the header, and six point type is not a
             * name.
             */}
            {labelled && <span className="puck-label">{thread.title}</span>}
        </button>
    );
}

/**
 * The folded remainder.
 *
 * It wears the worst state it is hiding, which is the whole point of it. A
 * plain "+3" would let the rail look calm with a failure sat behind it, and the
 * rail's one real promise is that a grey rail means nothing needs you.
 */
function OverflowPuck({
    count,
    state,
    hidden,
    labelled,
    onSelect,
}: {
    count: number;
    state: PuckState;
    hidden: RosterThread[];
    labelled: boolean;
    onSelect(): void;
}): React.JSX.Element {
    const names = hidden.map((thread) => `${thread.title} (${STATE_WORD[thread.state]})`).join("\n");
    return (
        <button
            className={`rail-puck overflow ${state}`}
            title={`${count} more thread${count === 1 ? "" : "s"}\n\n${names}\n\nOpen the work section to see them all`}
            aria-label={`${count} more threads, worst of them ${STATE_WORD[state]}`}
            onClick={onSelect}
        >
            <span className={`puck-face ${isLit(state) ? "lit" : ""}`}>+{count}</span>
            {labelled && <span className="puck-label">more</span>}
        </button>
    );
}

function RailButton({
    entry,
    on,
    rail,
    labelled,
    onSelect,
}: {
    entry: SectionDef;
    on: boolean;
    rail: RailState;
    labelled: boolean;
    onSelect(): void;
}): React.JSX.Element {
    return (
        <button
            className={`rail-tab ${on ? "on" : ""}`}
            title={rail.why ? `${entry.help}\n\n${rail.why}` : entry.help}
            aria-label={rail.why ? `${entry.label}, ${rail.why}` : entry.label}
            aria-current={on ? "page" : undefined}
            onClick={onSelect}
        >
            <span className="rail-mark">
                <Icon name={entry.icon} />
                {rail.attention !== undefined && <em className="rail-badge attention">{rail.attention}</em>}
                {rail.attention === undefined && rail.count !== undefined && (
                    <em className="rail-badge">{rail.count}</em>
                )}
                {rail.attention === undefined && rail.count === undefined && rail.dot && (
                    <em className="rail-badge quiet" />
                )}
            </span>
            {labelled && <span className="rail-label">{entry.label}</span>}
        </button>
    );
}
