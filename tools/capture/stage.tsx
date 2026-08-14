/**
 * The capture stage: a dev-only page that renders the real Orbit UI in a known
 * pose so it can be photographed.
 *
 * Two kinds of scene, both built from shipped code rather than a redraw:
 *
 * - character tiles render `Buddy` with a mood from the real `deriveMood`;
 * - app scenes mount the real `App` and feed it through the same
 *   `window.orbit` / snapshot-scene channels the app already uses, so the
 *   panel, the transcript, the shelf and the mood chip are all the real thing.
 *
 * Time is virtual (see clock.ts). The Electron driver calls `__stage.pose()`,
 * then `__stage.tick()` once per frame, and photographs between calls.
 */

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useEffect, useState } from "react";
import type { Mood, OrbitState } from "../../src/shared/types.js";
import { App } from "../../src/renderer/App.js";
import { Buddy } from "../../src/renderer/components/Buddy.js";
import { MOODS, deriveMood } from "../../src/renderer/mood.js";
import { initScenes } from "../../src/renderer/scene.js";
import "../../src/renderer/styles.css";
import { clockNow, installClock, resetClock, tick as tickClock } from "./clock.js";
import { AGENTS, EPOCH, MESSAGES, SWARM, baseState, installApiStub } from "./demo.js";
import type { Shot } from "./shots.js";
import { DEMO_BEATS, POSES, SHOTS, SWARM_POSE, buddyProps } from "./shots.js";
import "./stage.css";

// MARK: - Channels the real app listens on

let currentState: OrbitState = baseState();
const stateListeners = new Set<(state: OrbitState) => void>();
const sceneListeners = new Set<(scene: string) => void>();

const channel = {
    get: (): OrbitState => currentState,
    subscribe(cb: (state: OrbitState) => void): () => void {
        stateListeners.add(cb);
        return () => stateListeners.delete(cb);
    },
};

function pushState(state: OrbitState): void {
    currentState = state;
    for (const listener of stateListeners) listener(state);
}

function pushScene(scene: string): void {
    for (const listener of sceneListeners) listener(scene);
}

installClock();
installApiStub(channel);
(window as unknown as { orbitSnapshot: unknown }).orbitSnapshot = {
    onScene: (cb: (scene: string) => void) => sceneListeners.add(cb),
};
initScenes();

// MARK: - Scenery

/** A neutral desktop: no window chrome anybody owns, no readable content. */
function Desktop({ children }: { children: React.ReactNode }): React.JSX.Element {
    return (
        <div className="desk">
            <div className="desk-bar">
                <span className="desk-mark" />
                <b>Editor</b>
                <span>File</span>
                <span>Edit</span>
                <span>View</span>
                <span>Go</span>
                <span className="desk-spacer" />
                <span className="desk-tray" />
                <span className="desk-tray" />
                <span className="desk-orb" />
                <span>08:34</span>
            </div>
            {children}
        </div>
    );
}

/** A blurred stand-in for whatever the user actually had open. */
function BackdropWindow(): React.JSX.Element {
    const widths = [72, 46, 88, 34, 61, 79, 25, 54, 68, 41, 83, 30, 57, 74];
    return (
        <div className="fake-win">
            <div className="fake-bar">
                <i className="dot r" />
                <i className="dot y" />
                <i className="dot g" />
            </div>
            <div className="fake-body">
                <div className="fake-side">
                    {widths.slice(0, 8).map((width, index) => (
                        <span key={index} style={{ width: `${Math.min(88, width)}%` }} />
                    ))}
                </div>
                <div className="fake-code">
                    {widths.concat(widths.slice(2)).map((width, index) => (
                        <span
                            key={index}
                            className={index % 5 === 0 ? "hot" : index % 3 === 0 ? "warm" : ""}
                            style={{ width: `${width}%`, marginLeft: index % 4 === 2 ? 22 : 0 }}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}

/** One character, one mood, one label — the label straight from `MOODS`. */
function Tile({ mood, size }: { mood: Mood | "swarm"; size: number }): React.JSX.Element {
    const pose = mood === "swarm" ? SWARM_POSE : POSES[mood];
    const derived = deriveMood(pose.state, pose.typing);
    const props = buddyProps(pose);
    const label = mood === "swarm" ? `${props.agents.length} agents running` : MOODS[derived].label;
    return (
        <div className="tile" style={{ width: size, height: size }}>
            <div className="tile-art">
                <Buddy mood={derived} agents={props.agents} blockedCount={props.blockedCount} />
            </div>
            <span className="tile-label" style={{ color: MOODS[derived].accent }}>
                {label}
            </span>
        </div>
    );
}

// MARK: - App scenes

const APP_STATES: Record<string, () => OrbitState> = {
    hero: () =>
        baseState({
            messages: MESSAGES,
            agents: [AGENTS.flaky, AGENTS.deps, AGENTS.notes],
            lastInteractionAt: EPOCH - 4_000,
        }),
    deck: () =>
        baseState({
            messages: MESSAGES,
            agents: [AGENTS.flaky, AGENTS.deps, AGENTS.notes, AGENTS.links],
            lastInteractionAt: EPOCH - 4_000,
        }),
    ambient: () =>
        baseState({
            chatOpen: false,
            agents: SWARM.slice(0, 3),
            messages: MESSAGES,
            lastInteractionAt: EPOCH - 4_000,
            bubble: {
                text: "Release notes for 0.4 are drafted — want the PR?",
                until: EPOCH + 3_600_000,
            },
        }),
};

/** The real window, at the real default size, where it really sits. */
function AppFrame(): React.JSX.Element {
    return (
        <div className="app-frame">
            <App />
        </div>
    );
}

// MARK: - Stage

function Stage({ shot }: { shot: Shot | undefined }): React.JSX.Element | null {
    if (!shot) return null;
    const style = { width: shot.width, height: shot.height, zoom: shot.zoom };

    if (shot.kind === "tile" || shot.kind === "sheet") {
        return (
            <div className="stage" style={style}>
                <Tile mood={shot.pose ?? "idle"} size={shot.width} />
            </div>
        );
    }
    return (
        <div className="stage" style={style}>
            <Desktop>
                {shot.width > 900 && <BackdropWindow />}
                <AppFrame />
            </Desktop>
        </div>
    );
}

/** Wrapper so the driver can swap poses through React rather than around it. */
function Root(): React.JSX.Element | null {
    const [shot, setShot] = useState<Shot | undefined>();
    useEffect(() => {
        mount = setShot;
    }, []);
    return <Stage shot={shot} />;
}

let mount: ((shot: Shot | undefined) => void) | undefined;

const root = createRoot(document.getElementById("stage")!);
root.render(<Root />);

// MARK: - Driver API

function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Drive the real composer the way a person would. React listens for `input`,
 * and React's own value tracker has to be bypassed with the native setter or
 * the change is swallowed as a no-op.
 */
function compose(text: string): void {
    const field = document.querySelector<HTMLTextAreaElement>(".composer textarea");
    if (!field || field.value === text) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * CSS animations (the caret, the typing hop, the spinning agent dots) run on
 * the browser's own clock, which would leave them at a different phase in
 * every captured frame. Pinning them to virtual time makes them part of the
 * same deterministic timeline as everything else.
 */
function syncCssAnimations(): void {
    for (const animation of document.getAnimations()) {
        animation.pause();
        try {
            animation.currentTime = clockNow();
        } catch {
            /* an animation that has already finished cannot be seeked */
        }
    }
}

let active: Shot | undefined;

async function strike(index: number): Promise<void> {
    const shot = SHOTS[index];
    active = shot;
    resetClock();

    // Tear the previous scene down first: the app keeps internal state (open
    // panel, deck tab, composer text) that must not leak between shots.
    flushSync(() => mount?.(undefined));
    await settle();

    if (shot.kind === "app") {
        currentState = shot.timeline ? DEMO_BEATS[0].state() : APP_STATES[shot.appState ?? "hero"]();
    }
    flushSync(() => mount?.(shot));
    if (shot.kind === "app") {
        pushScene(shot.scene ?? "chat");
        pushState(currentState);
    }
    await settle();
    await settle();
    await document.fonts.ready;

    for (let step = 0; step < Math.round((shot.warmup ?? 0) / 16); step += 1) tickClock(16);
    if (shot.kind === "app") applyTimeline(0);
    syncCssAnimations();
    await settle();
}

/** Fast-forward the timeline to `elapsed` and hand the app the matching state. */
function applyTimeline(elapsed: number): void {
    if (!active?.timeline) return;
    let chosen = DEMO_BEATS[0];
    for (const candidate of DEMO_BEATS) if (candidate.at <= elapsed) chosen = candidate;
    if (chosen.scene) pushScene(chosen.scene);
    pushState(chosen.state());
    if (chosen.compose !== undefined) compose(chosen.compose);
}

let elapsed = 0;

function advance(ms: number): void {
    elapsed += ms;
    if (active?.timeline) {
        // State first, so the mood the character animates into this frame is
        // the one the panel is showing.
        applyTimeline(elapsed);
    }
    tickClock(ms);
    syncCssAnimations();
}

interface StageApi {
    shots(): Shot[];
    pose(index: number): Promise<void>;
    advance(ms: number): void;
}

const api: StageApi = {
    shots: () => SHOTS,
    pose: async (index: number) => {
        elapsed = 0;
        await strike(index);
    },
    advance,
};

(window as unknown as { __stage: StageApi }).__stage = api;
