/**
 * The board: every parallel thread in one place, with the judgement on top.
 *
 * Two surfaces, deliberately stacked in this order. The judgement comes first
 * because it is the part that is worth the ten seconds he actually has; the
 * lanes below are there for when the answer to "what is going on" is not one of
 * the calls. The reverse order was tried on paper and reads as a todo list with
 * a note above it, which is the thing he asked for something better than.
 *
 * Everything shown here is derived in main and arrives whole. This file draws
 * and decides how much fits; it works nothing out for itself, so there is no
 * second opinion to drift from the first.
 */
import { useEffect, useState } from "react";
import type {
    ActivityKind,
    Board,
    BoardArtifact,
    BoardThread,
    ChiefCall,
    Confidence,
    OrbitState,
    PathInfo,
    ThreadLane,
} from "../../shared/types.js";
import { agentColor, shortSpan } from "../mood.js";
import { Icon, type IconName } from "./Icon.js";
import { isViewable, openInReader } from "../reader.js";

/** Calls shown before the list folds. More than this and none of them get read. */
const CALLS_SHOWN = 3;

/** Rows per lane before it folds. A lane is a summary, not an inventory. */
const ROWS_PER_LANE = 4;

/**
 * Artifacts shown before the list folds.
 *
 * Five, because the job here is "find the thing from last week without
 * scrolling the chat", and the honest answer to that is recency plus a fold,
 * not a complete archive rendered in a panel this narrow.
 */
const ARTIFACTS_SHOWN = 5;


const LANES: Array<{ id: ThreadLane; label: string; hint: string }> = [
    { id: "you", label: "on you", hint: "Nothing moves on these until you do something" },
    { id: "stuck", label: "stuck", hint: "Stopped, and nobody chose to stop them" },
    { id: "others", label: "on others", hint: "Waiting on somebody who is not you" },
    { id: "running", label: "running", hint: "In flight without you, including standing watchers" },
    { id: "landed", label: "landed", hint: "Finished in the last twelve hours" },
];

const CALL_ICON: Record<ChiefCall["kind"], IconName> = {
    exposure: "alert",
    leverage: "bolt",
    decay: "clock",
    anticipation: "shield",
    capacity: "deck",
};

const THREAD_ICON: Record<BoardThread["kind"], IconName> = {
    agent: "run",
    watcher: "clock",
    decision: "edit",
    delivery: "file",
};

/** What the ledger called it, in words rather than in its stored shorthand. */
const KIND_LABEL: Record<ActivityKind, string> = {
    artifact_written: "a file it wrote",
    draft_composed: "a draft it composed",
    query_run: "the output of a query",
    access_checked: "an access check",
    agent_dispatched: "work it handed off",
    external_action: "something it did in mail, calendar or Teams",
    other: "something it made",
};

/**
 * The confidence label, spelled out rather than abbreviated.
 *
 * It is always rendered, including on the certain ones. Showing it only when it
 * is low would make its absence the real signal, and absence is exactly the
 * thing people read past.
 */
const CONFIDENCE_LABEL: Record<Confidence, string> = {
    certain: "certain",
    likely: "likely",
    guess: "a guess",
};

export function BoardTab({ state }: { state: OrbitState }): React.JSX.Element {
    const { board } = state;
    const empty =
        board.threads.length === 0 && board.calls.length === 0 && board.artifacts.length === 0;
    const onDisk = useExistingPaths(board.artifacts);
    // Clocks are measured from the moment the board was derived, not from the
    // renderer's own clock. They then agree with the copy on the calls, which is
    // written in main against the same instant, and a capture of a fixed state
    // renders the same numbers every time.
    const now = board.at || Date.now();

    return (
        <div className="deck-list board">
            <Calls board={board} />
            {LANES.map((lane) => (
                <Lane
                    key={lane.id}
                    label={lane.label}
                    hint={lane.hint}
                    threads={board.threads.filter((thread) => thread.lane === lane.id)}
                    onDisk={onDisk}
                    now={now}
                />
            ))}
            <Made artifacts={board.artifacts} onDisk={onDisk} now={now} />
            {empty && (
                <p className="muted small pad">
                    Nothing in flight, nothing waiting. Ask for something and it will show up here.
                </p>
            )}
            <BlindSpots spots={board.blindSpots} />
        </div>
    );
}

/**
 * Which artifact paths are actually still on disk.
 *
 * Checked here rather than in main so the board derivation stays pure and so the
 * cost is paid once per visit instead of on every three second refresh. It uses
 * the same `inspectPaths` channel the chat transcript already uses to decide
 * whether a path is worth offering a click on, so there is one answer to "does
 * this file exist" in the app rather than two.
 */
function useExistingPaths(artifacts: BoardArtifact[]): Map<string, PathInfo> {
    const [known, setKnown] = useState<Map<string, PathInfo>>(new Map());
    const key = artifacts.map((artifact) => artifact.location).join("\u0000");

    useEffect(() => {
        const paths = key.length > 0 ? key.split("\u0000") : [];
        if (paths.length === 0) {
            setKnown(new Map());
            return;
        }
        let live = true;
        window.orbit
            .inspectPaths(paths)
            .then((results) => {
                if (live) setKnown(new Map(results.map((info) => [info.raw, info])));
            })
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [key]);

    return known;
}

function Calls({ board }: { board: Board }): React.JSX.Element {
    const [all, setAll] = useState(false);
    if (board.calls.length === 0) {
        return (
            <div className="board-calls">
                <p className="muted small">Nothing worth interrupting you about.</p>
            </div>
        );
    }

    const shown = all ? board.calls : board.calls.slice(0, CALLS_SHOWN);
    return (
        <div className="board-calls">
            {shown.map((call) => (
                <CallRow key={call.id} call={call} />
            ))}
            {board.calls.length > CALLS_SHOWN && (
                <button
                    className="link center"
                    title="Everything Orbit has an opinion about right now"
                    onClick={() => setAll((value) => !value)}
                >
                    {all ? "fewer" : `${board.calls.length - CALLS_SHOWN} more`}
                </button>
            )}
        </div>
    );
}

/** Headline first, reasoning on demand. The reasoning is numbered, never prose. */
function CallRow({ call }: { call: ChiefCall }): React.JSX.Element {
    const [open, setOpen] = useState(false);
    return (
        <div className={`call call-${call.kind}`}>
            <div className="call-head" onClick={() => setOpen((value) => !value)}>
                <span className="call-mark">
                    <Icon name={CALL_ICON[call.kind]} />
                </span>
                <span className="call-headline">{call.headline}</span>
                <span className={`tag conf conf-${call.confidence}`}>
                    {CONFIDENCE_LABEL[call.confidence]}
                </span>
            </div>
            {open && (
                <div className="call-body">
                    <ol className="call-because">
                        {call.because.map((reason, index) => (
                            <li key={index}>{reason}</li>
                        ))}
                    </ol>
                    <div className="kv">
                        <span>basis</span>
                        <span className="muted small">{call.basis}</span>
                    </div>
                    {call.minutes !== undefined && (
                        <div className="kv">
                            <span>costs</span>
                            <span className="muted small">about {call.minutes} min</span>
                        </div>
                    )}
                    {call.unblocks.length > 0 && (
                        <div className="kv">
                            <span>frees</span>
                            <span className="muted small">{call.unblocks.join(", ")}</span>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

/**
 * Everything Orbit has made for him, newest first.
 *
 * Below the lanes rather than above them, and deliberately so: the lanes are
 * what is happening, and this is what has already happened. It sits under them
 * as the answer to "where did that thing go", which is a question he asks on
 * purpose, rather than competing for the glance he gives the top of the panel.
 *
 * Not a tab of its own, and not a side nav. He said additional UI was allowed
 * but complication was not, and a second screen listing files would have made
 * him choose where to look before knowing what he was looking for.
 */
function Made({
    artifacts,
    onDisk,
    now,
}: {
    artifacts: BoardArtifact[];
    onDisk: Map<string, PathInfo>;
    now: number;
}): React.JSX.Element {
    const [all, setAll] = useState(false);
    if (artifacts.length === 0) return <></>;

    const unopened = artifacts.filter((artifact) => !artifact.opened).length;
    const shown = all ? artifacts : artifacts.slice(0, ARTIFACTS_SHOWN);
    return (
        <div className="lane made">
            <div
                className="lane-head"
                title="Files and drafts Orbit produced. Click one to open it, alt-click to show it in Finder."
            >
                <span className="lane-label">made for you</span>
                {unopened > 0 && (
                    <span className="tag unopened" title="Orbit has not seen you open these">
                        {unopened} unopened
                    </span>
                )}
                <em>{artifacts.length}</em>
            </div>
            {shown.map((artifact) => (
                <ArtifactRow
                    key={artifact.id}
                    artifact={artifact}
                    info={onDisk.get(artifact.location)}
                    now={now}
                />
            ))}
            {artifacts.length > ARTIFACTS_SHOWN && (
                <button className="link center" onClick={() => setAll((value) => !value)}>
                    {all ? "fewer" : `${artifacts.length - ARTIFACTS_SHOWN} more`}
                </button>
            )}
        </div>
    );
}

/**
 * One artifact, and the click that opens it.
 *
 * Opening and recording the open are two calls, in that order, and the second
 * cannot prevent the first. The whole complaint was that he could not get to
 * these files; a bookkeeping failure must never become the reason a document
 * stays shut.
 *
 * A file that has moved or been deleted is drawn as unopenable rather than
 * offered and then failing on click. `info` is undefined while the check is
 * still in flight, which is treated as openable: a row that flickers from dead
 * to alive on every visit would teach him to distrust the marker.
 */
function ArtifactRow({
    artifact,
    info,
    now,
    compact = false,
}: {
    artifact: BoardArtifact;
    info: PathInfo | undefined;
    now: number;
    /** Under its own thread, where the title above already says what it is. */
    compact?: boolean;
}): React.JSX.Element {
    const [failed, setFailed] = useState<string | undefined>(undefined);
    const [opened, setOpened] = useState(artifact.opened);
    const gone = !artifact.external && info !== undefined && !info.exists;
    const target = info?.resolved ?? artifact.location;

    const act = (reveal: boolean): void => {
        if (gone) return;
        if (!reveal && !artifact.external && isViewable(target, info?.isDirectory)) {
            openInReader(target);
            setOpened(true);
            void window.orbit.markArtifactOpened(artifact.id).catch(() => undefined);
            return;
        }
        const call = artifact.external
            ? window.orbit.openUrl(target)
            : reveal
              ? window.orbit.revealPath(target)
              : window.orbit.openPath(target);
        void call
            .then((result) => setFailed(result.ok ? undefined : (result.error ?? "Could not open that.")))
            .catch(() => setFailed("Could not open that."));
        setOpened(true);
        void window.orbit.markArtifactOpened(artifact.id).catch(() => undefined);
    };

    const title = gone
        ? `Not where Orbit left it: ${artifact.location}`
        : [
              artifact.location,
              artifact.request ? `\nYou asked: ${artifact.request}` : "",
              `\n${KIND_LABEL[artifact.kind]}, ${opened ? "opened from Orbit before" : "not opened from Orbit"}`,
              "\nAlt-click to show in Finder",
          ].join("");

    return (
        <button
            type="button"
            className={["thread", "artifact", gone && "artifact-gone", failed && "artifact-failed"]
                .filter(Boolean)
                .join(" ")}
            disabled={gone}
            title={failed ?? title}
            onClick={(event) => act(event.altKey || event.shiftKey)}
        >
            <span className={`thread-mark ${opened ? "" : "artifact-new"}`}>
                <Icon name="file" />
            </span>
            <div className="thread-main">
                {/*
                 * Under its own thread the description is already on the row
                 * above, so repeating it wastes the one line there is and makes
                 * the panel look like it is stuttering. The path is the half
                 * that is new there.
                 */}
                {compact ? (
                    <span className="thread-title">
                        {gone ? "moved or deleted" : (failed ?? artifact.shortLocation)}
                    </span>
                ) : (
                    <>
                        <span className="thread-title">{artifact.title}</span>
                        <span className="thread-detail">
                            {gone ? "moved or deleted" : (failed ?? artifact.shortLocation)}
                        </span>
                    </>
                )}
            </div>
            <span className="thread-clock">{compact ? "" : shortSpan(artifact.at, now)}</span>
        </button>
    );
}

/** An empty lane is drawn as nothing at all: five headers reading 0 is noise. */
function Lane({
    label,
    hint,
    threads,
    onDisk,
    now,
}: {
    label: string;
    hint: string;
    threads: BoardThread[];
    onDisk: Map<string, PathInfo>;
    now: number;
}): React.JSX.Element {
    const [all, setAll] = useState(false);
    if (threads.length === 0) return <></>;

    const shown = all ? threads : threads.slice(0, ROWS_PER_LANE);
    return (
        <div className="lane">
            <div className="lane-head" title={hint}>
                <span className="lane-label">{label}</span>
                <em>{threads.length}</em>
            </div>
            {shown.map((thread) => (
                <ThreadRow key={thread.id} thread={thread} onDisk={onDisk} now={now} />
            ))}
            {threads.length > ROWS_PER_LANE && (
                <button className="link center" title={hint} onClick={() => setAll((value) => !value)}>
                    {all ? "fewer" : `${threads.length - ROWS_PER_LANE} more`}
                </button>
            )}
        </div>
    );
}

/**
 * One thread. Two lines and a clock, which is all the width there is.
 *
 * The clock reads differently per lane and says so in the title rather than in
 * the row: "running" counts up from the start, "landed" counts back from the
 * finish, and in the blocked lanes it is how long it has been sitting, which is
 * the number that should sting.
 */
function ThreadRow({
    thread,
    onDisk,
    now,
}: {
    thread: BoardThread;
    onDisk: Map<string, PathInfo>;
    now: number;
}): React.JSX.Element {
    const forward = thread.lane === "running" && thread.kind === "watcher";
    const clock = shortSpan(thread.since, now);
    return (
        <>
            <div className="thread">
                <span
                    className="thread-mark"
                    style={thread.hue !== undefined ? { color: agentColor(thread.hue, thread.lane === "you") } : undefined}
                >
                    <Icon name={THREAD_ICON[thread.kind]} />
                </span>
                <div className="thread-main">
                    <span className="thread-title">{thread.title}</span>
                    <span className="thread-detail">{thread.detail}</span>
                </div>
                <span className="thread-clock" title={forward ? "Until it runs" : "How long it has been like this"}>
                    {clock}
                </span>
            </div>
            {/* What this thread produced, hanging off the row that describes it.
                The other half of the same question: where it got to, and what
                came out of it. */}
            {thread.artifacts?.map((artifact) => (
                <div className="thread-made" key={artifact.id}>
                    <ArtifactRow
                        artifact={artifact}
                        info={onDisk.get(artifact.location)}
                        now={now}
                        compact
                    />
                </div>
            ))}
        </>
    );
}

/**
 * What could not be seen.
 *
 * At the bottom and quiet, but never omitted. An empty lane and an unreadable
 * source look identical from the top of the panel, and only one of them means
 * everything is fine.
 */
function BlindSpots({ spots }: { spots: string[] }): React.JSX.Element {
    if (spots.length === 0) return <></>;
    return (
        <div className="blind-spots" title="Gaps in what this board can actually see">
            <span className="lane-label">not seen</span>
            <ol>
                {spots.map((spot, index) => (
                    <li key={index}>{spot}</li>
                ))}
            </ol>
        </div>
    );
}
