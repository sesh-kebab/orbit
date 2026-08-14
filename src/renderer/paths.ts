/**
 * Finding file paths and links in prose.
 *
 * Agents write paths and URLs inline — sometimes bare, sometimes in backticks,
 * sometimes with a trailing full stop attached. The renderer needs to pick them
 * out well enough to offer a click, and cautiously enough never to swallow real
 * words. Main has the final say on paths: anything found here is only rendered
 * as a chip once main has confirmed it resolves to something that exists.
 *
 * One pass produces both kinds, so a URL and a path in the same sentence can
 * never be found twice or fight over the same characters.
 */

export interface TextSegment {
    /** Text as it should be rendered. */
    text: string;
    /** Set when this segment is a path candidate. */
    path?: string;
    /** Set when this segment is an http(s) link. */
    url?: string;
}

/**
 * Bare paths run to the first whitespace, which is the only rule that works
 * without a filesystem: "the file /tmp/a b.txt exists" is genuinely ambiguous.
 * A path with spaces is still reachable — write it in backticks or quotes,
 * which is what anything emitting such a path should be doing anyway.
 *
 * The lookbehind keeps `and/or` and `http://x` out: a bare path has to start at
 * something that is not already part of a word or a URL scheme.
 */
const BARE = String.raw`(?<![\w~/:.-])(?:~|/)[^\s'"\`<>|*?]+`;
const QUOTED = String.raw`\`([^\`\n]+)\`|"((?:~|/)[^"\n]+)"|'((?:~|/)[^'\n]+)'`;

/**
 * Only http and https are ever linkified. Everything else — `file:`,
 * `javascript:`, an app's own custom scheme — stays plain text, because a click
 * on message text must never be able to reach a handler nobody vetted, and
 * message text is ultimately model output.
 *
 * The run stops at whitespace and at the quoting characters, which is what lets
 * a long URL keep its query string, its `&` parameters and its %-encoding
 * intact; sentence punctuation is peeled off afterwards instead.
 */
const URL_RUN = String.raw`https?:\/\/[^\s<>"'\`]+`;

/** URL first, so a link is never mistaken for the start of something else. */
const CANDIDATE = new RegExp(`(${URL_RUN})|${QUOTED}|(${BARE})`, "g");

/**
 * Runs that markdown must not look inside.
 *
 * A long document link is often mostly base64, which means it is full of
 * characters markdown treats as markup — underscores especially. Italicising
 * half a URL would both look wrong and break the click. The markdown pass
 * therefore takes these runs whole and never parses within them; they reach
 * `splitPathSegments` intact and become links and chips as before.
 *
 * The path arm insists on `/` or `~/` rather than the looser rule used for
 * chips, so that `~~struck~~` is not mistaken for a home-relative path and
 * quietly protected from the markdown it actually is.
 */
export const PROTECTED_RUN = new RegExp(
    `${URL_RUN}|` + String.raw`(?<![\w~/:.-])(?:~\/|\/)[^\s'"\`<>|*?]+`,
    "g",
);

/** Punctuation that ends a sentence far more often than it ends a filename. */
const TRAILING = /[.,;:!?)\]}>]+$/;

/**
 * Split text into plain runs, path candidates and links.
 *
 * Quoted and backticked spans keep their delimiters in the rendered text — a
 * message should read the way its author wrote it — while the candidate handed
 * onwards is the unquoted inside.
 */
export function splitPathSegments(text: string): TextSegment[] {
    const segments: TextSegment[] = [];
    let cursor = 0;

    for (const match of text.matchAll(CANDIDATE)) {
        const start = match.index ?? 0;
        const whole = match[0];
        const bare = match[5] !== undefined;
        const link = match[1] !== undefined;
        const inner = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? "";
        // A backticked span may hold either kind, or neither; a bare run that
        // starts with a slash cannot be a link, so it is never offered one.
        const url = bare ? undefined : cleanUrl(inner);
        const candidate = url ? undefined : cleanCandidate(inner);
        // Not path-shaped or link-shaped after all — ordinary backticked code,
        // most often. Leaving the cursor alone lets it fall through as plain
        // text.
        if (!candidate && !url) continue;

        if (start > cursor) segments.push({ text: text.slice(cursor, start) });

        if (url) {
            // Sentence punctuation trailing a bare link belongs to the
            // sentence; inside backticks the author drew the boundary already.
            const shown = link ? url : whole;
            segments.push({ text: shown, url });
            const tail = whole.slice(shown.length);
            if (tail) segments.push({ text: tail });
        } else if (candidate && bare) {
            // A trailing full stop belongs to the sentence, not the filename,
            // so it is put back as plain text rather than made clickable.
            segments.push({ text: candidate, path: candidate });
            const tail = whole.slice(candidate.length);
            if (tail) segments.push({ text: tail });
        } else {
            segments.push({ text: whole, path: candidate });
        }
        cursor = start + whole.length;
    }

    if (cursor < text.length) segments.push({ text: text.slice(cursor) });
    return segments.filter((segment) => segment.text.length > 0);
}

/** Every distinct candidate in a message, for one batched lookup in main. */
export function pathCandidates(text: string): string[] {
    const found = splitPathSegments(text)
        .map((segment) => segment.path)
        .filter((path): path is string => path !== undefined);
    return [...new Set(found)];
}

/** Cheap rejections, so main is never asked to `stat` obvious prose. */
function cleanCandidate(raw: string): string | undefined {
    const trimmed = raw.trim().replace(TRAILING, "");
    if (trimmed.length < 3) return undefined;
    // Absolute or home-relative only. A relative path in a sentence is more
    // often prose than a file, and there is no cwd here to resolve it against.
    if (!/^(?:~|\/)/.test(trimmed)) return undefined;
    if (trimmed.startsWith("//")) return undefined;
    if (trimmed.startsWith("~") && !trimmed.startsWith("~/")) return undefined;
    return trimmed;
}

/**
 * Decide whether a run of text is a link Orbit is willing to open.
 *
 * Two jobs. First, insist on http or https via the URL parser rather than a
 * regex, so no other scheme can slip through: a `javascript:` or `file:` link
 * in model output must remain inert text. Second, hand back trailing sentence
 * punctuation — "see https://example.com." ends a sentence, it does not end a
 * hostname. Brackets are only given back when they are unbalanced, so a URL
 * that legitimately contains a closing paren keeps it.
 */
function cleanUrl(raw: string): string | undefined {
    let candidate = raw.trim();
    if (!/^https?:\/\//i.test(candidate)) return undefined;

    for (;;) {
        const last = candidate[candidate.length - 1];
        if (!last) return undefined;
        if (".,;:!?".includes(last)) {
            candidate = candidate.slice(0, -1);
            continue;
        }
        const opener = CLOSERS[last];
        if (opener && count(candidate, last) > count(candidate, opener)) {
            candidate = candidate.slice(0, -1);
            continue;
        }
        break;
    }

    try {
        const parsed = new URL(candidate);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
        if (!parsed.hostname) return undefined;
    } catch {
        return undefined;
    }
    return candidate;
}

const CLOSERS: Record<string, string | undefined> = { ")": "(", "]": "[", "}": "{" };

function count(text: string, character: string): number {
    let total = 0;
    for (const char of text) if (char === character) total += 1;
    return total;
}

/**
 * A URL short enough to read in a narrow panel. The host is the part that says
 * whether a link is worth clicking, so it is always kept; the rest is elided
 * from the middle, and the full URL stays available in the tooltip.
 */
export function urlLabel(url: string): string {
    if (url.length <= 48) return url;
    // The label may still carry the author's backticks or quotes; the shortener
    // works on the link itself and puts them back around the result.
    const match = /^(\W*)(https?:\/\/\S*?)(\W*)$/i.exec(url);
    // A markdown link's label is prose, not a URL — "the walkthrough deck" has
    // no host worth keeping and must be shown as written, however long.
    if (!match) return url;
    const [, open = "", bare = url, close = ""] = match;
    try {
        const parsed = new URL(bare);
        const rest = `${parsed.pathname}${parsed.search}${parsed.hash}`;
        const head = `${parsed.protocol}//${parsed.host}`;
        if (rest.length <= 12) return `${open}${head}${rest}${close}`;
        return `${open}${head}${rest.slice(0, 8)}…${rest.slice(-6)}${close}`;
    } catch {
        return `${url.slice(0, 40)}…`;
    }
}

/** Last path component, which is all a narrow chat panel has room for. */
export function pathLabel(path: string): string {
    const parts = path.replace(/\/+$/, "").split("/");
    return parts[parts.length - 1] || path;
}
