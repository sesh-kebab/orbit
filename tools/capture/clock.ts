/**
 * A virtual clock for the capture harness.
 *
 * The character animates off `requestAnimationFrame` and `performance.now()`,
 * and the mood machine reads `Date.now()`. Capturing a frame takes tens of
 * milliseconds, so real time would make every animated capture stutter and
 * drift. Instead the page's clock is replaced with one the capture driver
 * advances by an exact frame interval, and the rAF queue is pumped by hand.
 *
 * The result: frame N of a GIF is the same pixel-for-pixel on a fast machine
 * and a slow one, and the animation runs at exactly the frame rate asked for.
 */

import { EPOCH } from "./demo.js";

let virtual = 0;
const pending = new Map<number, FrameRequestCallback>();
let nextId = 1;

export function installClock(): void {
    window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
        const id = nextId++;
        pending.set(id, callback);
        return id;
    };
    window.cancelAnimationFrame = (id: number): void => {
        pending.delete(id);
    };
    performance.now = (): number => virtual;
    Date.now = (): number => EPOCH + virtual;
}

/** Move the clock on and run every frame callback that was waiting on it. */
export function tick(ms: number): void {
    virtual += ms;
    // Snapshot and clear first: each callback re-registers itself for the next
    // frame, and those registrations belong to the *following* tick.
    const due = [...pending.values()];
    pending.clear();
    for (const callback of due) callback(virtual);
}

export function clockNow(): number {
    return virtual;
}

/** Rewind to zero. Used between shots so every capture starts from t = 0. */
export function resetClock(): void {
    virtual = 0;
    pending.clear();
}
