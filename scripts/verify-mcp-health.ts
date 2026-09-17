/**
 * Checks for the MCP reconnect rules.
 *
 * No session, no subprocess, no clock: every case is a plain health record and a
 * timestamp handed to the functions in `mcpHealth.ts`. The half that actually
 * talks to the runtime — `restartServer` then `listTools` — is not exercised
 * here, for the same reason the freshness suite does not build the app.
 */
import {
    FIRST_BACKOFF_MS,
    MAX_ATTEMPTS,
    MAX_BACKOFF_MS,
    capabilityOf,
    describeMcpError,
    dueForRetry,
    dueForRetryAmong,
    gaveUpMessage,
    noteAttempt,
    noteFailure,
    noteRecovery,
    recoveredMessage,
    unavailableMessage,
    type McpHealth,
} from "../src/main/mcpHealth.js";

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

const NOW = new Date(2026, 8, 17, 9, 0).getTime();
const SECOND = 1000;
const TIMEOUT = "MCP transport host MCP list tools callback failed: McpError: MCP error -32001: Request timed out";

// --- The first failure ------------------------------------------------------

const first = noteFailure(undefined, "ado", TIMEOUT, NOW);

check("a fresh timeout schedules a retry", first.state, "retrying");
check("a fresh failure has made no attempts yet", first.attempts, 0);
check("the first retry is one backoff away", first.nextAttemptAt, NOW + FIRST_BACKOFF_MS);
check("the raw error is kept for the log", first.lastError, TIMEOUT);

check(
    "a second report of the same outage does not consume an attempt",
    noteFailure(first, "ado", TIMEOUT, NOW + SECOND).attempts,
    0,
);
check(
    "a second report of the same outage does not push the schedule out",
    noteFailure(first, "ado", TIMEOUT, NOW + SECOND).nextAttemptAt,
    NOW + FIRST_BACKOFF_MS,
);

// A server that was fine and then dropped is a new outage, not a continuation.
const dropped = noteFailure(noteRecovery("ado", NOW), "ado", TIMEOUT, NOW + 60 * SECOND);
check("a server that drops later starts its own count", dropped.attempts, 0);
check("a server that drops later is retried", dropped.state, "retrying");

// --- Errors retrying cannot fix ---------------------------------------------

check(
    "a missing command is not retried",
    noteFailure(undefined, "ado", "spawn agency ENOENT", NOW).state,
    "unrecoverable",
);
check(
    "a registry-blocked server is not retried",
    noteFailure(undefined, "workiq", "Could not verify server against any configured registry", NOW)
        .state,
    "unrecoverable",
);
check(
    "an unrecoverable server is never due",
    dueForRetry(noteFailure(undefined, "ado", "spawn agency ENOENT", NOW), NOW + 10 * 60 * SECOND),
    false,
);

// --- Backoff ----------------------------------------------------------------

check("nothing is due before its backoff elapses", dueForRetry(first, NOW + FIRST_BACKOFF_MS - 1), false);
check("it is due once the backoff elapses", dueForRetry(first, NOW + FIRST_BACKOFF_MS), true);

let walk: McpHealth = first;
const waits: number[] = [];
for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const at = walk.nextAttemptAt;
    walk = noteAttempt(walk, { ok: false, error: TIMEOUT }, at);
    if (walk.state === "retrying") waits.push(walk.nextAttemptAt - at);
}

check("the waits double from fifteen seconds", waits, [30_000, 60_000, 120_000, 240_000]);
ok("no wait exceeds the ceiling", waits.every((wait) => wait <= MAX_BACKOFF_MS));
check("the attempts run out", walk.state, "gave-up");
check("giving up is counted honestly", walk.attempts, MAX_ATTEMPTS);
check("a server that gave up is never due again", dueForRetry(walk, NOW + 24 * 3600 * SECOND), false);

// --- Recovery ---------------------------------------------------------------

const recovered = noteAttempt(first, { ok: true }, NOW + FIRST_BACKOFF_MS);
check("a successful retry clears the state", recovered.state, "connected");
check("a successful retry clears the count", recovered.attempts, 0);

const noTools = noteAttempt(first, { ok: false, error: "it came back with no tools" }, NOW);
check("a restart that yields no tools is still a failure", noTools.state, "retrying");
check("a restart that yields no tools counts as an attempt", noTools.attempts, 1);

// --- Ordering ---------------------------------------------------------------

const later = noteFailure(undefined, "kusto", TIMEOUT, NOW + 5 * SECOND);
check(
    "the oldest failure is retried first",
    dueForRetryAmong([later, first], NOW + FIRST_BACKOFF_MS + 5 * SECOND).map((h) => h.name),
    ["ado", "kusto"],
);
check(
    "a connected server is never in the queue",
    dueForRetryAmong([noteRecovery("workiq", NOW)], NOW + 3600 * SECOND).length,
    0,
);

// --- What the user is told --------------------------------------------------

const single = unavailableMessage([first]) ?? "";

ok("the message names the server", single.includes("ado"));
ok("the message says what is missing", single.includes("work items"));
ok("the message says a retry is coming", /[Rr]econnecting/.test(single));
ok("the message never says to restart Orbit", !/restart/i.test(single));
ok("the message carries no raw error", !single.includes("-32001") && !single.includes("McpError"));
ok("the message is one plain line", !single.includes("\n") && single.length < 200);

const both = unavailableMessage([first, later]) ?? "";
ok("two failures are one line, not two", !both.includes("\n"));
ok("two failures name both servers", both.includes("ado") && both.includes("kusto"));

const blocked = noteFailure(undefined, "workiq", "Could not verify server against any configured registry", NOW);
const blockedText = unavailableMessage([blocked]) ?? "";
ok("an unrecoverable failure does not promise a retry", !/Reconnecting/.test(blockedText));
ok("an unrecoverable failure says why not", /will not help/.test(blockedText));

check("nothing failing says nothing", unavailableMessage([]), undefined);

// A record that has already run out of attempts must never promise more of them,
// which is exactly the lie the old "restart Orbit to retry" line told.
const exhaustedText = unavailableMessage([walk]) ?? "";
ok("a server that gave up is not promised a reconnect", !/Reconnecting/.test(exhaustedText));

const back = recoveredMessage(noteRecovery("ado", NOW), 2);
ok("recovery names the server", back.includes("ado"));
ok("recovery says how many attempts it took", back.includes("2 attempts"));
ok("one attempt is not '1 attempts'", recoveredMessage(noteRecovery("ado", NOW), 1).includes("one attempt"));

const gaveUp = gaveUpMessage(walk);
ok("giving up says how many attempts were made", gaveUp.includes(`${MAX_ATTEMPTS} attempts`));
ok("giving up says the capability is gone for the session", gaveUp.includes("rest of this session"));
ok("giving up carries no raw error", !gaveUp.includes("-32001"));

// --- Wording of the parts ---------------------------------------------------

check("a timeout is described as a timeout", describeMcpError(TIMEOUT), "it did not answer in time");
check(
    "an EntraID failure is described as auth",
    describeMcpError("JSON-RPC error: -32000: Authentication failed: Failed to get EntraID token"),
    "it could not authenticate",
);
check("a missing binary is described as such", describeMcpError("spawn agency ENOENT"), "its command could not be run");
check("no error at all still reads as a sentence", describeMcpError(undefined), "it did not load");

check("ado is named by what it does", capabilityOf("ado"), "work items, pull requests and the ADO wiki");
ok("workiq covers the calendar", capabilityOf("workiq").includes("calendar"));
ok("an unknown server still reads as English", capabilityOf("acme").includes("acme"));

// --- Report -----------------------------------------------------------------

console.log("");
console.log(`On a timeout, the user now sees: ${single}`);
console.log("");

if (failures.length > 0) {
    console.error(`${failures.length} check(s) failed:\n`);
    for (const failure of failures) console.error(`  ${failure}\n`);
    process.exit(1);
}
console.log(`${passed} checks passed.`);
console.log("MCP reconnect rules verified.");
