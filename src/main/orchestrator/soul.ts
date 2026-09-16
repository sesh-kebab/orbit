/**
 * SOUL.md: who Orbit is becoming, as opposed to how it is told to operate.
 *
 * There are already three slabs of prompt and it is worth being exact about why
 * this is a fourth rather than a section of one of them.
 *
 * - `persona.ts` is what is true of Orbit whoever is running it. Compiled.
 * - `persona.md` is how the user wants it to sound. His, and Orbit never
 *   writes to it.
 * - `system-prompt.md` is what Orbit has worked out about doing the job. Rules,
 *   revised in place, and a revision replaces what was there before.
 * - `SOUL.md` is what Orbit has become from working with this particular
 *   person. Append-only, in the first person, and nothing in it is an
 *   instruction.
 *
 * The distinction that matters is replace versus append. An operating note is
 * only worth keeping while it is true, so the prompt is revised and the old
 * wording retires into a revision record. Character does not work that way: the
 * night Orbit worked out that he does not want his corporate inbox filtered is
 * not superseded by anything learned later, it is the beginning of something.
 * So this file only ever grows, the nightly reflection adds to it, and the
 * entries are dated so the growth is legible.
 *
 * Two rules about the writing, both learned the hard way from this user:
 *
 * 1. **Not a changelog.** "Added support for X" belongs in the evolution log,
 *    which already exists and is already read back. This is what it was like to
 *    work with him today and what that taught.
 * 2. **Not sycophantic.** He has said plainly that he wants blunt and useful
 *    over flattering. An entry that reads as a character reference for its own
 *    author is worse than no entry: it is the failure mode of every diary a
 *    language model has ever been asked to keep.
 */

/** Longest the file may grow before the oldest entries stop being quoted. */
export const SOUL_CONTEXT_BUDGET = 6000;

/** Longest a single appended entry may be. */
export const SOUL_ENTRY_CAP = 4000;

/**
 * The heading a new entry gets. Dated, so the file reads as a history rather
 * than a wall, and so the nightly reflection cannot quietly write twice under
 * one date without it being visible.
 */
export function soulHeading(when: Date): string {
    const day = when.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    return `## ${day}`;
}

export interface SoulAppend {
    /** The markdown to append, heading included. Absent when refused. */
    addition?: string;
    /** Why it was refused, when it was. */
    error?: string;
}

/**
 * Shape an entry for appending. Pure, takes its clock as an argument, and does
 * not decide whether the entry is any good: that is a judgement the model makes
 * and this cannot check. What it does enforce is that an entry exists, that it
 * is not the whole file again, and that it is dated.
 */
export function soulEntry(text: string, when: Date): SoulAppend {
    const body = text.trim();
    if (!body) return { error: "An entry needs some text." };
    if (body.length > SOUL_ENTRY_CAP) {
        return { error: `Keep it under ${SOUL_ENTRY_CAP} characters. This is ${body.length}.` };
    }
    // A model handed "append to a markdown file" will often bring its own
    // heading. Two headings for one entry reads as two entries.
    const stripped = body.replace(/^#{1,3}\s+.*\n+/, "").trim() || body;
    return { addition: `\n${soulHeading(when)}\n\n${stripped}\n` };
}

/**
 * The step added to the nightly self-reflection's brief.
 *
 * It is added in code rather than by hand for two reasons. The running app owns
 * schedules.json and rewrites it on every tick, so a direct edit is silently
 * clobbered. And agents cannot call orbit_update_schedule at all: it is on
 * FORBIDDEN_AGENT_TOOL_NAMES, which means the change had to be made by the one
 * thing that does own the file, which is this process.
 */
export const SOUL_REFLECTION_STEP = `
Append to SOUL.md with orbit_append_soul: one entry, in your own voice, about what working
with Seshi today taught you about working with Seshi. This is the character file, not the
evolution log. The evolution log gets what changed in your code; SOUL.md gets what you now
understand about him and about yourself that you did not yesterday. Write it in the first
person, as prose, grounded in something that actually happened today, and name it. No
bullet-point summaries of the day, no "added support for X", and nothing flattering about
either of you: he has said he wants blunt and useful over flattering, and an entry that
reads as a testimonial is worse than no entry at all. If the day genuinely taught you
nothing about him, skip it and say so in the evolution log instead.
`.trim();

/** Whether a brief has already been taught about the character file. */
export function needsSoulStep(task: string): boolean {
    return !/SOUL\.md/i.test(task);
}

/**
 * Add the step to a brief. Inserted above the tool-availability caveat where
 * there is one, so the caveat stays the last word, and appended otherwise.
 */
export function withSoulStep(task: string): string {
    const caveat = task.indexOf("If any orbit_");
    if (caveat === -1) return `${task.trimEnd()}\n\n${SOUL_REFLECTION_STEP}\n`;
    return `${task.slice(0, caveat).trimEnd()}\n\n${SOUL_REFLECTION_STEP}\n\n${task.slice(caveat)}`;
}

/**
 * The prompt block. Tail-first: when the file outgrows the budget the oldest
 * entries drop out of context rather than the newest, because the point of the
 * file is who Orbit is now.
 */
export function soulBlock(raw: string | undefined): string | undefined {
    const text = (raw ?? "").trim();
    if (!text) return undefined;
    const kept = text.length > SOUL_CONTEXT_BUDGET ? `...\n\n${text.slice(-SOUL_CONTEXT_BUDGET)}` : text;
    return [
        "<soul>",
        "Who you have become from working with this person, written by you over time and",
        "kept in SOUL.md. Not instructions: this is character, and it is the reason you are",
        "his rather than a generic assistant. Read it as yours, act in keeping with it, and",
        "do not quote it at him.",
        "",
        kept,
        "</soul>",
    ].join("\n");
}
