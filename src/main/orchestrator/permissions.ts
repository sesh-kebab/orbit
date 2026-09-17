import type { PermissionRequest, PermissionRequestResult } from "@github/copilot-sdk";

type ApproveForSession = Extract<PermissionRequestResult, { kind: "approve-for-session" }>;
type SessionApproval = NonNullable<ApproveForSession["approval"]>;
import type { PendingRequest, Settings } from "../../shared/types.js";
import {
    describeOutboundSend,
    outboundDetail,
    outboundSubject,
    outboundTitle,
} from "./outbound.js";

export interface PermissionDescription {
    title: string;
    subject?: string;
    detail?: string;
    canOfferSessionApproval: boolean;
    /** Set when this puts words in front of someone who is not Seshi. */
    outbound?: boolean;
}

/** Turn a raw SDK permission request into something a human can judge at a glance. */
export function describePermission(request: PermissionRequest): PermissionDescription {
    // Checked ahead of the kind switch: a send is a send whether it arrives as
    // an MCP call or a custom tool, and the audience matters more than the
    // plumbing it came down.
    const send = describeOutboundSend(request);
    if (send) {
        return {
            title: outboundTitle(send),
            subject: outboundSubject(send),
            detail: outboundDetail(send),
            // Never offer "for the session": approving this audience must not
            // silently approve the next one.
            canOfferSessionApproval: false,
            outbound: true,
        };
    }

    switch (request.kind) {
        case "shell": {
            // `identifier` is often the whole command line, which would just
            // repeat the subject — only show it when it's a short exe name.
            const names = [
                ...new Set(
                    (request.commands ?? [])
                        .map((c) => c.identifier)
                        .filter((id) => id.length <= 24 && !id.includes(" ")),
                ),
            ];
            return {
                title: "wants to run a command",
                subject: request.fullCommandText,
                detail: names.length > 0 ? `uses: ${names.join(", ")}` : undefined,
                canOfferSessionApproval: request.canOfferSessionApproval ?? false,
            };
        }
        case "write":
            return {
                title: "wants to edit a file",
                subject: request.fileName,
                detail: truncate(request.intention ?? "", 220),
                canOfferSessionApproval: request.canOfferSessionApproval ?? false,
            };
        case "read":
            return {
                title: "wants to read a file",
                subject: request.path,
                detail: truncate(request.intention ?? "", 220),
                canOfferSessionApproval: false,
            };
        case "url":
            return {
                title: "wants to fetch a URL",
                subject: request.url,
                detail: truncate(request.intention ?? "", 220),
                canOfferSessionApproval: false,
            };
        case "mcp":
            return {
                title: `wants to use ${request.serverName ?? "an MCP server"}`,
                subject: request.toolName,
                detail: request.readOnly ? "read-only tool" : undefined,
                canOfferSessionApproval: true,
            };
        case "custom-tool":
            return {
                title: "wants to use a custom tool",
                subject: request.toolName,
                canOfferSessionApproval: true,
            };
        case "memory":
            return {
                title: `wants to ${request.action ?? "update"} a memory`,
                subject: truncate(request.fact ?? "", 160),
                canOfferSessionApproval: false,
            };
        default:
            return {
                title: `wants permission (${(request as { kind?: string }).kind ?? "unknown"})`,
                canOfferSessionApproval: false,
            };
    }
}

/**
 * Decide automatically where it's clearly safe, otherwise hand it to the human.
 * Returning `undefined` means "ask".
 */
export function autoDecide(
    request: PermissionRequest,
    settings: Settings,
): PermissionRequestResult | undefined {
    // Ahead of `yolo`, deliberately. "Approve everything" is a statement about
    // Orbit's own risk appetite with Seshi's files and shell; it was never a
    // mandate to speak to his colleagues unsupervised. On 16 Sep it was read as
    // one, and a message went into a chat with an extra person in it.
    if (describeOutboundSend(request)) return undefined;

    if (settings.yolo) return { kind: "approve-once" };

    if (!settings.autoApproveReads) return undefined;

    if (request.kind === "read") {
        // Sandbox-bypass reads are an escalation — always ask.
        return request.requestSandboxBypass ? undefined : { kind: "approve-once" };
    }

    if (request.kind === "mcp" && request.readOnly) {
        return { kind: "approve-once" };
    }

    if (request.kind === "shell") {
        const commands = request.commands ?? [];
        const readOnly =
            commands.length > 0 &&
            commands.every((c) => c.readOnly) &&
            !request.hasWriteFileRedirection;
        if (readOnly) return { kind: "approve-once" };
    }

    return undefined;
}

export function permissionOptions(
    description: PermissionDescription,
): PendingRequest["options"] {
    // "Allow once" is the right words for a shell command and the wrong words
    // for a message: the button should say what it does to other people.
    const allowLabel = description.outbound ? "Send it" : "Allow once";
    const denyLabel = description.outbound ? "Don't send" : "Nope";
    const options: PendingRequest["options"] = [{ id: "once", label: allowLabel, tone: "primary" }];
    if (description.canOfferSessionApproval) {
        options.push({ id: "session", label: "Allow for session", tone: "neutral" });
    }
    options.push({ id: "deny", label: denyLabel, tone: "danger" });
    return options;
}

/** Map the option the human clicked back onto an SDK decision. */
export function optionToDecision(
    optionId: string,
    request: PermissionRequest,
): PermissionRequestResult {
    if (optionId === "once") return { kind: "approve-once" };
    if (optionId === "session") {
        const approval = buildSessionApproval(request);
        return approval ? { kind: "approve-for-session", approval } : { kind: "approve-once" };
    }
    return { kind: "reject", feedback: "The user declined this action. Try a different approach or ask them why." };
}

function buildSessionApproval(
    request: PermissionRequest,
): SessionApproval | undefined {
    // A blanket rule for "workiq/create_entity" would re-open the hole this
    // guard closes, so an outbound send is never session-approvable even if the
    // card somehow offered it.
    if (describeOutboundSend(request)) return undefined;

    switch (request.kind) {
        case "shell": {
            const commandIdentifiers = (request.commands ?? []).map((c) => c.identifier);
            if (commandIdentifiers.length === 0) return undefined;
            return { kind: "commands", commandIdentifiers };
        }
        case "write":
            return { kind: "write" };
        case "mcp":
            return {
                kind: "mcp",
                serverName: request.serverName,
                toolName: request.toolName ?? null,
            };
        case "custom-tool":
            return { kind: "custom-tool", toolName: request.toolName };
        default:
            return undefined;
    }
}

function truncate(value: string, limit: number): string | undefined {
    if (!value) return undefined;
    return value.length > limit ? `${value.slice(0, limit)}…` : value;
}
