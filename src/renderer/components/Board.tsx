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
import { useState } from "react";
import type { Board, BoardThread, ChiefCall, Confidence, OrbitState, ThreadLane } from "../../shared/types.js";
import { agentColor, elapsedLabel } from "../mood.js";
import { Icon, type IconName } from "./Icon.js";

/** Calls shown before the list folds. More than this and none of them get read. */
const CALLS_SHOWN = 3;

/** Rows per lane before it folds. A lane is a summary, not an inventory. */
const ROWS_PER_LANE = 4;

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
    const empty = board.threads.length === 0 && board.calls.length === 0;

    return (
        <div className="deck-list board">
            <Calls board={board} />
            {LANES.map((lane) => (
                <Lane
                    key={lane.id}
                    label={lane.label}
                    hint={lane.hint}
                    threads={board.threads.filter((thread) => thread.lane === lane.id)}
                />
            ))}
            {empty && (
                <p className="muted small pad">
                    Nothing in flight, nothing waiting. Ask for something and it will show up here.
                </p>
            )}
            <BlindSpots spots={board.blindSpots} />
        </div>
    );
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

/** An empty lane is drawn as nothing at all: five headers reading 0 is noise. */
function Lane({
    label,
    hint,
    threads,
}: {
    label: string;
    hint: string;
    threads: BoardThread[];
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
                <ThreadRow key={thread.id} thread={thread} />
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
function ThreadRow({ thread }: { thread: BoardThread }): React.JSX.Element {
    const forward = thread.lane === "running" && thread.kind === "watcher";
    const clock = forward
        ? elapsedLabel(Date.now(), thread.since)
        : elapsedLabel(thread.since, Date.now());
    return (
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
