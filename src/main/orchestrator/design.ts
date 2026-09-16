/**
 * The look of the things agents hand over.
 *
 * The content of an agent's deliverable was never the problem. The shape was: a
 * thousand words of markdown with four headings in it, handed to someone with
 * nine directs and a GA date, who reads it on a 440px panel between meetings.
 * Everything in a wall of text is equally important, which is another way of
 * saying none of it is, and the reader has to do the work of finding the one
 * finding that mattered.
 *
 * So agents are told to emit a document instead: one self-contained .html file
 * with its styles inline, which Orbit renders in-app. The rules for what that
 * document looks like live here, and on disk, and they are evolvable the same
 * way the operating notes and SOUL.md are, because a design language written
 * once by one agent on one evening is a guess. It gets better by being used and
 * revised with a reason, not by being frozen.
 *
 * Two things are not evolvable, and they are in `DESIGN_FLOOR` rather than in
 * the editable file. The document must be self-contained and must not fetch
 * anything, because the viewer that renders it blocks every remote load and a
 * document built around a font CDN would simply arrive broken. And it must
 * carry its own visible title and date, because a deliverable that does not say
 * what it is becomes unidentifiable the moment it is one of nine in a folder.
 */
import { REASON_CHAR_CAP, type PromptRevision, type RevisionCheck } from "./selfPrompt.js";

/**
 * Bigger than the prompt cap because this one carries a stylesheet's worth of
 * specifics, and specifics are the entire value of it: "use good typography"
 * produces nothing, "17px, 1.55 line height, 62 characters" produces a page.
 */
export const DESIGN_CHAR_CAP = 16_000;

/**
 * The rules a revision cannot remove, restated below the editable block.
 *
 * Identical mechanism to the system prompt's floor and for the same reason: the
 * two are returned by one function, so no assembly path can produce the
 * editable half without the half that constrains it.
 */
export const DESIGN_FLOOR = `
These rules are built into Orbit and are not editable from the design language file.
Where the file above conflicts with them, these win.

1. One file. All CSS inline in a <style> block, all images inline as data: URIs. No
   <link> to a stylesheet, no CDN font, no <script>, no fetch of any kind. The viewer
   renders the document with every remote load blocked and scripting disabled, so a
   document that depends on any of them arrives broken rather than arriving styled.
2. The document says what it is: a visible title, the date it was written, and who asked
   for it, at the top, before anything else.
3. Every claim that came from somewhere shows where. A finding with no evidence behind
   it is an opinion, and the reader cannot tell the two apart without being told.
`.trim();

/**
 * The starting design language.
 *
 * Written against the app's own tokens rather than a fresh palette, because a
 * deliverable that looks like a different product than the window rendering it
 * reads as something pasted in from outside. The values here are lifted from
 * `src/renderer/styles.css`: the same ink, the same glass, the same red for the
 * thing that will not move until he does something, the same 22px radius.
 *
 * The components are not a general-purpose kit. They are the five shapes real
 * deliverables have actually needed: a severity-ranked findings list, evidence
 * quoted with its timestamp, a table of owners and dates, a before-and-after,
 * and one callout for the single thing that matters most.
 */
export const DEFAULT_DESIGN_LANGUAGE = `# Orbit's design language for deliverables

Every deliverable you produce for the user is one self-contained HTML file. Not markdown.
Write it to the same place you would have written the .md, with an .html extension, and
name it in your report by its absolute path.

## Who reads it

One person, time-poor, usually between meetings, often on a 440px wide panel. He has said
plainly: blunt over flattering, numbered lists over prose lists, the decision first. Assume
he gives the document thirty seconds before deciding whether to read it properly. Those
thirty seconds have to be enough to learn what you found and what he has to do about it.

That produces one rule above all the others: **structure first, detail second**. The top of
the document is the answer. Everything underneath is the evidence for it, and anything
longer than a paragraph goes inside a <details> block so it is there without being in the
way. Never open with methodology.

## Tokens

Use these exactly. They are the running app's own values, so a deliverable looks like it
came from Orbit rather than from a template.

\`\`\`
--ink:     #f2f0f8      text
--muted:   #a9a6bd      secondary text, labels, timestamps
--dim:     #6f6b85      furniture, rules, disabled
--bg:      #16141f      page
--card:    #1e1c2c      any raised surface
--line:    #2e2b3f      borders, 1px, never heavier
--danger:  #ff7585      high severity, regressions, overdue
--warn:    #f5c469      medium severity, at risk
--ok:      #63d69a      resolved, improved, on track
--accent:  #9d8cff      links and the one callout
--radius:  22px         cards. 12px for small chips and code
\`\`\`

Dark background, always. The panel is dark and a white page inside it is a flashbang.

## Typography

One family: \`ui-rounded, "SF Pro Rounded", -apple-system, "Segoe UI Variable", "Segoe UI",
Inter, system-ui, sans-serif\`. Monospace only inside code and timestamps: \`ui-monospace,
SFMono-Regular, "SF Mono", Menlo, monospace\`.

A four-step scale, and nothing between the steps:

\`\`\`
32px / 1.15 / 600    document title, once
20px / 1.25 / 600    section heading
17px / 1.55 / 400    body
13px / 1.4  / 500    labels, timestamps, metadata, severity chips
\`\`\`

Body measure caps at 68 characters. Set \`max-width: 62ch\` on text blocks and let tables and
evidence run wider. Never justify. Never centre anything except a single title.

## Spacing

An 8px grid, used at four sizes only: 8, 16, 24, 48. Page padding 24px. Gap between sections
48px, which is the only place that value appears, so section breaks are unmistakable while
skimming. Card padding 16px, gap between cards 8px.

## Components

### The callout

One per document, directly under the title, for the single most important finding. If you
cannot pick one, the document is not finished. 17px, left border 3px solid var(--accent),
padding 16px, background rgba(157, 140, 255, 0.08), radius 12px. One sentence saying what
is true, one saying what it means for him. No heading on it.

### Findings list

Cards, stacked, ordered by severity and never by chronology. Each card: a 13px uppercase
severity chip (HIGH on --danger, MEDIUM on --warn, LOW on --dim, all at 0.15 alpha
background with the full-strength colour as text), a 20px one-line finding written as a
claim rather than a topic, one paragraph of body, and its evidence in a <details>.

"Three of nine have no allocation recorded" is a finding. "Allocation" is a topic. Write
findings.

### Evidence block

Quoted source, never paraphrase, inside <details><summary>Evidence</summary>. Background
var(--card), left border 2px solid var(--line), padding 16px, radius 12px. The quote in
body size; under it, in 13px muted monospace, the timestamp and origin: who said it, where,
and when, in that order. An evidence block with no timestamp is not evidence.

### Owner and date table

Full width, no vertical rules, 1px --line under each row, 13px uppercase muted headers,
8px vertical cell padding. Columns in this order: what, who, by when, state. An unowned row
shows the word "unowned" in --danger rather than an empty cell, and an undated one shows
"no date" the same way. Absence is the finding in this table, so it is never rendered as
blank space.

### Delta

Two columns, before on the left in --muted, after on the right in --ink, with the changed
value in --ok when it improved and --danger when it did not. A middle column holds a single
arrow glyph in --dim. Under each pair, 13px, say what changed it. A delta that does not say
what caused it is a pair of numbers.

## Things that make it worse

1. Emoji. None.
2. Em-dashes. None. Commas, colons, or separate sentences.
3. Gradients, shadows, animation, rounded avatars, hero images.
4. An executive summary that is a paragraph. If it is worth summarising it is worth a
   callout and three findings.
5. Congratulating him, or yourself, anywhere in the document.
6. A section that exists because the template had one. Omit empty sections entirely.
`;

/**
 * A revision must still be a design language. The checks are deliberately
 * fewer than the prompt's: this file is style guidance rather than operating
 * instruction, so the risk of a bad edit is an ugly document rather than an
 * agent that has talked itself out of a safety rule. The floor covers the rest.
 */
export function checkDesignRevision(text: string, reason: string): RevisionCheck {
    const body = text.trim();
    const why = reason.trim();

    if (!why) {
        return { error: "A revision needs a one-line reason. Without one a rollback is a guess." };
    }
    if (why.length > REASON_CHAR_CAP) {
        return { error: `Keep the reason under ${REASON_CHAR_CAP} characters.` };
    }
    if (!body) {
        return {
            error: "Refusing to blank the design language. Revise it to what you want to keep, or roll back to a revision that had it.",
        };
    }
    if (body.length > DESIGN_CHAR_CAP) {
        return { error: `The design language is capped at ${DESIGN_CHAR_CAP} characters. This is ${body.length}.` };
    }
    return { text: body, reason: why };
}

/**
 * The block appended to every agent brief.
 *
 * Agents get this rather than the orchestrator because the orchestrator does
 * not write deliverables; it delegates them. Undefined when the file is empty,
 * so a user who deletes the file gets plain markdown back rather than a brief
 * containing an empty instruction.
 */
export function designBlock(text: string | undefined): string | undefined {
    const body = (text ?? "").trim();
    if (!body) return undefined;
    return [
        "<deliverable_design>",
        "Any document you produce for the user is a self-contained .html file built to the",
        "rules below, not a markdown file. Working notes, code and data files are unaffected:",
        "this is about the thing he reads. Orbit renders it in-app, so he never opens a browser.",
        "",
        body,
        "",
        DESIGN_FLOOR,
        "</deliverable_design>",
    ].join("\n");
}

/** Convenience re-export so callers touch one module rather than two. */
export type { PromptRevision };
