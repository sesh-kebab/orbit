/**
 * Verification for id resolution: finding the thing a model meant.
 *
 *   npm run verify:ids
 *
 * Built from the failure of 18 September 2026, reproduced below with the real
 * ids. Six calls to `orbit_resolve_open_item` were refused that night, every
 * one of them carrying an eight-character prefix that was unique across the
 * entire list of sixty-one outstanding items. The store compared with `===`.
 *
 * Pure, so it needs no app and no clock.
 */
import { MIN_PREFIX, describeMiss, findById, findIndexById } from "../src/main/orchestrator/ids.js";

let passed = 0;
const failures: string[] = [];

function check(what: string, ok: boolean): void {
    if (ok) passed += 1;
    else failures.push(what);
}

interface Item {
    id: string;
    text: string;
}

// MARK: - The six that failed on 18 September

/** Real ids from the open-item store, as they stood that night. */
const theSix: Item[] = [
    { id: "086e5f9e-aa60-423e-83cb-21daf30d8e25", text: "Fresno bugs 64150443 and 64071299" },
    { id: "6b88fb7a-1f4c-4a2e-9d31-2b0e7c4a5d61", text: "Six placeholders in section 4" },
    { id: "c7c84b3c-55a1-49f7-8e2d-90b3ff1ac742", text: "Fresno funding direction" },
    { id: "ab73f442-3d09-4c18-bb57-6e1a2d4f8093", text: "Sustained FE level for GA" },
    { id: "2630fba0-9c72-4bd6-a1e8-7f45c0b2e316", text: "Two loose ends outside section 4" },
    { id: "10fa1e75-6ba3-42de-9c04-5d81ef73a920", text: "Fresno GA ask in 4.5" },
];

/** Some unrelated neighbours, so the list is not trivially unambiguous. */
const alongside: Item[] = [
    { id: "df991cb5-0913-47ae-9113-7dd6474bc4b8", text: "Orbit now goes quiet" },
    { id: "dd1dcd05-c6ef-4fdb-ae37-e06a81fef929", text: "Retire the Bastion watcher" },
    { id: "d353a0e3-2211-4a77-b3c5-0e9d6f8a1c24", text: "Roadmap doc naming" },
];

const store = [...theSix, ...alongside];

for (const item of theSix) {
    const prefix = item.id.slice(0, 8);
    const found = findById(store, prefix);
    check(
        `${prefix} resolves, as it should have on 18 Sep`,
        found.status === "ok" && found.item.id === item.id,
    );
}

check(
    "and the full id still resolves, which is the path that did work",
    findById(store, theSix[0].id).status === "ok",
);

// MARK: - Exactness beats prefix

const nested: Item[] = [
    { id: "abcd", text: "the short one" },
    { id: "abcdef", text: "the long one" },
];

const exact = findById(nested, "abcd");
check(
    "an exact match wins even when it is a prefix of another id",
    exact.status === "ok" && exact.item.text === "the short one",
);
check(
    "and the longer one is still reachable by its own id",
    (() => {
        const hit = findById(nested, "abcdef");
        return hit.status === "ok" && hit.item.text === "the long one";
    })(),
);

// MARK: - Ambiguity is reported, not guessed

const twins: Item[] = [
    { id: "dd1dcd05-c6ef-4fdb-ae37-e06a81fef929", text: "one" },
    { id: "dd1dcd05-0000-4000-8000-000000000000", text: "two" },
];
const clash = findById(twins, "dd1dcd05");
check("two matches is ambiguous, not a coin toss", clash.status === "ambiguous");
check(
    "and the error names both, so the next attempt can succeed",
    (() => {
        const message = describeMiss(clash, "item");
        return message.includes(twins[0].id) && message.includes(twins[1].id);
    })(),
);
check(
    "a longer prefix disambiguates them",
    findById(twins, "dd1dcd05-c6ef").status === "ok",
);

// MARK: - Misses

check("an id for nothing in the list misses", findById(store, "99999999").status === "none");
check("an empty string misses", findById(store, "").status === "none");
check("whitespace alone misses", findById(store, "   ").status === "none");
check(
    `a prefix shorter than ${MIN_PREFIX} is refused rather than matched loosely`,
    findById(store, "0").status === "none" && findById(store, "08").status === "none",
);
check(
    "a miss is described plainly",
    describeMiss(findById(store, "99999999"), "item") === "No outstanding item with that id.",
);

// MARK: - What a model wraps an id in

const wrapped = theSix[0].id.slice(0, 8);
for (const [label, given] of [
    ["surrounded by whitespace", `  ${wrapped}\n`],
    ["in a code span", `\`${wrapped}\``],
    ["in single quotes", `'${wrapped}'`],
    ["in double quotes", `"${wrapped}"`],
    ["in angle brackets", `<${wrapped}>`],
    ["shouted in upper case", wrapped.toUpperCase()],
] as const) {
    const found = findById(store, given);
    check(`${label} still resolves`, found.status === "ok" && found.item.id === theSix[0].id);
}

// MARK: - Index form agrees with the reference form

check("findIndexById agrees on a hit", findIndexById(store, wrapped) === 0);
check("findIndexById returns -1 on a miss", findIndexById(store, "99999999") === -1);
check("findIndexById returns -1 on ambiguity", findIndexById(twins, "dd1dcd05") === -1);

// MARK: - An empty store

check("nothing matches in an empty list", findById([] as Item[], wrapped).status === "none");

// MARK: - Report

console.log(
    `\nReplaying 18 Sep 2026: ${theSix.length} open items could not be closed by prefix.` +
        `\n  Under prefix resolution: all ${theSix.length} resolve, ambiguity refused rather than guessed.`,
);

console.log(`\n${passed} checks passed.`);
if (failures.length > 0) {
    console.error(`${failures.length} failed:`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exit(1);
}
console.log("Id resolution verified.\n");
