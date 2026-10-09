import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, DeckSection, DictationSupport, OrbitState } from "../../shared/types.js";
import { DECK_SECTIONS, isDeckSection } from "../../shared/types.js";
import { MOODS, headline } from "../mood.js";
import type { Mood } from "../../shared/types.js";
import { onScene } from "../scene.js";
import { Icon } from "./Icon.js";
import { Message, useAutoScroll } from "./Message.js";
import { MissionControl } from "./MissionControl.js";
import { onReaderOpen } from "../reader.js";
import { NavRail } from "./NavRail.js";
import { buildRoster, layoutRoster } from "../roster.js";

const QUICK_ACTIONS = [
    "What's running?",
    "Brief me at 8:30 every morning",
    "Summarise this repo",
    "Watch my repo for failing tests every 30m",
];

/**
 * Scene names from the capture harness, which predate the rail and still say
 * `agents` and `watchers`. They are aliases rather than a rename so an old
 * capture script keeps posing the panel at the section it meant.
 */
const SCENE_ALIASES: Array<[string, DeckSection]> = [
    ["agents", "work"],
    ["watchers", "work"],
    ["history", "log"],
];

interface Props {
    state: OrbitState;
    mood: Mood;
    onClose(): void;
    onTypingChange(typing: boolean): void;
}

export function ChatPanel({ state, mood, onClose, onTypingChange }: Props): React.JSX.Element {
    const [draft, setDraft] = useState("");
    const [deckOpen, setDeckOpen] = useState(false);
    // Seeded from the saved choice so reopening Orbit lands where he left it,
    // then owned locally: a click must switch the pane whether or not the
    // write to settings.json comes back.
    const [section, setSection] = useState<DeckSection>(() =>
        isDeckSection(state.settings.deckSection) ? state.settings.deckSection : "board",
    );
    /** The document the viewer is showing. Set by a click on a file anywhere. */
    const [reading, setReading] = useState<string | undefined>(undefined);
    /**
     * The thread being worked in. Independent of `section`: looking at the log
     * does not leave the thread, which is the whole reason the rail carries two
     * marks rather than one.
     */
    const [activeThreadId, setActiveThreadId] = useState<string | undefined>(undefined);
    /** How many faces the rail has room for. Measured by the rail itself. */
    const [capacity, setCapacity] = useState(6);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const scrollRef = useAutoScroll(state.messages.length + (state.messages.at(-1)?.text.length ?? 0));
    const palette = MOODS[mood];

    const roster = useMemo(() => buildRoster(state), [state.agents, state.board]);
    const layout = useMemo(
        () => layoutRoster(roster, capacity, activeThreadId),
        [roster, capacity, activeThreadId],
    );
    const activeThread = roster.find((thread) => thread.id === activeThreadId);

    // A thread that leaves the roster entirely, because the user cleared
    // finished work, must not leave the panel stuck on a thread that no longer
    // exists with no way back to Orbit.
    useEffect(() => {
        if (activeThreadId && !roster.some((thread) => thread.id === activeThreadId)) {
            setActiveThreadId(undefined);
        }
    }, [roster, activeThreadId]);

    const onMeasure = useCallback((next: number) => setCapacity(next), []);

    /**
     * The transcript, narrowed to one thread.
     *
     * Messages are not stored against a thread, and threading the store
     * properly is a far larger piece of work than this redesign. What the store
     * already carries is enough to do this honestly: a spawn names the agents
     * it started, a completion names the agent that finished, and a request
     * resolves to an agent through the pending-request table. So the slice is
     * derived rather than invented, and it holds exactly the real messages
     * belonging to that thread and nothing else.
     *
     * The seam this leaves is written in plain words in the header: the
     * composer still talks to Orbit, because replying into an agent's own
     * session needs multi-turn agents, which Orbit does not have.
     */
    const threadMessages = useMemo((): ChatMessage[] => {
        if (!activeThreadId) return state.messages;
        const agentOf = (requestId: string): string | undefined =>
            state.requests.find((request) => request.id === requestId)?.agentId;
        return state.messages.filter((message) => {
            switch (message.kind.type) {
                case "spawn":
                    return message.kind.agentIds.includes(activeThreadId);
                case "completion":
                    return message.kind.agentId === activeThreadId;
                case "request":
                    return agentOf(message.kind.requestId) === activeThreadId;
                default:
                    return false;
            }
        });
    }, [state.messages, state.requests, activeThreadId]);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    // The capture harness names a scene "chat-deck-board" and expects both the
    // pane open and that section showing. Both live here now, so both are set
    // from the one place.
    useEffect(
        () =>
            onScene((scene) => {
                setDeckOpen(scene.includes("deck"));
                const alias = SCENE_ALIASES.find(([suffix]) => scene.endsWith(suffix));
                if (alias) {
                    setSection(alias[1]);
                    return;
                }
                const match = DECK_SECTIONS.find((id) => scene.endsWith(id));
                if (match) setSection(match);
            }),
        [],
    );

    // A click on a deliverable, from a chat bubble or from the board, opens the
    // viewer at it. It always opens the pane rather than toggling it: the click
    // was on a document, and a click that closed the thing showing the document
    // would be a click that did the opposite of what it said.
    useEffect(
        () =>
            onReaderOpen((path) => {
                setReading(path);
                setSection("read");
                setDeckOpen(true);
                void window.orbit.setSettings({ deckSection: "read" });
            }),
        [],
    );

    /**
     * The rail is permanent, so it has to be able to close what it opens:
     * clicking the section already showing puts the transcript back. Anything
     * else opens the pane at what was clicked.
     */
    const chooseSection = (id: DeckSection): void => {
        if (deckOpen && id === section) {
            setDeckOpen(false);
            return;
        }
        setSection(id);
        setDeckOpen(true);
        if (id !== section) void window.orbit.setSettings({ deckSection: id });
    };

    useEffect(() => {
        onTypingChange(draft.trim().length > 0);
    }, [draft, onTypingChange]);

    // The composer grows with what is in it. Dictation arrives as whole
    // sentences rather than keystrokes, so a fixed two-line box hides most of
    // what was just said at exactly the moment the user needs to check it.
    // Height is reset before it is measured, otherwise `scrollHeight` only ever
    // reports the previous, larger box and the field could never shrink back.
    // The cap lives in CSS as `max-height`, so the box stops growing and starts
    // scrolling at the same point.
    useEffect(() => {
        const node = inputRef.current;
        if (!node) return;
        node.style.height = "auto";
        // `scrollHeight` covers content and padding but not the border, which
        // `box-sizing: border-box` makes part of the height being set; without
        // it the field is permanently one border-width short and scrolls by a
        // pixel or two at every size.
        const borders = node.offsetHeight - node.clientHeight;
        node.style.height = `${node.scrollHeight + borders}px`;
    }, [draft]);

    const ready = state.runtime === "ready";

    const submit = (override?: string): void => {
        const text = (override ?? draft).trim();
        if (!text || !ready) return;
        setDraft("");
        void window.orbit.send(text);
    };

    // Speech goes in as if it had been typed: partials fill the composer so the
    // user can see they are being heard, and the final transcript is sent.
    const voice = useDictation({
        onPartial: setDraft,
        onFinal: (text) => {
            setDraft("");
            submit(text);
        },
        onDiscard: () => setDraft(""),
    });

    // ⌘⇧M / Ctrl⇧M toggles the mic. A modifier combo rather than a bare key so
    // it still works with the cursor in the composer. The handler reads the
    // dictation state through a ref, so the listener is bound once instead of
    // being torn down and re-added on every keystroke.
    const voiceRef = useRef(voice);
    voiceRef.current = voice;
    useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === "KeyM") {
                event.preventDefault();
                voiceRef.current.toggle();
            } else if (event.key === "Escape" && voiceRef.current.busy) {
                event.preventDefault();
                voiceRef.current.cancel();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    return (
        <section className="panel" data-interactive>
            <ResizeGrip />

            <NavRail
                state={state}
                section={section}
                open={deckOpen}
                layout={layout}
                activeThreadId={activeThreadId}
                onSelect={chooseSection}
                onSelectThread={setActiveThreadId}
                onMeasure={onMeasure}
            />

            <div className="panel-main">
                <header className="panel-head">
                    {activeThread ? (
                        <>
                            {/*
                             * The monogram follows the thread out of the rail:
                             * the same two letters in the same hue, which is
                             * what lets a 28px puck in a column and a mark
                             * fourteen pixels high be recognisably one thing.
                             */}
                            <span
                                className="head-puck"
                                style={{ ["--puck-hue" as string]: String(Math.round(activeThread.hue * 360)) }}
                            >
                                {activeThread.monogram}
                            </span>
                            <div className="panel-title">
                                <strong>{activeThread.title}</strong>
                                {/*
                                 * Said plainly rather than implied. The composer
                                 * below is addressed to Orbit, and a header that
                                 * let the user believe otherwise would be a much
                                 * worse failure than an inelegant line of text.
                                 */}
                                <span className="muted">reading · the composer still talks to Orbit</span>
                            </div>
                        </>
                    ) : (
                        <>
                            <span className="status-dot" style={{ background: palette.accent }} />
                            <div className="panel-title">
                                <strong>Orbit</strong>
                                <span className="muted">{headline(state)}</span>
                            </div>
                            <span
                                className="mood-chip"
                                style={{ color: palette.accent, background: `${palette.accent}22` }}
                            >
                                {palette.label}
                            </span>
                        </>
                    )}
                    <button
                        className={`icon-button ${state.settings.yolo ? "danger" : ""}`}
                        title={
                            state.settings.yolo
                                ? "Approving everything. Click to require approval again."
                                : "Asking before commands and edits. Click to approve everything (YOLO)."
                        }
                        aria-label={state.settings.yolo ? "Require approval" : "Approve everything"}
                        onClick={() => void window.orbit.setSettings({ yolo: !state.settings.yolo })}
                    >
                        <Icon name={state.settings.yolo ? "bolt" : "shield"} />
                    </button>
                    <button
                        className="icon-button"
                        title="Restart Orbit to load new code, keeping this conversation"
                        aria-label="Restart Orbit to load new code, keeping this conversation"
                        onClick={() => void window.orbit.softRestart()}
                    >
                        <Icon name="restart" />
                    </button>
                    <button
                        className="icon-button"
                        title="Hide the chat panel"
                        aria-label="Hide the chat panel"
                        onClick={onClose}
                    >
                        <Icon name="close" />
                    </button>
                </header>

                {deckOpen && <MissionControl state={state} section={section} reading={reading} />}

                <div className="transcript" ref={scrollRef}>
                    {threadMessages.map((message) => (
                        <Message key={message.id} state={state} message={message} />
                    ))}
                    {activeThread && threadMessages.length === 0 && (
                        <p className="thread-empty muted small">
                            Nothing from {activeThread.title} has reached the transcript yet. What it
                            is doing right now is in the work section.
                        </p>
                    )}
                    {!activeThread && state.orbitBusy && !state.messages.at(-1)?.streaming && (
                        <div className="typing">
                            <i style={{ background: palette.accent }} />
                            <i style={{ background: palette.accent }} />
                            <i style={{ background: palette.accent }} />
                        </div>
                    )}
                </div>

                {!activeThread && state.messages.length < 3 && !voice.busy && voice.state === "idle" && (
                    <div className="quick">
                        {QUICK_ACTIONS.map((action) => (
                            <button
                                key={action}
                                className="chip chip-neutral"
                                title={`Ask Orbit: ${action}`}
                                onClick={() => void window.orbit.send(action)}
                            >
                                {action}
                            </button>
                        ))}
                    </div>
                )}

                {(voice.busy || voice.state === "transcribing" || voice.state === "error") && (
                    <VoiceStatus voice={voice} />
                )}

                <form
                    className="composer"
                    onSubmit={(event) => {
                        event.preventDefault();
                        submit();
                    }}
                >
                    <textarea
                        ref={inputRef}
                        rows={1}
                        value={draft}
                        readOnly={voice.busy}
                        placeholder={
                            ready ? "Ask Orbit to do something…" : "waiting for Copilot…"
                        }
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey) {
                                event.preventDefault();
                                submit();
                            }
                        }}
                    />
                    <button
                        type="button"
                        className={`icon-button mic ${voice.busy ? "on" : ""}`}
                        aria-label={voice.busy ? "Stop dictating and send" : "Dictate a message"}
                        disabled={!ready || voice.support?.available === false}
                        title={
                            voice.support?.available === false
                                ? (voice.support.reason ?? "Dictation isn't available on this Mac.")
                                : voice.busy
                                  ? "Stop and send (⌘⇧M) · Esc to discard"
                                  : "Talk to Orbit (⌘⇧M)"
                        }
                        onClick={() => voice.toggle()}
                    >
                        <Icon name={voice.busy ? "stop" : "mic"} />
                    </button>
                    {state.orbitBusy ? (
                        <button
                            type="button"
                            className="send stop"
                            title="Stop what Orbit is doing"
                            aria-label="Stop what Orbit is doing"
                            onClick={() => void window.orbit.abort()}
                        >
                            <Icon name="stop" />
                        </button>
                    ) : (
                        <button
                            type="submit"
                            className="send"
                            style={{ background: palette.accent }}
                            disabled={!draft.trim() || voice.busy}
                            title="Send (Enter) · Shift+Enter for a new line"
                            aria-label="Send message"
                        >
                            <Icon name="send" />
                        </button>
                    )}
                </form>
            </div>
        </section>
    );
}

const VOICE_LABELS: Record<VoiceState, string> = {
    idle: "",
    starting: "opening the mic…",
    waiting: "macOS is asking for microphone and speech permission…",
    recording: "listening — ⌘⇧M to send, Esc to discard",
    transcribing: "transcribing…",
    error: "",
};

/** The recording banner: what Orbit is doing with the mic, and a way out. */
function VoiceStatus({ voice }: { voice: Dictation }): React.JSX.Element {
    if (voice.state === "error") {
        return (
            <div className="voice-state bad">
                <span className="voice-text">{voice.error}</span>
                <button
                    className="icon-button tiny"
                    title="Dismiss"
                    aria-label="Dismiss"
                    onClick={() => voice.dismiss()}
                >
                    <Icon name="close" />
                </button>
            </div>
        );
    }
    return (
        <div className="voice-state">
            <i className="voice-dot" />
            <span className="voice-text">{VOICE_LABELS[voice.state]}</span>
            <button
                className="icon-button tiny"
                title="Discard what you said (Esc)"
                aria-label="Discard what you said"
                onClick={() => voice.cancel()}
            >
                <Icon name="close" />
            </button>
        </div>
    );
}

type VoiceState = "idle" | "starting" | "waiting" | "recording" | "transcribing" | "error";

interface Dictation {
    state: VoiceState;
    /** True whenever the microphone is open or the transcript is still coming. */
    busy: boolean;
    error?: string;
    support?: DictationSupport;
    toggle(): void;
    cancel(): void;
    dismiss(): void;
}

/**
 * Drives the microphone helper in the main process. Dictation is deliberately
 * one-shot: start, speak, stop, and the transcript is sent as a message. There
 * is no background listening.
 */
function useDictation(handlers: {
    onPartial(text: string): void;
    onFinal(text: string): void;
    onDiscard(): void;
}): Dictation {
    const [state, setState] = useState<VoiceState>("idle");
    const [error, setError] = useState<string | undefined>();
    const [support, setSupport] = useState<DictationSupport | undefined>();

    // Held in a ref so the event subscription is made once, not on every
    // keystroke that changes the enclosing component's closures.
    const latest = useRef(handlers);
    latest.current = handlers;

    useEffect(() => {
        let cancelled = false;
        void window.orbit.dictationSupport().then((result) => {
            if (!cancelled) setSupport(result);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        const off = window.orbit.onDictation((event) => {
            switch (event.type) {
                case "ready":
                    setState("recording");
                    break;
                case "waiting":
                    setState("waiting");
                    break;
                case "partial":
                    setState("recording");
                    latest.current.onPartial(event.text);
                    break;
                case "final":
                    setState("idle");
                    if (event.text.trim()) latest.current.onFinal(event.text.trim());
                    else latest.current.onDiscard();
                    break;
                case "cancelled":
                    setState("idle");
                    latest.current.onDiscard();
                    break;
                case "error":
                    setState("error");
                    setError(event.message);
                    latest.current.onDiscard();
                    break;
            }
        });
        return off;
    }, []);

    // Never leave the microphone open behind a closed panel.
    useEffect(() => () => void window.orbit.cancelDictation(), []);

    const busy = state === "starting" || state === "waiting" || state === "recording";

    return {
        state,
        busy,
        error,
        support,
        toggle: () => {
            if (busy) {
                setState("transcribing");
                void window.orbit.stopDictation();
                return;
            }
            if (state === "transcribing") return;
            setError(undefined);
            setState("starting");
            void window.orbit.startDictation();
        },
        cancel: () => {
            setState("idle");
            void window.orbit.cancelDictation();
        },
        dismiss: () => {
            setState("idle");
            setError(undefined);
        },
    };
}

/**
 * Drag-to-resize handle in the panel's top-left corner. The bottom-right corner
 * is anchored by the main process, so the buddy — which lives there — stays put
 * while the panel grows up and to the left.
 *
 * Deltas are sent to the main process rather than applied here, because only it
 * can size the window; screen coordinates are used so the drag survives the
 * window moving out from under the cursor.
 *
 * The drag is driven by pointer events with an explicit pointer capture instead
 * of window-level mouse listeners. That matters twice over in this app:
 * capture keeps events flowing after the cursor leaves the 26px grip, and the
 * click-through layer in App.tsx flips the whole window to
 * `setIgnoreMouseEvents(true)` as soon as the cursor sits over a non-interactive
 * pixel — which happens the moment the window stops tracking the cursor at its
 * minimum or maximum size. Without capture the drag simply died there.
 */
function ResizeGrip(): React.JSX.Element {
    const origin = useRef<{ x: number; y: number } | undefined>(undefined);
    const [dragging, setDragging] = useState(false);

    // While resizing, keep App's click-through watcher from re-evaluating what
    // is under the cursor: it listens for `mousemove` on window, so a
    // capture-phase listener on the same target can stop it before it runs. If
    // it fired mid-drag it would hand the window back to the OS as
    // click-through and cut the drag short.
    useEffect(() => {
        if (!dragging) return;
        const swallow = (event: MouseEvent): void => event.stopImmediatePropagation();
        window.addEventListener("mousemove", swallow, true);
        return () => window.removeEventListener("mousemove", swallow, true);
    }, [dragging]);

    const end = (event: React.PointerEvent<HTMLDivElement>): void => {
        if (!origin.current) return;
        origin.current = undefined;
        setDragging(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };

    return (
        <div
            className="resize-grip"
            data-interactive
            data-dragging={dragging || undefined}
            title="Drag to resize"
            onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                origin.current = { x: event.screenX, y: event.screenY };
                setDragging(true);
            }}
            onPointerMove={(event) => {
                const from = origin.current;
                if (!from) return;
                const dx = event.screenX - from.x;
                const dy = event.screenY - from.y;
                if (dx === 0 && dy === 0) return;
                origin.current = { x: event.screenX, y: event.screenY };
                // Positive dx/dy drag the top-left corner in, shrinking the
                // window; the main process clamps to the minimum size.
                void window.orbit.resizeWindow(dx, dy);
            }}
            onPointerUp={end}
            onPointerCancel={end}
        />
    );
}


