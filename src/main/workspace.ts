import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { localDay } from "./orchestrator/schedules.js";

/**
 * Getting the day's work out of scratch space and somewhere it can be picked up
 * again.
 *
 * Everything an agent writes for the user lands in a Copilot session-state
 * folder: a UUID under `~/.copilot/session-state`, on one machine, gone from
 * view the moment the session is. That is fine while the user is sat in front
 * of that machine and useless as soon as they are not, which is the whole
 * reason this exists: work produced during the day should be waiting on
 * whatever machine they open next.
 *
 * The alternative is manual, and manual means bespoke: a hand-written "copy
 * this into the repo, commit, push" brief that works once and is forgotten the
 * next time. This module makes it a routine instead.
 *
 * Two rules shape the whole thing:
 *
 * 1. *A file is filed under its own date, never under today's.* A sync that has
 *    not run for a week must still put last Tuesday's draft in Tuesday's folder,
 *    or catching up would flatten a week of work into one misleading pile.
 * 2. *Never destroy what is already there.* Copies only ever go forward into an
 *    empty name; a same-named file from a different session gets a suffix rather
 *    than overwriting, and git is only ever asked to add, commit and push — no
 *    reset, no checkout, no force, no branch changes.
 *
 * Git is invoked through `execFile` with an argument array, never a shell
 * string, so a filename with a space or a quote in it is an argument and cannot
 * become a command.
 */

/** Where agents leave the files they make for the user. */
const SESSION_STATE_DIR = join(homedir(), ".copilot", "session-state");

/** Used when nothing has been configured. Nothing is created here on its own. */
export const DEFAULT_WORKSPACE_REPO = join(homedir(), "git", "workspace");

/**
 * The git repository synced work is copied into.
 *
 * Configurable two ways, most specific first: the `ORBIT_WORKSPACE_REPO`
 * environment variable, and the `workspaceRepo` key in `settings.json`, passed
 * in here as `configured`. The environment variable wins so a test run can be
 * pointed at a scratch clone without editing, or later restoring, the user's
 * real configuration. With neither set the default below applies, and a sync is
 * simply skipped when no repository is found there.
 */
export function workspaceRepoPath(configured?: string): string {
    const fromEnv = process.env.ORBIT_WORKSPACE_REPO?.trim();
    if (fromEnv) return fromEnv;
    const fromSettings = configured?.trim();
    if (fromSettings) return fromSettings;
    return DEFAULT_WORKSPACE_REPO;
}

/**
 * Big enough for a deck, small enough that nobody accidentally commits a video
 * to a git repo they sync over a phone tether. Anything larger is reported as
 * skipped rather than dropped silently.
 */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** How deep to walk inside a session's `files` directory. */
const MAX_DEPTH = 3;

/** A ceiling on one pass, so a runaway agent cannot make a 500-file commit. */
const MAX_FILES_PER_SYNC = 200;

/** Seconds before a git call is assumed wedged. Push gets longer; it is network. */
const GIT_TIMEOUT_MS = 20_000;
const PUSH_TIMEOUT_MS = 90_000;

/**
 * Scratch output nobody wants a permanent record of: the clipboard dumps the
 * CLI writes when a large paste arrives, named by epoch millisecond.
 */
const MACHINE_JUNK = /^paste-\d{10,}\.[a-z0-9]+$/i;

/** One candidate file, already resolved to where it would land. */
export interface WorkspaceCandidate {
    /** Absolute path in session-state. */
    source: string;
    /** Local YYYY-MM-DD taken from the file's own mtime. */
    day: string;
    /** Session UUID it came from, used to break name collisions. */
    sessionId: string;
    /** File name as it will appear in the repo, collisions already resolved. */
    name: string;
    bytes: number;
    modifiedAt: number;
}

export interface WorkspaceSyncReport {
    /** `synced` means something was committed; `clean` means there was nothing to do. */
    status: "synced" | "clean" | "skipped" | "failed";
    repo: string;
    /** Repo-relative paths added by this pass. */
    added: string[];
    /** Files deliberately left behind, each with a reason. */
    skipped: Array<{ file: string; reason: string }>;
    commit?: string;
    pushed: boolean;
    /** Set when the pass could not complete, or when only the push failed. */
    error?: string;
}

/**
 * Every file an agent has left for the user, newest first.
 *
 * Deliberately tolerant: a session folder that disappears mid-walk, or one with
 * no `files` directory at all, is not an error — it is the normal state of most
 * sessions. Nothing here throws.
 */
export function collectSessionFiles(
    root: string = SESSION_STATE_DIR,
    now: number = Date.now(),
): WorkspaceCandidate[] {
    const found: WorkspaceCandidate[] = [];
    if (!existsSync(root)) return found;

    for (const session of safeReaddir(root)) {
        const filesDir = join(root, session, "files");
        if (!existsSync(filesDir)) continue;
        walk(filesDir, 0, (absolute, stats) => {
            found.push({
                source: absolute,
                // A clock skewed into the future would file work under a day
                // that has not happened; clamp rather than invent a folder.
                day: localDay(Math.min(stats.mtimeMs, now)),
                sessionId: session,
                name: basename(absolute),
                bytes: stats.size,
                modifiedAt: stats.mtimeMs,
            });
        });
    }

    return found.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

function walk(dir: string, depth: number, visit: (path: string, stats: Stats) => void): void {
    if (depth > MAX_DEPTH) return;
    for (const entry of safeReaddir(dir)) {
        // Dotfiles are tooling, not work product.
        if (entry.startsWith(".")) continue;
        const absolute = join(dir, entry);
        let stats: Stats;
        try {
            stats = statSync(absolute);
        } catch {
            continue;
        }
        if (stats.isDirectory()) {
            walk(absolute, depth + 1, visit);
        } else if (stats.isFile()) {
            visit(absolute, stats);
        }
    }
}

function safeReaddir(dir: string): string[] {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

/**
 * Decide what actually moves, and under what name.
 *
 * Anything already in the repo byte-for-byte is not "skipped" in the sense
 * worth reporting — it is simply done, and reporting it every night would bury
 * the one line that matters. Only files held back for a reason the user might
 * disagree with (too big, machine junk) are surfaced.
 */
export function planSync(
    candidates: WorkspaceCandidate[],
    repo: string,
): { copy: WorkspaceCandidate[]; skipped: Array<{ file: string; reason: string }> } {
    const copy: WorkspaceCandidate[] = [];
    const skipped: Array<{ file: string; reason: string }> = [];
    // Names claimed during *this* pass, so two sessions that both wrote
    // "notes.md" today do not race for the same destination.
    const claimed = new Set<string>();

    for (const candidate of candidates) {
        if (copy.length >= MAX_FILES_PER_SYNC) {
            skipped.push({ file: candidate.source, reason: "over the per-sync file limit" });
            continue;
        }
        if (MACHINE_JUNK.test(candidate.name)) continue;
        if (candidate.bytes > MAX_FILE_BYTES) {
            skipped.push({ file: candidate.source, reason: `${Math.round(candidate.bytes / 1024 / 1024)} MB, over the size cap` });
            continue;
        }

        const dayDir = join(repo, "sessions", candidate.day);
        const name = uniqueName(candidate, dayDir, claimed);
        // Already there, unchanged: nothing to do and nothing to say.
        if (name === undefined) continue;

        claimed.add(join(dayDir, name));
        copy.push({ ...candidate, name });
    }

    return { copy, skipped };
}

/**
 * The name this file should take in its day folder, or undefined if an
 * identical copy is already sitting there.
 *
 * A same-named file whose *content* differs is a genuinely different document
 * that happens to share a name — two sessions both producing "summary.md" is
 * routine — so it takes a suffix from its session id rather than overwriting
 * the earlier one. Losing yesterday's draft to today's is the one outcome this
 * whole module exists to avoid.
 */
function uniqueName(candidate: WorkspaceCandidate, dayDir: string, claimed: Set<string>): string | undefined {
    const attempt = (name: string): "free" | "identical" | "taken" => {
        const target = join(dayDir, name);
        if (claimed.has(target)) return "taken";
        if (!existsSync(target)) return "free";
        return sameContent(candidate.source, target) ? "identical" : "taken";
    };

    const first = attempt(candidate.name);
    if (first === "free") return candidate.name;
    if (first === "identical") return undefined;

    const dot = candidate.name.lastIndexOf(".");
    const stem = dot > 0 ? candidate.name.slice(0, dot) : candidate.name;
    const ext = dot > 0 ? candidate.name.slice(dot) : "";
    const tag = candidate.sessionId.slice(0, 6);

    for (const suffixed of [`${stem}-${tag}${ext}`, ...Array.from({ length: 20 }, (_, i) => `${stem}-${tag}-${i + 2}${ext}`)]) {
        const result = attempt(suffixed);
        if (result === "free") return suffixed;
        if (result === "identical") return undefined;
    }
    return undefined;
}

function sameContent(a: string, b: string): boolean {
    try {
        const left = statSync(a);
        const right = statSync(b);
        if (left.size !== right.size) return false;
        return readFileSync(a).equals(readFileSync(b));
    } catch {
        return false;
    }
}

/**
 * Copy the day's work into the repo, commit it, and push if there is a remote.
 *
 * A failed push is not a failed sync: the files are on disk and committed, which
 * is most of the value, so the report says `synced` with the push error attached
 * rather than pretending nothing happened.
 */
export async function syncWorkspace(
    options: { repo?: string; now?: number; push?: boolean } = {},
): Promise<WorkspaceSyncReport> {
    const repo = options.repo ?? workspaceRepoPath();
    const now = options.now ?? Date.now();
    const report: WorkspaceSyncReport = { status: "clean", repo, added: [], skipped: [], pushed: false };

    if (!existsSync(join(repo, ".git"))) {
        return { ...report, status: "skipped", error: `no git repository at ${repo}` };
    }

    const { copy, skipped } = planSync(collectSessionFiles(SESSION_STATE_DIR, now), repo);
    report.skipped = skipped;
    if (copy.length === 0) return report;

    const relatives: string[] = [];
    for (const candidate of copy) {
        const dayDir = join(repo, "sessions", candidate.day);
        try {
            mkdirSync(dayDir, { recursive: true });
            copyFileSync(candidate.source, join(dayDir, candidate.name));
            relatives.push(`sessions/${candidate.day}/${candidate.name}`);
        } catch (error) {
            report.skipped.push({ file: candidate.source, reason: message(error) });
        }
    }
    if (relatives.length === 0) return report;

    try {
        // `--` guards against a file named like a flag.
        await git(repo, ["add", "--", ...relatives], GIT_TIMEOUT_MS);
        // A file can be byte-identical to something git already tracks under
        // the same path, in which case there is nothing staged and `commit`
        // would fail. Ask git rather than guess.
        const staged = await git(repo, ["diff", "--cached", "--name-only"], GIT_TIMEOUT_MS);
        if (!staged.trim()) return report;

        await git(repo, ["commit", "-m", commitMessage(copy, now)], GIT_TIMEOUT_MS);
        report.commit = (await git(repo, ["rev-parse", "HEAD"], GIT_TIMEOUT_MS)).trim();
        report.added = relatives;
        report.status = "synced";
    } catch (error) {
        return { ...report, status: "failed", error: message(error) };
    }

    if (options.push === false) return report;

    try {
        const remotes = await git(repo, ["remote"], GIT_TIMEOUT_MS);
        if (!remotes.trim()) return report;
        await git(repo, ["push"], PUSH_TIMEOUT_MS);
        report.pushed = true;
    } catch (error) {
        // Committed but not pushed: worth saying, not worth calling a failure.
        report.error = `committed locally, push failed: ${message(error)}`;
    }

    return report;
}

/** A commit message that reads as a log entry a month later. */
function commitMessage(copied: WorkspaceCandidate[], now: number): string {
    const days = Array.from(new Set(copied.map((c) => c.day))).sort();
    const span = days.length === 1 ? days[0] : `${days[0]}..${days[days.length - 1]}`;
    const count = `${copied.length} file${copied.length === 1 ? "" : "s"}`;
    const names = copied
        .slice(0, 20)
        .map((c) => `- sessions/${c.day}/${c.name}`)
        .join("\n");
    const more = copied.length > 20 ? `\n- …and ${copied.length - 20} more` : "";
    return `Sync ${count} from ${span}\n\nCopied out of session scratch space so they survive the session.\n\n${names}${more}\n\nSynced ${new Date(now).toISOString()}`;
}

function git(repo: string, args: string[], timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            "git",
            ["-C", repo, ...args],
            { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
            (error, stdout, stderr) => {
                if (error) {
                    const detail = (stderr || stdout || "").trim().split("\n").slice(-3).join("; ");
                    reject(new Error(detail || error.message));
                    return;
                }
                resolve(stdout);
            },
        );
    });
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * One line for the chat panel. The panel is narrow and this runs unattended, so
 * a quiet night should read as one short sentence, not a manifest.
 */
export function describeSync(report: WorkspaceSyncReport): string {
    if (report.status === "skipped") return `Workspace sync skipped: ${report.error}.`;
    if (report.status === "failed") return `Workspace sync failed: ${report.error}.`;
    if (report.status === "clean") return "Workspace already up to date.";

    const count = report.added.length;
    const days = Array.from(new Set(report.added.map((path) => path.split("/")[1]))).sort();
    const where = days.length === 1 ? days[0] : `${days.length} days`;
    const pushed = report.pushed ? "pushed" : report.error ? "committed locally only" : "committed";
    return `Synced ${count} file${count === 1 ? "" : "s"} from ${where} to the working repo, ${pushed}.`;
}

/**
 * Should the automatic pass run now?
 *
 * Once per local day, and not before the hour a working day tends to wind down.
 * The point is to have the day's output waiting when the user opens a laptop
 * somewhere else, not to commit a draft every time an agent touches it. If the
 * app was closed at that hour the answer stays true for the rest of the day, so
 * a machine that sleeps through the evening still catches up next time it is
 * awake.
 */
export function shouldAutoSync(lastSyncedDay: string | undefined, now: number, afterHour = 17): boolean {
    const today = localDay(now);
    if (lastSyncedDay === today) return false;
    return new Date(now).getHours() >= afterHour;
}
