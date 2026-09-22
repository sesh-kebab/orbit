/**
 * Which unanswered decisions get put in front of the user, and how often.
 *
 * This exists because of two defects that together made the open-items list
 * quietly lie. Both were found in live state on 12 September, with eleven items
 * outstanding.
 *
 * The first is starvation. The selection was `openItems.slice(-CAP)`: a blind
 * tail of the six most *recent*. Items are appended in creation order, so once
 * more than six were outstanding the oldest were not merely deprioritised, they
 * became unreachable. They could never appear in Orbit's prompt and could never
 * be re-raised, because the re-raise pass filtered the same truncated six. Five
 * items were in that state, among them a BAMI approval that had been sitting for
 * thirty-seven hours and two that had never been raised a second time at all.
 * An item aged into invisibility exactly as it became urgent, which is the worst
 * possible direction for the bug to run.
 *
 * The second is flat nagging. Every due item was re-raised on a fixed four-hour
 * cadence forever, with no regard for how many times it had already been asked
 * and ignored. That is the same pathology fixed for watchers the night before:
 * a question nobody is answering asked at full volume indefinitely.
 *
 * The two fixes have to land together, because either alone makes the other
 * worse. Rotation without back-off would take five long-ignored items and put
 * them all back on a four-hour loop. Back-off without rotation would slow down
 * the six visible items while the starved five stayed invisible at any speed.
 *
 * Pure, and deliberately free of any store or clock, so it can be verified
 * without an app: see `scripts/verify-openitems.ts`.
 */
import type { OpenItem } from "../../shared/types.js";

/** How long a freshly raised decision sits before it is worth repeating. */
export const FIRST_RERAISE_MS = 4 * 60 * 60 * 1000;

/**
 * The longest gap back-off will ever stretch to. Two days: long enough that a
 * thoroughly ignored question stops being noise, short enough that it is still
 * a live question rather than a forgotten one.
 */
export const RERAISE_CEILING_MS = 48 * 60 * 60 * 1000;

/** At most this many outstanding items are ever quoted in one block. */
export const OPEN_ITEM_CAP = 6;

/**
 * At most this many are pushed at the user in a single re-raise. The cap on the
 * block is about prompt size; this one is about tone. Six decisions arriving at
 * once reads as a backlog dump and gets skimmed, which is how they got ignored
 * in the first place.
 */
export const RERAISE_BATCH = 2;

/**
 * How many times an item has been put in front of the user, counting the
 * original raise. Older items predate the field and are treated as raised once,
 * which is true: `raiseOpenItem` stamps `lastRaisedAt` on creation.
 */
export function timesRaised(item: OpenItem): number {
    return Math.max(1, item.timesRaised ?? 1);
}

/**
 * The gap before this item is worth repeating, doubling with each unanswered
 * asking and then holding flat at the ceiling.
 *
 * Doubling rather than a longer fixed gap because the signal is asymmetric: one
 * ignored asking might be a bad moment, five is an answer of sorts.
 */
export function reRaiseIntervalMs(item: OpenItem): number {
    const askings = timesRaised(item);
    const widened = FIRST_RERAISE_MS * 2 ** (askings - 1);
    return Math.min(RERAISE_CEILING_MS, widened);
}

/** When this item next deserves the user's attention. */
export function dueAt(item: OpenItem): number {
    return (item.lastRaisedAt ?? item.createdAt) + reRaiseIntervalMs(item);
}

export function isDue(item: OpenItem, now: number): boolean {
    return now >= dueAt(item);
}

/**
 * Every unsettled item, most neglected first.
 *
 * "Neglected" is time since it was last put in front of the user, not age. An
 * item raised an hour ago is not neglected however old it is, and a three-day
 * silence on something raised once is the strongest claim on attention there is.
 * Ties fall back to creation order so the ordering is total and stable.
 */
export function byNeglect(items: readonly OpenItem[]): OpenItem[] {
    return items
        .filter((item) => !item.resolved)
        .slice()
        .sort((a, b) => {
            const seen = (a.lastRaisedAt ?? a.createdAt) - (b.lastRaisedAt ?? b.createdAt);
            if (seen !== 0) return seen;
            const made = a.createdAt - b.createdAt;
            if (made !== 0) return made;
            // Two items filed in the same millisecond are common: a single
            // agent run files several at once. Falling through to the id keeps
            // the order total, so the visible set does not shuffle between
            // ticks for no reason the user could ever explain.
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
}

/**
 * The items worth quoting now: the most neglected, capped.
 *
 * Because the ordering is by last-raised and raising updates that, the cap
 * rotates rather than truncating. Every outstanding item reaches the front
 * eventually, which is the property `slice(-CAP)` did not have at any list
 * length above the cap.
 */
export function selectOutstanding(items: readonly OpenItem[], cap = OPEN_ITEM_CAP): OpenItem[] {
    return byNeglect(items).slice(0, Math.max(0, cap));
}

/**
 * The ones to push at the user on this tick: due, most neglected first, and no
 * more than a small handful.
 *
 * Only these should have their clock stamped. Stamping an item that was not
 * actually shown resets its silence to zero without anyone having seen it,
 * which is the starvation bug wearing a different hat.
 */
export function selectForReRaise(
    items: readonly OpenItem[],
    now: number,
    batch = RERAISE_BATCH,
): OpenItem[] {
    return byNeglect(items)
        .filter((item) => isDue(item, now))
        .slice(0, Math.max(0, batch));
}

/**
 * Record that an item was just shown. Returns a new item rather than mutating,
 * so callers inside a store update apply it deliberately.
 */
export function noteRaised(item: OpenItem, now: number): OpenItem {
    return { ...item, lastRaisedAt: now, timesRaised: timesRaised(item) + 1 };
}

/**
 * A plain-language note on how hard a decision has been chased, for the line
 * the user actually reads. Silent for the first couple of askings: saying
 * "asked twice" about something raised yesterday is pedantry, but saying it
 * about the fifth asking is the point.
 */
export function describeChasing(item: OpenItem): string {
    const askings = timesRaised(item);
    if (askings < 3) return "";
    if (reRaiseIntervalMs(item) >= RERAISE_CEILING_MS) {
        return `asked ${askings} times, now only every other day`;
    }
    return `asked ${askings} times`;
}

/**
 * What to do with the decisions quoted above.
 *
 * The provenance rule is here because of an exchange on 21 September. Orbit
 * raised the Fresno session-string question as a bare question, and Seshi came
 * back with "where did that question come from? I thought we answered that
 * question already right?". He was right: it had been settled off-system, and
 * the item was closed a turn later.
 *
 * Both turns were avoidable. The block above already carries where each item
 * came from and how long it has sat, because `openItemsBlock` puts it there;
 * Orbit simply had no instruction to repeat it, so it asked the question naked
 * and made him do the archaeology. A decision filed by an agent six days ago is
 * unrecognisable without its origin, and an unrecognisable question reads as a
 * non sequitur rather than as a chase. Saying "from the 11 Sep wrap-up" costs
 * six words and is the whole difference between him answering and him asking
 * what this is.
 *
 * It matters most for exactly the items back-off has stretched furthest, which
 * are the oldest and the least recognisable, so the rule is unconditional
 * rather than reserved for items over some age.
 */
export const OPEN_ITEM_GUIDANCE = [
    "Raise the most pressing one when it is a sensible moment: one line, with quick",
    "replies, rather than all of them at once. Say where and when it came from in the",
    "same line. These were filed days ago, often by an agent he never saw, and a",
    "question he cannot place reads as a non sequitur rather than as a chase. If he",
    "says it is already settled, believe him and close it. Call orbit_resolve_open_item",
    "as soon as the user answers, declines, or the question stops mattering.",
].join("\n");
