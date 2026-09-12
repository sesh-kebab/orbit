/**
 * Does the code a proposal claims to have shipped actually exist on `main`?
 *
 * This exists because of one concrete failure. Proposal `cc773a7c` — derive the
 * calendar-scan interval from what the last scan found, instead of reading an
 * empty calendar every forty-five minutes all night — was recorded `shipped`
 * against branch `feat/quiet-calendar-polling`, commit `a00dab5`, on 15 August.
 * The branch was later deleted without being merged. The commit survived only
 * as a dangling object. Nothing noticed, because nothing ever asked.
 *
 * The cost was four weeks of the exact behaviour the proposal had been closed
 * for: on 11 September the calendar was scanned thirty times at a flat forty-six
 * minutes, twelve of those between midnight and eight in the morning. Worse, the
 * proposal read `shipped`, so every later review skipped it. A false "shipped"
 * is not a neutral bookkeeping error: it actively hides the work.
 *
 * The check is deliberately weak in one direction and strong in the other. It
 * cannot tell whether a proposal's *intent* was met, only whether the commit it
 * named is still reachable from `main`.
 *
 * And that signal has a known false positive: a branch that was rebased or
 * squashed lands its behaviour under a new SHA, leaving the recorded one
 * unreachable even though the feature is present. On 11 September nine of the
 * twenty shipped proposals flagged this way and eight of them were fine. So
 * this is a triage list for a human, not a gate. Its worth is that it is short,
 * it is exhaustive, and the one real regression in four weeks was on it.
 */

/** The part of a proposal this cares about. Structural, so callers can pass their own. */
export interface LandedCandidate {
    proposalId: string;
    status: string;
    text: string;
    shippedIn?: { branch?: string; commit?: string };
}

export type LandedVerdict =
    /** The named commit is reachable from `main`. Nothing to do. */
    | { kind: "landed"; commit: string }
    /**
     * The commit exists but is not an ancestor of `main`. Either it was never
     * merged, or its branch was rebased or squashed and the behaviour landed
     * under a different SHA. Needs a human to tell those apart.
     */
    | { kind: "unlanded"; commit: string }
    /** The commit is not in the repository at all: rewritten, or another repo. */
    | { kind: "missing"; commit: string }
    /** Marked shipped with no commit recorded, so the claim cannot be checked. */
    | { kind: "unrecorded" };

export interface LandedReport {
    proposalId: string;
    text: string;
    branch?: string;
    verdict: LandedVerdict;
}

/**
 * How a commit relates to `main`. Injected rather than shelled out to, so the
 * decision above is pure and testable without a git repository.
 */
export type CommitLookup = (commit: string) => "ancestor" | "present" | "absent";

/** Only a proposal claiming to have shipped code makes a checkable claim. */
export function claimsCode(proposal: LandedCandidate): boolean {
    return proposal.status === "shipped";
}

/** Judge one proposal. */
export function judgeProposal(proposal: LandedCandidate, lookup: CommitLookup): LandedVerdict {
    const commit = proposal.shippedIn?.commit?.trim();
    if (!commit) return { kind: "unrecorded" };
    switch (lookup(commit)) {
        case "ancestor":
            return { kind: "landed", commit };
        case "present":
            return { kind: "unlanded", commit };
        case "absent":
            return { kind: "missing", commit };
    }
}

/**
 * Every shipped proposal whose code is not demonstrably on `main`.
 *
 * `unrecorded` is included on purpose. A proposal marked shipped with no commit
 * is not obviously wrong, but it is unfalsifiable, and the whole point here is
 * that an unfalsifiable claim is how the calendar regression survived four
 * weeks. Callers that only want hard failures can filter on the verdict kind.
 */
export function unlandedShipped(
    proposals: readonly LandedCandidate[],
    lookup: CommitLookup,
): LandedReport[] {
    return proposals
        .filter(claimsCode)
        .map((proposal) => ({
            proposalId: proposal.proposalId,
            text: proposal.text,
            branch: proposal.shippedIn?.branch,
            verdict: judgeProposal(proposal, lookup),
        }))
        .filter((report) => report.verdict.kind !== "landed");
}

/**
 * The ones whose commit reference is demonstrably stale, as opposed to merely
 * absent. Still needs checking by hand: a rebase produces exactly this.
 */
export function provablyUnlanded(reports: readonly LandedReport[]): LandedReport[] {
    return reports.filter(
        (report) => report.verdict.kind === "unlanded" || report.verdict.kind === "missing",
    );
}

/** One line for a human, short enough for a report. */
export function describeVerdict(report: LandedReport): string {
    const head = report.text.length > 80 ? `${report.text.slice(0, 77)}...` : report.text;
    const where = report.branch ? ` on ${report.branch}` : "";
    switch (report.verdict.kind) {
        case "landed":
            return `${head} — landed as ${report.verdict.commit.slice(0, 7)}`;
        case "unlanded":
            return `${head} — ${report.verdict.commit.slice(0, 7)}${where} was never merged to main; check whether it was rebased`;
        case "missing":
            return `${head} — ${report.verdict.commit.slice(0, 7)}${where} is not in this repository`;
        case "unrecorded":
            return `${head} — marked shipped with no commit recorded, so nothing can check it`;
    }
}
