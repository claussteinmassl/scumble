// Sign-in for "Magnific (subscription)" (magnificsub): OAuth against Magnific's MCP server, so that a run spends the
// user's plan credits instead of an API key's (docs/PLAN_MAGNIFIC_SUB.md).
//
// The MCP SDK does the protocol: StreamableHTTPClientTransport answers a 401 by discovering the protected resource's
// metadata, the realm it names (https://auth.magnific.com/realms/mcp, Keycloak), registering a client dynamically,
// and sending the browser to the realm with a PKCE (S256) challenge; transport.finishAuth(code) trades the code for
// tokens, and a later 401 refreshes them. This file is the SDK's OAuthClientProvider and the loopback redirect:
//
//   - Scumble registers a client of its own (client_name "Scumble", public, no secret). It never uses the client id of
//     Magnific's plugins and never presents itself as one of them.
//   - The redirect is http://127.0.0.1:<ephemeral port>/callback. A registered client is bound to its redirect URI, so
//     the client is stored with the URI it was registered for, and a sign-in on another port registers again
//     (registration is cheap; the old client only ever refreshes the tokens it was given).
//   - Everything (the client, the tokens, the PKCE verifier while a sign-in runs, the plan's name) is one JSON value in
//     keys.js under "magnificsub" (safeStorage), never in settings.json. The store is injected: { get, set, clear }
//     like keys.js, so the tests use a fake.
//   - The host is https://mcp.magnific.com. settings.magnificsub.base may name a loopback mock
//     (http://127.0.0.1:<port>, nothing else), and then only a token that starts with "test-" goes there, while such
//     a token never goes to Magnific: checkToken() before any request, and guardFetch() on every request the SDK makes.
"use strict";

const http = require("node:http");
const crypto = require("node:crypto");

const NAME = "magnificsub";
const HOST = "https://mcp.magnific.com";
const SCOPE = "openid profile email mcp:custom-audience";
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
const RESIGN = "Sign in to Magnific again (Settings › API providers).";
const NOT_SIGNED_IN = "Magnific (subscription): not signed in; sign in under Settings › API providers.";
const DONE_PAGE = "<!doctype html><meta charset=utf-8><title>Scumble</title><p style=\"font:16px system-ui;margin:3em\">Signed in to Magnific. You can close this tab.</p>";

// ---- host and token ------------------------------------------------------------------------------------------------

/** http://127.0.0.1:<port> (the test mock) or null: the only base a setting may name. */
function testBase(value) {
    if (!value) return null;
    let u;
    try { u = new URL(String(value).trim()); } catch (_) { return null; }
    if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== "/")) return null;
    if (u.protocol === "http:" && u.hostname === "127.0.0.1" && u.port) return `${u.protocol}//${u.host}`;
    return null;
}

/** { url, test }: the MCP server to talk to (the mock only through settings.magnificsub.base). */
function serverOf(settings) {
    const s = (settings && settings.magnificsub) || {};
    const mock = testBase(s.base);
    return { url: mock || HOST, test: !!mock };
}

/** A test token goes only to the mock, a real one never there. Throws before any request. */
function checkToken(test, token) {
    if (!token) return;
    const isTest = /^test-/.test(String(token));
    if (test && !isTest) throw new Error("Magnific (subscription): the host is set to a test address (settings.magnificsub.base), and only a test sign-in goes there; clear the setting to use your Magnific account.");
    if (!test && isTest) throw new Error("Magnific (subscription): a test sign-in is never sent to Magnific; sign in again under Settings › API providers.");
}

/** The text with every secret in `secrets` replaced, and any Bearer value. */
function scrub(text, secrets = []) {
    let s = String(text == null ? "" : text);
    for (const k of secrets) if (k && String(k).length >= 6) s = s.split(String(k)).join("[token]");
    return s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [token]");
}

function headerOf(headers, name) {
    if (!headers) return null;
    if (typeof headers.get === "function") return headers.get(name);
    if (Array.isArray(headers)) { const e = headers.find(([k]) => String(k).toLowerCase() === name); return e ? e[1] : null; }
    const k = Object.keys(headers).find((x) => x.toLowerCase() === name);
    return k ? headers[k] : null;
}

/** The credentials a request carries: the Bearer token and a refresh token in a form body. */
function credentialsOf(init) {
    const out = [];
    const auth = headerOf(init && init.headers, "authorization");
    const m = auth && /^Bearer\s+(.+)$/i.exec(String(auth));
    if (m) out.push(m[1]);
    const body = init && init.body;
    const form = body instanceof URLSearchParams ? body : (typeof body === "string" && /(^|&)grant_type=/.test(body) ? new URLSearchParams(body) : null);
    if (form && form.get("refresh_token")) out.push(form.get("refresh_token"));
    return out;
}

/**
 * fetch with the host rule on every request: against the mock, nothing leaves the mock's origin and every credential
 * is a test one; against Magnific, nothing goes over plain http or to a loopback address, every credential is a real
 * one, and the access token goes to the MCP server's origin alone (the refresh token to the realm's token endpoint).
 */
function guardFetch(fetchImpl, server) {
    const origin = new URL(server.url).origin;
    return async (input, init) => {
        const u = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
        const creds = credentialsOf(init);
        for (const c of creds) checkToken(server.test, c);
        if (server.test) {
            if (u.origin !== origin) throw new Error(`Magnific (subscription): the test server sent the app to ${u.origin}; refused.`);
        } else {
            if (u.protocol !== "https:") throw new Error(`Magnific (subscription): refused a request over ${u.protocol} to ${u.host}.`);
            const bearer = /^Bearer\s/i.test(String(headerOf(init && init.headers, "authorization") || ""));
            if (bearer && u.origin !== origin) throw new Error(`Magnific (subscription): refused to send the sign-in to ${u.host}.`);
        }
        return fetchImpl(input, init);
    };
}

// ---- the stored value -----------------------------------------------------------------------------------------------

/** The stored JSON ({} when none): { server, redirect, client, tokens, codeVerifier, account }. */
function load(keys) {
    try { return JSON.parse(keys.get(NAME) || "{}") || {}; } catch (_) { return {}; }
}

function save(keys, patch) {
    const next = { ...load(keys), ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    keys.set(NAME, JSON.stringify(next));
}

/**
 * The SDK's OAuthClientProvider over the stored value. `redirect` is the loopback URI of a running sign-in; without
 * one (a run) the stored client's own URI stands in, and a needed browser step throws ReauthNeeded instead of opening
 * anything: a run never starts a sign-in.
 */
class Provider {
    constructor({ keys, server, redirect = null, open = null, state = null }) {
        this.keys = keys;
        this.server = server;
        this.interactive = !!redirect;
        this._redirect = redirect || load(keys).redirect || "http://127.0.0.1/callback";
        this.open = open;
        this._state = state || crypto.randomBytes(16).toString("hex");
    }
    get redirectUrl() { return this._redirect; }
    get clientMetadata() {
        return {
            client_name: "Scumble", redirect_uris: [this._redirect], grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"], token_endpoint_auth_method: "none", scope: SCOPE,
        };
    }
    state() { return this._state; }
    /** The stored client, if it was registered at this server for this redirect URI. */
    clientInformation() {
        const s = load(this.keys);
        if (!s.client || s.server !== this.server.url || s.redirect !== this._redirect) return undefined;
        return s.client;
    }
    saveClientInformation(client) { save(this.keys, { server: this.server.url, redirect: this._redirect, client }); }
    tokens() {
        const s = load(this.keys);
        return s.server === this.server.url ? s.tokens : undefined;
    }
    saveTokens(tokens) {
        checkToken(this.server.test, tokens && tokens.access_token);
        save(this.keys, { tokens });
    }
    saveCodeVerifier(codeVerifier) { save(this.keys, { codeVerifier }); }
    codeVerifier() {
        const v = load(this.keys).codeVerifier;
        if (!v) throw new Error("Magnific (subscription): the sign-in lost its PKCE verifier; sign in again.");
        return v;
    }
    invalidateCredentials(scope) {
        if (scope === "all") save(this.keys, { client: undefined, redirect: undefined, tokens: undefined, codeVerifier: undefined });
        else if (scope === "client") save(this.keys, { client: undefined, redirect: undefined });
        else if (scope === "tokens") save(this.keys, { tokens: undefined });
        else if (scope === "verifier") save(this.keys, { codeVerifier: undefined });
    }
    async redirectToAuthorization(url) {
        if (!this.interactive) { const e = new Error(RESIGN); e.code = "MAGNIFICSUB_REAUTH"; throw e; }
        const u = new URL(String(url));
        const ok = this.server.test ? u.origin === new URL(this.server.url).origin : u.protocol === "https:";
        if (!ok) throw new Error(`Magnific (subscription): refused to open the sign-in page at ${u.origin}.`);
        await this.open(u.toString());
    }
}

// ---- the loopback redirect ----------------------------------------------------------------------------------------

/**
 * A server on 127.0.0.1 at an ephemeral port that takes one /callback and closes. Returns
 * { redirect, code (a promise of the authorization code), close }.
 */
async function listenForCode({ state, timeoutMs = SIGN_IN_TIMEOUT_MS }) {
    let settle;
    const code = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    code.catch(() => {});
    let timer = null;
    const srv = http.createServer((req, res) => {
        const u = new URL(req.url, "http://127.0.0.1");
        if (u.pathname !== "/callback") { res.writeHead(404); res.end(); return; }
        const q = u.searchParams;
        let failure = null;
        if (q.get("error")) failure = `Magnific refused the sign-in: ${q.get("error_description") || q.get("error")}`;
        else if (state && q.get("state") !== state) failure = "Magnific (subscription): the sign-in answer does not belong to this sign-in (state mismatch).";
        else if (!q.get("code")) failure = "Magnific (subscription): the sign-in answer carried no code.";
        res.writeHead(failure ? 400 : 200, { "content-type": "text/html; charset=utf-8", connection: "close" });
        res.end(failure ? `<!doctype html><meta charset=utf-8><p>${failure.replace(/[<>&]/g, "")}</p>` : DONE_PAGE);
        close();
        if (failure) settle.reject(new Error(failure)); else settle.resolve(q.get("code"));
    });
    function close() {
        clearTimeout(timer);
        srv.close();
        if (srv.closeIdleConnections) srv.closeIdleConnections();
    }
    await new Promise((resolve, reject) => { srv.once("error", reject); srv.listen(0, "127.0.0.1", resolve); });
    timer = setTimeout(() => { close(); settle.reject(new Error("Magnific (subscription): the sign-in timed out (10 minutes without an answer from the browser).")); }, timeoutMs);
    if (timer.unref) timer.unref();
    return { redirect: `http://127.0.0.1:${srv.address().port}/callback`, code, close: () => { close(); settle.reject(new Error("Magnific (subscription): the sign-in was cancelled.")); } };
}

// ---- sign in, out, status -----------------------------------------------------------------------------------------

function sdk() {
    return {
        Client: require("@modelcontextprotocol/sdk/client/index.js").Client,
        Transport: require("@modelcontextprotocol/sdk/client/streamableHttp.js").StreamableHTTPClientTransport,
        UnauthorizedError: require("@modelcontextprotocol/sdk/client/auth.js").UnauthorizedError,
    };
}

/** The plan's name from account_balance, or "" (never a reason for a sign-in to fail). */
async function accountOf(client) {
    try {
        const r = await client.callTool({ name: "account_balance", arguments: {} });
        const plan = r && !r.isError && r.structuredContent && r.structuredContent.plan;
        return plan && typeof plan.productName === "string" ? plan.productName : "";
    } catch (_) { return ""; }
}

/**
 * Signs in through the browser: a fresh start (whatever was stored goes), the loopback redirect, `openExternal(url)`
 * with the realm's authorization page, the code from the redirect traded for tokens, one connect to confirm. Resolves
 * to status(). ctx: { keys, settings, openExternal, fetch?, timeoutMs?, version? }.
 */
async function signIn(ctx) {
    const keys = ctx.keys;
    const server = serverOf(ctx.settings);
    const fetchImpl = guardFetch(ctx.fetch || globalThis.fetch, server);
    const { Client, Transport, UnauthorizedError } = sdk();
    keys.clear(NAME);
    const state = crypto.randomBytes(16).toString("hex");
    const wait = await listenForCode({ state, timeoutMs: ctx.timeoutMs });
    const provider = new Provider({ keys, server, redirect: wait.redirect, state, open: async (url) => { await ctx.openExternal(url); } });
    const connect = async () => {
        const transport = new Transport(new URL(server.url), { authProvider: provider, fetch: fetchImpl });
        const client = new Client({ name: "scumble", version: ctx.version || "0" });
        try {
            await client.connect(transport);
            return { client, transport, signedIn: true };
        } catch (err) {
            if (err instanceof UnauthorizedError) return { client, transport, signedIn: false };
            throw err;
        }
    };
    let open = null;
    try {
        open = await connect();
        if (!open.signedIn) {
            // the browser step ran (redirectToAuthorization opened the page): the code arrives at the loopback
            await open.transport.finishAuth(await wait.code);
            open = await connect();
            if (!open.signedIn) throw new Error("Magnific (subscription): the server refused the new sign-in.");
        }
        const account = await accountOf(open.client);
        save(keys, { codeVerifier: undefined, account: account || undefined });
        return status(ctx);
    } catch (err) {
        throw new Error(scrub(err && err.message || err, secretsOf(keys)));
    } finally {
        wait.close();
        if (open) await open.client.close().catch(() => {});
    }
}

/** Forgets the sign-in (the tokens and the registered client). */
function signOut(ctx) {
    ctx.keys.clear(NAME);
    return status(ctx);
}

/** { signedIn, account? } from the store alone (no request): signed in when it holds tokens for this server. */
function status(ctx) {
    const s = load(ctx.keys);
    const server = serverOf(ctx.settings);
    const signedIn = !!(s.tokens && s.tokens.access_token && s.server === server.url);
    return signedIn && s.account ? { signedIn, account: s.account } : { signedIn };
}

/** The stored tokens, for scrubbing error texts. */
function secretsOf(keys) {
    const t = load(keys).tokens || {};
    return [t.access_token, t.refresh_token, t.id_token].filter(Boolean);
}

module.exports = {
    NAME, HOST, SCOPE, RESIGN, NOT_SIGNED_IN,
    signIn, signOut, status,
    serverOf, testBase, checkToken, guardFetch, scrub, secretsOf,
    Provider, load, sdk,
};
