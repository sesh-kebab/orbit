/**
 * Getting a click on a file to the viewer.
 *
 * A path is clickable in two places that know nothing about each other: inside
 * a chat message, and in the board's list of things Orbit has made. Neither
 * sits anywhere near the panel state that decides which section is showing, and
 * threading a callback from the chat panel down through message parsing to a
 * chip would be a prop on every component in between, most of which have no
 * business knowing the viewer exists.
 *
 * So the chips announce, and the panel listens. One event, one listener, and
 * the components in the middle stay ignorant.
 */

/** What the viewer will take. Matches `VIEWABLE_EXTENSIONS` in main. */
const VIEWABLE = /\.(html?|markdown|md)$/i;

/**
 * Is this something the in-app viewer should take rather than the editor?
 *
 * Directories never are, whatever they are called, and a path that does not
 * exist is left to the ordinary open path so the failure it reports is the
 * accurate one.
 */
export function isViewable(path: string, isDirectory = false): boolean {
    return !isDirectory && VIEWABLE.test(path.trim());
}

const OPEN_EVENT = "orbit:read-artifact";

/** Ask the panel to show this document. */
export function openInReader(path: string): void {
    window.dispatchEvent(new CustomEvent<string>(OPEN_EVENT, { detail: path }));
}

/** Listen for those requests. Returns the unsubscribe, for an effect's cleanup. */
export function onReaderOpen(callback: (path: string) => void): () => void {
    const listener = (event: Event): void => {
        const path = (event as CustomEvent<string>).detail;
        if (typeof path === "string" && path) callback(path);
    };
    window.addEventListener(OPEN_EVENT, listener);
    return () => window.removeEventListener(OPEN_EVENT, listener);
}
