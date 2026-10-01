// Pixel helpers of "Magnific (subscription)" (magnificsub.js), on bitmaps as the context's codec gives them
// ({ width, height, data } with 4 bytes a pixel, alpha last: Electron's nativeImage keeps BGRA). Plain JS, no I/O.
//
// The retouch geometry: images_retouch renders inside the request and dies at 30 s on large pictures, so the picture
// goes at most 2048 px on the long edge, both edges multiples of 8 (Magnific's plugin does the same). A crop within
// 2048 keeps its pixels 1:1 and is padded up to the next multiple of 8 (the picture by repeating its edge, the mask in
// black = keep); a larger one is scaled with its aspect kept, then padded. The answer is cropped back to the part that
// held the picture and, when that is not the crop's size, scaled to it.
"use strict";

const RETOUCH_MAX = 2048;
const RETOUCH_STEP = 8;

/** [width, height] of a PNG (IHDR) or a JPEG (its first SOF marker); null for anything else. */
function imageSize(bytes) {
    const b = bytes ? Buffer.from(bytes) : null;
    if (!b || b.length < 24) return null;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return [b.readUInt32BE(16), b.readUInt32BE(20)];
    if (b[0] === 0xff && b[1] === 0xd8) {
        let i = 2;
        while (i + 9 < b.length) {
            if (b[i] !== 0xff) { i++; continue; }
            const m = b[i + 1];
            if (m === 0xff) { i++; continue; }
            if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
            // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC): height then width
            if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
            i += 2 + b.readUInt16BE(i + 2);
        }
    }
    return null;
}

/**
 * Scaled by the area average of the source pixels each target pixel covers, the colour weighted by its alpha so a
 * transparent pixel adds no dark fringe. For a smaller target.
 */
function resizeArea(bm, W, H) {
    const { width: w, height: h } = bm;
    const src = bm.data;
    const out = Buffer.alloc(W * H * 4);
    const sx = w / W, sy = h / H;
    for (let y = 0; y < H; y++) {
        const y0 = Math.min(h - 1, Math.floor(y * sy)), y1 = Math.max(y0 + 1, Math.min(h, Math.ceil((y + 1) * sy)));
        for (let x = 0; x < W; x++) {
            const x0 = Math.min(w - 1, Math.floor(x * sx)), x1 = Math.max(x0 + 1, Math.min(w, Math.ceil((x + 1) * sx)));
            let c0 = 0, c1 = 0, c2 = 0, a = 0, n = 0;
            for (let yy = y0; yy < y1; yy++) {
                for (let xx = x0, j = (yy * w + x0) * 4; xx < x1; xx++, j += 4) {
                    const al = src[j + 3];
                    c0 += src[j] * al; c1 += src[j + 1] * al; c2 += src[j + 2] * al; a += al; n++;
                }
            }
            const o = (y * W + x) * 4;
            if (a) { out[o] = Math.round(c0 / a); out[o + 1] = Math.round(c1 / a); out[o + 2] = Math.round(c2 / a); }
            out[o + 3] = Math.round(a / n);
        }
    }
    return { width: W, height: H, data: out };
}

/** Scaled bilinearly (pixel centres aligned), for a target at least as large on one side. */
function resizeBilinear(bm, W, H) {
    const { width: w, height: h } = bm;
    const src = bm.data;
    const out = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) {
        const fy = Math.min(h - 1, Math.max(0, (y + 0.5) * h / H - 0.5));
        const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
        for (let x = 0; x < W; x++) {
            const fx = Math.min(w - 1, Math.max(0, (x + 0.5) * w / W - 0.5));
            const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
            const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, d = (y1 * w + x1) * 4;
            const o = (y * W + x) * 4;
            for (let k = 0; k < 4; k++) {
                const top = src[a + k] + (src[b + k] - src[a + k]) * tx;
                const bottom = src[c + k] + (src[d + k] - src[c + k]) * tx;
                out[o + k] = Math.round(top + (bottom - top) * ty);
            }
        }
    }
    return { width: W, height: H, data: out };
}

/** Scaled to W x H: the area average when smaller on both sides, bilinear otherwise; the same bitmap at its size. */
function resample(bm, W, H) {
    if (W === bm.width && H === bm.height) return bm;
    return W <= bm.width && H <= bm.height ? resizeArea(bm, W, H) : resizeBilinear(bm, W, H);
}

/**
 * The mask at W x H in black and white only (white = change, as images_retouch takes it): the nearest source pixel,
 * white from 128 on (the first channel; a grey mask has the same value in all three), opaque.
 */
function binaryMask(bm, W, H) {
    const out = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) {
        const sy = Math.min(bm.height - 1, Math.floor((y + 0.5) * bm.height / H));
        for (let x = 0; x < W; x++) {
            const sx = Math.min(bm.width - 1, Math.floor((x + 0.5) * bm.width / W));
            const v = bm.data[(sy * bm.width + sx) * 4] >= 128 ? 255 : 0;
            const o = (y * W + x) * 4;
            out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 255;
        }
    }
    return { width: W, height: H, data: out };
}

/** The bitmap at the top left of a W x H one; the rest repeats the edge pixels ("edge") or is opaque black ("black"). */
function pad(bm, W, H, fill) {
    if (W === bm.width && H === bm.height) return bm;
    const out = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) {
        const sy = Math.min(y, bm.height - 1);
        for (let x = 0; x < W; x++) {
            const o = (y * W + x) * 4;
            if (fill === "black" && (x >= bm.width || y >= bm.height)) { out[o + 3] = 255; continue; }
            const j = (sy * bm.width + Math.min(x, bm.width - 1)) * 4;
            out[o] = bm.data[j]; out[o + 1] = bm.data[j + 1]; out[o + 2] = bm.data[j + 2]; out[o + 3] = bm.data[j + 3];
        }
    }
    return { width: W, height: H, data: out };
}

/** The top-left W x H of a bitmap. */
function crop(bm, W, H) {
    if (W === bm.width && H === bm.height) return bm;
    const out = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) Buffer.from(bm.data.buffer, bm.data.byteOffset, bm.data.byteLength).copy(out, y * W * 4, y * bm.width * 4, y * bm.width * 4 + W * 4);
    return { width: W, height: H, data: out };
}

/**
 * How a w x h crop goes to images_retouch: { width, height } the picture's part (the crop itself up to 2048 on the long
 * edge, else scaled with its aspect kept), { padWidth, padHeight } the size sent (rounded up to multiples of 8), and
 * whether it was scaled.
 */
function retouchGeometry(w, h) {
    const s = Math.min(1, RETOUCH_MAX / Math.max(w, h));
    const width = s < 1 ? Math.max(1, Math.round(w * s)) : w;
    const height = s < 1 ? Math.max(1, Math.round(h * s)) : h;
    const up = (v) => Math.ceil(v / RETOUCH_STEP) * RETOUCH_STEP;
    return { width, height, padWidth: up(width), padHeight: up(height), scaled: s < 1 };
}

/** The part of an answer of W x H that holds the picture, when the request was g.padWidth x g.padHeight. */
function contentOf(g, W, H) {
    if (W === g.padWidth && H === g.padHeight) return [g.width, g.height];
    return [Math.max(1, Math.min(W, Math.round(W * g.width / g.padWidth))), Math.max(1, Math.min(H, Math.round(H * g.height / g.padHeight)))];
}

module.exports = { RETOUCH_MAX, RETOUCH_STEP, imageSize, resizeArea, resizeBilinear, resample, binaryMask, pad, crop, retouchGeometry, contentOf };
