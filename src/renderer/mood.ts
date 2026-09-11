import type { Mood, OrbitState } from "../shared/types.js";
import { isLive } from "../shared/types.js";

export interface MoodPalette {
    accent: string;
    tint: string;
    label: string;
    /** Animation speed multiplier. */
    tempo: number;
}

export const MOODS: Record<Mood, MoodPalette> = {
    napping: { accent: "#858FE6", tint: "#9EA8F2", label: "napping", tempo: 0.45 },
    idle: { accent: "#70D4C2", tint: "#99DBDB", label: "hanging out", tempo: 1 },
    listening: { accent: "#66B8FF", tint: "#94CCFF", label: "listening", tempo: 1.25 },
    thinking: { accent: "#AD8CFF", tint: "#C7B3FF", label: "thinking", tempo: 1.5 },
    working: { accent: "#FFB852", tint: "#FFD499", label: "on it", tempo: 2.1 },
    needsInput: { accent: "#FF7585", tint: "#FFADB8", label: "needs you", tempo: 2.4 },
    celebrating: { accent: "#FFD659", tint: "#FFE39E", label: "nailed it", tempo: 2.8 },
    broken: { accent: "#9AA0AE", tint: "#B6BBC6", label: "not connected", tempo: 0.7 },
};

const NAP_AFTER_MS = 45_000;
const CELEBRATE_MS = 3200;

export function deriveMood(state: OrbitState, typing: boolean): Mood {
    if (state.runtime === "error") return "broken";
    if (state.requests.length > 0) return "needsInput";
    if (typing) return "listening";
    if (state.orbitBusy) return "thinking";

    const live = state.agents.filter(isLive);
    if (live.length > 0) return "working";

    const lastFinish = state.agents
        .filter((a) => a.status === "done")
        .reduce((max, a) => Math.max(max, a.endedAt ?? 0), 0);
    if (lastFinish > 0 && Date.now() - lastFinish < CELEBRATE_MS) return "celebrating";

    if (Date.now() - state.lastInteractionAt > NAP_AFTER_MS) return "napping";
    return "idle";
}

export function headline(state: OrbitState): string {
    if (state.runtime === "starting") return "waking up…";
    if (state.runtime === "error") return state.runtimeError ?? "can't reach Copilot";
    const blocked = state.requests.length;
    if (blocked > 0) return `${blocked} decision${blocked === 1 ? "" : "s"} waiting on you`;
    const live = state.agents.filter(isLive).length;
    if (live > 0) return `${live} agent${live === 1 ? "" : "s"} running`;
    if (state.orbitBusy) return state.orbitActivity ?? "thinking";
    const done = state.agents.filter((a) => a.status === "done").length;
    if (done > 0) return `${done} finished · all clear`;
    return "nothing running";
}

export function agentColor(hue: number, blocked: boolean): string {
    if (blocked) return "#FF7585";
    return `hsl(${Math.round(hue * 360)} 72% 66%)`;
}

export function elapsedLabel(from: number, to = Date.now()): string {
    const seconds = Math.max(0, Math.round((to - from) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * A span at the coarsest unit that still says something, for the board's clock
 * column.
 *
 * `elapsedLabel` above is right for an agent, which lives for minutes, and it
 * never rolls over into days. Things on the board are routinely days old: a
 * decision that has waited nine days rendered as "216h 0m", which is wider than
 * the column and unreadable at a glance. One unit, no second component, and
 * direction is left to the row's tooltip, because the sign is never the question
 * when the row already says "next" or "waiting".
 */
export function shortSpan(at: number, now: number): string {
    const ms = Math.abs(now - at);
    if (ms < 60_000) return "now";
    const minutes = Math.round(ms / 60_000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.round(hours / 24);
    if (days < 14) return `${days}d`;
    return `${Math.round(days / 7)}w`;
}
