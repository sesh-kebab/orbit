/**
 * Finding the Copilot CLI.
 *
 * Orbit does not ship the Copilot runtime. The SDK can bundle it — that is its
 * default — but the binary is ~326 MB per platform, and a user needs the CLI
 * installed and logged in regardless, because authentication lives in
 * `~/.copilot` and is established by `copilot /login`. Bundling a second copy
 * would quadruple the download to save nobody a step.
 *
 * The cost of that choice is this file: without a bundled runtime the SDK has
 * nothing to spawn, so Orbit has to find the user's own binary and be clear
 * when it cannot.
 */

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** Where the CLI ends up for the usual install routes, per platform. */
function candidatePaths(): string[] {
    const home = homedir();
    if (process.platform === "win32") {
        const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
        const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
        return [
            join(appData, "npm", "copilot.cmd"),
            join(appData, "npm", "copilot.ps1"),
            join(programFiles, "nodejs", "copilot.cmd"),
        ];
    }
    return [
        // Homebrew, Apple silicon and Intel respectively.
        "/opt/homebrew/bin/copilot",
        "/usr/local/bin/copilot",
        // npm global installs, including the common nvm and fnm layouts.
        join(home, ".npm-global", "bin", "copilot"),
        join(home, ".local", "bin", "copilot"),
        join(home, ".volta", "bin", "copilot"),
        "/usr/bin/copilot",
    ];
}

function isExecutable(path: string): boolean {
    try {
        accessSync(path, constants.X_OK);
        return true;
    } catch {
        // On Windows the execute bit is meaningless; existence is the test.
        return process.platform === "win32" && existsSync(path);
    }
}

/** Walk PATH by hand rather than shelling out, which is faster and quieter. */
function fromPath(): string | undefined {
    const raw = process.env.PATH;
    if (!raw) return undefined;
    const names =
        process.platform === "win32" ? ["copilot.cmd", "copilot.exe", "copilot"] : ["copilot"];
    for (const dir of raw.split(delimiter)) {
        if (!dir) continue;
        for (const name of names) {
            const candidate = join(dir, name);
            if (isExecutable(candidate)) return candidate;
        }
    }
    return undefined;
}

/**
 * A GUI app on macOS does not inherit the shell's PATH — it gets a minimal one
 * from launchd — so a CLI installed by Homebrew or nvm is invisible to a
 * double-clicked Orbit even though it works in a terminal. Asking the user's
 * login shell is the only reliable way to see what they actually have.
 */
function fromLoginShell(): Promise<string | undefined> {
    if (process.platform === "win32") return Promise.resolve(undefined);
    const shell = process.env.SHELL ?? "/bin/zsh";
    return new Promise((resolve) => {
        let out = "";
        let settled = false;
        const done = (value?: string): void => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        try {
            // A login+interactive shell so profile files are sourced.
            const child = spawn(shell, ["-lic", "command -v copilot"], {
                stdio: ["ignore", "pipe", "ignore"],
            });
            const timer = setTimeout(() => {
                child.kill();
                done(undefined);
            }, 4000);
            child.stdout.on("data", (chunk: Buffer) => {
                out += chunk.toString();
            });
            child.on("error", () => {
                clearTimeout(timer);
                done(undefined);
            });
            child.on("close", () => {
                clearTimeout(timer);
                const found = out.trim().split("\n").pop()?.trim();
                done(found && isExecutable(found) ? found : undefined);
            });
        } catch {
            done(undefined);
        }
    });
}

export interface RuntimeLookup {
    path?: string;
    /** How it was found, for the log and for support questions. */
    source?: "setting" | "path" | "login-shell" | "well-known";
}

/**
 * Resolve the CLI, cheapest check first. An explicit setting always wins, so a
 * user with an unusual install can point Orbit straight at it.
 */
export async function findCopilotCli(override?: string): Promise<RuntimeLookup> {
    if (override) {
        if (isExecutable(override)) return { path: override, source: "setting" };
        // Fall through rather than fail: a stale path in settings.json should
        // not stop a working install being used. Say so, though, or the
        // setting looks like it silently did nothing.
        console.warn(`[orbit] copilotPath "${override}" is not executable; looking elsewhere`);
    }

    const onPath = fromPath();
    if (onPath) return { path: onPath, source: "path" };

    for (const candidate of candidatePaths()) {
        if (isExecutable(candidate)) return { path: candidate, source: "well-known" };
    }

    const viaShell = await fromLoginShell();
    if (viaShell) return { path: viaShell, source: "login-shell" };

    return {};
}

/** Shown in the buddy's broken state, so it has to be short and actionable. */
export function missingCliMessage(): string {
    const install =
        process.platform === "darwin"
            ? "brew install copilot-cli   (or: npm i -g @github/copilot)"
            : "npm i -g @github/copilot";
    return [
        "I can't find the GitHub Copilot CLI, which is where I get my brain.",
        "",
        `Install it:  ${install}`,
        "Then log in: copilot  →  /login",
        "",
        "Already installed somewhere unusual? Put the full path in settings.json as \"copilotPath\".",
    ].join("\n");
}
