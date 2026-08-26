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
import type { InteractionRecord, LoggedToolCall, Persistence, SessionSnapshot } from "../persistence.js";
import { findCopilotCli, missingCliMessage } from "../runtime.js";
import type { Store } from "../store.js";
import { AgentRunner } from "./agentRunner.js";
import { artifactPathsIn, artifactSearchDirs, resolveArtifactPaths } from "./artifacts.js";
import { parseChoices, stripChoicesForStream } from "./choices.js";
import { clip, elapsed, summarise } from "./describe.js";
import { evolutionBlock, parseEvolutionLog, type EvolutionEntry } from "./evolution.js";
import {
    CALENDAR_SCAN_TEMPLATE,
    armableMeetings,
    calendarUnavailableMessage,
    classifyMeeting,
    headsUpAt,
    headsUpLine,
    prepBriefFor,
    readMeetingPlan,
    wantsPrep,
    type CalendarProblem,
    type Meeting,
    type MeetingPlan,
} from "./meetings.js";
import { MCP_TOOLS_RULE, ORBIT_PERSONA } from "./persona.js";
import {
    DAILY_BRIEF_TEMPLATE,
    catchUpDecision,
    clearBackoff,
    clearBlindRuns,
    blindReason,
    describeCadence,
    describeSchedule,
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

    constructor(
        private readonly store: Store,
        private readonly disk: Persistence,
    ) {}

    // MARK: - Lifecycle

    async start(): Promise<void> {
        this.persona = this.disk.loadPersona();
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
                    return ok ? { ok: true } : { error: "No outstanding item with that id." };
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
                }),
                handler: async ({ activityId, status, note }) =>
                    this.updateActivity(activityId, status, note),
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

    // MARK: - Chat

    async send(prompt: string): Promise<void> {
        const text = prompt.trim();
        if (!text) return;
        this.poke();
        this.pushMessage({ role: "user", text, kind: { type: "text" } });
        this.logInteraction({ kind: "turn", role: "user", text });

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
            if (process.env.ORBIT_DEBUG === "1") console.log("[orbit] sending:", text.slice(0, 60));
            const id = await this.orbit.send({ prompt: text });
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

        // A server that fails to connect is dropped for the whole session, and
        // Orbit has no way to know it ever existed — it will simply insist it
        // has no mail tools. Say so plainly instead.
        session.on("session.mcp_servers_loaded", (event) => {
            const data = event.data as
                | { servers?: Array<{ name: string; status: string; error?: string }> }
                | undefined;
            const failed = (data?.servers ?? []).filter((server) => server.status === "failed");
            if (failed.length === 0) return;
            const detail = failed
                .map((server) => `${server.name}${server.error ? ` (${clip(server.error, 80)})` : ""}`)
                .join(", ");
            this.pushMessage({
                role: "system",
                text: `MCP server unavailable this session: ${detail}. Restart Orbit to retry.`,
                kind: { type: "error" },
            });
        });
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

    private handleAgentFinished(agentId: string): void {
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
                if ((rescheduled || recovered) && isRunnable(target) && target.cadence.kind === "interval") {
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
    private notifyOrbit(note: string): void {
        if (!this.orbit) return;
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
                if (slot === undefined || slot > now || ranSlot(schedule, slot)) {
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

    /** How often the plan is rebuilt, so meetings added mid-day are caught. */
    private static readonly MEETING_RESCAN_MS = 45 * 60 * 1000;

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
        // A scan that never reports back — an agent cancelled out from under
        // us, say — must not wedge the feature for the rest of the session.
        if (this.scanningCalendar && Date.now() - this.lastCalendarScanAt < Orchestrator.SCAN_GIVE_UP_MS) {
            return;
        }

        const now = Date.now();
        const newDay = this.meetingPlanDay !== localDay(now);
        // A calendar that cannot be read is retried on a much slower cadence.
        // The new day still forces one, so signing in overnight is noticed by
        // the morning rather than six hours into it.
        const interval =
            this.calendarProblem?.problem === "no-calendar"
                ? Orchestrator.MEETING_BLIND_RESCAN_MS
                : Orchestrator.MEETING_RESCAN_MS;
        const stale = now - this.lastCalendarScanAt >= interval;
        if (!newDay && !stale) return;

        this.scanningCalendar = true;
        this.lastCalendarScanAt = now;
        this.meetingPlanDay = localDay(now);

        const spawned = this.spawnAgent("Read today's calendar", CALENDAR_SCAN_TEMPLATE, undefined, {
            announce: false,
            onResult: (agent) => {
                this.scanningCalendar = false;
                if (agent.status !== "done") return;
                this.applyMeetingPlan(readMeetingPlan(agent.result ?? ""));
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

        const detail = this.calendarProblem.detail;
        this.raiseOpenItem(
            `${tag} I cannot read your calendar, so I have no idea what is in your day. ${detail}`,
            "calendar scan",
        );
        this.say(calendarUnavailableMessage(detail));
    }

    /** Replace the armed timers with the ones this plan calls for. */
    private adoptMeetingPlan(meetings: Meeting[]): void {
        this.clearMeetingTimers();
        const now = Date.now();
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

    forget(memoryId: string): void {
        this.store.update((state) => {
            state.memories = state.memories.filter((memory) => memory.id !== memoryId);
        });
        this.disk.saveMemories(this.store.get().memories);
        this.store.flush();
    }

    // MARK: - Open items

    /** Longest a decision sits unanswered before it is put back in front of the user. */
    private static readonly RERAISE_AFTER_MS = 4 * 60 * 60 * 1000;

    /** Only re-raise while the user is actually around to answer. */
    private static readonly RECENT_INTERACTION_MS = 30 * 60 * 1000;

    /** At most this many outstanding items are ever quoted at once. */
    private static readonly OPEN_ITEM_CAP = 6;

    private outstandingItems(): OpenItem[] {
        return this.store
            .get()
            .openItems.filter((item) => !item.resolved)
            .slice(-Orchestrator.OPEN_ITEM_CAP);
    }

    private openItemsBlock(items: OpenItem[]): string {
        const lines = items
            .map((item) => {
                const age = elapsed(item.createdAt);
                const from = item.source ? ` — from ${item.source}` : "";
                return `- ${item.text} (raised ${age} ago${from}) id=${item.id}`;
            })
            .join("\n");
        return [
            "<open_items>",
            "Decisions you have asked for and not yet received. They are yours to chase:",
            lines,
            "",
            "Raise the most pressing one when it is a sensible moment — one line, with quick",
            "replies — rather than all of them at once. Call orbit_resolve_open_item as soon as",
            "the user answers, declines, or the question stops mattering.",
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
        return { ok: true, openItemId: item.id };
    }

    /**
     * Settle an item. Kept on the list with `resolved` set rather than deleted,
     * so an answered proposal can still be looked back at; the tail is pruned
     * so the file cannot grow forever.
     */
    resolveOpenItem(openItemId: string, resolution?: string): boolean {
        const existing = this.store.get().openItems.find((entry) => entry.id === openItemId);
        if (!existing || existing.resolved) return false;
        this.store.update((state) => {
            const item = state.openItems.find((entry) => entry.id === openItemId);
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

        const due = this.outstandingItems().filter(
            (item) =>
                Date.now() - (item.lastRaisedAt ?? item.createdAt) > Orchestrator.RERAISE_AFTER_MS,
        );
        if (due.length === 0) return;

        const ids = new Set(due.map((item) => item.id));
        this.store.update((s) => {
            for (const item of s.openItems) {
                if (ids.has(item.id)) item.lastRaisedAt = Date.now();
            }
        });
        this.persistOpenItems();
        this.notifyOrbit(this.openItemsBlock(due));
    }

    private persistOpenItems(): void {
        this.disk.saveOpenItems(this.store.get().openItems);
    }

    // MARK: - Running build

    /** Marks the one open item this check owns, so it can find it again. */
    private static readonly FRESHNESS_TAG = "[running build]";

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
     * problem and nobody has to remember to close it. Tagged rather than matched
     * on the whole message because the wording carries an age that changes every
     * time it is measured.
     */
    private reconcileFreshness(): void {
        const tag = Orchestrator.FRESHNESS_TAG;
        const existing = this.store
            .get()
            .openItems.find((item) => !item.resolved && item.text.startsWith(tag));

        const summary = this.freshness?.summary;
        if (!summary) {
            if (existing) this.resolveOpenItem(existing.id, "The running build caught up.");
            return;
        }
        // Already asked. Re-raising on every launch would nag with a number that
        // only grows, which is the behaviour open items exist to avoid.
        if (existing) return;
        this.raiseOpenItem(`${tag} ${summary}`, "freshness check");
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
                age: elapsed(entry.at),
            })),
        };
    }

    /** Move an entry along. The only way anything ever leaves the chase list. */
    updateActivity(
        activityId: string,
        status?: ActivityStatus,
        note?: string,
    ): Record<string, unknown> {
        const entry = this.activity.find((candidate) => candidate.id === activityId);
        if (!entry) return { error: "No activity entry with that id." };
        if (!status && !note) return { error: "Give a status, a note, or both." };

        if (status && status !== entry.status) {
            entry.status = status;
            entry.statusChangedAt = Date.now();
            // A fresh status starts the chase clock over rather than inheriting
            // the back-off earned while it was stuck.
            entry.chaseCount = 0;
            entry.lastChasedAt = undefined;
        }
        if (note) entry.note = clip(note, 200);

        this.persistActivity();
        this.log({ kind: "activity.updated", title: `${entry.status}: ${entry.description}`, detail: entry.note });
        return { ok: true, activityId: entry.id, status: entry.status };
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

        const due = chaseableActivity(this.activity);
        if (due.length === 0) return;

        for (const entry of due) {
            entry.lastChasedAt = Date.now();
            entry.chaseCount = (entry.chaseCount ?? 0) + 1;
        }
        this.persistActivity();
        this.notifyOrbit(activityChaseBlock(due));
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
        const proposal = this.proposals.find((entry) => entry.id === proposalId);
        if (!proposal) return { error: "No proposal with that id." };

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

    /** Drops expired bubbles; called on a slow timer from main. */
    tick(): void {
        this.tickCount += 1;
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
