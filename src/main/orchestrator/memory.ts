/**
 * Correcting a memory, as opposed to deleting one.
 *
 * Memories are injected into the system prompt of every session
 * (`orchestrator.ts`, the memory block). That makes a wrong memory active
 * misinformation rather than an inert record: it is re-asserted to the model
 * every time Orbit starts, and it will be believed.
 *
 * `orbit_forget` already existed, but it is on `FORBIDDEN_AGENT_TOOL_NAMES`
 * because it "destroys a record rather than moving it". That rule is right, and
 * the consequence was still wrong: the nightly self-reflection is the only
 * process that ever reviews the memory list, and it could add to that list but
 * never repair it. Four of twenty-six memories still named the project by its
 * old name and pointed at a repo and a log path that have not existed since
 * 20 August, and no run could do anything about it but write another memory
 * contradicting the first.
 *
 * So the fix is a correction, not a delete. The record keeps its id, its
 * creation date and its provenance; the old wording is retired into
 * `priorText` with the reason it was replaced. Nothing is destroyed, which is
 * exactly the property that made deletion unsafe for an agent, so this is safe
 * for one.
 */
import type { MemoryNote } from "../../shared/types.js";
import { describeMiss, findById, findIndexById } from "./ids.js";

/** How many superseded wordings to keep before dropping the oldest. */
export const PRIOR_TEXT_CAP = 5;

/** Longest a memory may be, matching what `remember` clips to. */
export const MEMORY_TEXT_CAP = 240;

/**
 * How many memories go into a prompt. The newest win, because a correction is
 * always newer than the belief it corrects.
 */
export const MEMORY_CONTEXT_CAP = 60;

/**
 * Render what is known about the user, for a prompt.
 *
 * This exists as one shared function rather than a string built at each call
 * site because the two call sites disagreeing is a real bug that has already
 * happened, not a tidiness concern.
 *
 * On 21 September at 15:59 the user wrote "Amex - this is done. I confirmed
 * that the payment has gone through", and a memory was duly written saying the
 * $460 balance had no claim outstanding. At 15:04 the next morning the daily
 * briefing agent flagged the same $460 again, and Orbit's own chat turn
 * corrected it in the same minute. Both were reasoning from the same store.
 * Only one of them had been given it: `buildAgentPrompt` passed the preamble,
 * the design language and the task, and nothing else. Agents did the looking,
 * and agents were the ones told nothing.
 *
 * So the block is built once, here, and both the orchestrator's system prompt
 * and every dispatched agent are handed the result. They can no longer drift,
 * because there is no longer a second copy to drift from.
 *
 * Note that no attempt is made to select memories relevant to the task. It is
 * tempting, and it fails on exactly the case above: the briefing agent's task
 * says "produce a short executive briefing", never "Amex". Relevance only
 * becomes knowable after the agent has read the mail, which is long after the
 * prompt is built. Everything, capped and newest-first, is the honest answer.
 */
export function rememberedBlock(memories: readonly MemoryNote[], cap = MEMORY_CONTEXT_CAP): string | undefined {
    if (memories.length === 0) return undefined;
    const lines = memories
        .slice(-cap)
        .map((memory) => `- [${memory.category}] ${memory.text}`)
        .join("\n");
    return [
        "<remembered>",
        "Things you have learned about this user. They were true when they were written.",
        "They are beliefs recorded earlier, not findings: where something you have actually",
        "checked in this run contradicts one, the fresh evidence wins. Say that it does, and",
        "correct the memory with orbit_correct_memory. Do not talk someone out of a thing they",
        "just verified on the strength of a line in this list, and never suppress a warning",
        "because a memory says it is handled.",
        "A memory ending in \"[truncated]\" lost its last clause. Treat the missing part as",
        "unknown rather than guessing what it said.",
        lines,
        "</remembered>",
    ].join("\n");
}

export interface MemoryCorrection {
    /** The replacement wording. */
    text: string;
    /** A new category, when the correction changes what kind of thing it is. */
    category?: MemoryNote["category"];
    /** Why it was wrong, in a few words. Kept against the retired wording. */
    reason?: string;
}

export interface CorrectionOutcome {
    /** The list to persist. Unchanged when the correction did not apply. */
    memories: MemoryNote[];
    /** The corrected record, when one changed. */
    corrected?: MemoryNote;
    /** Why nothing changed, when nothing did. */
    error?: string;
    /** Set when the correction was a no-op rather than a failure. */
    note?: string;
}

export interface ClippedMemory {
    text: string;
    /** True when something was cut. The caller is expected to say so. */
    truncated: boolean;
}

/**
 * Shorten a memory for storage without silently destroying its meaning.
 *
 * The plain `clip` helper cuts at the character and appends an ellipsis, which
 * is right for a tool label in the activity feed and actively dangerous for a
 * memory, because a memory is re-asserted into a prompt and believed.
 *
 * What that cost, on 22 September 2026. A memory was written recording that a
 * $460.00 expense reimbursement had been approved and paid to the user's own
 * account on 11 August, "so the matching $460.00 Amex corporate card balance on
 * account ending 471005 has no c". The sentence was 244 characters and the cap
 * was 240. The four characters past the cap were the start of the clause that
 * distinguished the two halves: the claim was settled, the card balance was
 * still the user's to pay.
 *
 * Read back the next morning, "has no c…" reads as "has no claim", and Orbit
 * told the user his briefing agent was wrong about an unpaid card and that it
 * would stop the agent mentioning it again. The agent was right. The card is
 * cancelled around 9 November.
 *
 * So: cut on a word boundary, never mid-word, and mark the cut so that a reader
 * can see a thought was interrupted rather than completing it themselves. An
 * interrupted sentence that announces itself is recoverable. One that does not
 * is confidently wrong.
 */
export const TRUNCATION_MARKER = " … [truncated]";

export function clipMemory(text: string, cap = MEMORY_TEXT_CAP): ClippedMemory {
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean.length <= cap) return { text: clean, truncated: false };

    const room = cap - TRUNCATION_MARKER.length;
    const head = clean.slice(0, room);
    const lastSpace = head.lastIndexOf(" ");
    const body = (lastSpace > room * 0.5 ? head.slice(0, lastSpace) : head).trimEnd();
    return { text: `${body}${TRUNCATION_MARKER}`, truncated: true };
}

function same(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Apply a correction, returning a new list. Pure: takes its clock as an
 * argument and mutates nothing it was given.
 */
export function correctMemory(
    memories: readonly MemoryNote[],
    memoryId: string,
    correction: MemoryCorrection,
    now: number,
): CorrectionOutcome {
    const all = [...memories];
    const index = findIndexById(all, memoryId);
    if (index === -1) {
        const lookup = findById(all, memoryId);
        const why =
            lookup.status === "ambiguous"
                ? describeMiss(lookup, "memory")
                : "No memory with that id. List them first with orbit_list_memories.";
        return { memories: all, error: why };
    }

    const clipped = clipMemory(correction.text);
    const text = clipped.text;
    if (text.length === 0) {
        return { memories: all, error: "A correction needs replacement text. To retire a memory outright, say so instead." };
    }

    const current = all[index];
    const categoryChanged = correction.category !== undefined && correction.category !== current.category;
    if (same(current.text, text) && !categoryChanged) {
        return { memories: all, corrected: current, note: "Already says that." };
    }

    // Correcting one memory into the exact words of another would leave two
    // records asserting the same thing, which is the duplicate `remember`
    // already refuses to create.
    const collision = all.find((memory) => memory.id !== memoryId && same(memory.text, text));
    if (collision) {
        return {
            memories: all,
            error: `Memory ${collision.id} already says that. Correct or retire that one instead of duplicating it.`,
        };
    }

    const priorText = [...(current.priorText ?? [])];
    if (!same(current.text, text)) {
        priorText.push({ text: current.text, retiredAt: now, ...(correction.reason ? { reason: correction.reason } : {}) });
    }

    const corrected: MemoryNote = {
        ...current,
        text,
        category: correction.category ?? current.category,
        correctedAt: now,
        ...(priorText.length > 0 ? { priorText: priorText.slice(-PRIOR_TEXT_CAP) } : {}),
    };
    all[index] = corrected;
    return { memories: all, corrected };
}
