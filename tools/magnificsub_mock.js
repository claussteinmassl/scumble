// A loopback stand-in for Magnific's MCP server and its OAuth realm, for tools/magnificsub_test.js and for a run of
// the app against settings.magnificsub.base = http://127.0.0.1:<port>:
//   node tools/magnificsub_mock.js --port 5579
// or, from a test: const mock = await require("./magnificsub_mock.js").start({ port: 0 });
//
// What it plays (the real shapes were measured by the spike of 2026-10-01, docs/PLAN_MAGNIFIC_SUB.md):
//   GET  /.well-known/oauth-protected-resource      { resource, authorization_servers: [<base>/realm] }
//   GET  /.well-known/oauth-authorization-server[/realm]   the realm's metadata (S256 only)
//   POST /realm/register                            dynamic client registration -> { client_id, ... }
//   GET  /realm/auth                                checks the client, the redirect URI and the S256 challenge,
//                                                   302 to redirect_uri?code=...&state=...
//   POST /realm/token                               authorization_code (the verifier hashed against the challenge,
//                                                   the redirect URI matched) and refresh_token (rotating)
//   POST /                                          the MCP endpoint (the SDK's low-level Server, stateless, JSON
//                                                   answers), Bearer test-... only, else 401 with resource_metadata
//   PUT  /upload/<uuid>                             the upload proxy (no credentials)
//   GET  /asset/<id>.png                            a creation's original (no credentials)
//
// The tools are listed with the input schemas copied from the live server (tools/refs/magnificsub/*.json); every call
// is validated against its schema (required keys, unknown keys, types, enums, bounds) and recorded in `calls`.
// Scripted failures: a prompt or a fileName containing "mock-failed" makes the creation fail, "mock-slow" keeps it
// processing; the bytes of an upload containing "mock-put-503" make the first two PUTs answer 503; `script` (below)
// does the rest from a test: queued PUT statuses, a rejected token, an expired access token, a failing refresh.
// It only ever issues tokens that start with "test-", and it records any other Bearer token it is shown.
"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const REFS = path.join(__dirname, "refs", "magnificsub");
const TOOLS = ["account_balance", "creations_request_upload", "creations_finalize_upload", "creations_wait",
    "creations_register_download", "creations_get", "images_upscale", "images_retouch", "images_generate",
    "images_remove_background"];

/** The tool descriptors as the live server lists them (name, title, inputSchema, outputSchema when it has one). */
function toolDefs() {
    return TOOLS.map((name) => {
        const d = JSON.parse(fs.readFileSync(path.join(REFS, name + ".json"), "utf8"));
        const t = { name: d.name, title: d.title, description: d.description || d.title, inputSchema: d.inputSchema };
        if (d.outputSchema) t.outputSchema = d.outputSchema;
        return t;
    });
}

/** Problems of `v` against the JSON schema `s` ([] when it holds). A key the schema does not name is a problem. */
function validate(s, v, at = "arguments") {
    if (!s) return [];
    const out = [];
    const types = s.type == null ? null : [].concat(s.type);
    const is = {
        string: typeof v === "string", integer: Number.isInteger(v), number: typeof v === "number",
        boolean: typeof v === "boolean", array: Array.isArray(v), null: v === null,
        object: !!v && typeof v === "object" && !Array.isArray(v),
    };
    if (types && !types.some((t) => is[t])) return [`${at}: not ${types.join(" or ")}`];
    if (s.enum && !s.enum.includes(v)) out.push(`${at}: ${JSON.stringify(v)} is not one of ${s.enum.join(", ")}`);
    if (typeof v === "number") {
        if (s.minimum != null && v < s.minimum) out.push(`${at}: below ${s.minimum}`);
        if (s.maximum != null && v > s.maximum) out.push(`${at}: above ${s.maximum}`);
    }
    if (Array.isArray(v)) {
        if (s.minItems != null && v.length < s.minItems) out.push(`${at}: fewer than ${s.minItems} items`);
        if (s.maxItems != null && v.length > s.maxItems) out.push(`${at}: more than ${s.maxItems} items`);
        if (s.items) v.forEach((x, i) => out.push(...validate(s.items, x, `${at}[${i}]`)));
    }
    if (is.object && (s.properties || s.required)) {
        for (const k of s.required || []) if (!(k in v)) out.push(`${at}.${k}: required`);
        for (const [k, x] of Object.entries(v)) {
            const p = s.properties && s.properties[k];
            if (!p) { if (s.properties) out.push(`${at}.${k}: unknown`); continue; }
            out.push(...validate(p, x, `${at}.${k}`));
        }
    }
    return out;
}

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A small PNG-looking buffer: the signature, an IHDR of w × h, then a tag (the test reads it back). */
function fakePng(w, h, tag) {
    const b = Buffer.alloc(64 + tag.length, 0);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b);
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    b.write(tag, 33, "latin1");
    return b;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const parts = [];
        req.on("data", (c) => parts.push(c));
        req.on("end", () => resolve(Buffer.concat(parts)));
        req.on("error", reject);
    });
}

function json(res, status, body, headers = {}) {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
}

/**
 * Starts the mock on 127.0.0.1. Returns { base, calls, http, oauth, script, close }:
 *   calls   every tools/call: { tool, args, error? }
 *   http    every request: { method, path, auth (the Authorization header or null), headers (their names) }
 *   oauth   registrations, authorizations, token grants, and `foreignTokens` (any non-test Bearer it was shown)
 *   script  put: [statuses for the next PUTs], reject401: n (refuse n valid MCP requests once each),
 *           expireAccess(): every access token issued so far stops working, refreshFails: true (invalid_grant),
 *           realTokens: true (the next tokens issued do not start with "test-": the client must refuse to use them),
 *           waitMs (how long creations_wait sits on a processing creation, default 20), downloadUrl (overrides
 *           originals[].url), credits (what a creation costs, default 90)
 */
async function start({ port = 0 } = {}) {
    const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
    const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
    const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

    const defs = toolDefs();
    const byName = new Map(defs.map((d) => [d.name, d]));
    const calls = [];
    const httpLog = [];
    const oauth = { registrations: [], authorizations: [], grants: [], foreignTokens: [] };
    const script = { put: [], reject401: 0, refreshFails: false, realTokens: false, waitMs: 20, downloadUrl: null, credits: 90, expireAccess: null };
    const clients = new Map();      // client_id -> registered metadata
    const codes = new Map();        // code -> { client_id, redirect_uri, challenge }
    const access = new Set();       // valid access tokens
    const refresh = new Set();      // valid refresh tokens
    const uploads = new Map();      // uuid -> { path, mimeType, bytes }
    const creations = new Map();    // identifier -> { identifier, tool, status, failureReason, bytes, fileName, trigger }
    let seq = 0;
    let base = "";
    script.expireAccess = () => access.clear();

    function issueTokens() {
        seq++;
        const prefix = script.realTokens ? "eyJreal" : "test";
        const t = { access_token: `${prefix}-at-${seq}-${crypto.randomUUID()}`, refresh_token: `${prefix}-rt-${seq}-${crypto.randomUUID()}`, token_type: "Bearer", expires_in: 300, scope: "openid profile email mcp:custom-audience" };
        access.add(t.access_token);
        refresh.add(t.refresh_token);
        return t;
    }

    const tokenError = (res, error, description) => json(res, 400, { error, error_description: description });

    async function oauthRoute(req, res, u) {
        const realm = base + "/realm";
        if (req.method === "GET" && u.pathname === "/.well-known/oauth-protected-resource") {
            return json(res, 200, { resource: base + "/", authorization_servers: [realm], bearer_methods_supported: ["header"] });
        }
        if (req.method === "GET" && (u.pathname === "/.well-known/oauth-authorization-server/realm" || u.pathname === "/.well-known/oauth-authorization-server")) {
            return json(res, 200, {
                issuer: realm, authorization_endpoint: realm + "/auth", token_endpoint: realm + "/token",
                registration_endpoint: realm + "/register", response_types_supported: ["code"],
                grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
                token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["openid", "profile", "email", "mcp:custom-audience"],
            });
        }
        if (req.method === "POST" && u.pathname === "/realm/register") {
            const meta = JSON.parse((await readBody(req)).toString("utf8") || "{}");
            const uris = Array.isArray(meta.redirect_uris) ? meta.redirect_uris : [];
            if (!uris.length || !uris.every((r) => /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(r))) return json(res, 400, { error: "invalid_redirect_uri" });
            const info = { ...meta, client_id: crypto.randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) };
            clients.set(info.client_id, info);
            oauth.registrations.push(info);
            return json(res, 201, info);
        }
        if (req.method === "GET" && u.pathname === "/realm/auth") {
            const q = Object.fromEntries(u.searchParams);
            const client = clients.get(q.client_id);
            oauth.authorizations.push(q);
            if (!client) return json(res, 400, { error: "invalid_client" });
            if (!client.redirect_uris.includes(q.redirect_uri)) return json(res, 400, { error: "invalid_redirect_uri" });
            if (q.response_type !== "code" || q.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge || "")) return json(res, 400, { error: "invalid_request", error_description: "S256 PKCE required" });
            if (!String(q.scope || "").split(" ").includes("mcp:custom-audience")) return json(res, 400, { error: "invalid_scope" });
            const code = "code-" + crypto.randomUUID();
            codes.set(code, { client_id: q.client_id, redirect_uri: q.redirect_uri, challenge: q.code_challenge });
            const to = new URL(q.redirect_uri);
            to.searchParams.set("code", code);
            if (q.state) to.searchParams.set("state", q.state);
            res.writeHead(302, { location: to.toString() });
            return res.end();
        }
        if (req.method === "POST" && u.pathname === "/realm/token") {
            const p = Object.fromEntries(new URLSearchParams((await readBody(req)).toString("utf8")));
            oauth.grants.push({ grant_type: p.grant_type, client_id: p.client_id });
            if (p.grant_type === "authorization_code") {
                const c = codes.get(p.code);
                codes.delete(p.code);
                if (!c) return tokenError(res, "invalid_grant", "unknown code");
                if (c.client_id !== p.client_id) return tokenError(res, "invalid_grant", "client mismatch");
                if (c.redirect_uri !== p.redirect_uri) return tokenError(res, "invalid_grant", "redirect_uri mismatch");
                if (b64url(crypto.createHash("sha256").update(String(p.code_verifier || "")).digest()) !== c.challenge) return tokenError(res, "invalid_grant", "PKCE verification failed");
                return json(res, 200, issueTokens());
            }
            if (p.grant_type === "refresh_token") {
                if (script.refreshFails || !refresh.has(p.refresh_token) || !clients.has(p.client_id)) return tokenError(res, "invalid_grant", "refresh token refused");
                refresh.delete(p.refresh_token);
                return json(res, 200, issueTokens());
            }
            return tokenError(res, "unsupported_grant_type", String(p.grant_type));
        }
        return false;
    }

    function creationOf(tool, args, trigger) {
        seq++;
        const c = { identifier: `cr-${seq}`, tool, status: "processing", failureReason: null, trigger };
        creations.set(c.identifier, c);
        return c;
    }
    const triggerOf = (...texts) => {
        const t = texts.filter(Boolean).join(" ");
        return /mock-failed/.test(t) ? "failed" : /mock-slow/.test(t) ? "slow" : "";
    };

    /** The tool's answer, or { error } for an isError result. */
    async function runTool(name, args) {
        const known = (id) => creations.get(id);
        switch (name) {
            case "account_balance":
                return { plan: { tier: "magnific", productName: "Mock Plan", isUnlimitedMode: false, unlimitedAppliesHere: false }, credits: { available: 1000, totalPlan: 2000, spent: 1000, hasExtraCredits: false } };
            case "creations_request_upload": {
                const id = crypto.randomUUID();
                const p = `uploads/${id}.${args.mimeType.split("/")[1]}`;
                uploads.set(id, { path: p, mimeType: args.mimeType, bytes: null });
                return { proxyUploadUrl: `${base}/upload/${id}`, path: p, mimeType: args.mimeType, expiresAt: new Date(Date.now() + 3600e3).toISOString() };
            }
            case "creations_finalize_upload": {
                const up = [...uploads.values()].find((x) => x.path === args.path);
                if (!up) return { error: `unknown upload path ${args.path}` };
                if (!up.bytes) return { error: "nothing was uploaded to this path" };
                seq++;
                const c = { identifier: `upl-${seq}`, tool: "upload", status: "completed", bytes: up.bytes, fileName: args.fileName || "", visible: args.visible, trigger: triggerOf(args.fileName) };
                creations.set(c.identifier, c);
                return { identifier: c.identifier, status: "completed", count: 1, errorCount: 0 };
            }
            case "creations_wait": {
                const list = args.identifiers.map(known);
                if (list.some((c) => !c)) return { error: "unknown creation identifier" };
                if (list.some((c) => c.trigger === "slow")) await new Promise((r) => setTimeout(r, Math.min((args.timeoutSeconds ?? 25) * 1000, script.waitMs)));
                const results = list.map((c) => {
                    if (c.status === "processing") {
                        if (c.trigger === "slow") return { identifier: c.identifier, status: "processing", poll_after_seconds: 0, expectTime: 30 };
                        c.status = c.trigger === "failed" ? "failed" : "completed";
                        if (c.status === "failed") c.failureReason = "mock: the model refused the picture";
                    }
                    if (c.status === "failed") return { identifier: c.identifier, status: "failed", failureReason: c.failureReason };
                    return { identifier: c.identifier, status: c.status, failureReason: null, results: { url: `${base}/asset/${c.identifier}.jpg`, thumbnailUrl: `${base}/asset/${c.identifier}.jpg` } };
                });
                return { results, allTerminal: results.every((r) => r.status !== "processing") };
            }
            case "creations_register_download": {
                const list = args.identifiers.map(known);
                if (list.some((c) => !c)) return { error: "unknown creation identifier" };
                return { recorded: list.length, skipped: 0, originals: list.map((c) => ({ identifier: c.identifier, url: script.downloadUrl || `${base}/asset/${c.identifier}.png` })) };
            }
            case "creations_get": {
                const c = known(args.creationIdentifier);
                if (!c) return { error: "unknown creation identifier" };
                return { text: `Creation ${c.identifier}\nstatus: ${c.status}\nurl: ${base}/asset/${c.identifier}.jpg` };
            }
            case "images_upscale":
            case "images_retouch":
            case "images_generate":
            case "images_remove_background": {
                const src = args.creationIdentifier;
                if (src && !known(src)) return { error: `creation ${src} not found` };
                if (args.maskCreationIdentifier && !known(args.maskCreationIdentifier)) return { error: `creation ${args.maskCreationIdentifier} not found` };
                if (name === "images_retouch" && (args.mode || "replace") === "replace" && !args.prompt) return { error: "prompt is required for replace" };
                const c = creationOf(name, args, triggerOf(args.prompt, src && known(src).fileName));
                return { creation: { identifier: c.identifier, status: "processing", expectTime: 20, tool: name, credits: script.credits }, instruction: "Call creations_wait with the identifier." };
            }
        }
        return { error: `unknown tool ${name}` };
    }

    function mcpServer() {
        const server = new Server({ name: "pikaso-mock", version: "0" }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: defs }));
        server.setRequestHandler(CallToolRequestSchema, async (req) => {
            const name = req.params.name;
            const args = req.params.arguments || {};
            const def = byName.get(name);
            const record = { tool: name, args };
            calls.push(record);
            const problems = def ? validate(def.inputSchema, args) : [`unknown tool ${name}`];
            if (problems.length) {
                record.error = problems.join("; ");
                return { isError: true, content: [{ type: "text", text: `Invalid arguments for ${name}: ${record.error}` }] };
            }
            const out = await runTool(name, args);
            if (out.error) {
                record.error = out.error;
                return { isError: true, content: [{ type: "text", text: out.error }] };
            }
            if (out.text != null) return { content: [{ type: "text", text: out.text }] };
            return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
        });
        return server;
    }

    async function mcpRoute(req, res) {
        if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); return res.end(); }
        const auth = String(req.headers.authorization || "");
        const token = /^Bearer (.+)$/.exec(auth);
        const unauthorized = (why) => {
            res.writeHead(401, { "content-type": "application/json", "www-authenticate": `Bearer error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource"` });
            res.end(JSON.stringify({ error: "invalid_token", error_description: why }));
        };
        if (token && !/^test-/.test(token[1])) oauth.foreignTokens.push(token[1]);
        if (!token || !access.has(token[1])) return unauthorized(token ? "token refused" : "no token");
        if (script.reject401 > 0) { script.reject401--; access.delete(token[1]); return unauthorized("token revoked (scripted)"); }
        const body = JSON.parse((await readBody(req)).toString("utf8"));
        const server = mcpServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => { transport.close(); server.close(); });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
    }

    const srv = http.createServer(async (req, res) => {
        const u = new URL(req.url, base);
        httpLog.push({ method: req.method, path: u.pathname, auth: req.headers.authorization || null, headers: Object.keys(req.headers) });
        try {
            if (u.pathname.startsWith("/.well-known/") || u.pathname.startsWith("/realm/")) {
                if ((await oauthRoute(req, res, u)) === false) json(res, 404, { error: "not found" });
                return;
            }
            if (req.method === "PUT" && u.pathname.startsWith("/upload/")) {
                const up = uploads.get(u.pathname.slice("/upload/".length));
                const bytes = await readBody(req);
                if (!up) return json(res, 404, { error: "unknown upload" });
                if (bytes.includes("mock-put-503") && !up.tagged) { up.tagged = true; script.put.unshift(503, 503); }
                const status = script.put.length ? script.put.shift() : 200;
                if (status !== 200) return json(res, status, { error: `scripted ${status}` });
                up.bytes = bytes;
                res.writeHead(200);
                return res.end();
            }
            if (req.method === "GET" && u.pathname.startsWith("/asset/")) {
                const id = u.pathname.slice("/asset/".length).replace(/\.\w+$/, "");
                const c = creations.get(id);
                if (!c) return json(res, 404, { error: "unknown asset" });
                res.writeHead(200, { "content-type": "image/png" });
                return res.end(c.bytes || fakePng(64, 48, "RESULT " + id));
            }
            if (u.pathname === "/") return await mcpRoute(req, res);
            json(res, 404, { error: "not found" });
        } catch (err) {
            if (!res.headersSent) json(res, 500, { error: String(err && err.message || err) });
            else res.end();
        }
    });
    await new Promise((resolve) => srv.listen(port, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${srv.address().port}`;
    return {
        base, calls, http: httpLog, oauth, script, creations,
        close: () => new Promise((resolve) => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(() => resolve()); }),
    };
}

module.exports = { start, validate, toolDefs };

if (require.main === module) {
    const i = process.argv.indexOf("--port");
    const port = i > 0 ? Number(process.argv[i + 1]) : 0;
    start({ port }).then((m) => console.log(`magnificsub mock on ${m.base} (settings.magnificsub.base)`));
}
