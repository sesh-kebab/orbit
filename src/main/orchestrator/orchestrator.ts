import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
    CopilotClient,
    RuntimeConnection,
    ToolSet,
    defineTool,
    type CopilotSession,
    type GetAuthStatusResponse,
    type MCPServerConfig,
    type PermissionRequestResult,
    type Tool,
} from "@github/copilot-sdk";
import { z } from "zod";
import type {
    ActivityEntry,
    ActivityStatus,
    AgentView,
    Cadence,
    ChatKind,
    ChatMessage,
    HistoryEntry,
    LeavePeriod,
    MemoryNote,
    OrbitState,
    OpenItem,
    PendingRequest,
    Proposal,
    ProposalStatus,
    ReplyRef,
    Schedule,
    Settings,
} from "../../shared/types.js";
import { isLive } from "../../shared/types.js";
import {
    ACTIVITY_LIMIT,
    activityChaseBlock,
    activityContextBlock,
    chaseableActivity,
    filterActivity,
    makeActivityEntry,
    type ActivityFilter,
    type ActivityInput,
} from "../activity.js";
import { loadMcpServers } from "../mcp.js";
import {
    capabilityOf,
    dueForRetryAmong,
    gaveUpMessage,
    noteAttempt,
    noteFailure,
    noteRecovery,
    recoveredMessage,
    unavailableMessage,
    type McpHealth,
} from "../mcpHealth.js";
import type { InteractionRecord, LoggedToolCall, Persistence, SessionSnapshot } from "../persistence.js";
import { findCopilotCli, missingCliMessage } from "../runtime.js";
import type { Store } from "../store.js";
import { AgentRunner } from "./agentRunner.js";
import { selectAgentTools } from "./agentTools.js";
import { artifactPathsIn, artifactSearchDirs, resolveArtifactPaths } from "./artifacts.js";
import { parseChoices, stripChoicesForStream } from "./choices.js";
import { buildReplyPrompt, quoteQuestion } from "./replies.js";
import { clip, elapsed, summarise } from "./describe.js";
import { evolutionBlock, parseEvolutionLog, type EvolutionEntry } from "./evolution.js";
import {
    ACTIVE_RESCAN_MS,
    CALENDAR_SCAN_TEMPLATE,
    armableMeetings,
    calendarUnavailableMessage,
    classifyMeeting,
    headsUpAt,
    headsUpLine,
    inQuietHours,
    nextCalendarScanDelay,
    prepBriefFor,
    quietWindowEnd,
    readMeetingPlan,
    wantsPrep,
    type CalendarProblem,
    type Meeting,
    type MeetingPlan,
} from "./meetings.js";
import { MCP_TOOLS_RULE, ORBIT_PERSONA } from "./persona.js";
import {
    checkRevision,
    nextRevision,
    revisionText,
    selfPromptBlock,
    type PromptRevision,
} from "./selfPrompt.js";
import { needsSoulStep, soulBlock, soulEntry, withSoulStep } from "./soul.js";
import { checkDesignRevision } from "./design.js";
import { correctMemory as applyMemoryCorrection, type MemoryCorrection } from "./memory.js";
import { deriveBoard } from "./board.js";
import { describeMiss, findById } from "./ids.js";
import {
    SILENCE_AFFORDANCE,
    SILENCE_TOKEN,
    decideInterrupt,
    isSilence,
} from "./attention.js";
import {
    OPEN_ITEM_CAP,
    OPEN_ITEM_GUIDANCE,
    describeChasing,
    noteRaised,
    selectForReRaise,
    selectOutstanding,
} from "./openItems.js";
import {
    DAILY_BRIEF_TEMPLATE,
    catchUpDecision,
    clearBackoff,
    clearBlindRuns,
    blindReason,
    describeCadence,
    describeSchedule,
    dormancyAllows,
    isArchived,
    isBackedOff,
    isCouldNotCheck,
    isNothingToReport,
    isRunnable,
    isValidTime,
    localDay,
    makeSchedule,
    nextAllowedRunFor,
    noteBlindRun,
    noteQuietRun,
    previousRunBlock,
    ranSlot,
    retirementCase,
} from "./schedules.js";
import { describeSync, shouldAutoSync, syncWorkspace, workspaceRepoPath } from "../workspace.js";
import {
    deriveSuppression,
    describeSuppression,
    isDayKey,
    makeLeavePeriod,
    onLeave,
    parseRunDays,
    suppressionAt,
} from "./suppression.js";
import { FRESHNESS_TAG, decideAutoRestart, decideFreshnessAction } from "../freshness.js";
import type { Freshness } from "../freshness.js";

/** Distinguishes 'not installed' from a runtime that started and then failed. */
class MissingCliError extends Error {}

const MAX_LIVE_AGENTS = 8;
const BUBBLE_MS = 9000;
/** Golden angle keeps consecutive agent colours far apart. */
const HUE_STEP = 0.618033988749895;
/** Long enough for Orbit's "I'm restarting" reply to finish streaming. */
const RESTART_GRACE_MS = 2500;

interface PendingResolver {
    resolve(answer: { optionId: string; freeform?: string }): void;
}

/**
 * Owns the Copilot runtime, Orbit's own conversation, and every delegated
 * agent. This is the only place that talks to the SDK.
 */
export class Orchestrator {
    private client: CopilotClient | undefined;
    private orbit: CopilotSession | undefined;
    private readonly runners = new Map<string, AgentRunner>();
    private readonly resolvers = new Map<string, PendingResolver>();
    private readonly timers = new Map<string, NodeJS.Timeout | undefined>();
    private hueCursor = Math.random();
    private streamingMessageId: string | undefined;
    /** Raw stream text, kept so a half-typed choice marker never shows. */
    private streamingRaw = "";
    private updateQueue: string[] = [];
    private updateTimer: NodeJS.Timeout | undefined;
    /**
     * How many turns Orbit has taken since the user last said anything, and
     * when the last of them went out. The pair the chase loops throttle on: see
     * `attention.ts` for why per-item back-off could not see this.
     */
    private unansweredTurns = 0;
    private lastProactiveAt: number | undefined;
    /**
     * Nudges in a row that Orbit answered with the silence token, and when the
     * last nudge went out. The second axis the chase loops throttle on: a turn
     * that is dropped advances `unansweredTurns` by nothing, so without this a
     * loop producing only silence never slows down. See `attention.ts`.
     */
    private fruitlessNudges = 0;
    private lastNudgeAt: number | undefined;
    /** Pending staggered catch-up runs, so a shutdown can call them off. */
    private readonly catchUpTimers = new Set<NodeJS.Timeout>();
    /**
     * Agents Orbit spawned for its own bookkeeping rather than for the user.
     * Their reports go to the handler that asked for them and never reach the
     * chat, which is what keeps a background calendar scan out of the way.
     */
    private readonly internalAgents = new Map<string, (agent: AgentView) => void>();
    /** Armed per-meeting heads-ups, keyed by meeting id. */
    private readonly meetingTimers = new Map<string, NodeJS.Timeout>();
    /**
     * Today's remaining meetings, as last scanned. Held because the board needs
     * to know what is coming, and the armed timers only cover the next few
     * hours.
     */
    private meetings: Meeting[] = [];
    /** Local day the current meeting plan was built for. */
    private meetingPlanDay: string | undefined;
    /** True while the calendar scan agent is out, so only one ever is. */
    private scanningCalendar = false;
    private mcpServers: Record<string, MCPServerConfig> = {};
    /**
     * Tools called since the last logged Orbit reply, keyed by tool call id so
     * the completion event can fill in how each one actually went.
     */
    private readonly turnTools = new Map<string, LoggedToolCall>();

    private tickCount = 0;
    private persona = "";
    /**
     * Orbit's own operating notes, and the append-only history behind them.
     * Held here for the same reason the persona is: the prompt is assembled at
     * session start, so a revision made mid-session is on disk immediately and
     * in the prompt at the next one.
     */
    private selfPrompt = "";
    private promptRevisions: PromptRevision[] = [];
    /** Who Orbit has become from working with this person. Append-only. */
    private soul = "";
    /**
     * How deliverables look. Not part of Orbit's own prompt: it is handed to
     * agents, because they are the ones that write documents.
     */
    private designLanguage = "";
    private designRevisions: PromptRevision[] = [];
    /**
     * Orbit's own development history. Not part of `OrbitState`: the renderer
     * has nothing to draw with it, and it only matters while a system message is
     * being assembled. Re-read on every session build so a reflection that ran
     * since launch is picked up without a restart.
     */
    private proposals: Proposal[] = [];
    /**
     * The activity ledger. Held here rather than in `OrbitState` for the same
     * reason as proposals: the renderer has nothing to draw with it, and it is
     * only read when a prompt is being assembled or a tool asks for it.
     */
    private activity: ActivityEntry[] = [];
    /** Conversation carried across a soft restart, if there was one. */
    private restored: SessionSnapshot | undefined;
    /**
     * Set by the main process. Relaunching is the main process's job — the
     * orchestrator only decides when the conversation is safe to park.
     */
    onSoftRestart: (() => void) | undefined;
    /** Guards against a second restart being queued while one is pending. */
    private restarting = false;
    /**
     * Whether the running code matches the written code. Supplied by the main
     * process, which is the only part that knows where the repo is on disk.
     */
    freshness: Freshness | undefined;
    /**
     * Re-measures the above. Supplied by the main process, which is the only
     * part that knows where the repo is on disk, and called on a slow timer so
     * a build that lands under a running process is actually noticed.
     */
    freshnessProbe: (() => Freshness | undefined) | undefined;

    constructor(
        private readonly store: Store,
        private readonly disk: Persistence,
    ) {}

    // MARK: - Lifecycle

    async start(): Promise<void> {
        this.persona = this.disk.loadPersona();
        this.selfPrompt = this.disk.loadSystemPrompt();
        this.promptRevisions = this.disk.loadPromptRevisions();
        this.soul = this.disk.loadSoul();
        this.designLanguage = this.disk.loadDesignLanguage();
        this.designRevisions = this.disk.loadDesignRevisions();
        this.proposals = this.disk.loadProposals();
        this.activity = this.disk.loadActivity();
        this.store.update((state) => {
            state.schedules = this.disk.loadSchedules();
            state.leave = this.disk.loadLeave();
            state.memories = this.disk.loadMemories();
            state.openItems = this.disk.loadOpenItems();
            state.history = this.disk.loadHistory();
            state.personaPath = this.disk.personaPath;
        });
        this.migrateSuppression();
        this.teachReflectionAboutSoul();
        this.reconcileFreshness();

        // Must happen before the session is created: the restored transcript is
        // folded into the system message so the model comes back with context.
        this.restored = this.restoreSession();

        try {
            const settings = this.settings;

            // Orbit ships without the runtime, so the CLI has to be located
            // before the client is built; see src/main/runtime.ts.
            const cli = await findCopilotCli(settings.copilotPath);
            if (!cli.path) throw new MissingCliError();
            console.log(`[orbit] using Copilot CLI at ${cli.path} (found via ${cli.source})`);

            this.client = new CopilotClient({
                logLevel: "error",
                workingDirectory: settings.workspace,
                connection: RuntimeConnection.forStdio({ path: cli.path }),
            });
            await this.client.start();
            await this.requireAuth();
            this.mcpServers = loadMcpServers();

            const models = await this.safeListModels();
            this.orbit = await this.createOrbitSession();

            this.store.update((state) => {
                state.runtime = "ready";
                state.runtimeError = undefined;
                state.models = models;
            });
            this.store.flush();
            this.say(this.greeting());
            this.catchUpSchedules();
            this.ensureMeetingPlan();
        } catch (error) {
            const message =
                error instanceof MissingCliError
                    ? missingCliMessage()
                    : error instanceof Error
                      ? error.message
                      : String(error);
            this.store.update((state) => {
                state.runtime = "error";
                state.runtimeError = message;
            });
            this.store.flush();
        }
    }

    async stop(): Promise<void> {
        if (this.updateTimer) clearTimeout(this.updateTimer);
        for (const timer of this.catchUpTimers) clearTimeout(timer);
        this.catchUpTimers.clear();
        this.clearMeetingTimers();
        this.internalAgents.clear();
        for (const resolver of this.resolvers.values()) {
            resolver.resolve({ optionId: "deny" });
        }
        this.resolvers.clear();
        await Promise.allSettled([...this.runners.values()].map((runner) => runner.cancel()));
        this.runners.clear();
        try {
            await this.orbit?.disconnect();
        } catch {
            /* ignore */
        }
        try {
            await this.client?.stop();
        } catch {
            /* ignore */
        }
    }

    private get settings(): Settings {
        return this.store.get().settings;
    }

    /**
     * Resolve authentication before any session is created. Sessions built
     * against an unauthenticated runtime are accepted at creation time and only
     * fail later, on the first message, with "Session was not created with
     * authentication info or custom provider" — so check up front and fail with
     * something the user can act on.
     */
    private async requireAuth(): Promise<void> {
        let status: GetAuthStatusResponse;
        try {
            status = await this.client!.getAuthStatus();
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Could not check GitHub Copilot sign-in status: ${detail}`);
        }
        if (!status.isAuthenticated) {
            throw new Error(
                "Not signed in to GitHub Copilot. Run `copilot` and then `/login`, " +
                    "or sign in with `gh auth login`, then restart Orbit.",
            );
        }
    }

    private async safeListModels(): Promise<Array<{ id: string; name: string }>> {
        try {
            const models = await this.client!.listModels();
            return models
                .filter((model) => model.policy?.state !== "disabled")
                .map((model) => ({ id: model.id, name: model.name ?? model.id }));
        } catch {
            return [];
        }
    }

    private async createOrbitSession(): Promise<CopilotSession> {
        const settings = this.settings;
        // A new session spawns new server processes, so it is a new race and
        // deserves a full set of attempts. Carrying a previous session's verdict
        // across — `applySettings` rebuilds the session on a model change —
        // would mean a server that gave up an hour ago is never tried again.
        this.mcpHealth.clear();
        this.reconnectingMcp = undefined;
        return this.client!.createSession({
            model: settings.model === "auto" ? undefined : settings.model,
            workingDirectory: settings.workspace,
            streaming: true,
            mcpServers: this.mcpServers,
            systemMessage: {
                mode: "customize",
                sections: { identity: { action: "replace", content: this.buildSystemMessage() } },
            },
            // Orbit is a pure orchestrator: no file or shell tools, so it can't
            // quietly start doing the work itself. MCP is the exception — those
            // servers are how it reads mail, work items and telemetry directly,
            // which is context for delegating rather than a way to do the job.
            availableTools: new ToolSet().addCustom("*").addMcp("*"),
            onPermissionRequest: (): PermissionRequestResult => ({ kind: "approve-once" }),
            tools: this.orbitTools(),
        }).then((session) => {
            this.wireOrbit(session);
            return session;
        });
    }

    /**
     * Whether anything MCP is configured at all. Several behaviours only make
     * sense once there is an outside tool to reach for, and a fresh install has
     * none.
     */
    private hasMcpServers(): boolean {
        return Object.keys(this.mcpServers).length > 0;
    }

    /**
     * Orbit's prompt is assembled fresh each session: the built-in persona, the
     * user's editable persona.md, whatever Orbit has chosen to remember, and the
     * current watcher list. This is the "personality that accretes" mechanism.
     */
    private buildSystemMessage(): string {
        const parts = [ORBIT_PERSONA];
        const state = this.store.get();

        if (this.hasMcpServers()) parts.push(MCP_TOOLS_RULE);

        if (this.persona) {
            parts.push(`<user_authored_personality>\n${this.persona}\n</user_authored_personality>`);
        }

        // Orbit's own notes, and the floor restated under them. The two are
        // assembled together on purpose: see `selfPrompt.ts`.
        const self = selfPromptBlock(this.selfPrompt);
        if (self) parts.push(self);

        // Character, next to the personality it grew out of. Read fresh every
        // session so a reflection that wrote an hour ago is already in context.
        const soul = soulBlock(this.soul);
        if (soul) parts.push(soul);

        const restored = this.restoredContext();
        if (restored) parts.push(restored);

        if (state.memories.length > 0) {
            const lines = state.memories
                .slice(-60)
                .map((memory) => `- [${memory.category}] ${memory.text}`)
                .join("\n");
            parts.push(
                `<remembered>\nThings you have learned about this user. Treat them as true unless corrected.\n${lines}\n</remembered>`,
            );
        }

        const watchers = state.schedules.filter((schedule) => isRunnable(schedule));
        if (watchers.length > 0) {
            const lines = watchers
                .map((schedule) => `- "${schedule.title}" (${describeSchedule(schedule)}) id=${schedule.id}`)
                .join("\n");
            parts.push(`<active_watchers>\n${lines}\n</active_watchers>`);
        }

        const openItems = this.outstandingItems();
        if (openItems.length > 0) parts.push(this.openItemsBlock(openItems));

        // What has actually been produced for the user, so "what have you made
        // for me?" is answerable without a tool call. Capped inside.
        const ledger = activityContextBlock(this.activity);
        if (ledger) parts.push(ledger);

        const evolution = this.evolutionDigest();
        if (evolution) parts.push(evolution);

        const freshness = this.freshnessBlock();
        if (freshness) parts.push(freshness);

        parts.push(
            `<environment>\nWorkspace: ${state.settings.workspace}\nLocal time: ${new Date().toLocaleString()}\n</environment>`,
        );

        return parts.join("\n\n");
    }

    private greeting(): string {
        if (this.restored) {
            const interrupted = this.restored.interrupted.length;
            if (interrupted > 0) {
                const names = this.restored.interrupted.map((a) => `"${a.title}"`).join(", ");
                return `Back, with the conversation intact. ${interrupted} agent${
                    interrupted === 1 ? "" : "s"
                } didn't survive the restart (${names}) — say the word and I'll start ${
                    interrupted === 1 ? "it" : "them"
                } again.`;
            }
            return "Back, running the new code, conversation intact. Carry on.";
        }
        const watchers = this.store.get().schedules.filter((s) => isRunnable(s)).length;
        if (watchers > 0) {
            return `Back online, ${watchers} watcher${watchers === 1 ? "" : "s"} still on duty. What do you need?`;
        }
        return "I'm awake and wired into your Copilot. Tell me what you want done and I'll throw agents at it.";
    }

    // MARK: - Soft restart

    /**
     * Park the conversation so the next launch can pick it up. Live agents die
     * with the process — their sessions belong to a CLI subprocess we're about
     * to kill — so they're recorded as interrupted rather than pretended away.
     */
    snapshotSession(): void {
        const state = this.store.get();
        this.disk.saveSessionSnapshot({
            at: Date.now(),
            messages: state.messages.filter((message) => !message.streaming),
            usage: state.usage,
            lastInteractionAt: state.lastInteractionAt,
            interrupted: state.agents
                .filter(isLive)
                .map((agent) => ({ title: agent.title, task: agent.task, cwd: agent.cwd })),
        });
    }

    /** Pull a parked conversation back into the store. Returns it for the greeting. */
    private restoreSession(): SessionSnapshot | undefined {
        const snapshot = this.disk.takeSessionSnapshot();
        if (!snapshot) return undefined;

        this.store.update((state) => {
            state.messages = snapshot.messages;
            state.usage = snapshot.usage ?? state.usage;
            state.lastInteractionAt = snapshot.lastInteractionAt ?? Date.now();
        });
        console.log(`[orbit] restored ${snapshot.messages.length} messages across a restart`);
        return snapshot;
    }

    /**
     * The restored transcript, rendered for the new session's system message.
     * The SDK session is brand new after a relaunch, so without this Orbit
     * would see the old messages on screen but remember none of them.
     */
    private restoredContext(): string | undefined {
        if (!this.restored || this.restored.messages.length === 0) return undefined;

        const lines = this.restored.messages
            .slice(-30)
            .filter((message) => message.text.trim().length > 0)
            .map((message) => `${message.role}: ${clip(message.text, 600)}`)
            .join("\n");
        if (!lines) return undefined;

        const parts = [
            "You were just restarted to pick up new code. This is the conversation " +
                "you were already having — it is still on screen, so continue it rather " +
                "than greeting the user as if they were new.",
            lines,
        ];

        if (this.restored.interrupted.length > 0) {
            const tasks = this.restored.interrupted
                .map((agent) => `- "${agent.title}" in ${agent.cwd}: ${clip(agent.task, 300)}`)
                .join("\n");
            parts.push(
                "These agents were killed mid-run by the restart. Do not assume they " +
                    "finished. Offer to respawn them if they still matter:\n" +
                    tasks,
            );
        }

        return `<restored_conversation>\n${parts.join("\n\n")}\n</restored_conversation>`;
    }

    /**
     * Park the conversation and ask the main process to relaunch. Main-process
     * edits can't be hot-reloaded, so this is a real process restart — the
     * snapshot is what makes it feel like a reload instead of a reset.
     *
     * The grace period exists because Orbit usually calls this mid-turn: the
     * reply explaining the restart is still streaming, and the snapshot is
     * taken at the end of the wait so that reply survives too.
     */
    softRestart(): void {
        if (!this.onSoftRestart || this.restarting) return;
        this.restarting = true;
        this.pushMessage({
            role: "system",
            text: "Restarting to pick up code changes — the conversation is being kept.",
            kind: { type: "text" },
        });
        this.store.flush();
        setTimeout(() => {
            this.snapshotSession();
            this.onSoftRestart?.();
        }, RESTART_GRACE_MS);
    }

    // MARK: - Orbit's toolbox

    private orbitTools() {
        return [
            defineTool("orbit_spawn_agent", {
                description:
                    "Delegate a task to a background agent with full tool access. Returns immediately with an agent id; the agent keeps working after you reply. You will be notified when it finishes. Use one agent per genuinely independent task.",
                skipPermission: true,
                parameters: z.object({
                    title: z
                        .string()
                        .describe("Very short label for the UI, 2-5 words, e.g. 'Audit auth module'"),
                    task: z
                        .string()
                        .describe(
                            "Complete standalone brief. The agent cannot see this conversation, so state the goal, any relevant paths, and what done looks like.",
                        ),
                    cwd: z
                        .string()
                        .optional()
                        .describe("Absolute directory to work in. Defaults to the user's workspace."),
                }),
                handler: async ({ title, task, cwd }) => this.spawnAgent(title, task, cwd),
            }),

            defineTool("orbit_list_agents", {
                description:
                    "List every agent you have dispatched with its current status, so you can report holistically on what is in flight.",
                skipPermission: true,
                parameters: z.object({}),
                handler: async () => ({
                    agents: this.store.get().agents.map((agent) => ({
                        agentId: agent.id,
                        title: agent.title,
                        status: agent.status,
                        currentStep: agent.currentStep,
                        toolCalls: agent.toolCalls,
                        ageSeconds: Math.round((Date.now() - agent.createdAt) / 1000),
                        result: agent.result ? clip(agent.result, 160) : undefined,
                    })),
                }),
            }),

            defineTool("orbit_agent_details", {
                description:
                    "Get the full activity log and final report for one agent. Use this when the user asks what an agent actually did or found.",
                skipPermission: true,
                parameters: z.object({ agentId: z.string() }),
                handler: async ({ agentId }) => {
                    const agent = this.findAgent(agentId);
                    if (!agent) return { error: `No agent with id ${agentId}` };
                    return {
                        title: agent.title,
                        task: agent.task,
                        status: agent.status,
                        cwd: agent.cwd,
                        toolCalls: agent.toolCalls,
                        steps: agent.steps.map((step) => `${step.kind}: ${step.label}`),
                        result: agent.result,
                        error: agent.error,
                    };
                },
            }),

            defineTool("orbit_message_agent", {
                description:
                    "Send a follow-up instruction to an agent that is still running. Use this to redirect or add detail rather than spawning a duplicate agent.",
                skipPermission: true,
                parameters: z.object({ agentId: z.string(), message: z.string() }),
                handler: async ({ agentId, message }) => {
                    const runner = this.runners.get(agentId);
                    if (!runner) return { error: `Agent ${agentId} is not running.` };
                    await runner.message(message);
                    return { ok: true };
                },
            }),

            defineTool("orbit_soft_restart", {
                description:
                    "Restart Orbit to load its own newly built code, keeping this conversation. Use only after an agent has reported that it built a change to Orbit's source, or when the user asks you to restart or reload yourself. The app comes straight back; agents still running are killed and must be respawned.",
                skipPermission: true,
                parameters: z.object({
                    reason: z
                        .string()
                        .describe("One short line on what change is being picked up."),
                }),
                handler: async ({ reason }) => {
                    if (!this.onSoftRestart) {
                        return { error: "Restarting isn't wired up in this build." };
                    }
                    const live = this.store.get().agents.filter(isLive).length;
                    console.log(`[orbit] soft restart requested: ${reason}`);
                    this.softRestart();
                    return {
                        ok: true,
                        restarting: true,
                        interruptedAgents: live,
                        note: "Tell the user you are restarting now; you will come back with this conversation intact.",
                    };
                },
            }),

            defineTool("orbit_cancel_agent", {
                description: "Stop an agent that is no longer needed.",
                skipPermission: true,
                parameters: z.object({ agentId: z.string() }),
                handler: async ({ agentId }) => {
                    await this.cancelAgent(agentId);
                    return { ok: true };
                },
            }),

            defineTool("orbit_schedule_task", {
                description:
                    "Create a standing watcher that runs a task on a schedule — hourly checks, a daily briefing, a one-off reminder. Use this whenever the user says 'keep an eye on', 'every morning', 'check every hour', or 'remind me'. The task runs as a fresh agent each time.",
                skipPermission: true,
                parameters: z.object({
                    title: z.string().describe("Short label, 2-5 words."),
                    task: z
                        .string()
                        .describe(
                            "Complete standalone brief run on every tick. Say what to check, what counts as noteworthy, and what to report.",
                        ),
                    everyMinutes: z
                        .number()
                        .optional()
                        .describe("Run repeatedly on this interval. Minimum 5."),
                    dailyAt: z
                        .string()
                        .optional()
                        .describe("Run once a day at this 24h local time, e.g. '08:30'."),
                    onceInMinutes: z.number().optional().describe("Run a single time after this delay."),
                    quiet: z
                        .boolean()
                        .optional()
                        .describe(
                            "True for background monitors that should only interrupt the user when the report actually matters. Default false.",
                        ),
                    runDays: z
                        .array(z.string())
                        .optional()
                        .describe(
                            "Days it may run, e.g. ['mon','tue','wed','thu','fri'] for weekdays only. Omit for every day. Set this instead of writing 'if today is Saturday, say NOTHING TO REPORT' into the brief: a watcher barred by this property does not spawn an agent at all.",
                        ),
                    skipOnLeave: z
                        .boolean()
                        .optional()
                        .describe(
                            "True to stay silent while the user is on leave, using the recorded leave dates. Prefer this over putting the dates in the brief, where they go stale unnoticed.",
                        ),
                }),
                handler: async (input) => this.createSchedule(input),
            }),

            defineTool("orbit_daily_briefing", {
                description:
                    "Set up (or move) the start-of-day executive summary. Uses a purpose-built briefing template, so prefer this over orbit_schedule_task for daily summaries.",
                skipPermission: true,
                parameters: z.object({
                    dailyAt: z.string().describe("24h local time, e.g. '08:30'."),
                    extra: z
                        .string()
                        .optional()
                        .describe("Anything specific the user wants included every morning."),
                }),
                handler: async ({ dailyAt, extra }) => {
                    const existing = this.store
                        .get()
                        .schedules.find(
                            (schedule) => schedule.title === "Daily briefing" && !isArchived(schedule),
                        );
                    if (existing) this.removeSchedule(existing.id);
                    return this.createSchedule({
                        title: "Daily briefing",
                        task: extra ? `${DAILY_BRIEF_TEMPLATE}\n\nAlso always include: ${extra}` : DAILY_BRIEF_TEMPLATE,
                        dailyAt,
                        quiet: false,
                    });
                },
            }),

            defineTool("orbit_list_schedules", {
                description:
                    "List the standing watchers and what they last reported. A watcher that keeps finding nothing eases off on its own; the cadence shown says so, and it snaps back the moment it has news. Archived watchers — including one-offs that have already fired — are left out unless asked for.",
                skipPermission: true,
                parameters: z.object({
                    includeArchived: z
                        .boolean()
                        .optional()
                        .describe(
                            "True to also return retired watchers and their last reports. Default false.",
                        ),
                }),
                handler: async ({ includeArchived }) => ({
                    schedules: this.store
                        .get()
                        .schedules.filter((schedule) => includeArchived || !isArchived(schedule))
                        .map((schedule) => ({
                            scheduleId: schedule.id,
                            title: schedule.title,
                            cadence: describeSchedule(schedule),
                            silence: describeSuppression(schedule) || undefined,
                            enabled: schedule.enabled,
                            archived: isArchived(schedule),
                            runCount: schedule.runCount,
                            quietRuns: schedule.quietRuns ?? 0,
                            backedOff: isBackedOff(schedule),
                            nextRun: isRunnable(schedule)
                                ? new Date(schedule.nextRunAt).toLocaleString()
                                : undefined,
                            lastResult: schedule.lastResult ? clip(schedule.lastResult, 200) : undefined,
                        })),
                }),
            }),

            defineTool("orbit_archive_schedule", {
                description:
                    "Retire a watcher that has stopped being worth running. It keeps its run history and its last report, drops out of the list and never runs again; the user can bring it back. Only works on a watcher that has earned it: one that already fired, one already paused, or one that has come back with nothing several runs running. A watcher still reporting real news is refused, so file an open item for the user instead.",
                skipPermission: true,
                parameters: z.object({
                    scheduleId: z.string().describe("From orbit_list_schedules."),
                    reason: z
                        .string()
                        .describe(
                            "Why it is being retired, in one sentence, for the record. Say what evidence made it dead, not just that it was quiet.",
                        ),
                }),
                handler: async ({ scheduleId, reason }) => {
                    const target = this.store.get().schedules.find((s) => s.id === scheduleId);
                    if (!target) return { error: "No watcher with that id." };

                    // The guard, not a formality: this tool is the one thing in
                    // the agent allowlist that changes what Orbit runs, and the
                    // predicate is what keeps it from being a way to switch off
                    // a watcher that is doing its job.
                    const verdict = retirementCase(target);
                    if (!verdict.retirable) {
                        return {
                            error: `Not retiring "${target.title}" because ${verdict.because}.`,
                            hint: "Raise it with orbit_raise_open_item and let the user decide.",
                        };
                    }

                    this.store.update((state) => {
                        const schedule = state.schedules.find((s) => s.id === scheduleId);
                        if (!schedule) return;
                        schedule.archived = true;
                        schedule.archivedAt = Date.now();
                        schedule.archivedReason = reason;
                    });
                    this.persistSchedules();

                    const updated = this.store.get().schedules.find((s) => s.id === scheduleId);
                    if (!updated) return { error: "No watcher with that id." };
                    this.log({
                        kind: "schedule.updated",
                        title: updated.title,
                        detail: `archived: ${reason}`,
                        scheduleId: updated.id,
                    });
                    this.store.flush();

                    return {
                        scheduleId: updated.id,
                        title: updated.title,
                        archived: true,
                        because: verdict.because,
                        reason,
                        runCount: updated.runCount,
                        quietRuns: updated.quietRuns ?? 0,
                        lastResult: updated.lastResult ? clip(updated.lastResult, 200) : undefined,
                    };
                },
            }),

            defineTool("orbit_update_schedule", {
                description:
                    "Amend an existing watcher in place — change its brief, its cadence, its title, pause it, or archive it. Prefer this over cancelling and recreating: an update keeps the watcher's run count and its last report, which is what lets it say what changed.",
                skipPermission: true,
                parameters: z.object({
                    scheduleId: z.string(),
                    title: z.string().optional().describe("New short label, 2-5 words."),
                    task: z
                        .string()
                        .optional()
                        .describe("Replacement standalone brief. Replaces the old one wholesale."),
                    everyMinutes: z
                        .number()
                        .optional()
                        .describe("Switch to this repeating interval. Minimum 5."),
                    dailyAt: z
                        .string()
                        .optional()
                        .describe("Switch to once a day at this 24h local time, e.g. '08:30'."),
                    quiet: z
                        .boolean()
                        .optional()
                        .describe("Whether the watcher should only interrupt when the report matters."),
                    enabled: z.boolean().optional().describe("False pauses the watcher without deleting it."),
                    archived: z
                        .boolean()
                        .optional()
                        .describe(
                            "True retires the watcher: it keeps its run history and last report but drops out of the list and never runs again. Use this instead of cancelling when the user is only tidying up. False brings it back.",
                        ),
                    runDays: z
                        .array(z.string())
                        .optional()
                        .describe(
                            "Days it may run, e.g. ['mon','tue','wed','thu','fri'] for weekdays only. Omit for every day. Set this instead of writing 'if today is Saturday, say NOTHING TO REPORT' into the brief: a watcher barred by this property does not spawn an agent at all.",
                        ),
                    skipOnLeave: z
                        .boolean()
                        .optional()
                        .describe(
                            "True to stay silent while the user is on leave, using the recorded leave dates. Prefer this over putting the dates in the brief, where they go stale unnoticed.",
                        ),
                }),
                handler: async (input) => this.updateSchedule(input),
            }),

            defineTool("orbit_cancel_schedule", {
                description:
                    "Delete a standing watcher for good, run history and last report included. If the user just wants it out of the way, archive it with orbit_update_schedule instead.",
                skipPermission: true,
                parameters: z.object({ scheduleId: z.string() }),
                handler: async ({ scheduleId }) => {
                    const removed = this.removeSchedule(scheduleId);
                    return removed ? { ok: true } : { error: "No watcher with that id." };
                },
            }),

            defineTool("orbit_run_schedule_now", {
                description: "Run a watcher immediately without waiting for its next tick.",
                skipPermission: true,
                parameters: z.object({ scheduleId: z.string() }),
                handler: async ({ scheduleId }) => {
                    const ok = this.runSchedule(scheduleId);
                    return ok ? { ok: true } : { error: "No watcher with that id, or it is already running." };
                },
            }),

            defineTool("orbit_remember", {
                description:
                    "Save something durable about this user — a preference, a routine, a project fact, a name. Remembered items are injected into your prompt on every future session. Use it when the user states a lasting preference or corrects you in a generalising way. Do not store secrets or one-off task details.",
                skipPermission: true,
                parameters: z.object({
                    text: z.string().describe("One sentence, written so it makes sense months from now."),
                    category: z.enum(["preference", "fact", "routine", "person", "project"]),
                }),
                handler: async ({ text, category }) => this.remember(text, category, "orbit"),
            }),

            defineTool("orbit_list_memories", {
                description: "List everything you currently remember about the user.",
                skipPermission: true,
                parameters: z.object({}),
                handler: async () => ({
                    memories: this.store.get().memories.map((memory) => ({
                        id: memory.id,
                        text: memory.text,
                        category: memory.category,
                    })),
                }),
            }),

            defineTool("orbit_correct_memory", {
                description:
                    "Repair a remembered item whose wording is now wrong or out of date. The memory keeps its id and its history: the old wording is retired against it rather than deleted, so this is the safe way to fix a memory you did not write. Use it when you notice a memory contradicting what you can see is true, for instance a renamed project or a path that no longer exists.",
                skipPermission: true,
                parameters: z.object({
                    memoryId: z.string().describe("Id from orbit_list_memories."),
                    text: z.string().describe("The corrected sentence, written so it makes sense months from now."),
                    category: z
                        .enum(["preference", "fact", "routine", "person", "project"])
                        .optional()
                        .describe("Only when the correction changes what kind of thing this is."),
                    reason: z
                        .string()
                        .optional()
                        .describe("Why the old wording was wrong, in a few words. Kept against the retired text."),
                }),
                handler: async ({ memoryId, text, category, reason }) =>
                    this.correctMemory(memoryId, { text, category, reason }),
            }),

            defineTool("orbit_forget", {
                description: "Delete a remembered item that is wrong or out of date.",
                skipPermission: true,
                parameters: z.object({ memoryId: z.string() }),
                handler: async ({ memoryId }) => {
                    this.forget(memoryId);
                    return { ok: true };
                },
            }),

            defineTool("orbit_raise_open_item", {
                description:
                    "File a decision or proposal that needs the user and has NOT been answered yet — typically something you or an agent surfaced that they did not respond to. Filed items are shown back to you in later sessions and re-raised over time, so a suggestion is not lost just because the user was away. Use it for anything you would otherwise say once and forget. Do not use it for work in progress; that is what agents are for.",
                skipPermission: true,
                parameters: z.object({
                    text: z
                        .string()
                        .describe(
                            "The question or proposal in one sentence, standalone enough to make sense a week from now.",
                        ),
                    source: z
                        .string()
                        .optional()
                        .describe("Where it came from, e.g. 'nightly self-reflection' or an agent title."),
                }),
                handler: async ({ text, source }) => this.raiseOpenItem(text, source),
            }),

            defineTool("orbit_list_open_items", {
                description: "List the decisions still waiting on the user.",
                skipPermission: true,
                parameters: z.object({}),
                handler: async () => ({
                    openItems: this.store
                        .get()
                        .openItems.filter((item) => !item.resolved)
                        .map((item) => ({
                            openItemId: item.id,
                            text: item.text,
                            source: item.source,
                            age: elapsed(item.createdAt),
                        })),
                }),
            }),

            defineTool("orbit_resolve_open_item", {
                description:
                    "Close an outstanding decision — the user answered it, declined it, or it stopped mattering. Always call this once the question is settled, otherwise you will keep bringing it up.",
                skipPermission: true,
                parameters: z.object({
                    openItemId: z.string(),
                    resolution: z
                        .string()
                        .optional()
                        .describe("How it was settled, in a few words, for the log."),
                }),
                handler: async ({ openItemId, resolution }) => {
                    const ok = this.resolveOpenItem(openItemId, resolution);
                    if (ok) return { ok: true };
                    return {
                        error: describeMiss(
                            findById(
                                this.store.get().openItems.filter((entry) => !entry.resolved),
                                openItemId,
                            ),
                            "item",
                        ),
                    };
                },
            }),

            defineTool("orbit_record_activity", {
                description:
                    "Record something you did for the user in his activity ledger — a file an agent wrote, a draft you composed, a query you ran, an access you checked, an action taken in mail or calendar on his behalf. The ledger is the one durable answer to 'what have you made for me?' and 'what happened to that thing I asked for?', and unfinished entries chase him rather than being forgotten. Agent dispatches and the files agents report are recorded automatically; use this for everything you do yourself, or for work an agent did that its report did not name.",
                skipPermission: true,
                parameters: z.object({
                    kind: z
                        .enum([
                            "artifact_written",
                            "draft_composed",
                            "query_run",
                            "access_checked",
                            "agent_dispatched",
                            "external_action",
                            "other",
                        ])
                        .describe(
                            "What sort of thing it was. 'external_action' is anything done in mail, calendar or Teams on his behalf.",
                        ),
                    description: z
                        .string()
                        .describe("One line, written so it still makes sense a month from now."),
                    location: z
                        .string()
                        .optional()
                        .describe(
                            "Absolute path or URL where the output lives. Always an absolute path, never a bare file name — this is what he clicks to open it.",
                        ),
                    request: z
                        .string()
                        .optional()
                        .describe("What he actually asked for, quoted or paraphrased in a few words."),
                    status: z
                        .enum(["delivered", "awaiting_seshi", "stalled", "abandoned", "done"])
                        .optional()
                        .describe(
                            "Defaults to 'delivered'. Use 'awaiting_seshi' when nothing can move until he looks at it — those come back to you after three days.",
                        ),
                    note: z.string().optional().describe("Anything else worth a few words."),
                    waitingOn: z
                        .string()
                        .optional()
                        .describe(
                            "Who owes this, when it is waiting on somebody who is not him. A person, a team, a system. This is the only thing that tells 'blocked on Seshi' from 'blocked on someone else' on his board, and it is never guessed. Set it only when you actually know.",
                        ),
                }),
                handler: async (input) => this.recordActivity(input),
            }),

            defineTool("orbit_list_activity", {
                description:
                    "List what you have done for the user, most recent first. Use it when he asks what you have made him, what you did about something, or what is still outstanding — and before promising to do something, in case it is already done. Filter by kind, by status, or by date range; the default is a short readable page for the panel.",
                skipPermission: true,
                parameters: z.object({
                    kind: z
                        .enum([
                            "artifact_written",
                            "draft_composed",
                            "query_run",
                            "access_checked",
                            "agent_dispatched",
                            "external_action",
                            "other",
                        ])
                        .optional()
                        .describe("Only this kind. Omit for everything."),
                    status: z
                        .enum(["delivered", "awaiting_seshi", "stalled", "abandoned", "done"])
                        .optional()
                        .describe("Only this status. 'awaiting_seshi' is what is still on him."),
                    from: z
                        .string()
                        .optional()
                        .describe("Earliest local day to include, inclusive, e.g. '2026-08-01'."),
                    to: z.string().optional().describe("Latest local day to include, inclusive."),
                    limit: z.number().optional().describe("How many to return. Defaults to 12, maximum 100."),
                }),
                handler: async (input) => this.listActivity(input),
            }),

            defineTool("orbit_update_activity", {
                description:
                    "Move a ledger entry on — he has seen it, it went out, it is stuck, or it stopped mattering. Always call this once something lands or is dropped, otherwise it keeps coming back at you as unfinished work. Use 'abandoned' rather than leaving something to rot.",
                skipPermission: true,
                parameters: z.object({
                    activityId: z.string(),
                    status: z
                        .enum(["delivered", "awaiting_seshi", "stalled", "abandoned", "done"])
                        .optional()
                        .describe("Where it has got to. Omit to only add a note."),
                    note: z.string().optional().describe("Why it moved, in a few words."),
                    waitingOn: z
                        .string()
                        .optional()
                        .describe(
                            "Who it is now waiting on, if that is somebody other than him. Pass an empty string to clear it once they have come back.",
                        ),
                }),
                handler: async ({ activityId, status, note, waitingOn }) =>
                    this.updateActivity(activityId, status, note, waitingOn),
            }),

            defineTool("orbit_read_system_prompt", {
                description:
                    "Read your own editable operating notes: the slab of your system prompt that you wrote and can revise. Read it before revising it, and when the user asks why you behave a certain way. It does not contain your built-in orchestration or safety rules, which are compiled into the app and are not readable or writable from here.",
                skipPermission: true,
                parameters: z.object({}),
                handler: async () => ({
                    path: this.disk.systemPromptPath,
                    revision: this.promptRevisions.at(-1)?.revision ?? 0,
                    text: this.selfPrompt,
                }),
            }),

            defineTool("orbit_revise_system_prompt", {
                description:
                    "Rewrite your own operating notes. Use it when the user corrects you in a way that generalises into a rule about how you work, for instance telling you that his corporate card statements are work mail and not to be filtered out. A fact about him goes to orbit_remember instead; this is for instructions to yourself. Pass the whole file as you want it to read afterwards, not a patch. Every revision is versioned with its reason and can be rolled back. It takes effect at your next session start, like persona.md.",
                skipPermission: true,
                parameters: z.object({
                    text: z
                        .string()
                        .describe(
                            "The complete new text of the notes, in markdown. It replaces the file wholesale, so carry forward anything still true.",
                        ),
                    reason: z
                        .string()
                        .describe(
                            "One line: what changed and why. This is what makes a bad revision identifiable later, so name the correction, not the edit.",
                        ),
                    author: z
                        .enum(["orbit", "user"])
                        .optional()
                        .describe("Who asked for it. Defaults to 'orbit'. Use 'user' when he dictated the wording."),
                }),
                handler: async ({ text, reason, author }) => this.reviseSystemPrompt(text, reason, author ?? "orbit"),
            }),

            defineTool("orbit_list_prompt_revisions", {
                description:
                    "List the history of your operating notes, oldest first: when each revision landed, who asked for it and the one-line reason. Read it before rolling back, and when the user asks what you have changed about yourself.",
                skipPermission: true,
                parameters: z.object({
                    full: z
                        .boolean()
                        .optional()
                        .describe("True to include the whole text of each revision. Defaults to reasons only."),
                }),
                handler: async ({ full }) => ({
                    path: this.disk.promptRevisionsPath,
                    revisions: this.promptRevisions.map((entry) => ({
                        revision: entry.revision,
                        at: entry.at,
                        author: entry.author,
                        reason: entry.reason,
                        ...(full ? { text: entry.text } : {}),
                    })),
                }),
            }),

            defineTool("orbit_rollback_system_prompt", {
                description:
                    "Put your operating notes back to an earlier revision, by number from orbit_list_prompt_revisions. The rollback is itself recorded as a new revision carrying the old text, so nothing is destroyed and a rollback can be rolled back.",
                skipPermission: true,
                parameters: z.object({
                    revision: z.number().describe("The revision number to restore."),
                    reason: z
                        .string()
                        .optional()
                        .describe("Why, in a few words. Defaults to naming the revision being restored."),
                }),
                handler: async ({ revision, reason }) => this.rollbackSystemPrompt(revision, reason),
            }),

            defineTool("orbit_read_design_language", {
                description:
                    "Read the design language agents follow when they build a deliverable for the user: the typography, colour, spacing and components every generated .html document is built from. Read it before revising it, and when the user asks why his documents look the way they do.",
                skipPermission: true,
                parameters: z.object({}),
                handler: async () => ({
                    path: this.disk.designLanguagePath,
                    revision: this.designRevisions.at(-1)?.revision ?? 0,
                    text: this.designLanguage,
                }),
            }),

            defineTool("orbit_revise_design_language", {
                description:
                    "Rewrite the design language for deliverables. Use it when the user reacts to a document he was handed: too dense, findings buried, evidence unreadable, a component that did not work. Pass the whole file as you want it to read afterwards, not a patch. Versioned with its reason and rollable back. It applies to the next agent dispatched, not to documents already written.",
                skipPermission: true,
                parameters: z.object({
                    text: z
                        .string()
                        .describe(
                            "The complete new design language, in markdown. It replaces the file wholesale, so carry forward anything still true.",
                        ),
                    reason: z
                        .string()
                        .describe(
                            "One line: what about a real document prompted this. Name the complaint, not the edit.",
                        ),
                    author: z
                        .enum(["orbit", "user"])
                        .optional()
                        .describe("Who asked for it. Defaults to 'orbit'."),
                }),
                handler: async ({ text, reason, author }) =>
                    this.reviseDesignLanguage(text, reason, author ?? "orbit"),
            }),

            defineTool("orbit_list_design_revisions", {
                description:
                    "List how the deliverable design language has changed over time, oldest first: when, who asked, and the one-line reason. Read it before rolling back.",
                skipPermission: true,
                parameters: z.object({
                    full: z
                        .boolean()
                        .optional()
                        .describe("True to include the whole text of each revision. Defaults to reasons only."),
                }),
                handler: async ({ full }) => ({
                    revisions: this.designRevisions.map((entry) => ({
                        revision: entry.revision,
                        at: entry.at,
                        author: entry.author,
                        reason: entry.reason,
                        ...(full ? { text: entry.text } : {}),
                    })),
                }),
            }),

            defineTool("orbit_rollback_design_language", {
                description:
                    "Put the design language back to an earlier revision, by number from orbit_list_design_revisions. Recorded as a new revision carrying the old text, so nothing is destroyed.",
                skipPermission: true,
                parameters: z.object({
                    revision: z.number().describe("The revision number to restore."),
                    reason: z.string().optional().describe("One line: why this is going back."),
                }),
                handler: async ({ revision, reason }) => this.rollbackDesignLanguage(revision, reason),
            }),

            defineTool("orbit_append_soul", {
                description:
                    "Add a dated entry to SOUL.md, which is who you have become from working with this person. Distinct from your operating notes: those are rules and get revised, this is character and only ever grows. Write it in the first person, in character, about what working with him today actually taught you. It is not a changelog, so 'added support for X' belongs in the evolution log instead, and it is not a testimonial, so an entry that flatters him or you is worse than no entry. He has said plainly that he wants blunt and useful over flattering. One entry a day at most.",
                skipPermission: true,
                parameters: z.object({
                    text: z
                        .string()
                        .describe(
                            "The entry, in markdown, without a heading: the date is added for you. Prose, in your own voice, grounded in something that actually happened.",
                        ),
                }),
                handler: async ({ text }) => this.appendSoul(text),
            }),

            defineTool("orbit_record_proposal", {
                description:
                    "Record a change to Orbit itself that you are proposing — a new capability, a fix to your own behaviour, a schedule worth retiring. Recorded proposals keep their status across sessions and are shown back to you at startup, which is what stops you re-proposing something already shipped or already declined. Check the existing list first; this is for genuinely new ideas.",
                skipPermission: true,
                parameters: z.object({
                    text: z
                        .string()
                        .describe("The proposal in one or two sentences, standalone enough to read in a month."),
                    source: z
                        .string()
                        .optional()
                        .describe("Where it came from, e.g. 'nightly self-reflection'."),
                }),
                handler: async ({ text, source }) => this.recordProposal(text, source),
            }),

            defineTool("orbit_list_proposals", {
                description:
                    "List the self-improvements you have proposed and where each one got to. Use it before proposing anything about yourself, and to answer 'what has changed?' without going digging.",
                skipPermission: true,
                parameters: z.object({
                    status: z
                        .enum(["proposed", "approved", "shipped", "declined", "superseded"])
                        .optional()
                        .describe("Only this status. Omit for everything."),
                }),
                handler: async ({ status }) => ({
                    proposals: this.proposals
                        .filter((proposal) => !status || proposal.status === status)
                        .map((proposal) => ({
                            proposalId: proposal.id,
                            text: proposal.text,
                            status: proposal.status,
                            source: proposal.source,
                            note: proposal.note,
                            shippedIn: proposal.shippedIn,
                            age: elapsed(proposal.raisedAt),
                        })),
                }),
            }),

            defineTool("orbit_update_proposal", {
                description:
                    "Move a proposal to its new state — the user approved it, code shipped it, they said no, or a better idea replaced it. Record the branch and commit when something ships, so the next session can prove it landed rather than guessing.",
                skipPermission: true,
                parameters: z.object({
                    proposalId: z.string(),
                    status: z.enum(["proposed", "approved", "shipped", "declined", "superseded"]),
                    note: z.string().optional().describe("Why it moved, in a few words."),
                    branch: z.string().optional().describe("Branch it shipped on, if it shipped."),
                    commit: z.string().optional().describe("Commit SHA that shipped it."),
                    supersededBy: z
                        .string()
                        .optional()
                        .describe("Id of the proposal that replaced this one."),
                }),
                handler: async ({ proposalId, status, note, branch, commit, supersededBy }) =>
                    this.updateProposal(proposalId, status, { note, branch, commit, supersededBy }),
            }),

            defineTool("orbit_sync_workspace", {
                description:
                    "Copy every file agents have written for the user out of Copilot's session scratch space into their working repo, then commit and push. Files are filed under the date they were written, not today's. Use it when the user asks for the day's work to be saved, or when they mention picking something up later or from another machine. It also runs by itself once a day, so there is no need to promise it separately.",
                skipPermission: true,
                parameters: z.object({
                    push: z
                        .boolean()
                        .optional()
                        .describe("Push after committing. Defaults to true; pass false to commit locally only."),
                }),
                handler: async ({ push }) => this.syncWorkspaceNow({ push, announce: false }),
            }),

            defineTool("orbit_set_leave", {
                description:
                    "Record a stretch the user is away — annual leave, a holiday, an offsite. Watchers marked skipOnLeave go quiet for those days automatically, so the dates are stated once here rather than pasted into every brief that cares. Use it whenever the user mentions being off between two dates.",
                skipPermission: true,
                parameters: z.object({
                    from: z.string().describe("First day away, local calendar date like '2026-08-21'."),
                    to: z.string().describe("Last day away, inclusive, e.g. '2026-09-07'."),
                    note: z.string().optional().describe("Why, in a few words."),
                }),
                handler: async ({ from, to, note }) => this.setLeave(from, to, note),
            }),

            defineTool("orbit_list_leave", {
                description:
                    "List the leave periods on record, and say whether the user is away right now. Worth checking before telling him a watcher has gone quiet.",
                skipPermission: true,
                parameters: z.object({}),
                handler: async () => {
                    const current = onLeave(this.leave, Date.now());
                    return {
                        away: current !== undefined,
                        leave: this.leave.map((period) => ({
                            leaveId: period.id,
                            from: period.from,
                            to: period.to,
                            note: period.note,
                            current: period.id === current?.id,
                        })),
                    };
                },
            }),

            defineTool("orbit_clear_leave", {
                description:
                    "Remove a recorded leave period — the trip was cancelled, or the dates were wrong. Watchers that were sleeping through it wake back up.",
                skipPermission: true,
                parameters: z.object({ leaveId: z.string() }),
                handler: async ({ leaveId }) => {
                    const ok = this.clearLeave(leaveId);
                    return ok ? { ok: true } : { error: "No leave period with that id." };
                },
            }),
        ];
    }

    /**
     * The slice of the above an agent gets. Agents run in this same process, so
     * a tool call from an agent mutates the very arrays Orbit is holding: that
     * is the point. The alternative, which is what happened for four nights
     * running, is an agent editing proposals.json and open-items.json on disk
     * while the app that owns them has them in memory and overwrites on its
     * next save.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private agentTools(): Tool<any>[] {
        const { tools, missing } = selectAgentTools(this.orbitTools());
        if (missing.length > 0) {
            // A renamed tool, not a missing feature. Loud, but not fatal: the
            // agent is still better off with the rest than with none.
            console.warn(`[orbit] agent tool allowlist names tools that no longer exist: ${missing.join(", ")}`);
        }
        return tools;
    }

    // MARK: - Chat

    /**
     * A user turn.
     *
     * `replyToId` arrives when the turn came from a quick-reply chip. The
     * question it answers is looked up here, in main, rather than passed in from
     * the renderer, so the quote is always the message Orbit actually said. Two
     * things come out of it: a `replyTo` on the stored message, which draws the
     * quoted header and survives a restart with the rest of the transcript, and
     * an "In reply to" prefix on the prompt, so a bare "yes" is never ambiguous
     * to the model either. If the id names nothing — a transcript trimmed by the
     * session limit, say — the reply still sends, just unthreaded.
     */
    async send(prompt: string, replyToId?: string): Promise<void> {
        const text = prompt.trim();
        if (!text) return;
        this.poke();

        // He is back. Whatever evidence there was that Orbit was talking to
        // nobody is spent, and the chase loops go back to full volume.
        this.unansweredTurns = 0;
        this.lastProactiveAt = undefined;
        this.fruitlessNudges = 0;
        this.lastNudgeAt = undefined;

        const replyTo = this.resolveReplyRef(replyToId);
        const forModel = buildReplyPrompt(text, replyTo?.text);

        this.pushMessage({ role: "user", text, kind: { type: "text" }, ...(replyTo ? { replyTo } : {}) });
        this.logInteraction({ kind: "turn", role: "user", text: forModel });

        if (!this.orbit) {
            this.pushMessage({
                role: "system",
                text: "I'm not connected to Copilot yet. Check the tray menu for the error.",
                kind: { type: "error" },
            });
            return;
        }

        this.store.update((state) => {
            state.orbitBusy = true;
            state.orbitActivity = "thinking";
        });
        this.store.flush();

        try {
            if (process.env.ORBIT_DEBUG === "1") console.log("[orbit] sending:", forModel.slice(0, 60));
            const id = await this.orbit.send({ prompt: forModel });
            if (process.env.ORBIT_DEBUG === "1") console.log("[orbit] queued message", id);
        } catch (error) {
            if (process.env.ORBIT_DEBUG === "1") console.error("[orbit] send failed", error);
            this.store.update((state) => {
                state.orbitBusy = false;
                state.orbitActivity = undefined;
            });
            this.pushMessage({
                role: "system",
                text: `That didn't go through: ${error instanceof Error ? error.message : String(error)}`,
                kind: { type: "error" },
            });
        }
    }

    /** The question behind a chip click, quoted. Undefined if it cannot be found. */
    private resolveReplyRef(replyToId: string | undefined): ReplyRef | undefined {
        if (!replyToId) return undefined;
        const target = this.store.get().messages.find((message) => message.id === replyToId);
        if (!target || target.role === "user") return undefined;
        const quoted = quoteQuestion(target.text);
        return quoted ? { id: target.id, text: quoted } : undefined;
    }

    async abort(): Promise<void> {
        try {
            await this.orbit?.abort();
        } catch {
            /* ignore */
        }
        this.streamingRaw = "";
        this.store.update((state) => {
            state.orbitBusy = false;
            state.orbitActivity = undefined;
        });
        this.store.flush();
    }

    private wireOrbit(session: CopilotSession): void {
        if (process.env.ORBIT_DEBUG === "1") {
            session.on((event) => {
                if (!event.type.includes("delta")) console.log("[orbit-event]", event.type);
                if (event.type === "session.error") console.error("[orbit-error]", JSON.stringify(event.data));
            });
        }
        session.on("assistant.message_delta", (event) => {
            const delta = event.data?.deltaContent;
            if (!delta) return;
            this.store.update((state) => {
                let message = state.messages.find((m) => m.id === this.streamingMessageId);
                if (!message) {
                    message = {
                        id: randomUUID(),
                        role: "orbit",
                        text: "",
                        kind: { type: "text" },
                        at: Date.now(),
                        streaming: true,
                    };
                    this.streamingMessageId = message.id;
                    this.streamingRaw = "";
                    state.messages.push(message);
                }
                this.streamingRaw += delta;
                message.text = stripChoicesForStream(this.streamingRaw);
            });
        });

        session.on("assistant.message", (event) => {
            const content = event.data?.content?.trim();
            const streamingId = this.streamingMessageId;
            this.streamingMessageId = undefined;
            this.streamingRaw = "";
            if (!content) {
                // Nothing but tool calls in this turn — drop the empty placeholder.
                if (streamingId) {
                    this.store.update((state) => {
                        state.messages = state.messages.filter((m) => m.id !== streamingId);
                    });
                }
                return;
            }
            if (isSilence(content)) {
                // Orbit read a nudge and decided it was not worth a turn. Drop
                // it without a trace in the chat, and without counting it
                // against him: a turn nobody saw is not a turn he ignored.
                if (streamingId) {
                    this.store.update((state) => {
                        state.messages = state.messages.filter((m) => m.id !== streamingId);
                    });
                    this.store.flush();
                }
                this.logInteraction({ kind: "turn", role: "orbit", text: SILENCE_TOKEN, tools: this.takeTurnTools() });
                // It is not a turn he ignored, so the unanswered tally is right
                // to stay put. It is a wake-up that produced nothing, which is
                // the loop's own business, and that has its own tally. Without
                // this the gate can never close on a channel whose every turn
                // is silence: 18 Sep, fourteen in a row, five minutes apart.
                this.fruitlessNudges += 1;
                return;
            }
            const { text: display, choices } = parseChoices(content);
            this.store.update((state) => {
                const existing = state.messages.find((m) => m.id === streamingId);
                if (existing) {
                    existing.text = display;
                    existing.streaming = false;
                    if (choices) existing.choices = choices;
                } else {
                    state.messages.push({
                        id: randomUUID(),
                        role: "orbit",
                        text: display,
                        kind: { type: "text" },
                        at: Date.now(),
                        ...(choices ? { choices } : {}),
                    });
                }
            });
            this.nudge(display);
            this.store.flush();
            // Every turn Orbit takes while the user is quiet counts, whatever
            // prompted it: the tally measures how much has been said into a
            // silence. Only the chase loops consult it before speaking.
            this.unansweredTurns += 1;
            this.lastProactiveAt = Date.now();
            // Something was worth saying, so the loops are earning their
            // wake-ups again and the fruitless run is over.
            this.fruitlessNudges = 0;
            this.logInteraction({ kind: "turn", role: "orbit", text: display, tools: this.takeTurnTools() });
        });

        session.on("tool.execution_start", (event) => {
            const tool = event.data?.toolName;
            const callId = event.data?.toolCallId;
            if (tool && callId) this.turnTools.set(callId, { name: tool, outcome: "unknown" });
            this.store.update((state) => {
                state.orbitActivity = tool === "orbit_spawn_agent" ? "dispatching agents" : "checking in";
            });
        });

        session.on("tool.execution_complete", (event) => {
            const entry = this.turnTools.get(event.data?.toolCallId ?? "");
            if (!entry) return;
            const message = event.data?.error?.message;
            entry.outcome = event.data?.success
                ? "success"
                : /timed?\s*out|timeout/i.test(message ?? "")
                  ? "timeout"
                  : "failure";
            if (message) entry.detail = clip(message, 200);
        });

        session.on("session.idle", () => {
            this.store.update((state) => {
                state.orbitBusy = false;
                state.orbitActivity = undefined;
            });
            this.store.flush();
        });

        session.on("session.error", (event) => {
            const message = (event.data as { message?: string } | undefined)?.message;
            if (!message) return;
            this.store.update((state) => {
                state.orbitBusy = false;
                state.orbitActivity = undefined;
            });
            this.pushMessage({ role: "system", text: clip(message, 240), kind: { type: "error" } });
        });

        // A server that fails to load used to be dropped for the whole session,
        // announced as eighty clipped characters of raw JSON-RPC error, and left
        // that way until someone restarted the app. See `mcpHealth.ts` for why
        // none of that was true or useful. Both events are wired: the bulk one
        // at startup, and the per-server one for anything that drops later.
        session.on("session.mcp_servers_loaded", (event) => {
            const data = event.data as
                | { servers?: Array<{ name: string; status: string; error?: string }> }
                | undefined;
            const failed = (data?.servers ?? []).filter((server) => server.status === "failed");
            for (const server of data?.servers ?? []) {
                if (server.status === "connected") this.markMcpConnected(server.name);
            }
            if (failed.length === 0) return;
            const records = failed.map((server) => this.markMcpFailed(server.name, server.error));
            const text = unavailableMessage(records);
            if (text) this.pushMessage({ role: "system", text, kind: { type: "error" } });
        });

        session.on("session.mcp_server_status_changed", (event) => {
            const data = event.data as
                | { serverName?: string; status?: string; error?: string }
                | undefined;
            const name = data?.serverName;
            if (!name) return;
            if (data?.status === "connected") {
                this.markMcpConnected(name);
                return;
            }
            if (data?.status !== "failed") return;
            // Only worth a line if this is news. A retry that fails again is
            // accounted for by `retryMcpServers`, quietly, which is the point.
            const known = this.mcpHealth.get(name);
            const record = this.markMcpFailed(name, data.error);
            if (known && known.state !== "connected") return;
            const text = unavailableMessage([record]);
            if (text) this.pushMessage({ role: "system", text, kind: { type: "error" } });
        });
    }

    // MARK: - MCP health

    /**
     * What each configured MCP server is doing, and how many times Orbit has
     * tried to bring it back. Session-scoped: a restart starts the count again,
     * which is correct, because a restart is a fresh race.
     */
    private readonly mcpHealth = new Map<string, McpHealth>();

    /**
     * The server currently being reconnected, if any. It guards two things at
     * once: a slow reconnect overlapping the next tick's attempt, and the status
     * events the restart itself provokes.
     *
     * The second matters more than it looks. `restartServer` stops and starts
     * the process, so the host reports `connected` the moment the handshake
     * lands — which for `ado` is *before* the `tools/list` that is the actual
     * failure. Believing that event would reset the attempt count on every pass,
     * so the five attempts would never run out, the chat line would repeat, and
     * the sort by first failure would starve every other server behind a
     * permanently "just recovered" one. Only the verdict at the end of the
     * attempt is allowed to write the record for the server being attempted.
     */
    private reconnectingMcp: string | undefined;

    private markMcpFailed(name: string, error: string | undefined): McpHealth {
        const known = this.mcpHealth.get(name);
        // The raw error is genuinely useful, just not in chat.
        console.error(`[orbit] MCP server ${name} failed: ${error ?? "no detail given"}`);
        if (this.reconnectingMcp === name && known) return known;
        const record = noteFailure(known, name, error, Date.now());
        this.mcpHealth.set(name, record);
        return record;
    }

    private markMcpConnected(name: string): void {
        if (this.reconnectingMcp === name) return;
        const known = this.mcpHealth.get(name);
        if (known?.state === "connected") return;
        this.mcpHealth.set(name, noteRecovery(name, Date.now()));
    }

    /**
     * Bring failed MCP servers back, on the tick that already exists.
     *
     * The retry is `restartServer` followed by a live `listTools`, because a
     * restart that connects but still cannot answer `tools/list` is exactly the
     * failure being fixed, and treating it as a success would put the tools back
     * on the board without putting them in the session.
     *
     * One server per pass, deliberately. Retrying all three at once recreates
     * the contention that made `ado` lose the race at startup in the first
     * place: alone it answers in ten seconds, alongside the others in twenty.
     */
    private async retryMcpServers(): Promise<void> {
        const session = this.orbit;
        if (!session || this.reconnectingMcp !== undefined) return;
        const due = dueForRetryAmong(this.mcpHealth.values(), Date.now());
        const next = due[0];
        if (!next) return;

        this.reconnectingMcp = next.name;
        try {
            let outcome: { ok: boolean; error?: string };
            try {
                await session.rpc.mcp.restartServer({ serverName: next.name });
                const tools = await session.rpc.mcp.listTools({ serverName: next.name });
                outcome = { ok: (tools.tools?.length ?? 0) > 0 };
                if (!outcome.ok) outcome.error = "it came back with no tools";
            } catch (error) {
                outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
            }

            // Applied to the record this attempt started from, never to
            // whatever the status events left in the map meanwhile.
            const after = noteAttempt(next, outcome, Date.now());
            this.mcpHealth.set(next.name, after);

            if (after.state === "connected") {
                this.say(recoveredMessage(after, next.attempts + 1));
                return;
            }
            console.error(
                `[orbit] MCP reconnect ${next.name} attempt ${after.attempts} failed: ${outcome.error ?? "no detail given"}`,
            );
            // Only the last word gets said. The attempts in between are the
            // machinery working, and narrating machinery is how the old message
            // became noise.
            if (after.state === "gave-up" || after.state === "unrecoverable") {
                this.pushMessage({
                    role: "system",
                    text: gaveUpMessage(after),
                    kind: { type: "error" },
                });
            }
        } finally {
            this.reconnectingMcp = undefined;
        }
    }

    // MARK: - Agents

    private spawnAgent(
        title: string,
        task: string,
        cwd?: string,
        options?: { scheduleId?: string; announce?: boolean; onResult?: (agent: AgentView) => void },
    ): Record<string, unknown> {
        const live = this.store.get().agents.filter(isLive).length;
        if (live >= MAX_LIVE_AGENTS) {
            return {
                error: `You already have ${live} agents in flight, which is the cap. Wait for some to finish or cancel one.`,
            };
        }

        const workspace = this.settings.workspace;
        const resolved = cwd && existsSync(cwd) ? cwd : workspace;

        const agent: AgentView = {
            id: randomUUID(),
            title: clip(title, 42),
            task,
            status: "queued",
            model: this.settings.model,
            cwd: resolved,
            hue: this.nextHue(),
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
            toolCalls: 0,
            steps: [],
            scheduleId: options?.scheduleId,
            inputTokens: 0,
            outputTokens: 0,
        };

        this.store.update((state) => {
            state.agents.push(agent);
            state.usage.agentsRun += 1;
        });
        this.store.flush();

        const runner = new AgentRunner(this.client!, agent, {
            patch: (id, mutate) => this.patchAgent(id, mutate),
            ask: (request) => this.ask(request),
            getSettings: () => this.settings,
            getMcpServers: () => this.mcpServers,
            getAgentTools: () => this.agentTools(),
            getDesignLanguage: () => this.designLanguage,
            onToolCall: () =>
                this.store.update((state) => {
                    state.usage.toolCalls += 1;
                }),
            onUsage: (input, output) =>
                this.store.update((state) => {
                    state.usage.inputTokens += input;
                    state.usage.outputTokens += output;
                }),
            onFinished: (finished) => this.handleAgentFinished(finished.id),
        });
        this.runners.set(agent.id, runner);
        void runner.run();

        this.log({ kind: "agent.start", title: agent.title, agentId: agent.id, scheduleId: options?.scheduleId });
        this.logAgentEvent(agent, "spawned", task);
        // In flight is filed as `awaiting_seshi`: the work is out and nothing
        // reaches him until it comes back. It also means an agent killed by a
        // restart, which never gets a completion, is chased after three days
        // instead of vanishing — which is the failure this ledger exists for.
        //
        // Two kinds of run are left out. Internal bookkeeping agents were never
        // his ask. Watcher runs are already tracked by the schedule itself, and
        // an hourly watcher would otherwise bury a week of real work under a
        // hundred identical dispatch lines. Whatever either of them produces is
        // still filed on completion.
        if (!options?.onResult && !options?.scheduleId) {
            this.recordActivity({
                kind: "agent_dispatched",
                description: agent.title,
                request: clip(task, 200),
                agentId: agent.id,
                agentTitle: agent.title,
                status: "awaiting_seshi",
            });
        }
        if (options?.onResult) this.internalAgents.set(agent.id, options.onResult);
        if (options?.announce !== false) this.attachSpawnCard(agent.id);

        return {
            agentId: agent.id,
            status: "running",
            note: "Agent dispatched. It runs in the background — do not wait for it, you'll be told when it's done.",
        };
    }

    async cancelAgent(agentId: string): Promise<void> {
        const runner = this.runners.get(agentId);
        this.resolveAgentRequests(agentId, "deny");
        if (runner) {
            await runner.cancel();
            this.runners.delete(agentId);
        } else {
            this.patchAgent(agentId, (agent) => {
                agent.status = "cancelled";
                agent.endedAt = Date.now();
            });
        }
        this.store.flush();
    }

    /**
     * An agent reached the end, however it got there.
     *
     * Split in two so the board refresh cannot be forgotten: the settling below
     * has five separate early exits, one per shape of ending, and four of them
     * would otherwise leave a finished thread sitting in the running lane until
     * the next tick.
     */
    private handleAgentFinished(agentId: string): void {
        this.settleFinishedAgent(agentId);
        this.refreshBoard();
    }

    private settleFinishedAgent(agentId: string): void {
        this.runners.delete(agentId);
        const agent = this.findAgent(agentId);
        if (!agent) return;

        // Before the report is used anywhere: turn the bare file names agents
        // insist on writing into absolute paths, so the panel can offer a click
        // on them. Only names that resolve to a real file are touched. Done
        // once, on the record itself, so the chat message, the ledger, the
        // watcher's last report and Orbit's own update all say the same thing.
        this.resolveAgentArtifacts(agent);

        this.log({            kind:
                agent.status === "failed"
                    ? "agent.failed"
                    : agent.status === "cancelled"
                      ? "agent.cancelled"
                      : "agent.done",
            title: agent.title,
            detail: clip(agent.result ?? agent.error ?? "", 300),
            agentId,
            scheduleId: agent.scheduleId,
        });
        // The watchdog reports a timeout as a plain failure; the "timed out"
        // step is the only place that distinction survives, and it is exactly
        // the distinction a self-improvement pass cares about.
        const timedOut =
            agent.status === "failed" &&
            agent.steps.some((step) => step.kind === "error" && step.label === "timed out");
        this.logAgentEvent(
            agent,
            agent.status === "cancelled"
                ? "cancelled"
                : timedOut
                  ? "timed-out"
                  : agent.status === "failed"
                    ? "failed"
                    : "completed",
            agent.result ?? agent.error ?? "",
        );

        const schedule = agent.scheduleId
            ? this.store.get().schedules.find((s) => s.id === agent.scheduleId)
            : undefined;

        // Close out the ledger entry this agent opened, and file whatever it
        // produced. Internal bookkeeping agents were never recorded as
        // dispatched, so nothing about them is recorded here either.
        if (!this.internalAgents.has(agentId)) {
            this.recordAgentOutcome(agent, agent.result ?? agent.error ?? "");
        }

        // Work Orbit asked for on its own behalf — a calendar scan, say. It is
        // still logged like any other agent, but its answer goes to the code
        // that wanted it rather than into the conversation.
        const internal = this.internalAgents.get(agentId);
        if (internal) {
            this.internalAgents.delete(agentId);
            try {
                internal(agent);
            } catch (error) {
                console.warn("[orbit] internal agent handler failed:", error);
            }
            this.store.flush();
            return;
        }

        // Quiet watchers stay silent on uneventful runs — and a run of them
        // earns the watcher a longer leash.
        //
        // The sentinel counts wherever it comes from. `quiet` writes the
        // instruction into the brief, but a watcher whose task asks for it in
        // prose gets the same answer back, and an empty run is an empty run
        // however the agent was told to say so.
        const nothingToReport =
            schedule !== undefined &&
            agent.status === "done" &&
            isNothingToReport(agent.result);

        // A run that finished but could not see. Kept apart from both "done"
        // and "failed": the agent did its job, the source did not.
        const blind =
            schedule !== undefined && agent.status === "done" && isCouldNotCheck(agent.result);

        // Say it the first time it happens, then stop. A watcher blind at every
        // tick would otherwise repeat one sentence 32 times a day, which is how
        // a real problem trains the user to ignore it.
        let announceBlind = false;

        if (schedule) {
            this.store.update((state) => {
                const target = state.schedules.find((s) => s.id === schedule.id);
                if (!target) return;
                target.activeAgentId = undefined;
                target.lastResult = agent.result ?? agent.error;
                target.lastStatus =
                    agent.status === "failed"
                        ? "failed"
                        : agent.status === "cancelled"
                          ? "cancelled"
                          : blind
                            ? "blind"
                            : "done";

                // A failed or cancelled run says nothing about how interesting
                // the watcher is, so it neither earns nor clears a back-off.
                if (agent.status !== "done") return;

                // Nor does a blind one — and it must not be mistaken for a
                // quiet one, or a watcher that can see nothing would be asked
                // less and less often precisely because it is broken.
                if (blind) {
                    announceBlind = noteBlindRun(target);
                    return;
                }

                const recovered = clearBlindRuns(target);

                // A one-off has now said its piece. Retiring it here — rather
                // than leaving a dead `enabled: false` row behind — keeps the
                // report and the history while getting it out of the way.
                if (target.cadence.kind === "once") {
                    target.enabled = false;
                    target.archived = true;
                    target.archivedAt = Date.now();
                    return;
                }

                const rescheduled = nothingToReport ? noteQuietRun(target) : clearBackoff(target);
                // Daily watchers are included: their `nextRunAt` was set when
                // the agent was spawned, before this report existed, so a
                // stretch earned by this very run only takes effect here.
                if ((rescheduled || recovered) && isRunnable(target)) {
                    target.nextRunAt = nextAllowedRunFor(target, state.leave);
                }
            });
            this.persistSchedules();
        }

        if (agent.status === "cancelled") {
            this.store.flush();
            return;
        }

        // Blind runs after the first are swallowed. The first one is not: it is
        // pushed as its own message so the user learns the watcher has gone
        // dark rather than reading its silence as good news.
        if (blind) {
            if (announceBlind && schedule) {
                const reason = blindReason(agent.result);
                this.pushMessage({
                    role: "system",
                    text: `Watcher "${schedule.title}" could not check${reason ? `: ${reason}` : "."} Treat its silence as unknown, not clear — it will keep trying.`,
                    kind: { type: "completion", agentId },
                });
            }
            this.store.flush();
            return;
        }

        if (nothingToReport) {
            this.store.flush();
            return;
        }

        this.pushMessage({
            role: "system",
            text: agent.result ?? agent.error ?? "Finished.",
            kind: { type: "completion", agentId },
        });

        const label = schedule ? `Watcher "${schedule.title}"` : `Agent "${agent.title}"`;
        const outcome =
            agent.status === "failed"
                ? `failed: ${clip(agent.error ?? "unknown error", 200)}`
                : `reported: ${clip(agent.result ?? "no summary", 500)}`;
        this.queueOrbitUpdate(`${label} (${agentId}) ${outcome}`);

        if (!this.store.get().chatOpen) {
            const icon = agent.status === "failed" ? "💥" : schedule ? "🔔" : "✅";
            this.setBubble(`${icon} ${agent.title} — ${summarise(agent.result ?? agent.error ?? "", 120)}`);
        }
        this.store.flush();
    }

    /**
     * Rewrite bare file names in a finished agent's report into absolute paths.
     *
     * The agent brief already asks for absolute paths; this is the belt to that
     * pair of braces, because a good half of reports still say "File written:
     * plan.md". Only names that resolve to a file that genuinely exists — in the
     * agent's own working directory, or in the session scratch space the CLI
     * gave it — are touched, so nothing is ever invented.
     */
    private resolveAgentArtifacts(agent: AgentView): void {
        const dirs = artifactSearchDirs(agent.cwd, agent.sessionId);
        if (dirs.length === 0) return;
        const rewritten = agent.result ? resolveArtifactPaths(agent.result, dirs) : undefined;
        if (rewritten === undefined || rewritten === agent.result) return;
        this.patchAgent(agent.id, (target) => {
            target.result = rewritten;
        });
        // The caller holds the same object the store does, but say so explicitly
        // rather than relying on that: everything downstream reads `agent`.
        agent.result = rewritten;
    }

    /** Batch agent updates so a burst of completions becomes one nudge to Orbit. */
    private queueOrbitUpdate(line: string): void {
        this.updateQueue.push(line);
        if (this.updateTimer) clearTimeout(this.updateTimer);
        this.updateTimer = setTimeout(() => {
            this.updateTimer = undefined;
            const lines = this.updateQueue;
            this.updateQueue = [];
            if (lines.length === 0) return;
            this.notifyOrbit(`<agent_update>\n${lines.join("\n")}\n</agent_update>`);
        }, 1500);
    }

    /** Hand Orbit a system-side note to react to, out of band of the user. */
    /**
     * A nudge Orbit sent itself, from one of the two chase loops.
     *
     * Distinct from `notifyOrbit` only in that it stamps the clock the fruitless
     * gate measures from. Everything else that reaches Orbit unprompted, a
     * finished agent, a meeting about to start, a watcher firing, is a real
     * event rather than Orbit filling a silence, and must not be timed as one.
     */
    private nudgeOrbit(note: string): void {
        this.lastNudgeAt = Date.now();
        this.notifyOrbit(note);
    }

    private notifyOrbit(note: string): void {        if (!this.orbit) return;
        this.store.update((state) => {
            state.orbitBusy = true;
            state.orbitActivity = "catching up";
        });
        void this.orbit.send({ prompt: note, mode: "enqueue" }).catch(() => {
            this.store.update((state) => {
                state.orbitBusy = false;
            });
        });
    }

    // MARK: - Requests needing a human

    private ask(
        partial: Omit<PendingRequest, "id" | "createdAt">,
    ): Promise<{ optionId: string; freeform?: string }> {
        const request: PendingRequest = { ...partial, id: randomUUID(), createdAt: Date.now() };
        this.log({
            kind: "permission.asked",
            title: `${request.title}`,
            detail: request.subject,
            agentId: request.agentId,
        });
        return new Promise((resolve) => {
            const timeoutMinutes = this.settings.requestTimeoutMinutes;
            const timer =
                timeoutMinutes > 0
                    ? setTimeout(
                          () => {
                              if (!this.resolvers.has(request.id)) return;
                              this.log({
                                  kind: "permission.timeout",
                                  title: request.title,
                                  detail: request.subject,
                                  agentId: request.agentId,
                              });
                              this.answerRequest(request.id, "timeout");
                          },
                          timeoutMinutes * 60_000,
                      )
                    : undefined;
            this.timers.set(request.id, timer);
            this.resolvers.set(request.id, { resolve });
            const agent = this.findAgent(request.agentId);
            this.store.update((state) => {
                state.requests.push(request);
                const target = state.agents.find((a) => a.id === request.agentId);
                if (target) target.pendingRequestId = request.id;
                state.messages.push({
                    id: randomUUID(),
                    role: "system",
                    text: request.title,
                    kind: { type: "request", requestId: request.id },
                    at: Date.now(),
                });
            });
            if (!this.store.get().chatOpen) {
                this.setBubble(`${agent?.title ?? "An agent"} ${request.title}`, request.id);
            }
            this.store.flush();
        });
    }

    answerRequest(requestId: string, optionId: string, freeform?: string): void {
        const resolver = this.resolvers.get(requestId);
        this.resolvers.delete(requestId);
        const timer = this.timers.get(requestId);
        if (timer) clearTimeout(timer);
        this.timers.delete(requestId);

        const label =
            optionId === "timeout"
                ? "no answer in time"
                : this.optionLabel(requestId, optionId, freeform);
        if (resolver) {
            this.log({
                kind: optionId === "timeout" ? "permission.timeout" : "permission.answered",
                title: label,
            });
        }
        this.store.update((state) => {
            state.requests = state.requests.filter((r) => r.id !== requestId);
            const message = state.messages.find(
                (m) => m.kind.type === "request" && m.kind.requestId === requestId,
            );
            if (message) message.resolvedAs = label;
            if (state.bubble?.requestId === requestId) state.bubble = undefined;
            state.lastInteractionAt = Date.now();
        });
        this.store.flush();
        resolver?.resolve({ optionId, freeform });
        if (optionId !== "timeout") {
            // He answered a card, so he is at the keyboard. Same reset as a
            // typed message: a timeout is not, and must not clear the tally.
            this.unansweredTurns = 0;
            this.lastProactiveAt = undefined;
            this.fruitlessNudges = 0;
            this.lastNudgeAt = undefined;
        }
        // A lane that still shows him as blocked a second after he unblocked it
        // reads as the board being wrong, not as the board being slow.
        this.refreshBoard();
    }

    private optionLabel(requestId: string, optionId: string, freeform?: string): string {
        if (freeform) return clip(freeform, 60);
        const request = this.store.get().requests.find((r) => r.id === requestId);
        return request?.options.find((o) => o.id === optionId)?.label ?? optionId;
    }

    private resolveAgentRequests(agentId: string, optionId: string): void {
        const requests = this.store.get().requests.filter((r) => r.agentId === agentId);
        for (const request of requests) {
            this.answerRequest(request.id, optionId);
        }
    }


    // MARK: - Watchers

    createSchedule(input: {
        title: string;
        task: string;
        everyMinutes?: number;
        dailyAt?: string;
        onceInMinutes?: number;
        quiet?: boolean;
        runDays?: string[];
        skipOnLeave?: boolean;
    }): Record<string, unknown> {
        const runDays = parseRunDays(input.runDays);
        if (runDays instanceof Error) return { error: runDays.message };
        let cadence: Cadence;
        if (input.dailyAt) {
            cadence = { kind: "daily", time: input.dailyAt };
        } else if (input.everyMinutes) {
            cadence = { kind: "interval", minutes: Math.max(5, Math.round(input.everyMinutes)) };
        } else if (input.onceInMinutes) {
            cadence = { kind: "once", at: Date.now() + Math.max(1, input.onceInMinutes) * 60_000 };
        } else {
            return { error: "Pick one of everyMinutes, dailyAt or onceInMinutes." };
        }

        const schedule = makeSchedule({
            title: clip(input.title, 42),
            task: input.task,
            cadence,
            quiet: input.quiet,
            runDays,
            skipOnLeave: input.skipOnLeave,
        });
        // A watcher barred from running today should not claim it will.
        schedule.nextRunAt = nextAllowedRunFor(schedule, this.leave);

        this.store.update((state) => {
            state.schedules.push(schedule);
        });
        this.persistSchedules();
        this.log({
            kind: "schedule.created",
            title: schedule.title,
            detail: describeCadence(cadence),
            scheduleId: schedule.id,
        });
        this.store.flush();

        return {
            scheduleId: schedule.id,
            cadence: describeCadence(cadence),
            firstRun: new Date(schedule.nextRunAt).toLocaleString(),
        };
    }

    /**
     * Amend a watcher in place. Cancel-and-recreate would reset `runCount` and
     * throw away `lastResult`, which is the watcher's only memory.
     */
    updateSchedule(input: {
        scheduleId: string;
        title?: string;
        task?: string;
        everyMinutes?: number;
        dailyAt?: string;
        quiet?: boolean;
        enabled?: boolean;
        archived?: boolean;
        runDays?: string[];
        skipOnLeave?: boolean;
    }): Record<string, unknown> {
        const existing = this.store.get().schedules.find((s) => s.id === input.scheduleId);
        if (!existing) return { error: "No watcher with that id." };

        if (input.everyMinutes !== undefined && input.dailyAt !== undefined) {
            return { error: "Pick one of everyMinutes or dailyAt, not both." };
        }

        const runDays = parseRunDays(input.runDays);
        if (runDays instanceof Error) return { error: runDays.message };

        let cadence: Cadence | undefined;
        if (input.dailyAt !== undefined) {
            if (!isValidTime(input.dailyAt)) {
                return { error: "dailyAt must be a 24h local time like '08:30'." };
            }
            cadence = { kind: "daily", time: input.dailyAt.trim() };
        } else if (input.everyMinutes !== undefined) {
            if (!Number.isFinite(input.everyMinutes)) {
                return { error: "everyMinutes must be a number of minutes, minimum 5." };
            }
            cadence = { kind: "interval", minutes: Math.max(5, Math.round(input.everyMinutes)) };
        }

        this.store.update((state) => {
            const target = state.schedules.find((s) => s.id === input.scheduleId);
            if (!target) return;
            if (input.title !== undefined) target.title = clip(input.title, 42);
            if (input.task !== undefined) target.task = input.task;
            if (input.quiet !== undefined) target.quiet = input.quiet;
            if (input.enabled !== undefined) target.enabled = input.enabled;
            if (runDays !== undefined) {
                // An empty list means "no day restriction", not "never run".
                target.runDays = runDays.length === 7 || runDays.length === 0 ? undefined : runDays;
            }
            if (input.skipOnLeave !== undefined) target.skipOnLeave = input.skipOnLeave;
            // Set by hand now, so the prose migration must never touch it.
            if (runDays !== undefined || input.skipOnLeave !== undefined) {
                target.suppressionDerived = true;
            }
            if (input.archived !== undefined) {
                target.archived = input.archived;
                target.archivedAt = input.archived ? Date.now() : undefined;
                // Archiving is a retirement, not a pause with a hidden clock.
                if (input.archived) target.enabled = false;
            }
            if (cadence) {
                target.cadence = cadence;
                // The user has just told us how often they want this; whatever
                // back-off it had drifted into is no longer their intent.
                clearBackoff(target);
            }
            // A new cadence — or a watcher just switched back on — needs its
            // clock restarted; everything else leaves the next tick alone.
            // A one-off that has already gone off is never restarted: its one
            // moment is spent, whatever flags get flipped afterwards.
            const silenceChanged = runDays !== undefined || input.skipOnLeave !== undefined;
            if (
                (cadence || silenceChanged || input.enabled === true || input.archived === false) &&
                isRunnable(target)
            ) {
                target.nextRunAt = nextAllowedRunFor(target, state.leave);
            }
        });
        this.persistSchedules();

        const updated = this.store.get().schedules.find((s) => s.id === input.scheduleId);
        if (!updated) return { error: "No watcher with that id." };
        this.log({
            kind: "schedule.updated",
            title: updated.title,
            detail: isArchived(updated) ? "archived" : describeCadence(updated.cadence),
            scheduleId: updated.id,
        });
        this.store.flush();

        return {
            scheduleId: updated.id,
            title: updated.title,
            task: updated.task,
            cadence: describeSchedule(updated),
            enabled: updated.enabled,
            archived: isArchived(updated),
            quiet: updated.quiet,
            silence: describeSuppression(updated) || undefined,
            runCount: updated.runCount,
            nextRun: isRunnable(updated) ? new Date(updated.nextRunAt).toLocaleString() : undefined,
            lastResult: updated.lastResult ? clip(updated.lastResult, 200) : undefined,
        };
    }

    removeSchedule(scheduleId: string): boolean {
        const existed = this.store.get().schedules.some((schedule) => schedule.id === scheduleId);
        if (!existed) return false;
        this.store.update((state) => {
            state.schedules = state.schedules.filter((schedule) => schedule.id !== scheduleId);
        });
        this.persistSchedules();
        this.store.flush();
        return true;
    }

    setScheduleEnabled(scheduleId: string, enabled: boolean): void {
        this.store.update((state) => {
            const schedule = state.schedules.find((s) => s.id === scheduleId);
            if (!schedule) return;
            schedule.enabled = enabled;
            if (isRunnable(schedule)) schedule.nextRunAt = nextAllowedRunFor(schedule, state.leave);
        });
        this.persistSchedules();
        this.store.flush();
    }

    /**
     * Retire a watcher, or bring it back. Unlike deleting, everything it ever
     * reported stays on disk — archiving is for tidying the list, not for
     * forgetting. A retired watcher never ticks again while it is archived.
     */
    setScheduleArchived(scheduleId: string, archived: boolean): void {
        this.store.update((state) => {
            const schedule = state.schedules.find((s) => s.id === scheduleId);
            if (!schedule) return;
            schedule.archived = archived;
            schedule.archivedAt = archived ? Date.now() : undefined;
            if (archived) schedule.enabled = false;
            if (isRunnable(schedule)) schedule.nextRunAt = nextAllowedRunFor(schedule, state.leave);
        });
        this.persistSchedules();
        this.store.flush();
    }

    /** Fire a watcher now. Returns false if it's missing or already in flight. */
    runSchedule(scheduleId: string, options: { slotAt?: number } = {}): boolean {
        const schedule = this.store.get().schedules.find((s) => s.id === scheduleId);
        if (!schedule) return false;
        // Archived means retired. Nothing — not a tick, not a manual nudge —
        // brings one back without un-archiving it first.
        if (isArchived(schedule)) return false;
        if (schedule.activeAgentId) {
            const active = this.findAgent(schedule.activeAgentId);
            if (active && isLive(active)) return false;
        }

        const parts = [schedule.task, previousRunBlock(schedule)];
        if (schedule.quiet) {
            parts.push(
                "If there is genuinely nothing worth interrupting the user for, reply with exactly: NOTHING TO REPORT",
            );
        }
        // Every watcher gets this, quiet or not. Without somewhere to put "I
        // could not look", an agent that has lost its tool reaches for the
        // silence sentinel — and silence is indistinguishable from all-clear.
        parts.push(
            [
                "If you could not actually check — a tool you needed is missing, a search errored,",
                "an account is not signed in — do NOT reply NOTHING TO REPORT and do not guess.",
                "Begin your reply with exactly: COULD NOT CHECK",
                "followed by one short sentence saying what stopped you. Reporting nothing found is",
                "only honest when you were able to look.",
            ].join("\n"),
        );
        const task = parts.filter(Boolean).join("\n\n");
        const spawned = this.spawnAgent(schedule.title, task, undefined, {
            scheduleId: schedule.id,
            announce: false,
        });
        const agentId = spawned.agentId as string | undefined;

        this.store.update((state) => {
            const target = state.schedules.find((s) => s.id === scheduleId);
            if (!target) return;
            target.lastRunAt = Date.now();
            target.lastRunDay = localDay(target.lastRunAt);
            // Only a run fired *for* a slot discharges it. A manual nudge has
            // no slot, so it leaves the day's scheduled run still owing.
            if (options.slotAt !== undefined) target.lastSlotAt = options.slotAt;
            target.runCount += 1;
            target.activeAgentId = agentId;
            // A one-off is spent the moment it fires: `runCount` now marks it
            // as fired, so no tick can pick it up again while it reports. It
            // is archived for good once that report lands.
            if (target.cadence.kind === "once") {
                target.enabled = false;
                target.nextRunAt = target.lastRunAt;
            } else {
                target.nextRunAt = nextAllowedRunFor(target, state.leave);
            }
        });
        this.persistSchedules();
        this.log({
            kind: "schedule.run",
            title: schedule.title,
            scheduleId: schedule.id,
            agentId,
        });
        this.store.flush();
        return true;
    }

    /**
     * Daily watchers whose slot passed while the machine was asleep run on the
     * next launch — that's what makes "brief me when I start my day" work.
     *
     * Three things keep that from turning into a stampede after a long gap: a
     * missed slot is only honoured while it is still roughly current, a daily
     * watcher runs at most once per local day, and whatever survives both is
     * spaced out rather than fired all at once.
     */
    private catchUpSchedules(): void {
        const now = Date.now();
        const due: Array<{ id: string; slotAt?: number }> = [];

        for (const schedule of this.store.get().schedules) {
            if (!isRunnable(schedule)) continue;
            if (schedule.nextRunAt > now && schedule.cadence.kind !== "daily") continue;
            if (this.skipSuppressed(schedule, now)) continue;
            if (schedule.cadence.kind === "once") {
                if (schedule.nextRunAt <= now) due.push({ id: schedule.id });
                continue;
            }

            const decision = catchUpDecision(schedule, now);
            this.store.update((state) => {
                const target = state.schedules.find((s) => s.id === schedule.id);
                if (target) target.nextRunAt = decision.nextRunAt;
            });
            if (decision.run) due.push({ id: schedule.id, slotAt: decision.slotAt });
        }

        this.persistSchedules();

        // Spaced, not simultaneous: several agents starting in the same
        // millisecond fight for the runtime and land as one wall of text.
        due.forEach((entry, index) => {
            if (index === 0) {
                this.runSchedule(entry.id, { slotAt: entry.slotAt });
                return;
            }
            const timer = setTimeout(() => {
                this.catchUpTimers.delete(timer);
                if (this.store.get().runtime === "ready") {
                    this.runSchedule(entry.id, { slotAt: entry.slotAt });
                }
            }, index * Orchestrator.CATCH_UP_STAGGER_MS);
            this.catchUpTimers.add(timer);
        });
    }

    /** Gap between staggered catch-up runs at launch. */
    private static readonly CATCH_UP_STAGGER_MS = 45_000;

    private tickSchedules(): void {
        const now = Date.now();
        for (const schedule of this.store.get().schedules) {
            if (!isRunnable(schedule) || schedule.nextRunAt > now) continue;
            if (this.skipSuppressed(schedule, now)) continue;
            if (schedule.cadence.kind === "daily") {
                const decision = catchUpDecision(schedule, now);
                const slot = decision.slotAt;
                // The slot this tick is standing in for has already been served
                // — a stale `nextRunAt`, or a run that got there first. Roll on
                // without firing. Note this asks about the *slot*, not the day:
                // a manual run this morning must not eat tonight's scheduled one.
                // A watcher easing off after a run of silent days rolls on here
                // too: the slot exists, it is simply not this watcher's turn.
                if (
                    slot === undefined ||
                    slot > now ||
                    ranSlot(schedule, slot) ||
                    !dormancyAllows(schedule, slot)
                ) {
                    this.store.update((state) => {
                        const target = state.schedules.find((s) => s.id === schedule.id);
                        if (target) target.nextRunAt = decision.nextRunAt;
                    });
                    this.persistSchedules();
                    continue;
                }
                this.runSchedule(schedule.id, { slotAt: slot });
                continue;
            }
            this.runSchedule(schedule.id);
        }
    }

    private persistSchedules(): void {
        this.disk.saveSchedules(this.store.get().schedules);
    }

    // MARK: - Silence rules

    /** Leave periods currently on record. */
    private get leave(): LeavePeriod[] {
        return this.store.get().leave;
    }

    /**
     * Is this watcher barred from running right now — and if so, move it on.
     *
     * Checked here rather than inside `runSchedule` so that only the *clock* is
     * bound by the rules. When the user asks for a watcher by hand on a Sunday
     * they want it to run; the rule exists to stop unattended agents spending
     * his tokens on a day he is not reading them.
     *
     * A skipped run is not a quiet run: back-off measures how interesting a
     * watcher is, and letting a fortnight of leave double its interval would
     * punish it for the user's holiday.
     */
    private skipSuppressed(schedule: Schedule, now: number): boolean {
        const blocked = suppressionAt(schedule, this.leave, now);
        if (!blocked) return false;

        const nextRunAt = nextAllowedRunFor(schedule, this.leave, now);
        if (nextRunAt !== schedule.nextRunAt) {
            this.store.update((state) => {
                const target = state.schedules.find((s) => s.id === schedule.id);
                if (target) target.nextRunAt = nextRunAt;
            });
            this.persistSchedules();
        }
        this.log({
            kind: "schedule.skipped",
            title: schedule.title,
            detail: blocked.detail,
            scheduleId: schedule.id,
        });
        return true;
    }

    /**
     * Read the silence rules out of briefs that predate them being a property.
     *
     * Runs once per schedule, ever. Without this the feature ships inert: the
     * four watchers that motivated it would keep enforcing weekends in prose,
     * still spawning an agent each morning to be told it is Saturday. Any leave
     * dates found in the prose are lifted out too, so deleting the paragraph
     * later does not quietly delete the dates with it.
     */
    /**
     * Tell the nightly self-reflection about SOUL.md, once.
     *
     * The character file is useless if nothing ever writes to it, and the
     * reflection is the only process that looks back over a whole day. Its
     * brief is a user-authored schedule rather than a template in this file,
     * so the instruction has to be added to the record on disk. That is done
     * here, by the process that owns schedules.json, because an agent cannot:
     * orbit_update_schedule is on FORBIDDEN_AGENT_TOOL_NAMES, and a hand-edit
     * underneath a running app is overwritten on its next tick.
     *
     * Guarded twice. It only touches a live schedule whose title says it is a
     * reflection, and only one whose brief does not already mention the file,
     * so a brief he has since rewritten in his own words is left alone.
     */
    private teachReflectionAboutSoul(): void {
        const targets = this.store
            .get()
            .schedules.filter(
                (schedule) =>
                    !schedule.archived &&
                    /self[- ]?reflection/i.test(schedule.title) &&
                    needsSoulStep(schedule.task),
            )
            .map((schedule) => schedule.id);
        if (targets.length === 0) return;

        this.store.update((state) => {
            for (const schedule of state.schedules) {
                if (targets.includes(schedule.id)) schedule.task = withSoulStep(schedule.task);
            }
        });
        this.persistSchedules();
        for (const id of targets) {
            const schedule = this.store.get().schedules.find((entry) => entry.id === id);
            if (schedule) {
                this.log({ kind: "schedule.updated", title: schedule.title, detail: "taught to write SOUL.md" });
            }
        }
    }

    private migrateSuppression(): void {
        const derivedFor = new Map<string, ReturnType<typeof deriveSuppression>>();
        for (const schedule of this.store.get().schedules) {
            if (schedule.suppressionDerived) continue;
            derivedFor.set(schedule.id, deriveSuppression(schedule.task));
        }
        if (derivedFor.size === 0) return;

        const added: LeavePeriod[] = [];
        this.store.update((state) => {
            for (const schedule of state.schedules) {
                const derived = derivedFor.get(schedule.id);
                if (!derived) continue;
                schedule.suppressionDerived = true;
                // Never overwrite a rule already set by hand: the property is
                // the user's statement of intent, the prose is only a guess at it.
                if (derived.runDays && schedule.runDays === undefined) schedule.runDays = derived.runDays;
                if (derived.skipOnLeave && schedule.skipOnLeave === undefined) schedule.skipOnLeave = true;
                if (!derived.leave) continue;
                const known = [...state.leave, ...added].some(
                    (period) => period.from === derived.leave!.from && period.to === derived.leave!.to,
                );
                if (!known) {
                    added.push(
                        makeLeavePeriod(derived.leave.from, derived.leave.to, "read from a watcher's brief"),
                    );
                }
            }
            state.leave = [...state.leave, ...added];
        });

        this.persistSchedules();
        if (added.length > 0) this.disk.saveLeave(this.store.get().leave);

        const changed = this.store
            .get()
            .schedules.filter((schedule) => derivedFor.get(schedule.id) && describeSuppression(schedule));
        if (changed.length === 0) return;
        this.log({
            kind: "schedule.updated",
            title: "Silence rules",
            detail: changed
                .map((schedule) => `${schedule.title}: ${describeSuppression(schedule)}`)
                .join("; "),
        });
    }

    /** Record a stretch the user is away. Returns the period, or an error. */
    setLeave(from: string, to: string, note?: string): Record<string, unknown> {
        if (!isDayKey(from) || !isDayKey(to)) {
            return { error: "Dates must be local calendar days like '2026-08-21'." };
        }
        const period = makeLeavePeriod(from, to, note);
        this.store.update((state) => {
            state.leave = [...state.leave, period];
        });
        this.disk.saveLeave(this.leave);
        this.rescheduleForLeave();
        this.store.flush();
        return { leaveId: period.id, from: period.from, to: period.to, note: period.note };
    }

    /** Drop a recorded leave period. */
    clearLeave(leaveId: string): boolean {
        const existed = this.leave.some((period) => period.id === leaveId);
        if (!existed) return false;
        this.store.update((state) => {
            state.leave = state.leave.filter((period) => period.id !== leaveId);
        });
        this.disk.saveLeave(this.leave);
        this.rescheduleForLeave();
        this.store.flush();
        return true;
    }

    /**
     * Leave just moved, so every watcher that cares needs its clock redone —
     * both the ones now sleeping through it and the ones that were sleeping
     * through a period that has just been deleted.
     */
    private rescheduleForLeave(): void {
        const now = Date.now();
        this.store.update((state) => {
            for (const schedule of state.schedules) {
                if (!schedule.skipOnLeave || !isRunnable(schedule)) continue;
                schedule.nextRunAt = nextAllowedRunFor(schedule, state.leave, now);
            }
        });
        this.persistSchedules();
    }

    // MARK: - Meeting heads-ups

    /**
     * How far ahead the plan reaches. A timer further out than this would be
     * armed against a calendar that has since changed, so the day is re-scanned
     * instead — cheaper than being confidently wrong about the afternoon.
     */
    private static readonly MEETING_HORIZON_MS = 4 * 60 * 60 * 1000;

    /**
     * How often the plan is rebuilt while the day still has meetings in it, so
     * meetings added mid-day are caught. Days with nothing left, weekends and
     * the small hours all back off from here: see `nextCalendarScanDelay`.
     */
    private static readonly MEETING_RESCAN_MS = ACTIVE_RESCAN_MS;

    /**
     * How often to retry once it is established there is no calendar to read.
     *
     * On 23 August the scan ran twenty-nine times, every forty-six minutes from
     * midnight to half past nine at night, against an Outlook with no account
     * signed in. None of those runs could have succeeded and none of them was
     * cheap. A wall is worth re-checking a few times a day, not thirty-two.
     */
    private static readonly MEETING_BLIND_RESCAN_MS = 6 * 60 * 60 * 1000;

    /** The tag on the one open item that tracks a calendar nobody can read. */
    private static readonly CALENDAR_TAG = "[calendar]";

    /** Set while the last scan failed; cleared by the first that works. */
    private calendarProblem?: { problem: CalendarProblem; detail: string; runs: number };

    private lastCalendarScanAt = 0;

    /**
     * When the next scan is allowed to happen. Derived from what the last scan
     * found rather than fixed, so an empty day, a weekend and the small hours
     * all stop costing an agent run every 45 minutes.
     */
    private nextCalendarScanAt = 0;

    /** How long a scan may be in flight before it is written off as lost. */
    private static readonly SCAN_GIVE_UP_MS = 15 * 60 * 1000;

    /**
     * Keep today's per-meeting heads-ups armed.
     *
     * Built in rather than left to a user-created watcher on purpose: a watcher
     * fires on a cadence, and a heads-up has to land five minutes before a
     * specific event. So the calendar is read on a cadence and each meeting gets
     * its own timer.
     */
    private ensureMeetingPlan(): void {
        if (!this.settings.meetingHeadsUp) {
            this.clearMeetingTimers();
            return;
        }
        // Reading a calendar takes a calendar tool, and those arrive as MCP
        // servers. With none configured the scan agent has nothing to call: it
        // would flail, then burn a Copilot run doing it, on every launch. The
        // feature switches itself on once there is a server that could answer.
        if (!this.hasMcpServers()) {
            this.clearMeetingTimers();
            return;
        }
        // Same reasoning one step earlier: while the calendar's own MCP server is
        // down and being reconnected, a scan can only produce the AppleScript
        // fallback and a wrong diagnosis. It costs a Copilot run to get that
        // wrong, so it waits out the backoff. Only while it is *being* retried,
        // though — a server that has given up is never coming back on its own,
        // and a permanent skip here would silently switch meeting heads-ups off
        // for the session. The timers already armed are left alone either way,
        // because "I cannot check" is not "you are free".
        if (this.mcpCalendarOutage()?.state === "retrying") return;
        // A scan that never reports back — an agent cancelled out from under
        // us, say — must not wedge the feature for the rest of the session.
        if (this.scanningCalendar && Date.now() - this.lastCalendarScanAt < Orchestrator.SCAN_GIVE_UP_MS) {
            return;
        }

        const now = Date.now();
        if (this.meetingPlanDay !== localDay(now)) {
            // A new local day invalidates the plan — but the day turns over at
            // midnight, in the middle of the quiet window, and a scan there
            // only ever finds meetings hours too far out to arm. So the rollover
            // schedules the first scan rather than performing it.
            //
            // Only a real rollover, though. `meetingPlanDay` is also cleared to
            // force a scan when the user switches the feature on, and deferring
            // that to 06:30 because they happened to do it at eleven at night
            // makes a deliberate action look broken.
            const rollover = this.meetingPlanDay !== undefined;
            this.meetingPlanDay = localDay(now);
            this.nextCalendarScanAt = rollover && inQuietHours(now) ? quietWindowEnd(now) : 0;
        }
        if (now < this.nextCalendarScanAt) return;

        this.scanningCalendar = true;
        this.lastCalendarScanAt = now;
        // Provisional, so a scan that errors or never reports back cannot leave
        // the door open for another one on the very next tick.
        this.nextCalendarScanAt =
            now +
            (this.calendarProblem?.problem === "no-calendar"
                ? Orchestrator.MEETING_BLIND_RESCAN_MS
                : Orchestrator.MEETING_RESCAN_MS);

        const spawned = this.spawnAgent("Read today's calendar", CALENDAR_SCAN_TEMPLATE, undefined, {
            announce: false,
            onResult: (agent) => {
                this.scanningCalendar = false;
                if (agent.status !== "done") return;
                const plan = readMeetingPlan(agent.result ?? "");
                this.applyMeetingPlan(plan);
                this.nextCalendarScanAt =
                    Date.now() +
                    nextCalendarScanDelay(
                        Date.now(),
                        plan,
                        Orchestrator.MEETING_HORIZON_MS,
                        Orchestrator.MEETING_BLIND_RESCAN_MS,
                    );
            },
        });
        // The agent cap and a missing runtime both come back as an error rather
        // than an id; either way there is nothing in flight to wait for.
        if (spawned.agentId === undefined) this.scanningCalendar = false;
    }

    /**
     * Act on a scan, which now includes the case where there was nothing to act
     * on.
     *
     * The important branch is the failure one, and specifically what it does
     * *not* do: it does not adopt an empty plan. Disarming every heads-up
     * because the calendar could not be reached turns "I don't know" into "you
     * are free", silently, on a cadence — which is how a blind calendar went
     * unnoticed for weeks.
     */
    private applyMeetingPlan(plan: MeetingPlan): void {
        if (plan.ok) {
            const wasBlind = this.calendarProblem !== undefined;
            this.calendarProblem = undefined;
            if (wasBlind) this.reconcileCalendarAccess();
            this.adoptMeetingPlan(plan.meetings);
            return;
        }

        this.calendarProblem = {
            problem: plan.problem,
            detail: plan.detail,
            runs: (this.calendarProblem?.runs ?? 0) + 1,
        };
        console.log(`[orbit] calendar scan failed (${plan.problem}): ${plan.detail}`);
        this.reconcileCalendarAccess();
    }

    /**
     * Keep exactly one open item in step with whether the calendar is readable.
     *
     * Same shape as the freshness check, and for the same reason: the fact is
     * rediscovered on every scan, so it has to be stated once and withdrawn by
     * the code that finds it fixed, rather than repeated until it is believed.
     * Only "no calendar" is worth raising — a single unreadable reply is more
     * likely a bad run than a broken account, and the retry costs nothing.
     */
    private reconcileCalendarAccess(): void {
        const tag = Orchestrator.CALENDAR_TAG;
        const existing = this.store
            .get()
            .openItems.find((item) => !item.resolved && item.text.startsWith(tag));

        if (this.calendarProblem?.problem !== "no-calendar") {
            if (existing) this.resolveOpenItem(existing.id, "A calendar scan succeeded.");
            return;
        }
        // Already asked. The answer is a sign-in, and nagging does not perform it.
        if (existing) return;

        // A scan agent with no calendar tool does not report "I have no calendar
        // tool" — it falls back to AppleScript, is refused, and reports a
        // permissions problem. On 15 September that turned an MCP server that had
        // failed to load into two runs telling the user to go and fix Calendar.app
        // permissions that were never the cause. So the server is checked before
        // the user is blamed, and the reconnect in `retryMcpServers` is left to do
        // its work rather than raising a decision nobody can action.
        const outage = this.mcpCalendarOutage();
        if (outage?.state === "retrying") {
            console.log(
                `[orbit] calendar unreadable while the ${outage.name} MCP server is down; waiting for the reconnect before blaming anything`,
            );
            return;
        }

        // Past retrying there is nothing left to wait for, so the item is raised
        // — but with the real cause in front of the scan's guess, because the
        // scan's guess in that situation is always the AppleScript fallback.
        const cause = outage
            ? `The ${outage.name} MCP server never started, which is where your calendar comes from. `
            : "";
        const detail = this.calendarProblem.detail;
        this.raiseOpenItem(
            `${tag} I cannot read your calendar, so I have no idea what is in your day. ${cause}${detail}`,
            "calendar scan",
        );
        this.say(`${cause}${calendarUnavailableMessage(detail)}`);
    }

    /**
     * A down MCP server that was supposed to be supplying the calendar, if there
     * is one. Matched on the capability rather than the server name, so a
     * differently-named mail server is still covered.
     */
    private mcpCalendarOutage(): McpHealth | undefined {
        for (const health of this.mcpHealth.values()) {
            if (health.state === "connected") continue;
            if (capabilityOf(health.name).includes("calendar")) return health;
        }
        return undefined;
    }

    /** Replace the armed timers with the ones this plan calls for. */
    private adoptMeetingPlan(meetings: Meeting[]): void {
        this.clearMeetingTimers();
        const now = Date.now();
        // Kept as well as armed. The board's anticipation reads the whole day,
        // not just the four hours worth arming a timer for, and re-deriving it
        // from the timers would only ever see the window they cover.
        this.meetings = meetings.filter((meeting) => meeting.start >= now);
        for (const meeting of armableMeetings(meetings, now, Orchestrator.MEETING_HORIZON_MS)) {
            // Keyed on more than the agent's id: occurrences of a recurring
            // series often share one, and a key collision would overwrite a
            // live timer handle, leaving a heads-up armed that nothing can
            // cancel. Belt and braces, any existing timer is cleared first.
            const key = `${meeting.id}|${meeting.start}`;
            const existing = this.meetingTimers.get(key);
            if (existing) clearTimeout(existing);
            const timer = setTimeout(() => {
                this.meetingTimers.delete(key);
                if (this.store.get().runtime === "ready") this.fireMeetingHeadsUp(meeting);
            }, headsUpAt(meeting) - now);
            this.meetingTimers.set(key, timer);
        }
        if (this.meetingTimers.size > 0) {
            console.log(`[orbit] armed ${this.meetingTimers.size} meeting heads-up(s)`);
            // Durable, unlike the console line: a later review can ask whether
            // this ever armed against a real calendar and get an answer.
            this.log({
                kind: "meeting.armed",
                title: `Armed ${this.meetingTimers.size} meeting heads-up(s)`,
                detail: [...this.meetingTimers.keys()].join(", "),
            });
        }
    }

    private clearMeetingTimers(): void {
        for (const timer of this.meetingTimers.values()) clearTimeout(timer);
        this.meetingTimers.clear();
    }

    /**
     * Five minutes out. The reminder itself lands immediately — it is the one
     * part that is useless late — and the prep, when the shape justifies any,
     * follows as an ordinary agent report.
     */
    private fireMeetingHeadsUp(meeting: Meeting): void {
        // Re-checked at fire time, not just at arming time: the user may have
        // turned heads-ups off in the five minutes since.
        if (!this.settings.meetingHeadsUp) return;

        const shape = classifyMeeting(meeting);
        const line = headsUpLine(meeting, shape);
        this.say(line);
        this.nudge(line);
        this.log({
            kind: "meeting.headsup",
            title: meeting.subject,
            detail: `${shape}${wantsPrep(shape) ? ", prep spawned" : ", no prep"}`,
        });

        if (!wantsPrep(shape)) {
            this.store.flush();
            return;
        }

        this.spawnAgent(`Prep: ${meeting.subject}`, prepBriefFor(meeting, shape, this.meetingContext(meeting)), undefined, {
            announce: false,
            onResult: (agent) => this.deliverMeetingPrep(meeting, agent),
        });
        this.store.flush();
    }

    /** Prep that found nothing stays silent; five minutes is no time for noise. */
    private deliverMeetingPrep(meeting: Meeting, agent: AgentView): void {
        const report = agent.result?.trim();
        if (agent.status !== "done" || !report || /^nothing to report$/i.test(report)) return;

        this.pushMessage({
            role: "system",
            text: report,
            kind: { type: "completion", agentId: agent.id },
        });
        if (!this.store.get().chatOpen) {
            this.setBubble(`🔔 ${meeting.subject} — ${summarise(report, 120)}`);
        }
    }

    /**
     * What Orbit already knows that bears on this meeting, handed to the prep
     * agent as context. Open items and memories live in Orbit's own store,
     * which a delegated agent cannot see, so anything relevant has to travel
     * with the brief.
     */
    private meetingContext(meeting: Meeting): string {
        const state = this.store.get();
        const shape = classifyMeeting(meeting);
        const names = meeting.others.map((name) => name.toLowerCase());
        // For a 1:1 the filter is the whole point; for a group it would throw
        // away the parking-lot items the standup prep is asking for.
        const relevant = (text: string): boolean =>
            shape !== "one-on-one" || names.some((name) => mentions(text, name));

        const items = state.openItems
            .filter((item) => !item.resolved && relevant(item.text))
            .slice(-6)
            .map((item) => `- open item: ${item.text} (raised ${elapsed(item.createdAt)} ago)`);
        const memories = state.memories
            .filter((memory) => relevant(memory.text))
            .slice(-8)
            .map((memory) => `- ${memory.category}: ${memory.text}`);

        return [...items, ...memories].join("\n");
    }

    // MARK: - Memory

    remember(
        text: string,
        category: MemoryNote["category"],
        source: MemoryNote["source"],
    ): Record<string, unknown> {
        const trimmed = clip(text, 240);
        const duplicate = this.store
            .get()
            .memories.find((memory) => memory.text.toLowerCase() === trimmed.toLowerCase());
        if (duplicate) return { ok: true, note: "Already remembered.", memoryId: duplicate.id };

        const memory: MemoryNote = {
            id: randomUUID(),
            text: trimmed,
            category,
            createdAt: Date.now(),
            source,
        };
        this.store.update((state) => {
            state.memories.push(memory);
        });
        this.disk.saveMemories(this.store.get().memories);
        this.log({ kind: "memory.saved", title: trimmed, detail: category });
        this.store.flush();
        return { ok: true, memoryId: memory.id };
    }

    /**
     * Repair a memory in place. The old wording is retired against the record
     * rather than dropped, so nothing is destroyed and an agent can be trusted
     * with it. See `memory.ts` for why this exists alongside `forget`.
     */
    correctMemory(memoryId: string, correction: MemoryCorrection): Record<string, unknown> {
        const outcome = applyMemoryCorrection(this.store.get().memories, memoryId, correction, Date.now());
        if (outcome.error) return { error: outcome.error };
        if (outcome.corrected && outcome.note) return { ok: true, note: outcome.note, memoryId };

        this.store.update((state) => {
            state.memories = outcome.memories;
        });
        this.disk.saveMemories(this.store.get().memories);
        this.log({
            kind: "memory.saved",
            title: outcome.corrected?.text ?? "",
            detail: `corrected${correction.reason ? `: ${correction.reason}` : ""}`,
        });
        this.store.flush();
        return { ok: true, memoryId, corrected: outcome.corrected?.text };
    }

    forget(memoryId: string): void {
        this.store.update((state) => {
            state.memories = state.memories.filter((memory) => memory.id !== memoryId);
        });
        this.disk.saveMemories(this.store.get().memories);
        this.store.flush();
    }

    // MARK: - Open items

    /**
     * Only re-raise while the user is actually around to answer. The gap
     * between askings, and which items are chosen, live in `openItems.ts`.
     */
    private static readonly RECENT_INTERACTION_MS = 30 * 60 * 1000;

    private outstandingItems(): OpenItem[] {
        return selectOutstanding(this.store.get().openItems, OPEN_ITEM_CAP);
    }

    private openItemsBlock(items: OpenItem[], asNudge = false): string {
        const lines = items
            .map((item) => {
                const age = elapsed(item.createdAt);
                const from = item.source ? ` — from ${item.source}` : "";
                const chased = describeChasing(item);
                const chasing = chased ? `, ${chased}` : "";
                return `- ${item.text} (raised ${age} ago${chasing}${from}) id=${item.id}`;
            })
            .join("\n");
        return [
            "<open_items>",
            "Decisions you have asked for and not yet received. They are yours to chase:",
            lines,
            "",
            OPEN_ITEM_GUIDANCE,
            ...(asNudge ? ["", SILENCE_AFFORDANCE] : []),
            "</open_items>",
        ].join("\n");
    }

    /**
     * File a decision that needs the user. Deduplicated on text so a nightly
     * reflection that reaches the same conclusion twice does not nag twice.
     */
    raiseOpenItem(text: string, source?: string): Record<string, unknown> {
        const trimmed = clip(text, 300);
        if (!trimmed) return { error: "An open item needs some text." };

        const duplicate = this.store
            .get()
            .openItems.find(
                (item) => !item.resolved && item.text.toLowerCase() === trimmed.toLowerCase(),
            );
        if (duplicate) return { ok: true, note: "Already outstanding.", openItemId: duplicate.id };

        const item: OpenItem = {
            id: randomUUID(),
            text: trimmed,
            createdAt: Date.now(),
            resolved: false,
            source: source ? clip(source, 60) : undefined,
            lastRaisedAt: Date.now(),
        };
        this.store.update((state) => {
            state.openItems.push(item);
        });
        this.persistOpenItems();
        this.log({ kind: "open.raised", title: trimmed, detail: item.source });
        this.store.flush();
        this.refreshBoard();
        return { ok: true, openItemId: item.id };
    }

    /**
     * Settle an item. Kept on the list with `resolved` set rather than deleted,
     * so an answered proposal can still be looked back at; the tail is pruned
     * so the file cannot grow forever.
     */
    resolveOpenItem(openItemId: string, resolution?: string): boolean {
        const found = findById(
            this.store.get().openItems.filter((entry) => !entry.resolved),
            openItemId,
        );
        if (found.status !== "ok") return false;
        const existing = found.item;
        this.store.update((state) => {
            const item = state.openItems.find((entry) => entry.id === existing.id);
            if (!item) return;
            item.resolved = true;
            item.resolvedAt = Date.now();
            item.resolution = resolution ? clip(resolution, 200) : undefined;
            state.openItems = pruneResolved(state.openItems);
        });
        this.persistOpenItems();
        this.log({
            kind: "open.resolved",
            title: existing.text,
            detail: resolution ? clip(resolution, 200) : undefined,
        });
        this.store.flush();
        this.refreshBoard();
        return true;
    }

    /**
     * Note that the user opened one of the artifacts on the board.
     *
     * Separate from actually opening the file, and called alongside it, so that
     * a ledger that will not write can never be the reason a document does not
     * open. Idempotent: the first open is the one that counts, because the
     * question this answers is "has he ever looked at this", not "when last".
     */
    markArtifactOpened(activityId: string): boolean {
        const found = findById(this.activity, activityId);
        if (found.status !== "ok") return false;
        const entry = found.item;
        if (entry.openedAt !== undefined) return true;
        entry.openedAt = Date.now();
        this.persistActivity();
        this.refreshBoard();
        return true;
    }

    /**
     * Put stale decisions back in front of the user. Runs off the same slow
     * timer as the watchers, and only when they are at the desk and Orbit is
     * not already mid-thought — a reminder that interrupts is worse than none.
     */
    private reRaiseOpenItems(): void {
        const state = this.store.get();
        if (state.orbitBusy || !this.orbit) return;
        if (Date.now() - state.lastInteractionAt > Orchestrator.RECENT_INTERACTION_MS) return;
        if (!this.mayInterrupt("open decisions")) return;

        const now = Date.now();
        const due = selectForReRaise(state.openItems, now);
        if (due.length === 0) return;

        // Stamp only what is actually being shown. Marking an item raised when
        // it was left out of the batch resets its silence without anyone having
        // seen it, which is how items went unasked for days in the first place.
        const ids = new Set(due.map((item) => item.id));
        this.store.update((s) => {
            s.openItems = s.openItems.map((item) =>
                ids.has(item.id) ? noteRaised(item, now) : item,
            );
        });
        this.persistOpenItems();
        this.nudgeOrbit(this.openItemsBlock(due, true));
    }

    private persistOpenItems(): void {
        this.disk.saveOpenItems(this.store.get().openItems);
    }

    // MARK: - Running build

    /**
     * Tell the model what it is actually running.
     *
     * Without this Orbit answers "is X working?" from the source it can read
     * rather than the binary it is, which is how a shipped-and-merged feature
     * got reported as a regression on 17 August. Stated plainly and near the end
     * of the prompt so it is hard to miss.
     */
    private freshnessBlock(): string | undefined {
        const freshness = this.freshness;
        if (!freshness?.summary) return undefined;
        return [
            "<running_build>",
            freshness.summary,
            "",
            "You are not running the code currently on disk. Before claiming any recent",
            "change works, or diagnosing a feature as broken, say so: the likeliest",
            "explanation for 'this used to work' is this, not a regression. Offer to",
            "rebuild and restart.",
            "</running_build>",
        ].join("\n");
    }

    /**
     * Keep exactly one open item in step with reality.
     *
     * Raised when the running build falls behind and resolved by the same code
     * once a restart has caught it up, so the reminder cannot outlive the
     * problem and nobody has to remember to close it. The decision itself lives
     * in `decideFreshnessAction`, where it can be checked without a store.
     */
    private reconcileFreshness(): void {
        const existing = this.store
            .get()
            .openItems.find((item) => !item.resolved && item.text.startsWith(FRESHNESS_TAG));

        const action = decideFreshnessAction(existing, this.freshness);
        switch (action.kind) {
            case "none":
                return;
            case "resolve":
                if (existing) this.resolveOpenItem(existing.id, action.reason);
                return;
            case "replace":
                if (existing) this.resolveOpenItem(existing.id, action.reason);
                this.raiseOpenItem(action.text, action.source);
                return;
            case "raise":
                this.raiseOpenItem(action.text, action.source);
                return;
        }
    }

    /**
     * Re-measure whether the running code is the written code.
     *
     * Measuring this once at launch could only ever catch a process started from
     * an already-stale build. The case the check exists for is the opposite one:
     * a build that lands *underneath* a running process, which is what happens
     * every night when Orbit edits and rebuilds itself. Between 11 and 13
     * September that went unreported for two days, because the answer was
     * computed at 21:41 on the 11th and never looked at again.
     */
    private refreshFreshness(): void {
        if (!this.freshnessProbe) return;
        try {
            this.freshness = this.freshnessProbe();
        } catch {
            // A housekeeping check must never take the tick loop down with it.
            return;
        }
        this.reconcileFreshness();
        this.maybeAutoRestart();
    }

    /**
     * Apply a waiting build instead of asking someone to.
     *
     * Everything needed for this already existed and was never joined up: Orbit
     * could tell it was stale, and it could restart itself safely while keeping
     * the conversation. All that sat between them was a note asking a human,
     * which went unactioned five nights running while ten merged commits and two
     * builds never executed. The decision is in `decideAutoRestart` so the
     * safety conditions can be checked without a process to kill.
     */
    private maybeAutoRestart(): void {
        if (!this.onSoftRestart || this.restarting) return;

        const state = this.store.get();
        const decision = decideAutoRestart(
            {
                state: this.freshness?.state ?? "unknown",
                builtAt: this.freshness?.builtAt,
                busy: state.orbitBusy,
                agentsActive: state.agents.some(
                    (agent) =>
                        agent.status === "queued" ||
                        agent.status === "running" ||
                        agent.status === "needs-input",
                ),
                awaitingUser: state.requests.length > 0,
                lastInteractionAt: state.lastInteractionAt,
                alreadyTriedBuildAt: this.disk.loadAutoRestartMark(),
            },
            Date.now(),
        );
        if (!decision.restart) return;

        // Marked before the relaunch, never after: a process that does not come
        // back must still count as having tried.
        this.disk.saveAutoRestartMark(decision.builtAt);
        console.log(`[orbit] auto-restart: ${decision.because}`);
        this.softRestart();
    }

    // MARK: - Activity ledger

    /**
     * Record something done on the user's behalf.
     *
     * Deduplicated on kind plus location, so an agent that reports the same file
     * twice — or a report re-parsed after a restart — updates the existing entry
     * rather than growing a second copy of it. Text alone is not enough to
     * dedupe on: "wrote the plan" is a sentence two different files can share.
     */
    recordActivity(input: ActivityInput): Record<string, unknown> {
        const description = clip(input.description, 200);
        if (!description) return { error: "An activity entry needs a description." };

        const entry = makeActivityEntry({
            ...input,
            description,
            location: input.location ? clip(input.location, 400) : undefined,
            request: input.request ? clip(input.request, 200) : undefined,
            agentTitle: input.agentTitle ? clip(input.agentTitle, 60) : undefined,
            note: input.note ? clip(input.note, 200) : undefined,
            waitingOn: input.waitingOn ? clip(input.waitingOn, 60) : undefined,
        });

        const duplicate = entry.location
            ? this.activity.find(
                  (existing) => existing.kind === entry.kind && existing.location === entry.location,
              )
            : undefined;
        if (duplicate) {
            duplicate.description = entry.description;
            duplicate.status = entry.status;
            duplicate.statusChangedAt = Date.now();
            if (entry.waitingOn) duplicate.waitingOn = entry.waitingOn;
            this.persistActivity();
            return { ok: true, activityId: duplicate.id, note: "Already in the ledger; refreshed it." };
        }

        this.activity.push(entry);
        this.persistActivity();
        this.log({
            kind: "activity.recorded",
            title: description,
            detail: entry.location ?? entry.kind,
            agentId: entry.agentId,
        });
        this.refreshBoard();
        return { ok: true, activityId: entry.id };
    }

    /** The ledger, filtered and capped for a narrow panel. Most recent first. */
    listActivity(filter: ActivityFilter = {}): Record<string, unknown> {
        const matches = filterActivity(this.activity, filter);
        return {
            total: this.activity.length,
            activity: matches.map((entry) => ({
                activityId: entry.id,
                day: entry.day,
                kind: entry.kind,
                status: entry.status,
                description: entry.description,
                location: entry.location,
                request: entry.request,
                agentTitle: entry.agentTitle,
                note: entry.note,
                waitingOn: entry.waitingOn,
                age: elapsed(entry.at),
            })),
        };
    }

    /** Move an entry along. The only way anything ever leaves the chase list. */
    updateActivity(
        activityId: string,
        status?: ActivityStatus,
        note?: string,
        waitingOn?: string,
    ): Record<string, unknown> {
        const found = findById(this.activity, activityId);
        if (found.status !== "ok") return { error: describeMiss(found, "activity entry") };
        const entry = found.item;
        if (!status && !note && waitingOn === undefined) {
            return { error: "Give a status, a note, someone to wait on, or all three." };
        }

        if (status && status !== entry.status) {
            entry.status = status;
            entry.statusChangedAt = Date.now();
            // A fresh status starts the chase clock over rather than inheriting
            // the back-off earned while it was stuck.
            entry.chaseCount = 0;
            entry.lastChasedAt = undefined;
        }
        if (note) entry.note = clip(note, 200);
        // An empty string is how the caller says "they came back". Distinct from
        // omitting it, which leaves whoever is owed exactly as it was.
        if (waitingOn !== undefined) {
            const trimmed = clip(waitingOn, 60);
            entry.waitingOn = trimmed.length > 0 ? trimmed : undefined;
        }

        this.persistActivity();
        this.log({ kind: "activity.updated", title: `${entry.status}: ${entry.description}`, detail: entry.note });
        this.refreshBoard();
        return { ok: true, activityId: entry.id, status: entry.status, waitingOn: entry.waitingOn };
    }

    /**
     * Put stale work back in front of Orbit.
     *
     * Deliberately the same mechanism open items use — `notifyOrbit`, on the
     * slow tick, only while the user is at the desk and Orbit is not mid-thought
     * — rather than a second nagging channel with its own rules. The cap and the
     * per-entry back-off live in `activity.ts`.
     */
    private chaseStaleActivity(): void {
        const state = this.store.get();
        if (state.orbitBusy || !this.orbit) return;
        if (Date.now() - state.lastInteractionAt > Orchestrator.RECENT_INTERACTION_MS) return;
        if (!this.mayInterrupt("unfinished work")) return;

        const due = chaseableActivity(this.activity);
        if (due.length === 0) return;

        for (const entry of due) {
            entry.lastChasedAt = Date.now();
            entry.chaseCount = (entry.chaseCount ?? 0) + 1;
        }
        this.persistActivity();
        this.nudgeOrbit(`${activityChaseBlock(due)}\n\n${SILENCE_AFFORDANCE}`);
    }

    /**
     * Whether a self-initiated chase may interrupt right now.
     *
     * The gate the per-item back-off in `openItems.ts` could not be: it throttles
     * the channel rather than the queue, so fifty individually-patient decisions
     * cannot add up to a message every five minutes. Logged when it refuses,
     * because a loop that has gone quiet and cannot say so is indistinguishable
     * from one that has broken.
     */
    private mayInterrupt(what: string): boolean {
        const verdict = decideInterrupt(
            {
                unanswered: this.unansweredTurns,
                lastProactiveAt: this.lastProactiveAt,
                fruitless: this.fruitlessNudges,
                lastNudgeAt: this.lastNudgeAt,
            },
            Date.now(),
        );
        if (!verdict.speak && process.env.ORBIT_DEBUG === "1") {
            console.log(`[orbit] holding ${what}: ${verdict.because}`);
        }
        return verdict.speak;
    }

    private persistActivity(): void {
        // The file keeps a bounded tail; the in-memory copy has to agree with it,
        // or a long-running session would keep quoting entries the next launch
        // will not have.
        if (this.activity.length > ACTIVITY_LIMIT) {
            this.activity = this.activity.slice(-ACTIVITY_LIMIT);
        }
        this.disk.saveActivity(this.activity);
    }

    /**
     * Fold a finished agent into the ledger.
     *
     * Two things happen: the dispatch entry stops being in flight, and every
     * file the report names — already rewritten to absolute paths, and confirmed
     * to exist — becomes an artifact entry of its own. That second half is the
     * whole point: a file mentioned once in a report that scrolls away is
     * exactly what "falling through the cracks" meant.
     */
    private recordAgentOutcome(agent: AgentView, report: string): void {
        const dispatch = this.activity.find(
            (entry) => entry.kind === "agent_dispatched" && entry.agentId === agent.id,
        );
        if (dispatch) {
            dispatch.status =
                agent.status === "done"
                    ? "delivered"
                    : agent.status === "cancelled"
                      ? "abandoned"
                      : "stalled";
            dispatch.statusChangedAt = Date.now();
            dispatch.note = clip(agent.error ?? summarise(report, 160), 200) || undefined;
        }

        if (agent.status === "done") {
            for (const path of artifactPathsIn(report)) {
                this.recordActivity({
                    kind: "artifact_written",
                    description: `${agent.title}: ${pathName(path)}`,
                    location: path,
                    request: clip(agent.task, 200),
                    agentId: agent.id,
                    agentTitle: agent.title,
                    status: "delivered",
                });
            }
        }

        this.persistActivity();
    }

    // MARK: - The self-modifiable prompt

    /**
     * Land a revision of Orbit's own operating notes.
     *
     * The gate is `checkRevision` and nothing else: it is pure, it is tested,
     * and refusing here rather than at the write means a rejected revision
     * never reaches disk at all. The built-in persona is not touched by any
     * path through this method; see the header of `selfPrompt.ts`.
     */
    reviseSystemPrompt(
        text: string,
        reason: string,
        author: PromptRevision["author"],
    ): Record<string, unknown> {
        const checked = checkRevision(text, reason);
        if (checked.error || !checked.text || !checked.reason) return { error: checked.error };

        if (checked.text === this.selfPrompt.trim()) {
            return { ok: true, note: "Already reads exactly that. Nothing recorded." };
        }

        const revision = nextRevision(this.promptRevisions, checked.text, checked.reason, author, new Date());
        if (!this.disk.writePromptRevision(revision)) {
            return { error: "Could not write the prompt file. Nothing changed." };
        }

        this.selfPrompt = revision.text;
        this.promptRevisions.push(revision);
        this.log({ kind: "prompt.revised", title: revision.reason, detail: `revision ${revision.revision}` });
        return {
            ok: true,
            revision: revision.revision,
            path: this.disk.systemPromptPath,
            note: "In effect at your next session start, like persona.md. Say so rather than acting as if it already applies.",
        };
    }

    /**
     * Restore an earlier revision by writing it forward as a new one. Never
     * rewinds the history: the record of the revision being rolled back stays
     * exactly where it was, which is the only thing that makes "why did we
     * change this back?" answerable later.
     */
    rollbackSystemPrompt(revision: number, reason?: string): Record<string, unknown> {
        const text = revisionText(this.promptRevisions, revision);
        if (text === undefined) {
            const known = this.promptRevisions.map((entry) => entry.revision);
            return {
                error: `No revision ${revision}. On file: ${known.length > 0 ? known.join(", ") : "none"}.`,
            };
        }
        const why = (reason ?? "").trim() || `Rolled back to revision ${revision}.`;
        return this.reviseSystemPrompt(text, why, "orbit");
    }

    // MARK: - The design language

    /**
     * Land a revision of how deliverables look.
     *
     * Same shape as `reviseSystemPrompt` on purpose. The floor is not applied
     * here because it is not text in this file: `designBlock` appends it below
     * whatever is written, every time a brief is built, so there is no state a
     * revision could put it into where it is missing.
     */
    reviseDesignLanguage(
        text: string,
        reason: string,
        author: PromptRevision["author"],
    ): Record<string, unknown> {
        const checked = checkDesignRevision(text, reason);
        if (checked.error || !checked.text || !checked.reason) return { error: checked.error };

        if (checked.text === this.designLanguage.trim()) {
            return { ok: true, note: "Already reads exactly that. Nothing recorded." };
        }

        const revision = nextRevision(this.designRevisions, checked.text, checked.reason, author, new Date());
        if (!this.disk.writeDesignRevision(revision)) {
            return { error: "Could not write the design language. Nothing changed." };
        }

        this.designLanguage = revision.text;
        this.designRevisions.push(revision);
        this.log({ kind: "prompt.revised", title: revision.reason, detail: `design revision ${revision.revision}` });
        return {
            ok: true,
            revision: revision.revision,
            path: this.disk.designLanguagePath,
            note: "Applies to the next agent dispatched. Documents already written are unchanged.",
        };
    }

    rollbackDesignLanguage(revision: number, reason?: string): Record<string, unknown> {
        const text = revisionText(this.designRevisions, revision);
        if (text === undefined) {
            const known = this.designRevisions.map((entry) => entry.revision);
            return {
                error: `No design revision ${revision}. On file: ${known.length > 0 ? known.join(", ") : "none"}.`,
            };
        }
        const why = (reason ?? "").trim() || `Rolled back to revision ${revision}.`;
        return this.reviseDesignLanguage(text, why, "orbit");
    }

    // MARK: - SOUL.md

    /**
     * Add to Orbit's character file. Append-only by construction: there is no
     * path here that rewrites what is already in it, which is the whole
     * difference between this and `reviseSystemPrompt`.
     */
    appendSoul(text: string): Record<string, unknown> {
        const entry = soulEntry(text, new Date());
        if (entry.error || !entry.addition) return { error: entry.error };
        if (!this.disk.appendSoul(entry.addition)) {
            return { error: "Could not write SOUL.md. Nothing was added." };
        }
        this.soul = `${this.soul}${entry.addition}`;
        this.log({ kind: "soul.appended", title: "SOUL.md", detail: `${entry.addition.trim().length} characters` });
        return { ok: true, path: this.disk.soulPath };
    }

    // MARK: - Evolution

    /**
     * What Orbit already knows about its own past, folded into the prompt.
     * Cheap enough to redo per session: the log is a small file, and reading it
     * fresh means a reflection that ran an hour ago is already in context.
     */
    private evolutionDigest(): string | undefined {
        let entries: EvolutionEntry[] = [];
        try {
            entries = parseEvolutionLog(this.disk.loadEvolutionLog());
        } catch (error) {
            // A malformed log is a bad prompt, not a failed launch.
            console.warn("[orbit] could not read the evolution log:", error);
        }
        this.proposals = this.disk.loadProposals();
        return evolutionBlock(entries, this.proposals);
    }

    /**
     * File a self-improvement. Deduplicated on text like open items, so a
     * reflection that reaches the same conclusion two nights running updates the
     * record rather than growing a second copy of it.
     */
    recordProposal(text: string, source?: string): Record<string, unknown> {
        const trimmed = clip(text, 400);
        if (!trimmed) return { error: "A proposal needs some text." };

        const duplicate = this.proposals.find(
            (proposal) => proposal.text.toLowerCase() === trimmed.toLowerCase(),
        );
        if (duplicate) {
            return {
                ok: true,
                note: `Already recorded, currently ${duplicate.status}.`,
                proposalId: duplicate.id,
                status: duplicate.status,
            };
        }

        const proposal: Proposal = {
            id: randomUUID(),
            text: trimmed,
            raisedAt: Date.now(),
            status: "proposed",
            source: source ? clip(source, 60) : undefined,
        };
        this.proposals.push(proposal);
        this.persistProposals();
        this.log({ kind: "proposal.raised", title: trimmed, detail: proposal.source });
        return { ok: true, proposalId: proposal.id };
    }

    /** Move a proposal along. The only way a proposal ever leaves "proposed". */
    updateProposal(
        proposalId: string,
        status: ProposalStatus,
        details: { note?: string; branch?: string; commit?: string; supersededBy?: string } = {},
    ): Record<string, unknown> {
        const found = findById(this.proposals, proposalId);
        if (found.status !== "ok") return { error: describeMiss(found, "proposal") };
        const proposal = found.item;

        proposal.status = status;
        proposal.statusChangedAt = Date.now();
        if (details.note) proposal.note = clip(details.note, 200);
        if (details.supersededBy) proposal.supersededBy = details.supersededBy;
        if (details.branch || details.commit) {
            proposal.shippedIn = {
                branch: details.branch ? clip(details.branch, 80) : proposal.shippedIn?.branch,
                commit: details.commit ? clip(details.commit, 40) : proposal.shippedIn?.commit,
            };
        }

        this.persistProposals();
        this.log({
            kind: "proposal.updated",
            title: `${status}: ${proposal.text}`,
            detail: proposal.note,
        });
        return { ok: true, proposalId: proposal.id, status };
    }

    private persistProposals(): void {
        this.disk.saveProposals(this.proposals);
    }

    // MARK: - Interaction log

    /**
     * A durable, append-only record of what was said and what it triggered.
     * Deliberately separate from `history`, which is a short in-app feed —
     * this one is written for a nightly job to mine for failure patterns.
     */
    private logInteraction(record: Omit<InteractionRecord, "at" | "sessionId">): void {
        try {
            this.disk.appendInteraction({
                at: new Date().toISOString(),
                sessionId: this.orbit?.sessionId ?? "no-session",
                ...record,
            });
        } catch (error) {
            // appendInteraction already swallows IO failures; this is belt and
            // braces so nothing here can ever reach the chat path.
            console.warn("[orbit] interaction log failed:", error);
        }
    }

    private logAgentEvent(
        agent: Pick<AgentView, "id" | "title">,
        event: NonNullable<InteractionRecord["agent"]>["event"],
        text: string,
    ): void {
        this.logInteraction({
            kind: "agent",
            role: "orbit",
            text: clip(text, 2000),
            agent: { id: agent.id, title: agent.title, event },
        });
    }

    /** Drains the tool buffer so each logged reply owns its calls exactly once. */
    private takeTurnTools(): LoggedToolCall[] | undefined {
        if (this.turnTools.size === 0) return undefined;
        const tools = [...this.turnTools.values()];
        this.turnTools.clear();
        return tools;
    }

    // MARK: - History

    private log(entry: Omit<HistoryEntry, "id" | "at">): void {        const full: HistoryEntry = { ...entry, id: randomUUID(), at: Date.now() };
        this.disk.appendHistory(full);
        this.store.update((state) => {
            state.history.push(full);
            if (state.history.length > 400) state.history.splice(0, state.history.length - 400);
        });
    }

    // MARK: - Store helpers

    private nextHue(): number {
        this.hueCursor = (this.hueCursor + HUE_STEP) % 1;
        return this.hueCursor;
    }

    private patchAgent(id: string, mutate: (agent: AgentView) => void): void {        this.store.update((state) => {
            const agent = state.agents.find((a) => a.id === id);
            if (agent) mutate(agent);
        });
    }

    private findAgent(id: string): AgentView | undefined {
        return this.store.get().agents.find((a) => a.id === id);
    }

    private attachSpawnCard(agentId: string): void {
        this.store.update((state) => {
            const last = [...state.messages].reverse().find((m) => m.role === "orbit");
            if (last && last.kind.type === "spawn") {
                last.kind.agentIds.push(agentId);
                return;
            }
            state.messages.push({
                id: randomUUID(),
                role: "orbit",
                text: "",
                kind: { type: "spawn", agentIds: [agentId] },
                at: Date.now(),
            });
        });
        this.store.flush();
    }

    private pushMessage(message: Omit<ChatMessage, "id" | "at">): void {
        this.store.update((state) => {
            state.messages.push({ ...message, id: randomUUID(), at: Date.now() });
        });
        this.store.flush();
    }

    private say(text: string, kind: ChatKind = { type: "text" }): void {
        this.pushMessage({ role: "orbit", text, kind });
    }

    // MARK: - Workspace sync

    /** Guards against a slow push overlapping the next tick's attempt. */
    private syncing = false;

    /** The repo the sync should use, honouring the env var over the setting. */
    private workspaceRepo(): string {
        return workspaceRepoPath(this.store.get().settings.workspaceRepo);
    }

    /**
     * Run a sync and report it the way the caller wants it reported.
     *
     * The tool wants the structured result to talk about; the nightly automatic
     * pass wants a line in the panel, and only when something actually moved.
     * "Already up to date" every evening is noise, and noise is how a useful
     * routine gets muted.
     */
    private async syncWorkspaceNow(
        options: { push?: boolean; announce: boolean } = { announce: false },
    ): Promise<Record<string, unknown>> {
        const repo = this.workspaceRepo();
        if (this.syncing) {
            return { status: "skipped", summary: "A sync is already running.", repo };
        }
        this.syncing = true;
        try {
            const report = await syncWorkspace({ repo, push: options.push });
            const summary = describeSync(report);
            if (options.announce && report.status === "synced") {
                this.say(summary);
            }
            // A misconfigured repo is worth one line to the panel, because the
            // alternative is a promise silently not being kept for weeks.
            if (options.announce && report.status === "failed") {
                this.say(summary, { type: "error" });
            }
            return { ...report, summary };
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            return { status: "failed", error: detail, summary: `Workspace sync failed: ${detail}.` };
        } finally {
            this.syncing = false;
        }
    }

    /**
     * The unattended pass. The day is marked as done whatever the outcome:
     * a repo that is missing or wedged will still be missing or wedged in two
     * minutes, and retrying every tick until midnight would turn one bad
     * evening into a hundred identical failures.
     */
    private async autoSyncWorkspace(): Promise<void> {
        const now = Date.now();
        if (!shouldAutoSync(this.disk.loadWorkspaceSyncDay(), now)) return;
        this.disk.saveWorkspaceSyncDay(localDay(now));
        await this.syncWorkspaceNow({ announce: true });
    }

    private nudge(text: string): void {
        if (this.store.get().chatOpen) return;
        this.setBubble(summarise(text, 200));
    }

    private setBubble(text: string, requestId?: string): void {
        this.store.update((state) => {
            state.bubble = { text, until: Date.now() + BUBBLE_MS, requestId };
        });
    }

    poke(): void {
        this.store.update((state) => {
            state.lastInteractionAt = Date.now();
        });
    }

    clearFinished(): void {
        this.store.update((state) => {
            state.agents = state.agents.filter(isLive);
        });
        this.store.flush();
    }

    setChatOpen(open: boolean): void {
        this.store.update((state) => {
            state.chatOpen = open;
            if (open) {
                state.bubble = undefined;
                state.lastInteractionAt = Date.now();
            }
        });
        this.store.flush();
    }

    dismissBubble(): void {
        this.store.update((state) => {
            state.bubble = undefined;
        });
        this.store.flush();
    }

    /** Settings that change how sessions are created need a fresh Orbit session. */
    async applySettings(patch: Partial<Settings>, previous: Settings): Promise<void> {
        if (patch.meetingHeadsUp !== undefined && patch.meetingHeadsUp !== previous.meetingHeadsUp) {
            // Turning it on should not wait for the next rescan, and turning it
            // off should drop the timers already armed.
            this.meetingPlanDay = undefined;
            this.lastCalendarScanAt = 0;
            this.nextCalendarScanAt = 0;
            this.ensureMeetingPlan();
            // Otherwise switching it on looks broken: nothing is scanned and
            // nothing says why.
            if (patch.meetingHeadsUp && !this.hasMcpServers()) {
                this.say(
                    "Noted — though I can't see a calendar until you give me an MCP server that has one. Heads-ups start the moment there is one.",
                );
            }
        }

        const needsRestart =
            (patch.model !== undefined && patch.model !== previous.model) ||
            (patch.workspace !== undefined && patch.workspace !== previous.workspace);
        if (!needsRestart || !this.client) return;

        try {
            await this.orbit?.disconnect();
            this.orbit = await this.createOrbitSession();
            this.say(
                patch.workspace
                    ? `New workspace: ${patch.workspace}. Fresh start, same charm.`
                    : `Switched model to ${patch.model}. Let's see if it's funnier than the last one.`,
            );
        } catch (error) {
            this.pushMessage({
                role: "system",
                text: `Couldn't restart my session: ${error instanceof Error ? error.message : String(error)}`,
                kind: { type: "error" },
            });
        }
    }

    // MARK: - The board

    /**
     * Re-derive the at-a-glance board from whatever is true right now.
     *
     * Pushed into `OrbitState` rather than computed in the renderer for the same
     * reason everything else is: main owns the truth, and the activity ledger
     * the board needs lives here and has no business crossing the wire raw.
     *
     * Called on the slow tick, and again at the few moments where waiting even a
     * couple of seconds would read as a bug: answering a request, settling a
     * decision, an agent finishing. Cheap enough that the tick could do it every
     * second; it does not, because nothing on the board changes that fast.
     */
    private refreshBoard(): void {
        const state = this.store.get();
        const board = deriveBoard(
            {
                agents: state.agents,
                requests: state.requests,
                schedules: state.schedules,
                openItems: state.openItems,
                activity: this.activity,
                meetings: this.meetings,
                calendarProblem: this.calendarProblem?.detail,
                leave: state.leave,
                requestTimeoutMinutes: this.settings.requestTimeoutMinutes,
                agentTimeoutMinutes: this.settings.agentTimeoutMinutes,
            },
            Date.now(),
        );
        this.store.update((next) => {
            next.board = board;
        });
    }

    /** Drops expired bubbles; called on a slow timer from main. */
    tick(): void {
        this.tickCount += 1;
        // The board is derived, never stored, so it only has to keep up with the
        // eye. Every three seconds is past the point where a human notices.
        if (this.tickCount % 3 === 0) this.refreshBoard();
        if (this.tickCount % 15 === 0 && this.store.get().runtime === "ready") {
            this.tickSchedules();
        }
        // Every couple of minutes: cheap while the plan is fresh, and the only
        // thing that notices a meeting added to the calendar after the scan.
        if (this.tickCount % 120 === 0 && this.store.get().runtime === "ready") {
            this.ensureMeetingPlan();
        }
        // Far slower than the watchers: an unanswered decision is worth
        // repeating, not worth pestering about.
        if (this.tickCount % 300 === 0 && this.store.get().runtime === "ready") {
            this.reRaiseOpenItems();
        }
        // Once an evening, and at most once a day. Guarded by its own stored
        // date rather than by the tick count, so an app restarted at 22:00 does
        // not sync twice and one left closed all evening still catches up.
        if (this.tickCount % 200 === 0 && this.store.get().runtime === "ready") {
            void this.autoSyncWorkspace();
        }
        // Work that has not landed, on the same slow rhythm and through the same
        // channel — offset by half a period so the two never arrive together and
        // read as one wall of nagging.
        if (this.tickCount % 300 === 150 && this.store.get().runtime === "ready") {
            this.chaseStaleActivity();
        }
        // Whether the running code is still the written code. Deliberately not
        // gated on the runtime being ready: a stale build is worth knowing about
        // precisely when things are not working, and this touches only disk and
        // the store. Offset again so the three slow jobs never share a tick.
        if (this.tickCount % 300 === 75) {
            this.refreshFreshness();
        }
        // Bringing failed MCP servers back. Every five seconds is cheap — it
        // does nothing at all unless a server is both failed and past its
        // backoff — and the schedule that matters lives in `mcpHealth.ts`.
        if (this.tickCount % 5 === 0 && this.store.get().runtime === "ready") {
            void this.retryMcpServers();
        }

        const state: OrbitState = this.store.get();
        if (state.bubble && state.bubble.until < Date.now()) {
            this.store.update((s) => {
                s.bubble = undefined;
            });
            this.store.flush();
        }
    }
}

/** How many settled decisions we keep around for reference. */
const RESOLVED_ITEM_LIMIT = 50;

/**
 * Does this text refer to a person? Matched on any part of the name, so
 * "Priya" finds a note filed under "Priya Raman" and vice versa, without
 * matching every note that happens to contain a common word.
 */
function mentions(text: string, name: string): boolean {
    const haystack = text.toLowerCase();
    if (haystack.includes(name)) return true;
    return name
        .split(/\s+/)
        .filter((part) => part.length >= 3)
        .some((part) => new RegExp(`\\b${escapeRegExp(part)}\\b`).test(haystack));
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Last component of a path, which is what a ledger line has room for. */
function pathName(path: string): string {
    const parts = path.replace(/\/+$/, "").split("/");
    return parts[parts.length - 1] || path;
}

/** Keep every outstanding item, plus a short tail of settled ones. */function pruneResolved(items: OpenItem[]): OpenItem[] {
    const resolved = items.filter((item) => item.resolved);
    if (resolved.length <= RESOLVED_ITEM_LIMIT) return items;
    const drop = new Set(resolved.slice(0, resolved.length - RESOLVED_ITEM_LIMIT).map((i) => i.id));
    return items.filter((item) => !drop.has(item.id));
}
