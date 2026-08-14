import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { resolve } from "node:path";

export default defineConfig({
    main: {
        build: {
            rollupOptions: {
                input: resolve("src/main/index.ts"),
                // The SDK spawns the Copilot runtime and uses native FFI, so it
                // must stay external rather than being bundled.
                external: ["@github/copilot-sdk", "koffi", "electron"],
            },
        },
    },
    preload: {
        build: {
            rollupOptions: {
                input: resolve("src/preload/index.ts"),
                output: { format: "es", entryFileNames: "index.mjs" },
            },
        },
    },
    renderer: {
        root: resolve("src/renderer"),
        build: {
            rollupOptions: { input: resolve("src/renderer/index.html") },
        },
        plugins: [react()],
    },
});
