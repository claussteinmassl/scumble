// "Magnific (subscription)" (magnificsub): the user's Magnific plan through Magnific's remote MCP server, signed in
// over OAuth (magnificsub_auth.js), so that a run spends the plan's credits. docs/PLAN_MAGNIFIC_SUB.md has the design
// and what the spike of 2026-10-01 measured; tools/refs/magnificsub/ holds the tool schemas.
//
// This part is the session: one MCP client per process, connected lazily, and the steps every verb is made of:
//
//   upload(bytes)   creations_request_upload { mimeType } -> { proxyUploadUrl, path }
//                   PUT the bytes to proxyUploadUrl (no credentials; a 5xx retried up to 3 times, a 4xx not)
//                   creations_finalize_upload { path, fileName, visible: false } -> { identifier }
//   waitFor(id)     creations_wait { identifiers: [id], timeoutSeconds <= 25 } until "completed" or "failed"
//   download(id)    creations_register_download { identifiers: [id], tool: "scumble" } -> originals[0].url, the
//                   untouched original (results.url is a JPEG re-encode), fetched over https without credentials
//
// A tool answers structuredContent (returned as it is) or text (returned joined; creations_get is one of those);
// isError becomes an Error with the tool's text. Every error text is scrubbed of the tokens. When the sign-in cannot
// be refreshed, a run fails with "Sign in to Magnific again (Settings › API providers)." and never opens a browser.
//
// On top of it the provider contract of providers/index.js ("the verbs" below):
//
//   upscale(req)    one upload, images_upscale { creationIdentifier, mode, scale: "<factor>x", the mode's own keys }
//   edit(req)       kind "fill": image and mask scaled together to at most 2048 px, multiples of 8, two uploads,
//                   images_retouch { creationIdentifier, maskCreationIdentifier, mode, prompt?, model?, resolution? }
//   generate(req)   kind "text": the reference layers uploaded, images_generate { prompt, mode, aspectRatio, count: 1,
//                   references?: [{ type, identifier }], seed? }
//   cutout(png)     images_remove_background -> the result's alpha as a grey mask (white = keep)
//   balance()       account_balance -> "N credits (plan)"
//   ready()         { ok } or { ok: false, reason }: signed in or not; index.js asks it instead of the key check
//
// Each creation is waited for (creations_wait) and its original downloaded; the answer is the contract's
// { bytes, mime, width, height, info } with info.credits, what the tool's answer says the creation costs.
"use strict";

const auth = require("./magnificsub_auth.js");
const { sleep: realSleep, closestAspect } = require("./util");
const { layoutOf, refRoles, instruction } = require("./refs");

const MAX_UPLOAD = 25 * 1000 * 1000;      // 25 MB: Magnific's plugin refuses more; the lower reading of "MB"
const PUT_RETRIES = 3;
const WAIT_SECONDS = 25;                  // creations_wait polls at most 25 s per call
const DEFAULT_WAIT_MS = 15 * 60 * 1000;
const CALL_TIMEOUT_MS = 120 * 1000;       // images_retouch renders inside the request (up to ~30 s on Magnific's side)

// A tool that only reads, or that only prepares an upload, may be sent again after the connection broke; a tool that
// starts a creation is not: the first attempt may have been charged.
const REPEATABLE = /^(account_balance|creations_(wait|get|register_download|request_upload)|simulate_cost|\w+_list)$/;

function sniff(bytes) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
    if (bytes.length > 12 && Buffer.from(bytes).toString("latin1", 8, 12) === "WEBP") return "image/webp";
    return "image/png";
}

/** True for an error of the sign-in (the SDK's UnauthorizedError, a failed refresh, our ReauthNeeded). */
function isAuthError(err) {
    if (!err) return false;
    if (err.code === "MAGNIFICSUB_REAUTH") return true;
    const name = err.constructor && err.constructor.name;
    if (name === "UnauthorizedError" || name === "InvalidGrantError" || name === "InvalidTokenError") return true;
    return /401 after successful authentication/.test(String(err.message || ""));
}

// the error codes of a connection that broke (Node's sockets and undici, fetch's own)
const NETWORK_CODES = /^(ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|UND_ERR_[A-Z_]+)$/;

/**
 * True for an error of the connection itself (no answer, a dropped session), not of the tool, the sign-in or the code:
 * the SDK's HTTP error, fetch's "fetch failed" TypeError (whose cause names the socket's error), a socket error code,
 * the SDK's "Not connected". Any other TypeError is a fault in the code and is not retried.
 */
function isTransportError(err) {
    if (!err || isAuthError(err)) return false;
    const name = err.constructor && err.constructor.name;
    if (name === "McpError") return false;
    if (name === "StreamableHTTPError") return true;
    const msg = String(err.message || "");
    const code = String(err.code || (err.cause && err.cause.code) || "");
    if (NETWORK_CODES.test(code)) return true;
    if (err instanceof TypeError) return /^(fetch failed|network error|Failed to fetch)/i.test(msg);
    return /ECONNRESET|ECONNREFUSED|socket hang up|^Not connected/i.test(msg);
}

class Session {
    /**
     * ctx: { keys (get/set/clear, keys.js in the app), settings, fetch?, sleep?, now?, version? }.
     * fetch defaults to the global one; sleep and now are injected by the tests.
     */
    constructor(ctx) {
        this.ctx = ctx;
        this.keys = ctx.keys;
        this.server = auth.serverOf(ctx.settings);
        this.fetch = ctx.fetch || globalThis.fetch;
        this.sleep = ctx.sleep || realSleep;
        this.now = ctx.now || Date.now;
        this.client = null;
        this.connecting = null;
    }

    /** Error text with the tokens taken out. */
    scrub(text) { return auth.scrub(text, auth.secretsOf(this.keys)); }

    /** The error a caller sees: the sign-in errors as one sentence, the rest scrubbed. */
    fail(err, prefix) {
        if (isAuthError(err)) return new Error(auth.RESIGN);
        const msg = this.scrub(err && err.message || err);
        return new Error(prefix && !msg.startsWith("Magnific") ? `${prefix}: ${msg}` : msg);
    }

    /** The connected client (one per session; a second caller waits for the first connect). */
    async connect() {
        if (this.client) return this.client;
        if (!this.connecting) {
            this.connecting = this._connect().finally(() => { this.connecting = null; });
        }
        return this.connecting;
    }

    async _connect() {
        const stored = auth.load(this.keys);
        const tokens = stored.server === this.server.url ? stored.tokens : null;
        if (!tokens || !tokens.access_token) throw new Error(auth.NOT_SIGNED_IN);
        auth.checkToken(this.server.test, tokens.access_token);
        auth.checkToken(this.server.test, tokens.refresh_token);
        const { Client, Transport } = auth.sdk();
        const provider = new auth.Provider({ keys: this.keys, server: this.server });
        const transport = new Transport(new URL(this.server.url), { authProvider: provider, fetch: auth.guardFetch(this.fetch, this.server, auth.storedPin(this.keys)) });
        const client = new Client({ name: "scumble", version: this.ctx.version || "0" });
        try {
            await client.connect(transport);
        } catch (err) {
            await client.close().catch(() => {});
            throw this.fail(err, "Magnific (subscription): cannot connect");
        }
        client.onclose = () => { if (this.client === client) this.client = null; };
        this.client = client;
        return client;
    }

    async close() {
        const c = this.client;
        this.client = null;
        if (c) await c.close().catch(() => {});
    }

    /**
     * Calls a tool: structuredContent, or the text of the answer joined. isError throws with the tool's text. After a
     * broken connection the session reconnects once; the call is sent again only when it cannot have been charged.
     */
    async call(name, args = {}) {
        for (let attempt = 0; ; attempt++) {
            const client = await this.connect();
            let r;
            try {
                r = await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
            } catch (err) {
                if (attempt === 0 && isTransportError(err)) {
                    await this.close();
                    if (REPEATABLE.test(name)) continue;
                    throw new Error(`Magnific (subscription): the connection broke during ${name}; it may still run and be charged (check your Magnific library). ${this.scrub(err.message)}`);
                }
                throw this.fail(err, `Magnific ${name}`);
            }
            const text = (r.content || []).filter((c) => c && c.type === "text").map((c) => c.text).join("\n");
            if (r.isError) throw new Error(`Magnific ${name}: ${this.scrub(text || "the tool failed")}`);
            if (r.structuredContent && typeof r.structuredContent === "object") return r.structuredContent;
            return text;
        }
    }

    /** A URL the session may fetch without credentials: https on a public host, or the mock's own origin in a test. */
    plainUrl(url, what) {
        let u;
        try { u = new URL(String(url)); } catch (_) { throw new Error(`Magnific (subscription): the ${what} URL is not a URL.`); }
        const ok = this.server.test ? u.origin === new URL(this.server.url).origin : auth.publicHttps(u);
        if (!ok) throw new Error(`Magnific (subscription): refused the ${what} URL at ${u.protocol}//${u.host} (https to a public host only).`);
        return u.toString();
    }

    /**
     * Uploads a picture as a hidden creation and returns its identifier. opts: { mimeType?, fileName? }.
     * More than 25 MB is refused before any request.
     */
    async upload(bytes, opts = {}) {
        const buf = Buffer.from(bytes);
        if (buf.length > MAX_UPLOAD) throw new Error(`Magnific (subscription): the picture is ${(buf.length / 1e6).toFixed(1)} MB; Magnific takes at most 25 MB per upload.`);
        const mimeType = opts.mimeType || sniff(buf);
        const req = await this.call("creations_request_upload", { mimeType });
        const slot = req && (req.proxyUploadUrl ? req : Array.isArray(req.uploads) && req.uploads[0]);
        if (!slot || !slot.proxyUploadUrl || !slot.path) throw new Error("Magnific creations_request_upload: the answer named no upload URL (the server may have changed; an update of Scumble may be needed).");
        const url = this.plainUrl(slot.proxyUploadUrl, "upload");
        for (let attempt = 0; ; attempt++) {
            let r;
            try {
                r = await this.fetch(url, { method: "PUT", headers: { "content-type": mimeType }, body: buf });
            } catch (err) {
                if (attempt < PUT_RETRIES) { await this.sleep(1000 * 2 ** attempt); continue; }
                throw new Error(`Magnific (subscription): the upload failed - ${this.scrub(err.message)}`);
            }
            if (r.ok) { await r.arrayBuffer().catch(() => null); break; }
            const text = this.scrub((await r.text().catch(() => "")).slice(0, 300));
            if (r.status >= 500 && attempt < PUT_RETRIES) { await this.sleep(1000 * 2 ** attempt); continue; }
            throw new Error(`Magnific (subscription): the upload was refused (${r.status})${text ? " - " + text : ""}`);
        }
        const fin = await this.call("creations_finalize_upload", { path: slot.path, fileName: opts.fileName || "scumble.png", visible: false });
        const id = fin && (fin.identifier || (Array.isArray(fin.results) && fin.results[0] && fin.results[0].identifier));
        if (!id) throw new Error("Magnific creations_finalize_upload: the answer named no creation (the server may have changed).");
        return id;
    }

    /**
     * Waits for a creation: the creations_wait entry once "completed"; throws with the server's reason on "failed",
     * and "timed out" after opts.timeoutMs (default 15 minutes).
     */
    async waitFor(id, opts = {}) {
        const timeoutMs = opts.timeoutMs == null ? DEFAULT_WAIT_MS : opts.timeoutMs;
        const t0 = this.now();
        for (;;) {
            const left = timeoutMs - (this.now() - t0);
            if (left <= 0) break;
            const secs = Math.max(1, Math.min(WAIT_SECONDS, Math.ceil(left / 1000)));
            const asked = this.now();
            const w = await this.call("creations_wait", { identifiers: [id], timeoutSeconds: secs });
            const list = w && Array.isArray(w.results) ? w.results : [];
            const entry = list.find((x) => x && x.identifier === id) || list[0];
            const status = String(entry && entry.status || "").toLowerCase();
            if (status === "completed") return entry;
            if (/^(failed|error|cancel)/.test(status)) throw new Error(`Magnific (subscription): the creation failed - ${this.scrub(entry.failureReason || "no reason given")}`);
            // creations_wait holds the request while the creation runs; one that answered at once is not hammered
            const spent = this.now() - asked;
            const rest = timeoutMs - (this.now() - t0);
            if (spent < 1000 && rest > 0) await this.sleep(Math.min(rest, Math.max(1000, 1000 * ((entry && entry.poll_after_seconds) || 0))));
        }
        throw new Error(`Magnific (subscription): the creation ${id} timed out after ${Math.round(timeoutMs / 1000)} s (it may still finish in your Magnific library).`);
    }

    /** The creation's original: { bytes, mime }, downloaded without credentials. */
    async download(id) {
        const r = await this.call("creations_register_download", { identifiers: [id], tool: "scumble" });
        const orig = r && Array.isArray(r.originals) && (r.originals.find((o) => o && o.identifier === id) || r.originals[0]);
        if (!orig || !orig.url) throw new Error("Magnific creations_register_download: the answer named no original to download.");
        const url = this.plainUrl(orig.url, "download");
        let res;
        try { res = await this.fetch(url); } catch (err) { throw new Error(`Magnific (subscription): the download failed - ${this.scrub(err.message)}`); }
        if (!res.ok) throw new Error(`Magnific (subscription): the download answered ${res.status}.`);
        const bytes = Buffer.from(await res.arrayBuffer());
        return { bytes, mime: res.headers.get("content-type") || sniff(bytes) };
    }
}

// ---- the verbs -----------------------------------------------------------------------------------------------------
//
// The provider contract of providers/index.js on top of the session: upscale, edit (kind "fill", Magnific's retouch),
// generate (kind "text", Generate new with reference layers), plus cutout and balance for the Settings row and the
// cutout backends. The recipes (recipes/magnificsub_*.json) show the labels of docs/PLAN_MAGNIFIC_SUB.md §3 in their
// rows; the tables below turn a label (or the slug itself, for an agent) into what the tool takes, and refuse anything
// else before a picture is uploaded. The lists are curated and static: the catalogs they come from are copied to
// tools/refs/magnificsub/catalog_*.txt (read 2026-10-01).

const LABEL = "Magnific (subscription)";
const SIGN_IN_FIRST = "Sign in to Magnific (subscription) first: Settings › API providers.";
const UPSCALE_WAIT_MS = 50 * 60 * 1000;   // a 16x creative upscale of a large picture takes long on Magnific's side
const RETOUCH_MAX = 2048;                 // images_retouch renders inside the request and dies at 30 s on larger pictures
const RETOUCH_STEP = 8;
const REFS_MAX = 12;                      // images_generate: "references[] (max 12)"
const PROMPT_MAX = 2000;                  // images_upscale's creative prompt

// images_generate's aspectRatio enum (tools/refs/magnificsub/images_generate.json): a model's own list is cut to it
const GENERATE_ASPECTS = ["1:1", "21:9", "16:9", "9:16", "2:3", "3:4", "1:2", "2:1", "5:4", "4:5", "3:2", "4:3"];

const CREATIVE_KEYS = ["presets", "optimised", "creativity", "resemblance", "hdr", "fractality", "engine", "prompt"];
const PRECISION_KEYS = ["sharpness", "grain", "ultraDetail", "precisionPreset"];
const ALL_SCALES = ["2x", "4x", "8x", "16x"];

// catalog_images_upscale_modes_list.txt: each mode's scales and the keys it takes ("supply only that mode's optional params")
const UPSCALE_MODES = Object.freeze({
    "Creative": { slug: "creative", scales: ALL_SCALES, keys: CREATIVE_KEYS, kind: "creative" },
    "Precision sublime": { slug: "ultra-sublime", scales: ALL_SCALES, keys: PRECISION_KEYS.filter((k) => k !== "ultraDetail"), kind: "precision" },
    "Precision photo": { slug: "ultra-photo", scales: ["2x"], keys: PRECISION_KEYS, kind: "precision" },
    "Precision photo denoiser": { slug: "ultra-denoiser", scales: ["2x"], keys: PRECISION_KEYS, kind: "precision" },
    "Precision v1": { slug: "ultra", scales: ["2x"], keys: PRECISION_KEYS, kind: "precision" },
});
// one Preset row for both kinds (a variant has eight setting slots): a creative preset or a precision macro sets the
// sliders on Magnific's side, so the sliders go only with "None (sliders)"
const UPSCALE_PRESETS = Object.freeze({
    "None (sliders)": { slug: null, kind: null, aliases: ["none", ""] },
    "Subtle": { slug: "subtle", kind: "creative" },
    "Vivid": { slug: "vivid", kind: "creative" },
    "Wild": { slug: "wild", kind: "creative" },
    "Balanced": { slug: "balanced", kind: "precision" },
    "Portraits": { slug: "portraits", kind: "precision" },
    "Grainy analog": { slug: "grainyAnalog", kind: "precision" },
});
const UPSCALE_OPTIMISED = Object.freeze({
    "Standard": { slug: "StandardUltra" },
    "Soft portraits": { slug: "SoftPortrait" },
    "Hard portraits": { slug: "HardPortrait" },
    "Art and illustration": { slug: "ArtAndIllustration" },
    "Video game assets": { slug: "VideoGameAssets" },
    "Nature and landscapes": { slug: "NatureAndLandscapes" },
    "Film and photography": { slug: "FilmAndPhotography" },
    "3D renders": { slug: "ThreeDRenders" },
    "Science fiction and horror": { slug: "ScienceFictionAndHorror" },
});
const UPSCALE_ENGINES = Object.freeze({
    "Automatic": { slug: "automatic" },
    "Illusio": { slug: "magnific_illusio" },
    "Sharpy": { slug: "magnific_sharpy" },
    "Sparkle": { slug: "magnific_sparkle" },
});
// the integer rows: [the request key, min, max]
const UPSCALE_SLIDERS = Object.freeze({
    creativity: ["creativity", -10, 10], resemblance: ["resemblance", -10, 10],
    sharpness: ["sharpness", 0, 100], grain: ["grain", 0, 100],
});

const RETOUCH_MODES = Object.freeze({
    "Replace": { slug: "replace" },
    "Erase": { slug: "erase" },
});
// catalog_retouch_models_list.txt, without the beta and private entries; Auto sends no model (the server picks)
const RETOUCH_MODELS = Object.freeze({
    "Auto": { slug: null, modes: ["replace", "erase"], aliases: ["auto", "retouch-auto"] },
    "Classic": { slug: "retouch-classic", modes: ["replace"] },
    "Erase": { slug: "retouch-erase", modes: ["erase"] },
    "Google Nano Banana Pro": { slug: "retouch-imagen-nano-banana-2", modes: ["replace"], resolutions: ["2k", "4k"] },
    "Google Nano Banana 2": { slug: "retouch-imagen-nano-banana-2-flash", modes: ["replace"], resolutions: ["1k", "2k", "4k"] },
});

// catalog_images_models_list.txt: each model's aspect ratios as listed, and how a reference layer goes: as "image"
// where the model takes one, as "style" (a creation as a style picture) where it takes only that
const GENERATE_MODELS = Object.freeze({
    "Auto": { slug: "auto", ref: "image", aspects: ["1:1", "16:9", "9:16", "2:3", "3:4", "1:2", "2:1", "4:5", "3:2", "4:3"] },
    "Flux.2 Pro": { slug: "flux-2", ref: "image", aspects: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "1:2", "2:1", "4:5"] },
    "Flux.2 Max": { slug: "flux-2-max", ref: "image", aspects: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "1:2", "2:1", "4:5"] },
    "GPT 2": { slug: "gpt-2", ref: "image", aspects: ["1:1", "2:1", "3:1", "2:3", "3:2", "3:4", "4:3", "16:9", "9:16", "21:9"] },
    "GPT 2.5": { slug: "gpt-2-mini", ref: "image", aspects: ["1:1", "2:1", "3:1", "2:3", "3:2", "3:4", "4:3", "16:9", "9:16", "21:9"] },
    "Google Nano Banana Pro": { slug: "imagen-nano-banana-2", ref: "image", aspects: ["1:1", "21:9", "16:9", "9:16", "4:3", "4:5", "5:4", "3:4", "3:2", "2:3"] },
    "Google Nano Banana 2": { slug: "imagen-nano-banana-2-flash", ref: "image", aspects: ["1:1", "21:9", "8:1", "4:1", "16:9", "9:16", "1:4", "1:8", "4:3", "4:5", "5:4", "3:4", "3:2", "2:3"] },
    "Seedream 5 Pro": { slug: "seedream-5-pro", ref: "image", aspects: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"] },
    "Ideogram 4.5": { slug: "ideogram-4-5", ref: "image", aspects: ["1:1", "4:5", "5:4", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "1:2", "2:1", "1:3", "3:1"] },
    "Mystic 2.5": { slug: "mystic-2-5", ref: "style", aspects: ["1:1", "16:9", "9:16", "2:3", "3:4", "1:2", "2:1", "4:5", "3:2", "4:3"] },
    "Recraft V4.1": { slug: "recraft-v4-1", ref: "style", aspects: ["1:1", "2:1", "1:2", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16"] },
    "Qwen Image 3.0 Pro": { slug: "qwen-image-3-0-pro", ref: "image", aspects: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "1:2", "2:1", "4:5"] },
});

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** The entry of a label table for a row's value (its label, its slug or an alias); `fallback` for an empty row. */
function pick(table, value, fallback, what) {
    const v = value == null || value === "" ? fallback : String(value);
    if (own(table, v)) return { label: v, ...table[v] };
    const hit = Object.entries(table).find(([, t]) => t.slug === v || (t.aliases || []).includes(v));
    if (hit) return { label: hit[0], ...hit[1] };
    throw new Error(`${LABEL}: no ${what} "${v}" (${Object.keys(table).join(", ")}).`);
}

/** "2x, 4x and 8x". */
function words(list) {
    return list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** A row's integer, or undefined when the row is empty (the server's default holds); out of range is refused. */
function int(value, [key, min, max]) {
    if (value === "" || value == null) return undefined;
    const n = Math.round(+value);
    if (!Number.isFinite(n)) throw new Error(`${LABEL}: ${key} "${value}" is not a number.`);
    if (n < min || n > max) throw new Error(`${LABEL}: ${key} goes from ${min} to ${max}, not ${n}.`);
    return n;
}

/** [width, height] of a PNG's IHDR, or null. */
function pngSize(b) {
    if (!b || b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

/** The session for a run: the app's keys.js and settings unless the context brings its own (the tests). */
function sessionOf(ctx = {}) {
    return sessionFor({
        keys: ctx.keys || require("../keys"),
        settings: ctx.settings || require("../settings").get(),
        fetch: ctx.fetch, sleep: ctx.sleep, now: ctx.now, version: ctx.version,
    });
}

/**
 * Starts a creation, waits for it and downloads its original: { bytes, mime, credits, identifier }. `credits` is what
 * the tool's answer says the creation costs (null when it names none).
 */
async function create(S, tool, args, waitMs) {
    const r = await S.call(tool, args);
    const c = r && typeof r === "object" ? (r.creation || (Array.isArray(r.creations) ? r.creations[0] : null)) : null;
    if (!c || !c.identifier) throw new Error(`Magnific ${tool}: the answer named no creation${r && r.partialFailure ? ` (${S.scrub(r.partialFailure)})` : ""}.`);
    await S.waitFor(c.identifier, { timeoutMs: waitMs });
    const file = await S.download(c.identifier);
    return { ...file, credits: Number.isFinite(+c.credits) && c.credits !== null ? +c.credits : null, identifier: c.identifier };
}

/** The contract's answer for a downloaded original. */
function answer(file, info) {
    const size = pngSize(file.bytes);
    const out = { bytes: file.bytes, mime: file.mime || "image/png", info: { credits: file.credits, ...info } };
    if (size) { out.width = size[0]; out.height = size[1]; }
    return out;
}

// ---- pictures (Scumble's own PNGs, through the context's codec: Electron's nativeImage in the app) -------------

function codecOf(ctx, what) {
    if (!ctx || typeof ctx.bitmap !== "function" || typeof ctx.fromBitmap !== "function") throw new Error(`${LABEL}: this build cannot read the ${what}.`);
    return ctx;
}

/**
 * A bitmap ({ width, height, data } with 4 bytes a pixel, alpha last: nativeImage's BGRA) scaled to W x H by the area
 * average of the source pixels each target pixel covers, the colour weighted by its alpha so a transparent pixel adds
 * no dark fringe.
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

/** The size a retouch goes out at: at most 2048 on the long edge, both edges multiples of 8 (rounded down). */
function retouchSize(w, h) {
    const s = Math.min(1, RETOUCH_MAX / Math.max(w, h));
    const down = (v) => Math.max(RETOUCH_STEP, Math.floor(v * s / RETOUCH_STEP) * RETOUCH_STEP);
    return [down(w), down(h)];
}

/**
 * Image and mask for images_retouch, scaled together: { image, mask, width, height }. A picture already at its size
 * goes as it is; the mask is always made black and white at that size.
 */
function retouchPictures(image, mask, ctx) {
    codecOf(ctx, "picture");
    const bm = ctx.bitmap(image);
    if (!bm || !bm.width || !bm.height) throw new Error(`${LABEL}: the picture could not be read.`);
    const mk = ctx.bitmap(mask);
    if (!mk || !mk.width || !mk.height) throw new Error(`${LABEL}: the mask could not be read.`);
    const [W, H] = retouchSize(bm.width, bm.height);
    const img = W === bm.width && H === bm.height ? Buffer.from(image) : Buffer.from(ctx.fromBitmap(resizeArea(bm, W, H)));
    return { image: img, mask: Buffer.from(ctx.fromBitmap(binaryMask(mk, W, H))), width: W, height: H };
}

// ---- upscale -----------------------------------------------------------------------------------------------------

/** images_upscale's arguments without the creation: the mode's scale and the keys the mode takes, nothing else. */
function upscaleArgs(req) {
    const p = req.params || {};
    const mode = pick(UPSCALE_MODES, p.mode, "Creative", "upscale mode");
    const f = Math.round(+req.factor || 2);
    const scale = `${f}x`;
    if (!mode.scales.includes(scale)) throw new Error(`${LABEL}: ${mode.label} upscales by ${words(mode.scales)} only, not ${req.factor}x.`);
    const preset = pick(UPSCALE_PRESETS, p.preset, "None (sliders)", "preset");
    if (preset.kind && preset.kind !== mode.kind) {
        const fits = Object.keys(UPSCALE_PRESETS).filter((k) => !UPSCALE_PRESETS[k].kind || UPSCALE_PRESETS[k].kind === mode.kind);
        throw new Error(`${LABEL}: the preset ${preset.label} is for the ${preset.kind === "creative" ? "Creative" : "Precision"} modes; ${mode.label} takes ${words(fits)}.`);
    }
    const args = { mode: mode.slug, scale };
    if (mode.kind === "creative") {
        if (preset.slug) args.presets = preset.slug;
        else {
            for (const k of ["creativity", "resemblance"]) { const v = int(p[k], UPSCALE_SLIDERS[k]); if (v !== undefined) args[k] = v; }
        }
        args.optimised = pick(UPSCALE_OPTIMISED, p.optimised, "Standard", "Optimized for").slug;
        args.engine = pick(UPSCALE_ENGINES, p.engine, "Automatic", "engine").slug;
        const prompt = String(req.prompt || "").trim();
        if (prompt) args.prompt = prompt.slice(0, PROMPT_MAX);
    } else if (preset.slug) {
        args.precisionPreset = preset.slug;
    } else {
        for (const k of ["sharpness", "grain"]) { const v = int(p[k], UPSCALE_SLIDERS[k]); if (v !== undefined) args[k] = v; }
    }
    // only what the mode takes goes out (the catalog: "supply only that mode's optional params")
    for (const k of Object.keys(args)) if (k !== "mode" && k !== "scale" && !mode.keys.includes(k)) delete args[k];
    return args;
}

async function upscale(req, ctx = {}) {
    if (!req.image || !req.image.length) throw new Error(`${LABEL}: no picture to upscale.`);
    const args = upscaleArgs(req);   // a factor or a row the mode does not take is refused before the upload
    const S = sessionOf(ctx);
    const id = await S.upload(req.image, { fileName: "scumble.png" });
    const file = await create(S, "images_upscale", { creationIdentifier: id, ...args }, UPSCALE_WAIT_MS);
    return answer(file, { model: args.mode, factor: args.scale });
}

// ---- edit (retouch) ----------------------------------------------------------------------------------------------

/** images_retouch's arguments without the creations, checked before anything is uploaded. */
function retouchArgs(req) {
    const p = req.params || {};
    const mode = pick(RETOUCH_MODES, p.mode, "Replace", "retouch mode");
    const model = pick(RETOUCH_MODELS, p.model, "Auto", "retouch model");
    if (!model.modes.includes(mode.slug)) throw new Error(`${LABEL}: the model ${model.label} does not ${mode.slug}; it takes the mode ${words(model.modes.map((m) => m[0].toUpperCase() + m.slice(1)))}.`);
    const args = { mode: mode.slug };
    if (mode.slug === "replace") {
        const prompt = String(req.prompt || "").trim();
        if (!prompt) throw new Error(`${LABEL}: Replace needs a prompt that says what the selection should become (Erase needs none).`);
        args.prompt = prompt;
    }
    if (model.slug) args.model = model.slug;
    const res = p.resolution == null || p.resolution === "" || p.resolution === "Default" ? null : String(p.resolution);
    if (res) {
        if (!model.resolutions) throw new Error(`${LABEL}: the model ${model.label} takes no resolution; set Resolution to Default.`);
        if (!model.resolutions.includes(res)) throw new Error(`${LABEL}: the model ${model.label} takes the resolution ${words(model.resolutions)}, not ${res}.`);
        args.resolution = res;
    }
    return args;
}

async function edit(req, ctx = {}) {
    if (req.kind !== "fill" || !req.mask || !req.mask.length) throw new Error(`${LABEL} retouch needs the selection as a mask (the variant's input must be fill).`);
    if (!req.image || !req.image.length) throw new Error(`${LABEL}: no picture to retouch.`);
    const args = retouchArgs(req);
    const pics = retouchPictures(req.image, req.mask, ctx);
    const S = sessionOf(ctx);
    const id = await S.upload(pics.image, { fileName: "scumble.png" });
    const maskId = await S.upload(pics.mask, { fileName: "scumble-mask.png" });
    const file = await create(S, "images_retouch", { creationIdentifier: id, maskCreationIdentifier: maskId, ...args }, DEFAULT_WAIT_MS);
    // the answer comes back at its own size; the renderer fits it to the selection's box (stitch.js)
    return answer(file, { model: args.model || "auto", mode: args.mode, sent: [pics.width, pics.height] });
}

/** The retouch sends the picture and the mask; the reference layers stay home. */
function layout(req) {
    if (req.kind !== "fill") throw new Error(`${LABEL} retouch needs the selection as a mask (the variant's input must be fill).`);
    return layoutOf({ seq: [["crop", "creationIdentifier"]], own: [["mask", "maskCreationIdentifier"]], drops: "Retouch takes the picture and the mask alone" });
}

// ---- generate (Generate new) -------------------------------------------------------------------------------------

function generateModel(params) {
    return pick(GENERATE_MODELS, (params || {}).model, "Auto", "model");
}

/**
 * The reference layers of a new image (26f): numbered from 1 as references[] of type "image", at most 12; on a model
 * that takes a creation only as a style picture (Mystic 2.5, Recraft V4.1) they go as style references, unnumbered.
 */
function textLayout(req) {
    const m = generateModel(req.params);
    const refs = refRoles(req).map(([role, i]) => [role, `references[${i}]`, i]);
    if (m.ref === "style") return layoutOf({ own: refs, max: REFS_MAX, style: true });
    return layoutOf({ seq: refs, max: REFS_MAX });
}

/** The model's aspect ratio closest to the asked width and height, from those images_generate takes. */
function aspectFor(model, w, h) {
    const list = model.aspects.filter((a) => GENERATE_ASPECTS.includes(a));
    return closestAspect(Math.max(1, +w || 1), Math.max(1, +h || 1), list.length ? list : ["1:1"]);
}

async function generate(req, ctx = {}) {
    const model = generateModel(req.params);
    const text = String(req.prompt || "").trim();
    if (!text) throw new Error(`${LABEL}: a new image needs a prompt.`);
    const refs = (req.references || []).filter((b) => b && b.length);
    if (refs.length > REFS_MAX) throw new Error(`${LABEL}: at most ${REFS_MAX} reference images go with a new image; this run has ${refs.length}.`);
    const lay = textLayout({ ...req, references: refs, original: 0 });
    const args = { prompt: instruction({ ...req, kind: "text" }, lay, text), mode: model.slug, aspectRatio: aspectFor(model, req.width, req.height), count: 1 };
    if (Number.isInteger(req.seed) && req.seed >= 0 && req.seed <= 4294967295) args.seed = req.seed;
    const S = sessionOf(ctx);
    if (refs.length) {
        const ids = [];
        for (let i = 0; i < refs.length; i++) ids.push(await S.upload(refs[i], { fileName: `scumble-ref-${i + 1}.png` }));
        args.references = ids.map((identifier) => ({ type: model.ref, identifier }));
    }
    const file = await create(S, "images_generate", args, DEFAULT_WAIT_MS);
    const out = answer(file, { model: model.slug, aspect: args.aspectRatio });
    if (args.seed !== undefined) out.seed = args.seed;
    return out;
}

// ---- cutout, balance, ready ----------------------------------------------------------------------------------------

/**
 * Background removal of one picture (PNG bytes): images_remove_background, and the result's alpha as a grey mask
 * (white = keep) at the result's size: { bytes (PNG), mime, width, height, info: { credits, model } }.
 */
async function cutout(image, ctx = {}) {
    if (!image || !image.length) throw new Error(`${LABEL}: no picture to cut out.`);
    codecOf(ctx, "cut-out");
    const S = sessionOf(ctx);
    const id = await S.upload(image, { fileName: "scumble.png" });
    const file = await create(S, "images_remove_background", { creationIdentifier: id }, DEFAULT_WAIT_MS);
    const bm = ctx.bitmap(file.bytes);
    if (!bm || !bm.width || !bm.height) throw new Error(`${LABEL}: the cut-out could not be read.`);
    const n = bm.width * bm.height;
    const out = Buffer.alloc(n * 4);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
        const a = bm.data[j + 3];
        out[j] = a; out[j + 1] = a; out[j + 2] = a; out[j + 3] = 255;
    }
    return { bytes: Buffer.from(ctx.fromBitmap({ width: bm.width, height: bm.height, data: out })), mime: "image/png", width: bm.width, height: bm.height, info: { credits: file.credits, model: "remove-background" } };
}

/** What the plan has left, for the Settings row's "check balance" (account_balance never charges). */
async function balance(ctx = {}) {
    const r = await sessionOf(ctx).call("account_balance", {});
    const credits = r && r.credits && r.credits.available;
    if (!Number.isFinite(+credits) || credits === null) throw new Error(`${LABEL}: the balance answer named no credits.`);
    const plan = r.plan && typeof r.plan.productName === "string" && r.plan.productName ? ` (${r.plan.productName})` : "";
    return `${credits} credits${plan}`;
}

/** Whether a run can start: signed in (index.js asks this instead of the key check). From the store alone. */
function ready(ctx = {}) {
    const st = auth.status({ keys: ctx.keys || require("../keys"), settings: ctx.settings || require("../settings").get() });
    return st.signedIn ? { ok: true } : { ok: false, reason: SIGN_IN_FIRST };
}

/** { signedIn, account? } for the Settings row (describeAll), from the store alone. */
function status(ctx = {}) {
    return auth.status({ keys: ctx.keys || require("../keys"), settings: ctx.settings || require("../settings").get() });
}

// One session per process, for the server the settings name (a change of settings.magnificsub.base starts another).
let shared = null;

/** The process's session for ctx.settings (made on first use). */
function sessionFor(ctx) {
    const server = auth.serverOf(ctx.settings);
    if (shared && shared.server.url === server.url && shared.keys === ctx.keys) return shared;
    if (shared) shared.close();
    shared = new Session(ctx);
    return shared;
}

/** Drops the process's session (after a sign-out or a sign-in, so the next run connects with the new tokens). */
async function resetSession() {
    const s = shared;
    shared = null;
    if (s) await s.close();
}

module.exports = {
    // the provider contract (providers/index.js)
    label: LABEL,
    keyUrl: "https://www.magnific.com",
    keyHint: "No key: sign in with your Magnific account (a run spends your plan's credits)",
    needsKey: false,
    auth: "oauth",
    ready,
    status,
    upscale,
    edit,
    layout,
    generate,
    textLayout,
    cutout,
    balance,
    // the sign-in, for the IPC handlers (call resetSession() after either)
    signIn: auth.signIn,
    signOut: auth.signOut,
    // the session
    Session, sessionFor, resetSession,
    MAX_UPLOAD, WAIT_SECONDS, SIGN_IN_FIRST,
    // exported for tools/magnificsub_test.js
    _isAuthError: isAuthError,
    _isTransportError: isTransportError,
    _upscaleArgs: upscaleArgs,
    _retouchArgs: retouchArgs,
    _retouchSize: retouchSize,
    _aspectFor: aspectFor,
    _tables: { UPSCALE_MODES, UPSCALE_PRESETS, UPSCALE_OPTIMISED, UPSCALE_ENGINES, RETOUCH_MODES, RETOUCH_MODELS, GENERATE_MODELS, GENERATE_ASPECTS },
};
