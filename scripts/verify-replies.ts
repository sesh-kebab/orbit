/**
 * Verification for quick-reply threading.
 *
 *   npm run verify:replies
 *
 * The case that matters is the one the user described: several questions
 * outstanding, a chip clicked on one of them, and a message reading "yes" that
 * neither he nor Orbit can attach to anything. So the checks below are about
 * two outputs of one decision — the quote drawn above his bubble, and the
 * prefix on the turn the model receives — and the fact that they are the same
 * sentence.
 *
 * Everything here is pure. No Electron, no renderer, no store.
 */
import { QUOTE_MAX, buildReplyPrompt, quoteQuestion } from "../src/main/orchestrator/replies.js";
import { parseChoices } from "../src/main/orchestrator/choices.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: unknown): void {
    if (condition) {
        passed += 1;
        return;
    }
    failures.push(`${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
    check(name, Object.is(actual, expected), { actual, expected });
}

// ── The quote ────────────────────────────────────────────────────────────────

eq(
    "a one-line question is quoted whole",
    quoteQuestion("Shall I merge the branch?"),
    "Shall I merge the branch?",
);

eq(
    "the question wins over the context before it",
    quoteQuestion("The agent finished and the tests pass. Shall I merge the branch?"),
    "Shall I merge the branch?",
);

eq(
    "the last question wins when there are two",
    quoteQuestion("Shall I merge it? Or do you want to read the diff first?"),
    "Or do you want to read the diff first?",
);

eq(
    "markdown furniture is dropped",
    quoteQuestion("## Ready to ship\n\n- tests pass\n- **build** is green\n\nShip it?"),
    "Ship it?",
);

eq(
    "a code fence never ends up in the quote",
    quoteQuestion("Here it is:\n\n```\nnpm run build\n```\n\nRun it?"),
    "Run it?",
);

eq(
    "a statement with no question mark falls back to its last sentence",
    quoteQuestion("I drafted the reply. Tell me whether to send it."),
    "Tell me whether to send it.",
);

eq("an empty message quotes to nothing", quoteQuestion("   \n  "), "");

const longQuestion = `Do you want me to ${"escalate this to the wider group and then ".repeat(10)}wait?`;
const long = quoteQuestion(longQuestion);
check("a long question is truncated", long.length <= QUOTE_MAX + 1, long.length);
check("truncation is marked with an ellipsis", long.endsWith("…"), long);
check("truncation lands on a word boundary", longQuestion.startsWith(`${long.slice(0, -1)} `), long);

// ── The prompt the model sees ────────────────────────────────────────────────

const threaded = buildReplyPrompt("yes", "Shall I merge the branch?");
check("a bare yes carries its question", threaded.includes("Shall I merge the branch?"), threaded);
check("the answer survives intact", threaded.includes("yes"), threaded);
check(
    "the question comes before the answer, because the answer is meaningless first",
    threaded.indexOf("Shall I merge") < threaded.indexOf("yes"),
    threaded,
);

eq("a typed message with no quote is sent exactly as typed", buildReplyPrompt("yes", undefined), "yes");
eq("an empty quote is the same as no quote", buildReplyPrompt("yes", "  "), "yes");
eq("an empty answer stays empty", buildReplyPrompt("   ", "Ship it?"), "");

// ── The two halves agree ─────────────────────────────────────────────────────

const question = "The branch is green. Shall I merge and push it?";
const quoted = quoteQuestion(question);
check(
    "the quote shown on screen is the quote sent to the model",
    buildReplyPrompt("go on then", quoted).includes(quoted),
    { quoted },
);

// ── End to end, from the marker Orbit writes ─────────────────────────────────

const raw = "Two things landed and the suites pass. Merge it?\n\n[[choices: Merge :: yes, merge it | Wait]]";
const parsed = parseChoices(raw);
eq("the marker is stripped before quoting", parsed.text, "Two things landed and the suites pass. Merge it?");
eq("the chip still carries its reply text", parsed.choices?.[0]?.value, "yes, merge it");
eq("the quote taken from the stripped text is the question", quoteQuestion(parsed.text), "Merge it?");
check(
    "the marker never leaks into the model prompt",
    !buildReplyPrompt(parsed.choices?.[0]?.value ?? "", quoteQuestion(parsed.text)).includes("[[choices"),
);

// ── Report ───────────────────────────────────────────────────────────────────

if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed:\n`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    console.error("");
    process.exit(1);
}

console.log(`All ${passed} quick-reply threading checks passed.`);
