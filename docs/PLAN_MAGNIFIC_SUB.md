# Magnific (subscription): Magnific through its MCP server

Written 2026-10-01. Decided with the user the same day ("ja, bitte bau das als möglichen provider mit ein"; the
design approved with "ok, bitte umsetzen").

## Why

The Magnific provider of 0.1.24 (`electron/main/providers/magnific.js`) speaks Magnific's REST API with an API key,
and every call costs API credits. Magnific ended pay-per-use for the API on 2026-06-30 (a Business plan with
prepaid credits since). Its MCP server (`https://mcp.magnific.com`) runs on the credits of the user's web plan
(Premium, Premium+, Pro), the same balance as the web app, with an OAuth sign-in instead of a key. Magnific's own
plugins (ComfyUI 0.8.0, the editor plugins) use the same server. A second provider, **Magnific (subscription)**,
lets a subscriber run Magnific from Scumble without an API plan.

## What a spike established (2026-10-01, a throwaway script, one live upscale)

- **Sign-in**: the OAuth realm `https://auth.magnific.com/realms/mcp` (Keycloak) offers dynamic client registration
  (`/clients-registrations/openid-connect`) and PKCE (S256). A public client registered with a loopback redirect
  (`http://127.0.0.1:<port>/callback`), scope `openid profile email mcp:custom-audience`, signs in through the
  browser; the MCP SDK's `OAuthClientProvider` and `StreamableHTTPClientTransport` (1.30, already a dependency) do
  the flow and the refresh. Magnific's plugins use the device grant with Magnific's own client id
  (`magnific-editor-plugins`) and an allowlisted `X-Pikaso-Client` header; **Scumble uses neither**: it registers
  its own client and does not present itself as Magnific's plugin.
- **Server**: `pikaso` 1.0.0, 187 tools. The schemas used here are copied to `tools/refs/magnificsub/` (and the
  three catalogs as `catalog_*.txt`).
- **Pipeline** (all measured): `creations_request_upload {mimeType}` -> `{proxyUploadUrl, path, expiresAt}`; HTTP PUT
  of the bytes (200); `creations_finalize_upload {path, fileName, visible: false}` -> `{identifier}`; the tool
  (`images_upscale {creationIdentifier, mode, scale}` -> `{creation: {identifier, status, credits, ...}}`);
  `creations_wait {identifiers, timeoutSeconds <= 25}` -> `{status: "completed", results: {url, thumbnailUrl}}`;
  `creations_register_download {identifiers, tool}` -> `{originals: [{identifier, url}]}`, the untouched PNG (the
  `results.url` is a JPEG re-encode). Some tools answer text, not JSON (`creations_get`): read `structuredContent`
  first, and parse text only where a tool is known to answer it.
- **Cost**: a 512 px creative 2x upscale cost 90 credits (`simulate_cost` estimated the S tier at 90);
  `account_balance` and `simulate_cost` never charge.
- **Limits** (from Magnific's plugin): `images_retouch` renders inside the HTTP request and dies at 30 s on large
  pictures, so image and mask go at most 2048 px on the long edge, on a multiple of 8; an upload is at most 25 MB;
  `creations_wait` polls at most 25 s per call.

## Decisions

- **A provider of its own**, id `magnificsub`, label "Magnific (subscription)", next to `magnific` (which stays as
  it is). Three recipes of its own, not variants on the REST recipes: the MCP's modes and models do not map onto the
  REST routes.
- **Sign-in instead of a key**: authorization code + PKCE + dynamic registration, the redirect to a loopback server
  of the main process on an ephemeral port of `127.0.0.1` (registered per sign-in), the browser opened with
  `shell.openExternal`. The client information and the tokens are stored with `keys.js` (safeStorage) under the
  name `magnificsub` as one JSON value; nothing in `settings.json`. Sign out forgets them.
- **The host is fixed** to `https://mcp.magnific.com` (and the realm the server names); `settings.magnificsub.base`
  may name a loopback mock for the tests only, with the same rule as `magnific.js` (`testBase`): a mock only on
  `http://127.0.0.1:<port>`, and then only with a test credential.
- **Credits as elsewhere in the app**: no estimate before a run (no provider has one); the Settings row gets
  "check balance" (`balance(ctx)` -> `account_balance`), and the credits a run used (the tool's `credits`) go into
  the result's `info` and its status line, as Comfy Router does with `x-comfy-credits-used`.
- **Uploads are not shown in the user's Magnific library** (`visible: false`); the results are Magnific creations
  and do show there (the server keeps them; nothing Scumble can change).
- Not in this step: outpainting (`images_expand` takes fixed aspect ratios, not margins per side), video, audio, a
  catalog fetched at run time.

## What changes

### 1. Main process
- `electron/main/providers/magnificsub_auth.js`: the `OAuthClientProvider` over `keys.js`, the loopback server (one
  request to `/callback`, a page saying the window can be closed, a 10-minute timeout, closed afterwards), `signIn()`,
  `signOut()`, `status()` -> `{ signedIn, account? }`.
- `electron/main/providers/magnificsub.js`: the adapter. One lazily connected MCP client (reconnect once on a
  transport error; a 401 that the refresh cannot fix -> "Sign in to Magnific again (Settings › API providers)").
  `upload(bytes, mime)` (25 MB check, PUT retried up to 3 times on 5xx or a network error), `waitFor(id)`
  (`creations_wait` until completed or failed; 15 min for retouch and generate, 50 min for upscale), `download(id)`
  (`creations_register_download` -> the original's URL, https only, fetched without credentials). Verbs:
  - `upscale(req)`: `images_upscale { mode, scale, ...settings }`; the factor of the request decides `scale`
    ("2x" ... "16x"), modes that allow 2x only refuse other factors before anything is uploaded.
  - `edit(req)` for `kind: "fill"`: image and mask (white = change, the provider contract's mask) scaled together
    to at most 2048 px, a multiple of 8, uploaded, `images_retouch { mode, prompt, model, resolution? }`; `erase`
    needs no prompt, `replace` refuses an empty one.
  - `generate(req)` (`kind: "text"`): `images_generate { prompt, model, aspectRatio, references? }`; the reference
    layers uploaded and passed in the schema's reference form; the first result.
  - `cutout(image)`: `images_remove_background`, the result's alpha as the mask.
  - `balance()`: `account_balance` -> "N credits (plan)".
  Every verb returns the contract's `{ bytes, mime, width, height, info }` with `info.credits`.
- `providers/index.js`: an optional adapter hook `ready()` beside `needsKey` (for `magnificsub`: signed in), used
  by `edit()` instead of the key check when present; `describeAll` reports `auth: "oauth"` and `signedIn` for such a
  provider. IPC `providers:signIn|signOut|status` (and a cutout call for the helper backend).
- `recipes.js`: `magnificsub` in `TEXT_PROVIDERS`.

### 2. Renderer
- Settings › API providers: for an `auth: "oauth"` provider the row shows **Sign in** (or **Sign out** and the
  account), "check balance" when signed in, and the status ("signed in as …" / "not signed in"); no key input.
  `providerKeyState` treats `signedIn` as the key.
- The cutout backends (`host.cutoutBackends`) list "Magnific (subscription)" while signed in.

### 3. Recipes (curated, static)
- `recipes/magnificsub_upscale.json` (task upscale): Mode (Creative, Precision sublime, Precision photo, Precision
  photo denoiser, Precision v1), factor 2/4/8/16 (2 only for the photo, denoiser and v1 modes), the Creative
  settings (preset, optimised for, engine, creativity, resemblance, HDR, fractality) and the Precision ones
  (sharpness, grain, ultra detail, preset), the prompt for Creative.
- `recipes/magnificsub_retouch.json` (input fill): Mode (replace, erase); Model: Auto, Classic, Erase, Google Nano
  Banana Pro (`retouch-imagen-nano-banana-2`), Google Nano Banana 2 (`retouch-imagen-nano-banana-2-flash`);
  Resolution where the model has one. Models the account's catalog lists are offered; beta or private ones are marked "(beta)" and confirmed by a live run.
- `recipes/magnificsub_generate.json` (Generate new, with reference layers): Model: Auto, Flux.2 Pro, Flux.2 Max,
  GPT 2, GPT 2.5, Google Nano Banana Pro, Google Nano Banana 2, Seedream 5 Pro, Ideogram 4.5, Mystic 2.5, Recraft
  V4.1, Qwen Image 3.0 Pro; aspect ratio from the model's list.
- Each recipe's description says it runs on the Magnific plan's credits and needs the sign-in.

### 4. Tests
- `tools/magnificsub_test.js` (plain Node): a mock MCP server (the SDK's server over Streamable HTTP on a loopback
  port, with the subset of tools and their schemas from `tools/refs/magnificsub/`, a fake OAuth that issues test
  tokens) and the adapter against it: every verb's arguments against the schemas, the upload (PUT, finalize, the
  25 MB refusal, the retry), the wait (completed, failed, timeout), the original's download, the 2048 / multiple-of-8
  scaling of image and mask together, the refusals (no prompt for replace, a factor the mode does not allow), the
  token refresh and the "sign in again" error, the host rule (no real token to a mock, no test token to Magnific).
- `tools/magnificsub_test.py` (a gate, `magnificsub`): the Settings row in the app (signed out, signed in with the
  mock's test sign-in), the three recipes listed and selectable, one run of each verb against the mock through the
  window. `--offline`.
- Live, once, with the user's account, after the mock tests: one upscale, one retouch, one generate, one cutout,
  each on a small picture (the cost estimated with `simulate_cost` first and reported).

### 5. Docs
- `docs/RECIPES.md` (a section "Magnific (subscription)"), `docs/MANUAL.md` (the sign-in and the three recipes,
  short), `docs/BUGS.md` (what was not checked), `CHANGELOG.md` untouched (a release is the maintainer's word).

## Not in scope
- Outpainting, video, audio, 3D, stock; a run-time model catalog; an estimate or a confirmation before a run.

## Results (2026-10-01)

Built on the branch `magnific-subscription` in four tasks: the sign-in and the MCP session with a mock (Task 1), the
verbs, the registry hook and the recipes (Task 2, with a fix round), the Settings row, the IPC, the cutout backend
and the gate (Task 3), and the docs (Task 4), then a live run with the user's account (Task 5).

### The live run (2026-10-01, a Premium+ plan, macOS)
- The sign-in through the Settings row worked; the browser comes to the front and Scumble comes back after it
  (checked by the user after the fix below).
- Upscale, Creative 2x, 320 x 240 -> 640 x 480 in 23 s: 90 credits. Retouch (replace, Auto), a 512 x 512 crop: 19 s,
  10 credits. Cutout of the retouch layer: 8 s, 3 credits. Generate new (Auto, 1:1): 1536 x 1536 in 41 s, 75 credits.
- Two faults only the real service showed, both fixed and tested against the mock since:
  `creations_register_download` names an original only for a creation whose `url` is a re-encode (an upscale), so a
  generated picture is fetched from the finished creation's `results.url`; and a model behind Auto (Seedream 5 Pro)
  refuses seeds above 2147483647, so a larger Scumble seed is sent as `seed % 2147483648`. The first, failed generate
  still cost 75 credits (the picture stayed in the Magnific library).
- In all 253 credits of the plan were spent on the run.

### What was built, as designed
- `magnificsub_auth.js` (OAuth with PKCE and dynamic registration, the loopback redirect, the host rule, a sign-in that
  keeps the old one on failure), `magnificsub.js` (the session: upload, wait, download, the verbs, balance),
  `providers/index.js` (the `ready()` hook, `auth: "oauth"` rows, IPC `providers:status|signIn|cancelSignIn|signOut|cutout`).
- The Settings row (Sign in / Cancel / Sign out, "check balance"), the status line's credits, the cutout backend
  (only while signed in, listed last, used only when picked).

### Deviations from the plan above
- **Four recipes, not three.** Upscale is split into **Magnific Creative (subscription)** and **Magnific Precision
  (subscription)**, because a recipe variant has eight setting slots and the twelve upscale controls did not fit one.
  With Retouch and Generate that makes four (`magnificsub_creative|precision|retouch|generate.json`).
- **The generate list offers the models the account's catalog lists**, beta or private ones marked "(beta)": GPT 2.5,
  Ideogram 4.5 and Qwen Image 3.0 Pro. The catalog flags are pinned in a test. Retouch's list has no beta entry.
- **Retouch crops are padded to multiples of 8** (scaled first with the aspect kept when larger than 2048) and the
  answer is cut back to the crop, so the pixels stay 1:1 within 2048 (`magnificsub_pictures.js`).
- **The credits used show in the status line for this provider only** (not for Comfy Router or ToAPIs, whose lines
  stay as they were).
- **The cutout backend appears only while signed in and is used only when picked in the cutout list, never as the default or a fallback** (`paid` backends are listed last).
- The `images_generate` field is `mode`, not `model`; `count: 1` and the seed go along. Mystic 2.5 and Recraft V4.1
  take reference layers as style pictures. The tables and the picture helpers are in `magnificsub_tables.js` and
  `magnificsub_pictures.js`. A creation tool that loses its connection is not sent again (no double charge).

### Tests that exist
- `node tools/magnificsub_test.js` (plain Node, 171 checks) against `tools/magnificsub_mock.js`: sign-in, session,
  every verb's arguments against the copied schemas, upload retries, wait, host rule, retouch geometry, registry hook,
  a dropped connection (a paid tool sent once, a read sent again), upload and download redirects, the download cap.
- `node tools/refs_layout_test.js` drives the adapter too: its capture plays the MCP server, so the retouch and
  generate layouts are pinned against the tool arguments the builders send.
- The gate `magnificsub` (`tools/magnificsub_test.py`, `--offline`): the Settings row signed out, in and out, the four
  recipes, one run of each verb through the window with the credits in the status line, the cutout list. Also
  `tools/recipes_test.js`, `tools/upscale_test.js` and the `magnific` gate (its row filter narrowed to leave the new row out).
- Not covered: the real realm, a real run, Windows and Linux redirects (`docs/BUGS.md`).

