# macOS build (B3 of `docs/PLAN_0_1_24.md`, done on a Mac)

Written 2026-09-30 on an Apple Silicon Mac (macOS 26.2) with a Developer ID. B3 was planned "without the developer
account and without a Mac"; both exist now, so the build is signed, notarized and run here, not only built. The work
is meant to go upstream as one pull request, so everything in the repository has to work for a maintainer who has
**no** Apple account: CI builds an unsigned macOS artifact without secrets and signs and notarizes only when the
secrets are set.

## Decisions (the user, 2026-09-30)

- Scope: all of B3 (config, darwin code paths, CI job, docs) plus a local build that runs and passes the gates here.
- Signing: Developer ID Application + notarization for the local release build. The identity and the notary profile
  live in this Mac's keychain (`xcrun notarytool` profile `scumble-notary`) and never enter the repository.
- Architecture: **arm64 only** (Apple Silicon; the ONNX runtime ships `darwin/arm64`).
- Git: branch `macos-build` on the fork `claussteinmassl/scumble`, a commit per step, pushed; at the end a pull
  request to `DenRakEiw/scumble` on the user's word.
- **Windows and Linux must not change behaviour.** Every change to shared code is either behind
  `process.platform === "darwin"` or provably inert on the other platforms (e.g. `e.ctrlKey || e.metaKey`, the
  pattern the editor already uses at its main key handler). Checked by CI (both jobs) and by a gate run in the
  Windows VM on `main` and on the branch.

## What changes

### 1. Packaging (`package.json`, `build/`)
- `build.mac`: `target` `dmg` and `zip` for `arm64`, `category` `public.app-category.graphics-design`,
  `hardenedRuntime: true`, `entitlements` / `entitlementsInherit` `build/entitlements.mac.plist` (allow-jit,
  allow-unsigned-executable-memory), `gatekeeperAssess: false`, `artifactName` `Scumble-${version}-${arch}.${ext}`,
  `icon` `build/icon.icns`, and a `files` list that leaves out the win32 and linux ONNX binaries (as the win and linux
  lists leave out darwin).
- `build/icon.icns` from the 1024 px `build/icon.png` (committed; `fileAssociations` finds it for the document icon).
- Scripts: `dist:mac` (`electron-builder --mac`). Notarization is on when the environment has credentials
  (`APPLE_KEYCHAIN_PROFILE` locally, `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` in CI) and skipped
  otherwise; signing uses the keychain's Developer ID locally, `CSC_LINK` / `CSC_KEY_PASSWORD` in CI, and is off when
  neither exists.

### 2. Main process (`electron/main/`)
- `window-all-closed`: on darwin the app stays alive (the macOS convention); `activate` shows or recreates the
  window. Windows and Linux still quit.
- `open-file` (darwin): a `.scumble` file opened from Finder or dropped on the Dock icon goes to the same document
  queue as argv / `second-instance`; registered before `ready`, because macOS sends it during launch.
- Menu: on darwin an **Edit** menu with the standard roles (undo/redo/cut/copy/paste/select all), without which
  Cmd+C/V/X/A do nothing in text fields. Windows and Linux menus stay as they are.
- `local.js`: on darwin the socket goes under `os.tmpdir()` with the profile hash in its name (sun_path is 104 bytes;
  `userData` paths in gate profiles exceed it).
- Updater: off on darwin (state like the Store's: "updates by download"), because no release carries
  `latest-mac.yml` yet; turning it on is one line once releases carry the mac zip.
- MCP: the launcher's error text names the macOS binary too; the registration line already resolves
  `Contents/MacOS/Scumble` and `Contents/Resources/app.asar`.

### 3. Renderer
- Mouse and drag modifiers that check `e.ctrlKey` alone (12 sites in `inpaint_canvas.js` and `prompt_field.js`) accept
  Cmd too, via one helper, as the key handlers already do. On macOS Ctrl+click is the context menu.
- Shortcut labels: "Ctrl+" in tooltips, menus of the renderer and the help reads "⌘" on darwin, through one helper
  applied where the labels are built (no rewrite of every string literal).

### 4. CI (`.github/workflows/build.yml`)
- A `macos` job on `macos-latest` (arm64): `npm ci`, `electron-builder --mac --arm64`. Without secrets:
  `CSC_IDENTITY_AUTO_DISCOVERY=false`, unsigned, uploaded as a workflow artifact. With the five secrets: signed,
  notarized, and on a tag attached to the draft release. The Windows and Linux jobs are untouched.

### 5. Test tooling (`tools/`)
- `run_gates.sh`: the Electron binary per platform, `timeout` or `gtimeout`, `SCUMBLE_GATES` default per platform,
  the ComfyUI test picture copied only when it exists; `--exe` accepts the `.app` bundle.
- The Python tests that pick `electron.exe` / `electron` pick `Electron.app/Contents/MacOS/Electron` on darwin, and the
  packaged launcher path `Contents/Resources/app.asar`. Win32-only tests (`quit`, `document`) say "skipped on this
  platform" instead of crashing.
- `platform_test.js`: the mac file list leaves out the other platforms' ONNX binaries.

### 6. Docs
- `docs/CODE_SIGNING_POLICY.md` and `docs/RELEASING.md`: the macOS paragraph (Developer ID, notarization, the secrets).
- `README.md`: Install (macOS).
- `docs/BUGS.md`: what was not checked (Intel Macs, the CoreML provider's speed, the Store flows).
- `CHANGELOG.md`: nothing (a release is the maintainer's word; the PR says what to add).

## How it is checked

1. Lint and types (`npm run lint`, `npm run types`), `node tools/platform_test.js`.
2. The dev app on this Mac: `bash tools/run_gates.sh mac-dev --offline --tiles on|off <gates>` with the gates that
   need no ComfyUI and no key (editor, composite, commands, shape, size, generate, transparent, recipes, llm,
   platform, mcp, film, toapis, openrouter, ark, comfyrouter, oxen, magnific, assistant).
3. The notarized package: `spctl -a -vv -t exec dist/mac-arm64/Scumble.app`, `xcrun stapler validate` on the dmg,
   `codesign --verify --deep --strict`, then the same gates with `--exe dist/mac-arm64/Scumble.app`.
4. By hand on this Mac: open a `.scumble` from Finder, Cmd shortcuts, Cmd+click, the window closed and reopened
   from the Dock, the ONNX helpers (CoreML, CPU fallback).
5. Windows: CI job green; in the Windows VM the installer from the branch and from `main`, the same gate subset
   against both, the results compared.
6. Linux: CI job green (build); `platform_test.js` covers its file list.

## Not in scope
- An Intel or universal build, the Mac App Store, a GitHub release of the fork, the updater on macOS.
