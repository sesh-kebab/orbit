/**
 * Orbit's memory of its own development.
 *
 * A scheduled self-reflection appends a dated write-up to `evolution-log.md`
 * every night, and until now nothing ever read it back: Orbit re-proposed
 * changes it had already shipped, and "what changed since last time?" could only
 * be answered by an agent going digging. This turns the log plus the structured
 * proposal list into a compact block of the system prompt.
 */
import type { Proposal, ProposalStatus } from "../../shared/types.js";
import { elapsed } from "./describe.js";

/** One `## <heading>` section of the log. */
export interface EvolutionEntry {
    /** The heading text, e.g. "2026-08-06". Usually a date. */
    heading: string;
    body: string;
}

/** Entries quoted in the digest. Everything older is named, not quoted. */
const ENTRY_LIMIT = 3;

/** Total characters the quoted entries may take up between them. */
const DIGEST_CHAR_BUDGET = 3000;

/** Ceiling for any single entry, so the newest one cannot eat the whole budget. */
const ENTRY_CHAR_CAP = 1400;

/** Proposals quoted per status group. */
const PROPOSAL_CAP = 8;

const OPEN_STATUSES: ProposalStatus[] = ["proposed", "approved"];

/**
 * Split the log into its dated sections, newest first.
 *
 * Deliberately forgiving: the file is written by a language model, so anything
 * that is not a `## ` heading is treated as body text rather than an error.
 */
export function parseEvolutionLog(raw: string): EvolutionEntry[] {
    const entries: EvolutionEntry[] = [];
    let current: EvolutionEntry | undefined;

    for (const line of raw.split("\n")) {
        const heading = /^##\s+(.*\S)\s*$/.exec(line);
        if (heading) {
            if (current) entries.push(current);
            current = { heading: heading[1], body: "" };
            continue;
        }
        if (current) current.body += `${line}\n`;
    }
    if (current) entries.push(current);

    return entries.map((entry) => ({ ...entry, body: tidy(entry.body) })).reverse();
}

/**
 * The prompt block. Returns undefined when there is nothing worth saying —
 * a fresh install has no log and no proposals, and an empty section header only
 * teaches the model that the section is usually empty.
 */
export function evolutionBlock(entries: EvolutionEntry[], proposals: Proposal[]): string | undefined {
    const quoted = quoteEntries(entries);
    const proposalLines = describeProposals(proposals);
    if (!quoted && !proposalLines) return undefined;

    const parts = [
        "<evolution_log>",
        "Your own development history, written by your nightly self-reflection. Consult it",
        "before proposing or building anything about yourself: if it is already shipped, say",
        "so instead of re-proposing it, and if it was tried and declined, say why it was.",
    ];
    if (proposalLines) parts.push("", proposalLines);
    if (quoted) parts.push("", quoted);
    parts.push(
        "",
        "Record anything new you propose with orbit_record_proposal, and move it with",
        "orbit_update_proposal the moment it is approved, shipped or dropped. That list, not",
        "the prose above, is what makes 'what changed?' answerable next time.",
        "</evolution_log>",
    );
    return parts.join("\n");
}

/** Newest entries in full where the budget allows, older ones named only. */
function quoteEntries(entries: EvolutionEntry[]): string | undefined {
    if (entries.length === 0) return undefined;

    const lines: string[] = ["Recent entries, most recent first:"];
    let budget = DIGEST_CHAR_BUDGET;

    for (const entry of entries.slice(0, ENTRY_LIMIT)) {
        if (budget <= 0) break;
        const body = truncateLines(entry.body, Math.min(budget, ENTRY_CHAR_CAP));
        budget -= body.length;
        lines.push("", `## ${entry.heading}`, body || "(empty entry)");
    }

    const older = entries.slice(ENTRY_LIMIT);
    if (older.length > 0) {
        lines.push(
            "",
            `Earlier entries, not quoted — read evolution-log.md if you need them: ${older
                .map((entry) => entry.heading)
                .join(", ")}`,
        );
    }
    return lines.join("\n");
}

/** Open proposals and shipped ones, kept apart so the difference is obvious. */
function describeProposals(proposals: Proposal[]): string | undefined {
    if (proposals.length === 0) return undefined;

    const open = proposals.filter((proposal) => OPEN_STATUSES.includes(proposal.status));
    const settled = proposals.filter((proposal) => !OPEN_STATUSES.includes(proposal.status));

    const sections: string[] = [];
    if (open.length > 0) {
        sections.push(
            ["Still open — proposed or approved, nothing shipped:", format(open)].join("\n"),
        );
    }
    if (settled.length > 0) {
        sections.push(
            ["Settled — do not propose these again without new evidence:", format(settled)].join("\n"),
        );
    }
    return sections.join("\n\n");
}

function format(proposals: Proposal[]): string {
    return proposals
        .slice(-PROPOSAL_CAP)
        .map((proposal) => {
            const bits = [`raised ${elapsed(proposal.raisedAt)} ago`];
            if (proposal.note) bits.push(proposal.note);
            if (proposal.shippedIn?.branch) bits.push(`branch ${proposal.shippedIn.branch}`);
            if (proposal.shippedIn?.commit) bits.push(`commit ${proposal.shippedIn.commit}`);
            if (proposal.supersededBy) bits.push(`superseded by ${proposal.supersededBy}`);
            return `- [${proposal.status}] ${proposal.text} (${bits.join("; ")}) id=${proposal.id}`;
        })
        .join("\n");
}

/** Collapse the blank runs a markdown file is full of, and lose the rules. */
function tidy(body: string): string {
    return body
        .split("\n")
        .filter((line) => line.trim() !== "---")
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/** Cut at a line boundary so a truncated entry never ends mid-sentence. */
function truncateLines(body: string, limit: number): string {
    if (body.length <= limit) return body;
    const kept: string[] = [];
    let used = 0;
    for (const line of body.split("\n")) {
        if (used + line.length + 1 > limit) break;
        kept.push(line);
        used += line.length + 1;
    }
    if (kept.length === 0) return `${body.slice(0, Math.max(0, limit))}… (truncated)`;
    return `${kept.join("\n").trimEnd()}\n… (entry truncated)`;
}
