/**
 * Reading a deliverable without leaving the app.
 *
 * Agents now write self-contained HTML (see `orchestrator/design.ts`), and the
 * obvious way to read an HTML file is a browser, which is exactly what the user
 * asked not to happen: a deliverable he has to alt-tab to is a deliverable he
 * reads later, which mostly means never. So the file is read here and handed to
 * the renderer as text, and the renderer puts it inside a sandboxed frame.
 *
 * Main does the reading rather than the renderer because the renderer has no
 * filesystem, by design. What main does not do is interpret any of it: this
 * returns bytes and a guess at what kind of document they are, and every
 * decision about how to contain the content is made at the point it is rendered.
 *
 * Old markdown deliverables come back through the same door with `kind` set to
 * "markdown", so a folder full of .md files written before any of this existed
 * stays readable rather than being orphaned by the change.
 */
import { statSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { ArtifactDoc } from "../shared/types.js";

/**
 * What the viewer will open rather than hand to the OS.
 *
 * Deliberately short. A .json or .csv is better served by the editor that
 * already opens it, and adding them here would mean building a table viewer to
 * justify having taken the file off the editor.
 */
export const VIEWABLE_EXTENSIONS = new Set([".html", ".htm", ".md", ".markdown"]);

/**
 * 4 MB. Large enough for any document with its images inlined as data URIs,
 * small enough that a file chosen by mistake cannot hang the renderer while it
 * parses. The failure is reported as a failure rather than a truncation,
 * because half a document rendered as if it were whole is a lie about content.
 */
export const ARTIFACT_SIZE_CAP = 4_000_000;

export function isViewable(path: string): boolean {
    return VIEWABLE_EXTENSIONS.has(extname(path).toLowerCase());
}

/**
 * Read a document for the in-app viewer. Never throws.
 *
 * Takes an already-resolved absolute path: resolution is `reveal.ts`'s job and
 * happens at the IPC boundary. Keeping it out of here is what lets this module
 * be verified without Electron, which is where `resolveUserPath` gets the
 * home directory from.
 */
export function readArtifact(target: string): ArtifactDoc {
    const title = basename(target);
    const fail = (error: string): ArtifactDoc => ({ ok: false, path: target, title, kind: "html", text: "", error });

    if (!isViewable(target)) return fail("Orbit's viewer only opens HTML and markdown.");

    let size: number;
    try {
        const stats = statSync(target);
        if (stats.isDirectory()) return fail("That's a folder.");
        size = stats.size;
    } catch {
        return fail("That file no longer exists.");
    }
    if (size > ARTIFACT_SIZE_CAP) {
        return fail(`That file is ${Math.round(size / 1_000_000)}MB, too big to render here. Open it in your editor.`);
    }

    try {
        const text = readFileSync(target, "utf8");
        const extension = extname(target).toLowerCase();
        return {
            ok: true,
            path: target,
            title,
            kind: extension === ".html" || extension === ".htm" ? "html" : "markdown",
            text,
        };
    } catch {
        return fail("Couldn't read that file.");
    }
}
