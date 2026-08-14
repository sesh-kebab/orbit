/**
 * What the capture harness shoots.
 *
 * Every entry drives the *real* components: character tiles render `Buddy`
 * with a mood produced by the real `deriveMood`, and the app scenes render the
 * real `App` fed through the app's own snapshot-scene channel. Nothing here
 * redraws the character, so a redesign lands in the assets on the next run.
 *
 * GIF frame delays are written in centiseconds, so only durations that are a
 * whole number of 10ms play back at the rate asked for.
 */

import type { AgentView, Mood, OrbitState } from "../../src/shared/types.js";
import { isLive } from "../../src/shared/types.js";
import { AGENTS, EPOCH, MESSAGES, REQUEST, SWARM, baseState } from "./demo.js";

export interface BuddyPose {
    state: OrbitState;
    typing: boolean;
}

/** One pose per real mood, each reached the way the app itself reaches it. */
export const POSES: Record<Mood, BuddyPose> = {
    napping: { state: baseState({ lastInteractionAt: EPOCH - 120_000 }), typing: false },
    idle: { state: baseState(), typing: false },
    listening: { state: baseState(), typing: true },
    thinking: {
        state: baseState({ orbitBusy: true, orbitActivity: "reading the CI logs" }),
        typing: false,
    },
    working: { state: baseState({ agents: [AGENTS.flaky, AGENTS.deps] }), typing: false },
    needsInput: {
        state: baseState({ agents: [AGENTS.flaky], requests: [REQUEST] }),
        typing: false,
    },
    // A finish inside the 3.2s celebrate window is the only way in.
    celebrating: {
        state: baseState({ agents: [{ ...AGENTS.notes, endedAt: EPOCH - 400 }] }),
        typing: false,
    },
    broken: {
        state: baseState({ runtime: "error", runtimeError: "can't reach Copilot" }),
        typing: false,
    },
};

/** A sky full of agents — the pose that sells the orchestration. */
export const SWARM_POSE: BuddyPose = { state: baseState({ agents: SWARM }), typing: false };

export const MOOD_ORDER: Mood[] = [
    "idle",
    "listening",
    "thinking",
    "working",
    "needsInput",
    "celebrating",
    "napping",
    "broken",
];

/** Exactly what `App` hands the character, so the tiles cannot drift from it. */
export function buddyProps(pose: BuddyPose): { agents: AgentView[]; blockedCount: number } {
    return {
        agents: pose.state.agents.filter(isLive),
        blockedCount: pose.state.requests.length,
    };
}

// MARK: - The end-to-end demo timeline

export interface Beat {
    /** Virtual milliseconds since the shot began. */
    at: number;
    scene?: string;
    /** Text to drive into the real composer, keystroke-style. */
    compose?: string;
    state(): OrbitState;
}

const ASK = "Find out why the checkout spec keeps failing in CI";

function runningFlaky(toolCalls: number, step: string): AgentView {
    return { ...AGENTS.flaky, status: "running", toolCalls, currentStep: step };
}

const OPENING: OrbitState = baseState({
    messages: [MESSAGES[0]],
    lastInteractionAt: EPOCH - 3_000,
});

function withUserAsk(patch: Partial<OrbitState> = {}): OrbitState {
    const { messages = [], ...rest } = patch;
    return baseState({
        ...rest,
        messages: [
            MESSAGES[0],
            { id: "d-user", role: "user", text: ASK, kind: { type: "text" }, at: EPOCH + 2_000 },
            ...messages,
        ],
        lastInteractionAt: EPOCH + 2_000,
    });
}

function reply(text: string, streaming: boolean) {
    return {
        id: "d-reply",
        role: "orbit" as const,
        text,
        kind: { type: "text" as const },
        at: EPOCH + 2_400,
        streaming,
    };
}

const REPLY = "Sure — sending an agent at it now.";

const SPAWN = {
    id: "d-spawn",
    role: "system" as const,
    text: "",
    kind: { type: "spawn" as const, agentIds: [AGENTS.flaky.id] },
    at: EPOCH + 3_200,
};

const DONE_CARD = {
    id: "d-done",
    role: "system" as const,
    text: "Found it: the cart total re-renders 200ms after the click, so the assertion races it. Waiting on the total instead of the button fixes all 20 runs. Branch is ready — want me to push it?",
    kind: { type: "completion" as const, agentId: AGENTS.flaky.id },
    at: EPOCH + 9_000,
};

function finishedFlaky(): AgentView {
    return {
        ...AGENTS.flaky,
        status: "done",
        toolCalls: 16,
        currentStep: undefined,
        endedAt: EPOCH + 9_000,
        result: "Race on the cart total. Fix on fix/checkout-race.",
    };
}

/**
 * The story: a question, an agent, the character going heads-down, and the
 * answer coming back. Times are virtual, so the recording is frame-exact.
 */
export const DEMO_BEATS: Beat[] = [
    { at: 0, scene: "chat", compose: "", state: () => OPENING },
    { at: 400, compose: ASK.slice(0, 6), state: () => OPENING },
    { at: 700, compose: ASK.slice(0, 14), state: () => OPENING },
    { at: 1000, compose: ASK.slice(0, 23), state: () => OPENING },
    { at: 1300, compose: ASK.slice(0, 33), state: () => OPENING },
    { at: 1600, compose: ASK.slice(0, 42), state: () => OPENING },
    { at: 1850, compose: ASK, state: () => OPENING },
    {
        at: 2200,
        compose: "",
        state: () => withUserAsk({ orbitBusy: true, orbitActivity: "thinking" }),
    },
    {
        at: 3000,
        state: () =>
            withUserAsk({
                orbitBusy: true,
                messages: [reply(REPLY.slice(0, 14), true)],
            }),
    },
    {
        at: 3400,
        state: () => withUserAsk({ orbitBusy: true, messages: [reply(REPLY, true)] }),
    },
    {
        at: 3900,
        state: () =>
            withUserAsk({
                messages: [reply(REPLY, false), SPAWN],
                agents: [{ ...AGENTS.flaky, status: "queued", toolCalls: 0, currentStep: undefined }],
            }),
    },
    {
        at: 4400,
        state: () =>
            withUserAsk({
                messages: [reply(REPLY, false), SPAWN],
                agents: [runningFlaky(1, "reading the checkout spec")],
            }),
    },
    {
        at: 5200,
        state: () =>
            withUserAsk({
                messages: [reply(REPLY, false), SPAWN],
                agents: [runningFlaky(4, "pulling the last 12 CI runs")],
            }),
    },
    {
        at: 6200,
        state: () =>
            withUserAsk({
                messages: [reply(REPLY, false), SPAWN],
                agents: [runningFlaky(8, "re-running the spec in a loop")],
            }),
    },
    {
        at: 7400,
        state: () =>
            withUserAsk({
                messages: [reply(REPLY, false), SPAWN],
                agents: [runningFlaky(13, "attempt 14 of 20 — reproduced it")],
            }),
    },
    {
        at: 9000,
        state: () =>
            withUserAsk({
                messages: [reply(REPLY, false), SPAWN, DONE_CARD],
                agents: [finishedFlaky()],
            }),
    },
];

// MARK: - Shot list

export type SceneKind = "tile" | "sheet" | "app";

export interface Shot {
    /** Output file name, relative to the assets directory. */
    file: string;
    kind: SceneKind;
    /** Which pose or app scene to strike. */
    pose?: Mood | "swarm";
    /** Scene name pushed through the app's snapshot channel. */
    scene?: string;
    /** State the app scene should be posed in. */
    appState?: "hero" | "ambient" | "deck";
    /** Logical stage size in CSS pixels. */
    width: number;
    height: number;
    /** Render zoom. The capture is downsampled back to `out` pixels wide. */
    zoom: number;
    out: number;
    /** Animated shots only. */
    frames?: number;
    /** Frame interval in ms. Must be a multiple of 10 for GIF playback. */
    interval?: number;
    /** Virtual ms to run before the first frame, so motion starts settled. */
    warmup?: number;
    /** Drive the demo timeline rather than holding a fixed pose. */
    timeline?: boolean;
    /**
     * Contact sheets only: the shots to tile, by file name.
     *
     * The tiles are photographed one at a time and pasted together by the
     * driver rather than laid out in the page. `Buddy` names its SVG
     * gradients with fixed ids, so several of them in one document all
     * resolve `url(#bodyGrad)` to whichever rendered first and every
     * character comes out the same colour. One per document, one at a time.
     */
    tiles?: string[];
    columns?: number;
    gap?: number;
    padding?: number;
}

const TILE = 300;

const stills: Shot[] = MOOD_ORDER.map((mood) => ({
    file: `state-${kebab(mood)}.png`,
    kind: "tile",
    pose: mood,
    width: TILE,
    height: TILE,
    zoom: 2,
    out: TILE * 2,
    warmup: 900,
}));

export function kebab(mood: string): string {
    return mood.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

export const SHOTS: Shot[] = [
    ...stills,
    {
        file: "state-many-agents.png",
        kind: "tile",
        pose: "swarm",
        width: TILE,
        height: TILE,
        zoom: 2,
        out: TILE * 2,
        warmup: 2600,
    },
    {
        file: "states.png",
        kind: "sheet",
        tiles: MOOD_ORDER.map((mood) => `state-${kebab(mood)}.png`),
        columns: 4,
        gap: 18,
        padding: 26,
        width: TILE,
        height: TILE,
        zoom: 2,
        out: 1700,
    },
    {
        file: "celebrate.gif",
        kind: "tile",
        pose: "celebrating",
        width: TILE,
        height: TILE,
        zoom: 2,
        out: TILE,
        frames: 83,
        interval: 40,
        warmup: 0,
    },
    {
        file: "many-agents.gif",
        kind: "tile",
        pose: "swarm",
        width: TILE,
        height: TILE,
        zoom: 2,
        out: TILE,
        frames: 100,
        interval: 50,
        warmup: 2600,
    },
    {
        file: "idle.gif",
        kind: "tile",
        pose: "idle",
        width: TILE,
        height: TILE,
        zoom: 2,
        out: TILE,
        frames: 79,
        interval: 50,
        warmup: 0,
    },
    {
        file: "napping.gif",
        kind: "tile",
        pose: "napping",
        width: TILE,
        height: TILE,
        zoom: 2,
        out: TILE,
        // `Buddy` throttles its own render loop to 12fps while napping, so a
        // shorter interval than that just writes each frame down twice.
        frames: 54,
        interval: 90,
        warmup: 0,
    },
    {
        file: "hero.png",
        kind: "app",
        appState: "hero",
        scene: "chat",
        width: 1440,
        height: 900,
        zoom: 2,
        out: 1920,
        warmup: 1500,
    },
    {
        file: "ambient.png",
        kind: "app",
        appState: "ambient",
        scene: "ambient",
        width: 720,
        height: 470,
        zoom: 2,
        out: 1440,
        warmup: 1500,
    },
    {
        file: "mission-control.png",
        kind: "app",
        appState: "deck",
        scene: "chat-deck-agents",
        width: 528,
        height: 812,
        zoom: 2,
        out: 1056,
        warmup: 1500,
    },
    {
        file: "demo.gif",
        kind: "app",
        appState: "hero",
        scene: "chat",
        timeline: true,
        width: 528,
        height: 812,
        zoom: 2,
        out: 460,
        frames: 200,
        interval: 60,
        warmup: 0,
    },
];
