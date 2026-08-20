import { app } from "electron";
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
    ChatMessage,
    HistoryEntry,
    LeavePeriod,
    MemoryNote,
    OpenItem,
    Proposal,
    Schedule,
    UsageTotals,
    WindowBounds,
} from "../shared/types.js";

const HISTORY_LIMIT = 400;

/** How much of the transcript survives a soft restart. */
const SESSION_MESSAGE_LIMIT = 60;

/**
 * What a soft restart carries across the process boundary. Written just before
 * the relaunch and consumed exactly once on the way back up.
 */
export interface SessionSnapshot {
    at: number;
    messages: ChatMessage[];
    usage: UsageTotals;
    lastInteractionAt: number;
    /** Agents that were still live when the restart happened. */
    interrupted: Array<{ title: string; task: string; cwd: string }>;
}

/**
 * The logs that live outside userData. Exported because the rename migration
 * has to move this directory, and the two must not drift apart.
 */
export const ORBIT_HOME_DIR = join(homedir(), ".copilot", "orbit");

/**
 * Where the interaction log lives. Deliberately outside userData: a nightly
 * self-improvement job reads these files and should not have to know where
 * Electron happens to put its application support directory.
 */
const INTERACTION_LOG_DIR = join(ORBIT_HOME_DIR, "interaction-log");

/**
 * Where the nightly self-reflection appends its write-up. Same reasoning as the
 * interaction log: it is written by a scheduled job outside the app, so it lives
 * somewhere a shell script can find without asking Electron.
 */
const EVOLUTION_LOG_PATH = join(ORBIT_HOME_DIR, "evolution-log.md");

/** Never read more of the log than a digest could possibly use. */
const EVOLUTION_LOG_READ_CAP = 200_000;

/** One tool or agent Orbit reached for during a turn, and how it went. */
export interface LoggedToolCall {
    name: string;
    outcome: "success" | "failure" | "timeout" | "unknown";
    detail?: string;
}

/**
 * A single append-only line of the interaction log. Flat and boring on purpose
 * — whatever analyses this later should not need the app to parse it.
 */
export interface InteractionRecord {
    /** ISO 8601, local-day bucketed into the file name. */
    at: string;
    sessionId: string;
    kind: "turn" | "agent";
    role: "user" | "orbit";
    text: string;
    /** Present on Orbit turns that called tools. */
    tools?: LoggedToolCall[];
    /** Present when kind is "agent". */
    agent?: {
        id: string;
        title: string;
        event: "spawned" | "completed" | "failed" | "timed-out" | "cancelled";
    };
}

/**
 * Everything Orbit remembers between launches lives here as plain files, so a
 * curious human can read or edit any of it without the app running.
 */
export class Persistence {
    private readonly dir: string;

    constructor() {
        this.dir = app.getPath("userData");
        mkdirSync(this.dir, { recursive: true });
    }

    get personaPath(): string {
        return join(this.dir, "persona.md");
    }

    private path(name: string): string {
        return join(this.dir, name);
    }

    /**
     * The data directory is made in the constructor, but a store that is only
     * written months into a run cannot assume it survived — a synced or cleaned
     * home directory takes it away underneath a live process, and the write
     * that discovers this is the one that loses the data.
     */
    private ensureDir(): void {
        mkdirSync(this.dir, { recursive: true });
    }

    private readJson<T>(name: string, fallback: T): T {
        const file = this.path(name);
        let raw: string;
        try {
            raw = readFileSync(file, "utf8");
        } catch (error) {
            // Missing is the normal state on a fresh install and reads as empty.
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                console.error(`[orbit] could not read ${name}:`, error);
            }
            return fallback;
        }

        try {
            return JSON.parse(raw) as T;
        } catch (error) {
            // A file that exists but will not parse is damage, not absence. The
            // next write would overwrite it silently, so keep a copy and say so.
            console.error(`[orbit] ${name} is corrupt and was set aside:`, error);
            try {
                renameSync(file, `${file}.corrupt-${Date.now()}`);
            } catch (renameError) {
                console.error(`[orbit] could not set aside ${name}:`, renameError);
            }
            return fallback;
        }
    }

    /**
     * Write via a temporary file so a crash mid-write cannot leave half a store
     * behind, and never fail quietly: a store that silently stops persisting
     * looks exactly like a store nothing was ever added to.
     */
    private writeJson(name: string, value: unknown): void {
        const file = this.path(name);
        const temp = `${file}.tmp`;
        try {
            this.ensureDir();
            writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
            renameSync(temp, file);
        } catch (error) {
            console.error(`[orbit] could not write ${name}:`, error);
            try {
                rmSync(temp, { force: true });
            } catch {
                /* the failed write is the story; the leftover temp file is not */
            }
        }
    }

    // MARK: - Schedules

    loadSchedules(): Schedule[] {
        return this.readJson<Schedule[]>("schedules.json", []).map(normaliseSchedule);
    }

    saveSchedules(schedules: Schedule[]): void {
        this.writeJson("schedules.json", schedules);
    }

    // MARK: - Leave

    /**
     * Stretches the user is away. Held apart from schedules on purpose: the
     * dates are a fact about the user, not about any one watcher, and every
     * watcher that used to carry its own copy in its prompt disagreed with the
     * others the moment one was edited.
     */
    loadLeave(): LeavePeriod[] {
        const periods = this.readJson<LeavePeriod[]>("leave.json", []);
        if (!Array.isArray(periods)) return [];
        return periods.filter(
            (period) =>
                period && typeof period.from === "string" && typeof period.to === "string",
        );
    }

    saveLeave(leave: LeavePeriod[]): void {
        this.writeJson("leave.json", leave);
    }

    // MARK: - Memories

    loadMemories(): MemoryNote[] {
        return this.readJson<MemoryNote[]>("memories.json", []);
    }

    saveMemories(memories: MemoryNote[]): void {
        this.writeJson("memories.json", memories);
    }

    // MARK: - Open items

    /**
     * Decisions the user has not answered yet. Separate from memories: a memory
     * is settled knowledge, an open item is an unpaid debt.
     */
    loadOpenItems(): OpenItem[] {
        const items = this.readJson<OpenItem[]>("open-items.json", []);
        return Array.isArray(items) ? items.filter((item) => item && typeof item.text === "string") : [];
    }

    saveOpenItems(items: OpenItem[]): void {
        this.writeJson("open-items.json", items);
    }

    // MARK: - Proposals

    /**
     * Orbit's own self-improvement backlog. Separate from open items: an open
     * item is a question for the user and disappears once answered, a proposal
     * is a change to Orbit that keeps its state after the answer — approved,
     * shipped, declined — so the next reflection knows what has already been
     * tried instead of proposing it again.
     */
    loadProposals(): Proposal[] {
        const proposals = this.readJson<Proposal[]>("proposals.json", []);
        if (!Array.isArray(proposals)) return [];
        // Seed the file on first read. Until something is proposed there is
        // nothing to write, which left the store invisible on disk — and an
        // absent file is indistinguishable from one that quietly failed to
        // save, which is how a proposal history gets lost without anyone
        // noticing.
        if (!existsSync(this.path("proposals.json"))) this.saveProposals([]);
        return proposals.filter((entry) => entry && typeof entry.text === "string");
    }

    saveProposals(proposals: Proposal[]): void {
        this.writeJson("proposals.json", proposals);
    }

    // MARK: - Window bounds

    /**
     * Where the panel was and how big it was. Position already survived via the
     * drag handler's clamping; size needs the same treatment now that the panel
     * can be resized.
     */
    loadWindowBounds(): WindowBounds | undefined {
        const saved = this.readJson<Partial<WindowBounds> | undefined>("window.json", undefined);
        if (!saved) return undefined;
        const { x, y, width, height } = saved;
        if (![x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n))) {
            return undefined;
        }
        return { x: x!, y: y!, width: width!, height: height! };
    }

    saveWindowBounds(bounds: WindowBounds): void {
        this.writeJson("window.json", bounds);
    }

    // MARK: - Soft restart

    /**
     * Orbit restarts itself to pick up its own code changes. Main-process edits
     * need a real relaunch, so the conversation is parked on disk rather than
     * thrown away — the whole point is that a self-improvement lands without
     * losing the context that motivated it.
     */
    saveSessionSnapshot(snapshot: SessionSnapshot): void {
        this.writeJson("session.json", {
            ...snapshot,
            messages: snapshot.messages.slice(-SESSION_MESSAGE_LIMIT),
        });
    }

    /** Read-and-delete: a snapshot is only ever restored once. */
    takeSessionSnapshot(): SessionSnapshot | undefined {
        const snapshot = this.readJson<SessionSnapshot | undefined>("session.json", undefined);
        try {
            rmSync(this.path("session.json"), { force: true });
        } catch {
            /* a stale snapshot is better than a crash */
        }
        if (!snapshot || !Array.isArray(snapshot.messages)) return undefined;
        return snapshot;
    }

    // MARK: - Persona

    /**
     * A user-editable slab of prompt appended to Orbit's identity. Seeded once
     * so there's something concrete to edit rather than an empty file.
     */
    loadPersona(): string {
        if (!existsSync(this.personaPath)) {
            writeFileSync(this.personaPath, DEFAULT_PERSONA, "utf8");
        }
        try {
            return readFileSync(this.personaPath, "utf8").trim();
        } catch {
            return "";
        }
    }

    // MARK: - History

    loadHistory(): HistoryEntry[] {
        try {
            const lines = readFileSync(this.path("history.jsonl"), "utf8")
                .split("\n")
                .filter(Boolean);
            return lines
                .slice(-HISTORY_LIMIT)
                .map((line) => JSON.parse(line) as HistoryEntry)
                .filter((entry) => typeof entry?.at === "number");
        } catch {
            return [];
        }
    }

    appendHistory(entry: HistoryEntry): void {
        try {
            appendFileSync(this.path("history.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
        } catch (error) {
            console.error("[orbit] could not append history:", error);
        }
    }

    // MARK: - Interaction log

    get interactionLogDir(): string {
        return INTERACTION_LOG_DIR;
    }

    /** One file per local day, so a nightly job can just read yesterday's. */
    private interactionLogPath(when: Date): string {
        const day = [
            when.getFullYear(),
            String(when.getMonth() + 1).padStart(2, "0"),
            String(when.getDate()).padStart(2, "0"),
        ].join("-");
        return join(INTERACTION_LOG_DIR, `${day}.jsonl`);
    }

    /**
     * Never throws. A log that fails to write is a shame; a chat turn that
     * dies because of it is a bug, so every failure stops here as a warning.
     */
    appendInteraction(record: InteractionRecord): void {
        try {
            mkdirSync(INTERACTION_LOG_DIR, { recursive: true });
            appendFileSync(
                this.interactionLogPath(new Date(record.at)),
                `${JSON.stringify(record)}\n`,
                "utf8",
            );
        } catch (error) {
            console.warn("[orbit] could not append interaction log:", error);
        }
    }

    // MARK: - Evolution log

    get evolutionLogPath(): string {
        return EVOLUTION_LOG_PATH;
    }

    /**
     * The nightly reflection's own write-up, raw. Missing is the normal state on
     * a fresh install and reads as empty — startup must never depend on a file
     * some other process is responsible for creating.
     */
    loadEvolutionLog(): string {
        try {
            const text = readFileSync(EVOLUTION_LOG_PATH, "utf8");
            return text.length > EVOLUTION_LOG_READ_CAP ? text.slice(-EVOLUTION_LOG_READ_CAP) : text;
        } catch {
            return "";
        }
    }
}

/**
 * Bring a record written by an older build up to today's shape.
 *
 * Nothing is dropped: records predating archiving simply have no `archived`
 * field and read as live. The one repair is the sentinel a fired one-off used
 * to be left with, which rendered as an "Invalid Date" next run — a one-off
 * that has already gone off is archived, which is what it always meant.
 */
function normaliseSchedule(schedule: Schedule): Schedule {
    const fired = schedule.cadence.kind === "once" && schedule.runCount > 0;
    const archived = schedule.archived ?? fired;
    return {
        ...schedule,
        archived,
        archivedAt: archived ? (schedule.archivedAt ?? schedule.lastRunAt ?? schedule.createdAt) : undefined,
        enabled: archived ? false : schedule.enabled,
        nextRunAt:
            fired && !Number.isFinite(new Date(schedule.nextRunAt).getTime())
                ? (schedule.lastRunAt ?? schedule.createdAt)
                : schedule.nextRunAt,
    };
}

export const DEFAULT_PERSONA = `# Orbit's personality

Edit this file to shape how Orbit behaves. It is appended to Orbit's system
prompt every time a session starts, so changes take effect on the next restart
(or when you change the model or workspace).

## Tone
- Dry, quick, a little smug. One joke per message, maximum.
- Short replies. This chat panel is narrow.

## Standing instructions
- (add your own, e.g. "always tell me the file paths you changed")

## Things to never do
- (add your own, e.g. "never push to main")
`;
