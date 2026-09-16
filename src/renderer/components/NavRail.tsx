/**
 * The nav rail: the five sections of Mission Control, and what each one is
 * shouting about before it is opened.
 *
 * It was built inside Mission Control, which meant it only existed while
 * Mission Control was open, and Mission Control is the thing it is meant to
 * open. So it lives here now and is drawn permanently above the transcript,
 * with Mission Control reduced to the pane below it.
 *
 * Two orientations, one set of buttons. `column` is the original vertical rail
 * and is kept because it is the right shape inside a wide pane. `bar` is what
 * the chat panel uses: horizontal, icon-first, labels kept because five short
 * words cost nothing across 440px and an icon-only rail is a memory test. The
 * choice is horizontal because the scarce axis in the chat panel is width: the
 * panel floor is 440px, of which the vertical rail took 58px, and every one of
 * those pixels came out of the column the user actually reads.
 */
import type { OrbitState } from "../../shared/types.js";
import type { DeckSection } from "../../shared/types.js";
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
        help: "What Orbit remembers about you, and anything waiting on you",
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

/** Not one of the four. It is how the panel looks, not what Orbit is doing. */
export const LOOK: SectionDef = {
    id: "look",
    label: "look",
    icon: "sliders",
    help: "Change how the panel looks",
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
            return waiting > 0
                ? { attention: waiting, why: `${waiting} decision${waiting === 1 ? "" : "s"} waiting on you` }
                : {};
        }
        // The log is a record, appearance is never urgent, and the viewer is
        // a place rather than a queue: the board already counts what is unread.
        case "read":
        case "log":
        case "look":
            return {};
    }
}

export function NavRail({
    state,
    section,
    open,
    orientation = "column",
    onSelect,
}: {
    state: OrbitState;
    section: DeckSection;
    /**
     * Whether the pane below is showing. A rail button is only drawn as current
     * when the section it names is actually on screen, otherwise the permanent
     * rail claims a pane is open when the panel is nothing but transcript.
     */
    open: boolean;
    orientation?: "column" | "bar";
    onSelect(id: DeckSection): void;
}): React.JSX.Element {
    return (
        <nav className={`deck-rail ${orientation}`} aria-label="Mission control sections">
            {SECTIONS.map((entry) => (
                <RailButton
                    key={entry.id}
                    entry={entry}
                    on={open && section === entry.id}
                    rail={railState(state, entry.id)}
                    onSelect={() => onSelect(entry.id)}
                />
            ))}
            <span className="rail-spacer" />
            <RailButton
                entry={LOOK}
                on={open && section === LOOK.id}
                rail={railState(state, LOOK.id)}
                onSelect={() => onSelect(LOOK.id)}
            />
        </nav>
    );
}

function RailButton({
    entry,
    on,
    rail,
    onSelect,
}: {
    entry: SectionDef;
    on: boolean;
    rail: RailState;
    onSelect(): void;
}): React.JSX.Element {
    return (
        <button
            className={`rail-tab ${on ? "on" : ""}`}
            title={rail.why ? `${entry.help}\n\n${rail.why}` : entry.help}
            aria-label={rail.why ? `${entry.label} — ${rail.why}` : entry.label}
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
            <span className="rail-label">{entry.label}</span>
        </button>
    );
}
