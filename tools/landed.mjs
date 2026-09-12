/**
 * Check the real proposal store against this checkout.
 *
 *   npm run landed
 *
 * Prints every proposal marked `shipped` whose commit is not reachable from
 * `main`. This is a triage list, not a gate: a branch that was rebased or
 * squashed lands its behaviour under a new SHA and shows up here even though it
 * is fine. On 11 September nine of twenty flagged and eight were false alarms.
 * So it exits zero by default and only fails under `--strict`.
 *
 * The eight false alarms are the price of the ninth. Proposal cc773a7c was
 * marked shipped against a commit on a branch that was deleted before being
 * merged, and the claim went unexamined for four weeks while the calendar it
 * was meant to quieten carried on being scanned thirty times a day. A short
 * list somebody reads would have caught it on the first night.
 *
 * Deliberately NOT part of `npm run verify`. The suites must pass on a clean
 * clone with no user data, and this reads a store that only exists on a machine
 * where Orbit has actually run. The logic it uses is what `verify:landed`
 * covers; this is the thing that points that logic at reality.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STORE = join(
    homedir(),
    "Library",
    "Application Support",
    "Orbit",
    "proposals.json",
);

if (!existsSync(STORE)) {
    console.log(`No proposal store at ${STORE}. Nothing to check.`);
    process.exit(0);
}

/** @type {{proposalId: string, status: string, text: string, shippedIn?: {branch?: string, commit?: string}}[]} */
let proposals;
try {
    const raw = JSON.parse(readFileSync(STORE, "utf8"));
    proposals = Array.isArray(raw) ? raw : (raw.proposals ?? []);
} catch (error) {
    console.error(`Could not read ${STORE}: ${error.message}`);
    process.exit(1);
}

const git = (...args) => spawnSync("git", args, { encoding: "utf8" });

/** Opt in to failing, since the false-positive rate makes a default gate wrong. */
const strict = process.argv.includes("--strict");

if (git("rev-parse", "--git-dir").status !== 0) {
    console.error("Not a git repository. Run this from the Orbit checkout.");
    process.exit(1);
}

/** Resolve a commit against main: reachable, merely present, or gone. */
function lookup(commit) {
    if (git("cat-file", "-e", `${commit}^{commit}`).status !== 0) return "absent";
    return git("merge-base", "--is-ancestor", commit, "main").status === 0 ? "ancestor" : "present";
}

const shipped = proposals.filter((p) => p.status === "shipped");
const reports = [];
for (const proposal of shipped) {
    const commit = proposal.shippedIn?.commit?.trim();
    const verdict = !commit
        ? "unrecorded"
        : { ancestor: "landed", present: "unlanded", absent: "missing" }[lookup(commit)];
    if (verdict !== "landed") {
        reports.push({ proposal, commit, verdict });
    }
}

const hard = reports.filter((r) => r.verdict === "unlanded" || r.verdict === "missing");

console.log(`${shipped.length} proposals marked shipped.`);
if (reports.length === 0) {
    console.log("Every one of them names a commit that is on main.");
    process.exit(0);
}

for (const { proposal, commit, verdict } of reports) {
    // The store on disk calls it `id`; the tool API exposes it as `proposalId`.
    const id = proposal.proposalId ?? proposal.id ?? "(no id)";
    const head = proposal.text.length > 90 ? `${proposal.text.slice(0, 87)}...` : proposal.text;
    const where = proposal.shippedIn?.branch ? ` on ${proposal.shippedIn.branch}` : "";
    const why =
        verdict === "unlanded"
            ? `${commit.slice(0, 7)}${where} is not on main`
            : verdict === "missing"
              ? `${commit.slice(0, 7)}${where} is not in this repository`
              : "no commit recorded, so nothing can check it";
    console.log(`\n  ${verdict === "unrecorded" ? "?" : "✗"} ${String(id).slice(0, 8)}  ${why}`);
    console.log(`      ${head}`);
}

console.log(
    `\n${hard.length} shipped proposal(s) name a commit that is not on main, ` +
        `${reports.length - hard.length} name no commit at all.` +
        `\nA rebased or squashed branch looks exactly like this, so confirm the behaviour` +
        `\nis present before concluding anything was lost.`,
);
process.exit(strict && hard.length > 0 ? 1 : 0);
