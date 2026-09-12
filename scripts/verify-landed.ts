/**
 * Verification for the shipped-but-never-merged check.
 *
 *   npm run verify:landed
 *
 * The case this is built from is real and is named in the fixtures: proposal
 * cc773a7c, recorded shipped against a00dab5 on branch feat/quiet-calendar-
 * polling, which was deleted before it was merged. Four weeks later the
 * behaviour it closed was still in production.
 *
 * Pure, so it needs no git.
 */
import {
    claimsCode,
    describeVerdict,
    judgeProposal,
    provablyUnlanded,
    unlandedShipped,
    type CommitLookup,
    type LandedCandidate,
} from "../src/main/orchestrator/landed.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: unknown): void {
    if (condition) {
        passed += 1;
        return;
    }
    failures.push(`${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

const lookup: CommitLookup = (commit) => {
    if (commit.startsWith("a00dab5")) return "present"; // written, branch deleted
    if (commit.startsWith("deadbee")) return "absent"; // not in this repo at all
    return "ancestor";
};

const calendar: LandedCandidate = {
    proposalId: "cc773a7c",
    status: "shipped",
    text: "Derive the calendar-scan interval from what the last scan found instead of a flat 45 minutes.",
    shippedIn: { branch: "feat/quiet-calendar-polling", commit: "a00dab5" },
};
const good: LandedCandidate = {
    proposalId: "8239838",
    status: "shipped",
    text: "Give agents the tools to record what they did.",
    shippedIn: { branch: "fix/agent-tools", commit: "8239838aaaa" },
};
const foreign: LandedCandidate = {
    proposalId: "elsewhere",
    status: "shipped",
    text: "Shipped in the other repository, allegedly.",
    shippedIn: { branch: "feature/activity-ledger", commit: "deadbeef" },
};
const vague: LandedCandidate = {
    proposalId: "vague",
    status: "shipped",
    text: "Shipped, we think.",
};
const openOne: LandedCandidate = {
    proposalId: "open",
    status: "proposed",
    text: "Not claimed to have shipped, so not this check's business.",
};
const declined: LandedCandidate = {
    proposalId: "declined",
    status: "declined",
    text: "Explicitly not doing this.",
};

// MARK: - Only shipped proposals make a checkable claim

check("shipped makes a claim", claimsCode(calendar));
check("proposed does not", !claimsCode(openOne));
check("declined does not", !claimsCode(declined));
check("superseded does not", !claimsCode({ ...openOne, status: "superseded" }));
check("approved does not, since approving is not shipping", !claimsCode({ ...openOne, status: "approved" }));

// MARK: - The verdicts

check("a merged commit is landed", judgeProposal(good, lookup).kind === "landed");
check("an unmerged commit is unlanded", judgeProposal(calendar, lookup).kind === "unlanded");
check("a commit from nowhere is missing", judgeProposal(foreign, lookup).kind === "missing");
check("no commit at all is unrecorded", judgeProposal(vague, lookup).kind === "unrecorded");
check(
    "an empty commit string is unrecorded, not missing",
    judgeProposal({ ...vague, shippedIn: { commit: "   " } }, lookup).kind === "unrecorded",
);
check(
    "a branch with no commit is still unrecorded",
    judgeProposal({ ...vague, shippedIn: { branch: "feat/x" } }, lookup).kind === "unrecorded",
);

// MARK: - The report

const all = [calendar, good, foreign, vague, openOne, declined];
const reports = unlandedShipped(all, lookup);

check("the landed one is not reported", !reports.some((r) => r.proposalId === "8239838"));
check("the open one is not reported", !reports.some((r) => r.proposalId === "open"));
check("the declined one is not reported", !reports.some((r) => r.proposalId === "declined"));
check("the calendar regression is reported", reports.some((r) => r.proposalId === "cc773a7c"));
check("the foreign commit is reported", reports.some((r) => r.proposalId === "elsewhere"));
check("the unverifiable claim is reported", reports.some((r) => r.proposalId === "vague"));
check("three reports in total", reports.length === 3, reports.length);

const hard = provablyUnlanded(reports);
check("two of them are provably wrong", hard.length === 2, hard.map((r) => r.proposalId));
check("and the vague one is not among them", !hard.some((r) => r.proposalId === "vague"));

check("an empty store reports nothing", unlandedShipped([], lookup).length === 0);
check(
    "a store where everything landed reports nothing",
    unlandedShipped([good], lookup).length === 0,
);

// MARK: - The sentence a human reads

const calendarLine = describeVerdict(reports.find((r) => r.proposalId === "cc773a7c")!);
check("the line names the commit", calendarLine.includes("a00dab5"), calendarLine);
check("and the branch", calendarLine.includes("feat/quiet-calendar-polling"), calendarLine);
check("and says it is not on main", calendarLine.includes("never merged to main"), calendarLine);

const vagueLine = describeVerdict(reports.find((r) => r.proposalId === "vague")!);
check("the unverifiable one says so plainly", vagueLine.includes("no commit recorded"), vagueLine);

const longText = "x".repeat(200);
check(
    "a long proposal is clipped rather than dumped",
    describeVerdict({ proposalId: "l", text: longText, verdict: { kind: "unrecorded" } }).length < 160,
);

console.log(
    `\nOn the fixture store: ${reports.length} shipped proposals cannot be proved to be on main,` +
        ` ${hard.length} of them provably are not.` +
        `\n  ${calendarLine}`,
);

// MARK: - Report

console.log(`\n${passed} checks passed.`);
if (failures.length > 0) {
    console.error(`${failures.length} failed:`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exit(1);
}
console.log("Shipped-proposal landing verified.\n");
