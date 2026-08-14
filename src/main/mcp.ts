import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { MCPServerConfig } from "@github/copilot-sdk";

/**
 * MCP servers Orbit hands to every session it creates — its own and each
 * delegated agent's.
 *
 * Which servers exist, and the endpoints they point at, are properties of the
 * machine Orbit is running on rather than of Orbit itself, so none of it is
 * hard-coded here. It lives in `mcp.json` in the app's data directory, in the
 * same shape as `~/.copilot/mcp-config.json`, and is hand-editable without the
 * app running.
 *
 * On first launch that file is seeded from the user's existing Copilot CLI
 * config if there is one, so whatever `copilot` can already reach, Orbit can
 * too. Otherwise it is seeded empty and Orbit simply runs without MCP.
 */
/**
 * Cold starts pay for an EntraID token fetch before the server answers
 * `tools/list`; the runtime's default timeout is short enough to lose that
 * race, and a server that loses it is dropped silently for the whole session.
 */
const STARTUP_TIMEOUT_MS = 120_000;

/** The user's Copilot CLI config, which is the natural source for a seed. */
function copilotConfigPath(): string {
    const home = app.getPath("home");
    return join(process.env.COPILOT_HOME ?? join(home, ".copilot"), "mcp-config.json");
}

function seedServers(): Record<string, MCPServerConfig> {
    try {
        const raw = readFileSync(copilotConfigPath(), "utf8");
        const parsed = JSON.parse(raw) as { mcpServers?: Record<string, MCPServerConfig> };
        return parsed.mcpServers ?? {};
    } catch {
        return {};
    }
}

/**
 * Directories that hold CLIs an MCP server may need (`agency`, `npx`, …).
 *
 * A GUI launch — Dock, Spotlight, a built .app — inherits a bare PATH that has
 * none of them, so a server that works from a terminal silently fails to start.
 * These are appended to whatever PATH we already have, never replacing it.
 */
function toolPathCandidates(): string[] {
    const home = app.getPath("home");
    return [
        join(home, ".config", "agency", "CurrentVersion"),
        join(home, ".local", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
    ];
}

/**
 * PATH for spawned MCP servers: the inherited one first (so a user's own
 * choices win), then the well-known tool directories that a GUI launch misses.
 */
export function mcpPath(): string {
    const current = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
    const missing = toolPathCandidates().filter(
        (dir) => !current.includes(dir) && existsSync(dir),
    );
    return [...current, ...missing].join(delimiter);
}

function configPath(): string {
    return join(app.getPath("userData"), "mcp.json");
}

/**
 * Load Orbit's MCP servers, seeding the file on first run from the user's
 * Copilot CLI config. A malformed or empty file yields no servers rather than
 * throwing: MCP is an enhancement, and Orbit should still start without it.
 */
export function loadMcpServers(): Record<string, MCPServerConfig> {
    const path = configPath();
    if (!existsSync(path)) {
        const seed = seedServers();
        try {
            mkdirSync(app.getPath("userData"), { recursive: true });
            writeFileSync(path, JSON.stringify({ mcpServers: seed }, null, 2), "utf8");
            console.log(
                `[orbit] seeded ${path} with ${Object.keys(seed).length} MCP server(s); edit it to add more`,
            );
        } catch (error) {
            console.error("[orbit] could not seed mcp.json:", error);
        }
        return withPath(seed);
    }

    try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as {
            mcpServers?: Record<string, MCPServerConfig>;
        };
        return withPath(parsed.mcpServers ?? {});
    } catch (error) {
        console.error("[orbit] could not read mcp.json, continuing without MCP:", error);
        return {};
    }
}

/**
 * Give every stdio server the augmented PATH and a startup timeout generous
 * enough to survive a cold auth handshake, unless the config pins its own.
 *
 * `env` replaces the server's environment rather than extending it, so the
 * inherited one has to be carried over explicitly — `agency` resolves its token
 * cache under `$HOME` and hangs waiting on interactive auth without it.
 */
function withPath(servers: Record<string, MCPServerConfig>): Record<string, MCPServerConfig> {
    const path = mcpPath();
    const inherited: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) inherited[key] = value;
    }

    const resolved: Record<string, MCPServerConfig> = {};
    for (const [name, server] of Object.entries(servers)) {
        const timeout = server.timeout ?? STARTUP_TIMEOUT_MS;
        if ("command" in server) {
            resolved[name] = {
                ...server,
                timeout,
                env: { ...inherited, PATH: path, ...server.env },
            };
        } else {
            resolved[name] = { ...server, timeout };
        }
    }
    return resolved;
}
