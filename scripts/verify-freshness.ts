/**
 * Checks for the running-build freshness rules.
 *
 * No clock, no filesystem, no Electron: every case below is a plain struct of
 * timestamps handed to `assessFreshness`, which is the whole reason the rules
 * were split away from the code that reads mtimes. The disk-reading half is
 * exercised separately, at the bottom, against this repository itself.
 */
import {
    GRACE_MS,
    assessFreshness,
    collectFreshnessFacts,
    describeGap,
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
