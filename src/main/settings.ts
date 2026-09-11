import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Settings } from "../shared/types.js";
import { CHAT_FONTS, CHAT_FONT_BASE, CHAT_FONT_MAX, CHAT_FONT_MIN, isDeckSection } from "../shared/types.js";

const DEFAULTS: Settings = {
    workspace: homedir(),
    workspaceRepo: "",
    model: "auto",
    // Off by default: agents get shell and file-write access, so the human
    // stays in the loop unless they explicitly opt out.
    yolo: false,
    autoApproveReads: true,
    // Long enough for a coffee, short enough that an unattended agent never
    // wedges forever waiting for a human who has gone to bed.
    requestTimeoutMinutes: 10,
    // Agents get a full hour before the watchdog calls them stuck; this must
    // not be shorter than AGENT_IDLE_TIMEOUT_MS in agentRunner.ts, or a healthy
    // long-running agent is killed before its idle backstop ever fires.
    copilotPath: "",
    agentTimeoutMinutes: 60,
    panelOpacity: 0.88,
    chatFontFamily: "rounded",
    chatFontSize: CHAT_FONT_BASE,
    meetingHeadsUp: true,
    deckSection: "board",
};

function settingsPath(): string {
    return join(app.getPath("userData"), "settings.json");
}

export function loadSettings(): Settings {
    try {
        const raw = readFileSync(settingsPath(), "utf8");
        const parsed = JSON.parse(raw) as Partial<Settings>;
        return normalizeSettings({ ...DEFAULTS, ...parsed });
    } catch {
        return { ...DEFAULTS };
    }
}

/** Bring anything hand-edited or sent over IPC back inside its legal range. */
export function normalizeSettings(settings: Settings): Settings {
    const merged = { ...settings };
    if (!merged.workspace || !existsSync(merged.workspace)) {
        merged.workspace = DEFAULTS.workspace;
    }
    merged.workspaceRepo = typeof merged.workspaceRepo === "string" ? merged.workspaceRepo.trim() : "";
    merged.panelOpacity = clamp(Number(merged.panelOpacity), 0.3, 1, DEFAULTS.panelOpacity);
    merged.chatFontSize = Math.round(
        clamp(Number(merged.chatFontSize), CHAT_FONT_MIN, CHAT_FONT_MAX, DEFAULTS.chatFontSize),
    );
    if (!CHAT_FONTS.some((font) => font.id === merged.chatFontFamily)) {
        merged.chatFontFamily = DEFAULTS.chatFontFamily;
    }
    merged.meetingHeadsUp = merged.meetingHeadsUp !== false;
    if (!isDeckSection(merged.deckSection)) merged.deckSection = DEFAULTS.deckSection;
    return merged;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
}

/**
 * Watch settings.json so hand-edits apply without a restart. Writes from the
 * app itself are ignored via a short suppression window.
 */
export function watchSettings(onChange: (settings: Settings) => void): () => void {
    let timer: NodeJS.Timeout | undefined;
    let watcher: ReturnType<typeof watch> | undefined;
    try {
        watcher = watch(settingsPath(), () => {
            if (Date.now() < suppressUntil) return;
            if (timer) clearTimeout(timer);
            // Editors often write in two bursts; settle before reading.
            timer = setTimeout(() => onChange(loadSettings()), 150);
        });
    } catch {
        return () => undefined;
    }
    return () => {
        if (timer) clearTimeout(timer);
        watcher?.close();
    };
}

let suppressUntil = 0;

export function saveSettings(settings: Settings): void {
    suppressUntil = Date.now() + 500;
    try {
        const path = settingsPath();
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(settings, null, 2), "utf8");
    } catch (error) {
        console.error("[orbit] could not persist settings:", error);
    }
}
