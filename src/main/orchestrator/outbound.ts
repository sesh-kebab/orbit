/**
 * Recognising the tool calls that put words in front of other people.
 *
 * Everything else Orbit does is recoverable. A file can be rewritten, a branch
 * can be reset, a wrong answer can be corrected in the next sentence. A message
 * that has landed in somebody's chat has been read, and deleting it afterwards
 * only tells them there was something to read.
 *
 * On 16 Sep an agent was asked to post a message to Sachin and Scott. It found
 * the only small chat containing both, noticed that the chat also contained
 * Becca Camarda, posted anyway, and mentioned her in its report. Seshi's words:
 * "that is something that should never happen ideally." Nothing gated the send,
 * because `yolo` was on and `yolo` approved everything.
 *
 * So this module exists to carve outbound sends out of blanket approval. It is
 * deliberately dumb: it pattern-matches the tool arguments rather than trying to
 * understand them, it errs towards calling something outbound, and it never
 * decides anything itself. It only says "a human should look at this one".
 */
import type { PermissionRequest } from "@github/copilot-sdk";

export type OutboundSurface = "mail" | "chat" | "channel" | "invite";

export interface OutboundSend {
    surface: OutboundSurface;
    /**
     * The people this reaches, by name or address, as far as the arguments
     * reveal. Empty is not "nobody": see `audienceKnown`.
     */
    recipients: string[];
    /**
     * False when the arguments name a destination but not the people in it, as
     * a Teams chat id does. The audience is then unverifiable from the request
     * alone, which is the exact condition that caused the 16 Sep mis-send, so it
     * is stated on the card rather than passed over in silence.
     */
    audienceKnown: boolean;
    /** The chat, channel or mailbox path being posted into. */
    target: string;
    /** The opening of what is about to be sent. */
    preview?: string;
}

const SEND_PATHS: Array<{ pattern: RegExp; surface: OutboundSurface }> = [
    { pattern: /\/sendmail\b/i, surface: "mail" },
    { pattern: /\/(?:reply|replyall|forward|send)(?:\(|\?|$)/i, surface: "mail" },
    { pattern: /\/chats\/[^/]+\/messages/i, surface: "chat" },
    { pattern: /\/channels\/[^/]+\/messages/i, surface: "channel" },
    { pattern: /\/teams\/[^/]+\/.*\/messages/i, surface: "channel" },
    { pattern: /\/(?:calendar\/)?events(?:\/|\?|$)/i, surface: "invite" },
    { pattern: /\/calendars\/[^/]+\/events/i, surface: "invite" },
];

const SEND_TOOL_NAMES: Array<{ pattern: RegExp; surface: OutboundSurface }> = [
    { pattern: /send_?mail|send_?email/i, surface: "mail" },
    { pattern: /send_?message|post_?message|send_?chat/i, surface: "chat" },
];

/**
 * Decide whether a permission request is about to say something to somebody.
 *
 * Returns `undefined` for anything that isn't, which is nearly everything.
 */
export function describeOutboundSend(request: PermissionRequest): OutboundSend | undefined {
    if (request.kind !== "mcp" && request.kind !== "custom-tool") return undefined;
    // A read cannot send. Custom tools carry no such flag, so they fall through.
    if (request.kind === "mcp" && request.readOnly) return undefined;

    const args = readArgs(request);
    const target = pathArgument(args);
    const toolName = typeof request.toolName === "string" ? request.toolName : "";

    const surface =
        (target ? SEND_PATHS.find((rule) => rule.pattern.test(target))?.surface : undefined) ??
        SEND_TOOL_NAMES.find((rule) => rule.pattern.test(toolName))?.surface;
    if (!surface) return undefined;

    // Creating a draft in your own mailbox reaches nobody. Only treat a bare
    // POST to /messages as a send when the path says send, which the rules above
    // already require, so nothing extra is needed here beyond leaving drafts out
    // of SEND_PATHS entirely.
    const body = bodyArgument(args);
    const recipients = collectRecipients(surface, body, args);

    return {
        surface,
        recipients,
        // Mail and invites carry their audience in the body. A chat or channel
        // carries only an opaque thread id, so its membership is never known
        // from the request.
        audienceKnown: (surface === "mail" || surface === "invite") && recipients.length > 0,
        target: target || toolName || "unknown destination",
        preview: previewOf(body),
    };
}

/** The one-line headline for the approval card. */
export function outboundTitle(send: OutboundSend): string {
    const where = {
        mail: "send an email",
        chat: "post into a Teams chat",
        channel: "post into a Teams channel",
        invite: "send a meeting invite",
    }[send.surface];

    if (send.audienceKnown) {
        const count = send.recipients.length;
        return `wants to ${where} to ${count} ${count === 1 ? "person" : "people"}`;
    }
    return `wants to ${where}, recipients unverified`;
}

/** What the card shows under the headline: who it reaches, or that nobody knows. */
export function outboundSubject(send: OutboundSend): string {
    if (send.recipients.length > 0) return send.recipients.join(", ");
    return `${send.target} — nobody in this request says who is in it`;
}

export function outboundDetail(send: OutboundSend): string | undefined {
    const parts: string[] = [];
    if (!send.audienceKnown) {
        parts.push(
            "Check the membership before approving: an extra person in the thread is not recoverable once sent.",
        );
    }
    if (send.preview) parts.push(`“${send.preview}”`);
    return parts.length > 0 ? parts.join(" ") : undefined;
}

function readArgs(request: PermissionRequest): Record<string, unknown> {
    const args = (request as { args?: unknown }).args;
    return isRecord(args) ? args : {};
}

/** The first argument that looks like a path to somewhere. */
function pathArgument(args: Record<string, unknown>): string {
    for (const key of ["actionUrl", "parentUrl", "entityUrl", "functionUrl", "path", "url"]) {
        const value = args[key];
        if (typeof value === "string" && value.length > 0) return value;
    }
    return "";
}

/** The payload, whether it arrived as an object or as a JSON string. */
function bodyArgument(args: Record<string, unknown>): Record<string, unknown> {
    const raw = args.jsonBody ?? args.body ?? args.message ?? args;
    if (isRecord(raw)) return raw;
    if (typeof raw === "string") {
        try {
            const parsed: unknown = JSON.parse(raw);
            if (isRecord(parsed)) return parsed;
        } catch {
            // Not JSON. Nothing to read recipients out of.
        }
    }
    return {};
}

function collectRecipients(
    surface: OutboundSurface,
    body: Record<string, unknown>,
    args: Record<string, unknown>,
): string[] {
    const found: string[] = [];
    // sendMail nests everything under `message`; a reply or a draft does not.
    const scopes = [body, isRecord(body.message) ? body.message : undefined].filter(isRecord);

    for (const scope of [...scopes, args]) {
        for (const key of ["toRecipients", "ccRecipients", "bccRecipients", "attendees"]) {
            found.push(...namesFrom(scope[key]));
        }
    }
    if (surface === "mail" || surface === "invite") {
        for (const scope of scopes) found.push(...namesFrom(scope.recipients));
    }
    return [...new Set(found.filter((name) => name.length > 0))];
}

function namesFrom(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
        if (typeof entry === "string") return [entry];
        if (!isRecord(entry)) return [];
        const address = isRecord(entry.emailAddress) ? entry.emailAddress : entry;
        const name = address.name ?? address.displayName;
        const mail = address.address ?? address.emailAddress ?? address.upn;
        if (typeof name === "string" && typeof mail === "string") return [`${name} <${mail}>`];
        if (typeof name === "string") return [name];
        if (typeof mail === "string") return [mail];
        return [];
    });
}

function previewOf(body: Record<string, unknown>): string | undefined {
    const scopes = [body, isRecord(body.message) ? body.message : undefined].filter(isRecord);
    for (const scope of scopes) {
        for (const key of ["content", "text", "subject", "comment"]) {
            const direct = scope[key];
            if (typeof direct === "string" && direct.trim().length > 0) {
                return truncate(stripTags(direct.trim()), 160);
            }
            const nested = scope.body;
            if (isRecord(nested) && typeof nested[key] === "string") {
                const value = (nested[key] as string).trim();
                if (value.length > 0) return truncate(stripTags(value), 160);
            }
        }
    }
    return undefined;
}

function stripTags(value: string): string {
    return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function truncate(value: string, limit: number): string {
    return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
