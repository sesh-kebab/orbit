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
import { useEffect, useState } from "react";
import type { HistoryEntry, MemoryNote, OrbitState, Proposal, Schedule, Settings } from "../../shared/types.js";
import { CHAT_FONTS, CHAT_FONT_SIZES } from "../../shared/types.js";
import { MEMORY_CATEGORIES, endsIncomplete } from "../../shared/memoryText.js";
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
        <div className="deck" data-section={section}>
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
            <MemoryList memories={state.memories} />
            <ProposalList proposals={state.proposals} />
        </div>
    );
}

/**
 * What Orbit is proposing about itself.
 *
 * A second group inside memory rather than a sixth rail section, and that is a
 * compromise rather than a discovery. A rail section is a promise that
 * something is worth opening daily; proposals are worth opening about once a
 * fortnight, and a section that is empty forty nights out of forty-two trains
 * the eye to skip that part of the rail. Memory is already the place for "what
 * Orbit knows and thinks", so this is the nearest honest home.
 *
 * The group is titled for what it holds rather than for the section it sits in.
 * "about me" was the first title and it was wrong in the one way that matters:
 * directly above it is a list of things Orbit remembers about the user, so a
 * heading saying "about me" reads as a label for that list, and the proposals
 * underneath look like more of the same.
 *
 * Only `proposed` is listed, and only approve or decline are offered. Shipping
 * is a claim about code that landed and belongs to whatever can name the branch
 * and the commit, which a button cannot.
 */
function ProposalList({ proposals }: { proposals: readonly Proposal[] }): React.JSX.Element | null {
    const open = proposals.filter((proposal) => proposal.status === "proposed");
    const shipped = proposals.filter((proposal) => proposal.status === "shipped").length;
    if (open.length === 0 && shipped === 0) return null;

    return (
        <div className="memory-group">
            <div className="group-head">
                <span className="group-title">changes Orbit is proposing</span>
                <span className="muted small">
                    {open.length > 0
                        ? `${open.length} waiting on an answer`
                        : `${shipped} shipped, nothing waiting`}
                </span>
            </div>
            {open.map((proposal) => (
                <div key={proposal.id} className="memory-row proposal-row">
                    <span className="tag quiet">proposing</span>
                    <span className="memory-text">{proposal.text}</span>
                    <button
                        className="icon-button"
                        title="Worth doing. Orbit will pick it up next time it works on itself."
                        aria-label="Approve this proposal"
                        onClick={() => void window.orbit.answerProposal(proposal.id, "approved")}
                    >
                        <Icon name="check" />
                    </button>
                    <button
                        className="icon-button"
                        title="Not worth doing. Orbit will stop raising it."
                        aria-label="Decline this proposal"
                        onClick={() => void window.orbit.answerProposal(proposal.id, "declined")}
                    >
                        <Icon name="close" />
                    </button>
                </div>
            ))}
        </div>
    );
}

/** "All", or one of the five category tags a memory can carry. */
type MemoryFilter = "all" | MemoryNote["category"];

/**
 * The remembered list, filtered.
 *
 * It was every record, newest first, grouped by nothing: at sixty-plus items
 * that is a scroll, not a list, and finding the one memory you want to correct
 * meant reading past fifty you did not. Three filters, applied together:
 * category, a substring of the text, and whether the record was cut short
 * before it was stored.
 *
 * The incomplete test is the same one `orbit_list_memories` marks records
 * with — `endsIncomplete` from `src/shared/memoryText.ts` — rather than a
 * second opinion written for the panel. Those are the records that need
 * rewriting from primary evidence, so being able to ask for just them is the
 * difference between knowing some are broken and being able to fix them.
 *
 * Filter state is local and this component unmounts with the section, so
 * leaving the tab and coming back gives you the whole list again. That is
 * deliberate: a filter you cannot see is a list that is lying to you, and the
 * one place it would be invisible is the moment you arrive.
 */
function MemoryList({ memories }: { memories: readonly MemoryNote[] }): React.JSX.Element {
    const [filter, setFilter] = useState<MemoryFilter>("all");
    const [query, setQuery] = useState("");
    const [incompleteOnly, setIncompleteOnly] = useState(false);

    if (memories.length === 0) {
        return (
            <p className="muted small pad">
                Nothing remembered yet. Tell Orbit a lasting preference and it will write it down.
            </p>
        );
    }

    const counts = new Map<MemoryNote["category"], number>();
    for (const memory of memories) counts.set(memory.category, (counts.get(memory.category) ?? 0) + 1);
    const cut = memories.filter((memory) => endsIncomplete(memory.text)).length;

    const needle = query.trim().toLowerCase();
    const shown = [...memories]
        .reverse()
        .filter((memory) => filter === "all" || memory.category === filter)
        .filter((memory) => !incompleteOnly || endsIncomplete(memory.text))
        .filter((memory) => needle === "" || memory.text.toLowerCase().includes(needle));

    const filtering = filter !== "all" || incompleteOnly || needle !== "";

    return (
        <>
            <div className="memory-filters">
                <button
                    className={filter === "all" ? "memory-chip on" : "memory-chip"}
                    title="Show every remembered item"
                    aria-pressed={filter === "all"}
                    onClick={() => setFilter("all")}
                >
                    all <em>{memories.length}</em>
                </button>
                {MEMORY_CATEGORIES.filter((category) => counts.has(category)).map((category) => (
                    <button
                        key={category}
                        className={filter === category ? "memory-chip on" : "memory-chip"}
                        title={`Show only ${category} memories`}
                        aria-pressed={filter === category}
                        onClick={() => setFilter((current) => (current === category ? "all" : category))}
                    >
                        {category} <em>{counts.get(category)}</em>
                    </button>
                ))}
                {cut > 0 && (
                    <button
                        className={incompleteOnly ? "memory-chip warn on" : "memory-chip warn"}
                        title="Show only memories that were cut short before they were stored"
                        aria-pressed={incompleteOnly}
                        onClick={() => setIncompleteOnly((on) => !on)}
                    >
                        incomplete only <em>{cut}</em>
                    </button>
                )}
            </div>

            <div className="memory-search">
                <input
                    type="search"
                    value={query}
                    placeholder="Filter by text"
                    aria-label="Filter memories by text"
                    onChange={(event) => setQuery(event.target.value)}
                />
            </div>

            {shown.length === 0 ? (
                <p className="muted small pad">
                    No memory matches that.{" "}
                    <button
                        className="link"
                        onClick={() => {
                            setFilter("all");
                            setQuery("");
                            setIncompleteOnly(false);
                        }}
                    >
                        clear filters
                    </button>
                </p>
            ) : (
                <>
                    {filtering && (
                        <p className="muted small pad">
                            {shown.length} of {memories.length} shown
                        </p>
                    )}
                    {shown.map((memory) => (
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
                    ))}
                </>
            )}
        </>
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

/**
 * Everything Orbit lets you set, in one pane.
 *
 * It used to be three appearance controls, and the other ten settings existed
 * only in settings.json. That is a defensible choice for a tool whose user
 * wrote it, and a bad one for a panel that already has a rail section called
 * "look": a section that shows three of thirteen settings is not a smaller
 * settings pane, it is a settings pane that lies about what Orbit can do.
 *
 * Grouped by what the setting is about rather than by control type, in the
 * order they are likely to be wanted: how it looks, what it is allowed to do,
 * where it works, and how long it waits. Everything applies immediately and is
 * written to settings.json, so there is no save button to forget.
 */
function LookTab({ state }: { state: OrbitState }): React.JSX.Element {
    const s = state.settings;
    const set = (patch: Partial<Settings>): void => void window.orbit.setSettings(patch);

    return (
        <div className="deck-list settings">
            <Group title="appearance">
                <Choice label="font">
                    {CHAT_FONTS.map((font) => (
                        <button
                            key={font.id}
                            className={`chip ${s.chatFontFamily === font.id ? "chip-primary" : "chip-neutral"}`}
                            style={{ fontFamily: font.stack }}
                            title={`Set the chat font to ${font.label}`}
                            onClick={() => set({ chatFontFamily: font.id })}
                        >
                            {font.label}
                        </button>
                    ))}
                </Choice>
                <Choice label="size" hint="scales the whole panel, not just the chat">
                    {CHAT_FONT_SIZES.map((size) => (
                        <button
                            key={size}
                            className={`chip ${s.chatFontSize === size ? "chip-primary" : "chip-neutral"}`}
                            title={`Set the chat text size to ${size}`}
                            onClick={() => set({ chatFontSize: size })}
                        >
                            {size}
                        </button>
                    ))}
                </Choice>
                <Choice label="opacity">
                    {[0.6, 0.75, 0.88, 1].map((value) => (
                        <button
                            key={value}
                            className={`chip ${Math.abs(s.panelOpacity - value) < 0.01 ? "chip-primary" : "chip-neutral"}`}
                            title={`Make the panels ${Math.round(value * 100)}% solid`}
                            onClick={() => set({ panelOpacity: value })}
                        >
                            {Math.round(value * 100)}%
                        </button>
                    ))}
                </Choice>
            </Group>

            <Group title="what Orbit may do on its own">
                <Toggle
                    label="approve everything"
                    hint="Runs commands and edits files without asking. The one setting here that can cost you something."
                    on={s.yolo}
                    danger
                    onChange={(yolo) => set({ yolo })}
                />
                <Toggle
                    label="approve reading"
                    hint="Looking at a file changes nothing, so asking about it is mostly noise."
                    on={s.autoApproveReads}
                    onChange={(autoApproveReads) => set({ autoApproveReads })}
                />
                <Toggle
                    label="meeting heads-up"
                    hint="A nudge about five minutes before each calendar meeting. Quiet if no calendar is reachable."
                    on={s.meetingHeadsUp}
                    onChange={(meetingHeadsUp) => set({ meetingHeadsUp })}
                />
            </Group>

            <Group title="where it works">
                <Choice label="model" hint={state.models.length === 0 ? "asking Copilot what it has" : undefined}>
                    {state.models.map((model) => (
                        <button
                            key={model.id}
                            className={`chip ${s.model === model.id ? "chip-primary" : "chip-neutral"}`}
                            title={`Use ${model.name} for Orbit and the agents it starts`}
                            onClick={() => set({ model: model.id })}
                        >
                            {model.name}
                        </button>
                    ))}
                </Choice>
                <TextSetting
                    label="workspace"
                    hint="Where agents are allowed to work unless told otherwise."
                    value={s.workspace}
                    placeholder="~/orbit-workspace"
                    onCommit={(workspace) => set({ workspace })}
                />
                <TextSetting
                    label="workspace repo"
                    hint="Git repository the workspace sync copies output into. Empty uses ~/git/workspace. Sync is skipped if there is no repository there."
                    value={s.workspaceRepo}
                    placeholder="~/git/workspace"
                    onCommit={(workspaceRepo) => set({ workspaceRepo })}
                />
                <TextSetting
                    label="copilot path"
                    hint="Empty means find it automatically. Set it when the CLI lives somewhere Orbit does not think to look."
                    value={s.copilotPath}
                    placeholder="found automatically"
                    onCommit={(copilotPath) => set({ copilotPath })}
                />
            </Group>

            <Group title="how long it waits">
                <Choice
                    label="waiting for you"
                    hint="How long a permission request stands before the agent is told nobody answered."
                >
                    {[0, 5, 15, 30, 60].map((value) => (
                        <button
                            key={value}
                            className={`chip ${s.requestTimeoutMinutes === value ? "chip-primary" : "chip-neutral"}`}
                            title={value === 0 ? "Wait forever" : `Give up after ${value} minutes`}
                            onClick={() => set({ requestTimeoutMinutes: value })}
                        >
                            {value === 0 ? "forever" : `${value}m`}
                        </button>
                    ))}
                </Choice>
                <Choice label="one agent run" hint="A hard cap, so a stuck agent cannot run all night.">
                    {[0, 10, 30, 60, 120].map((value) => (
                        <button
                            key={value}
                            className={`chip ${s.agentTimeoutMinutes === value ? "chip-primary" : "chip-neutral"}`}
                            title={value === 0 ? "No cap" : `Stop an agent after ${value} minutes`}
                            onClick={() => set({ agentTimeoutMinutes: value })}
                        >
                            {value === 0 ? "no cap" : `${value}m`}
                        </button>
                    ))}
                </Choice>
            </Group>

            {/*
             * The thirteenth. It is a remembered position rather than a
             * preference, and there is no control for it because the control is
             * the rail. Named anyway: a settings pane that silently omits one of
             * the things in settings.json is the problem this pane was fixing.
             */}
            <p className="muted small pad">
                Changes apply straight away and are saved to settings.json. The section you were
                last looking at is remembered there too, currently <strong>{s.deckSection}</strong>.
            </p>
        </div>
    );
}

function Group({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
    return (
        <section className="setting-group">
            <h4 className="group-title">{title}</h4>
            {children}
        </section>
    );
}

function Choice({
    label,
    hint,
    children,
}: {
    label: string;
    hint?: string;
    children: React.ReactNode;
}): React.JSX.Element {
    return (
        <div className="setting">
            <span className="setting-label">{label}</span>
            <div className="setting-options">{children}</div>
            {hint && <span className="setting-hint">{hint}</span>}
        </div>
    );
}

function Toggle({
    label,
    hint,
    on,
    danger,
    onChange,
}: {
    label: string;
    hint: string;
    on: boolean;
    danger?: boolean;
    onChange(next: boolean): void;
}): React.JSX.Element {
    return (
        <div className="setting setting-toggle">
            <button
                className={`switch ${on ? "on" : ""} ${danger && on ? "danger" : ""}`}
                role="switch"
                aria-checked={on}
                aria-label={label}
                title={hint}
                onClick={() => onChange(!on)}
            >
                <span className="switch-knob" />
            </button>
            <div className="setting-body">
                <span className="setting-label">{label}</span>
                <span className="setting-hint">{hint}</span>
            </div>
        </div>
    );
}

/**
 * A path or a name. Committed on blur and on Enter rather than on every
 * keystroke: these are written straight to settings.json, and a half-typed path
 * saved thirty times is thirty chances to point the workspace somewhere real
 * and wrong.
 */
function TextSetting({
    label,
    hint,
    value,
    placeholder,
    onCommit,
}: {
    label: string;
    hint: string;
    value: string;
    placeholder: string;
    onCommit(next: string): void;
}): React.JSX.Element {
    const [draft, setDraft] = useState(value);
    useEffect(() => setDraft(value), [value]);
    const commit = (): void => {
        const trimmed = draft.trim();
        if (trimmed !== value) onCommit(trimmed);
    };
    return (
        <div className="setting">
            <span className="setting-label">{label}</span>
            <input
                className="setting-input"
                value={draft}
                placeholder={placeholder}
                spellCheck={false}
                title={hint}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commit}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") setDraft(value);
                }}
            />
            <span className="setting-hint">{hint}</span>
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
