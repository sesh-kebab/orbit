import { app, shell } from "electron";
import { spawn } from "node:child_process";
import { statSync, type Stats } from "node:fs";
import { isAbsolute, extname, resolve } from "node:path";
import type { PathInfo } from "../shared/types.js";

/**
 * Opening files the user has just been handed.
 *
 * Agents report absolute paths constantly and a path in a chat bubble is inert
 * — the user has to select it, copy it, switch app, paste. Everything here
 * exists to turn that into a click without turning a chat bubble into a shell:
 * a path is resolved, checked, and handed to the OS as a single argument.
 * Nothing on this route is ever interpreted as a command.
 */

/** Cap on one batch, so a pathological message cannot make main stat forever. */
const MAX_LOOKUPS = 40;

/**
 * Turn whatever the renderer found into an absolute path, or nothing.
 *
 * Only `/…` and `~/…` are accepted. Relative paths are refused deliberately:
 * "src/main" in a sentence is far more often prose than a file, and resolving
 * it against some arbitrary cwd would make the chip point at the wrong thing.
 */
export function resolveUserPath(raw: string): string | undefined {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.includes("\0")) return undefined;

    const expanded =
        trimmed === "~" || trimmed.startsWith("~/")
            ? resolve(app.getPath("home"), trimmed.slice(1).replace(/^\/+/, ""))
            : trimmed;

    if (!isAbsolute(expanded)) return undefined;
    return resolve(expanded);
}

/** Stat a batch of candidate paths. Never throws; missing simply reads false. */
export function inspectPaths(raws: string[]): PathInfo[] {
    // Whether a file opens in an editor or gets shown in Finder depends on
    // whether there is an editor, so the answer is worked out once per batch
    // and matches exactly what `openPath` will go on to do.
    const editor = process.platform === "darwin" && hasVsCode();
    return raws.slice(0, MAX_LOOKUPS).map((raw) => {
        const resolved = resolveUserPath(raw);
        if (!resolved) return { raw, exists: false, isDirectory: false };
        try {
            const stats = statSync(resolved);
            const isDirectory = stats.isDirectory();
            return {
                raw,
                resolved,
                exists: true,
                isDirectory,
                revealOnly: isDirectory
                    ? isBundle(resolved)
                    : !editor && isLaunchable(resolved, stats),
            };
        } catch {
            return { raw, resolved, exists: false, isDirectory: false };
        }
    });
}

/** Where VS Code lives when it is installed the ordinary way. */
const VSCODE_APP = "/Applications/Visual Studio Code.app";

/**
 * Open a path the way the user would expect: source files in their editor,
 * ordinary folders in Finder.
 *
 * The editor is launched through `open -a`, with the path passed as its own
 * argv entry and no shell in between, so spaces and quotes in a filename are
 * just characters rather than an injection surface.
 *
 * `shell.openPath` is the last resort rather than the default, because on macOS
 * "open in the default manner" means *run* for a whole category of paths — an
 * `.app` bundle, a `.command`, anything with the executable bit. These paths
 * come out of message text, which is ultimately model output, so a chip that
 * says "open" must never be a way to launch something. Anything in that
 * category is shown in Finder instead, where the user decides.
 */
export async function openPath(raw: string): Promise<{ ok: boolean; error?: string; revealed?: boolean }> {
    const target = resolveUserPath(raw);
    if (!target) return { ok: false, error: "That isn't an absolute path." };

    let stats: Stats;
    try {
        stats = statSync(target);
    } catch {
        return { ok: false, error: "That path no longer exists." };
    }

    if (stats.isDirectory()) {
        // A bundle is a directory to the filesystem and an application to the
        // OS; opening one launches it.
        if (isBundle(target)) return { ...revealPath(target), revealed: true };
        const failure = await shell.openPath(target);
        return failure ? { ok: false, error: failure } : { ok: true };
    }

    if (process.platform === "darwin" && hasVsCode()) {
        const launched = await launchEditor(target);
        // An editor renders anything harmlessly, so nothing is refused here.
        if (launched) return { ok: true };
        // Fall through: an editor that will not start is no reason to refuse.
    }

    if (isLaunchable(target, stats)) return { ...revealPath(target), revealed: true };

    const failure = await shell.openPath(target);
    return failure ? { ok: false, error: failure } : { ok: true };
}

/**
 * Extensions macOS hands to something that runs them rather than shows them.
 * Not exhaustive — it cannot be — which is why the executable bit is checked
 * too and why anything unrecognised still goes via the editor first.
 */
const LAUNCHABLE_EXTENSIONS = new Set([
    ".app", ".action", ".appex", ".applescript", ".bat", ".cmd", ".command", ".dmg",
    ".exe", ".jar", ".kext", ".mpkg", ".msi", ".osax", ".pkg", ".prefpane", ".ps1",
    ".scpt", ".scptd", ".service", ".shortcut", ".term", ".tool", ".vbs", ".workflow",
    ".xpc",
]);

/** A directory the OS treats as one thing — an app, an installer, a plug-in. */
function isBundle(target: string): boolean {
    return LAUNCHABLE_EXTENSIONS.has(extname(target).toLowerCase());
}

/** Would handing this to LaunchServices run it rather than show it? */
function isLaunchable(target: string, stats: Stats): boolean {
    if (LAUNCHABLE_EXTENSIONS.has(extname(target).toLowerCase())) return true;
    // Anything marked executable, whatever it claims to be.
    return (stats.mode & 0o111) !== 0;
}

/**
 * Hand a link to the user's browser.
 *
 * The scheme is re-checked here rather than trusted from the renderer: this is
 * the process boundary, and everything on the far side of it started life as
 * message text. `shell.openExternal` will happily hand `file:`, `mailto:` or
 * any registered custom scheme to whatever claims it, so only http and https
 * are ever let through. The link always leaves the app — nothing navigates the
 * renderer window, which would replace Orbit's UI with a web page.
 */
export async function openExternalUrl(raw: string): Promise<{ ok: boolean; error?: string }> {
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (!trimmed || trimmed.includes("\0")) return { ok: false, error: "That isn't a link." };

    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        return { ok: false, error: "That isn't a link." };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false, error: "Only web links can be opened." };
    }
    if (!parsed.hostname) return { ok: false, error: "That link has no host." };

    try {
        // The original string is what gets opened, not the parser's
        // round-tripped form: %-encoding and the exact query are how a shared
        // document link stays the link that was shared.
        await shell.openExternal(trimmed);
        return { ok: true };
    } catch {
        return { ok: false, error: "Couldn't open that in your browser." };
    }
}

/** Show a path in Finder with the item itself selected. */
export function revealPath(raw: string): { ok: boolean; error?: string } {
    const target = resolveUserPath(raw);
    if (!target) return { ok: false, error: "That isn't an absolute path." };
    try {
        statSync(target);
    } catch {
        return { ok: false, error: "That path no longer exists." };
    }
    shell.showItemInFolder(target);
    return { ok: true };
}

function hasVsCode(): boolean {
    try {
        return statSync(VSCODE_APP).isDirectory();
    } catch {
        return false;
    }
}

/** Resolves false rather than throwing, so the caller can quietly fall back. */
function launchEditor(target: string): Promise<boolean> {
    return new Promise((done) => {
        try {
            const child = spawn("open", ["-a", VSCODE_APP, "--", target], {
                stdio: "ignore",
                detached: true,
            });
            child.on("error", () => done(false));
            child.on("exit", (code) => done(code === 0));
            child.unref();
        } catch {
            done(false);
        }
    });
}
