/**
 * Finding paths and links in prose.
 *
 *   npm run verify:paths
 *
 * This exists because of a defect Seshi reported on 21 Sep 2026. An agent
 * finished an adversarial review and reported it as
 * `**\/Users/.../files/2026-09-21 Adversarial review - Sachin PR.html**`. The
 * path scan stopped at the first space, so the candidate handed to main was
 * ".../files/2026-09-21", which has never existed. It failed the existence
 * check, so nothing rendered as a chip, so the document Seshi had just asked
 * for arrived as text he could not click and had to be opened by hand.
 *
 * That is not an exotic input: every deliverable Orbit writes is named
 * "<date> <title>.html", so every one of them has spaces in it. The fix is to
 * let a bare path keep reading past a space and offer main every reading, since
 * main is the only thing that can say which is real.
 *
 * Pure, so it runs without a browser or an Electron main process: the existence
 * check is a set here and a `stat` in the app.
 */
import { pathCandidates, splitPathSegments } from "../src/renderer/paths.js";

let passed = 0;
const failures: string[] = [];

function check(what: string, actual: unknown, expected: unknown): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
        passed += 1;
        return;
    }
    failures.push(`${what}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
}

function ok(what: string, condition: boolean): void {
    check(what, condition, true);
}

/** The render pass, given a filesystem that contains exactly `real`. */
function render(text: string, ...real: string[]): ReturnType<typeof splitPathSegments> {
    const set = new Set(real);
    return splitPathSegments(text, (path) => set.has(path));
}

/** What would actually become a clickable chip. */
function chips(text: string, ...real: string[]): string[] {
    return render(text, ...real)
        .filter((segment) => segment.path !== undefined && real.includes(segment.path))
        .map((segment) => segment.path as string);
}

// MARK: - The reported defect

const DELIVERABLE = "/Users/seshic/.copilot/session-state/e7bf1d8b/files/2026-09-21 Adversarial review - Sachin PR.html";
const REPORT = `Review complete. Nothing was posted to the PR. ${DELIVERABLE} Verdict: request changes.`;

ok(
    "the spaced deliverable is offered to main for checking",
    pathCandidates(REPORT).includes(DELIVERABLE),
);
check("and it is the chip that renders", chips(REPORT, DELIVERABLE), [DELIVERABLE]);
check(
    "while the prose after it stays prose",
    render(REPORT, DELIVERABLE)
        .filter((segment) => segment.path === undefined)
        .map((segment) => segment.text)
        .join(""),
    "Review complete. Nothing was posted to the PR.  Verdict: request changes.",
);

// The same report is what an agent actually emits: bold, so markdown hands the
// inner text to the path scan on its own.
check("bold delimiters are not swallowed into the path", chips(`**${DELIVERABLE}**`, DELIVERABLE), [DELIVERABLE]);

// MARK: - Not guessing when there is nothing to guess at

const PLAIN = "/tmp/notes.md";
check("an unspaced path still resolves", chips(`see ${PLAIN} for detail`, PLAIN), [PLAIN]);
check(
    "prose after a real path is never absorbed",
    render(`see ${PLAIN} for detail`, PLAIN)
        .filter((segment) => segment.path === undefined)
        .map((segment) => segment.text)
        .join(""),
    "see  for detail",
);
check("a sentence that merely looks pathish yields no chip", chips("try and/or /tmp/gone now"), []);
check("a trailing full stop belongs to the sentence", chips(`open ${PLAIN}.`, PLAIN), [PLAIN]);

// MARK: - The shorter reading wins when the longer one is fiction

const REAL = "/Users/seshic/reports";
check(
    "a directory followed by prose resolves to the directory",
    chips(`${REAL} holds the weekly files`, REAL),
    [REAL],
);
ok(
    "and the fictional longer readings were offered, not assumed",
    pathCandidates(`${REAL} holds the weekly files`).includes(`${REAL} holds the weekly`),
);

// With nothing confirmed at all, the old stop-at-whitespace reading is what is
// reported, so an unverified render is never worse than it was before.
check(
    "nothing confirmed falls back to the shortest reading",
    render(`${REAL} holds the weekly files`).find((segment) => segment.path !== undefined)?.path,
    REAL,
);

// MARK: - Bounds

const LONG = "/tmp/a b c d e f g h i j k l";
ok("growth is capped rather than eating the line", !pathCandidates(LONG).includes(LONG));
ok("but the readings it does offer are real prefixes", pathCandidates(LONG).every((path) => LONG.startsWith(path)));
check("a double space ends the path", chips("/tmp/one  two", "/tmp/one"), ["/tmp/one"]);
check(
    "a newline ends the path",
    chips("/tmp/one\ntwo", "/tmp/one"),
    ["/tmp/one"],
);
ok("a path is never grown across a newline", !pathCandidates("/tmp/one\ntwo").includes("/tmp/one two"));

// MARK: - Links are untouched by any of this

const URL = "https://example.com/a/b?x=1";
check("a link is still a link", render(`see ${URL} now`).find((s) => s.url !== undefined)?.url, URL);
check("and is never offered as a path", pathCandidates(`see ${URL} now`), []);
check(
    "a javascript: scheme stays inert text",
    render("javascript:alert(1) is not a link").some((segment) => segment.url !== undefined),
    false,
);

// MARK: - Quoted paths keep working

const QUOTED = "/Users/seshic/My Notes/a file.md";
check("a backticked spaced path resolves as before", chips(`open \`${QUOTED}\` please`, QUOTED), [QUOTED]);
check("a double-quoted spaced path resolves as before", chips(`open "${QUOTED}" please`, QUOTED), [QUOTED]);

if (failures.length > 0) {
    console.error(`\npaths: ${failures.length} failed, ${passed} passed\n`);
    for (const failure of failures) console.error(`  ✗ ${failure}\n`);
    process.exit(1);
}

console.log(`paths: ${passed} checks passed`);
