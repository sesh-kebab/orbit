/**
 * Icon stage.
 *
 * Renders the app icon and the tray icons from the *real* `Buddy` component,
 * so the thing in the Dock is the same character as the thing on screen and
 * cannot drift from it. Nothing here ships: this is served to a headless
 * Electron window by `run.mjs`, photographed, and thrown away.
 *
 * The app icon is the character on a rounded-square plate. macOS, Windows and
 * Linux all letterbox a bare transparent glyph differently, and a plate is
 * what makes it read as an application rather than a sticker.
 *
 * Tray icons are a different problem and get a different treatment: at 16-22px
 * the character's face is illegible, and macOS wants a monochrome template it
 * can invert for dark and light menu bars. So the tray mark is the silhouette
 * plus the antenna — recognisably Orbit at a glance, legible at 16px.
 */

import { createRoot } from "react-dom/client";
import { Buddy } from "../../src/renderer/components/Buddy.js";
import type { Mood } from "../../src/shared/types.js";
// The buddy's layers are positioned by the app's own stylesheet; without it the
// character renders as unstyled, overlapping fragments.
import "../../src/renderer/styles.css";
import "./stage.css";

export interface IconShot {
    name: string;
    size: number;
    /** Written under build/ rather than assets/. */
    out: string;
}

/**
 * One 1024px master is enough: electron-builder derives every macOS `.icns`
 * and Windows `.ico` size from it, and Linux takes the PNG directly.
 */
export const SHOTS: IconShot[] = [
    { name: "app", size: 1024, out: "icon.png" },
    { name: "tray", size: 32, out: "tray/idle.png" },
    { name: "tray-attention", size: 32, out: "tray/attention.png" },
    { name: "tray-error", size: 32, out: "tray/error.png" },
];

/** Orbit's idle mint, the colour it wears most of the time. */
const MARK = "#70D4C2";

const TRAY_MOOD: Record<string, Mood> = {
    tray: "idle",
    "tray-attention": "needsInput",
    "tray-error": "broken",
};

function AppIcon({ size }: { size: number }): React.JSX.Element {
    // The buddy's 230px box reserves space for the aura and orbiting motes, so
    // the character itself only occupies the middle ~150px. Scale against that
    // rather than the box, or the artwork floats undersized on the plate.
    const art = 152;
    const scale = (size * 0.76) / art;
    return (
        <div className="plate" style={{ width: size, height: size, borderRadius: size * 0.225 }}>
            <div
                className="plate-art"
                style={{
                    left: "50%",
                    top: "51%",
                    transform: `translate(-50%, -50%) scale(${scale})`,
                }}
            >
                <Buddy mood="idle" agents={[]} blockedCount={0} />
            </div>
        </div>
    );
}

/**
 * A flat mark rather than the full character: at 16-22px the face is illegible.
 *
 * These are for Windows and Linux — macOS keeps its text face — so they are
 * drawn in Orbit's mint rather than as a monochrome template. A taskbar may be
 * light or dark depending on theme, and a black silhouette disappears on one
 * while a white one disappears on the other; a mid-tone colour with a dark rim
 * survives both.
 */
function TrayIcon({ mood, size }: { mood: Mood; size: number }): React.JSX.Element {
    const attention = mood === "needsInput";
    const broken = mood === "broken";
    return (
        <svg width={size} height={size} viewBox="0 0 32 32" className="tray">
            <g stroke="#12202a" strokeWidth="1.2" strokeLinejoin="round">
                <rect x="15.2" y="7" width="1.6" height="5.5" rx="0.8" fill={MARK} />
                <circle cx="16" cy="6" r="2.4" fill={MARK} />
                <rect x="7" y="12" width="18" height="15" rx="6.5" fill={MARK} />
            </g>
            {attention && <circle cx="24.5" cy="10.5" r="3.6" fill="#FF7585" stroke="#12202a" strokeWidth="1.2" />}
            {broken && (
                <>
                    <path d="M11.5 17.5l3.5 3.5M15 17.5l-3.5 3.5" stroke="#12202a" strokeWidth="1.8" strokeLinecap="round" />
                    <path d="M17 17.5l3.5 3.5M20.5 17.5l-3.5 3.5" stroke="#12202a" strokeWidth="1.8" strokeLinecap="round" />
                </>
            )}
        </svg>
    );
}

function Stage(): React.JSX.Element {
    return <div id="stage" />;
}

const root = createRoot(document.getElementById("root")!);
root.render(<Stage />);

/** The Electron driver poses the stage through this, one shot at a time. */
declare global {
    interface Window {
        __icons: {
            shots(): IconShot[];
            pose(name: string): Promise<void>;
        };
    }
}

window.__icons = {
    shots: () => SHOTS,
    pose: (name: string) =>
        new Promise((resolve) => {
            const shot = SHOTS.find((s) => s.name === name)!;
            const node = document.getElementById("stage")!;
            node.style.width = `${shot.size}px`;
            node.style.height = `${shot.size}px`;
            createRoot(node).render(
                name === "app" ? (
                    <AppIcon size={shot.size} />
                ) : (
                    <TrayIcon mood={TRAY_MOOD[name] ?? "idle"} size={shot.size} />
                ),
            );
            // The buddy's blink cycle starts at t=0 and its first blink runs
            // for the first 180ms, so a fast shutter always catches it with
            // its eyes shut. Wait past that — and well short of the next blink
            // at 3.8s — so the icon is captured wide awake.
            requestAnimationFrame(() =>
                requestAnimationFrame(() => setTimeout(resolve, 600)),
            );
        }),
};
