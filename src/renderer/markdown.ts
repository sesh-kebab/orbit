/**
 * Markdown, as much of it as a chat panel actually needs.
 *
 * Agents write markdown whether or not anything renders it, so the choice is
 * between showing `**like this**` or showing emphasis. This is a small
 * hand-rolled parser rather than a library: the input is untrusted model output
 * that has to compose with the existing path-chip and link passes, and the
 * surface worth supporting — emphasis, code, lists, headings, quotes, tables of
 * contents that are really just lists — is far smaller than any library's.
 *
 * Two rules shape the whole design:
 *
 * 1. **Nothing becomes markup unless it is unambiguously markup.** An unclosed
 *    `**` stays two asterisks. This matters most while a message is streaming,
 *    when every emphasis span is briefly unclosed; text must not flicker
 *    between styled and literal as tokens arrive.
 * 2. **Links and paths are parsed around, never through.** A Loop URL is mostly
 *    base64 and full of underscores; letting emphasis inside it would mangle
 *    both the look and the click. Those runs are lifted out first and passed
 *    onwards whole.
 *
 * No HTML is interpreted, ever. Text stays text and only ever becomes React
 * elements chosen here.
 */

import { PROTECTED_RUN } from "./paths.js";

export type Inline =
    | { type: "text"; text: string }
    | { type: "code"; text: string }
    | { type: "link"; label: string; href: string }
    | { type: "strong"; children: Inline[] }
    | { type: "em"; children: Inline[] }
    | { type: "strike"; children: Inline[] };

export type Block =
    | { type: "paragraph"; children: Inline[] }
    | { type: "heading"; level: number; children: Inline[] }
    | { type: "quote"; blocks: Block[] }
    | { type: "list"; ordered: boolean; start: number; items: Block[][] }
    | { type: "code"; text: string; language?: string }
    | { type: "rule" };

/** Fence, heading, list marker, quote, rule — everything block-level. */
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const NUMBER = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;

/**
 * Parse a message into blocks.
 *
 * Lines are consumed with an explicit cursor rather than split and mapped,
 * because fenced code and lists both need to swallow a variable number of
 * following lines and a `for` loop over lines cannot express that cleanly.
 */
export function parseMarkdown(text: string): Block[] {
    return parseBlocks(text.replace(/\r\n?/g, "\n").split("\n"));
}

function parseBlocks(lines: string[]): Block[] {
    const blocks: Block[] = [];
    let index = 0;

    while (index < lines.length) {
        const line = lines[index] ?? "";

        if (!line.trim()) {
            index += 1;
            continue;
        }

        const fence = FENCE.exec(line);
        if (fence) {
            const marker = fence[1] ?? "```";
            const body: string[] = [];
            index += 1;
            // An unterminated fence runs to the end of the message, which is
            // what a half-streamed code block looks like.
            while (index < lines.length && !isClosingFence(lines[index] ?? "", marker)) {
                body.push(lines[index] ?? "");
                index += 1;
            }
            if (index < lines.length) index += 1;
            blocks.push({ type: "code", text: body.join("\n"), language: fence[2] || undefined });
            continue;
        }

        if (RULE.test(line)) {
            blocks.push({ type: "rule" });
            index += 1;
            continue;
        }

        const heading = HEADING.exec(line);
        if (heading) {
            blocks.push({
                type: "heading",
                level: (heading[1] ?? "#").length,
                children: parseInline(heading[2] ?? ""),
            });
            index += 1;
            continue;
        }

        if (QUOTE.test(line)) {
            const body: string[] = [];
            while (index < lines.length) {
                const quoted = QUOTE.exec(lines[index] ?? "");
                if (quoted) {
                    body.push(quoted[1] ?? "");
                    index += 1;
                    continue;
                }
                // A blank line ends the quote; plain text under it is a lazy
                // continuation and stays part of the same quote.
                if (!(lines[index] ?? "").trim()) break;
                if (isBlockStart(lines[index] ?? "")) break;
                body.push(lines[index] ?? "");
                index += 1;
            }
            blocks.push({ type: "quote", blocks: parseBlocks(body) });
            continue;
        }

        if (listMarker(line)) {
            const [list, next] = parseList(lines, index);
            blocks.push(list);
            index = next;
            continue;
        }

        const body: string[] = [];
        while (index < lines.length) {
            const current = lines[index] ?? "";
            if (!current.trim() || isBlockStart(current)) break;
            body.push(current.trim());
            index += 1;
        }
        if (body.length) blocks.push({ type: "paragraph", children: parseInline(body.join("\n")) });
    }

    return blocks;
}

function isClosingFence(line: string, marker: string): boolean {
    const trimmed = line.trim();
    return trimmed.startsWith(marker[0] ?? "`") && trimmed.replace(/\s+$/, "").length >= marker.length
        && /^(`{3,}|~{3,})$/.test(trimmed);
}

function isBlockStart(line: string): boolean {
    return (
        FENCE.test(line) ||
        HEADING.test(line) ||
        RULE.test(line) ||
        QUOTE.test(line) ||
        listMarker(line) !== undefined
    );
}

interface Marker {
    indent: number;
    ordered: boolean;
    start: number;
    content: string;
}

function listMarker(line: string): Marker | undefined {
    const bullet = BULLET.exec(line);
    if (bullet) {
        return { indent: (bullet[1] ?? "").length, ordered: false, start: 1, content: bullet[3] ?? "" };
    }
    const numbered = NUMBER.exec(line);
    if (numbered) {
        return {
            indent: (numbered[1] ?? "").length,
            ordered: true,
            start: Number(numbered[2] ?? "1"),
            content: numbered[3] ?? "",
        };
    }
    return undefined;
}

/**
 * One list, and any lists nested inside it.
 *
 * Nesting is decided purely by indentation: a marker indented further than the
 * one that opened the list belongs to the item above it, and is handed back to
 * this same function recursively. A marker indented less closes the list and
 * returns to the caller, which is what makes a nested list end without needing
 * a blank line.
 */
function parseList(lines: string[], from: number): [Block, number] {
    const opener = listMarker(lines[from] ?? "");
    const ordered = opener?.ordered ?? false;
    const indent = opener?.indent ?? 0;
    const items: Block[][] = [];
    let index = from;
    let current: string[] | undefined;

    const flush = (): void => {
        if (current) items.push(parseBlocks(current));
        current = undefined;
    };

    while (index < lines.length) {
        const line = lines[index] ?? "";

        if (!line.trim()) {
            // A blank line only ends the list if the next line leaves it.
            const next = lines[index + 1] ?? "";
            const marker = listMarker(next);
            if (!next.trim() || (!marker && !next.startsWith(" ".repeat(indent + 1)))) break;
            current?.push("");
            index += 1;
            continue;
        }

        const marker = listMarker(line);
        if (marker && marker.indent <= indent) {
            // A different marker shape at the same level starts a new list
            // rather than continuing this one.
            if (marker.ordered !== ordered && current) break;
            flush();
            current = [marker.content];
            index += 1;
            continue;
        }
        if (marker && marker.indent > indent) {
            // A deeper marker belongs to the item above. Its lines are gathered
            // and de-indented so the recursive `parseBlocks` on the item body
            // sees them as a list in their own right.
            current = current ?? [];
            while (index < lines.length) {
                const line = lines[index] ?? "";
                const deeper = listMarker(line);
                if (line.trim() && deeper && deeper.indent <= indent) break;
                if (!line.trim() && !listMarker(lines[index + 1] ?? "")) break;
                current.push(line.slice(Math.min(indent + 1, line.length - line.trimStart().length)));
                index += 1;
            }
            continue;
        }
        if (!current) break;
        // A plain continuation line belongs to the open item.
        current.push(line.trim());
        index += 1;
    }

    flush();
    return [{ type: "list", ordered, start: opener?.start ?? 1, items }, index];
}

/**
 * Inline markup within one run of text.
 *
 * Emphasis is resolved by looking ahead for a genuine closing delimiter before
 * committing to one: if there is no close, the characters are emitted as the
 * literal text the author typed. That is what keeps a streaming `**bold` from
 * flickering, and what keeps `2 * 3 * 4` as arithmetic.
 */
export function parseInline(text: string): Inline[] {
    const out: Inline[] = [];
    let plain = "";

    const push = (node: Inline): void => {
        if (plain) {
            out.push({ type: "text", text: plain });
            plain = "";
        }
        out.push(node);
    };

    // Links and paths are lifted out before anything else looks at the text.
    const protectedRuns = protectedRanges(text);
    let index = 0;

    while (index < text.length) {
        const guarded = protectedRuns.get(index);
        if (guarded !== undefined) {
            plain += text.slice(index, guarded);
            index = guarded;
            continue;
        }

        const char = text[index] ?? "";

        if (char === "\\" && index + 1 < text.length && isPunctuation(text[index + 1] ?? "")) {
            plain += text[index + 1];
            index += 2;
            continue;
        }

        if (char === "`") {
            const run = runLength(text, index, "`");
            const close = text.indexOf("`".repeat(run), index + run);
            // Only a matching run closes it, so ``a ` b`` keeps its backtick.
            if (close !== -1 && close > index + run) {
                push({ type: "code", text: text.slice(index + run, close) });
                index = close + run;
                continue;
            }
            plain += "`".repeat(run);
            index += run;
            continue;
        }

        if (char === "[") {
            const link = parseLink(text, index);
            if (link) {
                push({ type: "link", label: link.label, href: link.href });
                index = link.end;
                continue;
            }
        }

        const emphasis = parseEmphasis(text, index, protectedRuns);
        if (emphasis) {
            push(emphasis.node);
            index = emphasis.end;
            continue;
        }

        plain += char;
        index += 1;
    }

    if (plain) out.push({ type: "text", text: plain });
    return out;
}

/** Start offset → end offset for every run markdown must not parse into. */
function protectedRanges(text: string): Map<number, number> {
    const ranges = new Map<number, number>();
    for (const match of text.matchAll(PROTECTED_RUN)) {
        const start = match.index ?? 0;
        // A URL run stops at whitespace, so `**see https://x**` hands back a
        // "URL" with the closing delimiter stuck to it — and the emphasis would
        // then never find its close. Asterisks, tildes and backticks are given
        // back to the markdown; underscores are not, because a base64 path
        // really can end in one and breaking a link is the worse failure.
        let end = start + match[0].length;
        while (end > start && "*~`".includes(text[end - 1] ?? "")) end -= 1;
        if (end > start) ranges.set(start, end);
    }
    return ranges;
}

function runLength(text: string, from: number, char: string): number {
    let length = 0;
    while (text[from + length] === char) length += 1;
    return length;
}

function isPunctuation(char: string): boolean {
    return /[\\`*_{}[\]()#+\-.!~>|]/.test(char);
}

/**
 * `[label](https://…)`.
 *
 * The destination is held to exactly the rule bare links already follow — http
 * and https only — so markdown cannot become a way to smuggle in a scheme that
 * a bare URL would have been refused. Anything else falls through and the
 * brackets render as the literal text they are.
 */
function parseLink(text: string, from: number): { label: string; href: string; end: number } | undefined {
    let depth = 0;
    let close = -1;
    for (let index = from; index < text.length; index += 1) {
        const char = text[index];
        if (char === "\\") {
            index += 1;
            continue;
        }
        if (char === "[") depth += 1;
        if (char === "]") {
            depth -= 1;
            if (depth === 0) {
                close = index;
                break;
            }
        }
        if (char === "\n") break;
    }
    if (close === -1 || text[close + 1] !== "(") return undefined;

    const end = text.indexOf(")", close + 2);
    if (end === -1) return undefined;

    const href = (text.slice(close + 2, end).split(/\s+/)[0] ?? "").trim();
    if (!/^https?:\/\//i.test(href)) return undefined;
    try {
        const parsed = new URL(href);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
        if (!parsed.hostname) return undefined;
    } catch {
        return undefined;
    }

    const label = text.slice(from + 1, close);
    return { label: label || href, href, end: end + 1 };
}

const DELIMITERS = ["***", "___", "~~", "**", "__", "*", "_"] as const;

/**
 * Emphasis, if and only if this position genuinely opens some.
 *
 * `_` is held to a word-boundary rule that `*` is not, because snake_case is
 * ordinary in the things Orbit talks about — identifiers, filenames, query
 * parameters — and `some_long_name` must never come out italicised.
 */
function parseEmphasis(
    text: string,
    from: number,
    guarded: Map<number, number>,
): { node: Inline; end: number } | undefined {
    for (const delimiter of DELIMITERS) {
        if (!text.startsWith(delimiter, from)) continue;

        const underscore = delimiter.startsWith("_");
        const before = text[from - 1] ?? " ";
        if (underscore && /\w/.test(before)) continue;

        // The character after an opening delimiter has to be content, not
        // whitespace: "a * b" is multiplication, not an unclosed emphasis.
        const first = text[from + delimiter.length];
        if (first === undefined || /\s/.test(first)) continue;

        const close = findClose(text, from + delimiter.length, delimiter, guarded);
        if (close === undefined) continue;

        const inner = text.slice(from + delimiter.length, close);
        const end = close + delimiter.length;
        if (underscore && /\w/.test(text[end] ?? " ")) continue;

        if (delimiter === "***" || delimiter === "___") {
            return { node: { type: "strong", children: [{ type: "em", children: parseInline(inner) }] }, end };
        }
        if (delimiter === "~~") return { node: { type: "strike", children: parseInline(inner) }, end };
        if (delimiter.length === 2) return { node: { type: "strong", children: parseInline(inner) }, end };
        return { node: { type: "em", children: parseInline(inner) }, end };
    }
    return undefined;
}

/** The matching close, skipping code spans, protected runs and blank closes. */
function findClose(
    text: string,
    from: number,
    delimiter: string,
    guarded: Map<number, number>,
): number | undefined {
    for (let index = from; index < text.length; index += 1) {
        const skip = guarded.get(index);
        if (skip !== undefined) {
            index = skip - 1;
            continue;
        }
        const char = text[index];
        if (char === "\\") {
            index += 1;
            continue;
        }
        if (char === "`") {
            const run = runLength(text, index, "`");
            const close = text.indexOf("`".repeat(run), index + run);
            if (close !== -1) {
                index = close + run - 1;
                continue;
            }
        }
        if (!text.startsWith(delimiter, index)) continue;
        // Whitespace before a close means this is not one: "a ** b" is prose.
        if (/\s/.test(text[index - 1] ?? " ")) continue;
        // A longer run of the same character belongs to a different delimiter.
        if (delimiter !== "~~" && text[index + delimiter.length] === delimiter[0]) continue;
        if (index === from) continue;
        return index;
    }
    return undefined;
}

/** True when a message carries nothing markdown would change. */
export function isPlainText(blocks: Block[]): boolean {
    if (blocks.length !== 1) return false;
    const only = blocks[0];
    if (only?.type !== "paragraph") return false;
    return only.children.every((child) => child.type === "text");
}
