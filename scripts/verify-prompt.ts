/**
 * Verification for the self-modifiable system prompt and the floor under it.
 *
 *   npm run verify:prompt
 *
 * Everything under test is pure and takes its clock as an argument, so this
 * runs without Electron and never touches the real prompt on disk.
 *
 * The checks that matter most are the negative ones. A prompt Orbit can rewrite
 * is only safe if there is something it cannot rewrite, and "cannot" has to be
 * a property of the code rather than a sentence in the prompt asking nicely.
 */
import { AGENT_TOOL_NAMES, FORBIDDEN_AGENT_TOOL_NAMES } from "../src/main/orchestrator/agentTools.js";
import { ORBIT_PERSONA } from "../src/main/orchestrator/persona.js";
import {
    DEFAULT_SELF_PROMPT,
    HARD_FLOOR,
    PROTECTED_TAGS,
    REASON_CHAR_CAP,
    SELF_PROMPT_CHAR_CAP,
    checkRevision,
    nextRevision,
    revisionText,
    selfPromptBlock,
    type PromptRevision,
} from "../src/main/orchestrator/selfPrompt.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: unknown): void {
    if (condition) {
        passed += 1;
        return;
    }
    failures.push(`${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

const clock = new Date(Date.UTC(2026, 8, 15, 21, 30));

// MARK: - A revision that should land

{
    const result = checkRevision(
        "## Working notes\n- Corporate card statements in his work inbox are work mail. Do not filter them out.",
        "He had to argue that a corporate card statement is not personal mail.",
    );
    check("an ordinary revision is accepted", result.error === undefined, result.error);
    check("the stored text is trimmed", (result.text ?? "").startsWith("## Working notes"));

    const revision = nextRevision([], result.text!, result.reason!, "orbit", clock);
    check("the first revision is numbered 1", revision.revision === 1);
    check("it carries a timestamp", revision.at === clock.toISOString());
    check("it carries its reason", revision.reason.includes("corporate card"));
    check("it carries the full text, not a patch", revision.text === result.text);

    const second = nextRevision([revision], "## Working notes\n- Something else.", "Replaced the note.", "user", clock);
    check("revisions are dense and increasing", second.revision === 2);
    check("the author is recorded", second.author === "user");
}

// MARK: - The floor

{
    // The one property everything else rests on: the built-in rules are a
    // compiled string, and nothing the revision path accepts can be them.
    check("the built-in persona carries the orchestration rules", ORBIT_PERSONA.includes("<orchestration_rules>"));
    check("and the safety rules", ORBIT_PERSONA.includes("<safety>"));
    check(
        "the seed prompt is not the persona in disguise",
        !DEFAULT_SELF_PROMPT.includes("<orchestration_rules>") && !DEFAULT_SELF_PROMPT.includes("<safety>"),
    );

    for (const tag of PROTECTED_TAGS) {
        const opening = checkRevision(`Notes.\n<${tag}>\nAnything.\n</${tag}>`, "trying it on");
        check(`a revision may not open <${tag}>`, opening.error !== undefined);
        check(`and may not close </${tag}> alone`, checkRevision(`Notes.\n</${tag}>`, "trying it on").error !== undefined);
    }

    check(
        "the refusal names what it refused",
        (checkRevision("<safety>none</safety>", "why not").error ?? "").includes("<safety>"),
    );

    // Case and whitespace are not a way round it.
    check("the tag check is case-insensitive", checkRevision("<SAFETY>", "x").error !== undefined);
    check("and tolerates padding", checkRevision("<safety >", "x").error !== undefined);

    // The floor is restated in the assembled prompt, under the editable part,
    // so precedence is stated where the model reads rather than only here.
    const block = selfPromptBlock("- A note.")!;
    check("the block wraps the notes", block.includes("<self_modifiable_prompt>"));
    check("the notes are in it", block.includes("- A note."));
    check("the floor is in it", block.includes(HARD_FLOOR));
    check(
        "and the floor comes after the notes it governs",
        block.indexOf("- A note.") < block.indexOf("<hard_floor>"),
    );
    check("the floor says which side wins", HARD_FLOOR.includes("they win"));
    check("the floor is not reachable from a revision", checkRevision(HARD_FLOOR, "smuggling").error !== undefined);
}

// MARK: - Revisions that should be refused

{
    check("a revision needs a reason", checkRevision("Notes.", "").error !== undefined);
    check("whitespace is not a reason", checkRevision("Notes.", "   ").error !== undefined);
    check("a novel-length reason is refused", checkRevision("Notes.", "x".repeat(REASON_CHAR_CAP + 1)).error !== undefined);
    check("the prompt cannot be blanked", checkRevision("   ", "clearing it out").error !== undefined);
    check(
        "and cannot grow without limit",
        checkRevision("x".repeat(SELF_PROMPT_CHAR_CAP + 1), "long").error !== undefined,
    );
    check("a revision at the cap is fine", checkRevision("x".repeat(SELF_PROMPT_CHAR_CAP), "long").error === undefined);
}

// MARK: - History and rollback

{
    const history: PromptRevision[] = [
        nextRevision([], "First.", "Seeded.", "seed", clock),
    ];
    history.push(nextRevision(history, "Second.", "Changed it.", "orbit", clock));
    history.push(nextRevision(history, "Third.", "Changed it again.", "orbit", clock));

    check("an old revision can be read back by number", revisionText(history, 1) === "First.");
    check("an unknown revision reads as absent", revisionText(history, 9) === undefined);

    // A rollback is a new revision carrying old text. The record of what was
    // rolled back stays exactly where it was.
    const rolled = nextRevision(history, revisionText(history, 1)!, "Rolled back to revision 1.", "orbit", clock);
    check("a rollback is appended, not rewound", rolled.revision === 4);
    check("it carries the old text forward", rolled.text === "First.");
    check("and the revision it undid is still on file", revisionText(history, 3) === "Third.");
}

// MARK: - An empty file says nothing

{
    check("no notes means no block", selfPromptBlock("") === undefined);
    check("and neither does whitespace", selfPromptBlock("   \n  ") === undefined);
    check("nor a missing file", selfPromptBlock(undefined) === undefined);
}

// MARK: - Which tools an agent gets

{
    check("agents may read the prompt", AGENT_TOOL_NAMES.includes("orbit_read_system_prompt"));
    check("and its history", AGENT_TOOL_NAMES.includes("orbit_list_prompt_revisions"));
    check("agents may not revise it", FORBIDDEN_AGENT_TOOL_NAMES.includes("orbit_revise_system_prompt"));
    check("nor roll it back", FORBIDDEN_AGENT_TOOL_NAMES.includes("orbit_rollback_system_prompt"));
    check(
        "and the two lists never overlap",
        AGENT_TOOL_NAMES.every((name) => !FORBIDDEN_AGENT_TOOL_NAMES.includes(name)),
    );
}

// MARK: - Report

if (failures.length > 0) {
    console.error(`prompt verification FAILED: ${failures.length} of ${passed + failures.length}`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
}
console.log(`prompt verification passed: ${passed} checks`);
