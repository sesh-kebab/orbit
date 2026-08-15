/**
 * `npm run icons`
 *
 * Serves the icon stage with Vite, drives Electron over it, and writes the
 * icons into build/. Rerun after any change to the character so the Dock icon
 * and the tray mark keep matching what the app actually looks like.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { createServer } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));
const outDir = fileURLToPath(new URL("../../build", import.meta.url));

const server = await createServer({
    configFile: new URL("./vite.config.mjs", import.meta.url).pathname,
});
await server.listen();

const address = server.httpServer.address();
const url = `http://127.0.0.1:${address.port}/index.html`;

const child = spawn(electron, [fileURLToPath(new URL("./main.mjs", import.meta.url))], {
    stdio: "inherit",
    env: { ...process.env, ICON_URL: url, ICON_OUT: outDir },
});

const code = await new Promise((resolve) => child.on("close", resolve));
await server.close();
process.exit(code ?? 0);
