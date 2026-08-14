// gifenc ships CJS on `main`, so named ESM imports are not detected; the ESM
// build is reachable by path.
import { GIFEncoder, applyPalette, quantize } from "gifenc/dist/gifenc.esm.js";

/**
 * Encode RGBA frames as an animated GIF.
 *
 * Two things keep the files small enough for a README. One palette is built
 * from the whole clip rather than per frame, so no colour table is repeated;
 * and every frame after the first is reduced to what actually changed, with
 * untouched pixels written as transparent over the frame beneath. On these
 * captures — a small character moving inside a still panel — that is most of
 * the image.
 *
 * @param {Uint8ClampedArray[]} frames RGBA pixels, one entry per frame.
 * @param {number} width
 * @param {number} height
 * @param {number} delayMs Frame interval. GIF stores centiseconds, so this
 *   should be a multiple of 10 to play back at the rate asked for.
 * @param {{ colors?: number }} [options]
 * @returns {Uint8Array}
 */
export function encodeGif(frames, width, height, delayMs, options = {}) {
    const colors = options.colors ?? 255;
    const palette = buildPalette(frames, colors);
    const transparentIndex = palette.length;
    palette.push([0, 0, 0]);

    const encoder = GIFEncoder();
    let canvas;

    frames.forEach((frame, index) => {
        const indexed = applyPalette(frame, palette, "rgb565");
        let payload = indexed;

        if (canvas) {
            payload = new Uint8Array(indexed.length);
            for (let pixel = 0; pixel < indexed.length; pixel += 1) {
                const value = indexed[pixel];
                payload[pixel] = value === canvas[pixel] ? transparentIndex : value;
            }
        }
        // Whether a pixel was written or left transparent, the composited
        // canvas now holds the frame's own value.
        canvas = indexed;

        encoder.writeFrame(payload, width, height, {
            palette: index === 0 ? palette : undefined,
            first: index === 0,
            repeat: 0,
            delay: delayMs,
            dispose: 1,
            transparent: index > 0,
            transparentIndex,
        });
    });

    encoder.finish();
    return encoder.bytes();
}

/**
 * One palette for the whole clip, quantised from an even spread of frames.
 * Sampling rather than concatenating keeps this from allocating hundreds of
 * megabytes on a long recording.
 */
function buildPalette(frames, colors) {
    const wanted = Math.min(frames.length, 14);
    const stride = Math.max(1, Math.floor(frames.length / wanted));
    const picked = [];
    for (let index = 0; index < frames.length; index += stride) picked.push(frames[index]);

    const pixelStride = 3;
    const perFrame = Math.floor(frames[0].length / 4 / pixelStride);
    const sample = new Uint8ClampedArray(picked.length * perFrame * 4);
    let cursor = 0;
    for (const frame of picked) {
        for (let pixel = 0; pixel < perFrame; pixel += 1) {
            const source = pixel * pixelStride * 4;
            sample[cursor++] = frame[source];
            sample[cursor++] = frame[source + 1];
            sample[cursor++] = frame[source + 2];
            sample[cursor++] = 255;
        }
    }
    return quantize(sample, colors, { format: "rgb565" });
}

/** Electron hands back BGRA; every encoder here wants RGBA. */
export function bgraToRgba(bitmap) {
    const out = new Uint8ClampedArray(bitmap.length);
    for (let index = 0; index < bitmap.length; index += 4) {
        out[index] = bitmap[index + 2];
        out[index + 1] = bitmap[index + 1];
        out[index + 2] = bitmap[index];
        out[index + 3] = 255;
    }
    return out;
}
