/**
 * Electron side of the icon harness: loads the stage, poses it once per icon,
 * and photographs it. Mirrors tools/capture/main.mjs deliberately — same
 * shape, same guarantees — rather than sharing code with it, because the two
 * have different output contracts and coupling them would make both fussier.
 */

import { BrowserWindow, app } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const STAGE_URL = process.env.ICON_URL;
const OUT_DIR = process.env.ICON_OUT;

let failure;

void app.whenReady().then(async () => {
    try {
        await run();
    } catch (error) {
        failure = error;
        console.error("[icons] failed:", error);
    } finally {
        app.exit(failure ? 1 : 0);
    }
});

async function run() {
    const window = new BrowserWindow({
        width: 1200,
        height: 1200,
        show: false,
        frame: false,
        transparent: true,
        useContentSize: true,
        webPreferences: { backgroundThrottling: false, offscreen: true },
    });

    await window.loadURL(STAGE_URL);
    await window.webContents.executeJavaScript(
        "new Promise((r) => { const w = () => (window.__icons ? r(true) : setTimeout(w, 25)); w(); })",
    );

    const shots = await window.webContents.executeJavaScript("window.__icons.shots()");

    for (const shot of shots) {
        await window.webContents.executeJavaScript(
            `window.__icons.pose(${JSON.stringify(shot.name)})`,
        );
        const image = await window.webContents.capturePage({
            x: 0,
            y: 0,
            width: shot.size,
            height: shot.size,
        });
        const target = join(OUT_DIR, shot.out);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, image.toPNG());
        console.log(`[icons] ${shot.out} (${shot.size}px)`);
    }
}
