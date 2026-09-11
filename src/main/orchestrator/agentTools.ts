/**
 * Which of Orbit's own tools an agent is given.
 *
 * Agent sessions were created with no `tools` at all, so every agent ran with
 * the built-in file and shell tools and none of Orbit's. That is invisible for
 * an agent that only reads a repo, and fatal for the nightly self-reflection,
 * whose entire job is bookkeeping: it is asked to review proposals, move the
 * ones whose status changed and file decisions for the user, and it had no way
 * to do any of it. Four consecutive nights it reported the tools missing and
 * wrote Orbit's state files directly on disk instead, underneath a running app
 * that holds the same records in memory and rewrites them on its next tick.
 *
 * The fix is not to make agents omnipotent. An agent is a worker: it should be
 * able to record what it found and what it did, and read enough of Orbit's
 * state to avoid repeating itself. It should not be able to spawn more agents,
 * restart the app, rewrite schedules or declare the user on leave. So the set
 * below is an allowlist of bookkeeping and read tools, and `FORBIDDEN` is the
 * rule that keeps it one: the control-plane tools are named explicitly and an
 * invariant asserts none of them ever drifts into the allowlist.
 */

/** Bookkeeping and read tools an agent may call. */
export const AGENT_TOOL_NAMES: readonly string[] = [
    // Orbit's own backlog: the reflection's core loop, read before it writes.
    "orbit_list_proposals",
    "orbit_record_proposal",
    "orbit_update_proposal",
    // Decisions for the user. An agent that finds one should file it rather
    // than say it once in a report nobody re-reads.
    "orbit_list_open_items",
    "orbit_raise_open_item",
    "orbit_resolve_open_item",
    // What was done on the user's behalf, including artifacts with their paths.
    "orbit_list_activity",
    "orbit_record_activity",
    "orbit_update_activity",
    // Durable facts learned mid-investigation, which otherwise die with the
    // session that learned them.
    "orbit_list_memories",
    "orbit_remember",
    // Read-only context.
    "orbit_list_schedules",
    "orbit_list_leave",
];

/**
 * Tools an agent must never hold. Everything here either changes what Orbit
 * runs, changes whether Orbit runs at all, or destroys a record rather than
 * moving it. Listed by name rather than derived, so adding a control-plane tool
 * is a deliberate decision in both places.
 */
export const FORBIDDEN_AGENT_TOOL_NAMES: readonly string[] = [
    "orbit_spawn_agent",
    "orbit_list_agents",
    "orbit_agent_details",
    "orbit_message_agent",
    "orbit_cancel_agent",
    "orbit_soft_restart",
    "orbit_schedule_task",
    "orbit_daily_briefing",
    "orbit_update_schedule",
    "orbit_cancel_schedule",
    "orbit_run_schedule_now",
    "orbit_forget",
    "orbit_sync_workspace",
    "orbit_set_leave",
    "orbit_clear_leave",
];

export interface AgentToolSelection<T> {
    /** The tools to hand to the agent session. */
    tools: T[];
    /**
     * Allowlisted names with no matching registered tool. Always empty in a
     * healthy build; non-empty means a tool was renamed and the allowlist was
     * not, which would silently take a capability away from every agent.
     */
    missing: string[];
}

/**
 * Narrow the full tool list down to what an agent gets, and report anything the
 * allowlist names that no longer exists. Pure, and deliberately generic over
 * the tool type so it can be checked without the SDK or Electron.
 */
export function selectAgentTools<T extends { name: string }>(all: readonly T[]): AgentToolSelection<T> {
    const wanted = new Set(AGENT_TOOL_NAMES);
    const tools = all.filter((tool) => wanted.has(tool.name));
    const present = new Set(tools.map((tool) => tool.name));
    const missing = AGENT_TOOL_NAMES.filter((name) => !present.has(name));
    return { tools, missing };
}
