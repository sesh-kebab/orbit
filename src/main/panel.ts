import { BrowserWindow, screen, shell } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SavedWindow, WindowBounds } from "../shared/types.js";
import { WINDOW_STATE_VERSION } from "../shared/types.js";

/**
 * Wide enough for Mission Control's rail plus a pane worth reading, and tall
 * enough that the board does not have to fold everything. It was 480 wide,
 * which was a chat panel that happened to have a deck bolted above it; the
 * board made that a slit.
 */
export const PANEL_SIZE = { width: 720, height: 820 };

/**
 * Below this the transcript stops being readable and the composer starts
 * fighting the buddy for room. The buddy is 230px square, so the minimum
 * height has to leave space for it plus a usable panel. Both floors rose with
 * the rail. Width: 58px of it is the rail, and what is left has to still hold
 * a thread row's title, detail and clock without wrapping into mush. Height:
 * with Mission Control open the panel is split two-to-one between the deck and
 * the transcript, and the deck's two thirds have to stay tall enough for all
 * five rail sections to be reachable without scrolling the rail — which was
 * the thing the rail was built to stop.
 */
export const PANEL_MIN_SIZE = { width: 440, height: 660 };

export function createPanel(
    preload: string,
    rendererUrl: string | undefined,
    saved?: SavedWindow,
): BrowserWindow {
    const bounds = saved ? sanitize(saved) : defaultBounds();

    const window = new BrowserWindow({
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        minWidth: PANEL_MIN_SIZE.width,
        minHeight: PANEL_MIN_SIZE.height,
        frame: false,
        transparent: true,
        hasShadow: false,
        // The window is click-through everywhere except the buddy and the
        // panel, so its native edge handles are unreachable. Resizing happens
        // through the renderer's grip, which needs this flag to be honoured.
        resizable: true,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        // The panel must never steal focus when it appears; the renderer asks
        // for focus explicitly when the chat opens.
        focusable: true,
        show: false,
        acceptFirstMouse: true,
        webPreferences: {
            preload,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    window.setAlwaysOnTop(true, "floating");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // Clicks land on the buddy and the panels; everything else falls through to
    // whatever is behind the window. The renderer keeps this in sync.
    window.setIgnoreMouseEvents(false);

    if (rendererUrl) {
        void window.loadURL(rendererUrl);
    } else {
        void window.loadFile(bundledIndex());
    }

    // A window created with `show: false` only ever appears from
    // `ready-to-show`, which never fires if the load fails — leaving Orbit
    // running, invisible, with no way back. Fall back to the bundled renderer,
    // and show the window regardless so the user can still reach the tray.
    window.webContents.on("did-fail-load", (_event, code, description, url) => {
        console.error(`[orbit] renderer failed to load (${code} ${description}): ${url}`);
        if (rendererUrl && existsSync(bundledIndex())) {
            console.error("[orbit] falling back to the bundled renderer");
            void window.loadFile(bundledIndex());
            return;
        }
        if (!window.isDestroyed() && !window.isVisible()) window.showInactive();
    });

    window.once("ready-to-show", () => window.showInactive());

    window.webContents.setWindowOpenHandler(({ url }) => {
        void shell.openExternal(url);
        return { action: "deny" };
    });

    return window;
}

function bundledIndex(): string {
    return join(import.meta.dirname, "../renderer/index.html");
}

/**
 * In development the renderer is served by Vite, and that server dies with the
 * process that spawned it — including when Orbit relaunches itself. The stale
 * URL is inherited by the new process, so probe it before trusting it and fall
 * back to the last bundled renderer when it has gone.
 */
export async function resolveRendererUrl(devUrl: string | undefined): Promise<string | undefined> {
    if (!devUrl) return undefined;
    try {
        const response = await fetch(devUrl, {
            method: "HEAD",
            signal: AbortSignal.timeout(1500),
        });
        if (response.ok) return devUrl;
    } catch {
        /* dev server is gone */
    }
    if (existsSync(bundledIndex())) {
        console.error(`[orbit] dev server at ${devUrl} is gone; using the bundled renderer`);
        return undefined;
    }
    // Nothing bundled to fall back to: keep the dev URL so the failure is
    // visible in the log rather than silently loading a blank window.
    console.error(`[orbit] dev server at ${devUrl} is gone and no bundled renderer exists`);
    return devUrl;
}

/** Keep the panel fully on screen after a drag. */
export function clampToScreen(window: BrowserWindow): void {
    const bounds = window.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const area = display.workArea;
    const x = Math.min(Math.max(bounds.x, area.x - bounds.width + 120), area.x + area.width - 120);
    const y = Math.min(Math.max(bounds.y, area.y - 40), area.y + area.height - 120);
    if (x !== bounds.x || y !== bounds.y) {
        window.setBounds({ ...bounds, x: Math.round(x), y: Math.round(y) });
    }
}

/** Bottom-right of the primary display, which is where the buddy belongs. */
export function defaultBounds(): WindowBounds {
    const area = screen.getPrimaryDisplay().workArea;
    return {
        width: PANEL_SIZE.width,
        height: PANEL_SIZE.height,
        x: Math.round(area.x + area.width - PANEL_SIZE.width - 24),
        y: Math.round(area.y + area.height - PANEL_SIZE.height - 12),
    };
}

/**
 * Resize from the top-left corner, anchoring the bottom-right. The buddy sits
 * in that corner, so anchoring it means the thing under the user's cursor
 * doesn't slide away while they drag.
 */
export function resizeFromTopLeft(window: BrowserWindow, dx: number, dy: number): void {
    const bounds = window.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const right = bounds.x + bounds.width;
    const bottom = bounds.y + bounds.height;

    const width = Math.round(clamp(bounds.width - dx, PANEL_MIN_SIZE.width, area.width));
    const height = Math.round(clamp(bounds.height - dy, PANEL_MIN_SIZE.height, area.height));
    if (width === bounds.width && height === bounds.height) return;

    window.setBounds({ width, height, x: right - width, y: bottom - height });
}

/**
 * A saved size is only usable if it still fits a display that still exists —
 * monitors get unplugged between launches.
 *
 * A window saved before the nav rail existed is also grown once, to the size
 * the rail was designed against. Without it the change would land invisibly
 * for the only person who has an existing window.json: the rail would appear
 * inside the same 480px slit it was built to end. It happens exactly once,
 * keyed off the version stamped on every save from now on, so a window he
 * narrows afterwards stays narrow.
 */
export function sanitize(saved: SavedWindow): WindowBounds {
    const area = screen.getDisplayMatching(saved).workArea;
    const stale = (saved.v ?? 0) < WINDOW_STATE_VERSION;
    // Grown from the bottom-right, which is where the buddy lives and where
    // the user last put the window.
    const wanted = stale
        ? {
              width: Math.max(saved.width, PANEL_SIZE.width),
              height: Math.max(saved.height, PANEL_SIZE.height),
          }
        : { width: saved.width, height: saved.height };

    const width = Math.round(clamp(wanted.width, PANEL_MIN_SIZE.width, area.width));
    const height = Math.round(clamp(wanted.height, PANEL_MIN_SIZE.height, area.height));
    const right = saved.x + saved.width;
    const bottom = saved.y + saved.height;
    const anchored = stale ? { x: right - width, y: bottom - height } : { x: saved.x, y: saved.y };

    const x = Math.round(clamp(anchored.x, area.x - width + 120, area.x + area.width - 120));
    const y = Math.round(clamp(anchored.y, area.y - 40, area.y + area.height - 120));
    return { x, y, width, height };
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), Math.max(min, max));
}
