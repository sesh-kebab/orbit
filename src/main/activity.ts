/**
 * The activity ledger: one durable place recording everything Orbit has done on
 * the user's behalf.
 *
 * The ask, in his words: "a single place to keep track of all the files you
 * create for me, or maybe even at a higher level, all the actions you take on my
 * behalf" — so that "the things I ask you aren't just falling through the
 * cracks". Agents write a file, say so once, and the message scrolls away; a
 * draft gets composed and nobody remembers whether it was ever sent.
 *
 * Two things follow from that framing and shape everything here:
 *
 * 1. *An entry is never deleted on the way to being finished.* A delivered file
 *    stays delivered; the ledger is a record, not a queue.
 * 2. *Unfinished work chases the user rather than waiting to be asked about.*
 *    Anything left `awaiting_seshi` or `stalled` for three days is put back in
 *    front of Orbit through the same re-raise path open items use.
 *
 * Where this sits next to the existing stores: `history` is a short in-app feed,
 * the interaction log is an append-only transcript for the nightly job, and
 * `OpenItem` is a question waiting on an answer. None of them can say what was
 * produced and whether it landed. Open items and ledger entries do overlap at
 * `awaiting_seshi` — see the note on `ActivityEntry` — and a later change should
 * unify them. This one deliberately leaves open items alone.
 *
 * The file IO lives in this module rather than on `Persistence` so the store can
 * be verified without booting Electron; `Persistence` delegates to it and keeps
 * the same atomic-write discipline as every other store.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActivityEntry, ActivityKind, ActivityStatus } from "../shared/types.js";

export const ACTIVITY_FILE = "activity.json";

/** Ledger entries kept on disk. Old enough to be history, small enough to load. */
export const ACTIVITY_LIMIT = 1000;

/** How long unfinished work sits before it is put back in front of the user. */
export const CHASE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

/** Never chase more than this many at once. A wall of nagging gets ignored. */
export const CHASE_CAP = 3;

/** Statuses that mean the work has not landed. Everything else is closed out. */
const UNFINISHED: ActivityStatus[] = ["awaiting_seshi", "stalled"];

/** Recent entries quoted into the session context at startup. */
export const CONTEXT_RECENT = 8;

/** Hard ceiling on the whole context block, recent and unfinished together. */
export const CONTEXT_CAP = 12;

// MARK: - Persistence

/**
 * Read the ledger. A missing file is the normal state on a fresh install and
 * reads as empty; a file that exists but will not parse is damage rather than
 * absence, so it is set aside instead of being silently overwritten by the next
 * save. Same treatment every other store gets.
 */
export function readActivityLedger(dir: string): ActivityEntry[] {
    const file = join(dir, ACTIVITY_FILE);
    let raw: string;
    try {
        raw = readFileSync(file, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            console.error("[orbit] could not read the activity ledger:", error);
        }
        return [];
    }

    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isEntry);
    } catch (error) {
        console.error("[orbit] the activity ledger is corrupt and was set aside:", error);
        try {
            renameSync(file, `${file}.corrupt-${Date.now()}`);
        } catch (renameError) {
            console.error("[orbit] could not set aside the activity ledger:", renameError);
        }
        return [];
    }
}

/** Write via a temp file, so a crash mid-write cannot leave half a ledger behind. */
export function writeActivityLedger(dir: string, entries: ActivityEntry[]): void {
    const file = join(dir, ACTIVITY_FILE);
    const temp = `${file}.tmp`;
    try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(temp, JSON.stringify(entries.slice(-ACTIVITY_LIMIT), null, 2), "utf8");
        renameSync(temp, file);
    } catch (error) {
        console.error("[orbit] could not write the activity ledger:", error);
        try {
            rmSync(temp, { force: true });
        } catch {
            /* the failed write is the story; the leftover temp file is not */
        }
    }
}

/**
 * Anything without a description is not an entry, whatever else it carries —
 * a line nobody can read is worse than no line. Everything else is repaired
 * rather than dropped, so a ledger written by an older build still loads.
 */
function isEntry(value: unknown): value is ActivityEntry {
    const entry = value as Partial<ActivityEntry> | null;
    if (!entry || typeof entry.description !== "string" || !entry.description) return false;
    if (typeof entry.id !== "string") return false;
    if (typeof entry.at !== "number" || !Number.isFinite(entry.at)) return false;
    if (typeof entry.day !== "string") entry.day = localDay(entry.at);
    if (!KINDS.includes(entry.kind as ActivityKind)) entry.kind = "other";
    if (!STATUSES.includes(entry.status as ActivityStatus)) entry.status = "done";
    return true;
}

const KINDS: ActivityKind[] = [
    "artifact_written",
    "draft_composed",
    "query_run",
    "access_checked",
    "agent_dispatched",
    "external_action",
    "other",
];

const STATUSES: ActivityStatus[] = ["delivered", "awaiting_seshi", "stalled", "abandoned", "done"];

// MARK: - Building and filtering

/** Local calendar day, `YYYY-MM-DD`. Matches the convention used for schedules. */
export function localDay(at: number): string {
    const date = new Date(at);
    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0"),
    ].join("-");
}

export interface ActivityInput {
    kind: ActivityKind;
    description: string;
    location?: string;
    request?: string;
    agentId?: string;
    agentTitle?: string;
    status?: ActivityStatus;
    note?: string;
}

export function makeActivityEntry(input: ActivityInput, now = Date.now()): ActivityEntry {
    return {
        id: randomUUID(),
        at: now,
        day: localDay(now),
        kind: input.kind,
        description: input.description,
        location: input.location,
        request: input.request,
        agentId: input.agentId,
        agentTitle: input.agentTitle,
        status: input.status ?? "delivered",
        note: input.note,
    };
}

export interface ActivityFilter {
    kind?: ActivityKind;
    status?: ActivityStatus;
    /** Inclusive local day, `YYYY-MM-DD`. */
    from?: string;
    /** Inclusive local day, `YYYY-MM-DD`. */
    to?: string;
    /** Most recent first, capped here. */
    limit?: number;
}

/** Filtered, most recent first. The default cap suits a narrow panel. */
export function filterActivity(entries: ActivityEntry[], filter: ActivityFilter = {}): ActivityEntry[] {
    const limit = Math.max(1, Math.min(filter.limit ?? 12, 100));
    return entries
        .filter((entry) => !filter.kind || entry.kind === filter.kind)
        .filter((entry) => !filter.status || entry.status === filter.status)
        .filter((entry) => !filter.from || entry.day >= filter.from)
        .filter((entry) => !filter.to || entry.day <= filter.to)
        .slice()
        .sort((a, b) => b.at - a.at)
        .slice(0, limit);
}

export function isUnfinished(entry: ActivityEntry): boolean {
    return UNFINISHED.includes(entry.status);
}

/**
 * Entries overdue a chase, most stale first.
 *
 * The clock runs from the last chase rather than from creation, and each chase
 * doubles the wait — three days, then six, then twelve. Something the user has
 * decided to ignore should fade rather than turn into a daily alarm, and the
 * only way to make it stop entirely is to close it out, which is the point.
 */
export function chaseableActivity(entries: ActivityEntry[], now = Date.now()): ActivityEntry[] {
    return entries
        .filter(isUnfinished)
        .filter((entry) => {
            const since = entry.lastChasedAt ?? entry.at;
            const backoff = CHASE_AFTER_MS * 2 ** Math.min(entry.chaseCount ?? 0, 4);
            return now - since >= backoff;
        })
        .sort((a, b) => (a.lastChasedAt ?? a.at) - (b.lastChasedAt ?? b.at))
        .slice(0, CHASE_CAP);
}

// MARK: - Prose for the model

function line(entry: ActivityEntry, now: number): string {
    const where = entry.location ? ` → ${entry.location}` : "";
    const from = entry.agentTitle ? ` [agent "${entry.agentTitle}"]` : "";
    const asked = entry.request ? ` (asked: ${entry.request})` : "";
    return `- ${entry.day} ${entry.kind} · ${entry.status} · ${entry.description}${where}${asked}${from} · ${ageOf(entry.at, now)} old · id=${entry.id}`;
}

function ageOf(at: number, now: number): string {
    const days = Math.floor((now - at) / (24 * 60 * 60 * 1000));
    if (days >= 1) return `${days}d`;
    const hours = Math.max(0, Math.round((now - at) / (60 * 60 * 1000)));
    return `${hours}h`;
}

/**
 * The startup digest: the last few things done, plus anything still unfinished
 * however old it is.
 *
 * Capped hard. This is injected into every session's system message alongside
 * memories and proposals, and the whole history would crowd out the parts of
 * the prompt that make Orbit behave — "recent and unfinished" is what lets it
 * answer "what have you made for me?" without a tool call, and nothing more.
 */
export function activityContextBlock(entries: ActivityEntry[], now = Date.now()): string | undefined {
    if (entries.length === 0) return undefined;

    const byNewest = entries.slice().sort((a, b) => b.at - a.at);
    const recent = byNewest.slice(0, CONTEXT_RECENT);
    const seen = new Set(recent.map((entry) => entry.id));
    const unfinished = byNewest.filter((entry) => isUnfinished(entry) && !seen.has(entry.id));

    const chosen = [...recent, ...unfinished].slice(0, CONTEXT_CAP);
    if (chosen.length === 0) return undefined;

    const omitted = entries.length - chosen.length;
    return [
        "<activity_ledger>",
        "What you have actually done for this user, newest first, plus anything still",
        "unfinished. Use it to answer 'what have you made for me?' or 'what happened to X?'",
        "directly. Call orbit_list_activity when you need more than this, and record anything",
        "new you do for him with orbit_record_activity.",
        ...chosen.map((entry) => line(entry, now)),
        omitted > 0 ? `(${omitted} older entries not shown — orbit_list_activity has them.)` : "",
        "</activity_ledger>",
    ]
        .filter(Boolean)
        .join("\n");
}

/** The nudge sent when unfinished work has gone stale. */
export function activityChaseBlock(entries: ActivityEntry[], now = Date.now()): string {
    return [
        "<stale_activity>",
        "These are things you started for the user that have not landed. Raise the most",
        "pressing one in a single line when it is a sensible moment — not all of them, and",
        "not as a list. Then call orbit_update_activity to move it on, or to mark it",
        "abandoned if it has stopped mattering.",
        ...entries.map((entry) => line(entry, now)),
        "</stale_activity>",
    ].join("\n");
}
