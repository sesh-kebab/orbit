/**
 * The facts about a memory that both sides of the app need.
 *
 * `endsIncomplete` and the category list lived in
 * `src/main/orchestrator/memory.ts`, which the renderer cannot see:
 * `tsconfig.web.json` includes `src/renderer` and `src/shared` and nothing
 * else, for the good reason that main's modules reach for `node:fs` on import.
 * The memory panel still has to know the categories it is offering as filters,
 * and which records were cut before they were stored, because "incomplete
 * only" is the filter that turns a list of sixty into the handful that need
 * repairing.
 *
 * So they moved here rather than being written a second time in the renderer.
 * Main re-exports all three names, so every existing caller and the memory
 * suite keep the import they already had, and there is still exactly one
 * definition of what "cut short" means.
 */
import type { MemoryNote } from "./types.js";

/** The categories a memory may carry. */
export const MEMORY_CATEGORIES: readonly MemoryNote["category"][] = [
    "preference",
    "fact",
    "routine",
    "person",
    "project",
] as const;

/**
 * What a render-time clip leaves behind. Memories are stored whole and
 * shortened on the way into a prompt, so this marker says "shortened here",
 * not "lost".
 */
export const TRUNCATION_MARKER = " … [truncated]";

/**
 * Does this text stop mid-thought with no way back? True for anything written
 * under the old write-time clip, which left either the marker or a bare
 * ellipsis at the end and kept nothing else.
 */
export function endsIncomplete(text: string): boolean {
    const clean = text.trimEnd();
    return clean.endsWith(TRUNCATION_MARKER.trim()) || clean.endsWith("\u2026");
}
