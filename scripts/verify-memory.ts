/**
 * Verification for memory correction and for the agent tool allowlist that
 * makes it reachable.
 *
 *   npm run verify:memory
 *
 * Everything under test is pure and takes its clock as an argument, so this
 * runs without Electron and without touching the real memory store.
 */
import { AGENT_TOOL_NAMES, FORBIDDEN_AGENT_TOOL_NAMES, selectAgentTools } from "../src/main/orchestrator/agentTools.js";
import {
    MEMORY_CONTEXT_CAP,
    MEMORY_TEXT_CAP,
    PRIOR_TEXT_CAP,
    correctMemory,
    rememberedBlock,
} from "../src/main/orchestrator/memory.js";
import { buildAgentPrompt } from "../src/main/orchestrator/persona.js";
import type { MemoryNote } from "../src/shared/types.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: unknown): void {
    if (condition) {
        passed += 1;
        return;
    }
    failures.push(`${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

const now = Date.UTC(2026, 8, 14, 21, 30);

function note(id: string, text: string, category: MemoryNote["category"] = "project"): MemoryNote {
    return { id, text, category, createdAt: now - 1000, source: "orbit" };
}

// MARK: - The case this was built for

const stale = [
    note("m1", "Mochi's own source repo is at ~/dev/github/sesh-kebab/ai-desktop-companion."),
    note("m2", "Seshi dislikes em-dashes.", "preference"),
];

const fixed = correctMemory(
    stale,
    "m1",
    { text: "Orbit's own source repo is at ~/dev/github/sesh-kebab/orbit.", reason: "renamed; old repo dead since 20 Aug" },
    now,
);

check("a correction reports the record it changed", fixed.corrected?.id === "m1");
check("the new wording replaces the old", fixed.corrected?.text.includes("orbit") === true, fixed.corrected?.text);
check("the old wording is retired, not dropped", fixed.corrected?.priorText?.length === 1);
check(
    "the retired wording keeps its reason",
    fixed.corrected?.priorText?.[0]?.reason === "renamed; old repo dead since 20 Aug",
);
check("the retired wording keeps the original text", fixed.corrected?.priorText?.[0]?.text.includes("Mochi") === true);
check("the correction is stamped", fixed.corrected?.correctedAt === now);
check("identity survives a correction", fixed.corrected?.createdAt === stale[0].createdAt);
check("provenance survives a correction", fixed.corrected?.source === "orbit");
check("other memories are untouched", fixed.memories[1] === stale[1]);
check("the input list is not mutated", stale[0].text.includes("Mochi"));

// MARK: - Refusals

check(
    "an unknown id is refused",
    correctMemory(stale, "nope", { text: "anything" }, now).error !== undefined,
);
check(
    "empty replacement text is refused",
    correctMemory(stale, "m1", { text: "   " }, now).error !== undefined,
);
check(
    "correcting one memory into the words of another is refused",
    correctMemory(stale, "m1", { text: "Seshi dislikes em-dashes." }, now).error?.includes("m2") === true,
);

const noop = correctMemory(stale, "m1", { text: stale[0].text.toUpperCase() }, now);
check("restating the same text is a no-op, not an error", noop.error === undefined && noop.note !== undefined);
check("a no-op retires nothing", noop.corrected?.priorText === undefined);

// MARK: - Category and clipping

const recategorised = correctMemory(stale, "m2", { text: "Seshi dislikes em-dashes.", category: "fact" }, now);
check("a category-only change applies", recategorised.corrected?.category === "fact");
check("a category-only change retires no wording", recategorised.corrected?.priorText === undefined);

const long = correctMemory(stale, "m1", { text: "x".repeat(MEMORY_TEXT_CAP + 50) }, now);
check("long corrections are clipped", (long.corrected?.text.length ?? 0) <= MEMORY_TEXT_CAP);

// MARK: - History is capped

let rolling = [note("m3", "version 0")];
for (let i = 1; i <= PRIOR_TEXT_CAP + 3; i += 1) {
    rolling = correctMemory(rolling, "m3", { text: `version ${i}` }, now + i).memories;
}
const history = rolling[0].priorText ?? [];
check("retired wordings are capped", history.length === PRIOR_TEXT_CAP, history.length);
check("the cap drops the oldest, not the newest", history[history.length - 1]?.text === `version ${PRIOR_TEXT_CAP + 2}`);
check("the live text is the newest correction", rolling[0].text === `version ${PRIOR_TEXT_CAP + 3}`);

// MARK: - What a dispatched agent is told, replayed from 22 September 2026

/**
 * The failure this section exists to prevent, in full.
 *
 * 21 Sep 15:59, the user, unprompted: "Amex - this is done. I confirmed that
 * the payment has gone through." A memory was written the same evening.
 *
 * 22 Sep 15:04, the daily briefing agent, having read the same inbox: the Amex
 * $460 is still outstanding. Orbit's own turn, in the same minute, off the same
 * store: "One correction: it's still flagging the Amex $460, which you told me
 * yesterday was paid."
 *
 * The parent was right and the child was wrong because only the parent had been
 * handed the memories. These checks assert the child is handed them too.
 */
const amex: MemoryNote = {
    id: "amex",
    category: "fact",
    text: "The $460.00 Amex corporate card balance was reimbursed and paid on 11 Aug 2026: it has no claim outstanding.",
    createdAt: now,
};

const briefingTask = "Produce a short executive briefing for the start of the user's day.";

const block = rememberedBlock([amex]);
check("a remembered block is produced when anything is known", block !== undefined);
check("it carries the memory text", block?.includes("no claim outstanding") === true);
check("it names the category", block?.includes("[fact]") === true);
check("nothing known produces no block", rememberedBlock([]) === undefined);

const briefed = buildAgentPrompt(briefingTask, undefined, block);
check("the briefing agent is now told about the Amex balance", briefed.includes("no claim outstanding"));
check("the task still survives alongside it", briefed.includes(briefingTask));
check(
    "what is remembered is read before the task, not after it",
    briefed.indexOf("<remembered>") < briefed.indexOf("<task>"),
);
check(
    "an agent dispatched with nothing remembered gets no empty block",
    !buildAgentPrompt(briefingTask, undefined, undefined).includes("<remembered>"),
);

/**
 * Selecting memories by relevance to the task was considered and rejected. This
 * is why: the task that failed never mentions the subject it got wrong.
 */
check(
    "the briefing task gives no clue that the Amex memory is the relevant one",
    !briefingTask.toLowerCase().includes("amex"),
);

/** Newest win, because a correction is always newer than the belief it corrects. */
const many: MemoryNote[] = Array.from({ length: MEMORY_CONTEXT_CAP + 5 }, (_, index) => ({
    id: `m${index}`,
    category: "fact",
    text: `memory number ${index}`,
    createdAt: now + index,
}));
const capped = rememberedBlock(many) ?? "";
check(
    "the block is capped",
    capped.split("\n").filter((line) => line.startsWith("- [")).length === MEMORY_CONTEXT_CAP,
);
check("the newest memory survives the cap", capped.includes(`memory number ${MEMORY_CONTEXT_CAP + 4}`));
check("the oldest memory is the one dropped", !capped.includes("memory number 0\n"));

// MARK: - The allowlist

check("agents may correct a memory", AGENT_TOOL_NAMES.includes("orbit_correct_memory"));
check("agents still may not delete one", FORBIDDEN_AGENT_TOOL_NAMES.includes("orbit_forget"));
check(
    "the allowlist and the forbidden list never overlap",
    AGENT_TOOL_NAMES.every((name) => !FORBIDDEN_AGENT_TOOL_NAMES.includes(name)),
);

const registered = [...AGENT_TOOL_NAMES, ...FORBIDDEN_AGENT_TOOL_NAMES].map((name) => ({ name }));
const selection = selectAgentTools(registered);
check("every allowlisted tool resolves", selection.missing.length === 0, selection.missing);
check(
    "selection hands over the correction tool",
    selection.tools.some((tool) => tool.name === "orbit_correct_memory"),
);
check(
    "selection withholds the delete tool",
    !selection.tools.some((tool) => tool.name === "orbit_forget"),
);

// MARK: - Report

if (failures.length > 0) {
    console.error(`memory verification FAILED: ${failures.length} of ${passed + failures.length}`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
}
console.log(`memory verification passed: ${passed} checks`);
