/**
 * Checks for the running-build freshness rules.
 *
 * No clock, no filesystem, no Electron: every case below is a plain struct of
 * timestamps handed to `assessFreshness`, which is the whole reason the rules
 * were split away from the code that reads mtimes. The disk-reading half is
 * exercised separately, at the bottom, against this repository itself.
 */
import {
    FRESHNESS_TAG,
    GRACE_MS,
    RESTART_IDLE_MS,
    RESTART_SETTLE_MS,
    assessFreshness,
    collectFreshnessFacts,
    decideAutoRestart,
    decideFreshnessAction,
    describeGap,
    freshnessSource,
    stateOfFreshnessSource,
    type AutoRestartFacts,
    type FreshnessFacts,
} from "../src/main/freshness.js";

let passed = 0;
const failures: string[] = [];

function check(what: string, actual: unknown, expected: unknown): void {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a === b) {
        passed++;
        return;
    }
    failures.push(`${what}\n    expected ${b}\n    actual   ${a}`);
}

function ok(what: string, condition: boolean): void {
    check(what, condition, true);
}

const NOW = new Date(2026, 7, 19, 21, 30).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function facts(patch: Partial<FreshnessFacts>): FreshnessFacts {
    return {
        builtAt: NOW - HOUR,
        newestSourceAt: NOW - 2 * HOUR,
        newestSourcePath: "src/main/index.ts",
        processStartedAt: NOW - 30 * MINUTE,
        ...patch,
    };
}

// --- Everything current -----------------------------------------------------

check(
    "a build newer than the source, in a process newer than the build, is current",
    assessFreshness(facts({}), NOW).state,
    "current",
);
check(
    "nothing to say when current",
    assessFreshness(facts({}), NOW).summary,
    undefined,
);
check("current means zero drift", assessFreshness(facts({}), NOW).behindMs, 0);

// --- Source ahead of the build ---------------------------------------------

const needsBuild = assessFreshness(
    facts({ builtAt: NOW - 48 * HOUR, newestSourceAt: NOW - 2 * HOUR }),
    NOW,
);
check("source newer than the build needs a build", needsBuild.state, "needs-build");
check("the gap is reported", needsBuild.behindMs, 46 * HOUR);
ok("the summary names the offending file", needsBuild.summary!.includes("src/main/index.ts"));
ok("the summary says to rebuild", needsBuild.summary!.toLowerCase().includes("rebuild"));

// This is the real case that motivated the check: on 19 August the process was
// started that morning from a build made on the 17th, against source edited on
// the 18th. Ordering the two rules the other way round would have called this
// "current", because the process was indeed newer than the build.
const theRealCase = assessFreshness(
    {
        builtAt: new Date(2026, 7, 17, 18, 10).getTime(),
        newestSourceAt: new Date(2026, 7, 18, 22, 40).getTime(),
        newestSourcePath: "src/main/orchestrator/persona.ts",
        processStartedAt: new Date(2026, 7, 19, 9, 29).getTime(),
    },
    NOW,
);
check("a process newer than a stale build still needs a build", theRealCase.state, "needs-build");
ok(
    "and the wording is about rebuilding, not restarting",
    theRealCase.summary!.toLowerCase().includes("rebuild"),
);

// --- Build ahead of the process --------------------------------------------

const needsRestart = assessFreshness(
    facts({ builtAt: NOW - 5 * MINUTE, processStartedAt: NOW - 3 * HOUR }),
    NOW,
);
check("a build made after launch needs a restart", needsRestart.state, "needs-restart");
ok("the summary says to restart", needsRestart.summary!.toLowerCase().includes("restart"));
ok(
    "a restart message does not also demand a rebuild",
    !needsRestart.summary!.toLowerCase().includes("rebuild"),
);

// --- The grace window -------------------------------------------------------

check(
    "a source edit inside the grace window is not stale",
    assessFreshness(
        facts({ builtAt: NOW - HOUR, newestSourceAt: NOW - HOUR + GRACE_MS - 1000 }),
        NOW,
    ).state,
    "current",
);
check(
    "a source edit just outside it is",
    assessFreshness(
        facts({ builtAt: NOW - HOUR, newestSourceAt: NOW - HOUR + GRACE_MS + 1000 }),
        NOW,
    ).state,
    "needs-build",
);
check(
    "a build finishing moments after launch does not demand a restart",
    assessFreshness(
        facts({ builtAt: NOW - HOUR, processStartedAt: NOW - HOUR - GRACE_MS + 1000 }),
        NOW,
    ).state,
    "current",
);

// --- Missing information ----------------------------------------------------

// A packaged app: no source tree to be behind.
check(
    "no source means no opinion",
    assessFreshness(facts({ newestSourceAt: undefined, newestSourcePath: undefined }), NOW).state,
    "unknown",
);
// A dev server: nothing built worth comparing.
check("no build means no opinion", assessFreshness(facts({ builtAt: undefined }), NOW).state, "unknown");
check(
    "an unknown state says nothing to the user",
    assessFreshness(facts({ builtAt: undefined }), NOW).summary,
    undefined,
);

// --- Deciding what to do about the open item --------------------------------

// The bug this whole path exists to fix: between 11 and 13 September a build
// landed at 21:37 under a process started the previous night, and nothing was
// raised, because the answer was computed once at launch and never revisited.
const restartFacts = facts({ builtAt: NOW - 5 * MINUTE, processStartedAt: NOW - 26 * HOUR });
const stale = assessFreshness(restartFacts, NOW);

const firstNotice = decideFreshnessAction(undefined, stale);
check("a fresh problem is raised", firstNotice.kind, "raise");
ok(
    "the raised note is tagged so it can be found again",
    firstNotice.kind === "raise" && firstNotice.text.startsWith(FRESHNESS_TAG),
);
check(
    "and records which problem it was raised for",
    firstNotice.kind === "raise" ? firstNotice.source : undefined,
    "freshness check: needs-restart",
);

const raised = {
    text: firstNotice.kind === "raise" ? firstNotice.text : "",
    source: firstNotice.kind === "raise" ? firstNotice.source : undefined,
};

check(
    "the same problem is not raised twice",
    decideFreshnessAction(
        raised,
        assessFreshness(
            facts({ builtAt: NOW - 9 * HOUR, newestSourceAt: NOW - 12 * HOUR, processStartedAt: NOW - 30 * HOUR }),
            NOW,
        ),
    ).kind,
    "none",
);
check(
    "a restart clears the note",
    decideFreshnessAction(raised, assessFreshness(facts({}), NOW)).kind,
    "resolve",
);
check(
    "so does losing the ability to tell",
    decideFreshnessAction(raised, undefined).kind,
    "resolve",
);
check(
    "and there is nothing to clear when nothing was raised",
    decideFreshnessAction(undefined, assessFreshness(facts({}), NOW)).kind,
    "none",
);

// Telling someone to restart onto a build that has since gone stale would send
// them round the loop twice, so the note is replaced rather than left standing.
const changed = decideFreshnessAction(raised, needsBuild);
check("a different problem replaces the old note", changed.kind, "replace");
ok(
    "the replacement explains why the old one closed",
    changed.kind === "replace" && changed.reason.includes("needs-restart"),
);
ok(
    "and the new note asks for the right thing",
    changed.kind === "replace" && changed.text.toLowerCase().includes("rebuild"),
);
check(
    "the replacement records the new problem",
    changed.kind === "replace" ? changed.source : undefined,
    "freshness check: needs-build",
);

// Notes written before the state was recorded must not all re-raise on upgrade.
check(
    "a note from before this change is left alone",
    decideFreshnessAction({ text: `${FRESHNESS_TAG} something older`, source: "freshness check" }, stale).kind,
    "none",
);
check(
    "a note with no source at all is left alone",
    decideFreshnessAction({ text: `${FRESHNESS_TAG} something older` }, stale).kind,
    "none",
);

check("the source round-trips", stateOfFreshnessSource(freshnessSource("needs-build")), "needs-build");
check("an unrelated source yields no state", stateOfFreshnessSource("BAMI reply drafting agent"), undefined);
check("a missing source yields no state", stateOfFreshnessSource(undefined), undefined);

// --- Wording ----------------------------------------------------------------

check("minutes", describeGap(5 * MINUTE), "5 minutes");
check("a single minute is not plural", describeGap(MINUTE), "1 minute");
check("sub-minute gaps still read as a minute", describeGap(20_000), "1 minute");
check("hours", describeGap(3 * HOUR), "3 hours");
check("a single hour is not plural", describeGap(HOUR), "1 hour");
check("long gaps switch to days", describeGap(72 * HOUR), "3 days");

// --- Reading real mtimes ----------------------------------------------------

// `npm run` sets the working directory to the package root. Deriving it from
// `import.meta.url` would point at the bundle's home under node_modules instead.
const root = process.cwd();
const real = collectFreshnessFacts(root, 60_000, Date.now());
ok("the source tree is found in this repo", real.newestSourceAt !== undefined);
ok("and a path is named with it", typeof real.newestSourcePath === "string");
ok(
    "the newest source file is one we consider source",
    ["src/", "tools/", "scripts/", "package.json", "electron.vite.config.ts"].some((prefix) =>
        real.newestSourcePath!.startsWith(prefix),
    ),
);
ok("node_modules is not walked", !real.newestSourcePath!.includes("node_modules"));
ok("the process start time is derived from uptime", real.processStartedAt <= Date.now());

const missing = collectFreshnessFacts("/nonexistent-orbit-root", 1000, Date.now());
check("a missing root yields no source", missing.newestSourceAt, undefined);
check("a missing root yields no build", missing.builtAt, undefined);
check(
    "and therefore no opinion",
    assessFreshness(missing, Date.now()).state,
    "unknown",
);

// --- Applying a waiting build automatically ---------------------------------

// The conditions are a conjunction, so each case below flips exactly one thing
// away from a known-good baseline. That baseline is the situation this feature
// exists for: an overnight build, an idle machine, nobody around.
function autoFacts(patch: Partial<AutoRestartFacts>): AutoRestartFacts {
    return {
        state: "needs-restart",
        builtAt: NOW - 30 * MINUTE,
        busy: false,
        agentsActive: false,
        awaitingUser: false,
        lastInteractionAt: NOW - 3 * HOUR,
        alreadyTriedBuildAt: undefined,
        ...patch,
    };
}

const applies = decideAutoRestart(autoFacts({}), NOW);
check("an unrun build on an idle machine is applied", applies.restart, true);
check(
    "and the decision names the build it is applying",
    applies.restart ? applies.builtAt : undefined,
    NOW - 30 * MINUTE,
);

check(
    "a current process is left alone",
    decideAutoRestart(autoFacts({ state: "current" }), NOW).restart,
    false,
);
check(
    "a stale build is rebuilt by someone else, not restarted into",
    decideAutoRestart(autoFacts({ state: "needs-build" }), NOW).restart,
    false,
);
check(
    "an unknown state is not acted on",
    decideAutoRestart(autoFacts({ state: "unknown" }), NOW).restart,
    false,
);
check(
    "no build means nothing to apply",
    decideAutoRestart(autoFacts({ builtAt: undefined }), NOW).restart,
    false,
);

// The loop-breaker. Without this, a restart that fails to fix the staleness
// bounces the app every five minutes, forever.
check(
    "a build already restarted for is never restarted for again",
    decideAutoRestart(autoFacts({ alreadyTriedBuildAt: NOW - 30 * MINUTE }), NOW).restart,
    false,
);
check(
    "nor is an older build than the one already tried",
    decideAutoRestart(
        autoFacts({ builtAt: NOW - 90 * MINUTE, alreadyTriedBuildAt: NOW - 30 * MINUTE }),
        NOW,
    ).restart,
    false,
);
check(
    "but the next night's build is",
    decideAutoRestart(
        autoFacts({ builtAt: NOW - 10 * MINUTE, alreadyTriedBuildAt: NOW - 26 * HOUR }),
        NOW,
    ).restart,
    true,
);

check(
    "a build still being written is left to finish",
    decideAutoRestart(autoFacts({ builtAt: NOW - 30_000 }), NOW).restart,
    false,
);
check(
    "once settled, it is applied",
    decideAutoRestart(autoFacts({ builtAt: NOW - RESTART_SETTLE_MS - 1000 }), NOW).restart,
    true,
);

// Never yank the app out from under someone who is using it.
check(
    "not while Orbit is mid-turn",
    decideAutoRestart(autoFacts({ busy: true }), NOW).restart,
    false,
);
check(
    "not while an agent is working",
    decideAutoRestart(autoFacts({ agentsActive: true }), NOW).restart,
    false,
);
check(
    "not while something waits on the user",
    decideAutoRestart(autoFacts({ awaitingUser: true }), NOW).restart,
    false,
);
check(
    "not in the middle of a conversation",
    decideAutoRestart(autoFacts({ lastInteractionAt: NOW - MINUTE }), NOW).restart,
    false,
);
check(
    "once the conversation has gone quiet, yes",
    decideAutoRestart(autoFacts({ lastInteractionAt: NOW - RESTART_IDLE_MS - 1000 }), NOW).restart,
    true,
);

ok(
    "every refusal explains itself",
    [
        decideAutoRestart(autoFacts({ state: "current" }), NOW),
        decideAutoRestart(autoFacts({ busy: true }), NOW),
        decideAutoRestart(autoFacts({ agentsActive: true }), NOW),
        decideAutoRestart(autoFacts({ lastInteractionAt: NOW }), NOW),
    ].every((decision) => !decision.restart && decision.because.length > 0),
);

// The verdict has to carry the build it was reached about, or the "already
// tried this one" guard has nothing to compare.
check(
    "a needs-restart verdict names its build",
    assessFreshness(facts({ builtAt: NOW - 5 * MINUTE, processStartedAt: NOW - 3 * HOUR }), NOW).builtAt,
    NOW - 5 * MINUTE,
);

// --- Report -----------------------------------------------------------------

console.log("");
if (real.builtAt !== undefined) {
    const state = assessFreshness(real, Date.now());
    console.log(`This checkout right now: ${state.state}${state.summary ? ` — ${state.summary}` : ""}`);
} else {
    console.log("This checkout right now: never built.");
}
console.log("");

if (failures.length > 0) {
    console.error(`${failures.length} check(s) failed:\n`);
    for (const failure of failures) console.error(`  ${failure}\n`);
    process.exit(1);
}
console.log(`${passed} checks passed.`);
console.log("Freshness rules verified.");
