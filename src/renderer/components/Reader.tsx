/**
 * The in-app reader: a deliverable, rendered where it was handed over.
 *
 * The alternatives were a WebContentsView, a `<webview>` tag, and a second
 * window. All three were rejected for the same reason: this app is one small
 * always-on-top panel with a transparent frame and click-through regions, and
 * every one of them puts a second, rectangular, opaquely composited surface
 * over the top of that. A WebContentsView does not clip to the panel's rounded
 * corners or its glass, has to be positioned in main against a layout only the
 * renderer knows, and would have to be hidden and shown in step with a React
 * section. `<webview>` is discouraged by Electron itself and carries a whole
 * process for content that is four screens of static HTML. A second window is
 * the browser he asked not to have, with Orbit's icon on it.
 *
 * A sandboxed iframe is none of those things. It composites inside the panel,
 * it scrolls with it, it is one element in the section it belongs to, and it is
 * strictly more contained than the other three: see `readerDoc.ts` for what the
 * sandbox and the policy actually rule out.
 *
 * The one thing it gives up is the ability to make the document interactive.
 * That is not a loss here. Deliverables are read, not used, and `<details>` and
 * anchors work without a line of script.
 */
import { useEffect, useState } from "react";
import type { ArtifactDoc } from "../../shared/types.js";
import { readerDocument } from "../readerDoc.js";
import { Icon } from "./Icon.js";

export function Reader({ path }: { path: string | undefined }): React.JSX.Element {
    const [doc, setDoc] = useState<ArtifactDoc | undefined>(undefined);

    useEffect(() => {
        if (!path) {
            setDoc(undefined);
            return;
        }
        let live = true;
        setDoc(undefined);
        void window.orbit
            .readArtifact(path)
            .then((result) => {
                if (live) setDoc(result);
            })
            .catch(() => {
                if (live) {
                    setDoc({ ok: false, path, title: "", kind: "html", text: "", error: "Couldn't read that." });
                }
            });
        return () => {
            live = false;
        };
    }, [path]);

    if (!path) {
        return (
            <p className="muted small pad">
                Nothing open. Click an .html or .md file anywhere in the chat and it opens here instead of in a
                browser.
            </p>
        );
    }

    if (!doc) return <p className="muted small pad">Opening {shortName(path)}…</p>;

    if (!doc.ok) {
        return (
            <div className="reader">
                <ReaderHead path={path} title={shortName(path)} />
                <p className="muted small pad">{doc.error ?? "Couldn't open that."}</p>
            </div>
        );
    }

    return (
        <div className="reader">
            <ReaderHead path={doc.path} title={doc.title} />
            <iframe
                className="reader-frame"
                title={doc.title}
                // Empty on purpose. Every token this attribute can carry is a
                // capability being handed back to generated content, and the
                // document needs none of them.
                sandbox=""
                srcDoc={readerDocument(doc.kind, doc.text, doc.title)}
            />
        </div>
    );
}

/** The file it is, and the two ways out of the viewer. */
function ReaderHead({ path, title }: { path: string; title: string }): React.JSX.Element {
    return (
        <div className="reader-head">
            <span className="reader-title" title={path}>
                {title}
            </span>
            <button
                className="link"
                title="Open in your editor"
                onClick={() => void window.orbit.openPath(path).catch(() => undefined)}
            >
                <Icon name="file" /> edit
            </button>
            <button
                className="link"
                title="Show in Finder"
                onClick={() => void window.orbit.revealPath(path).catch(() => undefined)}
            >
                <Icon name="folderOpen" /> show
            </button>
        </div>
    );
}

function shortName(path: string): string {
    const tail = path.split("/").pop();
    return tail && tail.length > 0 ? tail : path;
}
