import { BrowserWindow, Menu, Tray, app, dialog, ipcMain, nativeImage, shell } from "electron";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Settings } from "../shared/types.js";
import { CHAT_FONTS, CHAT_FONT_SIZES } from "../shared/types.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { Persistence } from "./persistence.js";
import { inspectPaths, openExternalUrl, openPath, revealPath } from "./reveal.js";
import { migrateLegacyState } from "./migrate.js";
import { clampToScreen, createPanel, defaultBounds, resizeFromTopLeft, resolveRendererUrl } from "./panel.js";
import { loadSettings, normalizeSettings, saveSettings, watchSettings } from "./settings.js";
import {
    cancelDictation,
    dictationSupport,
    startDictation,
    stopDictation,
} from "./speech/index.js";
import { Store } from "./store.js";

const SNAPSHOT = process.env.ORBIT_SNAPSHOT === "1";

let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let store: Store;
let orchestrator: Orchestrator;
let disk: Persistence;
let tickTimer: NodeJS.Timeout | undefined;
let unwatchSettings: (() => void) | undefined;
let boundsTimer: NodeJS.Timeout | undefined;
let restarting = false;

// An unattended desktop companion must not vanish because of one bad promise.
process.on("uncaughtException", (error) => {
    console.error("[orbit] uncaught exception:", error);
});
process.on("unhandledRejection", (reason) => {
    console.error("[orbit] unhandled rejection:", reason);
});

if (process.platform === "darwin") {
    // Accessory app: no Dock icon, lives in the menu bar.
    app.dock?.hide();
}

app.on("window-all-closed", () => {
    // The buddy lives in the tray; closing the panel shouldn't quit.
});

void app.whenReady().then(async () => {
    // Before anything touches disk: the rename left the previous name's state
    // behind, and every read below would otherwise start from empty.
    migrateLegacyState();

    const settings = loadSettings();
    store = new Store(settings);
    disk = new Persistence();
    orchestrator = new Orchestrator(store, disk);

    const preload = join(import.meta.dirname, "../preload/index.mjs");
    const devUrl = await resolveRendererUrl(process.env.ELECTRON_RENDERER_URL);
    window = createPanel(preload, devUrl, disk.loadWindowBounds());
    trackBounds(window);

    orchestrator.onSoftRestart = relaunch;

    store.on("state", (state) => {
        if (window && !window.isDestroyed()) {
            window.webContents.send("orbit:state", state);
        }
    });

    registerIpc();
    createTray();

    tickTimer = setInterval(() => orchestrator.tick(), 1000);
    unwatchSettings = watchSettings((next) => void adoptSettings(next));

    await orchestrator.start();

    if (SNAPSHOT) {
        await runSnapshots();
    }
});

app.on("before-quit", async (event) => {
    if (tickTimer) clearInterval(tickTimer);
    unwatchSettings?.();
    cancelDictation();
    event.preventDefault();
    persistBounds();
    await orchestrator?.stop().catch(() => undefined);
    store?.dispose();
    app.exit(0);
});

/**
 * Remember where the user left the panel. Electron fires these continuously
 * during a drag, so the write is debounced rather than done per event.
 */
function trackBounds(target: BrowserWindow): void {
    const remember = (): void => {
        if (boundsTimer) clearTimeout(boundsTimer);
        boundsTimer = setTimeout(persistBounds, 400);
    };
    target.on("resize", remember);
    target.on("move", remember);
}

function persistBounds(): void {
    if (boundsTimer) {
        clearTimeout(boundsTimer);
        boundsTimer = undefined;
    }
    if (!window || window.isDestroyed()) return;
    try {
        disk.saveWindowBounds(window.getBounds());
    } catch (error) {
        console.error("[orbit] could not save window bounds:", error);
    }
}

/**
 * Restart into the freshly built code. `app.exit` is used rather than
 * `app.quit` because the before-quit handler is async and would race the
 * relaunch; the conversation has already been parked to disk by the
 * orchestrator at this point.
 */
function relaunch(): void {
    if (restarting) return;
    restarting = true;
    if (tickTimer) clearInterval(tickTimer);
    unwatchSettings?.();
    cancelDictation();
    persistBounds();
    console.log("[orbit] soft restart: relaunching");

    const done = (): void => {
        store?.dispose();
        rebuildIfDev();
        app.relaunch();
        app.exit(0);
    };
    // Give the CLI subprocesses a moment to die with us; never hang on them.
    const guard = setTimeout(done, 4000);
    void orchestrator
        ?.stop()
        .catch(() => undefined)
        .then(() => {
            clearTimeout(guard);
            done();
        });
}

/**
 * A relaunch escapes `electron-vite dev` — the new process is not a child of
 * it, and the dev server dies with the old one. The renderer therefore comes
 * from `out/`, which is only as fresh as the last build, so a self-edit to any
 * renderer file would silently not take effect. Build once on the way out.
 *
 * Only needed in development; a packaged or previewed app already runs `out/`.
 */
function rebuildIfDev(): void {
    if (!process.env.ELECTRON_RENDERER_URL) return;
    console.log("[orbit] soft restart: rebuilding renderer before relaunch");
    const result = spawnSync("npm", ["run", "build"], {
        cwd: app.getAppPath(),
        encoding: "utf8",
        timeout: 180_000,
    });
    if (result.status !== 0) {
        console.error("[orbit] rebuild failed; relaunching on the previous build");
        console.error(result.stdout?.slice(-2000) ?? "");
        console.error(result.stderr?.slice(-2000) ?? "");
    }
}

// MARK: - IPC

function registerIpc(): void {
    ipcMain.handle("orbit:getState", () => store.get());
    ipcMain.handle("orbit:send", (_event, prompt: string) => orchestrator.send(prompt));
    ipcMain.handle("orbit:abort", () => orchestrator.abort());
    ipcMain.handle(
        "orbit:answerRequest",
        (_event, requestId: string, optionId: string, freeform?: string) =>
            orchestrator.answerRequest(requestId, optionId, freeform),
    );
    ipcMain.handle("orbit:cancelAgent", (_event, agentId: string) =>
        orchestrator.cancelAgent(agentId),
    );
    ipcMain.handle("orbit:clearFinished", () => orchestrator.clearFinished());
    ipcMain.handle("orbit:poke", () => orchestrator.poke());
    ipcMain.handle("orbit:dismissBubble", () => orchestrator.dismissBubble());
    ipcMain.handle("orbit:setSettings", (_event, patch: Partial<Settings>) =>
        applySettings(patch),
    );
    ipcMain.handle("orbit:chooseWorkspace", () => chooseWorkspace());
    ipcMain.handle("orbit:setChatOpen", (_event, open: boolean) => {
        orchestrator.setChatOpen(open);
        if (open && window && !window.isDestroyed()) {
            window.focus();
        }
    });
    ipcMain.handle("orbit:moveWindow", (_event, dx: number, dy: number) => {
        if (!window || window.isDestroyed()) return;
        const bounds = window.getBounds();
        window.setBounds({
            ...bounds,
            x: Math.round(bounds.x + dx),
            y: Math.round(bounds.y + dy),
        });
        clampToScreen(window);
    });
    ipcMain.handle("orbit:resizeWindow", (_event, dx: number, dy: number) => {
        if (!window || window.isDestroyed()) return;
        resizeFromTopLeft(window, dx, dy);
    });
    ipcMain.handle("orbit:softRestart", () => orchestrator.softRestart());
    ipcMain.handle("orbit:setIgnoreMouse", (_event, ignore: boolean) => {
        if (!window || window.isDestroyed()) return;
        // `forward` keeps mousemove flowing to the renderer so it can decide
        // when the cursor is back over something interactive.
        window.setIgnoreMouseEvents(ignore, { forward: true });
    });
    ipcMain.handle("orbit:setScheduleEnabled", (_event, id: string, enabled: boolean) =>
        orchestrator.setScheduleEnabled(id, enabled),
    );
    ipcMain.handle("orbit:setScheduleArchived", (_event, id: string, archived: boolean) =>
        orchestrator.setScheduleArchived(id, archived),
    );
    ipcMain.handle("orbit:runScheduleNow", (_event, id: string) => {
        orchestrator.runSchedule(id);
    });
    ipcMain.handle("orbit:deleteSchedule", (_event, id: string) => {
        orchestrator.removeSchedule(id);
    });
    ipcMain.handle("orbit:forgetMemory", (_event, id: string) => orchestrator.forget(id));
    ipcMain.handle("orbit:resolveOpenItem", (_event, id: string) => {
        orchestrator.resolveOpenItem(id, "dismissed from Mission Control");
    });
    ipcMain.handle("orbit:openPersona", () => openPersona());
    // Only ever paths, never commands: main resolves and stats each one, and a
    // string that is not an existing absolute path simply does nothing.
    ipcMain.handle("orbit:inspectPaths", (_event, paths: unknown) =>
        Array.isArray(paths) ? inspectPaths(paths.filter((p): p is string => typeof p === "string")) : [],
    );
    ipcMain.handle("orbit:openPath", (_event, path: unknown) =>
        typeof path === "string" ? openPath(path) : { ok: false, error: "No path given." },
    );
    ipcMain.handle("orbit:revealPath", (_event, path: unknown) =>
        typeof path === "string" ? revealPath(path) : { ok: false, error: "No path given." },
    );
    // Links leave the app entirely, and only http(s) ones do; the scheme is
    // checked here as well as in the renderer.
    ipcMain.handle("orbit:openUrl", (_event, url: unknown) =>
        typeof url === "string" ? openExternalUrl(url) : { ok: false, error: "No link given." },
    );
    ipcMain.handle("orbit:dictationSupport", () => dictationSupport());
    ipcMain.handle("orbit:startDictation", () => {
        startDictation((event) => {
            if (window && !window.isDestroyed()) window.webContents.send("orbit:dictation", event);
        });
    });
    ipcMain.handle("orbit:stopDictation", () => stopDictation());
    ipcMain.handle("orbit:cancelDictation", () => cancelDictation());
    ipcMain.handle("orbit:quit", () => app.quit());
}

async function applySettings(patch: Partial<Settings>): Promise<void> {
    const previous = { ...store.get().settings };
    const next = normalizeSettings({ ...previous, ...patch });
    store.update((state) => {
        state.settings = next;
    });
    store.flush();
    saveSettings(next);
    await orchestrator.applySettings(patch, previous);
}

/** Apply settings that arrived from a hand-edit of settings.json. */
async function adoptSettings(next: Settings): Promise<void> {
    const previous = { ...store.get().settings };
    const patch: Partial<Settings> = {};
    for (const key of Object.keys(next) as Array<keyof Settings>) {
        if (next[key] !== previous[key]) Object.assign(patch, { [key]: next[key] });
    }
    if (Object.keys(patch).length === 0) return;

    store.update((state) => {
        state.settings = next;
    });
    store.flush();
    console.log("[orbit] settings reloaded from disk:", Object.keys(patch).join(", "));
    await orchestrator.applySettings(patch, previous);
}

async function chooseWorkspace(): Promise<void> {
    const result = await dialog.showOpenDialog({
        title: "Where should Orbit's agents work?",
        defaultPath: store.get().settings.workspace,
        properties: ["openDirectory", "createDirectory"],
    });
    const picked = result.filePaths[0];
    if (!result.canceled && picked && existsSync(picked)) {
        await applySettings({ workspace: picked });
    }
}

// MARK: - Tray

function createTray(): void {
    // A tiny transparent image keeps macOS happy; the title carries the face.
    tray = new Tray(nativeImage.createEmpty());
    tray.setTitle("◕‿◕");
    tray.setToolTip("Orbit");
    refreshTrayMenu();
    store.on("state", refreshTrayMenu);
}

let lastMenuSignature = "";

function refreshTrayMenu(): void {
    if (!tray) return;
    const state = store.get();
    const signature = [
        state.runtime,
        state.settings.workspace,
        state.settings.model,
        state.settings.yolo,
        state.settings.autoApproveReads,
        state.settings.meetingHeadsUp,
        state.settings.panelOpacity,
        state.settings.chatFontFamily,
        state.settings.chatFontSize,
        state.models.length,
        state.agents.filter((a) => a.status === "running" || a.status === "queued").length,
    ].join("|");
    if (signature === lastMenuSignature) return;
    lastMenuSignature = signature;

    const models = state.models.length > 0 ? state.models : [{ id: "auto", name: "Auto" }];

    const menu = Menu.buildFromTemplate([
        { label: `Orbit — ${state.runtime}`, enabled: false },
        { label: `Workspace: ${shorten(state.settings.workspace)}`, click: () => void chooseWorkspace() },
        {
            label: "Model",
            submenu: models.slice(0, 24).map((model) => ({
                label: model.name,
                type: "radio" as const,
                checked: state.settings.model === model.id,
                click: () => void applySettings({ model: model.id }),
            })),
        },
        { type: "separator" },
        {
            label: "Auto-approve read-only actions",
            type: "checkbox",
            checked: state.settings.autoApproveReads,
            click: () => void applySettings({ autoApproveReads: !state.settings.autoApproveReads }),
        },
        {
            label: "Approve everything (YOLO)",
            type: "checkbox",
            checked: state.settings.yolo,
            click: () => void applySettings({ yolo: !state.settings.yolo }),
        },
        {
            label: "Meeting heads-up (5 min before)",
            type: "checkbox",
            checked: state.settings.meetingHeadsUp,
            click: () => void applySettings({ meetingHeadsUp: !state.settings.meetingHeadsUp }),
        },
        {
            label: "Panel opacity",
            submenu: [0.6, 0.75, 0.88, 1].map((value) => ({
                label: `${Math.round(value * 100)}%`,
                type: "radio" as const,
                checked: Math.abs(state.settings.panelOpacity - value) < 0.01,
                click: () => void applySettings({ panelOpacity: value }),
            })),
        },
        {
            label: "Chat font",
            submenu: CHAT_FONTS.map((font) => ({
                label: font.label,
                type: "radio" as const,
                checked: state.settings.chatFontFamily === font.id,
                click: () => void applySettings({ chatFontFamily: font.id }),
            })),
        },
        {
            label: "Chat text size",
            submenu: CHAT_FONT_SIZES.map((size) => ({
                label: `${size}px`,
                type: "radio" as const,
                checked: state.settings.chatFontSize === size,
                click: () => void applySettings({ chatFontSize: size }),
            })),
        },
        { type: "separator" },
        { label: "Edit Orbit's personality…", click: () => void openPersona() },
        { label: "Show / hide Orbit", click: togglePanel },
        { label: "Reset size & position", click: resetPosition },
        { label: "Clear finished agents", click: () => orchestrator.clearFinished() },
        { label: "Restart (keep conversation)", click: () => orchestrator.softRestart() },
        { type: "separator" },
        { label: "Quit", click: () => app.quit() },
    ]);
    tray.setContextMenu(menu);

    const live = state.agents.filter((a) => a.status === "needs-input").length;
    tray.setTitle(live > 0 ? "◉_◉" : state.runtime === "error" ? "×_×" : "◕‿◕");
}

function togglePanel(): void {
    if (!window || window.isDestroyed()) return;
    if (window.isVisible()) window.hide();
    else window.showInactive();
}

function resetPosition(): void {
    if (!window || window.isDestroyed()) return;
    window.setBounds(defaultBounds());
    window.showInactive();
    persistBounds();
}

async function openPersona(): Promise<void> {
    const path = disk.personaPath;
    disk.loadPersona();
    await shell.openPath(path);
}

function shorten(path: string): string {
    const home = app.getPath("home");
    const short = path.startsWith(home) ? `~${path.slice(home.length)}` : path;
    return short.length > 34 ? `…${short.slice(-33)}` : short;
}

// MARK: - Snapshots (visual verification without a screen recorder)

async function runSnapshots(): Promise<void> {
    const outDir = process.env.ORBIT_SNAPSHOT_DIR ?? join(app.getPath("temp"), "orbit-shots");
    await mkdir(outDir, { recursive: true });
    const prompt = process.env.ORBIT_SNAPSHOT_PROMPT;
    const runFor = Number(process.env.ORBIT_SNAPSHOT_SECONDS ?? 90);

    const shoot = async (name: string): Promise<void> => {
        if (!window || window.isDestroyed()) return;
        const image = await window.webContents.capturePage();
        await writeFile(join(outDir, `${name}.png`), image.toPNG());
        console.log(`[snapshot] ${name} · ${JSON.stringify(summarizeState())}`);
    };

    const scene = async (name: string): Promise<void> => {
        window?.webContents.send("orbit:snapshotScene", name);
        await delay(900);
    };

    await scene("ambient");
    await shoot("01-ambient");
    await scene("chat");
    await shoot("02-chat");

    if (prompt) {
        void orchestrator.send(prompt);
        const step = Math.max(5, Math.round(runFor / 6));
        for (let index = 1; index <= 6; index += 1) {
            await delay(step * 1000);
            await shoot(`03-live-${String(index).padStart(2, "0")}`);
        }
        await scene("ambient");
        await delay(600);
        await shoot("04-ambient-busy");
    }

    for (const tab of ["agents", "watchers", "memory", "history"]) {
        await scene(`chat-deck-${tab}`);
        await shoot(`05-deck-${tab}`);
    }

    console.log(`[snapshot] written to ${outDir}`);
    app.exit(0);
}

function summarizeState(): Record<string, unknown> {
    const state = store.get();
    return {
        runtime: state.runtime,
        error: state.runtimeError,
        busy: state.orbitBusy,
        messages: state.messages.length,
        agents: state.agents.map((a) => `${a.title}:${a.status}:${a.toolCalls}`),
        requests: state.requests.map((r) => r.title),
    };
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
