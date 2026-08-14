import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

/**
 * Dev server for the capture stage. Deliberately separate from
 * electron.vite.config.ts: nothing under tools/ may end up in a build of the
 * app, and the stage is only ever served, never bundled.
 */
export default defineConfig({
    root: fileURLToPath(new URL(".", import.meta.url)),
    plugins: [react()],
    server: { host: "127.0.0.1", strictPort: false },
    clearScreen: false,
});
