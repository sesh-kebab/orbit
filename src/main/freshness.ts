/**
 * Is the code that is running the code that was written?
 *
 * Orbit edits itself, and every night it ends with a green build on a branch.
 * None of that reaches the user until the output is rebuilt and the process is
 * replaced, and nothing has ever checked. The failure is silent by construction:
 * a stale build throws nothing, logs nothing, and answers questions confidently
 * with last week's behaviour.
 *
 * It has already cost real trust. On 17 August the user reported that file paths
 * had stopped rendering as links. They had not; the feature had shipped and
 * merged days earlier, and the running process predated it. He was told about a
 * regression that did not exist while the actual cause, a build from before the
 * merge, went unmentioned because nobody was looking at it.
 *
 * Two distinct ways to be behind, and they need different fixes, so they are
 * kept apart rather than collapsed into one "stale" flag:
 *
 *   needs-build    the source is newer than `out/` — a rebuild is required
 *   needs-restart  `out/` is newer than this process — a relaunch is required
 *
 * This has to be asked repeatedly, not once at launch. Asking only at startup
 * can catch a process started from an already-stale build, but never the case
 * that actually happens here: Orbit rebuilds itself at night, so the build
 * lands *underneath* a running process. Between 11 and 13 September two nights
 * of merged work sat unrun and unmentioned for exactly that reason.
 *
 * The core is pure and takes `now` as an argument. Reading mtimes is the only
 * part that touches disk, and it is deliberately separate so the rules can be
 * tested without a filesystem, a clock, or a build.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Clock skew, editors that write-then-touch, and a build that takes a moment to
 * finish all produce differences of a second or two that mean nothing. Anything
 * inside this window counts as current.
 */
export const GRACE_MS = 90_000;

/** Directories under the repo root whose mtimes count as "the source". */
const SOURCE_DIRS = ["src", "tools", "scripts"];

/** Individual files that change what gets built. */
const SOURCE_FILES = ["package.json", "electron.vite.config.ts"];

/** Build outputs to date. The entry points, not every asset. */
const BUILD_MARKERS = [
    join("main", "index.js"),
    join("preload", "index.mjs"),
    join("renderer", "index.html"),
];

/** Never walk into these; they are large and never the source of a rebuild. */
const IGNORED = new Set(["node_modules", ".git", "out", "dist", ".cache"]);

export type FreshnessState = "current" | "needs-build" | "needs-restart" | "unknown";

/** Everything the rules need, with no opinion about where it came from. */
export interface FreshnessFacts {
    /** Newest mtime among the build outputs, or undefined if never built. */
    builtAt?: number;
    /** Newest mtime across the source tree, or undefined if the source is absent. */
    newestSourceAt?: number;
    /** Which file that was, purely so the message can be specific. */
    newestSourcePath?: string;
    /** When the running process started. */
    processStartedAt: number;
}

export interface Freshness {
    state: FreshnessState;
    /** How far behind, in milliseconds. Zero when current. */
    behindMs: number;
    /** One line, written for a human. Undefined when there is nothing to say. */
    summary?: string;
    newestSourcePath?: string;
}

/**
 * Decide what, if anything, is out of date.
 *
 * Order matters. A rebuild implies a restart, so `needs-build` is reported
 * first and the restart is folded into its wording — telling someone to restart
 * onto a build that is itself stale would send them round the loop twice.
 */
export function assessFreshness(facts: FreshnessFacts, now: number): Freshness {
    // A packaged app has no source tree, and a dev server has no build worth
    // comparing. Neither is stale; both are simply not this check's business.
    if (facts.builtAt === undefined || facts.newestSourceAt === undefined) {
        return { state: "unknown", behindMs: 0 };
    }

    const sourceAhead = facts.newestSourceAt - facts.builtAt;
    if (sourceAhead > GRACE_MS) {
        return {
            state: "needs-build",
            behindMs: sourceAhead,
            newestSourcePath: facts.newestSourcePath,
            summary: `The running build is ${describeGap(sourceAhead)} older than the source${
                facts.newestSourcePath ? ` (newest change: ${facts.newestSourcePath})` : ""
            }. Rebuild and restart before trusting anything about how Orbit behaves.`,
        };
    }

    const buildAhead = facts.builtAt - facts.processStartedAt;
    if (buildAhead > GRACE_MS) {
        return {
            state: "needs-restart",
            behindMs: buildAhead,
            summary: `A build finished ${describeGap(
                now - facts.builtAt,
            )} ago, after this process started. Restart to actually run it.`,
        };
    }

    return { state: "current", behindMs: 0 };
}

/**
 * What to do about the open item that tracks a stale build.
 *
 * Split out from the orchestrator because the interesting part is a decision,
 * not a store write, and a decision can be checked without a filesystem. The
 * rule it encodes is narrow: say it once per distinct problem. Re-raising the
 * same problem would nag with a number that only grows, which is the behaviour
 * open items exist to avoid; but leaving a `needs-build` notice in place after
 * the build has happened and the real answer became `needs-restart` would send
 * the user to do the wrong thing.
 */
export type FreshnessAction =
    | { kind: "none" }
    | { kind: "raise"; text: string; source: string }
    | { kind: "replace"; text: string; source: string; reason: string }
    | { kind: "resolve"; reason: string };

/** Marks the one open item this check owns, so it can find its own note again. */
export const FRESHNESS_TAG = "[running build]";

/**
 * The state is carried on the item's `source` rather than buried in its wording,
 * because the wording contains an age that changes every time it is measured and
 * so cannot be compared against anything.
 */
export function freshnessSource(state: FreshnessState): string {
    return `freshness check: ${state}`;
}

/** The state a note was raised for, or undefined if it did not record one. */
export function stateOfFreshnessSource(source: string | undefined): FreshnessState | undefined {
    const match = /^freshness check:\s*(current|needs-build|needs-restart|unknown)$/.exec(source ?? "");
    return (match?.[1] as FreshnessState | undefined) ?? undefined;
}

export function decideFreshnessAction(
    existing: { text: string; source?: string } | undefined,
    freshness: Freshness | undefined,
): FreshnessAction {
    // No summary means nothing is wrong, or nothing is knowable. Either way the
    // note must not outlive the problem it described.
    if (!freshness?.summary) {
        return existing ? { kind: "resolve", reason: "The running build caught up." } : { kind: "none" };
    }

    const text = `${FRESHNESS_TAG} ${freshness.summary}`;
    const source = freshnessSource(freshness.state);
    if (!existing) return { kind: "raise", text, source };

    // Already asked about this exact problem. Asking again is nagging.
    const was = stateOfFreshnessSource(existing.source);
    if (was === freshness.state) return { kind: "none" };

    // A note written before the state was recorded. Trust it rather than
    // churning: re-raising every old item once on upgrade is the nagging this
    // whole path exists to prevent.
    if (was === undefined) return { kind: "none" };

    return {
        kind: "replace",
        text,
        source,
        reason: `No longer ${was}: now ${freshness.state}.`,
    };
}

/** Rough, human units. Precision here would be false: mtimes are not exact. */
export function describeGap(ms: number): string {
    // Floors to zero for sub-minute gaps, so clamp before deciding the plural.
    const minutes = Math.max(Math.round(ms / 60_000), 1);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
    return `${Math.round(hours / 24)} days`;
}

/**
 * Read the mtimes off disk.
 *
 * Every failure is swallowed into `undefined`. This runs at startup on a
 * companion that must not fail to launch because a directory it expected was
 * missing, and "I could not tell" is a perfectly good answer here.
 */
export function collectFreshnessFacts(root: string, uptimeMs: number, now: number): FreshnessFacts {
    const facts: FreshnessFacts = { processStartedAt: now - uptimeMs };

    let builtAt: number | undefined;
    for (const marker of BUILD_MARKERS) {
        const at = mtimeOf(join(root, "out", marker));
        if (at !== undefined) builtAt = builtAt === undefined ? at : Math.max(builtAt, at);
    }
    facts.builtAt = builtAt;

    let newest: { at: number; path: string } | undefined;
    const consider = (at: number | undefined, path: string): void => {
        if (at === undefined) return;
        if (!newest || at > newest.at) newest = { at, path };
    };
    for (const dir of SOURCE_DIRS) {
        const found = newestUnder(join(root, dir), dir);
        if (found) consider(found.at, found.path);
    }
    for (const file of SOURCE_FILES) consider(mtimeOf(join(root, file)), file);

    facts.newestSourceAt = newest?.at;
    facts.newestSourcePath = newest?.path;
    return facts;
}

function mtimeOf(path: string): number | undefined {
    try {
        return statSync(path).mtimeMs;
    } catch {
        return undefined;
    }
}

/** Depth-limited walk; a repo is shallow and a runaway symlink is not worth the risk. */
function newestUnder(dir: string, display: string, depth = 0): { at: number; path: string } | undefined {
    if (depth > 8) return undefined;
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return undefined;
    }

    let newest: { at: number; path: string } | undefined;
    for (const entry of entries) {
        if (entry.name.startsWith(".") || IGNORED.has(entry.name)) continue;
        const path = join(dir, entry.name);
        const shown = `${display}/${entry.name}`;
        const found = entry.isDirectory()
            ? newestUnder(path, shown, depth + 1)
            : withPath(mtimeOf(path), shown);
        if (found && (!newest || found.at > newest.at)) newest = found;
    }
    return newest;
}

function withPath(at: number | undefined, path: string): { at: number; path: string } | undefined {
    return at === undefined ? undefined : { at, path };
}
