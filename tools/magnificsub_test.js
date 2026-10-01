// "Magnific (subscription)" (magnificsub): the sign-in (electron/main/providers/magnificsub_auth.js) and the MCP
// session (electron/main/providers/magnificsub.js) in plain Node, no Electron, no account:
//   node tools/magnificsub_test.js
// The loopback mock (tools/magnificsub_mock.js) plays Magnific's MCP server and its OAuth realm; the browser step of
// the sign-in is an HTTP GET of the authorization URL (the mock's 302 lands on the app's loopback redirect). A fake
// store stands in for keys.js, a recording fetch sees every request, and a scripted fetch plays https://mcp.magnific.com
// for the host rule (nothing here talks to the live server).
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

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
            const guard = auth.guardFetch(async () => new Response("{}"), { url: auth.HOST, test: false });
            e = await throws(() => guard("http://127.0.0.1:5/", { headers: { authorization: "Bearer " + realTokens.access_token } }));
            const e2 = await throws(() => guard("https://elsewhere.example/", { headers: { authorization: "Bearer " + realTokens.access_token } }));
            const e3 = await throws(() => guard("https://auth.magnific.com/realms/mcp/protocol/openid-connect/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "test-rt-9" }) }));
            const ok = await guard("https://auth.magnific.com/realms/mcp/protocol/openid-connect/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: realTokens.refresh_token }) });
            check("the guard: no plain http, the access token to the MCP host only, no test refresh token to Magnific; a real refresh to the realm passes",
                /over http:/.test(e || "") && /refused to send the sign-in to elsewhere\.example/.test(e2 || "") && /never sent to Magnific/.test(e3 || "") && ok.status === 200, [e, e2, e3].join(" | "));
            await S4.close();
        });

        await section("12. the whole run", async () => {
            const leaked = ERRORS.filter((m) => [...SEEN_TOKENS].some((t) => m.includes(t)));
            check("no token appears in any error of the run", SEEN_TOKENS.size >= 6 && ERRORS.length >= 15 && leaked.length === 0, `${ERRORS.length} errors, ${SEEN_TOKENS.size} tokens`);
            check("the mock never saw a non-test Bearer token", mock.oauth.foreignTokens.length === 0);
            const banned = ["X-Pik" + "aso-Client", "magnific-editor" + "-plugins"];
            const files = ["electron/main/providers/magnificsub.js", "electron/main/providers/magnificsub_auth.js", "tools/magnificsub_mock.js", "tools/magnificsub_test.js"];
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
