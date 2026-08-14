import type { ChatChoice } from "../../shared/types.js";

/**
 * Quick replies. Orbit ends a question with an inline marker:
 *
 *   [[choices: Ship it | Hold off | Ask me tomorrow]]
 *   [[choices: Ship it :: yes, ship it | Hold off :: not yet]]
 *
 * `label` is the button text; anything after `::` is the text sent back as the
 * user's reply. The marker is stripped before the message reaches the renderer.
 * Anything malformed is left alone — the text simply renders as written.
 */
const MARKER = /\[\[\s*choices\s*:([^\]]*)\]\]/gi;

const MAX_CHOICES = 5;
const MAX_LABEL = 48;

export interface ParsedChoices {
    /** The reply with every well-formed marker removed. */
    text: string;
    choices?: ChatChoice[];
}

export function parseChoices(raw: string): ParsedChoices {
    const choices: ChatChoice[] = [];
    let stripped = raw.replace(MARKER, (whole, body: string) => {
        const parsed = readBody(body);
        if (parsed.length === 0) return whole;
        for (const choice of parsed) {
            if (choices.length >= MAX_CHOICES) break;
            if (choices.some((existing) => existing.value === choice.value)) continue;
            choices.push(choice);
        }
        return "";
    });
    stripped = stripped.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return choices.length > 0 ? { text: stripped, choices } : { text: raw };
}

/**
 * While a reply streams in, the marker arrives a character at a time. Hide both
 * finished markers and the half-typed tail so it never flashes on screen.
 */
export function stripChoicesForStream(raw: string): string {
    const withoutComplete = raw.replace(MARKER, "");
    const open = withoutComplete.lastIndexOf("[[");
    if (open === -1) return withoutComplete;
    const tail = withoutComplete.slice(open);
    // Only swallow a tail that still looks like it is becoming a marker.
    return "[[choices:".startsWith(tail.slice(0, 10)) || /^\[\[\s*choices\s*:/i.test(tail)
        ? withoutComplete.slice(0, open).trimEnd()
        : withoutComplete;
}

function readBody(body: string): ChatChoice[] {
    const out: ChatChoice[] = [];
    for (const part of body.split("|")) {
        const [labelPart, ...valueParts] = part.split("::");
        const label = labelPart.trim().slice(0, MAX_LABEL);
        if (!label) continue;
        const value = valueParts.join("::").trim() || label;
        out.push({ label, value });
    }
    return out;
}
