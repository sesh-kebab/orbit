/**
 * Mission Control: a left-hand rail, and one section at a time beside it.
 *
 * It used to be a row of tabs above a 160px-tall list, inside a 480px window,
 * above the transcript. Three caps stacked on the tallest thing Orbit draws.
 * Moving the switcher to a vertical rail buys back the tab row's height, and
 * the window is wide enough now that the rail costs nothing that was being
 * used for reading.
 *
 * The rail is deliberately short. Additional UI was allowed; a more
 * complicated application was not. So nothing was invented to fill it, and
 * `agents` and `watchers` — two lists of the same thing, work Orbit is doing
 * without you — became one `work` section rather than two rail slots.
 */
import { useEffect, useState } from "react";
import type { HistoryEntry, OrbitState, Schedule } from "../../shared/types.js";
import { CHAT_FONTS, CHAT_FONT_SIZES, DECK_SECTIONS, isDeckSection } from "../../shared/types.js";
import type { DeckSection } from "../../shared/types.js";
import { elapsedLabel } from "../mood.js";
import { onScene } from "../scene.js";
import { BoardTab } from "./Board.js";
import { Icon, type IconName } from "./Icon.js";
import { AgentRow } from "./Message.js";

interface SectionDef {
    id: DeckSection;
    label: string;
    icon: IconName;
    help: string;
}

const SECTIONS: SectionDef[] = [
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
        id: "log",
        label: "log",
        icon: "clock",
        help: "An append-only timeline of everything that has happened",
    },
];

/** Not one of the four. It is how the panel looks, not what Orbit is doing. */
const LOOK: SectionDef = {
    id: "look",
    label: "look",
    icon: "sliders",
    help: "Change how the panel looks",
};

/**
 * Scene names from the capture harness, which predate the rail and still say
 * `agents` and `watchers`. They are aliases rather than a rename so an old
 * capture script keeps posing the panel at the section it meant.
 */
const SCENE_ALIASES: Array<[string, DeckSection]> = [
    ["agents", "work"],
    ["watchers", "work"],
    ["history", "log"],
];

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
        // The log is a record, never a demand, and appearance is never urgent.
        case "log":
        case "look":
            return {};
    }
}

export function MissionControl({ state }: { state: OrbitState }): React.JSX.Element {
    // Seeded from the saved choice so reopening Orbit lands where he left it,
    // then owned locally: a click must switch the pane whether or not the
    // write to settings.json comes back.
    const [section, setSection] = useState<DeckSection>(() =>
        isDeckSection(state.settings.deckSection) ? state.settings.deckSection : "board",
    );

    useEffect(
        () =>
            onScene((scene) => {
                const alias = SCENE_ALIASES.find(([suffix]) => scene.endsWith(suffix));
                if (alias) {
                    setSection(alias[1]);
                    return;
                }
                const match = DECK_SECTIONS.find((id) => scene.endsWith(id));
                if (match) setSection(match);
            }),
        [],
    );

    const choose = (id: DeckSection): void => {
        setSection(id);
        void window.orbit.setSettings({ deckSection: id });
    };

    return (
        <div className="deck">
            <nav className="deck-rail" aria-label="Mission control sections">
                {SECTIONS.map((entry) => (
                    <RailButton
                        key={entry.id}
                        entry={entry}
                        on={section === entry.id}
                        rail={railState(state, entry.id)}
                        onSelect={() => choose(entry.id)}
                    />
                ))}
                <span className="rail-spacer" />
                <RailButton
                    entry={LOOK}
                    on={section === LOOK.id}
                    rail={railState(state, LOOK.id)}
                    onSelect={() => choose(LOOK.id)}
                />
            </nav>

            <div className="deck-main">
                <div className="deck-body">
                    {section === "board" && <BoardTab state={state} />}
                    {section === "work" && <WorkSection state={state} />}
                    {section === "memory" && <MemoryTab state={state} />}
                    {section === "log" && <HistoryTab state={state} />}
                    {section === "look" && <LookTab state={state} />}
                </div>

                <div className="deck-foot">
                    <button
                        className="link"
                        title="Change where agents work by default"
                        onClick={() => void window.orbit.chooseWorkspace()}
                    >
                        <Icon name="folder" /> {shortenPath(state.settings.workspace)}
                    </button>
                    <span className="muted small">
                        {state.usage.agentsRun} run{state.usage.agentsRun === 1 ? "" : "s"} ·{" "}
                        {state.usage.toolCalls} step{state.usage.toolCalls === 1 ? "" : "s"} ·{" "}
                        {formatTokens(state.usage.inputTokens + state.usage.outputTokens)} tok
                    </span>
                </div>
            </div>
        </div>
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

/**
 * Work: what has been delegated, and what stands watch.
 *
 * One section rather than two rail slots. They were separate tabs because they
 * are separate stores, which is a fact about Orbit's insides and not about the
 * question being asked. Both answer "what is Orbit doing without me", both are
 * short lists, and neither was ever tall enough to need a screen of its own.
 */
function WorkSection({ state }: { state: OrbitState }): React.JSX.Element {
    return (
        <div className="deck-list">
            <AgentsGroup state={state} />
            <WatchersGroup state={state} />
        </div>
    );
}

function AgentsGroup({ state }: { state: OrbitState }): React.JSX.Element {
    return (
        <div className="lane">
            <div className="lane-head" title="Every task Orbit has delegated — click one for its full activity feed">
                <span className="lane-label">delegated</span>
                {state.agents.length > 0 && <em>{state.agents.length}</em>}
            </div>
            {state.agents.length === 0 ? (
                <p className="muted small pad">Nothing delegated yet. Ask for something that needs doing.</p>
            ) : (
                <>
                    {[...state.agents].reverse().map((agent) => (
                        <AgentDetail key={agent.id} state={state} agentId={agent.id} />
                    ))}
                    {state.agents.some((a) => a.status === "done" || a.status === "failed") && (
                        <button
                            className="link center"
                            title="Remove finished and failed agents from this list"
                            onClick={() => void window.orbit.clearFinished()}
                        >
                            clear finished
                        </button>
                    )}
                </>
            )}
        </div>
    );
}

function AgentDetail({ state, agentId }: { state: OrbitState; agentId: string }): React.JSX.Element {
    const [open, setOpen] = useState(false);
    const agent = state.agents.find((a) => a.id === agentId);
    if (!agent) return <></>;

    return (
        <div className="agent-block">
            <div onClick={() => setOpen((value) => !value)}>
                <AgentRow agent={agent} />
            </div>
            {open && (
                <div className="agent-detail">
                    <p className="muted small">{agent.task}</p>
                    <div className="kv">
                        <span>where</span>
                        <code>{agent.cwd}</code>
                    </div>
                    {(agent.inputTokens > 0 || agent.outputTokens > 0) && (
                        <div className="kv">
                            <span>tokens</span>
                            <code>
                                {formatTokens(agent.inputTokens)} in · {formatTokens(agent.outputTokens)} out
                            </code>
                        </div>
                    )}
                    <ol className="steps">
                        {agent.steps.slice(-14).map((step) => (
                            <li key={step.id} className={`step step-${step.kind}`}>
                                {step.label}
                            </li>
                        ))}
                    </ol>
                    {agent.result && <p className="result">{agent.result}</p>}
                    {agent.error && <p className="result error">{agent.error}</p>}
                </div>
            )}
        </div>
    );
}

function WatchersGroup({ state }: { state: OrbitState }): React.JSX.Element {
    const [showArchived, setShowArchived] = useState(false);
    const live = state.schedules.filter((schedule) => !schedule.archived);
    const archived = state.schedules.filter((schedule) => schedule.archived);

    return (
        <div className="lane">
            <div className="lane-head" title="Standing jobs that run on a schedule">
                <span className="lane-label">watching</span>
                {live.length > 0 && <em>{live.length}</em>}
            </div>
            {state.schedules.length === 0 && (
                <p className="muted small pad">
                    No standing watchers. Try: “keep an eye on my inbox every 30 minutes and flag anything
                    urgent”, or “give me an executive summary at 8:30 every morning”.
                </p>
            )}
            {state.schedules.length > 0 && live.length === 0 && (
                <p className="muted small pad">
                    Nothing on duty. {archived.length} watcher{archived.length === 1 ? "" : "s"} archived.
                </p>
            )}
            {live.map((schedule) => (
                <WatcherRow key={schedule.id} schedule={schedule} />
            ))}
            {archived.length > 0 && (
                <button
                    className="link center"
                    title="Archived watchers keep their history but never run"
                    onClick={() => setShowArchived((value) => !value)}
                >
                    {showArchived ? "hide" : "show"} {archived.length} archived
                </button>
            )}
            {showArchived &&
                archived.map((schedule) => <WatcherRow key={schedule.id} schedule={schedule} />)}
        </div>
    );
}

function WatcherRow({ schedule }: { schedule: Schedule }): React.JSX.Element {
    const [open, setOpen] = useState(false);
    const running = Boolean(schedule.activeAgentId);
    const archived = schedule.archived === true;
    return (
        <div className={`agent-block ${schedule.enabled ? "" : "off"}`}>
            <div className="agent-row" onClick={() => setOpen((value) => !value)}>
                <span className={`agent-dot ${running ? "spinning" : ""}`} style={{ color: "#8FD8FF", borderColor: "#8FD8FF" }}>
                    {running ? "" : <Icon name={archived ? "archive" : "clock"} />}
                </span>
                <div className="agent-main">
                    <span className="agent-title">{schedule.title}</span>
                    <span className="agent-step">
                        {cadenceLabel(schedule)} · {schedule.runCount} run
                        {schedule.runCount === 1 ? "" : "s"}
                        {schedule.quiet ? " · quiet" : ""}
                        {archived ? " · archived" : ""}
                    </span>
                </div>
                {!archived && (
                    <button
                        className="icon-button"
                        title={schedule.enabled ? "Pause this watcher" : "Resume this watcher"}
                        aria-label={schedule.enabled ? "Pause this watcher" : "Resume this watcher"}
                        onClick={(event) => {
                            event.stopPropagation();
                            void window.orbit.setScheduleEnabled(schedule.id, !schedule.enabled);
                        }}
                    >
                        <Icon name={schedule.enabled ? "pause" : "play"} />
                    </button>
                )}
                <button
                    className="icon-button"
                    title={archived ? "Restore" : "Archive — keeps its history, stops it running"}
                    aria-label={archived ? "Restore this watcher" : "Archive this watcher"}
                    onClick={(event) => {
                        event.stopPropagation();
                        void window.orbit.setScheduleArchived(schedule.id, !archived);
                    }}
                >
                    <Icon name={archived ? "unarchive" : "archive"} />
                </button>
                {!archived && (
                    <button
                        className="icon-button"
                        title="Run this watcher now"
                        aria-label="Run this watcher now"
                        onClick={(event) => {
                            event.stopPropagation();
                            void window.orbit.runScheduleNow(schedule.id);
                        }}
                    >
                        <Icon name="run" />
                    </button>
                )}
            </div>
            {open && (
                <div className="agent-detail">
                    <p className="muted small">{schedule.task}</p>
                    <div className="kv">
                        <span>next</span>
                        <code>
                            {archived
                                ? "archived"
                                : schedule.enabled && !hasFired(schedule)
                                  ? new Date(schedule.nextRunAt).toLocaleString()
                                  : "paused"}
                        </code>
                    </div>
                    {schedule.lastResult && <p className="result">{schedule.lastResult}</p>}
                    <button
                        className="link danger"
                        title="Delete this watcher permanently"
                        onClick={() => void window.orbit.deleteSchedule(schedule.id)}
                    >
                        delete watcher
                    </button>
                </div>
            )}
        </div>
    );
}

/** A one-off whose single moment has passed. It will not run again. */
function hasFired(schedule: Schedule): boolean {
    return schedule.cadence.kind === "once" && schedule.runCount > 0;
}

function MemoryTab({ state }: { state: OrbitState }): React.JSX.Element {
    const openItems = state.openItems.filter((item) => !item.resolved);
    return (
        <div className="deck-list">
            <button
                className="link"
                title="Open persona.md — the text appended to Orbit's system prompt"
                onClick={() => void window.orbit.openPersona()}
            >
                <Icon name="edit" /> edit personality file
            </button>
            {openItems.map((item) => (
                <div key={item.id} className="memory-row">
                    <span className="tag">waiting on you</span>
                    <span className="memory-text">{item.text}</span>
                    <button
                        className="icon-button"
                        title="Mark as dealt with"
                        aria-label="Mark as dealt with"
                        onClick={() => void window.orbit.resolveOpenItem(item.id)}
                    >
                        <Icon name="check" />
                    </button>
                </div>
            ))}
            {state.memories.length === 0 ? (
                <p className="muted small pad">
                    Nothing remembered yet. Tell Orbit a lasting preference and it will write it down.
                </p>
            ) : (
                [...state.memories].reverse().map((memory) => (
                    <div key={memory.id} className="memory-row">
                        <span className="tag">{memory.category}</span>
                        <span className="memory-text">{memory.text}</span>
                        <button
                            className="icon-button"
                            title="Forget this"
                            aria-label="Forget this"
                            onClick={() => void window.orbit.forgetMemory(memory.id)}
                        >
                            <Icon name="trash" />
                        </button>
                    </div>
                ))
            )}
        </div>
    );
}

function HistoryTab({ state }: { state: OrbitState }): React.JSX.Element {
    const entries = [...state.history].reverse().slice(0, 80);
    if (entries.length === 0) return <p className="muted small pad">Nothing has happened yet.</p>;
    return (
        <div className="deck-list log">
            {entries.map((entry) => (
                <div key={entry.id} className="log-row">
                    <span className="log-time">{new Date(entry.at).toLocaleTimeString()}</span>
                    <span className={`log-kind ${kindTone(entry.kind)}`}>{entry.kind.replace(".", " ")}</span>
                    <span className="log-title">{entry.title}</span>
                </div>
            ))}
        </div>
    );
}

/** The one place the panel's own appearance can be changed without the tray. */
function LookTab({ state }: { state: OrbitState }): React.JSX.Element {
    const { chatFontFamily, chatFontSize, panelOpacity } = state.settings;
    return (
        <div className="deck-list">
            <div className="setting">
                <span className="setting-label">font</span>
                <div className="setting-options">
                    {CHAT_FONTS.map((font) => (
                        <button
                            key={font.id}
                            className={`chip ${chatFontFamily === font.id ? "chip-primary" : "chip-neutral"}`}
                            style={{ fontFamily: font.stack }}
                            title={`Set the chat font to ${font.label}`}
                            onClick={() => void window.orbit.setSettings({ chatFontFamily: font.id })}
                        >
                            {font.label}
                        </button>
                    ))}
                </div>
            </div>
            <div className="setting">
                <span className="setting-label">size</span>
                <div className="setting-options">
                    {CHAT_FONT_SIZES.map((size) => (
                        <button
                            key={size}
                            className={`chip ${chatFontSize === size ? "chip-primary" : "chip-neutral"}`}
                            title={`Set the chat text size to ${size}`}
                            onClick={() => void window.orbit.setSettings({ chatFontSize: size })}
                        >
                            {size}
                        </button>
                    ))}
                </div>
            </div>
            <div className="setting">
                <span className="setting-label">opacity</span>
                <div className="setting-options">
                    {[0.6, 0.75, 0.88, 1].map((value) => (
                        <button
                            key={value}
                            className={`chip ${Math.abs(panelOpacity - value) < 0.01 ? "chip-primary" : "chip-neutral"}`}
                            title={`Make the panels ${Math.round(value * 100)}% solid`}
                            onClick={() => void window.orbit.setSettings({ panelOpacity: value })}
                        >
                            {Math.round(value * 100)}%
                        </button>
                    ))}
                </div>
            </div>
            <p className="muted small pad">
                Changes apply straight away and are saved to settings.json.
            </p>
        </div>
    );
}

function kindTone(kind: HistoryEntry["kind"]): string {    if (kind.endsWith("failed") || kind.includes("timeout") || kind === "session.error") return "bad";
    if (kind.endsWith("done")) return "good";
    return "";
}

function cadenceLabel(schedule: Schedule): string {
    const { cadence } = schedule;
    if (cadence.kind === "interval") {
        const backoff = schedule.backoffMinutes;
        const label = intervalLabel(cadence.minutes);
        // The configured cadence never changes; a dull watcher just runs on a
        // longer leash until it has something to say.
        return backoff && backoff > cadence.minutes
            ? `${label} · easing off to ${intervalLabel(backoff)}`
            : label;
    }
    if (cadence.kind === "daily") return `daily at ${cadence.time}`;
    if (hasFired(schedule)) return "one-off, fired";
    return schedule.enabled ? `in ${elapsedLabel(Date.now(), cadence.at)}` : "one-off";
}

function intervalLabel(minutes: number): string {
    return minutes % 60 === 0 && minutes >= 60 ? `every ${minutes / 60}h` : `every ${minutes}m`;
}

function formatTokens(count: number): string {
    if (count < 1000) return String(count);
    if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
    return `${(count / 1_000_000).toFixed(2)}M`;
}

function shortenPath(path: string): string {
    const parts = path.split("/").filter(Boolean);
    return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}
