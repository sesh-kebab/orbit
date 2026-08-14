/**
 * `npm run capture:assets`
 *
 * Serves the capture stage with Vite, drives Electron over it, and writes the
 * README assets. Regenerate after any change to the character or the panel:
 * everything is rendered from the app's own components, so a redesign shows up
 * in the assets on the next run and nowhere else.
 *
 * Pass a filter to shoot a subset: `npm run capture:assets -- celebrate`.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { createServer } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));
const outDir = fileURLToPath(new URL("../../assets", import.meta.url));
const only = process.argv.slice(2).join(" ").trim();

const server = await createServer({
    configFile: new URL("./vite.config.mjs", import.meta.url).pathname,
});
await server.listen();

const address = server.httpServer?.address();
const url = `http://127.0.0.1:${typeof address === "object" ? address.port : 5173}/index.html`;
console.log(`[capture] stage at ${url}`);

const child = spawn(electron, [new URL("./main.mjs", import.meta.url).pathname], {
    cwd: here,
    stdio: "inherit",
    env: {
        ...process.env,
        CAPTURE_URL: url,
        CAPTURE_OUT: outDir,
        CAPTURE_ONLY: only,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    },
});

const code = await new Promise((resolve) => child.on("exit", resolve));
await server.close();
process.exit(code ?? 0);
