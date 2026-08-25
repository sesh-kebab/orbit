/**
 * Verification for the activity ledger and for the artifact-path rewriting that
 * makes an agent's report clickable.
 *
 *   npm run verify:activity
 *
 * The ledger's store is exercised against a throwaway directory, so this never
 * touches the real one under userData. Everything else under test is pure and
 * takes its clock and its filesystem as arguments.
 */
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    ACTIVITY_FILE,
    CHASE_AFTER_MS,
    CHASE_CAP,
    CONTEXT_CAP,
    activityContextBlock,
    chaseableActivity,
    filterActivity,
    makeActivityEntry,
    readActivityLedger,
    writeActivityLedger,
} from "../src/main/activity.js";
import { artifactPathsIn, artifactSearchDirs, resolveArtifactPaths } from "../src/main/orchestrator/artifacts.js";
import type { ActivityEntry } from "../src/shared/types.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: unknown): void {
    if (condition) {
        passed += 1;
        return;
    }
    failures.push(`${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

const root = mkdtempSync(join(tmpdir(), "orbit-activity-"));
const day = 24 * 60 * 60 * 1000;
const now = Date.now();

// MARK: - Persistence round-trip

const store = join(root, "userData");
mkdirSync(store, { recursive: true });

check("a missing ledger reads as empty", readActivityLedger(store).length === 0);

const written: ActivityEntry[] = [
    makeActivityEntry(
        {
            kind: "artifact_written",
            description: "Learning series plan",
            location: "/tmp/learning-series-plan.md",
            request: "write me a plan for the learning series",
            agentId: "agent-1",
            agentTitle: "Draft learning plan",
            status: "delivered",
        },
        now - day,
    ),
    makeActivityEntry(
        {
            kind: "draft_composed",
            description: "Reply to the finance thread",
            request: "draft a reply to finance",
            status: "awaiting_seshi",
        },
        now - 5 * day,
    ),
];
writeActivityLedger(store, written);

const roundTripped = readActivityLedger(store);
check("everything written comes back", roundTripped.length === 2, roundTripped.length);
check(
    "every field survives the round trip",
    JSON.stringify(roundTripped) === JSON.stringify(written),
    { roundTripped, written },
);
check(
    "the day is the entry's own, not today's",
    roundTripped[1]!.day !== roundTripped[0]!.day,
    roundTripped.map((entry) => entry.day),
);

// A second write must replace, not append.
writeActivityLedger(store, [...roundTripped, makeActivityEntry({ kind: "query_run", description: "Checked the build logs" }, now)]);
check("a re-save keeps one copy of each entry", readActivityLedger(store).length === 3);

// Damage is set aside rather than silently overwritten by the next save. The
// warning this prints is the point of the check, not a failure.
writeFileSync(join(store, ACTIVITY_FILE), "{ not json", "utf8");
check("a corrupt ledger reads as empty", readActivityLedger(store).length === 0);
check(
    "a corrupt ledger is set aside, not destroyed",
    readdirSync(store).some((name) => name.startsWith(`${ACTIVITY_FILE}.corrupt-`)),
    readdirSync(store),
);

// An entry from an older build, missing fields this one adds, must still load.
writeFileSync(
    join(store, ACTIVITY_FILE),
    JSON.stringify([
        { id: "old-1", at: now - 2 * day, description: "Something from before" },
        { id: "junk", at: now, description: "" },
    ]),
    "utf8",
);
const repaired = readActivityLedger(store);
check("an older entry is repaired rather than dropped", repaired.length === 1, repaired);
check("a repaired entry gets a day", /^\d{4}-\d{2}-\d{2}$/.test(repaired[0]?.day ?? ""), repaired[0]);
check("a description-less entry is dropped", !repaired.some((entry) => entry.id === "junk"), repaired);

// MARK: - The three-day chase threshold

function aged(status: ActivityEntry["status"], ageDays: number, extra: Partial<ActivityEntry> = {}): ActivityEntry {
    return { ...makeActivityEntry({ kind: "other", description: `${status} ${ageDays}d`, status }, now - ageDays * day), ...extra };
}

check("nothing is chased before three days", chaseableActivity([aged("awaiting_seshi", 2.9)], now).length === 0);
check("awaiting_seshi is chased after three days", chaseableActivity([aged("awaiting_seshi", 3.1)], now).length === 1);
check("stalled is chased after three days", chaseableActivity([aged("stalled", 4)], now).length === 1);
check(
    "finished work is never chased",
    chaseableActivity([aged("delivered", 30), aged("done", 30), aged("abandoned", 30)], now).length === 0,
);
check("exactly three days is due", chaseableActivity([aged("stalled", 0, { at: now - CHASE_AFTER_MS })], now).length === 1);

// The cap, and the back-off that stops a chase becoming an alarm clock.
const many = Array.from({ length: 10 }, (_, i) => aged("awaiting_seshi", 5 + i));
check("no more than the cap is chased at once", chaseableActivity(many, now).length === CHASE_CAP, chaseableActivity(many, now).length);
check(
    "the stalest are chased first",
    chaseableActivity(many, now)[0]!.at === Math.min(...many.map((entry) => entry.at)),
);

const chasedOnce = aged("awaiting_seshi", 10, { lastChasedAt: now - 4 * day, chaseCount: 1 });
check("a chased entry waits twice as long the next time", chaseableActivity([chasedOnce], now).length === 0);
check(
    "and is chased again once that longer wait is up",
    chaseableActivity([{ ...chasedOnce, lastChasedAt: now - 7 * day }], now).length === 1,
);

// MARK: - Filtering

const mixed = [
    makeActivityEntry({ kind: "artifact_written", description: "A", status: "delivered" }, new Date(2026, 7, 1, 9).getTime()),
    makeActivityEntry({ kind: "draft_composed", description: "B", status: "awaiting_seshi" }, new Date(2026, 7, 5, 9).getTime()),
    makeActivityEntry({ kind: "artifact_written", description: "C", status: "delivered" }, new Date(2026, 7, 9, 9).getTime()),
];
check("filters by kind", filterActivity(mixed, { kind: "draft_composed" }).length === 1);
check("filters by status", filterActivity(mixed, { status: "delivered" }).length === 2);
check("filters by date range", filterActivity(mixed, { from: "2026-08-04", to: "2026-08-06" }).length === 1);
check("most recent first", filterActivity(mixed)[0]?.description === "C", filterActivity(mixed)[0]);
check("respects a limit", filterActivity(mixed, { limit: 1 }).length === 1);
check("caps a silly limit", filterActivity(mixed, { limit: 5000 }).length === 3);

// MARK: - The context block, and its cap

check("an empty ledger injects nothing", activityContextBlock([], now) === undefined);

const big: ActivityEntry[] = [
    // Forty delivered entries, newest last, plus some old unfinished ones that
    // must still surface however far down the list they are.
    ...Array.from({ length: 40 }, (_, i) => aged("delivered", 40 - i)),
    aged("awaiting_seshi", 90, { description: "an ancient unanswered thing" }),
    aged("stalled", 120, { description: "an ancient stuck thing" }),
];
const block = activityContextBlock(big, now)!;
const lines = block.split("\n").filter((text) => text.startsWith("- "));
check("the context block is capped", lines.length <= CONTEXT_CAP, lines.length);
check("the block does not quote the whole ledger", lines.length < big.length, lines.length);
check("it says how many were left out", block.includes("older entries not shown"), block);
check("old unfinished work still surfaces", block.includes("an ancient unanswered thing"), block);
check("so does old stalled work", block.includes("an ancient stuck thing"), block);
check("the newest delivered work is there", block.includes("delivered 1d"), block);
check("entries carry their id so they can be updated", lines.every((text) => text.includes("id=")));

// MARK: - Resolving bare file names in a report

const cwd = join(root, "agent-cwd");
const files = join(root, "session", "files");
mkdirSync(cwd, { recursive: true });
mkdirSync(files, { recursive: true });
writeFileSync(join(cwd, "learning-series-plan.md"), "plan\n", "utf8");
writeFileSync(join(files, "budget.csv"), "a,b\n", "utf8");
const dirs = [cwd, files];

const rewritten = resolveArtifactPaths("File written: learning-series-plan.md — have a look.", dirs);
check(
    "a bare name that exists becomes an absolute path",
    rewritten.includes(join(cwd, "learning-series-plan.md")),
    rewritten,
);
check("the rest of the sentence is untouched", rewritten.endsWith("— have a look."), rewritten);

check(
    "the session files directory is searched too",
    resolveArtifactPaths("I put the numbers in budget.csv.", dirs).includes(join(files, "budget.csv")),
);

// The negative case: nothing that is not really there is ever rewritten.
const missing = "I wrote it up in nonexistent-notes.md, roughly.";
check("a name that resolves nowhere is left alone", resolveArtifactPaths(missing, dirs) === missing);
check("no directories means no rewriting", resolveArtifactPaths("see plan.md", []) === "see plan.md");
check(
    "a name is never invented from a directory that does not exist",
    resolveArtifactPaths(missing, [join(root, "nope")]) === missing,
);

// Composition with the passes that already run: nothing already clickable is touched.
const already = `Saved to ${join(cwd, "learning-series-plan.md")} and mirrored at https://example.com/learning-series-plan.md today.`;
check("an absolute path is not rewritten again", resolveArtifactPaths(already, dirs) === already, resolveArtifactPaths(already, dirs));
const relative = "It is at docs/learning-series-plan.md in the repo.";
check("a name inside a relative path is left alone", resolveArtifactPaths(relative, dirs) === relative);
const extended = "The backup is learning-series-plan.md.bak, not the plan itself.";
check("a longer file name is not truncated into a match", resolveArtifactPaths(extended, dirs) === extended);
check(
    "an unlisted extension is ignored",
    resolveArtifactPaths("check index.ts for the change", dirs) === "check index.ts for the change",
);

const twice = resolveArtifactPaths("learning-series-plan.md, and again learning-series-plan.md.", dirs);
check(
    "a repeated name resolves the same way both times",
    twice.split(join(cwd, "learning-series-plan.md")).length === 3,
    twice,
);

// MARK: - Pulling artifact paths back out for the ledger

const found = artifactPathsIn(
    `Wrote ${join(cwd, "learning-series-plan.md")} and ${join(files, "budget.csv")}. Nothing at ${join(cwd, "ghost.md")}.`,
);
check("real artifact paths are collected", found.length === 2, found);
check("a path that does not exist is not collected", !found.some((path) => path.endsWith("ghost.md")), found);
check("urls are not mistaken for files", artifactPathsIn("see https://example.com/a.pdf").length === 0);
check(
    "a trailing full stop is not part of the path",
    artifactPathsIn(`Saved to ${join(cwd, "learning-series-plan.md")}.`)[0] === join(cwd, "learning-series-plan.md"),
);

// MARK: - Where a bare name is allowed to resolve

check("the working directory comes first", artifactSearchDirs("/tmp/work", "abc")[0] === "/tmp/work");
check("the session scratch space is included", artifactSearchDirs("/tmp/work", "abc")[1]?.endsWith(join("abc", "files")) === true);
check("a relative cwd is refused", artifactSearchDirs("work", undefined).length === 0);
check("no session id means one directory", artifactSearchDirs("/tmp/work", undefined).length === 1);

rmSync(root, { recursive: true, force: true });

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.error(`  FAIL ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
