/**
 * Verification for open-item selection and re-raise back-off.
 *
 *   npm run verify:openitems
 *
 * Built from the live state of 12 September 2026, which is reproduced in the
 * fixture below: eleven outstanding decisions, of which the five oldest were
 * unreachable because selection took `slice(-6)` of a list appended in creation
 * order. Two of those five had never been raised a second time. The oldest was
 * a BAMI approval that had been waiting thirty-seven hours.
 *
 * Pure, so it needs no app and no clock.
 */
import {
    FIRST_RERAISE_MS,
    OPEN_ITEM_CAP,
    RERAISE_BATCH,
    RERAISE_CEILING_MS,
    byNeglect,
    describeChasing,
    dueAt,
    isDue,
    noteRaised,
    reRaiseIntervalMs,
    selectForReRaise,
    selectOutstanding,
    timesRaised,
} from "../src/main/orchestrator/openItems.js";
import type { OpenItem } from "../src/shared/types.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: unknown): void {
    if (condition) {
        passed += 1;
        return;
    }
    failures.push(`${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

const HOUR = 60 * 60 * 1000;
/** "Now" for the whole suite: 12 Sep 2026, 21:30 local, the night this was found. */
const NOW = Date.UTC(2026, 8, 13, 4, 30);

function item(partial: Partial<OpenItem> & { id: string; createdAt: number }): OpenItem {
    return {
        text: `decision ${partial.id}`,
        resolved: false,
        lastRaisedAt: partial.createdAt,
        ...partial,
    } as OpenItem;
}

const ago = (hours: number): number => NOW - hours * HOUR;

// MARK: - The live fixture, in creation order, exactly as it was on disk

const live: OpenItem[] = [
    item({ id: "bami", createdAt: ago(37), lastRaisedAt: ago(32), text: "BAMI request 646a71cb" }),
    item({ id: "navrail", createdAt: ago(36), lastRaisedAt: ago(28) }),
    item({ id: "demogif", createdAt: ago(36), lastRaisedAt: ago(28) }),
    item({ id: "bug", createdAt: ago(31), lastRaisedAt: ago(31) }), // never re-raised
    item({ id: "agreement", createdAt: ago(31), lastRaisedAt: ago(31) }), // never re-raised
    item({ id: "dandelion", createdAt: ago(30) }),
    item({ id: "fresno", createdAt: ago(29) }),
    item({ id: "charter", createdAt: ago(24) }),
    item({ id: "oneonones", createdAt: ago(24) }),
    item({ id: "repos", createdAt: ago(24) }),
    item({ id: "uhf", createdAt: ago(13) }),
];

check("the fixture is the eleven that were really outstanding", live.length === 11);

// MARK: - Starvation

const oldWay = live.filter((i) => !i.resolved).slice(-OPEN_ITEM_CAP);
check(
    "the old selection really did hide the BAMI approval",
    !oldWay.some((i) => i.id === "bami"),
    oldWay.map((i) => i.id),
);

const selected = selectOutstanding(live);
check("selection still respects the cap", selected.length === OPEN_ITEM_CAP, selected.length);
check(
    "the longest-unseen item is now first",
    selected[0]?.id === "bami",
    selected.map((i) => i.id),
);
check(
    "the two never-re-raised items are now reachable",
    selected.some((i) => i.id === "bug") && selected.some((i) => i.id === "agreement"),
    selected.map((i) => i.id),
);
check(
    "the newest item yields to five more neglected ones",
    !selected.some((i) => i.id === "uhf"),
    selected.map((i) => i.id),
);

// Rotation: every outstanding item reaches the front if the visible ones are
// raised in turn. This is the property the blind tail did not have at all.
{
    let pool = live.slice();
    const seen = new Set<string>();
    for (let tick = 0; tick < 20 && seen.size < live.length; tick += 1) {
        const shown = selectOutstanding(pool);
        for (const i of shown) seen.add(i.id);
        const ids = new Set(shown.map((i) => i.id));
        pool = pool.map((i) => (ids.has(i.id) ? noteRaised(i, NOW + tick) : i));
    }
    check("every outstanding item reaches the front eventually", seen.size === live.length, {
        seen: seen.size,
        of: live.length,
    });
}

{
    // The old code could not do that at any number of ticks, because the tail
    // never moved. Proven rather than asserted.
    let pool = live.slice();
    const seen = new Set<string>();
    for (let tick = 0; tick < 20; tick += 1) {
        const shown = pool.filter((i) => !i.resolved).slice(-OPEN_ITEM_CAP);
        for (const i of shown) seen.add(i.id);
        const ids = new Set(shown.map((i) => i.id));
        pool = pool.map((i) => (ids.has(i.id) ? { ...i, lastRaisedAt: NOW + tick } : i));
    }
    check("the old tail starved five items no matter how long it ran", seen.size === 6, seen.size);
}

check("resolved items are never selected", !selectOutstanding([
    ...live,
    item({ id: "done", createdAt: ago(99), resolved: true }),
]).some((i) => i.id === "done"));

check("an empty list selects nothing", selectOutstanding([]).length === 0);
check("a cap of zero selects nothing", selectOutstanding(live, 0).length === 0);
check(
    "a list shorter than the cap is returned whole",
    selectOutstanding(live.slice(0, 3)).length === 3,
);
check(
    "ordering is total, so equal timestamps do not shuffle",
    byNeglect(live).map((i) => i.id).join() === byNeglect(live.slice().reverse()).map((i) => i.id).join(),
);

// MARK: - Back-off

const fresh = item({ id: "fresh", createdAt: NOW });
check("a first asking waits the base gap", reRaiseIntervalMs(fresh) === FIRST_RERAISE_MS);
check("an item with no count reads as asked once", timesRaised(fresh) === 1);
check(
    "a legacy item missing the field is not treated as never asked",
    timesRaised({ ...fresh, timesRaised: undefined }) === 1,
);

const intervals = [1, 2, 3, 4, 5, 9].map((n) =>
    reRaiseIntervalMs({ ...fresh, timesRaised: n }),
);
check("each unanswered asking doubles the gap", intervals[1] === intervals[0] * 2, intervals);
check("and again", intervals[2] === intervals[1] * 2, intervals);
check("the gap never exceeds the ceiling", intervals.every((ms) => ms <= RERAISE_CEILING_MS), intervals);
check("a thoroughly ignored item sits at the ceiling", intervals[5] === RERAISE_CEILING_MS);
check(
    "back-off is monotonic, never narrowing",
    intervals.every((ms, n) => n === 0 || ms >= intervals[n - 1]),
    intervals,
);

check("an item raised just now is not due", !isDue(fresh, NOW));
check("it is not due a minute before its gap elapses", !isDue(fresh, NOW + FIRST_RERAISE_MS - 1));
check("it is due the moment the gap elapses", isDue(fresh, NOW + FIRST_RERAISE_MS));
check(
    "an item never raised falls back to its creation time",
    dueAt({ ...fresh, lastRaisedAt: undefined }) === NOW + FIRST_RERAISE_MS,
);

const chased = noteRaised(fresh, NOW + FIRST_RERAISE_MS);
check("raising an item records the time", chased.lastRaisedAt === NOW + FIRST_RERAISE_MS);
check("raising an item counts the asking", timesRaised(chased) === 2);
check("raising does not mutate the original", timesRaised(fresh) === 1);
check(
    "a twice-asked item then waits longer than a once-asked one",
    reRaiseIntervalMs(chased) > reRaiseIntervalMs(fresh),
);
check("an ignored item is not due on the old flat cadence", !isDue(chased, NOW + 2 * FIRST_RERAISE_MS - 1));

// MARK: - The batch

const batch = selectForReRaise(live, NOW);
check("the batch is capped for tone, not just for size", batch.length === RERAISE_BATCH, batch.length);
check(
    "the batch takes the most neglected first",
    batch[0]?.id === "bami",
    batch.map((i) => i.id),
);
check("every item in the batch is actually due", batch.every((i) => isDue(i, NOW)));
check(
    "nothing is pushed when nothing is due",
    selectForReRaise([fresh], NOW).length === 0,
);
check(
    "an eleven-item backlog is not dumped at once",
    selectForReRaise(live, NOW).length < live.length,
);

// Stamping only what was shown: the rest keep their silence.
{
    const ids = new Set(batch.map((i) => i.id));
    const after = live.map((i) => (ids.has(i.id) ? noteRaised(i, NOW) : i));
    const untouched = after.filter((i) => !ids.has(i.id));
    check(
        "items left out of the batch keep their clock",
        untouched.every((i) => i.lastRaisedAt === live.find((o) => o.id === i.id)?.lastRaisedAt),
    );
    const next = selectForReRaise(after, NOW);
    check(
        "so the next tick moves on to the ones that waited",
        next.every((i) => !ids.has(i.id)),
        next.map((i) => i.id),
    );
    const expected = byNeglect(live)[RERAISE_BATCH]?.id;
    check("and they are the next-most neglected", next[0]?.id === expected, {
        got: next.map((i) => i.id),
        expected,
    });
}

// Drain: an ignored backlog does get through, and does slow down.
{
    let pool = live.slice();
    let clock = NOW;
    let pushes = 0;
    const seen = new Set<string>();
    for (let tick = 0; tick < 200; tick += 1) {
        const due = selectForReRaise(pool, clock);
        if (due.length > 0) {
            pushes += 1;
            for (const i of due) seen.add(i.id);
            const ids = new Set(due.map((i) => i.id));
            pool = pool.map((i) => (ids.has(i.id) ? noteRaised(i, clock) : i));
        }
        clock += HOUR;
    }
    check("over eight days every decision is asked at least once", seen.size === live.length, {
        seen: seen.size,
    });
    const flat = Math.floor((200 * HOUR) / FIRST_RERAISE_MS) * live.length;
    check("and far less often than the old flat cadence would have", pushes < flat, { pushes, flat });
    check(
        "by the end the untouched ones are at or near the ceiling",
        pool.every((i) => reRaiseIntervalMs(i) > FIRST_RERAISE_MS),
    );
}

// MARK: - What the user reads

check("a first asking is not labelled", describeChasing(fresh) === "");
check("nor a second", describeChasing({ ...fresh, timesRaised: 2 }) === "");
check("a third says so", describeChasing({ ...fresh, timesRaised: 3 }).includes("3 times"));
check(
    "a thoroughly ignored one says it has slowed down",
    describeChasing({ ...fresh, timesRaised: 9 }).includes("every other day"),
);
check(
    "the label stays short enough for one line",
    describeChasing({ ...fresh, timesRaised: 9 }).length < 60,
);

// MARK: - Report

const line = selectOutstanding(live).map((i) => i.id).join(", ");
console.log(
    `\nOn the live 12 Sep backlog of ${live.length}: the old tail showed [${oldWay
        .map((i) => i.id)
        .join(", ")}] and could never show the other five.` +
        `\n  Now shows [${line}], most neglected first.` +
        `\n  Re-raise pushes ${RERAISE_BATCH} at a time, widening ${FIRST_RERAISE_MS / HOUR}h to a ${
            RERAISE_CEILING_MS / HOUR
        }h ceiling.`,
);

console.log(`\n${passed} checks passed.`);
if (failures.length > 0) {
    console.error(`${failures.length} failed:`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exit(1);
}
console.log("Open-item selection and back-off verified.\n");
