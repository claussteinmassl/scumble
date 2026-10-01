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
"use strict";

const auth = require("./magnificsub_auth.js");
const { sleep: realSleep } = require("./util");

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
    Session, sessionFor, resetSession,
    MAX_UPLOAD, WAIT_SECONDS,
    _isAuthError: isAuthError,
    _isTransportError: isTransportError,
};
