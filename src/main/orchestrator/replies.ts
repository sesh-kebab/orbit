/**
 * Threading for quick replies.
 *
 * A chip click used to arrive as a bare "yes" with nothing attached to it. With
 * several questions outstanding, neither the user nor Orbit could tell which
 * one it answered — the user said as much: he does not know what he is saying
 * yes to, so he would not expect Orbit to.
 *
 * Two things fix that, and they are both derived here so they can never drift:
 * the quoted snippet shown above the user's bubble, and the "In reply to:"
 * prefix on the turn that actually reaches the model. The visual link and the
 * model's link are the same sentence.
 *
 * Everything in here is pure so it can be checked by `npm run verify:replies`.
 */

/** How much of the original question is kept. Two lines in a narrow panel. */
export const QUOTE_MAX = 160;

/**
 * The one sentence worth quoting back from an assistant message.
 *
 * Orbit's questions are usually the tail of a longer reply — some context, then
 * the ask. Quoting the opening would point at the wrong thing, so the last
 * question sentence wins, falling back to the last non-empty line and then to
 * the whole message. Markdown furniture is dropped: a leading "- " or "## " is
 * noise once the text is inside a quote strip.
 */
export function quoteQuestion(raw: string): string {
    const segments = sentences(raw);
    if (segments.length === 0) return "";
    const question = segments.filter((part) => part.endsWith("?")).at(-1);
    return truncate(question ?? segments.at(-1) ?? "", QUOTE_MAX);
}

/**
 * The user turn as the model sees it.
 *
 * The quote goes first and the answer second, because the answer is meaningless
 * before the question is known. A reply with no quote — a typed message, or a
 * chip whose question has aged out of the transcript — is sent exactly as it was
 * typed, with nothing bolted on.
 */
export function buildReplyPrompt(reply: string, quoted: string | undefined): string {
    const answer = reply.trim();
    const question = (quoted ?? "").trim();
    if (!question || !answer) return answer;
    return `In reply to your question: "${question}"\n\nMy answer: ${answer}`;
}

/**
 * The message as a list of candidate sentences, in order.
 *
 * Line breaks end a sentence as firmly as a full stop does. A bulleted list
 * whose last bullet is the question would otherwise fold into one run, and the
 * quote would be the whole list rather than the ask at the end of it.
 */
function sentences(raw: string): string[] {
    return raw
        .replace(/```[\s\S]*?```/g, "\n")
        .replace(/`([^`]*)`/g, "$1")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .split("\n")
        .map((line) =>
            line
                .replace(/^\s*(?:[-*+]|\d+[.)]|>|#{1,6})\s+/, "")
                .replace(/\*\*([^*]+)\*\*/g, "$1")
                .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1")
                .trim(),
        )
        .flatMap((line) => line.split(/(?<=[.!?])\s+/))
        .map((part) => part.replace(/\s+/g, " ").trim())
        .filter((part) => part.length > 1);
}

/** Cut on a word boundary where one is close, so the quote never ends mid-word. */
function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    const cut = text.slice(0, max);
    const space = cut.lastIndexOf(" ");
    return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
