/**
 * Mission Control: one section at a time, below the nav rail.
 *
 * It used to be a row of tabs above a 160px-tall list, inside a 480px window,
 * above the transcript. Three caps stacked on the tallest thing Orbit draws.
 * The switcher moved to a rail, and the rail then moved out of here entirely
 * (`NavRail.tsx`): it is drawn permanently under the chat panel header, so the
 * way into Mission Control no longer lives inside Mission Control.
 *
 * What is left is the pane and its foot. Which section is showing is decided
 * above, so this component is controlled and holds no state of its own.
 *
 * The rail is deliberately short. Additional UI was allowed; a more
 * complicated application was not. So nothing was invented to fill it, and
 * `agents` and `watchers`, two lists of the same thing, work Orbit is doing
 * without you, became one `work` section rather than two rail slots.
 */
import { useState } from "react";
import type { HistoryEntry, OrbitState, Schedule } from "../../shared/types.js";
import { CHAT_FONTS, CHAT_FONT_SIZES } from "../../shared/types.js";
import type { DeckSection } from "../../shared/types.js";
import { elapsedLabel } from "../mood.js";
import { BoardTab } from "./Board.js";
import { Icon } from "./Icon.js";
import { AgentRow } from "./Message.js";
import { Reader } from "./Reader.js";

export function MissionControl({
    state,
    section,
    reading,
}: {
    state: OrbitState;
    section: DeckSection;
    /** The document the viewer is showing, when there is one. */
    reading?: string;
}): React.JSX.Element {
    return (
        <div className="deck">
            <div className="deck-body">
                {section === "board" && <BoardTab state={state} />}
                {section === "work" && <WorkSection state={state} />}
                {section === "memory" && <MemoryTab state={state} />}
                {section === "read" && <Reader path={reading} />}
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
    if (cadence.kind === "daily") {
        const label = `daily at ${cadence.time}`;
        // Same idea as an interval's leash, measured in days: the slot the user
        // picked is kept, the watcher just skips days until it has news.
        const days = schedule.backoffDays ?? 1;
        return days > 1 ? `${label} · easing off to every ${days} days` : label;
    }
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
