/**
 * Fabricated `OrbitState` for the asset capture harness.
 *
 * Everything here is invented demo content — no real repositories, people,
 * mail or calendar entries. It exists so the real components can be rendered
 * outside the app, with no main process and no Copilot runtime behind them.
 */

import type {
    ActivityEntry,
    AgentStep,
    AgentView,
    ChatMessage,
    MemoryNote,
    OrbitState,
    PendingRequest,
    Schedule,
    Settings,
} from "../../src/shared/types.js";
import { deriveBoard } from "../../src/main/orchestrator/board.js";

/** Fixed wall-clock origin, so captures are stable across runs. */
export const EPOCH = new Date("2025-06-12T08:34:00Z").getTime();

const SETTINGS: Settings = {
    workspace: "~/code/lattice-web",
    workspaceRepo: "",
    model: "claude-sonnet-4.5",
    yolo: false,
    autoApproveReads: true,
    requestTimeoutMinutes: 10,
    agentTimeoutMinutes: 30,
    copilotPath: "",
    panelOpacity: 0.88,
    chatFontFamily: "rounded",
    chatFontSize: 13,
    meetingHeadsUp: true,
};

function steps(labels: string[]): AgentStep[] {
    return labels.map((label, index) => ({
        id: `s${index}`,
        label,
        at: EPOCH - (labels.length - index) * 9_000,
        kind: "tool" as const,
    }));
}

interface AgentSeed {
    id: string;
    title: string;
    task: string;
    hue: number;
    status?: AgentView["status"];
    toolCalls?: number;
    currentStep?: string;
    ageSeconds?: number;
    endedSecondsAgo?: number;
    result?: string;
    steps?: string[];
}

export function agent(seed: AgentSeed): AgentView {
    const status = seed.status ?? "running";
    const createdAt = EPOCH - (seed.ageSeconds ?? 90) * 1000;
    const toolCalls = seed.toolCalls ?? 7;
    return {
        id: seed.id,
        title: seed.title,
        task: seed.task,
        status,
        model: SETTINGS.model,
        cwd: SETTINGS.workspace,
        hue: seed.hue,
        createdAt,
        startedAt: createdAt + 400,
        endedAt: seed.endedSecondsAgo === undefined ? undefined : EPOCH - seed.endedSecondsAgo * 1000,
        lastActivityAt: EPOCH - 2000,
        toolCalls,
        currentStep: seed.currentStep,
        steps: steps(seed.steps ?? []),
        result: seed.result,
        inputTokens: toolCalls * 1840,
        outputTokens: toolCalls * 260,
    };
}

/** The agents the hero shot and the mission-control shot share. */
export const AGENTS = {
    flaky: agent({
        id: "a-flaky",
        title: "Flaky checkout spec",
        task: "Work out why the checkout spec fails intermittently in CI and propose a fix.",
        hue: 0.07,
        toolCalls: 14,
        ageSeconds: 132,
        currentStep: "re-running the spec, attempt 9 of 20",
        steps: [
            "read the checkout spec",
            "searched CI logs for the last 12 runs",
            "re-ran the spec in a loop",
            "found a 200ms race on the cart total",
        ],
    }),
    deps: agent({
        id: "a-deps",
        title: "Dependency audit",
        task: "Check the lockfile for advisories and report anything worth acting on.",
        hue: 0.52,
        toolCalls: 6,
        ageSeconds: 74,
        currentStep: "reading 2 advisories",
    }),
    notes: agent({
        id: "a-notes",
        title: "Release notes for 0.4",
        task: "Draft release notes for the 0.4 tag from the commits since 0.3.",
        hue: 0.78,
        status: "done",
        toolCalls: 11,
        ageSeconds: 240,
        endedSecondsAgo: 6,
        result: "Drafted notes for 38 commits — 6 features, 9 fixes, 1 breaking change.",
    }),
    links: agent({
        id: "a-links",
        title: "Docs link check",
        task: "Crawl the docs site and list every link that 404s.",
        hue: 0.33,
        toolCalls: 21,
        ageSeconds: 310,
        currentStep: "crawling page 41 of 96",
    }),
};

/** Enough agents that the orbit ring reads as a swarm. */
export const SWARM: AgentView[] = [
    AGENTS.flaky,
    AGENTS.deps,
    AGENTS.links,
    agent({ id: "a-perf", title: "Bundle size watch", task: "Compare bundle size against main.", hue: 0.61, toolCalls: 4 }),
    agent({ id: "a-tidy", title: "Changelog tidy", task: "Fix the headings in the changelog.", hue: 0.14, toolCalls: 9 }),
    agent({ id: "a-i18n", title: "Missing translations", task: "List untranslated strings.", hue: 0.87, toolCalls: 2 }),
];

export const REQUEST: PendingRequest = {
    id: "r-1",
    agentId: AGENTS.flaky.id,
    kind: "permission",
    title: "Push the fix branch to origin?",
    subject: "git push -u origin fix/checkout-race",
    detail: "Flaky checkout spec wants to publish the branch it just committed to.",
    options: [
        { id: "allow", label: "Go ahead", tone: "primary" },
        { id: "once", label: "Just this once", tone: "neutral" },
        { id: "deny", label: "No", tone: "danger" },
    ],
    allowFreeform: true,
    createdAt: EPOCH - 12_000,
};

const BRIEFING = [
    "Morning. Here's the 8:30 briefing.",
    "",
    "· lattice-web is green on main — 3 PRs merged overnight.",
    "· The checkout spec failed 4 of the last 12 CI runs.",
    "· Calendar's clear until 11:00.",
    "",
    "Want me to dig into the flaky spec?",
].join("\n");

export const MESSAGES: ChatMessage[] = [
    { id: "m1", role: "orbit", text: BRIEFING, kind: { type: "text" }, at: EPOCH - 300_000 },
    {
        id: "m2",
        role: "user",
        text: "Yes — and draft the 0.4 release notes while you're at it.",
        kind: { type: "text" },
        at: EPOCH - 250_000,
    },
    {
        id: "m3",
        role: "orbit",
        text: "On it — two agents out.",
        kind: { type: "text" },
        at: EPOCH - 249_000,
    },
    {
        id: "m4",
        role: "system",
        text: "",
        kind: { type: "spawn", agentIds: [AGENTS.flaky.id, AGENTS.notes.id] },
        at: EPOCH - 248_000,
    },
    {
        id: "m5",
        role: "system",
        text: "Drafted the 0.4 notes from 38 commits — 6 features, 9 fixes, one breaking change. Want me to open the PR?",
        kind: { type: "completion", agentId: AGENTS.notes.id },
        at: EPOCH - 6_000,
    },
];

export const SCHEDULES: Schedule[] = [
    {
        id: "sch-brief",
        title: "Morning briefing",
        task: "Summarise overnight CI, merged PRs and today's calendar.",
        cadence: { kind: "daily", time: "08:30" },
        enabled: true,
        createdAt: EPOCH - 86_400_000 * 21,
        nextRunAt: EPOCH + 79_000_000,
        lastRunAt: EPOCH - 300_000,
        runCount: 21,
        quiet: false,
    },
    {
        id: "sch-tests",
        title: "Watch main for failing tests",
        task: "Check the last CI run on main, and speak up only if something broke.",
        cadence: { kind: "interval", minutes: 30 },
        enabled: true,
        createdAt: EPOCH - 86_400_000 * 9,
        nextRunAt: EPOCH + 1_140_000,
        lastRunAt: EPOCH - 660_000,
        runCount: 402,
        quiet: true,
        quietRuns: 7,
    },
    {
        id: "sch-deps",
        title: "Dependency advisories",
        task: "Audit the lockfile and report anything above low severity.",
        cadence: { kind: "daily", time: "07:00" },
        enabled: true,
        createdAt: EPOCH - 86_400_000 * 30,
        nextRunAt: EPOCH + 81_000_000,
        lastRunAt: EPOCH - 5_400_000,
        runCount: 30,
        quiet: true,
    },
];

export const MEMORIES: MemoryNote[] = [
    { id: "n1", text: "Prefers short answers first, detail only if asked.", category: "preference", createdAt: EPOCH - 86_400_000 * 12, source: "orbit" },
    { id: "n2", text: "Works in the lattice-web repo most days.", category: "project", createdAt: EPOCH - 86_400_000 * 12, source: "orbit" },
    { id: "n3", text: "Never push to main. Branch and open a PR.", category: "preference", createdAt: EPOCH - 86_400_000 * 9, source: "user" },
    { id: "n4", text: "Standup is 09:45 on weekdays.", category: "routine", createdAt: EPOCH - 86_400_000 * 5, source: "orbit" },
    { id: "n5", text: "Uses pnpm, not npm, in the web repo.", category: "fact", createdAt: EPOCH - 86_400_000 * 3, source: "orbit" },
];

/**
 * Invented ledger entries, so the board has deliveries to lane as well as
 * agents. The `waitingOn` one is the point of including any of it: the "on
 * others" lane is otherwise empty in every capture, and an empty lane teaches
 * nobody what it is for.
 */
const DEMO_ACTIVITY: ActivityEntry[] = [
    {
        id: "a1",
        at: EPOCH - 86_400_000 * 4,
        day: "2025-06-08",
        kind: "draft_composed",
        description: "Headcount case for the Q3 review",
        status: "awaiting_seshi",
        request: "write up the headcount ask",
    },
    {
        id: "a2",
        at: EPOCH - 86_400_000 * 6,
        day: "2025-06-06",
        kind: "access_checked",
        description: "Access to the billing telemetry dataset",
        status: "stalled",
        waitingOn: "the data platform team",
        statusChangedAt: EPOCH - 86_400_000 * 5,
    },
    {
        id: "a3",
        at: EPOCH - 9_000_000,
        day: "2025-06-12",
        kind: "artifact_written",
        description: "Migration plan for the checkout service",
        location: "~/code/lattice-web/docs/checkout-migration.md",
        status: "delivered",
    },
];

export function baseState(patch: Partial<OrbitState> = {}): OrbitState {
    const state: OrbitState = {
        runtime: "ready",
        chatOpen: true,
        orbitBusy: false,
        messages: [],
        agents: [],
        requests: [],
        settings: SETTINGS,
        models: [{ id: SETTINGS.model, name: "Claude Sonnet 4.5" }],
        schedules: SCHEDULES,
        memories: MEMORIES,
        leave: [],
        openItems: [],
        history: [
            { id: "h1", at: EPOCH - 6_000, kind: "agent.done", title: "Release notes for 0.4", detail: "38 commits summarised" },
            { id: "h2", at: EPOCH - 132_000, kind: "agent.start", title: "Flaky checkout spec" },
            { id: "h3", at: EPOCH - 300_000, kind: "schedule.run", title: "Morning briefing" },
            { id: "h4", at: EPOCH - 660_000, kind: "schedule.run", title: "Watch main for failing tests", detail: "nothing to report" },
            { id: "h5", at: EPOCH - 900_000, kind: "memory.saved", title: "Uses pnpm, not npm, in the web repo" },
        ],
        usage: { inputTokens: 1_284_000, outputTokens: 96_400, agentsRun: 47, toolCalls: 612 },
        board: { at: EPOCH, threads: [], calls: [], blindSpots: [] },
        personaPath: "~/.copilot/orbit/persona.md",
        lastInteractionAt: EPOCH - 4_000,
        ...patch,
    };

    // Derived by the real rules from whatever this scene happens to contain,
    // rather than hand-written per scene. A fabricated board would drift from
    // the one the app builds, and a capture that flatters the code is worse
    // than no capture.
    return {
        ...state,
        board: patch.board ?? deriveBoard(
            {
                agents: state.agents,
                requests: state.requests,
                schedules: state.schedules,
                openItems: state.openItems,
                activity: DEMO_ACTIVITY,
                meetings: [],
                leave: state.leave,
                requestTimeoutMinutes: state.settings.requestTimeoutMinutes,
                agentTimeoutMinutes: state.settings.agentTimeoutMinutes,
            },
            EPOCH,
        ),
    };
}

/**
 * A no-op `window.orbit`, apart from the state channel the harness drives.
 *
 * The real components call this on mount — dictation support, path inspection
 * — and in a capture there is no main process to answer, nor should there be:
 * nothing here may touch the machine.
 */
export function installApiStub(channel: {
    get(): OrbitState;
    subscribe(cb: (state: OrbitState) => void): () => void;
}): void {
    const noop = async (): Promise<void> => undefined;
    const api: Record<string, unknown> = {
        getState: async () => channel.get(),
        onState: (cb: (state: OrbitState) => void) => channel.subscribe(cb),
        onDictation: () => () => undefined,
        dictationSupport: async () => ({ available: true, onDevice: true }),
        inspectPaths: async () => [],
        openPath: async () => ({ ok: true }),
        revealPath: async () => ({ ok: true }),
        openUrl: async () => ({ ok: true }),
    };
    const names = [
        "send", "abort", "answerRequest", "cancelAgent", "clearFinished", "poke", "dismissBubble",
        "setSettings", "chooseWorkspace", "setChatOpen", "setScheduleEnabled", "setScheduleArchived",
        "runScheduleNow", "deleteSchedule", "forgetMemory", "resolveOpenItem", "openPersona",
        "moveWindow", "resizeWindow", "softRestart", "setIgnoreMouse", "startDictation",
        "stopDictation", "cancelDictation", "quit",
    ];
    for (const name of names) api[name] ??= noop;
    (window as unknown as { orbit: unknown }).orbit = api;
}
