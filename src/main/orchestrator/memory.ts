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

/** The categories a memory may carry. */
export const MEMORY_CATEGORIES = ["preference", "fact", "routine", "person", "project"] as const;

/** What a memory falls back to. The least specific claim about what it is. */
export const DEFAULT_MEMORY_CATEGORY: MemoryNote["category"] = "fact";

/**
 * Coerce whatever arrived into a real category.
 *
 * `orbit_remember`'s own schema is a `z.enum`, so nothing reaches the store
 * without a category by that route. Agents do not take that route: they call
 * the tool across the agent bridge, and one of them wrote a memory on 17
 * September with no category field at all. It has been rendering as
 * "[undefined]" in every prompt since, on a line that reads "Apars Walia is
 * the primary approver for Game Streaming session limits".
 *
 * A label of "[undefined]" is not a small cosmetic problem in a prompt. Every
 * other line announces what kind of claim it is, so the odd one out reads as a
 * malformed record, and a reader who discounts a record discounts the approver
 * named in it. Validating at the tool boundary would have missed this, because
 * the boundary that failed was not the one with the schema on it. So it is
 * done here, where every write and every render has to pass.
 */
export function normaliseCategory(category: unknown): MemoryNote["category"] {
    return MEMORY_CATEGORIES.includes(category as MemoryNote["category"])
        ? (category as MemoryNote["category"])
        : DEFAULT_MEMORY_CATEGORY;
}

/**
 * Longest a memory is *rendered* into a prompt. Not what is kept on disk.
 *
 * The distinction is the whole point. Until now this was the storage cap:
 * `remember` clipped to it before writing, so the words past it were gone and
 * no later reader, however careful, could get them back. See `clipMemory`
 * below for what that cost. Storage keeps the sentence whole; only the copy
 * pasted into a prompt is shortened, and a shortened one says where the rest
 * of it lives.
 */
export const MEMORY_RENDER_CAP = 240;

/**
 * The one hard limit on what is stored: generous, and there only so a runaway
 * caller cannot write a megabyte into the memory file. Anything under this is
 * kept exactly as written.
 */
export const MEMORY_STORE_CAP = 4000;

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
    const shown = memories.slice(-cap).map((memory) => ({ memory, clipped: clipMemory(memory.text) }));
    const lines = shown
        .map(({ memory, clipped }) => `- [${normaliseCategory(memory.category)}] ${clipped.text}`)
        .join("\n");
    // Only say it when it is true. A standing instruction about truncation on a
    // list where nothing was truncated is noise, and noise in a preamble is how
    // the real warnings stop being read.
    const anyLost = shown.some(({ memory }) => endsIncomplete(memory.text));
    // A memory can be both: written already-cut, and still long enough to be
    // shortened again here. "Unrecoverable" is the dominant truth about it, so
    // it does not also get counted as something worth going to look up.
    const anyClipped = shown.some(({ memory, clipped }) => clipped.truncated && !endsIncomplete(memory.text));
    const truncationGuidance = [
        ...(anyClipped
            ? [
                  "A memory ending in \"[truncated]\" is shortened here, not lost: the full wording is",
                  "stored. Call orbit_list_memories to read the rest before relying on it, and never",
                  "guess at the missing clause. That is where the qualifier lives.",
              ]
            : []),
        ...(anyLost
            ? [
                  "Some memories below were cut short before they were stored and cannot be recovered,",
                  "even from orbit_list_memories. Treat whatever followed as unknown rather than",
                  "guessing, and rewrite the memory once you learn what it should have said.",
              ]
            : []),
    ];
    return [
        "<remembered>",
        "Things you have learned about this user. They were true when they were written.",
        "They are beliefs recorded earlier, not findings: where something you have actually",
        "checked in this run contradicts one, the fresh evidence wins. Say that it does, and",
        "correct the memory with orbit_correct_memory. Do not talk someone out of a thing they",
        "just verified on the strength of a line in this list, and never suppress a warning",
        "because a memory says it is handled.",
        ...truncationGuidance,
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
 * Shorten a memory for a prompt without silently destroying its meaning.
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
 *
 * And, since 23 September, this runs at render rather than at write. Marking
 * the cut tells a reader that something is missing; it does not tell them what.
 * That is only answerable if the words still exist somewhere, so the store now
 * holds the sentence whole and this shortens the copy going into the prompt.
 * The difference between the two versions of this fix is the difference between
 * "you cannot trust the end of this line" and "here is how to go and read it".
 */
export const TRUNCATION_MARKER = " … [truncated]";

export function clipMemory(text: string, cap = MEMORY_RENDER_CAP): ClippedMemory {
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
 * Words too common to carry meaning, so that two sentences are compared on
 * what they claim rather than on how English is built. "Seshi" and "Orbit" are
 * in here for the same reason: nearly every memory names one or both, so they
 * make unrelated records look alike.
 */
const OVERLAP_STOPWORDS = new Set(
    (
        "a an and are as at be been by do does for from had has have he her him his in " +
        "into is it its not of on or she that the them then they this to was were what " +
        "when where which who will with would you your seshi orbit want wants"
    ).split(" "),
);

function contentWords(text: string): Set<string> {
    return new Set(
        text
            .toLowerCase()
            .match(/[a-z0-9]+/g)
            ?.filter((word) => word.length > 2 && !OVERLAP_STOPWORDS.has(word)) ?? [],
    );
}

/** How alike two memories are, on the words that actually carry a claim. */
export interface MemorySimilarity {
    /** Shared words over all words. Penalises one sentence being much longer. */
    jaccard: number;
    /** Shared words over the shorter sentence's words. Catches "B restates A, plus more". */
    containment: number;
}

export function memorySimilarity(a: string, b: string): MemorySimilarity {
    const left = contentWords(a);
    const right = contentWords(b);
    if (left.size === 0 || right.size === 0) return { jaccard: 0, containment: 0 };

    let shared = 0;
    for (const word of left) if (right.has(word)) shared += 1;
    const union = left.size + right.size - shared;
    return {
        jaccard: union === 0 ? 0 : shared / union,
        containment: shared / Math.min(left.size, right.size),
    };
}

/**
 * Where the line sits between "this is the same memory again" and "these are
 * two facts about the same subject".
 *
 * Calibrated against the real store on 24 September, which held 60 memories.
 * Every pair was scored with the stopword list above. One pair stood out: the
 * two records saying Dhaivat Pandit goes by DP, at containment 0.71 and
 * Jaccard 0.39. The next pair down on either axis was containment 0.50 and
 * Jaccard 0.27, so both lines below sit inside a real gap rather than being
 * round numbers chosen because they look tidy.
 *
 * The runner-up pairs are the interesting part. Two records about ADO ids in
 * leadership documents are a genuine restatement and score 0.47 containment;
 * two records about Apars Walia and Lakshey Hooda are genuinely complementary
 * and score 0.50. The true duplicate scores *lower* than the pair that should
 * be kept. Word overlap cannot separate them, so do not pretend it can.
 *
 * Block only above the line where the evidence is unambiguous, and below it
 * say what was noticed and let the writer decide. Guessing wrong in the
 * blocking direction loses a fact permanently and silently, which is the
 * failure mode this store has already suffered twice.
 */
export const DUPLICATE_CONTAINMENT = 0.7;
export const DUPLICATE_JACCARD = 0.35;
export const RELATED_CONTAINMENT = 0.4;
export const RELATED_JACCARD = 0.2;

export interface MemoryOverlap {
    id: string;
    text: string;
    similarity: MemorySimilarity;
}

export interface OverlapReport {
    /** Near enough that writing a second record is certainly wrong. */
    duplicate?: MemoryOverlap;
    /** Worth a look, ordered most alike first. Never a reason to drop the write. */
    related: MemoryOverlap[];
}

/**
 * Compare a candidate memory against everything already known.
 *
 * Exact-match dedup has never been enough: the store accumulated paraphrases
 * because the same fact written twice in different words is two different
 * strings. A prompt carrying the same claim twice spends its budget twice and
 * invites the model to treat a repetition as emphasis.
 */
export function findMemoryOverlap(text: string, memories: MemoryNote[]): OverlapReport {
    const scored = memories
        .map((memory) => ({ id: memory.id, text: memory.text, similarity: memorySimilarity(text, memory.text) }))
        .filter(({ similarity }) => similarity.jaccard >= RELATED_JACCARD || similarity.containment >= RELATED_CONTAINMENT)
        .sort((a, b) => b.similarity.containment - a.similarity.containment);

    const duplicate = scored.find(
        ({ similarity }) =>
            similarity.containment >= DUPLICATE_CONTAINMENT && similarity.jaccard >= DUPLICATE_JACCARD,
    );
    return { duplicate, related: scored.filter((entry) => entry !== duplicate) };
}

/**
 * Does this text stop mid-thought with no way back? True for anything written
 * under the old write-time clip, which left either the marker or a bare
 * ellipsis at the end and kept nothing else.
 */
export function endsIncomplete(text: string): boolean {
    const clean = text.trimEnd();
    return clean.endsWith(TRUNCATION_MARKER.trim()) || clean.endsWith("\u2026");
}

/**
 * Normalise a memory for storage. Whitespace is collapsed because a memory is
 * one sentence, and the only truncation left is the runaway ceiling, which no
 * real memory comes near.
 */
export function storableMemoryText(text: string): ClippedMemory {
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean.length <= MEMORY_STORE_CAP) return { text: clean, truncated: false };
    return clipMemory(clean, MEMORY_STORE_CAP);
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

    const clipped = storableMemoryText(correction.text);
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
        category: normaliseCategory(correction.category ?? current.category),
        correctedAt: now,
        ...(priorText.length > 0 ? { priorText: priorText.slice(-PRIOR_TEXT_CAP) } : {}),
    };
    all[index] = corrected;
    return { memories: all, corrected };
}

/**
 * Every pair in the store that looks like the same claim written twice.
 *
 * The write-time guard can only stop new duplicates. The ones already on disk
 * predate it, and nothing reviews the memory list except the nightly
 * reflection, which had to go and write an ad-hoc script to find them on 24
 * September. A fact Orbit can work out for itself should not need a script, so
 * this is surfaced through `orbit_list_memories` and the pairs can be merged
 * with `orbit_correct_memory`.
 */
export interface DuplicatePair {
    a: MemoryOverlap;
    b: MemoryOverlap;
    likely: boolean;
}

export function findDuplicatePairs(memories: MemoryNote[]): DuplicatePair[] {
    const pairs: DuplicatePair[] = [];
    for (let i = 0; i < memories.length; i += 1) {
        for (let j = i + 1; j < memories.length; j += 1) {
            const similarity = memorySimilarity(memories[i].text, memories[j].text);
            if (similarity.jaccard < RELATED_JACCARD && similarity.containment < RELATED_CONTAINMENT) continue;
            pairs.push({
                a: { id: memories[i].id, text: memories[i].text, similarity },
                b: { id: memories[j].id, text: memories[j].text, similarity },
                likely:
                    similarity.containment >= DUPLICATE_CONTAINMENT && similarity.jaccard >= DUPLICATE_JACCARD,
            });
        }
    }
    return pairs.sort((x, y) => y.a.similarity.containment - x.a.similarity.containment);
}

/**
 * Fold one memory into another.
 *
 * Detecting a duplicate is worth nothing without a way to resolve it, and on
 * 24 September there was none. `orbit_forget` destroys a record and is
 * withheld from agents for exactly that reason, so the nightly reflection
 * could see the two records about what DP is called and do nothing about
 * either: correcting one still leaves two, and deleting one it may not do.
 *
 * A merge is the same trade that made `correctMemory` safe. The survivor takes
 * the agreed wording, and the loser's sentence is retired into the survivor's
 * `priorText` rather than dropped, so the claim leaves the active list without
 * leaving the store. Nothing is destroyed, so an agent can be trusted with it.
 */
export interface MergeOutcome {
    memories: MemoryNote[];
    merged?: MemoryNote;
    error?: string;
}

export function mergeMemories(
    memories: readonly MemoryNote[],
    keepId: string,
    foldId: string,
    text: string | undefined,
    reason: string | undefined,
    now: number,
): MergeOutcome {
    const all = [...memories];
    if (keepId === foldId) {
        return { memories: all, error: "Those are the same memory. A merge needs two different ids." };
    }

    const keepIndex = findIndexById(all, keepId);
    if (keepIndex === -1) {
        return { memories: all, error: describeMiss(findById(all, keepId), "memory") };
    }
    const foldIndex = findIndexById(all, foldId);
    if (foldIndex === -1) {
        return { memories: all, error: describeMiss(findById(all, foldId), "memory") };
    }

    const keep = all[keepIndex];
    const fold = all[foldIndex];

    // The surviving wording defaults to the one being kept, so a merge that
    // only wants the duplicate gone does not have to restate the sentence.
    const wanted = storableMemoryText(text ?? keep.text).text;
    if (wanted.length === 0) {
        return { memories: all, error: "The surviving memory cannot be empty." };
    }

    const priorText = [...(keep.priorText ?? []), ...(fold.priorText ?? [])];
    priorText.push({
        text: fold.text,
        retiredAt: now,
        reason: reason ?? `merged into ${keepId}`,
    });
    if (!same(keep.text, wanted)) {
        priorText.push({ text: keep.text, retiredAt: now, ...(reason ? { reason } : {}) });
    }

    const merged: MemoryNote = {
        ...keep,
        text: wanted,
        correctedAt: now,
        priorText: priorText.slice(-PRIOR_TEXT_CAP),
    };
    all[keepIndex] = merged;
    return { memories: all.filter((memory) => memory.id !== foldId), merged };
}
