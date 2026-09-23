/**
 * Which checkout is actually running?
 *
 * Orbit writes its own code. The nightly reflection ends by committing, merging
 * and rebuilding, and it learns where to do that from a sentence in a task
 * description written by a human. Nothing has ever checked that sentence
 * against the process doing the reading.
 *
 * On 20 August that cost a night's work. The activity ledger, about 1200 lines,
 * was built, tested and pushed to `ai-desktop-companion` after Orbit had said
 * it was working "in the Orbit repo". The running process was, and is, `orbit`.
 * The code was correct, the tests passed, the merge succeeded, and none of it
 * ever executed. It was caught the next night by a diff, by luck.
 *
 * The decoy is still on disk today, a month later, beside the live checkout and
 * indistinguishable from it to anything that is just reading paths. A memory
 * has said since 20 August which one is dead. A memory is a belief, though, and
 * a belief is exactly what was wrong in the first place: the instruction that
 * misdirected that night was also confidently asserted and also wrong.
 *
 * So this resolves it rather than asserting it. `app.getAppPath()` is where the
 * running process was loaded from, which is ground truth and cannot disagree
 * with itself, and the sibling checkouts are named explicitly so that a
 * plausible-looking wrong path is recognisable as the wrong path rather than
 * merely absent from the instructions.
 *
 * The rules are pure and take their directory listing as an argument, so they
 * can be checked without a filesystem.
 */
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface CheckoutFacts {
    /** Where the running process was loaded from. Ground truth. */
    root: string;
    /** Sibling checkouts that could be mistaken for it, nearest first. */
    decoys: string[];
}

/**
 * Sibling directories that are themselves git checkouts.
 *
 * Any sibling repo qualifies, not just ones with a similar name. The August
 * failure went to `ai-desktop-companion` from a checkout called `orbit`, which
 * a name-similarity test would have waved through: the two names have nothing
 * in common. What made it reachable was proximity, so proximity is the test.
 */
export function findDecoys(root: string, siblings: readonly { name: string; isRepo: boolean }[]): string[] {
    const here = basename(root);
    const parent = dirname(root);
    return siblings
        .filter((sibling) => sibling.isRepo && sibling.name !== here)
        .map((sibling) => join(parent, sibling.name))
        .sort();
}

/**
 * The block handed to an agent that might write code.
 *
 * Phrased as an instruction about precedence rather than a fact about a path,
 * because the failure mode is not ignorance of the right path. It is being
 * given a wrong one with confidence, and the agent needs to know which source
 * wins when the two disagree.
 */
export function checkoutBlock(facts: CheckoutFacts): string {
    const lines = [
        "<running_checkout>",
        `The Orbit process you are running inside was loaded from: ${facts.root}`,
        "That path is resolved from the running process, not copied from an instruction.",
        "If anything in your task names a different path for Orbit's own source, this one wins:",
        "say so in your report rather than committing to the other. Code committed to a",
        "checkout no process is running is work that will never execute, and it fails silently:",
        "it builds, it tests green, it merges, and nothing changes.",
    ];
    if (facts.decoys.length > 0) {
        lines.push(
            "",
            "Other git checkouts sit beside it and are not what is running:",
            ...facts.decoys.map((path) => `  ${path}`),
        );
    }
    lines.push("</running_checkout>");
    return lines.join("\n");
}

/**
 * Read the siblings off disk. Every failure becomes "no decoys known", which
 * degrades to simply naming the running checkout: still better than nothing,
 * and never a reason for a watcher to fail to dispatch.
 */
export function collectCheckoutFacts(root: string): CheckoutFacts {
    try {
        const parent = dirname(root);
        const siblings = readdirSync(parent, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
            .map((entry) => ({ name: entry.name, isRepo: existsSync(join(parent, entry.name, ".git")) }));
        return { root, decoys: findDecoys(root, siblings) };
    } catch {
        return { root, decoys: [] };
    }
}

/**
 * Does this task plausibly involve writing code?
 *
 * The block is worth several lines of prompt and most watchers never touch a
 * repo: a lunch reminder does not need to be told where Orbit's source lives.
 * Deliberately generous, because the cost of including it needlessly is a few
 * wasted lines and the cost of omitting it is a night of work in a dead repo.
 */
const CODE_WORDS = [
    "commit",
    "merge",
    "branch",
    "repo",
    "checkout",
    "build",
    "ship",
    "rebuild",
    "orbit's own source",
    "self-reflection",
    "pull request",
];

export function taskTouchesCode(task: string): boolean {
    const lower = task.toLowerCase();
    return CODE_WORDS.some((word) => lower.includes(word));
}
