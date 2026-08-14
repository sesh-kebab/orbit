/**
 * One-time move of the state left behind by the app's previous name.
 *
 * The product was renamed from "Mochi" to "Orbit". Both state locations are
 * derived from the product name — Electron's userData directory comes from the
 * app name, and the logs deliberately kept outside it live under `~/.copilot`
 * — so the rename alone would have left every memory, schedule and proposal
 * sitting in a directory nothing reads any more.
 *
 * Entries are moved one at a time rather than by renaming the whole directory:
 * Electron creates userData itself before the app is ready, so the destination
 * already exists by the time this runs. Anything already present in the new
 * location wins, which makes the migration safe to run on every launch and a
 * no-op from the second one onward.
 */

import { app } from "electron";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_PERSONA, ORBIT_HOME_DIR } from "./persistence.js";

/** The old Electron app name, and so the old userData directory name. */
const LEGACY_APP_NAME = "mochi";

/**
 * The state files Orbit owns. Electron's own caches are left behind on purpose:
 * they are disposable, and the compiled dictation helper is keyed by a name
 * that changed with the rename, so it is cheaper to rebuild than to carry over.
 */
const STATE_FILES = [
    "history.jsonl",
    "mcp.json",
    "memories.json",
    "open-items.json",
    "persona.md",
    "proposals.json",
    "schedules.json",
    "session.json",
    "settings.json",
    "window.json",
];

/**
 * The persona template exactly as the previous name shipped it. Compared
 * verbatim, so it must stay frozen even as the current template evolves.
 */
const LEGACY_DEFAULT_PERSONA = `# Mochi's personality

Edit this file to shape how Mochi behaves. It is appended to Mochi's system
prompt every time a session starts, so changes take effect on the next restart
(or when you change the model or workspace).

## Tone
- Dry, quick, a little smug. One joke per message, maximum.
- Short replies. This chat panel is narrow.

## Standing instructions
- (add your own, e.g. "always tell me the file paths you changed")

## Things to never do
- (add your own, e.g. "never push to main")
`;

/**
 * Must run before anything reads userData — the very first thing on app ready.
 * Never throws: a failed migration is a bad day, but a companion that will not
 * start at all is worse, and the old files are still on disk either way.
 */
export function migrateLegacyState(): void {
    const userData = app.getPath("userData");
    const legacyUserData = join(dirname(userData), LEGACY_APP_NAME);
    if (legacyUserData !== userData && existsSync(legacyUserData)) {
        for (const name of STATE_FILES) {
            move(join(legacyUserData, name), join(userData, name));
        }
    }

    move(join(homedir(), ".copilot", LEGACY_APP_NAME), ORBIT_HOME_DIR);

    reseedUntouchedPersona(join(userData, "persona.md"));
}

/**
 * `persona.md` is seeded from a template and then owned by the user, so it is
 * never rewritten — except here. The old template introduced the assistant by
 * its previous name, and that file is appended verbatim to the system prompt,
 * which would leave Orbit calling itself Mochi in its own voice.
 *
 * Only a byte-for-byte copy of the old template is replaced. The moment the
 * user has changed anything at all, their file stands.
 */
function reseedUntouchedPersona(path: string): void {
    try {
        if (!existsSync(path)) return;
        if (readFileSync(path, "utf8").trim() !== LEGACY_DEFAULT_PERSONA.trim()) return;
        writeFileSync(path, DEFAULT_PERSONA, "utf8");
        console.log(`[orbit] refreshed the untouched persona template at ${path}`);
    } catch (error) {
        console.error(`[orbit] could not refresh ${path}:`, error);
    }
}

function move(from: string, to: string): void {
    if (from === to || !existsSync(from) || existsSync(to)) return;
    try {
        renameSync(from, to);
        console.log(`[orbit] migrated ${from} -> ${to}`);
    } catch (error) {
        console.error(`[orbit] could not migrate ${from}:`, error);
    }
}
