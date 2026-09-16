/**
 * Turning a deliverable into something safe to put on screen.
 *
 * The document being rendered was written by a language model. It is not
 * hostile, but it is generated, and generated content that gets executed is the
 * oldest mistake in the business. So nothing here trusts it. The output of this
 * module is a string that goes into the `srcdoc` of a frame with an empty
 * `sandbox` attribute, which is the strongest form the attribute has: an opaque
 * origin, no scripting, no forms, no plugins, no top-level navigation, no
 * popups. Nothing in the document can reach the renderer, and the renderer
 * itself runs with `contextIsolation` on and `nodeIntegration` off, so there is
 * no bridge behind it either.
 *
 * On top of that the document gets a Content Security Policy of its own,
 * prepended to its head. It is not there to stop scripts, the sandbox already
 * did that. It is there to stop *fetching*: a document that links a font CDN or
 * an image on a server somewhere would otherwise phone that server the moment
 * it is opened, which turns reading a file into a network event. `default-src
 * 'none'` with data: URIs allowed for images and fonts means a self-contained
 * document renders exactly as written and a document that is not self-contained
 * renders without the parts that were not in it. When a document carries its
 * own CSP as well, the two are enforced together and the stricter wins, so this
 * one can only ever tighten.
 *
 * Markdown goes through the same frame rather than being rendered as React in
 * the panel. That is what keeps a folder of .md deliverables written before any
 * of this existed from being orphaned: they open in the viewer like everything
 * else, and they get the design language's typography applied to them, which is
 * more than they ever had.
 */
import { parseMarkdown, type Block, type Inline } from "./markdown.js";

/**
 * Everything blocked except what a self-contained document needs. `img-src` and
 * `font-src` allow data: because that is how a document with a chart in it is
 * meant to carry the chart. `style-src 'unsafe-inline'` is the whole point of
 * an inline stylesheet, and is not a scripting hole with scripts already off.
 */
export const READER_CSP =
    "default-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'";

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${READER_CSP}">`;

/**
 * The stylesheet markdown is rendered with, and the fallback frame around any
 * HTML document that turns out to have no styles of its own.
 *
 * These are the app's own tokens, and deliberately the same values the design
 * language hands agents, so an old .md and a new .html sit in the same viewer
 * looking like the same product.
 */
const READER_STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
    margin: 0;
    padding: 24px;
    background: #16141f;
    color: #f2f0f8;
    font: 400 17px/1.55 ui-rounded, "SF Pro Rounded", -apple-system, "Segoe UI Variable",
        "Segoe UI", Inter, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    overflow-wrap: break-word;
}
.doc { max-width: 62ch; }
h1 { font-size: 32px; line-height: 1.15; font-weight: 600; margin: 0 0 24px; }
h2 { font-size: 20px; line-height: 1.25; font-weight: 600; margin: 48px 0 16px; }
h3, h4, h5, h6 { font-size: 17px; font-weight: 600; margin: 24px 0 8px; }
p { margin: 0 0 16px; }
ul, ol { margin: 0 0 16px; padding-left: 24px; }
li { margin: 0 0 8px; }
/* A list item is a block and carries its own paragraph; without this a tight
   list is spaced like a set of sections. */
li > p { margin: 0; }
li > p + p { margin-top: 8px; }
a { color: #9d8cff; }
hr { border: 0; border-top: 1px solid #2e2b3f; margin: 48px 0; }
blockquote {
    margin: 0 0 16px;
    padding: 16px;
    background: #1e1c2c;
    border-left: 2px solid #2e2b3f;
    border-radius: 12px;
    color: #a9a6bd;
}
blockquote > :last-child { margin-bottom: 0; }
code {
    font: 500 13px/1.4 ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    background: #1e1c2c;
    border-radius: 6px;
    padding: 1px 5px;
}
pre {
    margin: 0 0 16px;
    padding: 16px;
    background: #1e1c2c;
    border-radius: 12px;
    overflow-x: auto;
}
pre code { background: none; padding: 0; font-size: 13px; }
strong { font-weight: 600; }
del { color: #6f6b85; }
table { border-collapse: collapse; width: 100%; margin: 0 0 16px; }
th, td { text-align: left; padding: 8px 8px 8px 0; border-bottom: 1px solid #2e2b3f; }
th { font-size: 13px; text-transform: uppercase; color: #a9a6bd; font-weight: 500; }
img { max-width: 100%; }
`.trim();

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * Only http, https and mailto survive as links. Anything else, `javascript:`
 * most of all, is rendered as the text it is: the sandbox would already refuse
 * to run it, but a link that looks live and does nothing is worse than a link
 * that never looked live.
 */
function safeHref(href: string): string | undefined {
    const trimmed = href.trim();
    if (/^(https?:|mailto:)/i.test(trimmed)) return escapeHtml(trimmed);
    return undefined;
}

function inlineToHtml(nodes: Inline[]): string {
    return nodes
        .map((node) => {
            switch (node.type) {
                case "text":
                    return escapeHtml(node.text);
                case "code":
                    return `<code>${escapeHtml(node.text)}</code>`;
                case "link": {
                    const href = safeHref(node.href);
                    const label = escapeHtml(node.label);
                    return href ? `<a href="${href}">${label}</a>` : label;
                }
                case "strong":
                    return `<strong>${inlineToHtml(node.children)}</strong>`;
                case "em":
                    return `<em>${inlineToHtml(node.children)}</em>`;
                case "strike":
                    return `<del>${inlineToHtml(node.children)}</del>`;
            }
        })
        .join("");
}

function blockToHtml(block: Block): string {
    switch (block.type) {
        case "paragraph":
            return `<p>${inlineToHtml(block.children)}</p>`;
        case "heading": {
            const level = Math.min(Math.max(block.level, 1), 6);
            return `<h${level}>${inlineToHtml(block.children)}</h${level}>`;
        }
        case "quote":
            return `<blockquote>${block.blocks.map(blockToHtml).join("")}</blockquote>`;
        case "list": {
            const tag = block.ordered ? "ol" : "ul";
            const start = block.ordered && block.start !== 1 ? ` start="${block.start}"` : "";
            const items = block.items.map((item) => `<li>${item.map(blockToHtml).join("")}</li>`).join("");
            return `<${tag}${start}>${items}</${tag}>`;
        }
        case "code":
            return `<pre><code>${escapeHtml(block.text)}</code></pre>`;
        case "rule":
            return "<hr>";
    }
}

/** Markdown to an HTML document, using the app's own type and colour. */
export function markdownDocument(text: string, title: string): string {
    const body = parseMarkdown(text).map(blockToHtml).join("\n");
    return [
        "<!doctype html>",
        '<html lang="en"><head><meta charset="utf-8">',
        CSP_META,
        `<title>${escapeHtml(title)}</title>`,
        `<style>${READER_STYLE}</style>`,
        "</head><body>",
        `<div class="doc">${body}</div>`,
        "</body></html>",
    ].join("\n");
}

/**
 * An agent's own HTML, with the policy inserted into its head.
 *
 * Inserted rather than prepended when there is a head to insert into, because a
 * meta element ahead of the document's own `<html>` relies on the parser
 * building an implied head and merging what follows, which works but is a
 * silent dependency on parser recovery. When there is no head, prepending is
 * the only option and the implied head is what happens anyway.
 */
export function htmlDocument(text: string): string {
    const head = /<head[^>]*>/i.exec(text);
    if (head) {
        const at = head.index + head[0].length;
        return `${text.slice(0, at)}\n${CSP_META}\n${text.slice(at)}`;
    }
    return `${CSP_META}\n${text}`;
}

/** The srcdoc for a document of either kind. */
export function readerDocument(kind: "html" | "markdown", text: string, title: string): string {
    return kind === "html" ? htmlDocument(text) : markdownDocument(text, title);
}
