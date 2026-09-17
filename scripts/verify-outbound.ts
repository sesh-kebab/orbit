/**
 * Verification for the outbound-send guard.
 *
 *   npm run verify:outbound
 *
 * The case that matters is the one that actually happened. On 16 Sep an agent
 * posted into `/chats/19:…@thread.v2/messages` with `yolo` on, so nothing asked
 * anybody anything and a fourth person read a message meant for two. The first
 * check below is that exact request, and it must not be auto-approved.
 *
 * Everything here is pure. No Electron, no network, no real mailbox.
 */
import type { PermissionRequest } from "@github/copilot-sdk";
import {
    autoDecide,
    describePermission,
    optionToDecision,
    permissionOptions,
} from "../src/main/orchestrator/permissions.js";
import { describeOutboundSend } from "../src/main/orchestrator/outbound.js";
import type { Settings } from "../src/shared/types.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: unknown): void {
    if (condition) {
        passed += 1;
        return;
    }
    failures.push(`${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

const YOLO = { yolo: true, autoApproveReads: true } as unknown as Settings;
const CAREFUL = { yolo: false, autoApproveReads: true } as unknown as Settings;

function mcp(toolName: string, args: Record<string, unknown>, readOnly = false): PermissionRequest {
    return {
        kind: "mcp",
        serverName: "workiq",
        toolName,
        toolTitle: toolName,
        readOnly,
        args,
    } as unknown as PermissionRequest;
}

// ── The 16 Sep send, reconstructed ───────────────────────────────────────────

const teamsPost = mcp("create_entity", {
    parentUrl: "/chats/19:b43cff7b4c98479facaae982b375216f@thread.v2/messages",
    jsonBody: {
        body: {
            content:
                "Morning both, quick one: are either of you already tracking a doc for the P0 status update?",
        },
    },
});

check("the 16 Sep Teams post is recognised as outbound", describeOutboundSend(teamsPost) !== undefined);
check(
    "yolo does not auto-approve the 16 Sep Teams post",
    autoDecide(teamsPost, YOLO) === undefined,
    autoDecide(teamsPost, YOLO),
);
check("careful mode does not auto-approve it either", autoDecide(teamsPost, CAREFUL) === undefined);

const teamsCard = describePermission(teamsPost);
check("the card names the surface", teamsCard.title.includes("Teams chat"), teamsCard.title);
check(
    "the card admits the audience is unverified",
    teamsCard.title.includes("recipients unverified"),
    teamsCard.title,
);
check(
    "the card shows the chat it is posting into",
    (teamsCard.subject ?? "").includes("19:b43cff7b4c98479facaae982b375216f@thread.v2"),
    teamsCard.subject,
);
check(
    "the card shows what is about to be said",
    (teamsCard.detail ?? "").includes("are either of you already tracking a doc"),
    teamsCard.detail,
);
check("a send is never session-approvable", teamsCard.canOfferSessionApproval === false);
check(
    "session approval is refused even if the card asked for it",
    optionToDecision("session", teamsPost).kind === "approve-once",
    optionToDecision("session", teamsPost),
);

const options = permissionOptions(teamsCard);
check("the button says what it does", options[0]?.label === "Send it", options);
check("there is no session option on the card", options.every((o) => o.id !== "session"), options);
check("declining still reads as a refusal", optionToDecision("deny", teamsPost).kind === "reject");
check(
    "a timeout is a refusal, not a send",
    optionToDecision("timeout", teamsPost).kind === "reject",
    optionToDecision("timeout", teamsPost),
);

// ── Mail, where the audience is knowable ─────────────────────────────────────

const mail = mcp("do_action", {
    actionUrl: "/me/sendMail",
    jsonBody: {
        message: {
            subject: "P0 status",
            body: { contentType: "Text", content: "Quick one about the pre-read." },
            toRecipients: [
                { emailAddress: { name: "Sachin Bhatia", address: "sachin@microsoft.com" } },
            ],
            ccRecipients: [{ emailAddress: { address: "scott@microsoft.com" } }],
        },
    },
});

const mailSend = describeOutboundSend(mail);
check("sendMail is outbound", mailSend !== undefined);
check("mail recipients are read from the body", mailSend?.recipients.length === 2, mailSend?.recipients);
check(
    "a named recipient is shown with their address",
    mailSend?.recipients.includes("Sachin Bhatia <sachin@microsoft.com>") === true,
    mailSend?.recipients,
);
check("cc counts as a recipient", mailSend?.recipients.includes("scott@microsoft.com") === true);
check("mail audience is known", mailSend?.audienceKnown === true);
check("yolo does not auto-approve mail", autoDecide(mail, YOLO) === undefined);

const mailCard = describePermission(mail);
check("the mail card counts the people", mailCard.title.includes("2 people"), mailCard.title);
check(
    "the mail card lists them by name",
    (mailCard.subject ?? "").includes("Sachin Bhatia"),
    mailCard.subject,
);
check(
    "a known audience is not warned about",
    (mailCard.detail ?? "").includes("Check the membership") === false,
    mailCard.detail,
);

const onePerson = mcp("do_action", {
    actionUrl: "/me/messages/AAA/reply",
    jsonBody: { comment: "Sounds right to me." },
});
check("a reply is outbound", describeOutboundSend(onePerson) !== undefined);
check("a reply is not auto-approved under yolo", autoDecide(onePerson, YOLO) === undefined);

const invite = mcp("create_entity", {
    parentUrl: "/me/events",
    jsonBody: {
        subject: "Squad agreement",
        attendees: [{ emailAddress: { name: "DP", address: "dp@microsoft.com" } }],
    },
});
const inviteSend = describeOutboundSend(invite);
check("creating an event is outbound", inviteSend?.surface === "invite", inviteSend?.surface);
check("attendees are recipients", inviteSend?.recipients.includes("DP <dp@microsoft.com>") === true);
check("the invite card says invite", describePermission(invite).title.includes("meeting invite"));

const channel = mcp("create_entity", {
    parentUrl: "/teams/abc/channels/19:def@thread.tacv2/messages",
    jsonBody: { body: { content: "Posting the pre-read here." } },
});
check("a channel post is outbound", describeOutboundSend(channel)?.surface === "channel");
check("a channel post is not auto-approved", autoDecide(channel, YOLO) === undefined);

const stringBody = mcp("create_entity", {
    parentUrl: "/chats/19:xyz@thread.v2/messages",
    jsonBody: '{"body":{"content":"sent as a JSON string"}}',
});
check(
    "a JSON-string body is still read for a preview",
    (describeOutboundSend(stringBody)?.preview ?? "").includes("sent as a JSON string"),
    describeOutboundSend(stringBody)?.preview,
);

const htmlBody = mcp("create_entity", {
    parentUrl: "/chats/19:xyz@thread.v2/messages",
    jsonBody: { body: { contentType: "html", content: "<p>Morning <b>both</b></p>" } },
});
check(
    "html is stripped out of the preview",
    describeOutboundSend(htmlBody)?.preview === "Morning both",
    describeOutboundSend(htmlBody)?.preview,
);

// ── Things that are not sends, and must stay out of the way ──────────────────

const readChat = mcp("fetch", { entityUrls: ["/chats/19:abc@thread.v2/messages?$top=10"] }, true);
check("reading a chat is not a send", describeOutboundSend(readChat) === undefined);
check("reading a chat is still auto-approved", autoDecide(readChat, CAREFUL)?.kind === "approve-once");

const draft = mcp("create_entity", {
    parentUrl: "/me/messages",
    jsonBody: { subject: "Notes to self", body: { content: "nothing sent" } },
});
check("a draft in your own mailbox is not a send", describeOutboundSend(draft) === undefined);

const listEvents = mcp("fetch", { entityUrls: ["/me/events?$select=subject"] }, true);
check("listing the calendar is not an invite", describeOutboundSend(listEvents) === undefined);

const shell: PermissionRequest = {
    kind: "shell",
    commands: [{ identifier: "git", readOnly: true }],
    fullCommandText: "git status",
} as unknown as PermissionRequest;
check("a shell command is not outbound", describeOutboundSend(shell) === undefined);
check("yolo still approves shell", autoDecide(shell, YOLO)?.kind === "approve-once");
check("a read-only shell command is still auto-approved", autoDecide(shell, CAREFUL)?.kind === "approve-once");
check("the ordinary card keeps its ordinary buttons", permissionOptions(describePermission(shell))[0]?.label === "Allow once");

const write: PermissionRequest = {
    kind: "write",
    fileName: "/tmp/x.md",
    intention: "write notes",
    canOfferSessionApproval: true,
} as unknown as PermissionRequest;
check("a file write is not outbound", describeOutboundSend(write) === undefined);
check("a file write can still be session-approved", describePermission(write).canOfferSessionApproval === true);
check(
    "a file write still builds a session approval",
    optionToDecision("session", write).kind === "approve-for-session",
);

const missingArgs = mcp("create_entity", {});
check("a tool call with no arguments is not guessed at", describeOutboundSend(missingArgs) === undefined);

// ── Report ───────────────────────────────────────────────────────────────────

if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed:`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exit(1);
}
console.log(`outbound: ${passed} checks passed.`);
