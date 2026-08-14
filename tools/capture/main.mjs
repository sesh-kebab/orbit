/**
 * Electron side of the asset capture harness.
 *
 * Loads the stage (see stage.tsx), poses it shot by shot, and photographs the
 * result with `webContents.capturePage()`. Animated shots are driven one
 * virtual frame at a time, so how long a capture takes has no bearing on what
 * the animation looks like.
 *
 * Not part of the app: nothing in src/ imports this, and it is never built.
 */

import { BrowserWindow, app, nativeImage } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bgraToRgba, encodeGif } from "./gif.mjs";

const STAGE_URL = process.env.CAPTURE_URL;
const OUT_DIR = process.env.CAPTURE_OUT;
/** Optional substring filter, e.g. `npm run capture:assets -- celebrate`. */
const ONLY = process.env.CAPTURE_ONLY?.trim();
/** Set to a stride to also drop every Nth animation frame as a PNG, for eyeballing. */
const DUMP = Number(process.env.CAPTURE_DUMP_FRAMES ?? 0);

app.commandLine.appendSwitch("force-device-scale-factor", "1");

let failure;

void app.whenReady().then(async () => {
    try {
        await run();
    } catch (error) {
        failure = error;
        console.error("[capture] failed:", error);
    } finally {
        app.exit(failure ? 1 : 0);
    }
});

async function run() {
    await mkdir(OUT_DIR, { recursive: true });

    const window = new BrowserWindow({
        width: 900,
        height: 700,
        show: false,
        frame: false,
        useContentSize: true,
        backgroundColor: "#0b0a12",
        webPreferences: { backgroundThrottling: false, offscreen: true },
    });
    window.webContents.setFrameRate(60);

    await window.loadURL(STAGE_URL);
    await window.webContents.executeJavaScript(
        "new Promise((resolve) => { const wait = () => (window.__stage ? resolve(true) : setTimeout(wait, 25)); wait(); })",
    );

    const shots = await window.webContents.executeJavaScript("window.__stage.shots()");
    const written = [];

    for (const [index, shot] of shots.entries()) {
        if (ONLY && !shot.file.includes(ONLY)) continue;
        const started = Date.now();

        let record;
        if (shot.kind === "sheet") {
            record = await captureSheet(window, shot, shots);
        } else {
            await strike(window, shot, index);
            record = shot.frames ? await captureGif(window, shot) : await capturePng(window, shot);
        }
        await writeFile(join(OUT_DIR, shot.file), record.bytes);
        written.push({ ...record, file: shot.file, ms: Date.now() - started });
        console.log(
            `[capture] ${shot.file.padEnd(26)} ${record.width}x${record.height}` +
                `${shot.frames ? ` · ${shot.frames} frames` : ""} · ${kb(record.bytes.length)}`,
        );
    }

    console.log(`[capture] ${written.length} asset(s) written to ${OUT_DIR}`);
}

/** Size the window to the shot and put the stage into its pose. */
async function strike(window, shot, index) {
    window.setContentSize(shot.width * shot.zoom, shot.height * shot.zoom);
    await settle(window, 120);
    await window.webContents.executeJavaScript(`window.__stage.pose(${index})`);
    await settle(window, 170);
}

async function capturePng(window, shot) {
    const image = await shoot(window, shot);
    const size = image.getSize();
    return { bytes: image.toPNG(), width: size.width, height: size.height };
}

async function captureGif(window, shot) {
    const frames = [];
    let size;
    if (DUMP) await mkdir(join(OUT_DIR, "..", ".capture-frames"), { recursive: true });
    for (let frame = 0; frame < shot.frames; frame += 1) {
        const image = await shoot(window, shot);
        size = image.getSize();
        frames.push(bgraToRgba(image.toBitmap()));
        if (DUMP && frame % DUMP === 0) {
            const name = `${shot.file.replace(".gif", "")}-${String(frame).padStart(3, "0")}.png`;
            await writeFile(join(OUT_DIR, "..", ".capture-frames", name), image.toPNG());
        }
        await window.webContents.executeJavaScript(`window.__stage.advance(${shot.interval})`);
    }
    const bytes = encodeGif(frames, size.width, size.height, shot.interval);
    return { bytes: Buffer.from(bytes), width: size.width, height: size.height };
}

/**
 * One photograph, downsampled to the shot's output width. The stage is laid
 * out at `zoom`x so text and the character's curves are supersampled on the
 * way down, which is the whole reason the window is oversized.
 */
async function shoot(window, shot) {
    const image = await window.webContents.capturePage();
    const size = image.getSize();
    if (size.width === 0) throw new Error(`empty capture for ${shot.file}`);
    if (size.width === shot.out) return image;
    const height = Math.round((size.height / size.width) * shot.out);
    return image.resize({ width: shot.out, height, quality: "best" });
}

/**
 * A contact sheet, pasted together from tiles photographed one at a time.
 * Compositing here rather than in the page is what keeps each character in
 * its own document, and therefore its own colour.
 */
async function captureSheet(window, shot, shots) {
    const tiles = [];
    for (const file of shot.tiles) {
        const index = shots.findIndex((candidate) => candidate.file === file);
        if (index < 0) throw new Error(`sheet ${shot.file} wants missing tile ${file}`);
        await strike(window, shots[index], index);
        const image = await shoot(window, shots[index]);
        tiles.push({ bitmap: image.toBitmap(), ...image.getSize() });
    }

    const columns = shot.columns ?? tiles.length;
    const rows = Math.ceil(tiles.length / columns);
    const gap = shot.gap ?? 0;
    const pad = shot.padding ?? 0;
    const cell = tiles[0];
    const width = pad * 2 + columns * cell.width + (columns - 1) * gap;
    const height = pad * 2 + rows * cell.height + (rows - 1) * gap;

    // Electron bitmaps are BGRA; the backdrop matches the tiles' own.
    const canvas = Buffer.alloc(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
        canvas[pixel * 4] = 0x12;
        canvas[pixel * 4 + 1] = 0x0a;
        canvas[pixel * 4 + 2] = 0x0b;
        canvas[pixel * 4 + 3] = 0xff;
    }

    tiles.forEach((tile, index) => {
        const left = pad + (index % columns) * (tile.width + gap);
        const top = pad + Math.floor(index / columns) * (tile.height + gap);
        for (let row = 0; row < tile.height; row += 1) {
            const from = row * tile.width * 4;
            const to = ((top + row) * width + left) * 4;
            tile.bitmap.copy(canvas, to, from, from + tile.width * 4);
        }
    });

    const sheet = nativeImage.createFromBitmap(canvas, { width, height });
    const scaled =
        shot.out && shot.out !== width
            ? sheet.resize({
                  width: shot.out,
                  height: Math.round((height / width) * shot.out),
                  quality: "best",
              })
            : sheet;
    return { bytes: scaled.toPNG(), ...scaled.getSize() };
}

function settle(window, ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function kb(bytes) {
    return bytes > 900_000
        ? `${(bytes / 1_048_576).toFixed(2)} MB`
        : `${Math.round(bytes / 1024)} kB`;
}
