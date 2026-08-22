/**
 * The contract between the main-process orchestrator and the renderer.
 * Everything the buddy displays is derived from `OrbitState`.
 */

export type AgentStatus =
    | "queued"
    | "running"
    | "needs-input"
    | "done"
    | "failed"
    | "cancelled";

export type Mood =
    | "napping"
    | "idle"
    | "listening"
    | "thinking"
    | "working"
    | "needsInput"
    | "celebrating"
    | "broken";

/** A decision the agent cannot make on its own. */
export interface PendingRequest {
    id: string;
    agentId: string;
    /** `permission` comes from the CLI's tool gate, `question` from `ask_user`. */
    kind: "permission" | "question";
    title: string;
    detail?: string;
    /** Extra context, e.g. the shell command or file path involved. */
    subject?: string;
    options: Array<{ id: string; label: string; tone: "primary" | "neutral" | "danger" }>;
    allowFreeform: boolean;
    createdAt: number;
}

/** One line in an agent's activity feed. */
export interface AgentStep {
    id: string;
    label: string;
    detail?: string;
    at: number;
    kind: "tool" | "note" | "error";
}

/** A task Orbit delegated to its own Copilot session. */
export interface AgentView {
    id: string;
    sessionId?: string;
    title: string;
    task: string;
    status: AgentStatus;
    model?: string;
    cwd: string;
    /** 0-1, drives the mote colour. */
    hue: number;
    createdAt: number;
    startedAt?: number;
    endedAt?: number;
    lastActivityAt: number;
    /** Number of tool calls made so far — our honest stand-in for "progress". */
    toolCalls: number;
    currentStep?: string;
    steps: AgentStep[];
    result?: string;
    error?: string;
    pendingRequestId?: string;
    /** Set when this agent is a run of a standing watcher. */
    scheduleId?: string;
    inputTokens: number;
    outputTokens: number;
}

export type ChatRole = "user" | "orbit" | "system";

export type ChatKind =
    | { type: "text" }
    | { type: "spawn"; agentIds: string[] }
    | { type: "request"; requestId: string }
    | { type: "completion"; agentId: string }
    | { type: "error" };

/** A one-click reply Orbit offers instead of making the user type. */
export interface ChatChoice {
    /** Short button text. */
    label: string;
    /** Sent verbatim as the user's next message when the chip is clicked. */
    value: string;
}

export interface ChatMessage {
    id: string;
    role: ChatRole;
    text: string;
    kind: ChatKind;
    at: number;
    /** True while Orbit is still streaming this message in. */
    streaming?: boolean;
    /** Resolution label once a request card has been answered. */
    resolvedAs?: string;
    /** Optional one-click replies rendered beneath the bubble. */
    choices?: ChatChoice[];
}

export type RuntimeStatus = "starting" | "ready" | "error";

export type Cadence =
    | { kind: "interval"; minutes: number }
    | { kind: "daily"; time: string }
    | { kind: "once"; at: number };

export interface Schedule {
    id: string;
    title: string;
    task: string;
    cadence: Cadence;
    enabled: boolean;
    createdAt: number;
    nextRunAt: number;
    lastRunAt?: number;
    /**
     * Local calendar day of the last run, `YYYY-MM-DD`. Kept for the record and
     * for reading the file by hand; the once-per-slot guarantee is carried by
     * `lastSlotAt`, not by this. Absent on watchers that have never run.
     */
    lastRunDay?: string;
    /**
     * The daily slot a run actually served, as its local timestamp.
     *
     * Deduping on the calendar day instead of the slot is what stopped a daily
     * watcher from ever running twice in a day — including the case where the
     * first run was a manual nudge hours before the slot, which then swallowed
     * the scheduled run entirely. A run only ever discharges the slot it was
     * fired for. Absent on schedules persisted before this existed and on
     * watchers that have never run for a slot.
     */
    lastSlotAt?: number;
    lastResult?: string;
    lastStatus?: "done" | "failed" | "cancelled";
    runCount: number;
    /** Agent currently executing this schedule, if any. */
    activeAgentId?: string;
    /** Only nudge the user when the agent says something matters. */
    quiet: boolean;
    /**
     * Consecutive runs that found nothing worth saying. Drives the back-off.
     * Absent on schedules persisted before back-off existed.
     */
    quietRuns?: number;
    /**
     * The stretched interval, in minutes, while a dull watcher is easing off.
     * `cadence` always keeps what the user actually asked for, so the original
     * rhythm can be restored the moment the watcher has something to say.
     */
    backoffMinutes?: number;
    /**
     * Retired, but kept. An archived watcher keeps its run history and its last
     * report on disk, stays out of the default list, and never runs again —
     * unlike `enabled: false`, which is a pause the user expects to undo.
     * Absent on schedules persisted before archiving existed.
     */
    archived?: boolean;
    /** When it was archived, by hand or automatically after a one-off fired. */
    archivedAt?: number;
    /**
     * Days this watcher is allowed to run, `0` Sunday through `6` Saturday.
     * Absent means every day.
     *
     * This is deliberately a property rather than a paragraph in the brief. The
     * prose version — "if today is Saturday, respond with exactly: NOTHING TO
     * REPORT" — was pasted by hand into four separate schedules, still spawned
     * an agent and still burned a run to say nothing, and the fifth schedule
     * was always going to be written without it.
     */
    runDays?: number[];
    /**
     * Stay silent while the user is on leave, per the recorded leave periods.
     * Same reasoning as `runDays`: the dates belong in one place that can go
     * stale visibly, not hard-coded into every brief that happens to care.
     */
    skipOnLeave?: boolean;
    /**
     * The one-time migration from prose has already looked at this schedule.
     * Set whether or not it found anything, so a brief the user has since
     * rewritten by hand is never re-derived behind their back.
     */
    suppressionDerived?: boolean;
}

/**
 * A stretch of days the user is away.
 *
 * Held once, centrally, because every watcher that cares about leave used to
 * carry its own copy of the dates in its prompt — four copies of "on leave from
 * 2026-08-21 returning around 2026-09-08", none of which would notice when that
 * became untrue.
 */
export interface LeavePeriod {
    id: string;
    /** Local calendar day, `YYYY-MM-DD`, inclusive. */
    from: string;
    /** Local calendar day, `YYYY-MM-DD`, inclusive. */
    to: string;
    /** Why, in a few words. Shown back to the user when they ask. */
    note?: string;
}

/**
 * A proposal or question that needs the user's decision.
 *
 * Orbit's nightly self-reflection is the motivating case: it surfaces "shall I
 * change X?" once, and if the user is not at the desk that thought is gone.
 * Open items outlive the message they arrived in and get put back in front of
 * the user until they are answered.
 */
export interface OpenItem {
    id: string;
    /** The question or proposal, phrased so it still makes sense a week later. */
    text: string;
    createdAt: number;
    resolved: boolean;
    resolvedAt?: number;
    /** How it was settled, when it was. */
    resolution?: string;
    /** Where it came from — an agent title, a watcher, "self-reflection". */
    source?: string;
    /** Last time it was put back in front of the user. */
    lastRaisedAt?: number;
}

/**
 * How far a self-improvement idea has got.
 *
 * `proposed` is the nightly reflection's output; `approved` means the user said
 * yes but nothing has landed; `shipped` means code exists; `declined` is a no;
 * `superseded` is for an idea a later, better one replaced.
 */
export type ProposalStatus = "proposed" | "approved" | "shipped" | "declined" | "superseded";

/**
 * A self-improvement Orbit has proposed for itself, with state that outlives the
 * prose it was first written in.
 *
 * The nightly self-reflection appends to `~/.copilot/orbit/evolution-log.md`,
 * which is fine to read and useless to query: answering "did we ever ship this?"
 * meant re-reading days of narrative. Proposals carry the same idea as a record,
 * so the startup digest can say what is still open and what already landed.
 */
export interface Proposal {
    id: string;
    /** The proposal in one sentence, standalone enough to make sense in a month. */
    text: string;
    raisedAt: number;
    status: ProposalStatus;
    /** When the status last moved. Absent while it is still just `proposed`. */
    statusChangedAt?: number;
    /** Where it came from — usually "nightly self-reflection". */
    source?: string;
    /** Why it is in this state, in a few words. */
    note?: string;
    /** What shipped it, when something did. */
    shippedIn?: { branch?: string; commit?: string };
    /** Id of the proposal that replaced this one, when superseded. */
    supersededBy?: string;
}

export interface MemoryNote {
    id: string;
    text: string;
    category: "preference" | "fact" | "routine" | "person" | "project";
    createdAt: number;
    source: "orbit" | "user";
}

/**
 * What sort of thing Orbit did on the user's behalf.
 *
 * Coarse on purpose: the point is to be able to answer "what have you made for
 * me?" and "what did you do about X?" months later, not to build a taxonomy.
 */
export type ActivityKind =
    | "artifact_written"
    | "draft_composed"
    | "query_run"
    | "access_checked"
    | "agent_dispatched"
    /** Something done in mail, calendar or Teams on the user's behalf. */
    | "external_action"
    | "other";

/**
 * Where a piece of work got to.
 *
 * `delivered` means the user has it; `awaiting_seshi` means it is sitting with
 * him and nothing can move until he looks; `stalled` means it stopped for a
 * reason neither side chose; `abandoned` means it was dropped deliberately;
 * `done` means finished and closed out.
 */
export type ActivityStatus = "delivered" | "awaiting_seshi" | "stalled" | "abandoned" | "done";

/**
 * One thing Orbit did for the user, kept forever.
 *
 * The complaint that produced this: "I have lost track of everything I have
 * asked for" — files written into a scratch directory, drafts composed, logs
 * checked, all of it visible for one message and then gone. History and the
 * interaction log both record events, but neither can be asked "what is still
 * outstanding?", because neither carries a status that outlives the moment.
 *
 * Overlap with `OpenItem` is real and deliberate for now: an open item is a
 * question *for* the user, a ledger entry is an action *by* Orbit, and an entry
 * in `awaiting_seshi` is the place the two meet. They are chased by separate
 * passes here so that neither is destabilised; unifying them is a later change.
 */
export interface ActivityEntry {
    id: string;
    at: number;
    /** Local calendar day it was created, `YYYY-MM-DD`. Filterable, readable by hand. */
    day: string;
    kind: ActivityKind;
    /** One line, written so it makes sense a month from now. */
    description: string;
    /** Absolute path or URL where the output lives, when there is one. */
    location?: string;
    /** What the user actually asked for — a short quote or paraphrase. */
    request?: string;
    /** Set when the entry came out of a delegated agent. */
    agentId?: string;
    agentTitle?: string;
    status: ActivityStatus;
    /** When the status last moved. Absent while it is still as first recorded. */
    statusChangedAt?: number;
    /** Why it is where it is, in a few words. */
    note?: string;
    /** Last time an unfinished entry was put back in front of the user. */
    lastChasedAt?: number;
    /** How many times it has been chased. Drives the back-off. */
    chaseCount?: number;
}


export interface HistoryEntry {
    id: string;
    at: number;
    kind:
        | "agent.start"
        | "agent.done"
        | "agent.failed"
        | "agent.cancelled"
        | "permission.asked"
        | "permission.answered"
        | "permission.timeout"
        | "schedule.run"
        | "schedule.created"
        | "schedule.updated"
        /** A run the clock skipped: wrong day of the week, or the user is away. */
        | "schedule.skipped"
        | "memory.saved"
        | "open.raised"
        | "open.resolved"
        | "activity.recorded"
        | "activity.updated"
        | "proposal.raised"
        | "proposal.updated"
        | "session.error";
    title: string;
    detail?: string;
    agentId?: string;
    scheduleId?: string;
}

export interface UsageTotals {
    inputTokens: number;
    outputTokens: number;
    agentsRun: number;
    toolCalls: number;
}

/** Panel geometry, persisted so a resize survives a restart. */
export interface WindowBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface Settings {
    /** Directory agents are allowed to work in by default. */
    workspace: string;
    /**
     * Git repository the workspace sync copies agent output into. Empty means
     * "use the default", `~/git/workspace`. `ORBIT_WORKSPACE_REPO` overrides
     * this. Sync is skipped entirely when no git repository is found there.
     */
    workspaceRepo: string;
    model: string;
    /** Approve every tool call without asking. Off by default, for good reason. */
    yolo: boolean;
    /** Auto-approve read-only operations. */
    autoApproveReads: boolean;
    /**
     * Minutes to wait for a human before giving up on a permission request.
     * The agent is told it was denied for lack of an answer so it can adapt
     * instead of hanging forever. 0 disables the timeout.
     */
    requestTimeoutMinutes: number;
    /**
     * Full path to the Copilot CLI. Empty means "find it automatically";
     * set it when the CLI lives somewhere Orbit doesn't think to look.
     */
    copilotPath: string;
    /** Hard cap on a single agent run. 0 disables. */
    agentTimeoutMinutes: number;
    /**
     * How solid the chat panel, speech bubble and pills look, 0.3 - 1.
     * Edit settings.json and it applies immediately, no restart.
     */
    panelOpacity: number;
    /** Id from `CHAT_FONTS`. Anything unknown falls back to the default stack. */
    chatFontFamily: string;
    /**
     * Base chat text size in px. Every other size in the panel is a fixed
     * ratio of this, so one number scales the whole UI.
     */
    chatFontSize: number;
    /**
     * Nudge roughly five minutes before each calendar meeting, with prep
     * matched to the meeting's shape. Needs a calendar tool to be reachable;
     * with none configured it simply finds nothing and stays quiet.
     */
    meetingHeadsUp: boolean;
}

/** A font the user can pick for the chat panel. */
export interface ChatFont {
    id: string;
    label: string;
    /** A full CSS `font-family` value, complete with fallbacks. */
    stack: string;
}

/**
 * Deliberately short, and limited to faces that are either already on macOS or
 * degrade to something sane. Web fonts are not an option: the panel must render
 * the instant it opens, offline.
 */
export const CHAT_FONTS: ChatFont[] = [
    {
        id: "rounded",
        label: "Rounded",
        stack: 'ui-rounded, "SF Pro Rounded", -apple-system, "Segoe UI Variable", "Segoe UI", Inter, system-ui, sans-serif',
    },
    {
        id: "system",
        label: "System UI",
        stack: '-apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
    },
    {
        id: "sf",
        label: "SF Pro",
        stack: '"SF Pro Text", "SF Pro Display", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
    },
    {
        id: "inter",
        label: "Inter",
        stack: 'Inter, "Inter Variable", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
    },
    {
        id: "helvetica",
        label: "Helvetica Neue",
        stack: '"Helvetica Neue", Helvetica, Arial, sans-serif',
    },
    {
        id: "mono",
        label: "Monospace",
        stack: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
    },
];

/** Sizes offered in the pickers. `chatFontSize` itself is only range-clamped. */
export const CHAT_FONT_SIZES = [11, 12, 13, 14, 15, 16, 18];

/** The size every ratio in styles.css is expressed against. */
export const CHAT_FONT_BASE = 13;
export const CHAT_FONT_MIN = 10;
export const CHAT_FONT_MAX = 24;

export function chatFontStack(id: string): string {
    return (CHAT_FONTS.find((font) => font.id === id) ?? CHAT_FONTS[0]).stack;
}

/**
 * What the dictation helper reports while the microphone is open. `waiting` is
 * emitted by the main process, not the helper: it means macOS is probably
 * showing a permission sheet.
 */
export type DictationEvent =
    | { type: "ready"; onDevice?: boolean }
    | { type: "waiting" }
    | { type: "partial"; text: string }
    | { type: "final"; text: string }
    | { type: "cancelled" }
    | { type: "error"; code: string; message: string };

export interface DictationSupport {
    available: boolean;
    onDevice?: boolean;
    /** Why not, phrased for the user, when `available` is false. */
    reason?: string;
}

/** What main knows about a path the renderer found in a message. */
export interface PathInfo {
    /** The path exactly as it appeared in the message, for matching back. */
    raw: string;
    /** Absolute, `~` expanded. Absent when the input was not path-shaped. */
    resolved?: string;
    exists: boolean;
    isDirectory: boolean;
    /**
     * Clicking this shows it in Finder rather than opening it — an app bundle,
     * an installer, anything executable. Opening those would mean running them,
     * which is never what a chip in a chat message should do.
     */
    revealOnly?: boolean;
}

export interface OrbitState {
    runtime: RuntimeStatus;
    runtimeError?: string;
    /** The renderer tells main when the panel is open so it can route nudges. */
    chatOpen: boolean;
    orbitBusy: boolean;
    /** Set while Orbit itself is running tools or thinking. */
    orbitActivity?: string;
    messages: ChatMessage[];
    agents: AgentView[];
    requests: PendingRequest[];
    settings: Settings;
    models: Array<{ id: string; name: string }>;
    schedules: Schedule[];
    /** Stretches the user is away. Watchers that opt in stay quiet through them. */
    leave: LeavePeriod[];
    memories: MemoryNote[];
    /** Decisions still waiting on the user. Resolved ones are dropped. */
    openItems: OpenItem[];
    history: HistoryEntry[];
    usage: UsageTotals;
    personaPath: string;
    lastInteractionAt: number;
    /** Transient line the buddy says when the chat is closed. */
    bubble?: { text: string; until: number; requestId?: string };
}

/** Renderer → main commands, exposed on `window.orbit` by the preload script. */
export interface OrbitApi {
    getState(): Promise<OrbitState>;
    onState(cb: (state: OrbitState) => void): () => void;
    send(prompt: string): Promise<void>;
    abort(): Promise<void>;
    answerRequest(requestId: string, optionId: string, freeform?: string): Promise<void>;
    cancelAgent(agentId: string): Promise<void>;
    clearFinished(): Promise<void>;
    poke(): Promise<void>;
    dismissBubble(): Promise<void>;
    setSettings(patch: Partial<Settings>): Promise<void>;
    chooseWorkspace(): Promise<void>;
    setChatOpen(open: boolean): Promise<void>;
    setScheduleEnabled(id: string, enabled: boolean): Promise<void>;
    /** Retire a watcher without losing it, or bring an archived one back. */
    setScheduleArchived(id: string, archived: boolean): Promise<void>;
    runScheduleNow(id: string): Promise<void>;
    deleteSchedule(id: string): Promise<void>;
    forgetMemory(id: string): Promise<void>;
    /** Mark an outstanding decision as dealt with. */
    resolveOpenItem(id: string): Promise<void>;
    openPersona(): Promise<void>;
    /**
     * Which of these candidate paths actually exist, so a message only offers a
     * click on something that can be opened.
     */
    inspectPaths(paths: string[]): Promise<PathInfo[]>;
    /** Open a file in the user's editor, or a directory in Finder. */
    openPath(path: string): Promise<{ ok: boolean; error?: string }>;
    /** Show a path in Finder with the item selected. */
    revealPath(path: string): Promise<{ ok: boolean; error?: string }>;
    /** Open an http(s) link in the user's browser. Other schemes are refused. */
    openUrl(url: string): Promise<{ ok: boolean; error?: string }>;
    moveWindow(dx: number, dy: number): Promise<void>;
    /**
     * Grow or shrink the panel by dragging its top-left grip. The window's
     * bottom-right corner stays put so the buddy never moves under the cursor.
     */
    resizeWindow(dx: number, dy: number): Promise<void>;
    /** Relaunch the app to pick up code changes, keeping the conversation. */
    softRestart(): Promise<void>;
    /** Click-through everywhere except the buddy and its panels. */
    setIgnoreMouse(ignore: boolean): Promise<void>;
    /** Can this Mac dictate? Answered without opening the microphone. */
    dictationSupport(): Promise<DictationSupport>;
    /** Open the microphone. Progress arrives through `onDictation`. */
    startDictation(): Promise<void>;
    /** Finish the utterance and keep what was heard. */
    stopDictation(): Promise<void>;
    /** Throw the utterance away. */
    cancelDictation(): Promise<void>;
    onDictation(cb: (event: DictationEvent) => void): () => void;
    quit(): Promise<void>;
}

export const AGENT_TERMINAL: AgentStatus[] = ["done", "failed", "cancelled"];

export function isLive(agent: AgentView): boolean {
    return !AGENT_TERMINAL.includes(agent.status);
}
