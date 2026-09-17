/**
 * An MCP server that failed to load is not dead, and saying so is a lie Orbit
 * has been telling all day.
 *
 * What actually happens: the runtime spawns each configured server at session
 * start, connects, then asks it for its tool list. The `ado` server answers
 * `initialize` in about ten seconds on its own and about twenty when all three
 * servers start at once, because it fetches an EntraID token and opens an Azure
 * DevOps connection before it will talk. That loses a race against the runtime's
 * startup deadline for `tools/list`, which comes back as `McpError -32001:
 * Request timed out` — the MCP spec's request timeout, not a crash and not a
 * missing binary. The copilot log records it two dozen times over three days.
 *
 * The old behaviour, and both halves of the complaint:
 *
 *   1. The failure was announced by pasting eighty characters of the raw error
 *      into chat, truncated mid-word, which told the user nothing about what he
 *      had lost.
 *   2. It said "restart Orbit to retry". Orbit restarts itself now when a build
 *      is waiting, and a restart never retried anything on purpose — it just
 *      re-rolled the same race. Until one landed the right way up, every agent
 *      that needed a work item quietly did without.
 *
 * So the same server is simply tried again, alone, a few seconds later. A retry
 * on its own is the ten-second case rather than the twenty-second one, which is
 * most of why it works.
 *
 * The rules live here, pure, with `now` passed in, for the same reason
 * `freshness.ts` does it: the interesting part is when to give up and what to
 * say, and neither needs a clock, a socket or a subprocess to be tested.
 */

/** Connection status as the runtime reports it, narrowed to what matters. */
export type McpStatus = "connected" | "failed" | "needs-auth" | "pending" | "disabled";

/** Where a server has got to, from Orbit's point of view rather than the host's. */
export type McpHealthState =
    /** Loaded, tools available. The only state with nothing to say. */
    | "connected"
    /** Failed, and an attempt to bring it back is scheduled. */
    | "retrying"
    /** Failed `MAX_ATTEMPTS` times. Nothing further will be tried this session. */
    | "gave-up"
    /** Failed in a way retrying cannot fix, so nothing is scheduled. */
    | "unrecoverable";

export interface McpHealth {
    name: string;
    state: McpHealthState;
    /** Reconnect attempts made so far. Zero until the first retry runs. */
    attempts: number;
    /** When the server first failed this session. */
    failedAt: number;
    /** Earliest time the next attempt may run. Meaningless unless retrying. */
    nextAttemptAt: number;
    /** The runtime's raw error, kept for the log and never for the chat. */
    lastError?: string;
}

/**
 * How many times a server is brought back before Orbit stops trying.
 *
 * Five attempts spans about nine minutes, which covers a cold token fetch, a
 * laptop that has just woken and a corporate network still finding itself. Past
 * that the problem is not a race and repeating it is just noise.
 */
export const MAX_ATTEMPTS = 5;

/** Wait before the first retry. Long enough that the host has settled. */
export const FIRST_BACKOFF_MS = 15_000;

/** Ceiling on the doubling, so attempt five is minutes and not hours. */
export const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * Exponential, from 15s: 15s, 30s, 60s, 120s, 240s. `attempt` is the number of
 * attempts already made, so the first wait is `retryDelayMs(0)`.
 */
export function retryDelayMs(attempt: number): number {
    const delay = FIRST_BACKOFF_MS * 2 ** Math.max(0, attempt);
    return Math.min(delay, MAX_BACKOFF_MS);
}

/**
 * Errors no amount of retrying will fix.
 *
 * A missing binary stays missing, and a server the registry policy refuses to
 * verify is refused again every time — that one happened to all three servers
 * on 15 September. Retrying those produces five identical failures and a worse
 * message than the first one.
 */
function isUnrecoverable(error: string | undefined): boolean {
    if (!error) return false;
    return /ENOENT|command not found|no such file|configured registry|not permitted|disabled by policy/i.test(
        error,
    );
}

/** First failure, or a repeat of one. Returns the record to store. */
export function noteFailure(
    previous: McpHealth | undefined,
    name: string,
    error: string | undefined,
    now: number,
): McpHealth {
    // Already failed and already counted. A second report of the same outage —
    // the loaded event and a status change often both arrive — must not consume
    // an attempt or push the schedule out.
    if (previous && previous.state !== "connected") {
        return { ...previous, lastError: error ?? previous.lastError };
    }
    if (isUnrecoverable(error)) {
        return {
            name,
            state: "unrecoverable",
            attempts: 0,
            failedAt: now,
            nextAttemptAt: 0,
            lastError: error,
        };
    }
    return {
        name,
        state: "retrying",
        attempts: 0,
        failedAt: now,
        nextAttemptAt: now + retryDelayMs(0),
        lastError: error,
    };
}

/** The server answered. Everything about the outage is forgotten. */
export function noteRecovery(name: string, now: number): McpHealth {
    return { name, state: "connected", attempts: 0, failedAt: 0, nextAttemptAt: now };
}

/** Is this server owed an attempt right now? */
export function dueForRetry(health: McpHealth, now: number): boolean {
    return health.state === "retrying" && now >= health.nextAttemptAt;
}

/** Every server owed an attempt, oldest failure first so nothing starves. */
export function dueForRetryAmong(health: Iterable<McpHealth>, now: number): McpHealth[] {
    return [...health]
        .filter((entry) => dueForRetry(entry, now))
        .sort((a, b) => a.failedAt - b.failedAt);
}

/**
 * Record the outcome of an attempt.
 *
 * A success returns a connected record; a failure either schedules the next
 * attempt or gives up, which is the only place `MAX_ATTEMPTS` is applied.
 */
export function noteAttempt(
    health: McpHealth,
    outcome: { ok: boolean; error?: string },
    now: number,
): McpHealth {
    if (outcome.ok) return noteRecovery(health.name, now);
    const attempts = health.attempts + 1;
    const error = outcome.error ?? health.lastError;
    if (isUnrecoverable(outcome.error)) {
        return { ...health, state: "unrecoverable", attempts, nextAttemptAt: 0, lastError: error };
    }
    if (attempts >= MAX_ATTEMPTS) {
        return { ...health, state: "gave-up", attempts, nextAttemptAt: 0, lastError: error };
    }
    return {
        ...health,
        state: "retrying",
        attempts,
        nextAttemptAt: now + retryDelayMs(attempts),
        lastError: error,
    };
}

/**
 * What the user actually loses when a named server is missing.
 *
 * Written as the capability rather than the product, because "ado is
 * unavailable" is only meaningful to someone who already knows what ado is for,
 * and the whole point of the message is to reach someone who does not.
 */
export function capabilityOf(name: string): string {
    switch (name.toLowerCase()) {
        case "ado":
        case "azure-devops":
        case "azuredevops":
            return "work items, pull requests and the ADO wiki";
        case "workiq":
            return "your mail, calendar and Teams";
        case "kusto":
            return "telemetry and Kusto queries";
        case "github":
            return "GitHub issues and pull requests";
        default:
            return `the tools ${name} provides`;
    }
}

/**
 * The runtime's error, in one clause a human can act on.
 *
 * Deliberately lossy. The raw text goes to the console, where it belongs; chat
 * gets the category, because "McpError: MCP error -32001: R" — which is what the
 * old message showed after clipping — is worse than nothing.
 */
export function describeMcpError(error: string | undefined): string {
    if (!error) return "it did not load";
    if (/-32001|timed out|timeout/i.test(error)) return "it did not answer in time";
    if (/-32000|auth|token|credential|unauthori[sz]ed|403|401/i.test(error)) {
        return "it could not authenticate";
    }
    if (/ENOENT|command not found|no such file|spawn/i.test(error)) {
        return "its command could not be run";
    }
    if (/configured registry|not permitted|disabled by policy/i.test(error)) {
        return "it was blocked by policy";
    }
    if (/ECONNREFUSED|ENOTFOUND|network|socket|EAI_AGAIN/i.test(error)) {
        return "it could not be reached";
    }
    return "it failed to start";
}

/** "a", "b and c", "a, b and c" — an Oxford-free list for one sentence. */
function joinNames(names: string[]): string {
    if (names.length <= 1) return names[0] ?? "";
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The line shown when servers fail, replacing the truncated raw error.
 *
 * Three facts, in the order they matter: which server, what is therefore
 * missing, and what is being done about it. Several servers failing at once is
 * one line, not one line each.
 */
export function unavailableMessage(failures: McpHealth[]): string | undefined {
    if (failures.length === 0) return undefined;
    if (failures.length === 1) {
        const only = failures[0];
        const reason = describeMcpError(only.lastError);
        const lost = `${capabilityOf(only.name)} are unavailable`;
        if (only.state === "unrecoverable" || only.state === "gave-up") {
            return `${only.name} could not start: ${reason}, so ${lost} until that is fixed. Retrying will not help, so I am not.`;
        }
        return `${only.name} could not start: ${reason}, so ${lost} for now. Reconnecting in the background, up to ${MAX_ATTEMPTS} times.`;
    }
    const names = joinNames(failures.map((failure) => failure.name));
    const retrying = failures.filter((failure) => failure.state === "retrying");
    const tail =
        retrying.length === 0
            ? "Retrying will not help those, so I am not."
            : `Reconnecting ${retrying.length === failures.length ? "them" : joinNames(retrying.map((r) => r.name))} in the background, up to ${MAX_ATTEMPTS} times each.`;
    const lost = joinNames(failures.map((failure) => capabilityOf(failure.name)));
    return `${names} could not start, so ${lost} are unavailable for now. ${tail}`;
}

/** Said once, when a retry works. The whole point of having retried. */
export function recoveredMessage(health: McpHealth, attempts = health.attempts): string {
    const attempt = attempts === 1 ? "one attempt" : `${attempts} attempts`;
    return `${health.name} is back after ${attempt}, so ${capabilityOf(health.name)} are available again.`;
}

/**
 * Said once, when the attempts run out.
 *
 * It names the number of attempts precisely so that the silence afterwards is
 * accounted for: a user who is told "gave up after 5" knows nothing more is
 * coming, which the old "restart Orbit to retry" never actually meant.
 */
export function gaveUpMessage(health: McpHealth): string {
    return `${health.name} still will not start after ${health.attempts} attempts: ${describeMcpError(health.lastError)}. ${capitalise(capabilityOf(health.name))} stay unavailable for the rest of this session.`;
}

function capitalise(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}
