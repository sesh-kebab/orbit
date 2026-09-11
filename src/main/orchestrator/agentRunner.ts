import { randomUUID } from "node:crypto";
import type {
    CopilotClient,
    CopilotSession,
    MCPServerConfig,
    PermissionRequest,
    PermissionRequestResult,
    SessionConfig,
    Tool,
} from "@github/copilot-sdk";

// The SDK doesn't re-export these handler payload types, so derive them.
type UserInputHandler = NonNullable<SessionConfig["onUserInputRequest"]>;
type UserInputRequest = Parameters<UserInputHandler>[0];
type UserInputResponse = Awaited<ReturnType<UserInputHandler>>;
import type { AgentStep, AgentView, PendingRequest, Settings } from "../../shared/types.js";
import { describeToolCall, summarise } from "./describe.js";
import {
    autoDecide,
    describePermission,
    optionToDecision,
    permissionOptions,
} from "./permissions.js";
import { buildAgentPrompt } from "./persona.js";

export interface AskFn {
    (
        request: Omit<PendingRequest, "id" | "createdAt">,
    ): Promise<{ optionId: string; freeform?: string }>;
}

export interface AgentRunnerHooks {
    /** Mutate this agent's record in the store. */
    patch(id: string, mutate: (agent: AgentView) => void): void;
    ask: AskFn;
    getSettings(): Settings;
    getMcpServers(): Record<string, MCPServerConfig>;
    /**
     * The subset of Orbit's own tools this agent may call. Without it an agent
     * can do the work but cannot record that it did any of it. Typed as the SDK
     * types its own `tools` option: `Tool<T>` is invariant in `T`, so a list of
     * differently-parameterised tools has no narrower common type.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getAgentTools(): Tool<any>[];
    onUsage(input: number, output: number): void;
    onToolCall(): void;
    onFinished(agent: AgentView): void;
}

const MAX_STEPS = 40;

/**
 * How long `sendAndWait` will wait for `session.idle` before giving up: 60
 * minutes. The SDK default is 60s, which kills perfectly healthy long-running
 * agents. The runtime watchdog (`Settings.agentTimeoutMinutes`) is the real
 * ceiling on an agent's life; this is only the "no idle event yet" backstop and
 * must never be shorter than it. Override with `ORBIT_AGENT_IDLE_TIMEOUT_MS`.
 */
export const AGENT_IDLE_TIMEOUT_MS = readIdleTimeoutMs();

function readIdleTimeoutMs(): number {
    const raw = Number(process.env.ORBIT_AGENT_IDLE_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 3_600_000;
}

/**
 * One delegated task = one Copilot session. This class owns that session's
 * lifetime and translates its event stream into the shape the buddy renders.
 */
export class AgentRunner {
    private session: CopilotSession | undefined;
    private cancelled = false;
    private watchdog: NodeJS.Timeout | undefined;
    private unsubscribes: Array<() => void> = [];

    constructor(
        private readonly client: CopilotClient,
        private readonly agent: AgentView,
        private readonly hooks: AgentRunnerHooks,
    ) {}

    get id(): string {
        return this.agent.id;
    }

    async run(): Promise<void> {
        const settings = this.hooks.getSettings();
        try {
            const session = await this.client.createSession({
                model: settings.model === "auto" ? undefined : settings.model,
                workingDirectory: this.agent.cwd,
                mcpServers: this.hooks.getMcpServers(),
                onPermissionRequest: (request) => this.handlePermission(request),
                onUserInputRequest: (request) => this.handleQuestion(request),
                // Orbit's bookkeeping tools, so an agent writes through the
                // running app rather than editing its state files on disk
                // underneath it. `availableTools` is left unset: a tool is
                // enabled when it matches that filter or the filter is absent,
                // so these are live without also having to restate the built-in
                // file and shell tools the agent needs to do the work.
                tools: this.hooks.getAgentTools(),
            });
            this.session = session;

            this.hooks.patch(this.agent.id, (a) => {
                a.sessionId = session.sessionId;
                a.status = "running";
                a.startedAt = Date.now();
                a.lastActivityAt = Date.now();
                a.currentStep = "getting started";
            });

            this.wire(session);
            this.armWatchdog(settings.agentTimeoutMinutes);

            const final = await session.sendAndWait(
                { prompt: buildAgentPrompt(this.agent.task) },
                AGENT_IDLE_TIMEOUT_MS,
            );

            if (this.cancelled) return;

            const result = final?.data?.content?.trim();
            this.hooks.patch(this.agent.id, (a) => {
                a.status = "done";
                a.endedAt = Date.now();
                a.lastActivityAt = Date.now();
                a.currentStep = undefined;
                a.result = result || "Finished, but didn't say much about it.";
            });
        } catch (error) {
            if (this.cancelled) return;
            const message = error instanceof Error ? error.message : String(error);
            this.hooks.patch(this.agent.id, (a) => {
                a.status = "failed";
                a.endedAt = Date.now();
                a.lastActivityAt = Date.now();
                a.currentStep = undefined;
                a.error = message;
                pushStep(a, { kind: "error", label: "failed", detail: message });
            });
        } finally {
            if (this.watchdog) clearTimeout(this.watchdog);
            this.teardown();
            this.hooks.onFinished(this.agent);
        }
    }

    /**
     * An agent that has been running for far too long is almost always stuck.
     * Stop it and record why, rather than leaving a mote spinning forever.
     */
    private armWatchdog(minutes: number): void {
        if (minutes <= 0) return;
        this.watchdog = setTimeout(
            () => {
                if (this.cancelled) return;
                this.hooks.patch(this.agent.id, (a) => {
                    a.status = "failed";
                    a.endedAt = Date.now();
                    a.currentStep = undefined;
                    a.error = `Gave up after ${minutes} minutes without finishing.`;
                    pushStep(a, { kind: "error", label: "timed out" });
                });
                this.cancelled = true;
                void this.session?.abort().catch(() => undefined);
                this.teardown();
                this.hooks.onFinished(this.agent);
            },
            minutes * 60_000,
        );
    }

    /** Send a follow-up message to an agent that is already running or idle. */
    async message(text: string): Promise<void> {
        if (!this.session) throw new Error("agent is not running yet");
        await this.session.send({ prompt: text, mode: "enqueue" });
        this.hooks.patch(this.agent.id, (a) => {
            a.lastActivityAt = Date.now();
            pushStep(a, { kind: "note", label: "got a follow-up from Orbit" });
        });
    }

    async cancel(): Promise<void> {
        this.cancelled = true;
        this.hooks.patch(this.agent.id, (a) => {
            a.status = "cancelled";
            a.endedAt = Date.now();
            a.currentStep = undefined;
        });
        try {
            await this.session?.abort();
        } catch {
            /* the session may already be gone */
        }
        this.teardown();
    }

    // MARK: - Event plumbing

    private wire(session: CopilotSession): void {
        this.unsubscribes.push(
            session.on("tool.execution_start", (event) => {
                const data = event.data;
                const label = describeToolCall(
                    data.toolName,
                    data.arguments as Record<string, unknown> | undefined,
                );
                this.hooks.patch(this.agent.id, (a) => {
                    a.toolCalls += 1;
                    a.currentStep = label;
                    a.lastActivityAt = Date.now();
                    pushStep(a, { kind: "tool", label });
                });
                this.hooks.onToolCall();
            }),
        );

        this.unsubscribes.push(
            session.on("assistant.message", (event) => {
                const content = event.data?.content;
                if (!content) return;
                this.hooks.patch(this.agent.id, (a) => {
                    a.lastActivityAt = Date.now();
                    a.currentStep = summarise(content, 60);
                    pushStep(a, { kind: "note", label: summarise(content) });
                });
            }),
        );

        this.unsubscribes.push(
            session.on("assistant.usage", (event) => {
                const data = event.data as { inputTokens?: number; outputTokens?: number } | undefined;
                const input = data?.inputTokens ?? 0;
                const output = data?.outputTokens ?? 0;
                if (input === 0 && output === 0) return;
                this.hooks.patch(this.agent.id, (a) => {
                    a.inputTokens += input;
                    a.outputTokens += output;
                });
                this.hooks.onUsage(input, output);
            }),
        );

        this.unsubscribes.push(
            session.on("session.error", (event) => {
                const message =
                    (event.data as { message?: string } | undefined)?.message ?? "something broke";
                this.hooks.patch(this.agent.id, (a) => {
                    a.lastActivityAt = Date.now();
                    pushStep(a, { kind: "error", label: summarise(message) });
                });
            }),
        );
    }

    private async handlePermission(request: PermissionRequest): Promise<PermissionRequestResult> {
        const settings = this.hooks.getSettings();
        const automatic = autoDecide(request, settings);
        if (automatic) return automatic;

        const description = describePermission(request);
        const previous = this.agent.status;

        this.hooks.patch(this.agent.id, (a) => {
            a.status = "needs-input";
            a.currentStep = description.title;
            a.lastActivityAt = Date.now();
        });

        const answer = await this.hooks.ask({
            agentId: this.agent.id,
            kind: "permission",
            title: description.title,
            subject: description.subject,
            detail: description.detail,
            options: permissionOptions(description),
            allowFreeform: false,
        });

        this.hooks.patch(this.agent.id, (a) => {
            if (a.status === "needs-input") a.status = previous === "queued" ? "running" : previous;
            a.pendingRequestId = undefined;
            a.lastActivityAt = Date.now();
        });

        return optionToDecision(answer.optionId, request);
    }

    private async handleQuestion(request: UserInputRequest): Promise<UserInputResponse> {
        const previous = this.agent.status;
        this.hooks.patch(this.agent.id, (a) => {
            a.status = "needs-input";
            a.currentStep = "waiting on you";
            a.lastActivityAt = Date.now();
        });

        const choices = request.choices ?? [];
        const answer = await this.hooks.ask({
            agentId: this.agent.id,
            kind: "question",
            title: request.question,
            options: choices.map((choice, index) => ({
                id: String(index),
                label: choice,
                tone: index === 0 ? "primary" : "neutral",
            })),
            allowFreeform: request.allowFreeform !== false || choices.length === 0,
        });

        this.hooks.patch(this.agent.id, (a) => {
            if (a.status === "needs-input") a.status = previous === "queued" ? "running" : previous;
            a.pendingRequestId = undefined;
            a.lastActivityAt = Date.now();
        });

        if (answer.freeform !== undefined && answer.freeform !== "") {
            return { answer: answer.freeform, wasFreeform: true };
        }
        const index = Number(answer.optionId);
        const chosen = Number.isInteger(index) ? choices[index] : undefined;
        return { answer: chosen ?? "proceed", wasFreeform: chosen === undefined };
    }

    private teardown(): void {
        for (const off of this.unsubscribes) {
            try {
                off();
            } catch {
                /* ignore */
            }
        }
        this.unsubscribes = [];
        const session = this.session;
        this.session = undefined;
        void session?.disconnect().catch(() => undefined);
    }
}

function pushStep(agent: AgentView, step: Omit<AgentStep, "id" | "at">): void {
    agent.steps.push({ ...step, id: randomUUID(), at: Date.now() });
    if (agent.steps.length > MAX_STEPS) {
        agent.steps.splice(0, agent.steps.length - MAX_STEPS);
    }
}
