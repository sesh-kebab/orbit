/**
 * Finding the thing a model meant when it hands back an id.
 *
 * Every durable object Orbit keeps, an open item, a ledger entry, a proposal, a
 * memory, is keyed by a `randomUUID()`: thirty-six characters, of which the
 * first eight carry all the distinguishing power anyone actually reads. Those
 * ids are printed into the prompt in full and then handed back by a model that
 * has been reading and writing them as prose.
 *
 * On 18 September 2026 that produced a specific, expensive failure. Six calls
 * to `orbit_resolve_open_item` were made with eight-character prefixes, and all
 * six were refused with "No outstanding item with that id":
 *
 *   086e5f9e  6b88fb7a  c7c84b3c  ab73f442  2630fba0  10fa1e75
 *
 * Every one of those prefixes was unique across the whole list. Nothing was
 * ambiguous and nothing was missing. The store simply compared with `===` and
 * a prefix is not equal to a uuid.
 *
 * The consequence is not one failed call. `orbit_raise_open_item` takes free
 * text and always succeeds; `orbit_resolve_open_item` takes a uuid and could
 * not. An asymmetry like that has exactly one outcome over weeks, and the
 * outcome was sitting in the store tonight: sixty-one outstanding decisions,
 * several of them settled days ago, the oldest seven days old. A queue that can
 * be added to and not subtracted from is a queue that grows, and because the
 * chase loops wake on whatever is due, a queue that grows is a channel that
 * never stops talking.
 *
 * So: match exactly if an exact match exists, otherwise accept an unambiguous
 * prefix, and when it genuinely is ambiguous say which ones it could have been
 * rather than failing blind.
 *
 * Pure, and free of any store, so it can be verified without an app: see
 * `scripts/verify-ids.ts`.
 */

/** The smallest prefix worth honouring. */
export const MIN_PREFIX = 4;

export type IdLookup<T> =
    | { status: "ok"; item: T }
    | { status: "none" }
    | { status: "ambiguous"; candidates: string[] };

/**
 * Strip what a model wraps an id in on its way back out: whitespace, the
 * backticks it uses for code, the quotes it uses for strings, and the case it
 * sometimes changes. Ids themselves are lowercase hex and hyphens, so none of
 * this can collide with a real character of one.
 */
function normalise(raw: string): string {
    return raw
        .trim()
        .replace(/^[`'"<]+|[`'">]+$/g, "")
        .trim()
        .toLowerCase();
}

/**
 * The item a caller meant.
 *
 * Exact match wins outright, and is checked first for a reason: an id is always
 * a prefix of itself, so without this an exact hit could be reported as
 * ambiguous against some longer id it happens to start. That cannot occur with
 * fixed-length uuids, but this should not depend on that staying true.
 */
export function findById<T extends { id: string }>(
    items: readonly T[],
    given: string,
): IdLookup<T> {
    const needle = normalise(given ?? "");
    if (!needle) return { status: "none" };

    const exact = items.find((item) => item.id.toLowerCase() === needle);
    if (exact) return { status: "ok", item: exact };

    if (needle.length < MIN_PREFIX) return { status: "none" };

    const matches = items.filter((item) => item.id.toLowerCase().startsWith(needle));
    if (matches.length === 1) return { status: "ok", item: matches[0] };
    if (matches.length > 1) {
        return { status: "ambiguous", candidates: matches.map((item) => item.id) };
    }
    return { status: "none" };
}

/**
 * The same, by index, for callers that have to mutate in place inside a store
 * update rather than hold a reference.
 */
export function findIndexById<T extends { id: string }>(
    items: readonly T[],
    given: string,
): number {
    const found = findById(items, given);
    if (found.status !== "ok") return -1;
    return items.indexOf(found.item);
}

/**
 * What to tell a caller that missed, phrased so the next attempt can succeed.
 *
 * An ambiguous miss names the candidates, because the caller usually has enough
 * context to pick and would otherwise retry with the same prefix forever.
 */
export function describeMiss<T>(lookup: IdLookup<T>, noun: string): string {
    if (lookup.status === "ambiguous") {
        return `That id matches ${lookup.candidates.length} ${noun}s: ${lookup.candidates.join(
            ", ",
        )}. Use more of the id.`;
    }
    return `No outstanding ${noun} with that id.`;
}
