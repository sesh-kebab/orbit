import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/** Dev server for the icon stage. Served only, never bundled into the app. */
export default defineConfig({
    root: fileURLToPath(new URL(".", import.meta.url)),
    plugins: [react()],
    server: { host: "127.0.0.1", strictPort: false },
    clearScreen: false,
});
