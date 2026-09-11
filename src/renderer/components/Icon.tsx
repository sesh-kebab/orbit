/**
 * The icon set.
 *
 * Every icon in the UI comes from here so they share one visual language:
 * a 16×16 box, `currentColor`, and a single stroke weight. The alternative —
 * text glyphs and emoji — is what this replaces, because the two never sat
 * together. Emoji are full-colour bitmaps supplied by the OS font at their own
 * optical size and baseline, so `🛡` and `✕` in adjacent buttons disagreed on
 * weight, colour and vertical centring no matter how the button was styled.
 *
 * Sizing is `1.2em`, so an icon scales with whatever font-size its button sets
 * and inherits colour from `currentColor` — hover, disabled and accent states
 * need no icon-specific rules.
 */

export type IconName =
    | "close"
    | "restart"
    | "deck"
    | "shield"
    | "bolt"
    | "mic"
    | "send"
    | "stop"
    | "pause"
    | "play"
    | "archive"
    | "unarchive"
    | "clock"
    | "folder"
    | "folderOpen"
    | "file"
    | "edit"
    | "check"
    | "alert"
    | "trash"
    | "run"
    | "book"
    | "sliders";

/**
 * Paths are drawn on a 16×16 grid, centred, with 2px of breathing room so no
 * icon touches the edge of a round button.
 */
const PATHS: Record<IconName, React.ReactNode> = {
    close: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
    restart: (
        <>
            <path d="M13 8a5 5 0 1 1-1.7-3.75" />
            <path d="M13 2.5V5h-2.5" />
        </>
    ),
    deck: (
        <>
            <path d="M8 2l5.5 3L8 8 2.5 5 8 2z" />
            <path d="M2.5 8L8 11l5.5-3" />
            <path d="M2.5 11L8 14l5.5-3" />
        </>
    ),
    shield: <path d="M8 2l5 2v4c0 3-2.2 5.1-5 6-2.8-.9-5-3-5-6V4l5-2z" />,
    bolt: <path d="M9 2L4 9h3.2L7 14l5-7H8.8L9 2z" />,
    mic: (
        <>
            <rect x="6" y="2" width="4" height="7" rx="2" />
            <path d="M4 8v0.4a4 4 0 0 0 8 0V8" />
            <path d="M8 12.4V14" />
            <path d="M5.8 14h4.4" />
        </>
    ),
    send: <path d="M8 13V3.5M4 7l4-3.5L12 7" />,
    stop: <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" />,
    pause: <path d="M6 4v8M10 4v8" />,
    play: <path d="M5.5 3.5l7 4.5-7 4.5v-9z" />,
    archive: (
        <>
            <rect x="2.5" y="3" width="11" height="3" rx="1" />
            <path d="M3.5 6v6.5h9V6" />
            <path d="M6.5 8.5h3" />
        </>
    ),
    unarchive: (
        <>
            <rect x="2.5" y="3" width="11" height="3" rx="1" />
            <path d="M3.5 6v6.5h9V6" />
            <path d="M8 11.5V7.5M6.5 9L8 7.5 9.5 9" />
        </>
    ),
    clock: (
        <>
            <circle cx="8" cy="8" r="5.5" />
            <path d="M8 5v3.2l2 1.3" />
        </>
    ),
    folder: <path d="M2.5 12.5v-9h4l1.5 2h5.5v7h-11z" />,
    folderOpen: (
        <>
            <path d="M2.5 12.5v-9h4l1.5 2h5.5v2" />
            <path d="M2.5 12.5l2-5h10l-2 5h-10z" />
        </>
    ),
    file: (
        <>
            <path d="M4 2.5h5l3 3v8H4v-11z" />
            <path d="M9 2.5v3h3" />
        </>
    ),
    edit: (
        <>
            <path d="M11 2.5l2.5 2.5L6 12.5 3 13l.5-3L11 2.5z" />
            <path d="M9.5 4l2.5 2.5" />
        </>
    ),
    check: <path d="M3.5 8.5l3 3 6-7" />,
    alert: (
        <>
            <circle cx="8" cy="8" r="5.5" />
            <path d="M8 5v3.5M8 11h.01" />
        </>
    ),
    trash: (
        <>
            <path d="M3 4.5h10M6.5 4.5V3h3v1.5" />
            <path d="M4.5 4.5l.6 8.5h5.8l.6-8.5" />
        </>
    ),
    /*
     * Memory. A closed book rather than the pencil, which already means "edit
     * this file" on the button inside the memory section itself — a rail icon
     * that repeats a button underneath it reads as the same control twice.
     */
    book: (
        <>
            <path d="M3.5 3.2h6.2a2 2 0 0 1 2 2v7.6H5.5a2 2 0 0 1-2-2V3.2z" />
            <path d="M3.5 10.8a2 2 0 0 1 2-2h6.2" />
        </>
    ),
    /*
     * Appearance. Sliders rather than the shield, which the panel header
     * already uses for "asking before commands and edits" — the same glyph
     * meaning both "approval" and "fonts" is worse than no icon.
     */
    sliders: (
        <>
            <path d="M3 5h4.2M9.8 5H13M3 11h1.6M7.2 11H13" />
            <circle cx="8.5" cy="5" r="1.6" />
            <circle cx="5.9" cy="11" r="1.6" />
        </>
    ),
    run: (
        <>
            <circle cx="8" cy="8" r="5.5" />
            <path d="M6.8 5.8l3.4 2.2-3.4 2.2V5.8z" />
        </>
    ),
};

/** Icons that read better filled than stroked at this size. */
const FILLED: ReadonlySet<IconName> = new Set(["bolt", "play", "stop"]);

export function Icon({ name, className }: { name: IconName; className?: string }): React.JSX.Element {
    const filled = FILLED.has(name);
    return (
        <svg
            className={className ? `icon ${className}` : "icon"}
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
            fill={filled ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth={filled ? 1 : 1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            {PATHS[name]}
        </svg>
    );
}
