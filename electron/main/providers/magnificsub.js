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
//   edit(req)       kind "fill": image and mask at most 2048 px (scaled only above), padded to multiples of 8, two uploads,
//                   images_retouch { creationIdentifier, maskCreationIdentifier, mode, prompt?, model?, resolution? }
//                   kind "edit": the crop and the reference layers uploaded, images_generate { prompt, mode,
//                   aspectRatio, count: 1, references: [{ type: "image", identifier }] (the crop first), resolution?, seed? }
//   generate(req)   kind "text": the reference layers uploaded, images_generate { prompt, mode, aspectRatio, count: 1,
//                   references?: [{ type, identifier }], resolution? (the Resolution row), seed? }
//
// What a recipe variant names in its `model` (the dropdown picks the provider, the recipe the model):
//
//   a generate model   the catalog slug ("seedream-5-pro", "flux-2"; magnificsub_tables.js GENERATE_MODELS), for
//                      kind "edit" (input "edit") and kind "text" (its `text.model`, the same slug)
//   an upscaler        "creative"; "precision" with a Mode row (key "mode", a Precision V2 flavour's label or slug:
//                      sublime, photo, photo denoiser; Precision sublime when empty); "precision-v1" (Precision v1,
//                      never a V2 flavour); a mode's slug ("ultra-photo") also names that mode as the default
//   the retouch        "images_retouch" with input "fill" (recipes/magnificsub_retouch.json)
//
// The shapes of the recipes the model recipes replaced (magnificsub_generate, _creative, _precision; removed) still
// run, for an agent or an imported copy: "images_generate" with the model in a Model row (key "model"),
// "images_upscale:creative" and "images_upscale:precision".
//   cutout(png)     images_remove_background -> the result's alpha as a grey mask (white = keep)
//   balance()       account_balance -> "N credits (plan)"
//   ready()         { ok } or { ok: false, reason }: signed in or not; index.js asks it instead of the key check
//
// The retouch answer is cropped back to the picture's part and scaled to the crop's size. Each creation is waited for
// (creations_wait) and its original downloaded; the answer is the contract's
// { bytes, mime, width, height, info } with info.credits, what the tool's answer says the creation costs.
"use strict";

const auth = require("./magnificsub_auth.js");
const { sleep: realSleep, closestAspect } = require("./util");
const { layoutOf, refRoles, instruction } = require("./refs");
const T = require("./magnificsub_tables.js");
const P = require("./magnificsub_pictures.js");

const MAX_UPLOAD = 25 * 1000 * 1000;      // 25 MB: Magnific's plugin refuses more; the lower reading of "MB"
const MAX_DOWNLOAD = 200 * 1000 * 1000;   // an original larger than this is no picture Scumble asked for: aborted
const MAX_REDIRECTS = 5;
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

/** An error of a URL the session will not fetch (never retried, never wrapped). */
function refusal(text) {
    const e = new Error(`Magnific (subscription): ${text}`);
    e.code = "MAGNIFICSUB_REFUSED";
    return e;
}

/** The body of a response, aborted once it passes `max` bytes (by its Content-Length, or while it streams). */
async function readCapped(res, max) {
    const tooLarge = () => new Error(`Magnific (subscription): the download is larger than ${Math.round(max / 1e6)} MB; aborted.`);
    const len = Number(res.headers.get("content-length"));
    if (Number.isFinite(len) && len > max) {
        if (res.body) await res.body.cancel().catch(() => {});
        throw tooLarge();
    }
    if (!res.body || typeof res.body.getReader !== "function") {
        const b = Buffer.from(await res.arrayBuffer());
        if (b.length > max) throw tooLarge();
        return b;
    }
    const reader = res.body.getReader();
    const parts = [];
    let n = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.byteLength;
        if (n > max) { await reader.cancel().catch(() => {}); throw tooLarge(); }
        parts.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
    return Buffer.concat(parts, n);
}

class Session {
    /**
     * ctx: { keys (get/set/clear, keys.js in the app), settings, fetch?, sleep?, now?, version?, maxDownload? }.
     * fetch defaults to the global one; sleep, now and maxDownload are injected by the tests.
     */
    constructor(ctx) {
        this.ctx = ctx;
        this.keys = ctx.keys;
        this.server = auth.serverOf(ctx.settings);
        this.fetch = ctx.fetch || globalThis.fetch;
        this.sleep = ctx.sleep || realSleep;
        this.now = ctx.now || Date.now;
        this.maxDownload = ctx.maxDownload || MAX_DOWNLOAD;
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
        try { u = new URL(String(url)); } catch (_) { throw refusal(`the ${what} URL is not a URL.`); }
        const ok = this.server.test ? u.origin === new URL(this.server.url).origin : auth.publicHttps(u);
        if (!ok) throw refusal(`refused the ${what} URL at ${u.protocol}//${u.host} (https to a public host only).`);
        return u.toString();
    }

    /**
     * A request without credentials to a URL plainUrl let through, following redirects by hand: each target is checked
     * by plainUrl again (a public https URL that redirects to a local host is refused, not followed), at most 5 hops. A
     * PUT follows only 307 and 308, the redirects that keep the method and the body.
     */
    async plainFetch(url, init, what) {
        let at = url;
        for (let hop = 0; ; hop++) {
            const r = await this.fetch(at, { ...init, redirect: "manual" });
            if (r.type === "opaqueredirect") throw refusal(`the ${what} was redirected; refused.`);
            if (r.status < 300 || r.status >= 400 || r.status === 304) return r;
            const loc = r.headers.get("location");
            if (r.body) await r.body.cancel().catch(() => {});
            if (!loc) throw refusal(`the ${what} answered ${r.status} without a target.`);
            if (init.method === "PUT" && r.status !== 307 && r.status !== 308) throw refusal(`the ${what} was redirected (${r.status}); refused.`);
            if (hop >= MAX_REDIRECTS) throw refusal(`the ${what} was redirected more than ${MAX_REDIRECTS} times; refused.`);
            let next;
            try { next = new URL(loc, at).toString(); } catch (_) { throw refusal(`the ${what} was redirected to no URL.`); }
            at = this.plainUrl(next, what);
        }
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
                r = await this.plainFetch(url, { method: "PUT", headers: { "content-type": mimeType }, body: buf }, "upload");
            } catch (err) {
                if (err.code === "MAGNIFICSUB_REFUSED") throw err;
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
     * Waits for a creation: the creations_wait entry once "completed", as the server gave it (its `results.url` is
     * what download() falls back to); throws with the server's reason on "failed", and "timed out" after
     * opts.timeoutMs (default 15 minutes).
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

    /**
     * The creation's file: { bytes, mime }, downloaded without credentials. creations_register_download is always
     * called (it records the download). Its `originals[]` carries the untouched original only of a creation whose
     * `results.url` is a re-encode (an upscale, measured live); for any other (a generated image) the list names none,
     * and `results.url` of the completed wait entry (`entry`, from waitFor) is the file itself. Either URL goes through
     * the same checks (plainUrl, plainFetch's redirects, the size cap).
     */
    async download(id, entry = null) {
        const r = await this.call("creations_register_download", { identifiers: [id], tool: "scumble" });
        const list = r && Array.isArray(r.originals) ? r.originals.filter((o) => o && o.url) : [];
        const orig = list.find((o) => o.identifier === id) || (list.length === 1 && !list[0].identifier ? list[0] : null);
        const own = entry && entry.results && typeof entry.results.url === "string" && entry.results.url ? entry.results.url : null;
        const from = orig ? orig.url : own;
        if (!from) throw new Error(`Magnific (subscription): the creation ${id} is done, but neither creations_register_download (no original) nor creations_wait (no results.url) named a file to download.`);
        const url = this.plainUrl(from, "download");
        let res;
        try { res = await this.plainFetch(url, { method: "GET" }, "download"); } catch (err) {
            if (err.code === "MAGNIFICSUB_REFUSED") throw err;
            throw new Error(`Magnific (subscription): the download failed - ${this.scrub(err.message)}`);
        }
        if (!res.ok) throw new Error(`Magnific (subscription): the download answered ${res.status}.`);
        const bytes = await readCapped(res, this.maxDownload);
        return { bytes, mime: res.headers.get("content-type") || sniff(bytes) };
    }
}

// ---- the verbs -----------------------------------------------------------------------------------------------------
//
// The provider contract of providers/index.js on top of the session: upscale, edit (kind "fill", Magnific's retouch;
// kind "edit", a generate model on the crop), generate (kind "text", Generate new with reference layers), plus cutout
// and balance for the Settings row and the cutout backends. The variant's `model` names the model or the upscaler (the
// header above); the recipes' rows show labels, and magnificsub_tables.js turns a label (or the slug itself, for an
// agent) into what the tool takes; anything else is refused before a picture is uploaded. The pixel work is in
// magnificsub_pictures.js.

const LABEL = T.LABEL;
const SIGN_IN_FIRST = "Sign in to Magnific (subscription) first: Settings › API providers.";
const UPSCALE_WAIT_MS = 50 * 60 * 1000;   // a 16x creative upscale of a large picture takes long on Magnific's side
const REFS_MAX = 12;                      // images_generate: "references[] (max 12)"
const PROMPT_MAX = 2000;                  // images_upscale's creative prompt

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
    const entry = await S.waitFor(c.identifier, { timeoutMs: waitMs });
    const file = await S.download(c.identifier, entry);
    return { ...file, credits: Number.isFinite(+c.credits) && c.credits !== null ? +c.credits : null, identifier: c.identifier };
}

/**
 * The contract's answer for a downloaded original, with its size: from the PNG or JPEG header, else from the
 * context's decoder (any other format nativeImage reads); without either the size stays out.
 */
function answer(file, info, ctx = {}) {
    const out = { bytes: file.bytes, mime: file.mime || "image/png", info: { credits: file.credits, ...info } };
    let size = P.imageSize(file.bytes);
    if (!size && typeof ctx.bitmap === "function") {
        const bm = ctx.bitmap(file.bytes);
        if (bm && bm.width && bm.height) size = [bm.width, bm.height];
    }
    if (size) { out.width = size[0]; out.height = size[1]; }
    return out;
}

function codecOf(ctx, what) {
    if (!ctx || typeof ctx.bitmap !== "function" || typeof ctx.fromBitmap !== "function") throw new Error(`${LABEL}: this build cannot read the ${what}.`);
    return ctx;
}

// ---- upscale -----------------------------------------------------------------------------------------------------

/**
 * The upscale mode of a request: { mode, kind }. The variant's `model` names the recipe it belongs to: "creative"
 * (recipes/magnific_creative.json) or "precision" (magnific_precision.json, whose Mode row picks the Precision mode,
 * Precision sublime when empty); a mode's own slug or label ("ultra-photo") makes that mode the default and its recipe
 * the kind. The older "images_upscale:creative" / "images_upscale:precision" read the same. The bare tool name or none
 * (an agent): no kind, the Mode row alone decides (Creative when empty). Another model is refused.
 */
function upscaleMode(req) {
    const p = req.params || {};
    const m = String(req.model || "").trim().replace(/^images_upscale:?/, "");
    let kind = null, fallback = "Creative";
    if (Object.prototype.hasOwnProperty.call(T.UPSCALE_KINDS, m)) {
        kind = m;
        fallback = T.UPSCALE_KINDS[m].fallback;
    } else if (m) {
        const named = T.pick(T.UPSCALE_MODES, m, null, "upscale mode");
        kind = named.kind;
        fallback = named.label;
    }
    const mode = T.pick(T.UPSCALE_MODES, p.mode, fallback, "upscale mode");
    if (kind && mode.kind !== kind) throw new Error(`${LABEL}: ${mode.label} is not a ${T.UPSCALE_KINDS[kind].label} mode; pick the Magnific upscale recipe that has it.`);
    return { mode, kind };
}

/** images_upscale's arguments without the creation: the mode's scale and the keys the mode takes, nothing else. */
function upscaleArgs(req) {
    const p = req.params || {};
    const { mode } = upscaleMode(req);
    const f = Math.round(+req.factor || 2);
    const scale = `${f}x`;
    if (!mode.scales.includes(scale)) throw new Error(`${LABEL}: ${mode.label} upscales by ${T.words(mode.scales)} only, not ${req.factor}x.`);
    const args = { mode: mode.slug, scale };
    const sliders = (keys) => { for (const k of keys) { const v = T.int(p[k], T.UPSCALE_SLIDERS[k]); if (v !== undefined) args[k] = v; } };
    if (mode.kind === "creative") {
        const preset = T.pick(T.CREATIVE_PRESETS, p.preset, "Subtle", "Creative preset");
        args.presets = preset.slug;
        // the sliders go with "custom" only, sent explicitly: without a preset the server would take "subtle"
        if (preset.slug === "custom") sliders(["creativity", "resemblance", "hdr", "fractality"]);
        args.optimised = T.pick(T.UPSCALE_OPTIMISED, p.optimised, "Standard", "Optimized for").slug;
        args.engine = T.pick(T.UPSCALE_ENGINES, p.engine, "Automatic", "engine").slug;
        const prompt = String(req.prompt || "").trim();
        if (prompt) args.prompt = prompt.slice(0, PROMPT_MAX);
    } else {
        const preset = T.pick(T.PRECISION_PRESETS, p.precisionPreset, "None (sliders)", "Precision preset");
        if (preset.slug) args.precisionPreset = preset.slug;
        else sliders(["sharpness", "grain", "ultraDetail"]);
    }
    // only what the mode takes goes out (the catalog: "supply only that mode's optional params"; no ultraDetail for sublime)
    for (const k of Object.keys(args)) if (k !== "mode" && k !== "scale" && !mode.keys.includes(k)) delete args[k];
    return args;
}

async function upscale(req, ctx = {}) {
    if (!req.image || !req.image.length) throw new Error(`${LABEL}: no picture to upscale.`);
    const args = upscaleArgs(req);   // a factor or a row the mode does not take is refused before the upload
    const S = sessionOf(ctx);
    const id = await S.upload(req.image, { fileName: "scumble.png" });
    const file = await create(S, "images_upscale", { creationIdentifier: id, ...args }, UPSCALE_WAIT_MS);
    return answer(file, { model: args.mode, factor: args.scale }, ctx);
}

// ---- edit (retouch) ----------------------------------------------------------------------------------------------

/** images_retouch's arguments without the creations, checked before anything is uploaded. */
function retouchArgs(req) {
    const p = req.params || {};
    const mode = T.pick(T.RETOUCH_MODES, p.mode, "Replace", "retouch mode");
    const model = T.pick(T.RETOUCH_MODELS, p.model, "Auto", "retouch model");
    if (!model.modes.includes(mode.slug)) throw new Error(`${LABEL}: the model ${model.label} does not ${mode.slug}; it takes the mode ${T.words(model.modes.map((m) => m[0].toUpperCase() + m.slice(1)))}.`);
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
        if (!model.resolutions.includes(res)) throw new Error(`${LABEL}: the model ${model.label} takes the resolution ${T.words(model.resolutions)}, not ${res}.`);
        args.resolution = res;
    }
    return args;
}

/**
 * Image and mask for images_retouch (magnificsub_pictures.js retouchGeometry): { image, mask, geometry, source }. A
 * crop that is already within 2048 and on multiples of 8 goes as it is; otherwise it is scaled (aspect kept) only when
 * larger than 2048, and padded. The mask is always black and white, padded in black (keep).
 */
function retouchPictures(image, mask, ctx) {
    codecOf(ctx, "picture");
    const bm = ctx.bitmap(image);
    if (!bm || !bm.width || !bm.height) throw new Error(`${LABEL}: the picture could not be read.`);
    const mk = ctx.bitmap(mask);
    if (!mk || !mk.width || !mk.height) throw new Error(`${LABEL}: the mask could not be read.`);
    const g = P.retouchGeometry(bm.width, bm.height);
    const same = !g.scaled && g.padWidth === bm.width && g.padHeight === bm.height;
    const img = same ? Buffer.from(image) : Buffer.from(ctx.fromBitmap(P.pad(P.resample(bm, g.width, g.height), g.padWidth, g.padHeight, "edge")));
    const msk = Buffer.from(ctx.fromBitmap(P.pad(P.binaryMask(mk, g.width, g.height), g.padWidth, g.padHeight, "black")));
    return { image: img, mask: msk, geometry: g, source: [bm.width, bm.height] };
}

/**
 * The answer back at the crop's size: the part that held the picture (the padding cut off, in proportion when Magnific
 * answers at another resolution), scaled to the crop when its size differs. An answer exactly the size sent with no
 * padding goes back as it is.
 */
function retouchBack(file, pics, ctx) {
    const g = pics.geometry, [w, h] = pics.source;
    // sent as it was (not scaled, not padded): nothing to cut, the renderer fits it as any answer
    if (!g.scaled && g.padWidth === w && g.padHeight === h) return file;
    const r = ctx.bitmap(file.bytes);
    if (!r || !r.width || !r.height) throw new Error(`${LABEL}: the retouched picture could not be read.`);
    const [cw, ch] = P.contentOf(g, r.width, r.height);
    const back = P.resample(P.crop(r, cw, ch), w, h);
    return { ...file, bytes: Buffer.from(ctx.fromBitmap(back)), mime: "image/png" };
}

const RETOUCH_TOOL = "images_retouch";
const GENERATE_TOOL = "images_generate";
const NEEDS_MASK = `${LABEL} retouch needs the selection as a mask (the variant's input must be fill).`;

/** Whether a request's model is the retouch (its tool's name, or none: the retouch recipe and an agent). */
const isRetouch = (req) => { const m = String(req.model || "").trim(); return !m || m === RETOUCH_TOOL; };

async function retouch(req, ctx) {
    if (!req.mask || !req.mask.length) throw new Error(NEEDS_MASK);
    if (!req.image || !req.image.length) throw new Error(`${LABEL}: no picture to retouch.`);
    const args = retouchArgs(req);
    const pics = retouchPictures(req.image, req.mask, ctx);
    const S = sessionOf(ctx);
    const id = await S.upload(pics.image, { fileName: "scumble.png" });
    const maskId = await S.upload(pics.mask, { fileName: "scumble-mask.png" });
    const file = await create(S, "images_retouch", { creationIdentifier: id, maskCreationIdentifier: maskId, ...args }, DEFAULT_WAIT_MS);
    const g = pics.geometry;
    return answer(retouchBack(file, pics, ctx), { model: args.model || "auto", mode: args.mode, sent: [g.padWidth, g.padHeight] }, ctx);
}

/**
 * kind "fill" with the retouch's model: Magnific's retouch (the selection as the mask). kind "edit" with a generate
 * model's slug: images_generate with the crop as its first reference (editGenerate). A generate model as a fill, and
 * the retouch as an edit, are refused: the variant's input does not fit its model.
 */
async function edit(req, ctx = {}) {
    if (req.kind === "fill") {
        if (!isRetouch(req)) throw new Error(`${LABEL}: ${req.model} edits with the crop and a prompt, not with a mask; the variant's input must be edit.`);
        return retouch(req, ctx);
    }
    if (isRetouch(req)) throw new Error(NEEDS_MASK);
    return editGenerate(req, ctx);
}

/**
 * Where each picture goes. The retouch (kind "fill") sends the picture and the mask, the reference layers stay home.
 * An edit with a generate model (kind "edit"): references[0] the crop, then the Original and the reference layers in
 * their order, numbered from 1 and at most 12 together; the mask stays home (the stitch keeps the selection). A model
 * that takes a creation only as a style picture cannot edit the crop.
 */
function layout(req) {
    if (req.kind === "fill") {
        if (!isRetouch(req)) throw new Error(`${LABEL}: ${req.model} edits with the crop and a prompt, not with a mask; the variant's input must be edit.`);
        return layoutOf({ seq: [["crop", "creationIdentifier"]], own: [["mask", "maskCreationIdentifier"]], drops: "Retouch takes the picture and the mask alone" });
    }
    if (isRetouch(req)) throw new Error(NEEDS_MASK);
    editModel(req);   // an unknown slug or a style-only model is refused here, before anything is sent
    return layoutOf({ seq: [["crop", "references[0]"], ...refRoles(req).map(([role, i]) => [role, `references[${i + 1}]`, i])], max: REFS_MAX });
}

// ---- generate (Generate new, and an edit through images_generate) -------------------------------------------------

/**
 * The generate model of a request: the variant's `model`, a slug of the catalog table (or its label, for an agent);
 * anything else is refused before a picture is uploaded. The tool's name or none (the removed recipe
 * magnificsub_generate, an agent) reads the Model row instead (Auto when empty).
 */
function generateModel(req) {
    const m = String(req.model || "").trim();
    if (!m || m === GENERATE_TOOL) return T.pick(T.GENERATE_MODELS, (req.params || {}).model, "Auto", "model");
    return T.pick(T.GENERATE_MODELS, m, null, "model");
}

/** The generate model of an edit: one that takes the crop as an "image" reference. */
function editModel(req) {
    const model = generateModel(req);
    if (model.ref !== "image") throw new Error(`${LABEL}: ${model.label} takes pictures as style references only, so it cannot edit the crop; use Generate new.`);
    return model;
}

/**
 * The reference layers of a new image (26f): numbered from 1 as references[] of type "image", at most 12; on a model
 * that takes a creation only as a style picture (Mystic 2.5, Recraft V4.1) they go as style references,
 * unnumbered.
 */
function textLayout(req) {
    const m = generateModel(req);
    const refs = refRoles(req).map(([role, i]) => [role, `references[${i}]`, i]);
    if (m.ref === "style") return layoutOf({ own: refs, max: REFS_MAX, style: true });
    return layoutOf({ seq: refs, max: REFS_MAX });
}

// The largest seed sent. images_generate's schema allows 0..4294967295, but models behind it refuse more than a signed
// 32-bit integer: Auto picked Seedream 5 Pro live (2026-10-01), which failed with "`seed` ... must be between -1 and
// 2147483647". The schema does not say so, so every seed is held to the smaller range.
const SEED_MAX = 2147483647;

/**
 * The seed Magnific gets for a run's seed: as it is within 0..2147483647, a larger one mapped into that range by its
 * remainder (the same seed always gives the same Magnific seed); undefined for none or a negative one.
 */
function seedFor(seed) {
    if (!Number.isInteger(seed) || seed < 0) return undefined;
    return seed <= SEED_MAX ? seed : seed % (SEED_MAX + 1);
}

/**
 * The Resolution row's value for images_generate's `resolution`: undefined for an empty row or "Default" (the model's
 * own); a value the model's catalog entry does not list, or any on a model that lists none, is refused before upload.
 */
function resolutionFor(model, params) {
    const v = (params || {}).resolution;
    if (v == null || v === "" || v === "Default") return undefined;
    const res = String(v);
    if (!model.resolutions) throw new Error(`${LABEL}: ${model.label} takes no resolution; set Resolution to Default.`);
    if (!model.resolutions.includes(res)) throw new Error(`${LABEL}: ${model.label} takes the resolution ${T.words(model.resolutions)}, not ${res}.`);
    return res;
}

/** The model's aspect ratio closest to the asked width and height, from those images_generate takes. */
function aspectFor(model, w, h) {
    const list = model.aspects.filter((a) => T.GENERATE_ASPECTS.includes(a));
    return closestAspect(Math.max(1, +w || 1), Math.max(1, +h || 1), list.length ? list : ["1:1"]);
}

// |ln(answer aspect / crop aspect)| up to this: the answer is the crop's shape and is stretched onto it (as magnific.js)
const FIT_SLACK = 0.03;

/** "stretch" when w:h is within 3 % of the crop's W:H, else null (the stitch then centre-crops the answer). */
function fitFor(w, h, W, H) {
    if (!(w > 0 && h > 0 && W > 0 && H > 0)) return null;
    return Math.abs(Math.log(w / h) - Math.log(W / H)) <= FIT_SLACK ? "stretch" : null;
}

/**
 * An edit through images_generate (kind "edit"): the crop uploaded as it is and sent first in references[] as type
 * "image", then the Original and the reference layers (at most 12 together), the instruction numbered by layout(); the
 * aspect ratio the model's closest to the crop's. The answer goes back at its own size, `info.fit` "stretch" when it
 * has the crop's shape (the renderer fits it into the box like any provider's answer, centre-cropping another shape).
 */
async function editGenerate(req, ctx) {
    const model = editModel(req);
    if (!req.image || !req.image.length) throw new Error(`${LABEL}: no picture to edit.`);
    const text = String(req.prompt || "").trim();
    if (!text) throw new Error(`${LABEL}: an edit needs a prompt.`);
    const refs = (req.references || []).filter((b) => b && b.length);
    if (refs.length + 1 > REFS_MAX) throw new Error(`${LABEL}: at most ${REFS_MAX} pictures go with an edit (the crop and ${REFS_MAX - 1} reference images); this run has ${refs.length + 1}.`);
    const lay = layout({ ...req, references: refs, original: refs.length ? req.original : 0 });
    // the crop's shape from the picture sent (its header), else from the request
    const size = P.imageSize(req.image);
    const [w, h] = size && size[0] > 0 && size[1] > 0 ? size : [+req.width, +req.height];
    const args = { prompt: instruction({ ...req, kind: "edit" }, lay, text), mode: model.slug, aspectRatio: aspectFor(model, w, h), count: 1 };
    const resolution = resolutionFor(model, req.params);
    if (resolution) args.resolution = resolution;
    const seed = seedFor(req.seed);
    if (seed !== undefined) args.seed = seed;
    const S = sessionOf(ctx);
    const ids = [await S.upload(req.image, { fileName: "scumble.png" })];
    for (let i = 0; i < refs.length; i++) ids.push(await S.upload(refs[i], { fileName: `scumble-ref-${i + 1}.png` }));
    args.references = ids.map((identifier) => ({ type: "image", identifier }));
    const file = await create(S, "images_generate", args, DEFAULT_WAIT_MS);
    const out = answer(file, { model: model.slug, aspect: args.aspectRatio }, ctx);
    const [aw, ah] = out.width ? [out.width, out.height] : args.aspectRatio.split(":").map(Number);
    out.info.fit = fitFor(aw, ah, w, h);
    if (seed !== undefined) { out.seed = req.seed; out.info.seed = seed; }
    return out;
}

async function generate(req, ctx = {}) {
    const model = generateModel(req);
    const text = String(req.prompt || "").trim();
    if (!text) throw new Error(`${LABEL}: a new image needs a prompt.`);
    const refs = (req.references || []).filter((b) => b && b.length);
    if (refs.length > REFS_MAX) throw new Error(`${LABEL}: at most ${REFS_MAX} reference images go with a new image; this run has ${refs.length}.`);
    const lay = textLayout({ ...req, references: refs, original: 0 });
    const args = { prompt: instruction({ ...req, kind: "text" }, lay, text), mode: model.slug, aspectRatio: aspectFor(model, req.width, req.height), count: 1 };
    const resolution = resolutionFor(model, req.params);
    if (resolution) args.resolution = resolution;
    const seed = seedFor(req.seed);
    if (seed !== undefined) args.seed = seed;
    const S = sessionOf(ctx);
    if (refs.length) {
        const ids = [];
        for (let i = 0; i < refs.length; i++) ids.push(await S.upload(refs[i], { fileName: `scumble-ref-${i + 1}.png` }));
        args.references = ids.map((identifier) => ({ type: model.ref, identifier }));
    }
    const file = await create(S, "images_generate", args, DEFAULT_WAIT_MS);
    const out = answer(file, { model: model.slug, aspect: args.aspectRatio }, ctx);
    // the run's own seed (the same one gives the same Magnific seed again); the one sent is in info
    if (seed !== undefined) { out.seed = req.seed; out.info.seed = seed; }
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

/**
 * Whether a run can start (index.js asks this instead of the key check), from the store alone: signed in, and the
 * sign-in recorded its token endpoint (one stored before that existed could never refresh: sign in again).
 */
function ready(ctx = {}) {
    const keys = ctx.keys || require("../keys");
    const st = auth.status({ keys, settings: ctx.settings || require("../settings").get() });
    if (!st.signedIn) return { ok: false, reason: SIGN_IN_FIRST };
    if (!auth.load(keys).tokenOrigin) return { ok: false, reason: auth.RESIGN };
    return { ok: true };
}

/** { signedIn, account?, email? } for the Settings row, from the store alone. */
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
    // whether the settings point at the loopback mock: a test sign-in opens no browser (index.js signIn)
    isTest: (settings) => auth.serverOf(settings).test,
    // the session
    Session, sessionFor, resetSession,
    MAX_UPLOAD, MAX_DOWNLOAD, WAIT_SECONDS, SIGN_IN_FIRST,
    // exported for tools/magnificsub_test.js
    _isAuthError: isAuthError,
    _isTransportError: isTransportError,
    _upscaleArgs: upscaleArgs,
    _upscaleMode: upscaleMode,
    _generateModel: generateModel,
    _fitFor: fitFor,
    _retouchArgs: retouchArgs,
    _aspectFor: aspectFor,
    _seedFor: seedFor,
    _tables: T,
    _pictures: P,
};
