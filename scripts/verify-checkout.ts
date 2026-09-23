/**
 * Verification for the running-checkout block: which repo Orbit's own
 * self-improvement work is allowed to land in.
 *
 *   npm run verify:checkout
 *
 * Built from the failure of 20 August 2026, when roughly 1200 lines of a
 * working, tested, merged activity ledger were committed to
 * `ai-desktop-companion` while the running process was `orbit`. The code never
 * executed. Nothing errored, because nothing was wrong except the destination.
 *
 * Pure, so it needs no app, no clock and no filesystem.
 */
import { checkoutBlock, findDecoys, taskTouchesCode } from "../src/main/orchestrator/checkout.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: unknown): void {
    if (condition) {
        passed += 1;
        return;
    }
    failures.push(`${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

// MARK: - The night of 20 August, as it sat on disk

const ROOT = "/Users/seshic/dev/github/sesh-kebab/orbit";
const DEAD = "/Users/seshic/dev/github/sesh-kebab/ai-desktop-companion";

const siblings = [
    { name: "orbit", isRepo: true },
    { name: "ai-desktop-companion", isRepo: true },
    { name: "illustrated-map-gen", isRepo: true },
    { name: "notes", isRepo: false },
];

const decoys = findDecoys(ROOT, siblings);
check("the repo that took the work is named as a decoy", decoys.includes(DEAD));
check("the running checkout is never listed against itself", !decoys.includes(ROOT));
check("a plain directory is not a decoy", !decoys.some((path) => path.endsWith("/notes")));
check("every decoy is an absolute path", decoys.every((path) => path.startsWith("/")));

/**
 * The failure went from a checkout called `orbit` to one called
 * `ai-desktop-companion`. The two names share nothing, so a name-similarity
 * test would have waved it through. Proximity is the test, and this asserts it.
 */
check(
    "a decoy with no name in common is still caught",
    decoys.includes(DEAD) && !"ai-desktop-companion".includes("orbit"),
);

check("no siblings means no decoys", findDecoys(ROOT, [{ name: "orbit", isRepo: true }]).length === 0);

// MARK: - What the block says

const block = checkoutBlock({ root: ROOT, decoys });
check("it states where the process was loaded from", block.includes(ROOT));
check("it names the dead repo explicitly", block.includes(DEAD));
check("it says the resolved path wins over the instruction", block.toLowerCase().includes("this one wins"));
check("it says why that matters", block.includes("never execute"));
check("it is a tagged block", block.startsWith("<running_checkout>") && block.endsWith("</running_checkout>"));

const bare = checkoutBlock({ root: ROOT, decoys: [] });
check("with no decoys it still names the running checkout", bare.includes(ROOT));
check("with no decoys it does not open an empty list", !bare.includes("Other git checkouts"));

// MARK: - Who gets told

check("the nightly self-reflection gets it", taskTouchesCode("Run a holistic self-reflection, then merge to main."));
check("a task that only says 'ship' gets it", taskTouchesCode("Ship the improvements you find."));
check("a task mentioning a branch gets it", taskTouchesCode("Check what is on unmerged branches."));
check("a lunch reminder does not", !taskTouchesCode("Find the user a clear hour for lunch today."));
check(
    "a calendar scan does not",
    !taskTouchesCode("List the user's calendar meetings for the rest of today and reply with JSON."),
);
check("matching ignores case", taskTouchesCode("COMMIT the result"));

// MARK: - Report

if (failures.length > 0) {
    console.error(`checkout verification FAILED: ${failures.length} of ${passed + failures.length}`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
}
console.log(`checkout verification passed: ${passed} checks`);
