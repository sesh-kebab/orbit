/**
 * Turning the file names an agent mentions into something clickable.
 *
 * The chat panel already renders absolute paths as chips, but agents habitually
 * write "File written: learning-series-plan.md" — a bare name, which resolves
 * against nothing and renders as dead text. The first half of the fix is the
 * brief (see `AGENT_PREAMBLE`); this is the second half, for every agent that
 * ignores it.
 *
 * The rule is deliberately timid: a bare name is rewritten only when a file of
 * that name actually exists in one of the directories the agent could plausibly
 * have written it to. Nothing is ever guessed, and a name that resolves nowhere
 * is left exactly as the agent wrote it.
 *
 * This runs in main, on the report text, before the renderer ever sees it. That
 * ordering matters: by the time the message reaches `splitPathSegments` the
 * rewritten name is an ordinary absolute path, so it becomes a chip through the
 * existing pass rather than a second, competing one. Runs that are already a URL
 * or already a path are skipped here for the same reason — whatever the renderer
 * would have linkified must reach it untouched.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Extensions worth resolving. Documents an agent produces for the user, not
 * source files: rewriting every `index.ts` mentioned in a code review into a
 * path would be noise at best and wrong at worst.
 */
export const ARTIFACT_EXTENSIONS = ["md", "csv", "txt", "json", "xlsx", "docx", "pdf", "png"];

/**
 * A bare file name, and nothing that is already part of something larger.
 *
 * The lookbehind rules out the tail of `/tmp/plan.md`, of `docs/plan.md`, and of
 * `~/plan.md`; the lookahead rules out `plan.md.bak` and `plan.md/x` while still
 * allowing the full stop that ends a sentence to follow.
 */
const BARE_NAME = new RegExp(
    String.raw`(?<![\w/~.-])([A-Za-z0-9][A-Za-z0-9._-]*\.(?:${ARTIFACT_EXTENSIONS.join("|")}))(?![\w/-])(?!\.[A-Za-z0-9])`,
    "g",
);

/**
 * Text the renderer will handle on its own. Kept in step with `PROTECTED_RUN`
 * in the renderer's `paths.ts` — the two describe the same runs, from opposite
 * ends of the pipe, and a name found inside one of these is already clickable.
 */
const ALREADY_LINKABLE = new RegExp(
    String.raw`https?:\/\/[^\s<>"'` + "`" + String.raw`]+|(?<![\w~/:.-])(?:~\/|\/)[^\s'"` + "`" + String.raw`<>|*?]+`,
    "g",
);

/** Where agents leave the files they make for the user, per Copilot session. */
function sessionFilesDir(sessionId: string): string {
    return join(homedir(), ".copilot", "session-state", sessionId, "files");
}

/**
 * The directories a bare name is allowed to resolve against, in the order they
 * are tried: the agent's own working directory first, then the scratch space
 * the CLI hands it. Anything else would be a guess.
 */
export function artifactSearchDirs(cwd: string | undefined, sessionId?: string): string[] {
    const dirs: string[] = [];
    if (cwd && isAbsolute(cwd)) dirs.push(cwd);
    if (sessionId) dirs.push(sessionFilesDir(sessionId));
    return dirs;
}

/** Does this name exist as a real file in one of these directories? */
function locate(name: string, dirs: string[], exists: (path: string) => boolean): string | undefined {
    for (const dir of dirs) {
        const candidate = join(dir, name);
        if (exists(candidate)) return candidate;
    }
    return undefined;
}

function isFile(path: string): boolean {
    try {
        return existsSync(path) && statSync(path).isFile();
    } catch {
        return false;
    }
}

/**
 * Rewrite the bare file names in `text` to absolute paths, where — and only
 * where — the file is really there.
 *
 * `exists` is injectable so the rule can be verified without a filesystem.
 */
export function resolveArtifactPaths(
    text: string,
    dirs: string[],
    exists: (path: string) => boolean = isFile,
): string {
    if (!text || dirs.length === 0) return text;

    // Ranges the renderer will already make clickable, so a name inside one is
    // left alone rather than linkified twice.
    const protectedRanges: Array<[number, number]> = [];
    for (const match of text.matchAll(ALREADY_LINKABLE)) {
        const start = match.index ?? 0;
        protectedRanges.push([start, start + match[0].length]);
    }
    const isProtected = (start: number): boolean =>
        protectedRanges.some(([from, to]) => start >= from && start < to);

    // Resolutions are cached per name: an agent that says "plan.md" four times
    // should cost one `stat`, and must not say four different things.
    const resolved = new Map<string, string | undefined>();

    let output = "";
    let cursor = 0;
    for (const match of text.matchAll(BARE_NAME)) {
        const start = match.index ?? 0;
        const name = match[1]!;
        if (isProtected(start)) continue;

        if (!resolved.has(name)) resolved.set(name, locate(name, dirs, exists));
        const absolute = resolved.get(name);
        if (!absolute) continue;

        output += text.slice(cursor, start) + absolute;
        cursor = start + name.length;
    }

    return cursor === 0 ? text : output + text.slice(cursor);
}

/**
 * Every absolute artifact path a report mentions, deduplicated and confirmed to
 * exist. Used to fill the activity ledger in with what an agent actually
 * produced, so run this on text that has already been through
 * `resolveArtifactPaths`.
 */
export function artifactPathsIn(text: string, exists: (path: string) => boolean = isFile): string[] {
    if (!text) return [];
    const found = new Set<string>();
    const suffix = new RegExp(String.raw`\.(?:${ARTIFACT_EXTENSIONS.join("|")})$`, "i");

    for (const match of text.matchAll(ALREADY_LINKABLE)) {
        const run = match[0];
        if (run.startsWith("http")) continue;
        // Sentence punctuation belongs to the sentence, not the file name.
        const path = run.replace(/[.,;:!?)\]}>]+$/, "");
        if (!suffix.test(path)) continue;
        const absolute = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
        if (exists(absolute)) found.add(absolute);
    }

    return [...found];
}
