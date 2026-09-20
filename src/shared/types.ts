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

/**
 * What a message is an answer to.
 *
 * Carried on the user's message rather than looked up at render time: the
 * quoted text has to survive the original question scrolling out of the
 * transcript, and it has to survive a restart, so it is stored, not derived.
 */
export interface ReplyRef {
    /** The id of the message being answered. Used to scroll back to it. */
    id: string;
    /** A short quote of the question, already truncated for display. */
    text: string;
}

export interface ChatMessage {
    id: string;
    role: ChatRole;
    text: string;
    kind: ChatKind;
    at: number;
    /** Set when this message answers an earlier one, e.g. a quick-reply chip. */
    replyTo?: ReplyRef;
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
    /**
     * How the last run ended.
     *
     * `blind` is not a kind of `done`. The agent finished and answered, but the
     * answer was "I could not look" — a missing tool, an errored search, an
     * account nobody is signed in to. It is kept apart from `done` because the
     * two must never be treated alike: a watcher that cannot see is not a
     * watcher that saw nothing, and only one of them is reassuring.
     */
    lastStatus?: "done" | "failed" | "cancelled" | "blind";
    /**
     * Consecutive runs that ended `blind`. The first one is worth saying out
     * loud; the thirtieth is the same sentence again, so it is counted and not
     * repeated. Cleared the moment a run can see again.
     */
    blindRuns?: number;
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
     * Days between runs while a dull *daily* watcher is easing off. The daily
     * counterpart of `backoffMinutes`, and kept separate from it because the
     * two cadences stretch along different axes: an interval widens its gap in
     * minutes, a daily keeps its slot and skips whole days to reach it.
     *
     * Absent or 1 means the watcher runs every day, as configured.
     *
     * This exists because for weeks a daily watcher could not ease off at all.
     * `quietRuns` was counted for every cadence and acted on for exactly one of
     * them, so "Tear down Bastion" — a one-off mis-encoded as a daily, whose
     * own brief guaranteed silence on every day but 20 August — sat at ten
     * consecutive quiet runs and still spawned an agent every morning.
     */
    backoffDays?: number;
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
    /**
     * How many times it has been put in front of the user, counting the first.
     * Drives the widening gap between askings: a question ignored five times is
     * asked far less often than one asked once. Absent on items written before
     * the field existed, which are read as having been asked once.
     */
    timesRaised?: number;
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

/** A wording a memory used to carry, kept when the memory was corrected. */
export interface RetiredMemoryText {
    text: string;
    retiredAt: number;
    /** Why it was replaced, in a few words. */
    reason?: string;
}

export interface MemoryNote {
    id: string;
    text: string;
    category: "preference" | "fact" | "routine" | "person" | "project";
    createdAt: number;
    source: "orbit" | "user";
    /** When the text was last corrected, if it ever was. */
    correctedAt?: number;
    /**
     * Wordings this memory used to carry, oldest first. A correction moves the
     * record rather than destroying it, which is what makes correcting safe for
     * an agent when deleting is not.
     */
    priorText?: RetiredMemoryText[];
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
    /**
     * Who this is waiting on, when it is waiting on a person who is not the
     * user. A name, a team, a system: whatever the answer to "who owes us this?"
     * actually is.
     *
     * This exists because "blocked on him" and "blocked on someone else" are the
     * two states he most needs told apart, and nothing in Orbit could tell them
     * apart. Every other signal that might have stood in for it was a guess:
     * matching names out of a description, reading a `stalled` note as if it
     * named a person. A guess presented as a fact is exactly what the board must
     * never do, so this is recorded rather than inferred. Absent on entries
     * written before it existed, and absent whenever nobody has said.
     */
    waitingOn?: string;
    /**
     * When the user last opened this from Orbit, if he ever has.
     *
     * Here because the complaint was not that artifacts are not recorded, it is
     * that the only pointer to one was a path in a chat message that scrolled
     * away. Recording the open is what lets the board say which of the things it
     * made for him he has actually looked at, which is the difference between a
     * list and a useful list.
     *
     * Its honest limit: this is an open *through Orbit*. Opening the same file
     * straight from an editor leaves no trace here, so an absent `openedAt` means
     * "Orbit has not seen you open it", never "you have not read it". Anything
     * built on this has to be labelled accordingly, and is.
     */
    openedAt?: number;
}

/**
 * Which of the five at-a-glance columns a thread belongs in.
 *
 * The set is his, almost verbatim: what is blocked on him, what is running
 * unattended, what is blocked on someone else. `stuck` and `landed` complete it,
 * because "what is stuck" was the third thing he asked to see and a thread that
 * finished an hour ago is neither in flight nor gone.
 *
 * Deliberately not a priority. A lane says where a thread is, and the ordering
 * inside it says what to look at first; conflating the two produced a board
 * where a finished agent outranked a blocked one because it was newer.
 */
export type ThreadLane = "you" | "running" | "others" | "stuck" | "landed";

/** Which store a thread was drawn from. Drives the icon and the click target. */
export type ThreadKind = "agent" | "watcher" | "decision" | "delivery";

/**
 * One parallel thread, whatever store it came from.
 *
 * The four stores the board unifies were each reachable one tool call at a time
 * and invisible in scrollback. This is the flattened shape they share: enough to
 * scan in a narrow panel, with the source ids kept so a row can still act on the
 * real record behind it.
 */
export interface BoardThread {
    /** Stable across refreshes, so a click target does not move underneath. */
    id: string;
    kind: ThreadKind;
    lane: ThreadLane;
    title: string;
    /** One short line under the title. Already written for the width available. */
    detail: string;
    /** The moment this lane's clock runs from: blocked since, running since, landed at. */
    since: number;
    /** Agent hue, so a row matches the mote the user already recognises. */
    hue?: number;
    agentId?: string;
    scheduleId?: string;
    openItemId?: string;
    requestId?: string;
    activityId?: string;
    /**
     * What this thread produced, newest first.
     *
     * On the thread rather than only in a list of its own because a thread has
     * two halves and he needs both: where it got to, and what came out of it. A
     * finished code review whose report cannot be found from the row that
     * describes it is the same problem as one that scrolled out of the chat.
     */
    artifacts?: BoardArtifact[];
}

/**
 * A file Orbit made for him, lifted out of the activity ledger.
 *
 * Not a new store. The ledger already recorded every one of these with its
 * absolute path, the request that prompted it, a day and a status; the failure
 * was purely that the only pointer a human ever saw was a path in a chat message
 * that scrolled away. So this type carries nothing that was not already written
 * down, and adding one changes no persistence.
 */
export interface BoardArtifact {
    /** The activity entry's id. Used to mark it opened, so it must survive a refresh. */
    id: string;
    /** The ledger's one-line description. Written to make sense a month later. */
    title: string;
    /** Absolute path, or a URL. The renderer picks how to open it from this. */
    location: string;
    /** Tail of the path, which is the half worth showing in a narrow panel. */
    shortLocation: string;
    /** True when `location` is a URL rather than something on disk. */
    external: boolean;
    at: number;
    kind: ActivityKind;
    /** What he actually asked for, when the ledger recorded it. */
    request?: string;
    /**
     * Whether Orbit has seen him open it.
     *
     * Deliberately named for what it measures. It is not "unread": he may well
     * have opened the file straight from his editor, and Orbit would never know.
     * Every piece of copy built on this says so.
     */
    opened: boolean;
    /** The thread that produced it, when one still exists on the board. */
    threadId?: string;
}

/**
 * What sort of judgement a call is making.
 *
 * `exposure` is the sharp one: something is about to happen on a timer whether
 * or not he acts. `decay` is something that costs more the longer it sits.
 * `leverage` is the ten-minute question. `anticipation` is what is coming that
 * nobody has asked him about yet.
 */
export type CallKind = "exposure" | "leverage" | "decay" | "anticipation" | "capacity";

/**
 * How much the call can be trusted, and it is always shown.
 *
 * `certain` is reserved for arithmetic on timestamps and on links the data model
 * actually carries: a request belongs to an agent, an agent belongs to a
 * watcher. `likely` is a real signal read slightly beyond what it strictly
 * proves. `guess` is a pattern match on prose.
 *
 * The rule this type exists to enforce: nothing derived from matching text is
 * ever `certain`, and no call ships without a `basis` saying where it came from.
 * A chief of staff who is confidently wrong twice is never listened to again.
 */
export type Confidence = "certain" | "likely" | "guess";

/** One piece of judgement about the board, with its reasoning attached. */
export interface ChiefCall {
    id: string;
    kind: CallKind;
    /** One line, leading with the action. Never a noun phrase. */
    headline: string;
    /** The evidence, rendered as a numbered list. Facts, not adjectives. */
    because: string[];
    confidence: Confidence;
    /** Where the confidence comes from, in one plain sentence. Never empty. */
    basis: string;
    /** Rough minutes to deal with it. Absent when there is no honest number. */
    minutes?: number;
    /** Titles of the threads this frees. Empty when it frees nothing but itself. */
    unblocks: string[];
    /** The thread this is about, when it is about one. */
    threadId?: string;
    /** Orders the list. Not shown: a number next to a judgement invites arguing with the number. */
    weight: number;
}

/**
 * The at-a-glance surface, derived rather than stored.
 *
 * Rebuilt from the live stores on a slow tick, so it has no persistence of its
 * own and cannot drift from what it describes.
 */
export interface Board {
    /** When this was derived. Shown when it is old enough to matter. */
    at: number;
    threads: BoardThread[];
    /** Sorted, highest weight first. The renderer decides how many fit. */
    calls: ChiefCall[];
    /**
     * Everything Orbit has made for him, newest first.
     *
     * On the board rather than behind a tab of its own because there are two
     * ways he goes looking for one of these and only one of them is served by
     * the threads. Sometimes he knows which piece of work produced it, and the
     * thread row is the right place; sometimes he half remembers a document and
     * no more than that, and then only recency helps. Same view, two entrances,
     * no side nav.
     */
    artifacts: BoardArtifact[];
    /**
     * What could not be seen while this was built.
     *
     * The single most dangerous failure mode of a board is a quiet one: an empty
     * lane reads as "all clear" whether it is empty because nothing is wrong or
     * empty because nothing could be looked at. Anything unreadable is named
     * here instead of being silently omitted.
     */
    blindSpots: string[];
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
        /**
         * A revision of Orbit's own operating notes, and an addition to SOUL.md.
         * In the timeline because a prompt that edits itself with no visible
         * trace is the one change nobody could audit from inside the app.
         */
        | "prompt.revised"
        | "soul.appended"
        /**
         * Heads-ups armed for today's meetings, and each one as it fires.
         *
         * Recorded because the feature was otherwise unobservable: arming only
         * reached a console line and the heads-up itself only reached the chat,
         * so "has this ever run against a real calendar?" was unanswerable for
         * the month the calendar was dead and the nineteen days after it.
         */
        | "meeting.armed"
        | "meeting.headsup"
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

/**
 * Geometry as it sits on disk. `v` is what makes a one-time correction to a
 * saved size possible: without it, widening an old narrow window would happen
 * on every launch and would fight anyone who deliberately narrowed it.
 */
export interface SavedWindow extends WindowBounds {
    v?: number;
}

/** Bumped when a saved window needs a one-time correction. */
export const WINDOW_STATE_VERSION = 1;

/**
 * The sections of Mission Control, in rail order.
 *
 * Six, and none of them invented to fill the rail. `read` is the viewer: it is
 * a section rather than a window because a deliverable is one more thing Orbit
 * has for him, and everything else in that category is already a section. `work` is the old `agents`
 * and `watchers` tabs folded together: two stores, one question.
 */
export const DECK_SECTIONS = ["board", "work", "memory", "read", "log", "look"] as const;

export type DeckSection = (typeof DECK_SECTIONS)[number];

export function isDeckSection(value: unknown): value is DeckSection {
    return typeof value === "string" && (DECK_SECTIONS as readonly string[]).includes(value);
}

/**
 * A document read off disk for the in-app viewer.
 *
 * `text` is exactly what was in the file and nothing has been done to it. It is
 * the renderer's job to contain it, because the renderer is where it is put on
 * screen and a sanitising pass here would only give the illusion that it is
 * safe by the time it gets there.
 */
export interface ArtifactDoc {
    ok: boolean;
    /** Absolute, resolved. */
    path: string;
    /** File name, which is all the title there is until the document says otherwise. */
    title: string;
    kind: "html" | "markdown";
    text: string;
    error?: string;
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
    /**
     * Which Mission Control section was last open, so reopening Orbit lands
     * where it was left rather than always on the board. A UI position rather
     * than a preference, but it lives here because settings.json is already
     * the one thing that survives a restart and reaches the renderer whole.
     */
    deckSection: DeckSection;
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
    /**
     * Every parallel thread in one place, plus the judgement about them.
     * Derived in main and pushed whole: the renderer draws it and decides
     * nothing.
     */
    board: Board;
    personaPath: string;
    lastInteractionAt: number;
    /** Transient line the buddy says when the chat is closed. */
    bubble?: { text: string; until: number; requestId?: string };
}

/** Renderer → main commands, exposed on `window.orbit` by the preload script. */
export interface OrbitApi {
    getState(): Promise<OrbitState>;
    onState(cb: (state: OrbitState) => void): () => void;
    /**
     * Send a user turn. `replyToId` names an earlier message this answers — set
     * by a quick-reply chip so the answer is threaded to its question both on
     * screen and in what the model receives.
     */
    send(prompt: string, replyToId?: string): Promise<void>;
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
    /**
     * Record that he opened one of the artifacts on the board.
     *
     * Called alongside `openPath`, not instead of it: opening is the act, this
     * is only the note that it happened. Kept separate so a failure to write the
     * ledger can never stop a file from opening.
     */
    markArtifactOpened(activityId: string): Promise<void>;
    openPersona(): Promise<void>;
    /**
     * Which of these candidate paths actually exist, so a message only offers a
     * click on something that can be opened.
     */
    inspectPaths(paths: string[]): Promise<PathInfo[]>;
    /** Open a file in the user's editor, or a directory in Finder. */
    openPath(path: string): Promise<{ ok: boolean; error?: string }>;
    /** Read a deliverable for the in-app viewer. HTML and markdown only. */
    readArtifact(path: string): Promise<ArtifactDoc>;
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
