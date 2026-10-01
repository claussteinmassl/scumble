// "Magnific (subscription)" (magnificsub): the sign-in (electron/main/providers/magnificsub_auth.js) and the MCP
// session (electron/main/providers/magnificsub.js) in plain Node, no Electron, no account:
//   node tools/magnificsub_test.js
// The loopback mock (tools/magnificsub_mock.js) plays Magnific's MCP server and its OAuth realm; the browser step of
// the sign-in is an HTTP GET of the authorization URL (the mock's 302 lands on the app's loopback redirect). A fake
// store stands in for keys.js, a recording fetch sees every request, and a scripted fetch plays https://mcp.magnific.com
// for the host rule (nothing here talks to the live server).
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const auth = require(path.join(ROOT, "electron", "main", "providers", "magnificsub_auth.js"));
const sub = require(path.join(ROOT, "electron", "main", "providers", "magnificsub.js"));
const mockLib = require(path.join(__dirname, "magnificsub_mock.js"));

const ERRORS = [];
const SEEN_TOKENS = new Set();

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 500 ? s.slice(0, 500) + " ..." : s; };
async function section(name, fn) {
    console.log(`\n--- ${name} ---`);
    try { await fn(); } catch (err) { check(`${name}: ran through`, false, err && err.stack || String(err)); }
}
async function throws(fn) {
    try { await fn(); return null; } catch (err) { const m = String((err && err.message) || err); ERRORS.push(m); return m; }
}

/** keys.js as the modules use it: get / set / clear, one string per name. */
function fakeKeys() {
    const data = {};
    return {
        data,
        get: (n) => data[n] || "",
        set: (n, v) => { data[n] = String(v); },
        clear: (n) => { delete data[n]; },
    };
}
const stored = (keys) => { try { return JSON.parse(keys.data.magnificsub || "{}"); } catch (_) { return null; } };
function remember(keys) {
    const t = (stored(keys) || {}).tokens || {};
    for (const k of [t.access_token, t.refresh_token]) if (k) SEEN_TOKENS.add(k);
}

/** The global fetch, recording { url, method, auth } of every request. */
function recordingFetch() {
    const log = [];
    const f = async (input, init = {}) => {
        const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
        const h = new Headers(init.headers || {});
        log.push({ url, method: init.method || "GET", auth: h.get("authorization") });
        return fetch(input, init);
    };
    f.log = log;
    return f;
}

/** The browser of the sign-in: a GET of the authorization URL that follows the realm's redirect to the loopback. */
function browser() {
    const opened = [];
    const open = async (url) => {
        opened.push(url);
        const r = await fetch(url, { redirect: "follow" });
        open.page = await r.text();
        open.status = r.status;
    };
    open.opened = opened;
    return open;
}

const sleeps = [];
const fakeSleep = (ms) => { sleeps.push(ms); return new Promise((r) => setImmediate(r)); };

function pngBytes(size, tag) {
    const b = Buffer.alloc(Math.max(size, 64), 0);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
    b.write(tag, 33, "latin1");
    return b;
}

// ---- the fake codec of tools/magnific_test.js: a "PNG" is the signature and an IHDR followed by raw 4-byte pixels -----

function header(w, h, len) {
    const b = Buffer.alloc(len, 0);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b);
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    b[24] = 8;
    b[25] = 6;
    return b;
}
const sizeOf = (b) => (b && b.length >= 24 && b[0] === 0x89 ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null);
const codec = {
    bitmap(png) {
        const b = Buffer.from(png), s = sizeOf(b);
        if (!s || b.length !== 33 + s[0] * s[1] * 4) return null;
        return { width: s[0], height: s[1], data: b.subarray(33) };
    },
    fromBitmap(bm) {
        const b = header(bm.width, bm.height, 33 + bm.width * bm.height * 4);
        Buffer.from(bm.data.buffer ? Buffer.from(bm.data.buffer, bm.data.byteOffset, bm.data.byteLength) : bm.data).copy(b, 33);
        return b;
    },
};
/** A grey picture of the fake codec: fn(x, y) -> 0..255, opaque. */
function greyOf(w, h, fn) {
    const d = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = fn(x, y), j = (y * w + x) * 4; d[j] = v; d[j + 1] = v; d[j + 2] = v; d[j + 3] = 255; }
    return { width: w, height: h, data: d };
}

async function main() {
    const mock = await mockLib.start({ port: 0 });
    const settings = { magnificsub: { base: mock.base } };
    const keys = fakeKeys();
    const rec = recordingFetch();
    const session = () => new sub.Session({ keys, settings, fetch: rec, sleep: fakeSleep });
    const toolCalls = (from) => mock.calls.slice(from);

    try {
        await section("1. host and the base setting", async () => {
            check("testBase: only http://127.0.0.1:<port>", auth.testBase(mock.base) === mock.base && auth.testBase("http://127.0.0.1:5/") === "http://127.0.0.1:5"
                && [null, "", "http://localhost:5", "https://127.0.0.1:5", "http://127.0.0.1:5/x", "http://127.0.0.1", "http://u:p@127.0.0.1:5", "https://mcp.magnific.com"].every((v) => auth.testBase(v) === null));
            check("the default server is https://mcp.magnific.com", eq(auth.serverOf({}), { url: "https://mcp.magnific.com", test: false }) && eq(auth.serverOf({ magnificsub: { base: "http://evil.example:80" } }), { url: "https://mcp.magnific.com", test: false }));
            check("a base on the mock makes it the server, in test mode", eq(auth.serverOf(settings), { url: mock.base, test: true }));
            check("status before any sign-in: signed out", eq(auth.status({ keys, settings }), { signedIn: false }));
            const e = await throws(() => session().call("account_balance", {}));
            check("a call before any sign-in says to sign in, and sends nothing", e === auth.NOT_SIGNED_IN && rec.log.length === 0 && mock.http.length === 0, e);
        });

        await section("2. sign-in against the mock", async () => {
            const open = browser();
            const st = await auth.signIn({ keys, settings, openExternal: open, fetch: rec });
            remember(keys);
            const s = stored(keys);
            const reg = mock.oauth.registrations[0] || {};
            check("signIn resolves to signed in, with the plan's name", eq(st, { signedIn: true, account: "Mock Plan" }), short(st));
            check("the client registered itself as Scumble (public, PKCE, the loopback redirect, the scope)", mock.oauth.registrations.length === 1 && reg.client_name === "Scumble"
                && reg.token_endpoint_auth_method === "none" && eq(reg.grant_types, ["authorization_code", "refresh_token"]) && eq(reg.response_types, ["code"])
                && reg.scope === "openid profile email mcp:custom-audience" && /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(reg.redirect_uris[0]), short(reg));
            const a = mock.oauth.authorizations[0] || {};
            check("the browser was sent to the realm's authorization page with an S256 challenge, a state and the resource",
                open.opened.length === 1 && open.opened[0].startsWith(mock.base + "/realm/auth?") && a.code_challenge_method === "S256" && /^[A-Za-z0-9_-]{43}$/.test(a.code_challenge || "")
                && !!a.state && a.redirect_uri === reg.redirect_uris[0] && a.resource === mock.base + "/", short(a));
            check("the loopback answered the browser with the short page", open.status === 200 && /Signed in to Magnific\. You can close this tab\./.test(open.page || ""), open.page);
            check("the code was traded (authorization_code) once", mock.oauth.grants.filter((g) => g.grant_type === "authorization_code").length === 1, short(mock.oauth.grants));
            check("the store holds one JSON value under magnificsub: server, redirect, client, test tokens, the account; no verifier left",
                Object.keys(keys.data).length === 1 && s && s.server === mock.base && s.redirect === reg.redirect_uris[0] && s.client.client_id === reg.client_id
                && /^test-at-/.test(s.tokens.access_token) && /^test-rt-/.test(s.tokens.refresh_token) && s.account === "Mock Plan" && !("codeVerifier" in s), short(s && Object.keys(s)));
            check("status: signed in", eq(auth.status({ keys, settings }), { signedIn: true, account: "Mock Plan" }));
            check("... and signed out for another server (the real one)", eq(auth.status({ keys, settings: {} }), { signedIn: false }));
            check("no credential went to the authorization page or anywhere outside the mock", rec.log.every((r) => r.url.startsWith(mock.base)) && mock.http.filter((h) => h.path === "/realm/auth").every((h) => !h.auth));
        });

        await section("3. a second sign-in registers again for its own redirect port", async () => {
            const before = stored(keys);
            await auth.signIn({ keys, settings, openExternal: browser(), fetch: rec });
            remember(keys);
            const s = stored(keys);
            check("a second client was registered, for a new redirect URI", mock.oauth.registrations.length === 2 && s.redirect !== before.redirect && s.client.client_id !== before.client.client_id
                && mock.oauth.registrations[1].redirect_uris[0] === s.redirect, `${before.redirect} -> ${s.redirect}`);
            check("new tokens replaced the old ones", s.tokens.access_token !== before.tokens.access_token);
        });

        await section("4. the mock verifies PKCE (S256) and the redirect URI", async () => {
            const reg = mock.oauth.registrations[1];
            const verifier = crypto.randomBytes(32).toString("base64url");
            const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
            const authorize = async (redirect) => {
                const u = new URL(mock.base + "/realm/auth");
                for (const [k, v] of Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", scope: auth.SCOPE })) u.searchParams.set(k, v);
                return fetch(u, { redirect: "manual" });
            };
            const token = (code, v, redirect) => fetch(mock.base + "/realm/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: v, client_id: reg.client_id, redirect_uri: redirect }) });
            let r = await authorize("http://127.0.0.1:1/callback");
            check("an unregistered redirect URI is refused at the authorization page", r.status === 400);
            r = await authorize(reg.redirect_uris[0]);
            let code = new URL(r.headers.get("location")).searchParams.get("code");
            r = await token(code, "wrong-verifier-" + verifier, reg.redirect_uris[0]);
            check("a wrong verifier is refused at the token endpoint (invalid_grant)", r.status === 400 && (await r.json()).error === "invalid_grant");
            r = await authorize(reg.redirect_uris[0]);
            code = new URL(r.headers.get("location")).searchParams.get("code");
            r = await token(code, verifier, "http://127.0.0.1:2/callback");
            check("a different redirect URI is refused at the token endpoint", r.status === 400);
            r = await authorize(reg.redirect_uris[0]);
            code = new URL(r.headers.get("location")).searchParams.get("code");
            r = await token(code, verifier, reg.redirect_uris[0]);
            const t = await r.json();
            check("the right verifier and redirect get test tokens", r.status === 200 && /^test-at-/.test(t.access_token));
        });

        await section("5. call", async () => {
            const S = session();
            const from = mock.calls.length, h0 = mock.http.length;
            const bal = await S.call("account_balance", {});
            check("a JSON tool answers its structuredContent", bal && bal.plan && bal.plan.productName === "Mock Plan" && bal.credits.available === 1000, short(bal));
            const up = await S.upload(pngBytes(200, "SRC"), { fileName: "src.png" });
            const text = await S.call("creations_get", { creationIdentifier: up });
            check("a text tool (creations_get) answers its text", typeof text === "string" && text.startsWith(`Creation ${up}`), short(text));
            const e = await throws(() => S.call("images_upscale", { creationIdentifier: up, scale: "3x" }));
            check("isError becomes an Error with the tool's text", /^Magnific images_upscale: Invalid arguments for images_upscale: arguments\.scale: "3x" is not one of/.test(e || ""), e);
            const posts = mock.http.slice(h0).filter((h) => h.path === "/" && h.method === "POST");
            check("one MCP connection served the calls (initialize and its notification, then one POST per call)", mock.calls.length - from === 5 && posts.length === 5 + 2, `${mock.calls.length - from} calls, ${posts.length} POSTs`);
            check("every MCP request of the session carried the test Bearer token", posts.every((h) => /^Bearer test-at-/.test(h.auth || "")));
            await S.close();
        });

        await section("6. upload", async () => {
            const S = session();
            const fromCalls = mock.calls.length, fromHttp = mock.http.length;
            const bytes = pngBytes(5000, "UPLOAD-ONE");
            const id = await S.upload(bytes, { fileName: "layer.png" });
            const c = toolCalls(fromCalls);
            const puts = mock.http.slice(fromHttp).filter((h) => h.method === "PUT");
            check("request_upload -> PUT -> finalize_upload {path, fileName, visible: false} -> the identifier",
                eq(c.map((x) => x.tool), ["creations_request_upload", "creations_finalize_upload"]) && eq(c[0].args, { mimeType: "image/png" })
                && eq(Object.keys(c[1].args), ["path", "fileName", "visible"]) && c[1].args.visible === false && c[1].args.fileName === "layer.png" && /^uploads\//.test(c[1].args.path)
                && /^upl-/.test(id) && puts.length === 1, short(c));
            check("the PUT carried no credentials", puts.every((p) => !p.auth));
            check("the mock holds the bytes as sent", Buffer.compare(mock.creations.get(id).bytes, bytes) === 0 && mock.creations.get(id).visible === false);

            const before = { calls: mock.calls.length, http: mock.http.length, rec: rec.log.length };
            const e = await throws(() => S.upload(Buffer.alloc(25 * 1000 * 1000 + 1)));
            check("more than 25 MB is refused before any request", /at most 25 MB/.test(e || "") && mock.calls.length === before.calls && mock.http.length === before.http && rec.log.length === before.rec, e);

            sleeps.length = 0;
            let h0 = mock.http.length;
            const id503 = await S.upload(pngBytes(300, "mock-put-503"), { fileName: "retry.png" });
            let n = mock.http.slice(h0).filter((h) => h.method === "PUT").length;
            check("two 503 answers to the PUT: retried, the third goes through", /^upl-/.test(id503) && n === 3 && eq(sleeps, [1000, 2000]), `${n} PUTs, sleeps ${sleeps}`);

            sleeps.length = 0;
            h0 = mock.http.length;
            let c0 = mock.calls.length;
            mock.script.put.push(503, 502, 503, 500, 503);
            const e5 = await throws(() => S.upload(pngBytes(300, "always-5xx")));
            n = mock.http.slice(h0).filter((h) => h.method === "PUT").length;
            check("a PUT that keeps failing with 5xx: retried 3 times (4 PUTs), then the error, no finalize", /upload was refused \(500\)/.test(e5 || "") && n === 4 && !toolCalls(c0).some((x) => x.tool === "creations_finalize_upload"), `${n} PUTs: ${e5}`);
            mock.script.put.length = 0;

            h0 = mock.http.length;
            c0 = mock.calls.length;
            mock.script.put.push(403);
            const e4 = await throws(() => S.upload(pngBytes(300, "forbidden")));
            n = mock.http.slice(h0).filter((h) => h.method === "PUT").length;
            check("a 4xx PUT is not retried", /upload was refused \(403\)/.test(e4 || "") && n === 1 && !toolCalls(c0).some((x) => x.tool === "creations_finalize_upload"), `${n} PUTs: ${e4}`);

            const jpg = Buffer.alloc(100, 0); jpg[0] = 0xff; jpg[1] = 0xd8;
            c0 = mock.calls.length;
            await S.upload(jpg);
            check("the MIME type is read from the bytes (a JPEG)", eq(toolCalls(c0)[0].args, { mimeType: "image/jpeg" }));
            await S.close();
        });

        await section("7. waitFor", async () => {
            const S = session();
            const src = await S.upload(pngBytes(400, "WAIT-SRC"));
            const job = await S.call("images_generate", { prompt: "a lighthouse at dusk" });
            check("a creation tool answers creation.identifier and creation.credits", /^cr-/.test(job.creation.identifier) && job.creation.credits === 90, short(job));
            let c0 = mock.calls.length;
            const entry = await S.waitFor(job.creation.identifier, { timeoutMs: 60000 });
            const waits = toolCalls(c0);
            check("creations_wait {identifiers: [id], timeoutSeconds: 25} until completed: the entry", entry.status === "completed" && entry.identifier === job.creation.identifier
                && eq(waits.map((x) => x.args), [{ identifiers: [job.creation.identifier], timeoutSeconds: 25 }]) && /\/asset\//.test(entry.results.url), short({ entry, waits }));

            const bad = await S.call("images_upscale", { creationIdentifier: src, mode: "creative", scale: "2x", prompt: "mock-failed" });
            const ef = await throws(() => S.waitFor(bad.creation.identifier));
            check("a failed creation throws with the server's reason", ef === "Magnific (subscription): the creation failed - mock: the model refused the picture", ef);

            const slow = await S.call("images_retouch", { creationIdentifier: src, maskCreationIdentifier: src, prompt: "mock-slow" });
            c0 = mock.calls.length;
            const t0 = Date.now();
            const es = await throws(() => S.waitFor(slow.creation.identifier, { timeoutMs: 400 }));
            const sw = toolCalls(c0);
            check("a creation that stays processing: \"timed out\" after timeoutMs", /timed out after 0 s/.test(es || "") && Date.now() - t0 < 5000 && sw.length >= 2
                && sw.every((x) => x.tool === "creations_wait" && x.args.timeoutSeconds >= 1 && x.args.timeoutSeconds <= 25), `${sw.length} waits: ${es}`);

            // a clock the test moves: a 25 s long-poll each time, the deadline at 60 s
            let clock = 0;
            const S2 = new sub.Session({ keys, settings, fetch: rec, sleep: async (ms) => { clock += ms; }, now: () => clock });
            const orig = S2.call.bind(S2);
            const asked = [];
            S2.call = async (name, args) => { asked.push(args.timeoutSeconds); clock += args.timeoutSeconds * 1000; return orig(name, args); };
            const em = await throws(() => S2.waitFor(slow.creation.identifier, { timeoutMs: 60000 }));
            check("each wait asks at most 25 s, the last only what is left", eq(asked, [25, 25, 10]) && /timed out after 60 s/.test(em || ""), `${asked}: ${em}`);
            await S.close();
            await S2.close();
        });

        await section("8. download", async () => {
            const S = session();
            const bytes = pngBytes(700, "ROUNDTRIP");
            const id = await S.upload(bytes);
            const job = await S.call("images_remove_background", { creationIdentifier: id });
            await S.waitFor(job.creation.identifier);
            const c0 = mock.calls.length, h0 = mock.http.length;
            const got = await S.download(job.creation.identifier);
            const c = toolCalls(c0);
            const gets = mock.http.slice(h0).filter((h) => h.path.startsWith("/asset/"));
            check("creations_register_download {identifiers: [id], tool: \"scumble\"} -> originals[0].url -> the bytes",
                eq(c.map((x) => [x.tool, x.args]), [["creations_register_download", { identifiers: [job.creation.identifier], tool: "scumble" }]])
                && got.bytes.toString("latin1", 33, 33 + 6 + job.creation.identifier.length + 1) === "RESULT " + job.creation.identifier && got.mime === "image/png", short(c));
            check("the original was fetched without the Authorization header", gets.length === 1 && !gets[0].auth && gets[0].path.endsWith(".png"));
            const back = await S.download(id);
            check("an uploaded creation comes back byte for byte", Buffer.compare(back.bytes, bytes) === 0);

            mock.script.downloadUrl = "http://example.com/x.png";
            const r0 = rec.log.length;
            const e = await throws(() => S.download(id));
            mock.script.downloadUrl = null;
            check("an original outside https (or, in a test, outside the mock) is refused, not fetched", /refused the download URL at http:\/\/example\.com/.test(e || "") && !rec.log.slice(r0).some((r) => r.url.includes("example.com")), e);
            await S.close();
        });

        await section("9. refresh", async () => {
            const S = session();
            await S.call("account_balance", {});
            const before = stored(keys).tokens;
            const g0 = mock.oauth.grants.length;
            mock.script.expireAccess();
            const bal = await S.call("account_balance", {});
            remember(keys);
            const after = stored(keys).tokens;
            check("an expired access token is refreshed and the call goes through", bal.plan.productName === "Mock Plan" && after.access_token !== before.access_token
                && eq(mock.oauth.grants.slice(g0).map((g) => g.grant_type), ["refresh_token"]), short(mock.oauth.grants.slice(g0)));
            mock.script.reject401 = 1;
            const bal2 = await S.call("account_balance", {});
            remember(keys);
            check("a token refused once: refreshed, then the call goes through", bal2.plan.productName === "Mock Plan" && stored(keys).tokens.access_token !== after.access_token);
            await S.close();

            const S2 = session();
            await S2.call("account_balance", {});
            mock.script.expireAccess();
            mock.script.refreshFails = true;
            const opened = mock.oauth.authorizations.length;
            const e = await throws(() => S2.call("account_balance", {}));
            mock.script.refreshFails = false;
            check("a refresh that fails: \"Sign in to Magnific again (Settings › API providers).\"", e === "Sign in to Magnific again (Settings › API providers).", e);
            check("... no browser step was started, and the dead tokens are gone (status: signed out)", mock.oauth.authorizations.length === opened && eq(auth.status({ keys, settings }), { signedIn: false }));
            const e2 = await throws(() => session().call("account_balance", {}));
            check("... the next run says to sign in", e2 === auth.NOT_SIGNED_IN, e2);
            await S2.close();
        });

        await section("10. sign out", async () => {
            await auth.signIn({ keys, settings, openExternal: browser(), fetch: rec });
            remember(keys);
            check("signed in again", auth.status({ keys, settings }).signedIn === true);
            const st = auth.signOut({ keys, settings });
            check("signOut clears the stored value and reports signed out", eq(st, { signedIn: false }) && !("magnificsub" in keys.data));
        });

        await section("11. the host rule", async () => {
            // a real-looking token while the base names the mock: refused before any request
            const realTokens = { access_token: "eyJhbGciOiJSUzI1NiJ9.real-access-0123456789", refresh_token: "eyJhbGciOiJIUzI1NiJ9.real-refresh-0123456789", token_type: "Bearer" };
            const k1 = fakeKeys();
            k1.set("magnificsub", JSON.stringify({ server: mock.base, redirect: "http://127.0.0.1:9/callback", client: { client_id: "x" }, tokens: realTokens }));
            const r1 = recordingFetch();
            const h0 = mock.http.length;
            let e = await throws(() => new sub.Session({ keys: k1, settings, fetch: r1 }).call("account_balance", {}));
            check("a real token never goes to the mock: refused before any request", /only a test sign-in goes there/.test(e || "") && r1.log.length === 0 && mock.http.length === h0, e);

            // a test token while the server is Magnific: refused before any request
            const k2 = fakeKeys();
            k2.set("magnificsub", JSON.stringify({ server: auth.HOST, redirect: "http://127.0.0.1:9/callback", client: { client_id: "x" }, tokens: { access_token: "test-at-1-abc", refresh_token: "test-rt-1-abc" } }));
            const r2 = recordingFetch();
            e = await throws(() => new sub.Session({ keys: k2, settings: {}, fetch: r2 }).call("account_balance", {}));
            check("a test token never goes to Magnific: refused before any request", /a test sign-in is never sent to Magnific/.test(e || "") && r2.log.length === 0, e);

            // the guard on every request: a refresh at the mock that hands out a non-test token is refused before use
            const k3 = fakeKeys();
            await auth.signIn({ keys: k3, settings, openExternal: browser(), fetch: rec });
            const S = new sub.Session({ keys: k3, settings, fetch: rec, sleep: fakeSleep });
            await S.call("account_balance", {});
            mock.script.realTokens = true;
            mock.script.expireAccess();
            e = await throws(() => S.call("account_balance", {}));
            mock.script.realTokens = false;
            check("a non-test token from the mock is refused before it is ever sent", !!e && mock.oauth.foreignTokens.length === 0, `${e}; foreign ${mock.oauth.foreignTokens.length}`);
            await S.close();

            // a scripted https://mcp.magnific.com: the real token goes there and nowhere else
            const sent = [];
            const live = async (input, init = {}) => {
                const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
                const h = new Headers(init.headers || {});
                sent.push({ url, method: init.method || "GET", auth: h.get("authorization") });
                if (!url.startsWith("https://mcp.magnific.com")) return new Response("{}", { status: 404 });
                if ((init.method || "GET") !== "POST") return new Response(null, { status: 405 });
                const msg = JSON.parse(String(init.body));
                if (msg.id == null) return new Response(null, { status: 202 });
                const result = msg.method === "initialize"
                    ? { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "pikaso", version: "1.0.0" } }
                    : { content: [{ type: "text", text: "{}" }], structuredContent: { plan: { productName: "Scripted" }, credits: { available: 1 } } };
                return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), { status: 200, headers: { "content-type": "application/json" } });
            };
            const k4 = fakeKeys();
            k4.set("magnificsub", JSON.stringify({ server: auth.HOST, redirect: "http://127.0.0.1:9/callback", client: { client_id: "x" }, tokens: realTokens }));
            const S4 = new sub.Session({ keys: k4, settings: {}, fetch: live });
            const bal = await S4.call("account_balance", {});
            check("against Magnific the real token goes to https://mcp.magnific.com, and every request goes there",
                bal.plan.productName === "Scripted" && sent.length >= 3 && sent.every((r) => r.url === "https://mcp.magnific.com/")
                && sent.filter((r) => r.method === "POST").every((r) => r.auth === "Bearer " + realTokens.access_token), short(sent));
            const REALM = "https://auth.magnific.com";
            const guard = auth.guardFetch(async () => new Response("{}"), { url: auth.HOST, test: false }, { origin: () => REALM });
            e = await throws(() => guard("http://127.0.0.1:5/", { headers: { authorization: "Bearer " + realTokens.access_token } }));
            const e2 = await throws(() => guard("https://elsewhere.example/", { headers: { authorization: "Bearer " + realTokens.access_token } }));
            const e3 = await throws(() => guard("https://auth.magnific.com/realms/mcp/protocol/openid-connect/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "test-rt-9" }) }));
            const ok = await guard("https://auth.magnific.com/realms/mcp/protocol/openid-connect/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: realTokens.refresh_token }) });
            check("the guard: no plain http, the access token to the MCP host only, no test refresh token to Magnific; a real refresh to the realm passes",
                /over http:/.test(e || "") && /refused to send the sign-in to elsewhere\.example/.test(e2 || "") && /never sent to Magnific/.test(e3 || "") && ok.status === 200, [e, e2, e3].join(" | "));
            await S4.close();
        });

        await section("12. hardening: the token endpoint pinned at sign-in", async () => {
            // the guard against Magnific: a refresh or a code only to the origin the sign-in recorded
            const ok = async () => new Response("{}");
            const real = { url: auth.HOST, test: false };
            const REALM = "https://auth.magnific.com";
            const pinned = auth.guardFetch(ok, real, { origin: () => REALM });
            const form = (grant) => ({ method: "POST", body: new URLSearchParams(grant === "refresh_token" ? { grant_type: grant, refresh_token: "eyJreal-refresh-0123456789" } : { grant_type: grant, code: "c", code_verifier: "v" }) });
            const e1 = await throws(() => pinned("https://evil.example/token", form("refresh_token")));
            const e2 = await throws(() => pinned("https://evil.example/token", form("authorization_code")));
            const r1 = await pinned(REALM + "/realms/mcp/protocol/openid-connect/token", form("refresh_token"));
            check("a refresh or a code to another origin than the pinned one is refused; to the pinned one it goes",
                /refused a token request to evil\.example; the sign-in was made at auth\.magnific\.com/.test(e1 || "") && /refused a token request to evil\.example/.test(e2 || "") && r1.status === 200, [e1, e2].join(" | "));
            const unpinned = auth.guardFetch(ok, real, { origin: () => null });
            const e3 = await throws(() => unpinned(REALM + "/token", form("refresh_token")));
            const e4 = await throws(() => auth.guardFetch(ok, real)(REALM + "/token", form("refresh_token")));
            check("without a recorded origin a run sends no token request at all (sign in again)", e3 === auth.RESIGN && e4 === auth.RESIGN, [e3, e4].join(" | "));
            let recorded = null;
            const signing = auth.guardFetch(ok, real, { origin: () => recorded, record: (o) => { recorded = o; } });
            await signing(REALM + "/token", form("authorization_code"));
            const e5 = await throws(() => signing("https://other.example/token", form("refresh_token")));
            check("a sign-in records the origin of its code exchange, and holds the next token request to it", recorded === REALM && /refused a token request to other\.example/.test(e5 || ""), `${recorded}: ${e5}`);

            // against the mock: a stored pin that names another origin stops the refresh before it is sent
            const k = fakeKeys();
            await auth.signIn({ keys: k, settings, openExternal: browser(), fetch: rec });
            remember(k);
            check("the sign-in recorded its token endpoint's origin (the mock's realm)", stored(k).tokenOrigin === mock.base, stored(k).tokenOrigin);
            const S = new sub.Session({ keys: k, settings, fetch: rec, sleep: fakeSleep });
            await S.call("account_balance", {});
            k.set("magnificsub", JSON.stringify({ ...stored(k), tokenOrigin: "http://127.0.0.1:1" }));
            mock.script.expireAccess();
            const g0 = mock.oauth.grants.length;
            const e6 = await throws(() => S.call("account_balance", {}));
            check("a pin that no longer matches: no refresh is sent, the run says to sign in again", e6 === auth.RESIGN && mock.oauth.grants.length === g0, `${e6}; ${mock.oauth.grants.length - g0} grants`);
            await S.close();
        });

        await section("13. hardening: no local or private host outside a test", async () => {
            const real = { url: auth.HOST, test: false };
            const guard = auth.guardFetch(async () => new Response("{}"), real, { origin: () => "https://auth.magnific.com" });
            const hosts = ["https://127.0.0.1/", "https://localhost/", "https://x.localhost/", "https://10.0.0.5/", "https://172.16.3.4/", "https://192.168.1.1/",
                "https://169.254.169.254/latest", "https://[::1]/", "https://[fd00::1]/", "https://[::ffff:7f00:1]/", "https://2130706433/", "https://printer.local/"];
            const refused = [];
            for (const h of hosts) { const e = await throws(() => guard(h)); if (/local or private address/.test(e || "")) refused.push(h); }
            check("the guard refuses every loopback, private, link-local and mDNS host even over https", refused.length === hosts.length, hosts.filter((h) => !refused.includes(h)).join(", "));
            const pub = await guard("https://mcp.magnific.com/");
            check("... and lets a public https host through", pub.status === 200);
            const S = new sub.Session({ keys: fakeKeys(), settings: {}, fetch: async () => new Response("") });
            const e1 = await throws(() => S.plainUrl("https://127.0.0.1/x.png", "download"));
            const e2 = await throws(() => S.plainUrl("https://192.168.0.2/up", "upload"));
            check("an upload or download URL on a local or private host is refused too", /refused the download URL at https:\/\/127\.0\.0\.1/.test(e1 || "") && /refused the upload URL/.test(e2 || "") && S.plainUrl("https://cdn.magnific.com/a.png", "download") === "https://cdn.magnific.com/a.png", [e1, e2].join(" | "));
            const P = new auth.Provider({ keys: fakeKeys(), server: real, redirect: "http://127.0.0.1:5/callback", open: async () => {} });
            const e3 = await throws(() => P.redirectToAuthorization("https://10.1.1.1/auth"));
            check("the sign-in page is never opened on a private host", /refused to open the sign-in page at https:\/\/10\.1\.1\.1/.test(e3 || ""), e3);
        });

        await section("14. hardening: what counts as a dropped connection", async () => {
            const net = new TypeError("fetch failed");
            net.cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
            const code = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
            const bug = new TypeError("Cannot read properties of undefined (reading 'x')");
            const notFn = new TypeError("client.callTool is not a function");
            check("fetch failed, a socket error code and Not connected are dropped connections",
                sub._isTransportError(net) && sub._isTransportError(code) && sub._isTransportError(new Error("Not connected")));
            check("a TypeError of the code is not (it is never retried as a dropped connection)", !sub._isTransportError(bug) && !sub._isTransportError(notFn));
        });

        await section("14b. hardening: a dropped connection never sends a paid tool twice (Session.call)", async () => {
            const k = fakeKeys();
            await auth.signIn({ keys: k, settings, openExternal: browser(), fetch: rec });
            remember(k);
            const S = new sub.Session({ keys: k, settings, fetch: rec, sleep: fakeSleep });
            const id = await S.upload(pngBytes(300, "DROP"));

            let c0 = mock.calls.length;
            mock.script.drop.push("images_upscale");
            const e = await throws(() => S.call("images_upscale", { creationIdentifier: id, mode: "creative", scale: "2x" }));
            const ups = toolCalls(c0).filter((c) => c.tool === "images_upscale");
            check("a paid tool (images_upscale) whose connection broke went out exactly once (the mock's call log)",
                ups.length === 1 && ups[0].dropped === true && mock.script.drop.length === 0, short(toolCalls(c0)));
            check("... and the error says it may still run and be charged", /the connection broke during images_upscale; it may still run and be charged \(check your Magnific library\)/.test(e || ""), e);
            const bal = await S.call("account_balance", {});
            check("... the next call reconnects and runs", bal && bal.credits && bal.credits.available === 1000, short(bal));

            const job = await S.call("images_remove_background", { creationIdentifier: id });
            c0 = mock.calls.length;
            const h0 = mock.http.length;
            mock.script.drop.push("creations_wait");
            const w = await S.waitFor(job.creation.identifier);
            const waits = toolCalls(c0).filter((c) => c.tool === "creations_wait");
            check("a read-only tool (creations_wait) whose connection broke is sent once more after a reconnect, and succeeds",
                waits.length === 2 && waits[0].dropped === true && !waits[1].dropped && !waits[1].error && w && w.status === "completed", short(waits));
            const inits = mock.http.slice(h0).filter((h) => h.method === "POST" && h.path === "/").length;
            check("... over a new connection (initialize, its notification, the call again)", inits === 1 + 2 + 1, `${inits} POSTs`);

            c0 = mock.calls.length;
            mock.script.drop.push("creations_wait", "creations_wait");
            const e2 = await throws(() => S.waitFor(job.creation.identifier));
            check("a read that breaks twice is sent twice, not more, and fails", toolCalls(c0).filter((c) => c.tool === "creations_wait").length === 2 && /Magnific creations_wait/.test(e2 || ""), e2);
            mock.script.drop.length = 0;
            await S.close();
        });

        await section("14c. hardening: upload and download redirects, the download's size cap", async () => {
            const k = fakeKeys();
            await auth.signIn({ keys: k, settings, openExternal: browser(), fetch: rec });
            remember(k);
            const S = new sub.Session({ keys: k, settings, fetch: rec, sleep: fakeSleep });
            const bytes = pngBytes(400, "REDIR");

            // the upload: a 302 is refused (it would turn the PUT into a GET); a 307 to the mock itself is followed
            let c0 = mock.calls.length;
            mock.script.putRedirect = { status: 302, to: "self" };
            let e = await throws(() => S.upload(bytes));
            check("an upload answered 302 is refused, not retried, and not finalized", /the upload was redirected \(302\); refused/.test(e || "") && !toolCalls(c0).some((c) => c.tool === "creations_finalize_upload"), e);
            mock.script.putRedirect = { status: 307, to: "http://example.com/put" };
            const r0 = rec.log.length;
            c0 = mock.calls.length;
            e = await throws(() => S.upload(bytes));
            check("an upload redirected (307) off the allowed host is refused before it is followed", /refused the upload URL at http:\/\/example\.com/.test(e || "") && !rec.log.slice(r0).some((r) => r.url.includes("example.com")) && !toolCalls(c0).some((c) => c.tool === "creations_finalize_upload"), e);
            mock.script.putRedirect = { status: 307, to: "self" };
            const h0 = mock.http.length;
            const id = await S.upload(bytes);
            const puts = mock.http.slice(h0).filter((h) => h.method === "PUT").length;
            check("an upload redirected (307) to an allowed URL is followed with its body", puts === 2 && Buffer.compare(mock.creations.get(id).bytes, bytes) === 0, `${puts} PUTs`);

            // the download
            mock.script.getRedirect = { status: 302, to: "http://example.com/x.png" };
            const r1 = rec.log.length;
            e = await throws(() => S.download(id));
            check("a download redirected off the allowed host is refused, not fetched", /refused the download URL at http:\/\/example\.com/.test(e || "") && !rec.log.slice(r1).some((r) => r.url.includes("example.com")), e);
            mock.script.getRedirect = { status: 302, to: "self" };
            const back = await S.download(id);
            check("a download redirected to an allowed URL is followed", Buffer.compare(back.bytes, bytes) === 0);
            mock.script.getRedirect = { status: 302, to: "self", times: 10 };
            e = await throws(() => S.download(id));
            mock.script.getRedirect = null;
            check("more than 5 redirects are refused", /redirected more than 5 times; refused/.test(e || ""), e);

            // outside a test, a public https URL that redirects to a local host is refused before it is followed
            const asked = [];
            const real = new sub.Session({ keys: fakeKeys(), settings: {}, fetch: async (u, init) => { asked.push([String(u), init && init.redirect]); return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/x.png" } }); } });
            e = await throws(() => real.plainFetch("https://cdn.magnific.com/a.png", { method: "GET" }, "download"));
            check("outside a test: a redirect from a public host to 127.0.0.1 is refused, asked with redirect: manual", /refused the download URL at https:\/\/127\.0\.0\.1/.test(e || "") && eq(asked, [["https://cdn.magnific.com/a.png", "manual"]]), e);

            // the size cap: by Content-Length, and while the body streams without one
            const job = await S.call("images_remove_background", { creationIdentifier: id });
            await S.waitFor(job.creation.identifier);
            mock.script.result = Buffer.alloc(5000, 7);
            const small = new sub.Session({ keys: k, settings, fetch: rec, sleep: fakeSleep, maxDownload: 4000 });
            e = await throws(() => small.download(job.creation.identifier));
            check("a download larger than the cap (by its Content-Length) is aborted", /larger than \d+ MB; aborted/.test(e || ""), e);
            const ok = await new sub.Session({ keys: k, settings, fetch: rec, sleep: fakeSleep, maxDownload: 5000 }).download(job.creation.identifier);
            check("... one at the cap goes through", ok.bytes.length === 5000);
            let cancelled = false;
            const streaming = async (u, init) => {
                if (!String(u).includes("/asset/")) return rec(u, init);
                let n = 0;
                const body = new ReadableStream({ pull(c) { if (n++ < 10) c.enqueue(new Uint8Array(1000)); else c.close(); }, cancel() { cancelled = true; } });
                return new Response(body, { status: 200, headers: { "content-type": "image/png" } });
            };
            const S3 = new sub.Session({ keys: k, settings, fetch: streaming, sleep: fakeSleep, maxDownload: 4000 });
            e = await throws(() => S3.download(job.creation.identifier));
            check("a body without Content-Length is aborted once it passes the cap (the stream cancelled)", /larger than \d+ MB; aborted/.test(e || "") && cancelled, e);
            check("the default cap is 200 MB", sub.MAX_DOWNLOAD === 200 * 1000 * 1000);
            mock.script.result = null;
            for (const x of [S, small, S3]) await x.close();
        });

        await section("15. hardening: a re-sign-in keeps the old sign-in until it succeeds", async () => {
            const k = fakeKeys();
            await auth.signIn({ keys: k, settings, openExternal: browser(), fetch: rec });
            remember(k);
            const before = k.data.magnificsub;
            // the browser never answers: the sign-in times out
            const e1 = await throws(() => auth.signIn({ keys: k, settings, openExternal: async () => {}, fetch: rec, timeoutMs: 200 }));
            check("a re-sign-in that times out fails with the timeout", /the sign-in timed out/.test(e1 || ""), e1);
            check("... and the stored sign-in is the one before, still signed in", k.data.magnificsub === before && eq(auth.status({ keys: k, settings }), { signedIn: true, account: "Mock Plan" }));
            // the browser cannot be opened: the sign-in fails at once
            const e2 = await throws(() => auth.signIn({ keys: k, settings, openExternal: async () => { throw new Error("no browser"); }, fetch: rec }));
            check("a re-sign-in that fails (no browser) leaves the stored sign-in as it was", !!e2 && k.data.magnificsub === before, e2);
            const S = new sub.Session({ keys: k, settings, fetch: rec, sleep: fakeSleep });
            const bal = await S.call("account_balance", {});
            check("... and a run still works with it", bal.plan.productName === "Mock Plan");
            await S.close();
            await auth.signIn({ keys: k, settings, openExternal: browser(), fetch: rec });
            remember(k);
            check("a re-sign-in that succeeds replaces it", k.data.magnificsub !== before && auth.status({ keys: k, settings }).signedIn === true);
        });

        await section("16. hardening: a callback with the wrong state keeps the sign-in waiting", async () => {
            const k = fakeKeys();
            const answers = [];
            const open = async (url) => {
                const redirect = new URL(url).searchParams.get("redirect_uri");
                // a stale tab (another state) and a request without any state come first
                for (const q of ["?code=forged&state=not-this-one", "?error=access_denied&state=other", "?code=forged"]) {
                    const r = await fetch(redirect + q);
                    answers.push([r.status, await r.text()]);
                }
                await browser()(url);
            };
            const g0 = mock.oauth.grants.length;
            const st = await auth.signIn({ keys: k, settings, openExternal: open, fetch: rec });
            remember(k);
            check("the wrong answers get 400 with a short page", answers.length === 3 && answers.every(([status, text]) => status === 400 && /does not belong to the sign-in/.test(text)), short(answers));
            check("... the sign-in kept waiting and finished with the right answer (one code traded, the forged one never)", eq(st, { signedIn: true, account: "Mock Plan" })
                && eq(mock.oauth.grants.slice(g0).map((g) => g.grant_type), ["authorization_code"]), short(mock.oauth.grants.slice(g0)));
            // the right state with the realm's error ends the sign-in
            const k2 = fakeKeys();
            const deny = async (url) => {
                const u = new URL(url);
                await fetch(`${u.searchParams.get("redirect_uri")}?error=access_denied&error_description=${encodeURIComponent("The user said no")}&state=${u.searchParams.get("state")}`);
            };
            const e = await throws(() => auth.signIn({ keys: k2, settings, openExternal: deny, fetch: rec, timeoutMs: 5000 }));
            check("an error with the right state ends the sign-in with the realm's words, and stores nothing", e === "Magnific refused the sign-in: The user said no" && !("magnificsub" in k2.data), e);
        });

        // ---- the verbs (Task 2) ----------------------------------------------------------------------------------
        const vk = fakeKeys();
        await auth.signIn({ keys: vk, settings, openExternal: browser(), fetch: rec });
        remember(vk);
        const vctx = { keys: vk, settings, fetch: rec, sleep: fakeSleep, bitmap: codec.bitmap, fromBitmap: codec.fromBitmap };
        const toolsOf = (from) => toolCalls(from).map((x) => x.tool);
        const invalid = (from) => toolCalls(from).filter((x) => x.error).map((x) => `${x.tool}: ${x.error}`);

        await section("18. upscale", async () => {
            let c0 = mock.calls.length;
            const out = await sub.upscale({ kind: "upscale", model: "images_upscale:creative", image: pngBytes(300, "UPSCALE-SRC"), factor: 2, prompt: "crisp bark", params: {} }, vctx);
            const c = toolCalls(c0);
            const up = c.find((x) => x.tool === "images_upscale");
            check("one upload, images_upscale, the wait and the original's download, every call valid", eq(toolsOf(c0), ["creations_request_upload", "creations_finalize_upload", "images_upscale", "creations_wait", "creations_register_download"]) && !invalid(c0).length, short(toolsOf(c0)) + " " + invalid(c0).join(" | "));
            check("Creative with no rows set: the preset Subtle, Optimized for, Engine and the prompt; no sliders",
                up && mock.creations.get(up.args.creationIdentifier).fileName === "scumble.png" && eq(up.args, { creationIdentifier: up.args.creationIdentifier, mode: "creative", scale: "2x", presets: "subtle", optimised: "StandardUltra", engine: "automatic", prompt: "crisp bark" }), short(up && up.args));
            check("the answer: the original's bytes, PNG, its size, the credits and the mode", out.mime === "image/png" && out.width === 64 && out.height === 48 && eq(out.info, { credits: 90, model: "creative", factor: "2x" })
                && out.bytes.toString("latin1", 33, 39) === "RESULT", short({ ...out, bytes: out.bytes.length }));

            // a factor the mode does not take: refused before the upload, naming the factors it takes
            const before = { calls: mock.calls.length, http: mock.http.length };
            const e = await throws(() => sub.upscale({ kind: "upscale", model: "images_upscale:precision", image: pngBytes(300, "X"), factor: 4, params: { mode: "Precision photo" } }, vctx));
            check("Precision photo at 4x is refused before anything is sent, naming its factors", e === "Magnific (subscription): Precision photo upscales by 2x only, not 4x." && mock.calls.length === before.calls && mock.http.length === before.http, e);
            const refuses = (mode) => [4, 8, 16].every((f) => { try { sub._upscaleArgs({ model: "images_upscale:precision", factor: f, params: { mode } }); return false; } catch (_) { return true; } });
            const takes = (model, mode) => [2, 4, 8, 16].every((f) => sub._upscaleArgs({ model, factor: f, params: { mode } }).scale === `${f}x`);
            check("ultra-photo, ultra-denoiser and ultra refuse 4, 8 and 16; creative and ultra-sublime take 2, 4, 8 and 16",
                ["Precision photo", "Precision photo denoiser", "Precision v1"].every(refuses) && takes("images_upscale:creative", undefined) && takes("images_upscale:precision", "Precision sublime"));

            // every mode sends only the keys its catalog entry lists (catalog_images_upscale_modes_list.txt)
            const cat = fs.readFileSync(path.join(__dirname, "refs", "magnificsub", "catalog_images_upscale_modes_list.txt"), "utf8");
            const optional = {};
            for (const m of cat.matchAll(/- id: ([\w-]+)[\s\S]*?optional\[\d+\]: ([\w,]+)/g)) optional[m[1]] = m[2].split(",");
            const T = sub._tables;
            const schema = mockLib.toolDefs().find((d) => d.name === "images_upscale").inputSchema;
            const bad = [];
            for (const [label, mode] of Object.entries(T.UPSCALE_MODES)) {
                if (!optional[mode.slug]) { bad.push(`${label}: ${mode.slug} not in the catalog`); continue; }
                const presets = mode.kind === "creative" ? Object.keys(T.CREATIVE_PRESETS) : Object.keys(T.PRECISION_PRESETS);
                for (const preset of presets) {
                    const a = sub._upscaleArgs({ model: `images_upscale:${mode.kind}`, factor: 2, prompt: "p", params: { mode: label, preset, precisionPreset: preset, creativity: 1, resemblance: 1, hdr: 1, fractality: 1, sharpness: 5, grain: 5, ultraDetail: 5 } });
                    for (const k of Object.keys(a)) if (k !== "mode" && !optional[mode.slug].includes(k)) bad.push(`${label}/${preset}: ${k}`);
                    const v = mockLib.validate(schema, { creationIdentifier: "x", ...a });
                    if (v.length) bad.push(`${label}/${preset}: ${v.join("; ")}`);
                }
            }
            check("every mode and preset sends only the keys the mode's catalog entry lists, valid against the schema", !bad.length, bad.join(" | "));
            const custom = sub._upscaleArgs({ model: "images_upscale:creative", factor: 4, params: { preset: "Custom (sliders)", creativity: 5, resemblance: -2, hdr: 3, fractality: -4 } });
            const vivid = sub._upscaleArgs({ model: "images_upscale:creative", factor: 16, params: { preset: "Vivid", creativity: 9, optimised: "3D renders", engine: "Sparkle" } });
            const sublime = sub._upscaleArgs({ model: "images_upscale:precision", factor: 8, prompt: "ignored", params: { mode: "Precision sublime", precisionPreset: "Portraits", sharpness: 50 } });
            const sliders = sub._upscaleArgs({ model: "images_upscale:precision", factor: 2, params: { mode: "Precision sublime", sharpness: 12, grain: 9, ultraDetail: 30 } });
            const photo = sub._upscaleArgs({ model: "images_upscale:precision", factor: 2, params: { mode: "ultra-photo", sharpness: 12, grain: 9, ultraDetail: 30 } });
            check("Creative: Custom sends presets \"custom\" with all four sliders, a named preset goes without them",
                eq(custom, { mode: "creative", scale: "4x", presets: "custom", creativity: 5, resemblance: -2, hdr: 3, fractality: -4, optimised: "StandardUltra", engine: "automatic" })
                && eq(vivid, { mode: "creative", scale: "16x", presets: "vivid", optimised: "ThreeDRenders", engine: "magnific_sparkle" }), short([custom, vivid]));
            check("Precision: a macro goes alone, the sliders without one, no Ultra detail for sublime, never a prompt",
                eq(sublime, { mode: "ultra-sublime", scale: "8x", precisionPreset: "portraits" }) && eq(sliders, { mode: "ultra-sublime", scale: "2x", sharpness: 12, grain: 9 })
                && eq(photo, { mode: "ultra-photo", scale: "2x", sharpness: 12, grain: 9, ultraDetail: 30 }), short([sublime, sliders, photo]));
            const e2 = await throws(() => sub.upscale({ model: "images_upscale:precision", image: pngBytes(100, "X"), factor: 2, params: { mode: "Creative" } }, vctx));
            const e3 = await throws(() => sub.upscale({ model: "images_upscale:creative", image: pngBytes(100, "X"), factor: 2, params: { preset: "Custom (sliders)", hdr: 11 } }, vctx));
            const e4 = await throws(() => sub.upscale({ model: "images_upscale:precision", image: pngBytes(100, "X"), factor: 2, params: { mode: "Turbo" } }, vctx));
            const e5 = await throws(() => sub.upscale({ model: "images_upscale:precision", image: pngBytes(100, "X"), factor: 2, params: { precisionPreset: "Vivid" } }, vctx));
            check("refused before the upload: a Creative mode on the Precision recipe, a slider out of range, an unknown mode, a Creative preset as a Precision macro",
                /Creative is not a Precision mode/.test(e2 || "") && /hdr goes from -10 to 10, not 11/.test(e3 || "") && /no upscale mode "Turbo"/.test(e4 || "") && /no Precision preset "Vivid"/.test(e5 || "") && mock.calls.length === before.calls, [e2, e3, e4, e5].join(" | "));
        });

        await section("19. retouch (edit, kind fill)", async () => {
            const P = sub._pictures;
            // the answer Magnific gives: a picture of the size asked, or twice it; values from the position
            const answerOf = (w, h) => codec.fromBitmap(greyOf(w, h, (x, y) => (x * 3 + y * 5) & 255));

            // 1001 x 999: within 2048, so it goes 1:1, padded to 1008 x 1000
            const W = 1001, H = 999;
            const image = codec.fromBitmap(greyOf(W, H, (x, y) => (x * 7 + y * 13) & 255));
            const mask = codec.fromBitmap(greyOf(W, H, (x, y) => (x >= 400 && x < 700 && y >= 300 && y < 600 ? 200 : 40)));
            mock.script.result = answerOf(1008, 1000);
            let c0 = mock.calls.length, out;
            try { out = await sub.edit({ kind: "fill", model: "images_retouch", prompt: "a red door", image, mask, references: [], params: {} }, vctx); } finally { mock.script.result = null; }
            const rt = toolCalls(c0).find((x) => x.tool === "images_retouch");
            check("two uploads, then images_retouch {creationIdentifier, maskCreationIdentifier, mode, prompt}, every call valid",
                eq(toolsOf(c0), ["creations_request_upload", "creations_finalize_upload", "creations_request_upload", "creations_finalize_upload", "images_retouch", "creations_wait", "creations_register_download"])
                && !invalid(c0).length && rt && eq(Object.keys(rt.args), ["creationIdentifier", "maskCreationIdentifier", "mode", "prompt"]) && rt.args.mode === "replace" && rt.args.prompt === "a red door", short(rt && rt.args));
            const sent = codec.bitmap(mock.creations.get(rt.args.creationIdentifier).bytes);
            const sentMask = codec.bitmap(mock.creations.get(rt.args.maskCreationIdentifier).bytes);
            const src = codec.bitmap(image);
            let same = true, edge = true, maskOk = true;
            for (let y = 0; y < 1000; y++) for (let x = 0; x < 1008; x++) {
                const j = (y * 1008 + x) * 4;
                const sj = (Math.min(y, H - 1) * W + Math.min(x, W - 1)) * 4;
                if (x < W && y < H) { if (sent.data[j] !== src.data[sj] || sent.data[j + 3] !== 255) same = false; }
                else if (sent.data[j] !== src.data[sj]) edge = false;
                const want = x < W && y < H && x >= 400 && x < 700 && y >= 300 && y < 600 ? 255 : 0;
                if (sentMask.data[j] !== want || sentMask.data[j + 3] !== 255) maskOk = false;
            }
            check("1001 x 999 goes as 1008 x 1000: the crop's pixels 1:1, the padding repeats the edge", sent.width === 1008 && sent.height === 1000 && same && edge, `${sent.width}x${sent.height} same ${same} edge ${edge}`);
            check("the mask: the same size, black and white only, the selection in place, the padding black (keep)", sentMask.width === 1008 && sentMask.height === 1000 && maskOk);
            const back = codec.bitmap(out.bytes), ans = codec.bitmap(answerOf(1008, 1000));
            let crop = !!back && back.width === W && back.height === H;
            for (let y = 0; crop && y < H; y++) if (Buffer.compare(back.data.subarray(y * W * 4, (y + 1) * W * 4), ans.data.subarray(y * 1008 * 4, y * 1008 * 4 + W * 4)) !== 0) crop = false;
            check("the answer is cut back to 1001 x 999, pixel for pixel; the credits and the size sent in info", crop && out.width === W && out.height === H && out.info.credits === 90 && eq(out.info.sent, [1008, 1000]), short(out.info));

            // Magnific answering at twice the size: the picture's part, scaled to the crop
            mock.script.result = answerOf(2016, 2000);
            try { out = await sub.edit({ kind: "fill", prompt: "x", image, mask, params: {} }, vctx); } finally { mock.script.result = null; }
            check("an answer at another resolution is cut in proportion and scaled to the crop", out.width === W && out.height === H && codec.bitmap(out.bytes).width === W);

            // 3000 x 1000: scaled to 2048 x 683 (aspect kept), padded to 2048 x 688, the answer back at 3000 x 1000
            const big = codec.fromBitmap(greyOf(3000, 1000, (x, y) => (x + y) & 255));
            const bigMask = codec.fromBitmap(greyOf(3000, 1000, (x) => (x >= 1500 ? 255 : 0)));
            mock.script.result = answerOf(2048, 688);
            c0 = mock.calls.length;
            try { out = await sub.edit({ kind: "fill", prompt: "x", image: big, mask: bigMask, params: {} }, vctx); } finally { mock.script.result = null; }
            const rt2 = toolCalls(c0).find((x) => x.tool === "images_retouch");
            const s2 = codec.bitmap(mock.creations.get(rt2.args.creationIdentifier).bytes), m2 = codec.bitmap(mock.creations.get(rt2.args.maskCreationIdentifier).bytes);
            check("3000 x 1000 goes as 2048 x 688 (scaled to 2048 x 683, padded), the mask the same; the answer comes back at 3000 x 1000",
                s2.width === 2048 && s2.height === 688 && m2.width === 2048 && m2.height === 688 && m2.data[(687 * 2048 + 2047) * 4] === 0 && m2.data[(682 * 2048 + 2047) * 4] === 255 && out.width === 3000 && out.height === 1000, `${s2.width}x${s2.height} -> ${out.width}x${out.height}`);
            const geo = [[3000, 1000], [1001, 999], [2048, 2048], [100, 5000], [5, 5], [800, 600]].map(([w, h]) => { const g = P.retouchGeometry(w, h); return [g.width, g.height, g.padWidth, g.padHeight]; });
            check("the geometry: 3000x1000 -> 2048x683 in 2048x688, 1001x999 1:1 in 1008x1000, 2048 as it is, 100x5000 -> 41x2048 in 48x2048, 5x5 in 8x8",
                eq(geo, [[2048, 683, 2048, 688], [1001, 999, 1008, 1000], [2048, 2048, 2048, 2048], [41, 2048, 48, 2048], [5, 5, 8, 8], [800, 600, 800, 600]]), short(geo));

            // a picture already at its size goes as it is, and the answer as it came
            const small = codec.fromBitmap(greyOf(800, 600, (x) => x & 255));
            c0 = mock.calls.length;
            out = await sub.edit({ kind: "fill", prompt: "sky", image: small, mask: codec.fromBitmap(greyOf(800, 600, () => 255)), params: { mode: "Replace", model: "Google Nano Banana Pro", resolution: "4k" } }, vctx);
            const rt3 = toolCalls(c0).find((x) => x.tool === "images_retouch");
            check("800 x 600 is sent unchanged; Nano Banana Pro at 4k sends its slug and the resolution", Buffer.compare(mock.creations.get(rt3.args.creationIdentifier).bytes, small) === 0
                && rt3.args.model === "retouch-imagen-nano-banana-2" && rt3.args.resolution === "4k" && !invalid(c0).length, short(rt3.args));
            const e0 = await throws(() => sub.edit({ kind: "fill", prompt: "sky", image: codec.fromBitmap(greyOf(801, 600, () => 9)), mask: codec.fromBitmap(greyOf(801, 600, () => 255)), params: {} }, vctx));
            check("an answer of another size that cannot be read is refused in words (not stitched blind)", /the retouched picture could not be read/.test(e0 || ""), e0);

            // erase: no prompt; the model Erase by its slug
            c0 = mock.calls.length;
            await sub.edit({ kind: "fill", prompt: "ignored for erase", image: small, mask: small, params: { mode: "Erase", model: "Erase" } }, vctx);
            const rt4 = toolCalls(c0).find((x) => x.tool === "images_retouch");
            check("Erase sends no prompt; the model Erase goes as retouch-erase", rt4 && !("prompt" in rt4.args) && rt4.args.mode === "erase" && rt4.args.model === "retouch-erase" && !invalid(c0).length, short(rt4 && rt4.args));

            // refusals before any upload
            const before = { calls: mock.calls.length, http: mock.http.length };
            const r = (prompt, params, kind = "fill") => throws(() => sub.edit({ kind, prompt, image: small, mask: small, params }, vctx));
            const errs = [
                await r("   ", {}),
                await r("x", { mode: "Erase", model: "Classic" }),
                await r("x", { model: "Google Nano Banana Pro", resolution: "1k" }),
                await r("x", { model: "Auto", resolution: "2k" }),
                await r("x", {}, "edit"),
            ];
            check("refused before any upload: Replace without a prompt, Classic erasing, Nano Banana Pro at 1k, a resolution on Auto, an edit without a mask",
                /Replace needs a prompt/.test(errs[0] || "") && /the model Classic does not erase; it takes the mode Replace/.test(errs[1] || "") && /takes the resolution 2k and 4k, not 1k/.test(errs[2] || "")
                && /the model Auto takes no resolution/.test(errs[3] || "") && /needs the selection as a mask/.test(errs[4] || "") && mock.calls.length === before.calls && mock.http.length === before.http, errs.join(" | "));
            const lay = sub.layout({ kind: "fill", references: [Buffer.from([1])], original: 0 });
            check("the layout: the crop and the mask; reference layers are dropped (a note says so)", lay.pictures.length === 2 && lay.pictures[0].role === "crop" && lay.pictures[1].role === "mask" && lay.pictures[1].n === null && /alone/.test(lay.drops || ""), short(lay));

            // the size of an answer that is no PNG: from a JPEG's header
            const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x01, 0xf4, 0x02, 0x80, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
            check("imageSize reads a JPEG's SOF (640 x 500) and a PNG's IHDR", eq(P.imageSize(jpeg), [640, 500]) && eq(P.imageSize(answerOf(7, 3)), [7, 3]) && P.imageSize(Buffer.from("not a picture at all, no")) === null);
        });

        await section("20. generate (kind text)", async () => {
            let c0 = mock.calls.length;
            const out = await sub.generate({ kind: "text", model: "images_generate", prompt: "a lighthouse at dusk", width: 1920, height: 1080, references: [], params: { model: "Seedream 5 Pro" }, seed: 7 }, vctx);
            const g = toolCalls(c0).find((x) => x.tool === "images_generate");
            check("without references: no upload, images_generate {prompt, mode, aspectRatio, count: 1, seed}, valid",
                eq(toolsOf(c0), ["images_generate", "creations_wait", "creations_register_download"]) && !invalid(c0).length && eq(g.args, { prompt: "a lighthouse at dusk", mode: "seedream-5-pro", aspectRatio: "16:9", count: 1, seed: 7 }), short(g && g.args));
            check("the answer: the first result, its size, the credits, the model and the aspect", out.width === 64 && out.height === 48 && eq(out.info, { credits: 90, model: "seedream-5-pro", aspect: "16:9" }) && out.seed === 7, short(out.info));

            c0 = mock.calls.length;
            const refs = [pngBytes(200, "REF-A"), pngBytes(200, "REF-B"), pngBytes(200, "REF-C")];
            await sub.generate({ kind: "text", prompt: "the cat of image 1 on the sofa of image 3", width: 1024, height: 1024, references: refs, params: { model: "Flux.2 Pro" } }, vctx);
            const g2 = toolCalls(c0).find((x) => x.tool === "images_generate");
            const ups = toolCalls(c0).filter((x) => x.tool === "creations_finalize_upload").map((x) => x.args.fileName);
            const ids = (g2 && g2.args.references || []).map((x) => x.identifier);
            check("three reference layers: three uploads, then references [{type: \"image\", identifier}] in their order (the schema's shape)",
                eq(ups, ["scumble-ref-1.png", "scumble-ref-2.png", "scumble-ref-3.png"]) && g2 && eq(g2.args.references.map((x) => Object.keys(x)), [["type", "identifier"], ["type", "identifier"], ["type", "identifier"]])
                && g2.args.references.every((x) => x.type === "image") && ids.every((id, i) => mock.creations.get(id).bytes.toString("latin1", 33, 38) === ["REF-A", "REF-B", "REF-C"][i]) && !invalid(c0).length, short(g2 && g2.args));
            check("... the prompt says what the references are; the model's slug and its aspect", g2.args.prompt === "the cat of image 1 on the sofa of image 3 Images 1 to 3 are reference images." && g2.args.mode === "flux-2" && g2.args.aspectRatio === "1:1", g2.args.prompt);

            c0 = mock.calls.length;
            await sub.generate({ kind: "text", prompt: "a castle", width: 800, height: 1200, references: [pngBytes(200, "STYLE")], params: { model: "Mystic 2.5" } }, vctx);
            const g3 = toolCalls(c0).find((x) => x.tool === "images_generate");
            check("Mystic 2.5 takes a creation as a style picture: type \"style\", no reference sentence", g3 && eq(g3.args.references.map((x) => x.type), ["style"]) && g3.args.prompt === "a castle" && g3.args.aspectRatio === "2:3" && !invalid(c0).length, short(g3 && g3.args));
            const lay = sub.textLayout({ kind: "text", references: [1, 2].map(() => Buffer.from([1])), original: 0, params: { model: "Recraft V4.1" } });
            const lay2 = sub.textLayout({ kind: "text", references: [1, 2].map(() => Buffer.from([1])), original: 0, params: {} });
            check("the text layouts: style references unnumbered for Recraft V4.1, numbered 1, 2 for Auto, both capped at 12", lay.style && lay.pictures.every((x) => x.n === null) && lay.max === 12 && eq(lay2.pictures.map((x) => x.n), [1, 2]) && lay2.max === 12, short([lay, lay2]));

            const a = (label, w, h) => sub._aspectFor(sub._tables.GENERATE_MODELS[label], w, h);
            check("the aspect: the model's closest that images_generate takes (GPT 2 at 3:1 gets 21:9, Nano Banana 2 at 4:1 gets 21:9, Flux.2 Max at 21:9 gets 2:1)",
                a("GPT 2", 3000, 1000) === "21:9" && a("Google Nano Banana 2", 4000, 1000) === "21:9" && a("Flux.2 Max", 2100, 900) === "2:1" && a("Auto", 1000, 1250) === "4:5", [a("GPT 2", 3000, 1000), a("Google Nano Banana 2", 4000, 1000), a("Flux.2 Max", 2100, 900), a("Auto", 1000, 1250)].join(", "));

            const before = { calls: mock.calls.length, http: mock.http.length };
            const e1 = await throws(() => sub.generate({ kind: "text", prompt: "x", references: Array.from({ length: 13 }, () => pngBytes(100, "R")), params: {} }, vctx));
            const e2 = await throws(() => sub.generate({ kind: "text", prompt: " ", references: [], params: {} }, vctx));
            const e3 = await throws(() => sub.generate({ kind: "text", prompt: "x", references: [], params: { model: "Cinematic" } }, vctx));
            check("refused before anything is sent: 13 references, no prompt, a model not on the list", /at most 12 reference images/.test(e1 || "") && /needs a prompt/.test(e2 || "") && /no model "Cinematic"/.test(e3 || "") && mock.calls.length === before.calls && mock.http.length === before.http, [e1, e2, e3].join(" | "));
        });

        await section("21. the curated lists against the catalogs", async () => {
            const read = (n) => fs.readFileSync(path.join(__dirname, "refs", "magnificsub", n), "utf8");
            const entries = (text) => text.split(/\n  - slug: /).slice(1).map((b) => {
                const slug = b.split("\n")[0].trim();
                const field = (k) => { const m = new RegExp(`\\n    ${k}(?:\\[\\d+\\])?: (.*)`).exec(b); return m ? m[1].trim() : null; };
                const list = (k) => (field(k) || "").split(",").map((x) => x.replace(/"/g, "")).filter(Boolean);
                return { slug, name: field("name"), beta: field("beta") === "true", private: field("private") === "true", aspects: list("aspectRatios"), modes: list("retouchModes"), resolutions: list("resolutions"), refTypes: list("referenceTypes") };
            });
            const models = new Map(entries(read("catalog_images_models_list.txt")).map((e) => [e.slug, e]));
            const bad = [];
            for (const [label, m] of Object.entries(sub._tables.GENERATE_MODELS)) {
                const e = models.get(m.slug);
                if (!e) { bad.push(`${label}: ${m.slug} not in the catalog`); continue; }
                // every model the account's catalog lists is offered; a beta or private one is marked (beta)
                const mark = e.beta || e.private ? " (beta)" : "";
                if (`${e.name}${mark}` !== label) bad.push(`${label}: the catalog calls ${m.slug} "${e.name}"${mark}`);
                if (!eq(e.aspects.filter((x) => x !== "auto"), m.aspects)) bad.push(`${label}: aspects ${m.aspects} vs ${e.aspects}`);
                if (!e.refTypes.includes(m.ref) || (m.ref === "style" && e.refTypes.includes("image"))) bad.push(`${label}: reference type ${m.ref} vs ${e.refTypes}`);
            }
            const retouch = new Map(entries(read("catalog_retouch_models_list.txt")).map((e) => [e.slug, e]));
            for (const [label, m] of Object.entries(sub._tables.RETOUCH_MODELS)) {
                const e = retouch.get(m.slug || "retouch-auto");
                if (!e) { bad.push(`retouch ${label}: not in the catalog`); continue; }
                if (e.name !== label) bad.push(`retouch ${label}: the catalog calls it "${e.name}"`);
                if (`${e.name}${e.beta || e.private ? " (beta)" : ""}` !== label) bad.push(`retouch ${label}: the label misses its (beta) mark`);
                if (!eq(e.modes, m.modes)) bad.push(`retouch ${label}: modes ${m.modes} vs ${e.modes}`);
                if (!eq(e.resolutions, m.resolutions || [])) bad.push(`retouch ${label}: resolutions ${m.resolutions} vs ${e.resolutions}`);
            }
            check("every generate and retouch entry has the catalog's name (\" (beta)\" for a beta or private model), slug, aspects, modes and resolutions", !bad.length, bad.join(" | "));
            // the spec's whole list in its order: GPT 2.5 is beta, Ideogram 4.5 and Qwen Image 3.0 Pro beta and private
            const spec = ["Auto", "Flux.2 Pro", "Flux.2 Max", "GPT 2", "GPT 2.5 (beta)", "Google Nano Banana Pro", "Google Nano Banana 2", "Seedream 5 Pro", "Ideogram 4.5 (beta)", "Mystic 2.5", "Recraft V4.1", "Qwen Image 3.0 Pro (beta)"];
            const flags = ["gpt-2-mini", "ideogram-4-5", "qwen-image-3-0-pro"].map((x) => models.get(x));
            check("the catalog's flags: GPT 2.5 beta only, Ideogram 4.5 and Qwen Image 3.0 Pro beta and private (offered, marked (beta))", flags[0].beta && !flags[0].private && flags.slice(1).every((e) => e && e.beta && e.private));
            check("the generate list is the spec's, in its order", eq(Object.keys(sub._tables.GENERATE_MODELS), spec) && eq(Object.keys(sub._tables.RETOUCH_MODELS), ["Auto", "Classic", "Erase", "Google Nano Banana Pro", "Google Nano Banana 2"]));
            const schemaAspects = mockLib.toolDefs().find((d) => d.name === "images_generate").inputSchema.properties.aspectRatio.enum;
            check("the aspects images_generate takes are its schema's enum", eq([...sub._tables.GENERATE_ASPECTS].sort(), [...schemaAspects].sort()));
        });

        await section("22. cutout, balance, ready", async () => {
            // the result: 4 x 2, alpha 0, 64, 128, 255 per column
            mock.script.result = codec.fromBitmap({ width: 4, height: 2, data: Buffer.from([...Array(8).keys()].flatMap((i) => [10, 20, 30, [0, 64, 128, 255][i % 4]])) });
            const c0 = mock.calls.length;
            let out;
            try { out = await sub.cutout(pngBytes(300, "CUT"), vctx); } finally { mock.script.result = null; }
            const call = toolCalls(c0).find((x) => x.tool === "images_remove_background");
            const m = codec.bitmap(out.bytes);
            check("images_remove_background {creationIdentifier}, valid", call && eq(Object.keys(call.args), ["creationIdentifier"]) && !invalid(c0).length, short(call && call.args));
            check("the cut-out's alpha as a grey mask (white = keep) at the result's size, with the credits", m && m.width === 4 && m.height === 2 && out.width === 4 && out.height === 2
                && eq([...m.data.subarray(0, 16)], [0, 0, 0, 255, 64, 64, 64, 255, 128, 128, 128, 255, 255, 255, 255, 255]) && eq(out.info, { credits: 90, model: "remove-background" }), short(m && [...m.data]));
            const e = await throws(() => sub.cutout(pngBytes(100, "X"), { ...vctx, bitmap: undefined }));
            check("no codec: refused in words before the upload", /cannot read the cut-out/.test(e || ""), e);

            check("balance: \"<available> credits (<plan>)\" from account_balance", await sub.balance(vctx) === "1000 credits (Mock Plan)");
            const old = fakeKeys();
            old.set("magnificsub", JSON.stringify({ ...JSON.parse(vk.data.magnificsub), tokenOrigin: undefined }));
            check("ready: a sign-in stored without its token endpoint (before the pin) -> sign in again", eq(sub.ready({ keys: old, settings }), { ok: false, reason: auth.RESIGN }) && sub.status({ keys: old, settings }).signedIn === true);
            check("ready: signed in -> ok; signed out -> the sign-in sentence", eq(sub.ready({ keys: vk, settings }), { ok: true }) && eq(sub.ready({ keys: fakeKeys(), settings }), { ok: false, reason: "Sign in to Magnific (subscription) first: Settings › API providers." }));
            const e2 = await throws(() => sub.balance({ keys: fakeKeys(), settings, fetch: rec }));
            check("a verb while signed out says to sign in, nothing sent", e2 === auth.NOT_SIGNED_IN, e2);
        });

        await section("23. providers/index.js: the ready() hook", async () => {
            const idxPath = path.join(ROOT, "electron", "main", "providers", "index.js");
            const store = fakeKeys();
            const orig = Module._load;
            Module._load = function (request, parent, ...rest) {
                if (request === "electron") return { nativeImage: {} };
                if (parent && parent.filename === idxPath) {
                    if (request === "../log") return { record: () => {} };
                    if (request === "../keys") return { get: store.get, set: store.set, clear: store.clear, describe: (id) => ({ name: id, set: !!store.get(id) }) };
                    if (request === "../settings") return { get: () => settings };
                }
                return orig.call(this, request, parent, ...rest);
            };
            let index;
            try { index = require(idxPath); } finally { Module._load = orig; }
            const P = index.PROVIDERS.magnificsub;
            const keepEdit = P.edit, keepGen = P.generate, keepUp = P.upscale, keepBal = P.balance;
            const seen = [];
            P.edit = async (req, c) => { seen.push(["edit", req, c]); return { bytes: pngBytes(80, "OUT"), mime: "image/png", info: { credits: 90 } }; };
            P.generate = async (req, c) => { seen.push(["generate", req, c]); return { bytes: pngBytes(80, "OUT"), mime: "image/png", info: {} }; };
            P.upscale = async (req, c) => { seen.push(["upscale", req, c]); return { bytes: pngBytes(80, "OUT"), mime: "image/png", info: {} }; };
            P.balance = async () => "1 credits";
            try {
                const rows = index.describeAll();
                const row = rows.find((x) => x.id === "magnificsub");
                check("describeAll: the magnificsub row has auth \"oauth\" and signedIn false; no other row has either",
                    row && row.auth === "oauth" && row.signedIn === false && row.label === "Magnific (subscription)" && row.balance === true && rows.filter((x) => x.id !== "magnificsub").every((x) => !("auth" in x) && !("signedIn" in x)), short(row));
                check("... the other rows keep their seven fields", rows.filter((x) => x.id !== "magnificsub").every((x) => eq(Object.keys(x), ["id", "label", "keyUrl", "keyHint", "key", "balance", "sharesKey"])));
                check("magnificsub is a text and an upscale provider", index.textProviders().includes("magnificsub") && index.upscaleProviders().includes("magnificsub"));
                const pic = new Uint8Array(pngBytes(80, "CROP"));
                const e1 = await throws(() => index.edit({ provider: "magnificsub", kind: "fill", model: "images_retouch", prompt: "x", image: pic, mask: pic, references: [], params: {} }));
                const e2 = await throws(() => index.balance("magnificsub"));
                check("signed out: edit() and balance() refuse with the sign-in sentence, the adapter is never called", e1 === "Sign in to Magnific (subscription) first: Settings › API providers." && e2 === e1 && !seen.length, `${e1} | ${e2}`);

                await auth.signIn({ keys: store, settings, openExternal: browser(), fetch: rec });
                remember(store);
                check("signed in: describeAll says so", index.describeAll().find((x) => x.id === "magnificsub").signedIn === true);
                const r1 = await index.edit({ provider: "magnificsub", kind: "fill", model: "images_retouch", prompt: "x", image: pic, mask: pic, references: [new Uint8Array(pngBytes(80, "REF"))], params: {} });
                check("... a fill reaches the adapter's edit with the key empty; the reference layer is dropped with a note", seen.length === 1 && seen[0][0] === "edit" && seen[0][2].key === "" && seen[0][1].references.length === 0
                    && r1.notes.length === 1 && /Retouch takes the picture and the mask alone/.test(r1.notes[0]), short(r1.notes));
                const r2 = await index.edit({ provider: "magnificsub", kind: "text", model: "images_generate", prompt: "a cat like {@ref:1}", width: 1024, height: 1024, references: [new Uint8Array(pngBytes(80, "A")), new Uint8Array(pngBytes(80, "B"))], params: { model: "Flux.2 Pro" } });
                check("... a text run with references reaches generate; the marker becomes \"image 2\"", seen[1] && seen[1][0] === "generate" && seen[1][1].references.length === 2 && seen[1][1].prompt === "a cat like image 2" && eq(r2.refs, [{ ref: 1, name: "image 2" }]), short(seen[1] && seen[1][1].prompt));
                const e3 = await throws(() => index.edit({ provider: "magnificsub", kind: "text", model: "images_generate", prompt: "a cat like {@ref:0}", references: [new Uint8Array(pngBytes(80, "A"))], params: { model: "Mystic 2.5" } }));
                check("... a prompt that names a style reference (Mystic 2.5) is refused before the adapter", !!e3 && seen.length === 2, e3);
                await index.edit({ provider: "magnificsub", kind: "upscale", model: "images_upscale", factor: 4, image: pic, references: [], params: {} });
                check("... an upscale reaches upscale with its factor", seen[2] && seen[2][0] === "upscale" && seen[2][1].factor === 4);
                check("... and balance() reaches the adapter", await index.balance("magnificsub") === "1 credits");
                const pv = index.layout({ provider: "magnificsub", kind: "text", count: 3, params: { model: "Auto" } });
                const pvStyle = index.layout({ provider: "magnificsub", kind: "text", count: 2, params: { model: "Recraft V4.1" } });
                check("the preview layout: Auto names image 1-3, Recraft V4.1 none (style references)", eq(pv.names, ["image 1", "image 2", "image 3"]) && eq(pvStyle.names, [null, null]), short([pv.names, pvStyle.names]));
                const e4 = await throws(() => index.edit({ provider: "magnific", kind: "fill", model: "ideogram-image-edit", prompt: "x", image: pic, mask: pic, references: [], params: {} }));
                check("a key provider keeps the key check (Magnific without a key)", e4 === "No API key for Magnific. Add it under Settings › API providers.", e4);
            } finally {
                P.edit = keepEdit; P.generate = keepGen; P.upscale = keepUp; P.balance = keepBal;
            }
        });

        await section("23b. providers/index.js: sign in, cancel, sign out and the cutout (the IPC of the Settings row)", async () => {
            const idxPath = path.join(ROOT, "electron", "main", "providers", "index.js");
            const store = fakeKeys();
            // nativeImage played by the fake codec (index.js's bitmap / fromBitmap go through it)
            const nativeImage = {
                createFromBuffer: (b) => { const bm = codec.bitmap(b); return { isEmpty: () => !bm, getSize: () => ({ width: bm.width, height: bm.height }), toBitmap: () => Buffer.from(bm.data) }; },
                createFromBitmap: (data, size) => ({ toPNG: () => codec.fromBitmap({ width: size.width, height: size.height, data }) }),
            };
            const logged = [];
            const orig = Module._load;
            Module._load = function (request, parent, ...rest) {
                if (request === "electron") return { nativeImage };
                if (parent && parent.filename === idxPath) {
                    if (request === "../log") return { record: (e) => logged.push(e) };
                    if (request === "../keys") return { get: store.get, set: store.set, clear: store.clear, describe: (id) => ({ name: id, set: !!store.get(id) }) };
                    if (request === "../settings") return { get: () => settings };
                }
                return orig.call(this, request, parent, ...rest);
            };
            let index;
            try {
                delete require.cache[idxPath];
                index = require(idxPath);
            } finally { Module._load = orig; }
            const waitFor = async (fn) => { for (let i = 0; i < 200; i++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); } return null; };
            check("authStatus: signed out, nothing pending", eq(index.authStatus("magnificsub"), { signedIn: false }));
            const e0 = await throws(() => Promise.resolve().then(() => index.authStatus("magnific")));
            check("a key provider does not sign in", /does not sign in/.test(e0 || ""), e0);

            // a test sign-in: no browser opens (openExternal is never called), the URL waits in authStatus for the test
            const opened = [];
            const run = index.signIn("magnificsub", { openExternal: async (u) => { opened.push(u); } });
            const pend = await waitFor(() => { const s = index.authStatus("magnificsub"); return s.url ? s : null; });
            check("while it waits: pending, with the mock's authorization URL", !!pend && pend.pending === true && pend.signedIn === false && pend.url.startsWith(mock.base + "/realm/auth?"), short(pend));
            const e1 = await throws(() => index.signIn("magnificsub", { openExternal: async () => {} }));
            check("... a second sign-in at the same time is refused", /already waiting for the browser/.test(e1 || ""), e1);
            await browser()(pend.url);
            const st = await run;
            remember(store);
            check("following the URL signs in; openExternal was never called", eq(st, { signedIn: true, account: "Mock Plan" }) && opened.length === 0 && eq(index.authStatus("magnificsub"), { signedIn: true, account: "Mock Plan" }), short(st));
            check("describeAll: the row reads signed in", index.describeAll().find((x) => x.id === "magnificsub").signedIn === true);

            // the cutout through index.js (the editor's backend): a grey PNG (white = keep), with the credits, logged
            mock.script.result = codec.fromBitmap({ width: 2, height: 1, data: Buffer.from([1, 2, 3, 0, 1, 2, 3, 255]) });
            let cut;
            try { cut = await index.cutout("magnificsub", new Uint8Array(pngBytes(200, "LAYER"))); } finally { mock.script.result = null; }
            const g = codec.bitmap(cut.bytes);
            check("cutout: the grey mask at the answer's size with info.credits", g && g.width === 2 && eq([...g.data], [0, 0, 0, 255, 255, 255, 255, 255]) && cut.info.credits === 90 && cut.seconds >= 0, short(cut && cut.info));
            check("... and an info line in the log", logged.some((e) => e.level === "info" && e.message === "Magnific (subscription) cutout ok"));
            const e2 = await throws(() => index.cutout("magnific", new Uint8Array(4)));
            check("a provider without a cutout is refused", /has no background removal/.test(e2 || ""), e2);

            // a second sign-in cancelled from the row: the stored sign-in stays
            const before = store.data.magnificsub;
            const run2 = index.signIn("magnificsub", {});
            await waitFor(() => index.authStatus("magnificsub").url);
            check("cancel: true while one waits", index.cancelSignIn("magnificsub") === true);
            const e3 = await throws(() => run2);
            check("... the sign-in ends as cancelled, the stored one is kept, nothing pends", /the sign-in was cancelled/.test(e3 || "") && store.data.magnificsub === before && eq(index.authStatus("magnificsub"), { signedIn: true, account: "Mock Plan" }), e3);
            check("cancel with nothing waiting: false", index.cancelSignIn("magnificsub") === false);
            // a Cancel that comes after the browser's code arrived: the new sign-in is dropped all the same
            const ac = new AbortController();
            const late = async (url) => { await browser()(url); ac.abort(); };
            const g0 = mock.oauth.grants.length;
            const e5 = await throws(() => auth.signIn({ keys: store, settings, openExternal: late, fetch: rec, signal: ac.signal }));
            check("... a Cancel after the code (traded already) still ends as cancelled and keeps the stored sign-in", /the sign-in was cancelled/.test(e5 || "") && store.data.magnificsub === before
                && mock.oauth.grants.slice(g0).some((g) => g.grant_type === "authorization_code"), e5);

            const out = await index.signOut("magnificsub");
            check("sign out: signed out, and keys no longer hold magnificsub", eq(out, { signedIn: false }) && !("magnificsub" in store.data));
            const e4 = await throws(() => index.cutout("magnificsub", new Uint8Array(pngBytes(50, "L"))));
            check("signed out: the cutout says to sign in, nothing sent", e4 === "Sign in to Magnific (subscription) first: Settings › API providers.", e4);
        });

        await section("24. the four recipes", async () => {
            const origLoad = Module._load;
            Module._load = function (request, ...rest) {
                if (request === "electron") return { app: { getPath: () => os.tmpdir() } };
                return origLoad.call(this, request, ...rest);
            };
            let recipes;
            try { recipes = require(path.join(ROOT, "electron", "main", "recipes.js")); } finally { Module._load = origLoad; }
            const raw = (id) => JSON.parse(fs.readFileSync(path.join(ROOT, "recipes", id + ".json"), "utf8"));
            const norm = (id) => recipes._normalize(raw(id));
            const cr = norm("magnificsub_creative"), pr = norm("magnificsub_precision"), rt = norm("magnificsub_retouch"), gen = norm("magnificsub_generate");
            const all = [cr, pr, rt, gen];
            const vc = cr.providers.magnificsub, vp = pr.providers.magnificsub, vr = rt.providers.magnificsub, vg = gen.providers.magnificsub;
            check("the four recipes (no magnificsub_upscale any more) have magnificsub as their only provider and default", !fs.existsSync(path.join(ROOT, "recipes", "magnificsub_upscale.json"))
                && all.every((r) => r.default === "magnificsub" && eq(r.providerIds, ["magnificsub"])));
            check("the descriptions and notes say they run on the plan's credits after signing in", all.every((r) => /Magnific plan's credits, after signing in under Settings › API providers/.test(r.description) && /signing in under Settings › API providers; each run spends the plan's credits/.test(r.providers.magnificsub.note)));
            check("Creative: an upscaler, factor 2/4/8/16, the prompt goes along, its model names the kind", cr.task === "upscale" && eq(vc.factor.steps, [2, 4, 8, 16]) && vc.factor.default === 2 && vc.usesPrompt === true && vc.text === null && vc.model === "images_upscale:creative");
            check("Precision: an upscaler, factor 2/4/8/16 (the mode refuses more), no prompt", pr.task === "upscale" && eq(vp.factor.steps, [2, 4, 8, 16]) && vp.usesPrompt === false && vp.text === null && vp.model === "images_upscale:precision");
            check("retouch: input fill, no text shape, the crop at most 2048 in steps of 8", vr.input === "fill" && vr.text === null && vr.edit === true && vr.limits.max === 2048 && vr.limits.step === 8);
            check("generate: Generate new only, images_generate with up to 12 references", vg.edit === false && vg.text && vg.text.model === "images_generate" && vg.text.refs && vg.text.refs.max === 12);
            // every row's choices are what the adapter's tables take, and the defaults run
            const rows = (v) => Object.fromEntries(v.settings.map((s) => [s.key, s]));
            const rc = rows(vc), rp = rows(vp), rr = rows(vr), rg = rows(vg);
            const T = sub._tables;
            const precisionModes = Object.keys(T.UPSCALE_MODES).filter((k) => T.UPSCALE_MODES[k].kind === "precision");
            check("the rows: Creative has Preset, Optimized for, Engine and its four sliders; Precision Mode, Precision preset and its three sliders; the choices are the adapter's labels",
                eq(Object.keys(rc), ["preset", "optimised", "engine", "creativity", "resemblance", "hdr", "fractality"]) && eq(Object.keys(rp), ["mode", "precisionPreset", "sharpness", "grain", "ultraDetail"])
                && eq(rc.preset.spec[0], Object.keys(T.CREATIVE_PRESETS)) && eq(rc.optimised.spec[0], Object.keys(T.UPSCALE_OPTIMISED)) && eq(rc.engine.spec[0], Object.keys(T.UPSCALE_ENGINES))
                && eq(rp.mode.spec[0], precisionModes) && eq(rp.precisionPreset.spec[0], Object.keys(T.PRECISION_PRESETS))
                && eq(rr.mode.spec[0], Object.keys(T.RETOUCH_MODES)) && eq(rr.model.spec[0], Object.keys(T.RETOUCH_MODELS)) && eq(rg.model.spec[0], Object.keys(T.GENERATE_MODELS)));
            const defaults = (v) => Object.fromEntries(v.settings.map((s) => [s.key, s.spec[1].default]));
            const dc = sub._upscaleArgs({ model: vc.model, factor: 2, params: defaults(vc) }), dp = sub._upscaleArgs({ model: vp.model, factor: 2, params: defaults(vp) });
            const dr = sub._retouchArgs({ prompt: "x", params: defaults(vr) });
            check("the defaults make a valid request (Creative Subtle 2x; Precision sublime with its sliders; Replace on Auto)",
                eq(dc, { mode: "creative", scale: "2x", presets: "subtle", optimised: "StandardUltra", engine: "automatic" }) && eq(dp, { mode: "ultra-sublime", scale: "2x", sharpness: 7, grain: 4 }) && eq(dr, { mode: "replace", prompt: "x" }), short([dc, dp, dr]));
            const S = T.UPSCALE_SLIDERS;
            check("the INT rows' ranges are the catalog's", ["creativity", "resemblance", "hdr", "fractality"].every((k) => rc[k].spec[1].min === S[k][1] && rc[k].spec[1].max === S[k][2])
                && ["sharpness", "grain", "ultraDetail"].every((k) => rp[k].spec[1].min === S[k][1] && rp[k].spec[1].max === S[k][2]));
        });

        await section("24b. the file of a creation: the original, or results.url when there is none", async () => {
            const gets = (h0) => mock.http.slice(h0).filter((h) => h.method === "GET" && h.path.startsWith("/asset/")).map((h) => h.path);
            // generate: Magnific names no original (results.url is no re-encode); the wait entry's results.url is the file
            let c0 = mock.calls.length, h0 = mock.http.length;
            const gen = await sub.generate({ kind: "text", prompt: "a fox", width: 1024, height: 1024, references: [], params: {} }, vctx);
            const id = toolCalls(c0).find((x) => x.tool === "creations_wait").args.identifiers[0];
            check("generate: creations_register_download is still called (it records the download), names no original, and the file comes from results.url",
                eq(toolsOf(c0), ["images_generate", "creations_wait", "creations_register_download"]) && eq(gets(h0), [`/asset/${id}.jpg`]) && gen.bytes.toString("latin1", 33, 39) === "RESULT" && gen.width === 64, short(gets(h0)));
            // upscale: the original is named and preferred over results.url (the JPEG re-encode)
            c0 = mock.calls.length; h0 = mock.http.length;
            await sub.upscale({ kind: "upscale", model: "images_upscale:creative", image: pngBytes(300, "ORIG-PREF"), factor: 2, params: {} }, vctx);
            const upId = toolCalls(c0).find((x) => x.tool === "images_upscale") && toolCalls(c0).find((x) => x.tool === "creations_wait").args.identifiers[0];
            check("upscale: the original from creations_register_download, not results.url", eq(gets(h0), [`/asset/${upId}.png`]), short(gets(h0)));
            // retouch and remove_background without originals: the same fallback
            const keep = mock.script.noOriginals;
            mock.script.noOriginals = ["images_generate", "images_retouch", "images_remove_background"];
            try {
                const small = codec.fromBitmap(greyOf(800, 600, (x) => x & 255));
                h0 = mock.http.length;
                const rt = await sub.edit({ kind: "fill", prompt: "sky", image: small, mask: small, params: {} }, vctx);
                const rtGets = gets(h0);
                mock.script.result = codec.fromBitmap({ width: 2, height: 1, data: Buffer.from([1, 2, 3, 0, 1, 2, 3, 255]) });
                h0 = mock.http.length;
                let cut;
                try { cut = await sub.cutout(pngBytes(300, "CUT2"), vctx); } finally { mock.script.result = null; }
                check("retouch and remove_background with no original named: both download results.url", rtGets.length === 1 && rtGets[0].endsWith(".jpg") && rt.width === 64 && gets(h0).length === 1 && gets(h0)[0].endsWith(".jpg") && cut.width === 2, short([rtGets, gets(h0)]));
            } finally { mock.script.noOriginals = keep; }
            // neither: a clear error; a results.url outside the mock: refused, not fetched
            mock.script.resultUrl = false;
            let e;
            try { e = await throws(() => sub.generate({ kind: "text", prompt: "a fox", width: 1024, height: 1024, references: [], params: {} }, vctx)); } finally { mock.script.resultUrl = null; }
            check("no original and no results.url: the run fails in words", /neither creations_register_download \(no original\) nor creations_wait \(no results\.url\) named a file/.test(e || ""), e);
            mock.script.resultUrl = "http://example.com/x.png";
            const r0 = rec.log.length;
            try { e = await throws(() => sub.generate({ kind: "text", prompt: "a fox", width: 1024, height: 1024, references: [], params: {} }, vctx)); } finally { mock.script.resultUrl = null; }
            check("a results.url outside the mock goes through the same check: refused, not fetched", /refused the download URL at http:\/\/example\.com/.test(e || "") && !rec.log.slice(r0).some((x) => x.url.includes("example.com")), e);
        });

        await section("25. the whole run", async () => {
            const leaked = ERRORS.filter((m) => [...SEEN_TOKENS].some((t) => m.includes(t)));
            check("no token appears in any error of the run", SEEN_TOKENS.size >= 6 && ERRORS.length >= 15 && leaked.length === 0, `${ERRORS.length} errors, ${SEEN_TOKENS.size} tokens`);
            check("the mock never saw a non-test Bearer token", mock.oauth.foreignTokens.length === 0);
            const banned = ["X-Pik" + "aso-Client", "magnific-editor" + "-plugins"];
            const files = ["electron/main/providers/magnificsub.js", "electron/main/providers/magnificsub_auth.js", "tools/magnificsub_mock.js", "tools/magnificsub_test.js",
                "recipes/magnificsub_creative.json", "recipes/magnificsub_precision.json", "recipes/magnificsub_retouch.json", "recipes/magnificsub_generate.json"];
            const hits = files.filter((f) => { const s = fs.readFileSync(path.join(ROOT, f), "utf8").toLowerCase(); return banned.some((b) => s.includes(b.toLowerCase())); });
            check("no plugin client header and no plugin client id in the new files", hits.length === 0, hits.join(", "));
            check("no request of the mock carried a header beyond the usual ones", mock.http.every((h) => h.headers.every((n) => /^(host|connection|content-type|content-length|accept|accept-encoding|accept-language|user-agent|authorization|mcp-protocol-version|mcp-session-id|sec-fetch-mode|transfer-encoding)$/.test(n))),
                [...new Set(mock.http.flatMap((h) => h.headers))].join(","));
        });
    } finally {
        await sub.resetSession();
        await mock.close();
    }

    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + (err && err.stack || err)); console.log("FAIL"); process.exit(1); });
