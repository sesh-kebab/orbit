import { useCallback, useEffect, useRef, useState } from "react";
import type { OrbitState } from "../shared/types.js";
import { CHAT_FONT_BASE, chatFontStack, isLive } from "../shared/types.js";
import { Buddy } from "./components/Buddy.js";
import { ChatPanel } from "./components/ChatPanel.js";
import { AgentShelf } from "./components/Message.js";
import { deriveMood } from "./mood.js";
import { onScene } from "./scene.js";

const DRAG_THRESHOLD = 4;

export function App(): React.JSX.Element {
    const [state, setState] = useState<OrbitState | undefined>();
    const [chatOpen, setChatOpen] = useState(false);
    const [typing, setTyping] = useState(false);
    // Re-derive the mood on a slow tick so napping and celebrating can expire.
    const [, setBeat] = useState(0);

    useEffect(() => {
        void window.orbit.getState().then(setState);
        const off = window.orbit.onState(setState);
        const beat = setInterval(() => setBeat((n) => n + 1), 1000);
        return () => {
            off();
            clearInterval(beat);
        };
    }, []);

    useEffect(() => {
        void window.orbit.setChatOpen(chatOpen);
    }, [chatOpen]);

    useClickThrough();

    // One preference drives every translucent surface.
    const panelOpacity = state?.settings.panelOpacity;
    useEffect(() => {
        if (panelOpacity === undefined) return;
        const root = document.documentElement.style;
        root.setProperty("--panel-alpha", String(panelOpacity));
        root.setProperty("--panel-alpha-strong", String(Math.min(1, panelOpacity + 0.08)));
        root.setProperty("--panel-alpha-pill", String(Math.max(0, panelOpacity - 0.1)));
    }, [panelOpacity]);

    // Font choices apply live: both are plain CSS custom properties, and every
    // size in styles.css is a ratio of the scale.
    const chatFontFamily = state?.settings.chatFontFamily;
    const chatFontSize = state?.settings.chatFontSize;
    useEffect(() => {
        if (chatFontFamily === undefined) return;
        document.documentElement.style.setProperty("--chat-font-family", chatFontStack(chatFontFamily));
    }, [chatFontFamily]);
    useEffect(() => {
        if (!chatFontSize) return;
        document.documentElement.style.setProperty(
            "--chat-font-scale",
            String(chatFontSize / CHAT_FONT_BASE),
        );
    }, [chatFontSize]);

    // Snapshot mode drives the panel into known states for visual verification.
    useEffect(
        () =>
            onScene((scene) => {
                if (scene.includes("chat") || scene.includes("deck")) setChatOpen(true);
                else if (scene.includes("ambient")) setChatOpen(false);
            }),
        [],
    );

    const onTypingChange = useCallback((value: boolean) => setTyping(value), []);

    if (!state) return <div className="root" />;

    const mood = deriveMood(state, typing && chatOpen);
    const live = state.agents.filter(isLive);
    const bubble = !chatOpen && state.bubble && state.bubble.until > Date.now() ? state.bubble : undefined;

    return (
        <div className="root">
            <div className="stack">
                {chatOpen ? (
                    <ChatPanel
                        state={state}
                        mood={mood}
                        onClose={() => setChatOpen(false)}
                        onTypingChange={onTypingChange}
                    />
                ) : (
                    bubble && (
                        <div className="speech" data-interactive onClick={() => setChatOpen(true)}>
                            <p>{bubble.text}</p>
                            <button
                                className="icon-button tiny"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    void window.orbit.dismissBubble();
                                }}
                            >
                                ✕
                            </button>
                        </div>
                    )
                )}

                {!chatOpen && live.length > 0 && <AgentShelf agents={live} requests={state.requests} />}

                <BuddyZone
                    onToggle={() => {
                        void window.orbit.poke();
                        setChatOpen((open) => !open);
                    }}
                >
                    <Buddy mood={mood} agents={live} blockedCount={state.requests.length} />
                </BuddyZone>
            </div>
        </div>
    );
}

/** Click opens the chat; dragging moves the whole window. */
function BuddyZone({
    children,
    onToggle,
}: {
    children: React.ReactNode;
    onToggle(): void;
}): React.JSX.Element {
    const dragging = useRef<{ x: number; y: number; moved: number } | undefined>(undefined);

    useEffect(() => {
        const onMove = (event: MouseEvent): void => {
            const drag = dragging.current;
            if (!drag) return;
            const dx = event.screenX - drag.x;
            const dy = event.screenY - drag.y;
            drag.moved += Math.abs(dx) + Math.abs(dy);
            drag.x = event.screenX;
            drag.y = event.screenY;
            if (dx !== 0 || dy !== 0) void window.orbit.moveWindow(dx, dy);
        };
        const onUp = (): void => {
            const drag = dragging.current;
            dragging.current = undefined;
            if (drag && drag.moved < DRAG_THRESHOLD) onToggle();
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        return () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
    }, [onToggle]);

    return (
        <div
            className="buddy-zone"
            data-interactive
            onMouseDown={(event) => {
                if (event.button !== 0) return;
                dragging.current = { x: event.screenX, y: event.screenY, moved: 0 };
            }}
        >
            {children}
        </div>
    );
}

/**
 * The window covers a big transparent area, so it stays click-through unless
 * the cursor is actually over the buddy or a panel.
 */
function useClickThrough(): void {
    const ignoring = useRef(true);
    useEffect(() => {
        void window.orbit.setIgnoreMouse(true);
        const onMove = (event: MouseEvent): void => {
            const target = document.elementFromPoint(event.clientX, event.clientY);
            const interactive = Boolean(target?.closest("[data-interactive]"));
            if (interactive === ignoring.current) {
                ignoring.current = !interactive;
                void window.orbit.setIgnoreMouse(!interactive);
            }
        };
        window.addEventListener("mousemove", onMove);
        return () => window.removeEventListener("mousemove", onMove);
    }, []);
}
