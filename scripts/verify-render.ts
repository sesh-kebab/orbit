/**
 * Renders Mission Control headlessly and reads the result as markup.
 *
 *   npm run verify:render
 *
 * This exists because the last change to this panel shipped two defects that
 * every type in the codebase was happy with — a clock column that rendered
 * "216h 0m" into a space built for "3d", and two clocks measuring from
 * different instants. Both were caught by rendering the thing and reading it,
 * and that check was thrown away afterwards. This is it kept.
 *
 * It is `react-dom/server` against the capture harness's fixture, which builds
 * its board through the real `deriveBoard`. No browser, no Electron, no
 * dependency that was not already installed. Effects do not run under static
 * rendering, so anything that only appears after a round trip to main — the
 * on-disk check behind artifact rows — is deliberately out of scope here and
 * is asserted on its pre-effect state instead.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MissionControl } from "../src/renderer/components/MissionControl.js";
import { Message } from "../src/renderer/components/Message.js";
import { NavRail, railState } from "../src/renderer/components/NavRail.js";
import { DECK_SECTIONS, isDeckSection, type ChatMessage, type DeckSection, type OrbitState } from "../src/shared/types.js";
import { AGENTS, EPOCH, REQUEST, SCHEDULES, baseState } from "../tools/capture/demo.js";

let passed = 0;
const failures: string[] = [];

function check(what: string, actual: unknown, expected: unknown): void {
    if (Object.is(actual, expected)) {
        passed += 1;
        return;
    }
    failures.push(`${what}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
}

function ok(what: string, condition: boolean): void {
    check(what, condition, true);
}

/**
 * The rail and the pane, composed the way `ChatPanel` composes them. The rail
 * moved out of Mission Control and is drawn permanently above it, so rendering
 * Mission Control alone would no longer render the thing half these checks are
 * about.
 */
function render(state: OrbitState, open = true): string {
    const section = isDeckSection(state.settings.deckSection) ? state.settings.deckSection : "board";
    return renderToStaticMarkup(
        createElement(
            "div",
            null,
            createElement(NavRail, {
                state,
                section,
                open,
                orientation: "bar" as const,
                onSelect: () => undefined,
            }),
            open ? createElement(MissionControl, { state, section }) : undefined,
        ),
    );
}

/** Markup with the tags taken out, which is what the user actually reads. */
function text(markup: string): string {
    return markup
        .replace(/<[^>]*>/g, " ")
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim();
}

function count(markup: string, needle: string): number {
    return markup.split(needle).length - 1;
}

function posed(patch: Partial<OrbitState> = {}, section: DeckSection = "board"): OrbitState {
    const state = baseState(patch);
    return { ...state, settings: { ...state.settings, deckSection: section } };
}

// MARK: - The rail itself

{
    const markup = render(posed());

    check("the rail has one button per section", count(markup, 'class="rail-tab'), DECK_SECTIONS.length);
    // The cap is the point, not the number: additional UI was allowed, a more
    // complicated application was not. Six is five plus the viewer, which is a
    // place the user is sent to by clicking a file rather than a new idea.
    check("six sections, no more", DECK_SECTIONS.length, 6);
    ok("the rail is a landmark", markup.includes('aria-label="Mission control sections"'));

    for (const label of ["board", "work", "memory", "read", "log", "look"]) {
        ok(`the rail carries "${label}"`, markup.includes(`class="rail-label">${label}<`));
    }

    // `look` is separated from the four that say what Orbit is doing.
    ok("appearance is pushed to the foot of the rail", markup.includes('class="rail-spacer"'));
    ok(
        "the spacer sits above look and below the rest",
        markup.indexOf('class="rail-spacer"') > markup.indexOf(">log<") &&
            markup.indexOf('class="rail-spacer"') < markup.indexOf(">look<"),
    );

    // One pane, not a stack. The board's lanes must not be on screen at the
    // same time as the watcher list; that was the whole complaint.
    ok("the deck has a single scrolling pane", count(markup, 'class="deck-body"') === 1);
    ok("the foot survives the rail", markup.includes('class="deck-foot"'));
}

// MARK: - The rail is permanent

{
    // The rail outlives the pane it opens. With Mission Control closed there is
    // still a full rail on screen, which is the entire point of moving it out.
    const shut = render(posed(), false);

    check("the rail is drawn with the pane closed", count(shut, 'class="rail-tab'), DECK_SECTIONS.length);
    ok("and the pane really is closed", !shut.includes('class="deck-body"'));
    check("nothing claims to be the current section", count(shut, 'aria-current="page"'), 0);
    check("and nothing is drawn as selected", count(shut, 'class="rail-tab on"'), 0);

    // Badges are the reason it is permanent: a decision waiting on him has to
    // be visible while he is reading the transcript, not only once he opens the
    // thing that would have told him.
    const blocked = render(posed({ agents: [AGENTS.flaky], requests: [REQUEST] }), false);
    ok("a blocked agent still shows through a closed pane", blocked.includes("rail-badge attention"));

    // Horizontal, because the panel floor is 440px wide and the vertical rail
    // took 58px of it away from the transcript permanently.
    ok("the permanent rail is the horizontal one", shut.includes('class="deck-rail bar"'));
}

// MARK: - One section at a time

{
    const state = posed({ agents: [AGENTS.flaky, AGENTS.deps] });

    for (const section of DECK_SECTIONS) {
        const markup = render({ ...state, settings: { ...state.settings, deckSection: section } });
        ok(`${section} renders something`, text(markup).length > 40);
        check(`${section} is the current section`, count(markup, 'aria-current="page"'), 1);
    }

    const board = render({ ...state, settings: { ...state.settings, deckSection: "board" } });
    const work = render({ ...state, settings: { ...state.settings, deckSection: "work" } });

    ok("the board section draws lanes", board.includes('class="deck-list board"'));
    ok("the board section does not also draw the watcher list", !board.includes("watching"));
    ok("the work section draws the watcher list", work.includes(">watching<"));
    ok("the work section draws delegated agents", work.includes(">delegated<"));
    ok("the work section does not also draw the board", !work.includes('class="deck-list board"'));
}

// MARK: - Folding agents and watchers into one section

{
    const empty = render(posed({ agents: [], schedules: [] }, "work"));
    ok("an empty work section still says what belongs there", empty.includes(">delegated<") && empty.includes(">watching<"));
    ok("and explains the emptiness", text(empty).includes("Nothing delegated yet"));
    ok("both halves, one pane", count(empty, 'class="deck-body"') === 1);

    const full = render(posed({ agents: [AGENTS.flaky], schedules: SCHEDULES }, "work"));
    ok("the watchers keep their controls", full.includes('aria-label="Run this watcher now"'));
    ok("the watchers keep archiving", full.includes('aria-label="Archive this watcher"'));
}

// MARK: - What the rail says without being clicked

{
    // Nothing on him: nothing red anywhere.
    const calm = posed({ agents: [], requests: [], openItems: [], schedules: [] });
    const calmState = { ...calm, board: { ...calm.board, threads: [], artifacts: [] } };
    check("no attention badge when nothing is on him", count(render(calmState), "rail-badge attention"), 0);

    // An agent stopped dead waiting for approval is on him, and the rail must
    // say so from whichever section he happens to be looking at.
    const blocked = posed({ agents: [AGENTS.flaky], requests: [REQUEST] }, "look");
    const blockedMarkup = render(blocked);
    ok(
        "a blocked agent is visible without selecting its section",
        blockedMarkup.includes("rail-badge attention"),
    );
    check("work is flagged, in words too", railState(blocked, "work").attention, 1);
    ok(
        "and the reason is spoken, not just coloured",
        (railState(blocked, "work").why ?? "").includes("approval"),
    );

    // Running work is context, not a demand: counted, never red.
    const running = posed({ agents: [AGENTS.flaky, AGENTS.deps], requests: [] });
    check("running agents are counted quietly", railState(running, "work").count, 2);
    check("and never flagged", railState(running, "work").attention, undefined);

    // Decisions waiting on him.
    const waiting = posed({
        openItems: [
            { id: "o1", at: EPOCH - 400_000, text: "Pick a database", source: "nightly", resolved: false },
            { id: "o2", at: EPOCH - 900_000, text: "Approve the budget", source: "nightly", resolved: true },
        ],
    });
    check("unresolved decisions are flagged", railState(waiting, "memory").attention, 1);
    check("resolved ones are not", railState({ ...waiting, openItems: [] }, "memory").attention, undefined);

    // The board badge counts only what will not move without him.
    const onYou = baseState({ requests: [REQUEST], agents: [AGENTS.flaky] });
    check(
        "the board badge is the on-you lane, not everything in flight",
        railState(onYou, "board").attention,
        onYou.board.threads.filter((thread) => thread.lane === "you").length,
    );
    ok("which is fewer than every thread", onYou.board.threads.length > (railState(onYou, "board").attention ?? 0));

    // Unopened artifacts are worth a glance and no more.
    const madeOnly = baseState();
    const quiet = {
        ...madeOnly,
        board: { ...madeOnly.board, threads: [], artifacts: madeOnly.board.artifacts },
    };
    if (quiet.board.artifacts.some((artifact) => !artifact.opened)) {
        check("unopened work gets a dot, not a number", railState(quiet, "board").dot, true);
        check("and is never red", railState(quiet, "board").attention, undefined);
    }

    // The log and the appearance settings never demand anything.
    for (const section of ["log", "look"] as const) {
        check(`${section} never shouts`, railState(blocked, section).attention, undefined);
        check(`${section} never counts`, railState(blocked, section).count, undefined);
    }
}

// MARK: - Everything the board could already do, it still does

{
    const state = posed({ agents: [AGENTS.flaky] }, "board");
    const markup = render(state);

    const artifacts = state.board.artifacts;
    ok("the fixture has artifacts to check", artifacts.length > 0);

    // Rows are buttons, so they are clickable and reachable by keyboard.
    ok("artifact rows are buttons", markup.includes('class="thread artifact"'));
    ok("alt-click is advertised", markup.includes("Alt-click to show in Finder"));

    // An artifact has two entrances — under the thread that made it, and in
    // "made for you" — so the dot is expected on both, and only on the ones
    // Orbit has not seen him open.
    const unopened = artifacts.filter((artifact) => !artifact.opened).length;
    const unopenedUnderThreads = state.board.threads.reduce(
        (total, thread) => total + (thread.artifacts ?? []).filter((artifact) => !artifact.opened).length,
        0,
    );
    check(
        "unread dots follow openedAt",
        count(markup, "thread-mark artifact-new"),
        unopened + unopenedUnderThreads,
    );
    ok("at least one artifact is read, so the dot is not just always on", unopened < artifacts.length);

    // Threads carry what they produced.
    ok("threads carry their artifacts", markup.includes('class="thread-made"'));

    // Blind spots and judgement survive.
    ok("the judgement is still on top", markup.includes('class="board-calls"'));
    ok(
        "the calls still carry their confidence",
        state.board.calls.length === 0 || markup.includes("class=\"tag conf conf-"),
    );
}

// MARK: - Nothing renders wider than the pane it sits in

{
    // The clock column is the narrowest thing on the board and the defect that
    // got through last time. Anything long enough to blow it out fails here.
    const markup = render(posed({ agents: [AGENTS.flaky, AGENTS.deps] }, "board"));
    const clocks = [...markup.matchAll(/class="thread-clock"[^>]*>([^<]*)</g)].map((m) => m[1]!.trim());
    ok("the board renders clocks", clocks.length > 0);
    for (const clock of clocks) {
        ok(`clock "${clock}" fits its column`, clock.length <= 6);
    }

    // The same column in the work section. An agent blocked on a permission
    // request with the timeout disabled sits there for as long as it takes him
    // to answer, so this one is fed a genuinely old agent rather than a fresh
    // fixture — the case that used to render "216h 0m".
    const old = {
        ...AGENTS.flaky,
        status: "needs-input" as const,
        createdAt: Date.now() - 9 * 86_400_000,
        endedAt: undefined,
    };
    const stale = render(posed({ agents: [old], requests: [REQUEST] }, "work"));
    const ages = [...stale.matchAll(/class="agent-meta">([^<]*)</g)].map((m) => m[1]!.trim());
    ok("the work section renders an agent's age", ages.length > 0);
    for (const age of ages) {
        ok(`age "${age}" fits its column`, age.length <= 7);
    }
    ok("a nine day wait reads in days", ages.some((age) => age === "9d"));

    // Rail labels sit in 58px minus padding. Anything long wraps or clips.
    const labels = [...markup.matchAll(/class="rail-label">([^<]*)</g)].map((m) => m[1]!);
    check("every section has a label", labels.length, DECK_SECTIONS.length);
    for (const label of labels) {
        ok(`rail label "${label}" fits the rail`, label.length <= 7);
    }
}

// MARK: - The remembered section

{
    for (const section of DECK_SECTIONS) {
        const markup = render(posed({}, section));
        const current = /class="rail-tab on"[\s\S]*?class="rail-label">([a-z]+)</.exec(markup);
        check(`a saved "${section}" reopens on ${section}`, current?.[1], section);
    }

    // A section id from an older build, or a hand-edited settings.json, must
    // not leave the pane blank.
    const state = baseState();
    const bogus = { ...state, settings: { ...state.settings, deckSection: "agents" as DeckSection } };
    const markup = render(bogus);
    check("an unknown saved section falls back to the board", count(markup, 'class="rail-tab on"'), 1);
    ok("and it is the board", /class="rail-tab on"[\s\S]*?class="rail-label">board</.test(markup));
}

// MARK: - Quick-reply threading
//
// The user could not tell which question a chip's "yes" was answering, and said
// he would not expect Orbit to either. Two things follow from that, and both are
// visible in the markup: a quoted header above his bubble, and chips that do not
// expire just because a later turn happened.

{
    const question: ChatMessage = {
        id: "q1",
        role: "orbit",
        text: "The branch is green and the suites pass. Shall I merge and push it?",
        kind: { type: "text" },
        at: EPOCH - 60_000,
        choices: [
            { label: "Merge", value: "yes, merge it" },
            { label: "Wait", value: "not yet" },
        ],
    };
    const elsewhere: ChatMessage = {
        id: "u1",
        role: "user",
        text: "what did the calendar scan find",
        kind: { type: "text" },
        at: EPOCH - 30_000,
    };
    const answer: ChatMessage = {
        id: "u2",
        role: "user",
        text: "yes, merge it",
        kind: { type: "text" },
        at: EPOCH,
        replyTo: { id: "q1", text: "Shall I merge and push it?" },
    };

    const draw = (state: OrbitState): string =>
        renderToStaticMarkup(
            createElement(
                "div",
                null,
                ...state.messages.map((message) =>
                    createElement(Message, { key: message.id, state, message }),
                ),
            ),
        );

    const threaded = draw(baseState({ messages: [question, elsewhere, answer] }));
    ok("a threaded reply draws a quoted header", threaded.includes('class="reply-quote"'));
    ok("the header quotes the question", threaded.includes("Shall I merge and push it?"));
    ok("the header says what it is", threaded.includes("replying to"));
    ok("the question is anchored so the quote can scroll to it", threaded.includes('id="msg-q1"'));
    check("only the reply carries a header", count(threaded, 'class="reply-quote"'), 1);

    // The failure this replaces: chips greyed out the moment any later user
    // turn arrived, so an answer to an older question had to be retyped.
    ok(
        "an unanswered question keeps its chips live across later turns",
        !/class="choices spent"/.test(draw(baseState({ messages: [question, elsewhere] }))),
    );
    ok(
        "chips lock once the question has actually been answered",
        /class="choices spent"/.test(threaded),
    );

    // A typed message is untouched.
    const typed = draw(baseState({ messages: [elsewhere] }));
    ok("a typed message carries no header", !typed.includes("reply-quote"));
}

if (failures.length > 0) {
    console.error(`\n${failures.length} render check(s) failed:\n`);
    for (const failure of failures) console.error(`  ✗ ${failure}\n`);
    process.exit(1);
}

console.log(`\n${passed} checks passed.`);
console.log("Mission control renders.\n");
