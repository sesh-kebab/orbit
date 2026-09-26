/**
 * Checks for the tools an agent is given.
 *
 *   npm run verify:agent-tools
 *
 * Two of these matter more than the rest. The first is that the allowlist and
 * the registered tool names stay in agreement: the failure this whole module
 * exists to prevent is silent, an agent simply not having a tool and writing
 * state files on disk instead, and a rename would reintroduce it without
 * anything going red. The second is that no control-plane tool ever drifts into
 * the allowlist, checked against the forbidden list as a set rather than
 * against a handful written out by hand.
 *
 * The registered names are read out of `orchestrator.ts` as text rather than by
 * importing it. That file pulls in Electron and the whole store; parsing the
 * `defineTool("...")` call sites is uglier but keeps this check runnable in CI
 * without a display, and it is the real list either way.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    AGENT_TOOL_NAMES,
    FORBIDDEN_AGENT_TOOL_NAMES,
    selectAgentTools,
} from "../src/main/orchestrator/agentTools.js";

let passed = 0;
const failures: string[] = [];

function ok(what: string, condition: boolean): void {
    if (condition) {
        passed++;
        return;
    }
    failures.push(what);
}

function check(what: string, actual: unknown, expected: unknown): void {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a === b) {
        passed++;
        return;
    }
    failures.push(`${what}\n    expected ${b}\n    actual   ${a}`);
}

// The bundle this runs from lives in node_modules/.cache, so `import.meta.url`
// points at the wrong tree. npm runs scripts from the package root.
const here = join(process.cwd(), "src/main/orchestrator");
const orchestrator = readFileSync(join(here, "orchestrator.ts"), "utf8");
const registered = [...orchestrator.matchAll(/defineTool\(\s*"(orbit_[a-z_]+)"/g)].map((m) => m[1]);

// MARK: - The list is real

ok("orchestrator registers tools at all", registered.length > 0);
ok("more tools are registered than an agent is given", registered.length > AGENT_TOOL_NAMES.length);

const registeredSet = new Set(registered);
check(
    "every allowlisted tool is actually registered",
    AGENT_TOOL_NAMES.filter((name) => !registeredSet.has(name)),
    [],
);
check(
    "every forbidden tool is actually registered, so the denial means something",
    FORBIDDEN_AGENT_TOOL_NAMES.filter((name) => !registeredSet.has(name)),
    [],
);

// Every registered tool is classified one way or the other. This is what makes
// a tool added later a deliberate decision: it fails here until someone says
// whether an agent may have it.
const classified = new Set([...AGENT_TOOL_NAMES, ...FORBIDDEN_AGENT_TOOL_NAMES]);
check(
    "no registered tool is left unclassified",
    registered.filter((name) => !classified.has(name)),
    [],
);

// MARK: - The invariant

const allowed = new Set(AGENT_TOOL_NAMES);
check(
    "no control-plane tool is in the agent allowlist",
    FORBIDDEN_AGENT_TOOL_NAMES.filter((name) => allowed.has(name)),
    [],
);
check("the allowlist has no duplicates", AGENT_TOOL_NAMES.length, allowed.size);

// Spelled out rather than derived from a prefix, because the point is the
// capability and not the name: an agent that can restart the app or rewrite a
// schedule can change what runs, which is Orbit's job and not a worker's.
for (const name of [
    "orbit_spawn_agent",
    "orbit_soft_restart",
    "orbit_update_schedule",
    "orbit_cancel_schedule",
    "orbit_set_leave",
    "orbit_forget",
]) {
    ok(`${name} is withheld from agents`, !allowed.has(name));
}

// MARK: - Retiring a watcher

// The one allowlisted tool that changes what Orbit runs. It is allowed because
// it can only stop a dead watcher, so these checks are about the difference
// between it and the tool that stays forbidden, not about it being present.
ok("an agent can retire a watcher", allowed.has("orbit_archive_schedule"));
ok(
    "retiring is a separate tool from amending, so the narrow one can be granted alone",
    allowed.has("orbit_archive_schedule") && !allowed.has("orbit_update_schedule"),
);

const archiveStart = orchestrator.indexOf('defineTool("orbit_archive_schedule"');
const archiveEnd = orchestrator.indexOf('defineTool("orbit_update_schedule"', archiveStart);
ok("the retire tool exists in the orchestrator", archiveStart > 0 && archiveEnd > archiveStart);
const archiveBody = orchestrator.slice(archiveStart, archiveEnd);

ok("retiring demands a reason for the record", /reason:\s*z[\s\S]{0,40}\.string\(\)/.test(archiveBody));
ok("retiring is gated on retirementCase", /retirementCase\(target\)/.test(archiveBody));
ok("a watcher that has not earned it is refused", /if\s*\(!verdict\.retirable\)/.test(archiveBody));
ok("the refusal points at the open-items route", /orbit_raise_open_item/.test(archiveBody));
ok("the reason is persisted", /archivedReason\s*=\s*reason/.test(archiveBody));

// The direction matters: this tool must not be a way to switch a watcher back
// on, which is the control-plane half of archiving.
ok("retiring only ever archives", !/archived\s*=\s*false/.test(archiveBody));
// Nor a way to smuggle in the edits `orbit_update_schedule` is withheld for.
for (const field of ["task", "title", "cadence", "enabled", "runDays"]) {
    ok(`retiring cannot change ${field}`, !new RegExp(`schedule\\.${field}\\s*=[^=]`).test(archiveBody));
}

// The four tools the nightly reflection cannot do its job without. These are
// the regression: it was asked to review proposals and file decisions and had
// no way to do either.
for (const name of [
    "orbit_list_proposals",
    "orbit_record_proposal",
    "orbit_update_proposal",
    "orbit_raise_open_item",
]) {
    ok(`${name} reaches agents`, allowed.has(name));
}

// MARK: - Selection

type FakeTool = { name: string };
const all: FakeTool[] = registered.map((name) => ({ name }));

const selection = selectAgentTools(all);
check("selection reports nothing missing against the real tool list", selection.missing, []);
check("selection returns exactly the allowlist", selection.tools.length, AGENT_TOOL_NAMES.length);
check(
    "selection returns no forbidden tool",
    selection.tools.filter((tool) => FORBIDDEN_AGENT_TOOL_NAMES.includes(tool.name)).map((t) => t.name),
    [],
);
check(
    "selection preserves the order the tools were registered in",
    selection.tools.map((tool) => tool.name),
    registered.filter((name) => allowed.has(name)),
);

// A renamed tool is the silent failure this guards. Drop one and the selection
// must say so rather than quietly returning a shorter list.
const renamed = all.filter((tool) => tool.name !== "orbit_record_proposal");
const afterRename = selectAgentTools(renamed);
check("a renamed tool is reported as missing", afterRename.missing, ["orbit_record_proposal"]);
check(
    "a renamed tool does not silently reappear",
    afterRename.tools.some((tool) => tool.name === "orbit_record_proposal"),
    false,
);

check("an empty tool list reports every allowlisted name missing", selectAgentTools([]).missing, [
    ...AGENT_TOOL_NAMES,
]);
check("an empty tool list selects nothing", selectAgentTools([]).tools, []);
check("an unknown tool is never selected", selectAgentTools([{ name: "bash" }]).tools, []);

// MARK: - Wiring

const runner = readFileSync(join(here, "agentRunner.ts"), "utf8");
ok("the agent session is created with tools", /tools:\s*this\.hooks\.getAgentTools\(\)/.test(runner));
ok("the hooks declare getAgentTools", /getAgentTools\(\):\s*Tool<any>\[\]/.test(runner));
ok(
    "the orchestrator supplies the hook",
    /getAgentTools:\s*\(\)\s*=>\s*this\.agentTools\(\)/.test(orchestrator),
);
ok("the orchestrator filters through selectAgentTools", /selectAgentTools\(this\.orbitTools\(\)\)/.test(orchestrator));

// `availableTools` unset means every tool is enabled, which is what lets the
// agent keep its file and shell tools while gaining these. Setting it on the
// agent session without also restating the built-ins would take the work away.
// Matched as a property assignment: the word also appears in the comment that
// explains why it is absent.
ok("the agent session leaves availableTools unset", !/^\s*availableTools:/m.test(runner));

// MARK: - Prose must not send an agent at a tool it cannot have

/**
 * A tool's own words are as binding as its schema, and they drift apart
 * silently. `orbit_list_memories` returned advice reading "merge with
 * orbit_correct_memory, then orbit_forget the loser", and `orbit_remember`
 * said the same on every near-duplicate write. Both were true when written and
 * became wrong the night `orbit_merge_memories` shipped, because `orbit_forget`
 * is forbidden to agents on purpose: nothing an agent does to a memory may
 * destroy it. So two allowlisted tools sent every reader at a tool that is not
 * in its list, and the fallback for a missing tool is improvisation.
 *
 * Nothing went red, because no check ever read the prose. This one does.
 *
 * Only prose an agent can actually reach counts. A forbidden tool's own
 * description may name another forbidden tool: `orbit_cancel_schedule` pointing
 * at `orbit_update_schedule` is a correct cross-reference that no agent is ever
 * shown. Scoping by the owning tool is the difference between a check that
 * fails on real misdirection and one that fails on correct writing, and the
 * second kind gets deleted rather than fixed.
 */
const ownedProse = registered.map((name, index) => {
    const from = orchestrator.indexOf(`defineTool("${name}"`);
    const next = registered[index + 1];
    const to = next ? orchestrator.indexOf(`defineTool("${next}"`) : orchestrator.length;
    return { name, body: orchestrator.slice(from, to > from ? to : orchestrator.length) };
});
ok("every registered tool's body was located", ownedProse.every((entry) => entry.body.length > 0));

// Response advice is written outside the tool body, in the handler's own
// method, so it is scanned separately: any `advice:` string anywhere in the
// file reaches whoever called the tool that produced it.
const adviceStrings = [...orchestrator.matchAll(/advice:\s*(?:\n\s*)?"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
ok("the advice strings are being read", adviceStrings.length > 0);

const reachable = [
    ...ownedProse
        .filter((entry) => allowed.has(entry.name))
        .flatMap((entry) =>
            [...entry.body.matchAll(/description:\s*(?:\n\s*)?"((?:[^"\\]|\\.)*)"/g)].map((m) => ({
                where: entry.name,
                text: m[1],
            })),
        ),
    ...adviceStrings.map((text) => ({ where: "a tool response", text })),
];
ok("agent-reachable prose is actually being read", reachable.length > 10);

const misdirections = FORBIDDEN_AGENT_TOOL_NAMES.flatMap((name) =>
    reachable.filter((entry) => entry.text.includes(name)).map((entry) => `${name} named by ${entry.where}`),
);
check("no prose an agent can read points it at a forbidden tool", misdirections, []);

// And the positive half: the advice that replaced it names the tool that does
// exist, so the pairs it reports are actionable rather than just observed.
const duplicateAdvice = adviceStrings.find((line) => line.includes("written twice"));
ok("the duplicate-pair advice is still there", duplicateAdvice !== undefined);
ok(
    "and it points at the tool an agent actually has",
    duplicateAdvice !== undefined && duplicateAdvice.includes("orbit_merge_memories"),
);
ok(
    "and it warns that complementary records are not duplicates",
    duplicateAdvice !== undefined && duplicateAdvice.includes("not duplicates"),
);

// The same advice is given at write time, where the near-duplicate is first
// noticed. That is the one a live agent hits most often.
const atWrite = adviceStrings.find((line) => line.startsWith("Stored anyway"));
ok("a near-duplicate write still says what it resembles", atWrite !== undefined);
ok(
    "and sends the writer at the non-destructive tool",
    atWrite !== undefined && atWrite.includes("orbit_merge_memories"),
);

// MARK: - Report

const preamble = readFileSync(join(here, "persona.ts"), "utf8");
ok("agents are told the orbit_ tools exist", /prefixed orbit_/.test(preamble));
ok("agents are told not to edit state files on disk", /state files on disk/.test(preamble));

if (failures.length > 0) {
    console.error(`\n${failures.length} failed:\n`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    console.error(`\n${passed} passed, ${failures.length} failed.\n`);
    process.exit(1);
}

console.log(`${passed} checks passed.`);
