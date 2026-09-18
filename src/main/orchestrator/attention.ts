/**
 * How much Orbit may say into a silence before it stops saying it.
 *
 * This exists because of 17 September 2026, a day the interaction log describes
 * better than any argument could: 33 turns from Orbit, 4 messages from Seshi.
 * Between 10:07 and 14:27 local, Orbit spoke fifteen consecutive times and was
 * not answered once. Five of those fifteen carried no information at all. Three
 * of them were announcements of silence, delivered five minutes apart:
 *
 *   10:17  "Going quiet until the 11:00."
 *   10:27  "Nothing further from me before 11:00."
 *   10:32  "Still holding."
 *
 * A turn that exists only to say a turn is not coming is an interruption
 * arguing that it is not one.
 *
 * ## Why it happened
 *
 * Two mechanisms, each individually defensible, multiply. `reRaiseOpenItems`
 * runs every five minutes and pushes up to `RERAISE_BATCH` due decisions at
 * Orbit through `notifyOrbit`. `chaseStaleActivity` runs on the same period,
 * offset by half. Every such nudge lands as a prompt, and every prompt produces
 * a turn, and every turn is visible.
 *
 * `openItems.ts` already backs off, but per item: an individual decision is
 * asked less and less often. With fifty decisions outstanding, which is where
 * the backlog actually stood on 17 September, per-item back-off buys nothing.
 * Fifty items each due every four hours is still a due item roughly every five
 * minutes, forever. The queue was throttled and the channel was not.
 *
 * So this module throttles the channel. It counts what per-item back-off cannot
 * see: how many times in a row Orbit has spoken without being answered.
 *
 * ## The rule
 *
 * Two turns of grace, because the first unanswered message is a bad moment
 * rather than a signal and the second is barely more. From the third, the
 * minimum gap between self-initiated interruptions doubles from fifteen minutes
 * to a three-hour ceiling. Anything the user says resets it to zero, instantly
 * and completely: he is back, and the evidence that he was ignoring Orbit is
 * spent.
 *
 * Replayed against 17 September, the run of fifteen becomes six.
 *
 * ## What it deliberately does not gate
 *
 * Only the two self-initiated chase loops. A meeting heads-up is tied to a real
 * event on his calendar, a finished agent is work he asked for, and a scheduled
 * watcher firing is a standing instruction he wrote. None of those are Orbit
 * filling a silence, and a user who has not typed in an hour still wants to
 * know his 11:00 starts in five minutes. They count toward the tally, because
 * the tally measures how much has been said into the silence and they were said
 * into it. They are simply never refused.
 *
 * Pure, and free of any store or clock, so it can be verified without an app:
 * see `scripts/verify-attention.ts`.
 */

/**
 * Unanswered turns allowed before the channel starts widening.
 *
 * Two. One ignored message is a bad moment. Three in a row, at the five-minute
 * cadence the chase loops run at, is fifteen minutes of talking to nobody.
 */
export const ATTENTION_GRACE = 2;

/** The first enforced gap, once grace is spent. */
export const QUIET_BASE_MS = 15 * 60 * 1000;

/**
 * The longest the gap will ever stretch to. Three hours: long enough that a
 * thoroughly ignored channel goes quiet for most of an afternoon, short enough
 * that Orbit is still there when he comes back from one.
 */
export const QUIET_CEILING_MS = 3 * 60 * 60 * 1000;

/**
 * The exact reply that means "this nudge was not worth a turn".
 *
 * A literal token rather than a judgement about emptiness, because deciding
 * whether prose is informative is exactly the thing that produced "Still
 * holding." A token is unambiguous in both directions: Orbit knows it is
 * allowed to be silent, and the renderer knows silence was chosen rather than
 * inferred from a turn that happened to be short.
 */
export const SILENCE_TOKEN = "(nothing to add)";

/**
 * The line appended to every self-initiated nudge, telling Orbit silence is on
 * the menu. Without it the model has no way to decline: it has been handed a
 * prompt, and a prompt has always meant a turn.
 */
export const SILENCE_AFFORDANCE = [
    `If none of this is worth interrupting him for right now, reply with exactly`,
    `${SILENCE_TOKEN} and nothing else. Saying nothing is a real choice and is`,
    `always better than a turn whose only content is that you are staying quiet.`,
].join("\n");

/** What the channel knows about itself when it is deciding whether to speak. */
export interface AttentionFacts {
    /** Turns Orbit has taken since the user last said anything. */
    unanswered: number;
    /** When Orbit last spoke unprompted. Undefined when it has not yet. */
    lastProactiveAt?: number;
}

export interface AttentionVerdict {
    /** Whether a self-initiated interruption may go out now. */
    speak: boolean;
    /** Why, in a few words, for the log and for explaining itself. */
    because: string;
    /**
     * The gap currently being enforced. Zero while in grace. Reported even when
     * `speak` is true so a caller can say how close to the edge it is.
     */
    requiredGapMs: number;
}

/**
 * The minimum silence owed before the next self-initiated interruption.
 *
 * Doubling rather than a longer flat gap, for the reason `openItems.ts` gives
 * about askings: the signal is asymmetric. Two ignored turns might be a
 * meeting. Eight is an answer.
 */
export function requiredGapMs(unanswered: number): number {
    if (unanswered < ATTENTION_GRACE) return 0;
    const steps = unanswered - ATTENTION_GRACE;
    return Math.min(QUIET_CEILING_MS, QUIET_BASE_MS * 2 ** steps);
}

/**
 * May Orbit interrupt on its own account right now?
 *
 * Called by the chase loops only. Event-driven speech does not ask.
 */
export function decideInterrupt(facts: AttentionFacts, now: number): AttentionVerdict {
    const gap = requiredGapMs(facts.unanswered);

    if (gap === 0) {
        return { speak: true, because: "he is still in the conversation", requiredGapMs: 0 };
    }
    if (facts.lastProactiveAt === undefined) {
        return { speak: true, because: "nothing has been said unprompted yet", requiredGapMs: gap };
    }

    const since = now - facts.lastProactiveAt;
    if (since >= gap) {
        return {
            speak: true,
            because: `${describeGap(gap)} of quiet has been served`,
            requiredGapMs: gap,
        };
    }
    return {
        speak: false,
        because: `${facts.unanswered} turns unanswered, owing ${describeGap(gap - since)} more quiet`,
        requiredGapMs: gap,
    };
}

/**
 * Is this turn Orbit declining to speak?
 *
 * Strict: the token has to be the whole message, give or take surrounding
 * whitespace, a trailing full stop, and the markdown emphasis a model sometimes
 * wraps a parenthetical in. A turn that merely ends with the phrase is a turn,
 * and swallowing it would lose something the user was meant to read.
 */
export function isSilence(content: string): boolean {
    const bare = content
        .trim()
        .replace(/^[*_`]+|[*_`]+$/g, "")
        .trim()
        .replace(/\.$/, "")
        .trim()
        .toLowerCase();
    return bare === SILENCE_TOKEN || bare === SILENCE_TOKEN.slice(1, -1);
}

/** "15 minutes", "2 hours". Only ever read by Orbit or by a log. */
function describeGap(ms: number): string {
    const minutes = Math.max(1, Math.round(ms / 60_000));
    if (minutes < 90) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    const hours = Math.round(minutes / 6) / 10;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
}
