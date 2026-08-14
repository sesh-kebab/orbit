import { useEffect, useRef, useState } from "react";
import type { AgentView, ChatMessage, OrbitState, PathInfo, PendingRequest } from "../../shared/types.js";
import { agentColor, elapsedLabel } from "../mood.js";
import { parseMarkdown, isPlainText, type Block, type Inline } from "../markdown.js";
import { pathCandidates, pathLabel, splitPathSegments, urlLabel } from "../paths.js";

interface Props {
    state: OrbitState;
    message: ChatMessage;
}

export function Message({ state, message }: Props): React.JSX.Element | null {
    switch (message.kind.type) {
        case "spawn":
            return <SpawnCard state={state} agentIds={message.kind.agentIds} />;
        case "request":
            return <RequestCard state={state} message={message} requestId={message.kind.requestId} />;
        case "completion":
            return <CompletionCard state={state} message={message} agentId={message.kind.agentId} />;
        case "error":
            return (
                <div className="card card-error">
                    <span className="card-title">that didn't work</span>
                    <p>{message.text}</p>
                </div>
            );
        default:
            if (!message.text.trim() && !message.choices?.length) return null;
            return (
                <>
                    {message.text.trim() && (
                        <div className={`bubble bubble-${message.role}`}>
                            <RichText text={message.text} live={!message.streaming} />
                            {message.streaming && <span className="caret" />}
                        </div>
                    )}
                    <MessageChoices state={state} message={message} />
                </>
            );
    }
}

/**
 * Message text, rendered.
 *
 * Three passes, in this order and for this reason. Markdown first, because it
 * decides the structure — what is a heading, what is a list, which words are
 * emphasised. Then, within each leaf run of text, the existing path and link
 * pass, because a filename is a filename whether or not it happened to be
 * inside a bullet or bold. The two compose rather than compete: markdown never
 * looks inside a URL or a path (see `markdown.ts`), so a link in a bullet keeps
 * both its bullet and its click.
 *
 * A path is only made a chip once main has confirmed it exists, so a path that
 * has been deleted, or a word that merely looked like one, reads as plain text
 * and nothing pretends to be openable when it is not. The lookup is skipped
 * entirely while a message is still streaming — half a path is not a path.
 *
 * Links need no such confirmation — there is nothing to check without fetching
 * them — but they are held to a stricter rule instead: only http and https are
 * ever clickable, and a click always leaves for the user's browser.
 */
export function RichText({ text, live = true }: { text: string; live?: boolean }): React.JSX.Element {
    const known = useVerifiedPaths(live ? text : "");
    const blocks = parseMarkdown(text);

    // The overwhelmingly common case — one plain sentence — renders exactly as
    // it did before markdown existed, with no wrapper and no layout change.
    if (isPlainText(blocks)) return <PlainRun text={text} known={known} />;

    return (
        <div className="md">
            <Blocks blocks={blocks} known={known} />
        </div>
    );
}

/** Text with no markdown in it: paths and links only, as before. */
function PlainRun({ text, known }: { text: string; known: Map<string, PathInfo> }): React.JSX.Element {
    const segments = splitPathSegments(text);
    if (!segments.some((segment) => segment.path || segment.url)) return <>{text}</>;

    return (
        <>
            {segments.map((segment, index) => {
                if (segment.url) return <UrlLink key={index} label={segment.text} url={segment.url} />;
                const info = segment.path ? known.get(segment.path) : undefined;
                if (!segment.path || !info?.exists) {
                    return <span key={index}>{segment.text}</span>;
                }
                return <PathChip key={index} label={segment.text} info={info} />;
            })}
        </>
    );
}

function Blocks({ blocks, known }: { blocks: Block[]; known: Map<string, PathInfo> }): React.JSX.Element {
    return (
        <>
            {blocks.map((block, index) => (
                <BlockNode key={index} block={block} known={known} />
            ))}
        </>
    );
}

function BlockNode({ block, known }: { block: Block; known: Map<string, PathInfo> }): React.JSX.Element {
    switch (block.type) {
        case "heading": {
            // Chat is not a document: a bubble-wide `<h1>` looks absurd next to
            // a 13px sentence, so weight and a class carry the level instead of
            // six escalating font sizes.
            const Tag = `h${Math.min(block.level, 6)}` as "h1";
            return (
                <Tag className={`md-heading md-h${block.level}`}>
                    <Inlines nodes={block.children} known={known} />
                </Tag>
            );
        }
        case "quote":
            return (
                <blockquote className="md-quote">
                    <Blocks blocks={block.blocks} known={known} />
                </blockquote>
            );
        case "code":
            return (
                <pre className="md-code">
                    <code>{block.text}</code>
                </pre>
            );
        case "rule":
            return <hr className="md-rule" />;
        case "list":
            return block.ordered ? (
                <ol className="md-list" start={block.start}>
                    {block.items.map((item, index) => (
                        <li key={index}>
                            <Blocks blocks={item} known={known} />
                        </li>
                    ))}
                </ol>
            ) : (
                <ul className="md-list">
                    {block.items.map((item, index) => (
                        <li key={index}>
                            <Blocks blocks={item} known={known} />
                        </li>
                    ))}
                </ul>
            );
        default:
            return (
                <p className="md-p">
                    <Inlines nodes={block.children} known={known} />
                </p>
            );
    }
}

function Inlines({ nodes, known }: { nodes: Inline[]; known: Map<string, PathInfo> }): React.JSX.Element {
    return (
        <>
            {nodes.map((node, index) => {
                switch (node.type) {
                    case "strong":
                        return (
                            <strong key={index}>
                                <Inlines nodes={node.children} known={known} />
                            </strong>
                        );
                    case "em":
                        return (
                            <em key={index}>
                                <Inlines nodes={node.children} known={known} />
                            </em>
                        );
                    case "strike":
                        return (
                            <s key={index}>
                                <Inlines nodes={node.children} known={known} />
                            </s>
                        );
                    case "link":
                        return <UrlLink key={index} label={node.label} url={node.href} />;
                    case "code":
                        // A backticked path stayed clickable before markdown
                        // rendered, and still does — it just looks like code now.
                        return (
                            <code key={index} className="md-inline-code">
                                <PlainRun text={node.text} known={known} />
                            </code>
                        );
                    default:
                        return <PlainRun key={index} text={node.text} known={known} />;
                }
            })}
        </>
    );
}

/**
 * A web link, opened in the user's own browser.
 *
 * Rendered as a button rather than an anchor on purpose: an `href` in this
 * window is a navigation waiting to happen — a stray middle-click or a dragged
 * link would replace Orbit's UI with a web page and there is no back button.
 * Main gets the URL and hands it to the OS.
 *
 * The visible text is shortened, because one long document link is wider than
 * the whole panel, while the title carries the URL in full for reading or
 * copying.
 */
function UrlLink({ label, url }: { label: string; url: string }): React.JSX.Element {
    const [failed, setFailed] = useState<string | undefined>(undefined);
    return (
        <button
            type="button"
            className={`url-link ${failed ? "url-link-failed" : ""}`}
            title={failed ?? `Open in your browser — ${url}`}
            onClick={() => {
                void window.orbit
                    .openUrl(url)
                    .then((result) => setFailed(result.ok ? undefined : (result.error ?? "Could not open that link.")))
                    .catch(() => setFailed("Could not open that link."));
            }}
        >
            {urlLabel(label)}
        </button>
    );
}

/**
 * Ask main which candidates exist. Batched per message and keyed on the text,
 * so a re-render costs nothing and a streaming bubble is only checked once it
 * has settled.
 */
function useVerifiedPaths(text: string): Map<string, PathInfo> {
    const [known, setKnown] = useState<Map<string, PathInfo>>(new Map());

    useEffect(() => {
        const candidates = text ? pathCandidates(text) : [];
        if (candidates.length === 0) {
            setKnown(new Map());
            return;
        }
        let live = true;
        void window.orbit
            .inspectPaths(candidates)
            .then((results) => {
                if (live) setKnown(new Map(results.map((info) => [info.raw, info])));
            })
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [text]);

    return known;
}

/**
 * Click opens — a file in the editor, a directory in Finder. Alt or shift
 * reveals instead, which is what you want when the point is *where* the thing
 * is rather than what is in it.
 */
function PathChip({ label, info }: { label: string; info: PathInfo }): React.JSX.Element {
    const [failed, setFailed] = useState<string | undefined>(undefined);
    const target = info.resolved ?? info.raw;

    const act = (reveal: boolean): void => {
        const call = reveal ? window.orbit.revealPath(target) : window.orbit.openPath(target);
        void call
            .then((result) => setFailed(result.ok ? undefined : (result.error ?? "Could not open that.")))
            .catch(() => setFailed("Could not open that."));
    };

    return (
        <button
            type="button"
            className={`path-chip ${failed ? "path-chip-failed" : ""}`}
            title={failed ?? `${openVerb(info)} — ${target}\nAlt-click to reveal in Finder`}
            onClick={(event) => act(event.altKey || event.shiftKey)}
        >
            <span className="path-chip-icon">{info.isDirectory ? "🗂" : "📄"}</span>
            <span className="path-chip-label">{shortenPath(label)}</span>
        </button>
    );
}

/** Say what the click will actually do, which is not always "open". */
function openVerb(info: PathInfo): string {
    if (info.revealOnly) return "Show in Finder";
    return info.isDirectory ? "Open in Finder" : "Open in your editor";
}

/** Long paths would dominate a narrow panel; the tail is the useful half. */
function shortenPath(label: string): string {
    return label.length > 44 ? `…/${pathLabel(label)}` : label;
}

/**
 * One-click replies beneath an assistant bubble. Clicking sends the choice's
 * value through `window.orbit.send`, the same path a typed message takes, so
 * logging, orchestration and history behave identically. The row locks once
 * answered — either by this click or by any later turn in the transcript.
 */
function MessageChoices({ state, message }: Props): React.JSX.Element | null {
    const [clicked, setClicked] = useState<string | undefined>(undefined);
    const choices = message.choices;
    if (!choices?.length || message.streaming) return null;

    const index = state.messages.findIndex((m) => m.id === message.id);
    const superseded = index >= 0 && state.messages.slice(index + 1).some((m) => m.role === "user");
    const spent = clicked !== undefined || superseded || state.runtime !== "ready";

    return (
        <div className={`choices ${spent ? "spent" : ""}`} role="group" aria-label="Quick replies">
            {choices.map((choice) => (
                <button
                    key={choice.value}
                    type="button"
                    className={`chip chip-choice ${clicked === choice.value ? "picked" : ""}`}
                    disabled={spent}
                    title={choice.value}
                    onClick={() => {
                        if (spent) return;
                        setClicked(choice.value);
                        void window.orbit.send(choice.value);
                    }}
                >
                    {choice.label}
                </button>
            ))}
        </div>
    );
}

function SpawnCard({ state, agentIds }: { state: OrbitState; agentIds: string[] }): React.JSX.Element {
    const agents = state.agents.filter((agent) => agentIds.includes(agent.id));
    if (agents.length === 0) return <></>;
    return (
        <div className="card card-spawn">
            <span className="card-title">dispatched {agents.length} agent{agents.length === 1 ? "" : "s"}</span>
            {agents.map((agent) => (
                <AgentRow key={agent.id} agent={agent} compact />
            ))}
        </div>
    );
}

function CompletionCard({
    state,
    message,
    agentId,
}: {
    state: OrbitState;
    message: ChatMessage;
    agentId: string;
}): React.JSX.Element {
    const agent = state.agents.find((a) => a.id === agentId);
    const failed = agent?.status === "failed";
    return (
        <div className={`card ${failed ? "card-error" : "card-done"}`}>
            <div className="card-head">
                <span className="tick">{failed ? "!" : "✓"}</span>
                <span className="card-title">{agent?.title ?? "agent"}</span>
                {agent && <span className="muted">{elapsedLabel(agent.createdAt, agent.endedAt)}</span>}
            </div>
            <p>
                <RichText text={message.text} />
            </p>
        </div>
    );
}

function RequestCard({
    state,
    message,
    requestId,
}: {
    state: OrbitState;
    message: ChatMessage;
    requestId: string;
}): React.JSX.Element {
    const request = state.requests.find((r) => r.id === requestId);
    const agent = state.agents.find((a) => a.id === request?.agentId);
    const [freeform, setFreeform] = useState("");

    if (!request) {
        return (
            <div className="card card-resolved">
                <span className="card-title">{message.text}</span>
                <span className="muted">→ {message.resolvedAs ?? "answered"}</span>
            </div>
        );
    }

    const answer = (optionId: string, text?: string): void => {
        void window.orbit.answerRequest(request.id, optionId, text);
    };

    return (
        <div className="card card-ask">
            <div className="card-head">
                <span className="card-title">{agent?.title ?? "an agent"}</span>
                <span className="ask-flag">needs you</span>
            </div>
            <p className="ask-question">{request.title}</p>
            {request.subject && <code className="ask-subject">{request.subject}</code>}
            {request.detail && <p className="muted small">{request.detail}</p>}
            <div className="ask-options">
                {request.options.map((option) => (
                    <button
                        key={option.id}
                        className={`chip chip-${option.tone}`}
                        onClick={() => answer(option.id)}
                    >
                        {option.label}
                    </button>
                ))}
            </div>
            {request.allowFreeform && (
                <form
                    className="ask-freeform"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (freeform.trim()) answer("freeform", freeform.trim());
                    }}
                >
                    <input
                        value={freeform}
                        placeholder="…or tell it what to do"
                        onChange={(event) => setFreeform(event.target.value)}
                    />
                </form>
            )}
        </div>
    );
}

export function AgentRow({
    agent,
    compact = false,
}: {
    agent: AgentView;
    compact?: boolean;
}): React.JSX.Element {
    const blocked = agent.status === "needs-input";
    const running = agent.status === "running" || agent.status === "queued";
    const color = agentColor(agent.hue, blocked);
    const [, force] = useState(0);

    // Elapsed time needs a heartbeat while the agent is alive.
    useEffect(() => {
        if (!running && !blocked) return;
        const timer = setInterval(() => force((n) => n + 1), 1000);
        return () => clearInterval(timer);
    }, [running, blocked]);

    return (
        <div className={`agent-row ${blocked ? "blocked" : ""}`}>
            <span
                className={`agent-dot ${running ? "spinning" : ""}`}
                style={{ borderColor: color, color }}
            >
                {agent.status === "done" ? "✓" : agent.status === "failed" ? "!" : ""}
            </span>
            <div className="agent-main">
                <span className="agent-title">{agent.title}</span>
                <span className="agent-step">
                    {blocked
                        ? "waiting on your call"
                        : (agent.currentStep ?? statusWord(agent.status))}
                </span>
            </div>
            {!compact && (
                <button
                    className="icon-button"
                    title="Cancel this agent"
                    onClick={() => void window.orbit.cancelAgent(agent.id)}
                    disabled={!running && !blocked}
                >
                    ✕
                </button>
            )}
            <span className="agent-meta">
                {elapsedLabel(agent.createdAt, agent.endedAt)}
                <em>
                    {agent.toolCalls} step{agent.toolCalls === 1 ? "" : "s"}
                </em>
            </span>
        </div>
    );
}

function statusWord(status: AgentView["status"]): string {
    switch (status) {
        case "queued":
            return "starting up";
        case "running":
            return "working";
        case "done":
            return "done";
        case "failed":
            return "gave up";
        case "cancelled":
            return "cancelled";
        default:
            return status;
    }
}

/** Compact right-aligned pills shown above the buddy when the chat is closed. */
export function AgentShelf({ agents, requests }: { agents: AgentView[]; requests: PendingRequest[] }): React.JSX.Element {
    const visible = agents.slice(0, 3);
    const blockedIds = new Set(requests.map((r) => r.agentId));
    return (
        <div className="shelf" data-interactive>
            {agents.length > 3 && <span className="shelf-more">+{agents.length - 3} more</span>}
            {visible.map((agent) => {
                const blocked = blockedIds.has(agent.id) || agent.status === "needs-input";
                return (
                    <div key={agent.id} className={`shelf-pill ${blocked ? "blocked" : ""}`}>
                        <span
                            className={`agent-dot small ${blocked ? "" : "spinning"}`}
                            style={{ borderColor: agentColor(agent.hue, blocked), color: agentColor(agent.hue, blocked) }}
                        />
                        <span className="shelf-title">{agent.title}</span>
                        <span className="shelf-step">{blocked ? "needs you" : `${agent.toolCalls}`}</span>
                    </div>
                );
            })}
        </div>
    );
}

export function useAutoScroll(dependency: unknown): React.RefObject<HTMLDivElement | null> {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const node = ref.current;
        if (!node) return;
        node.scrollTop = node.scrollHeight;
    }, [dependency]);
    return ref;
}
