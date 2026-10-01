"""Magnific (subscription) end to end without an account: the adapter in plain Node, then the app against
tools/magnificsub_mock.js.

No ComfyUI and no Magnific account. The first step runs tools/magnificsub_test.js (the sign-in, the session, the verbs
and providers/index.js against the mock). The rest drives the running app over CDP with settings.magnificsub.base
pointed at a mock this script starts on 127.0.0.1 (`node tools/magnificsub_mock.js --app`: decodable pictures and
GET /__mock/calls). With the base on the mock, the main process opens no browser for a sign-in: the authorization URL
waits in providers:status, and this script GETs it (the mock's 302 lands on the app's loopback redirect).

- the rows signed out: every provider of main's providers:list (less those that share a key) has its row; every row but
  Magnific (subscription) has its key input, Save and Clear; that one reads "not signed in" with Sign in and no input,
  no key hint, no "check balance"; the four recipes' provider options read "(not signed in)";
- Sign in from the row: "waiting for the browser…" with Cancel, then "signed in (Mock Plan)" with Sign out and "check
  balance", which answers "1000 credits (Mock Plan)"; the options lose "(not signed in)"; the cutout list offers
  Magnific (subscription), last, and does not select it; the other rows are the same as signed out (and after Sign out);
- a cutout click with nothing picked (no free backend in a gate profile) sends nothing and says to pick it;
- one run each through the window: a Creative upscale of a small picture (the document twice as large), a retouch of a
  selection (a result layer), a cutout of that layer (its mask about half kept), Generate new (a 1024 x 1024 base);
  each status line names the 90 credits, and the mock saw each tool once with valid arguments;
- Sign out from the row: "not signed in" again, keys no longer hold magnificsub, the cutout list drops it.

It refuses a profile that holds a magnificsub sign-in (a real one is never overwritten). The magnificsub setting, the
remembered providers and the selected recipe are put back at the end whatever happens.

    python tools/magnificsub_test.py

Start the app first (with --no-comfy: a result is uploaded into the mirror and would be forwarded to a connected
ComfyUI): bash tools/run_gates.sh <label> --offline --tiles on magnificsub
"""
import asyncio
import json
import os
import subprocess
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE_TEST = os.path.join(ROOT, "tools", "magnificsub_test.js")
MOCK = os.path.join(ROOT, "tools", "magnificsub_mock.js")
LABEL = "Magnific (subscription)"
RECIPES = ["magnificsub_creative", "magnificsub_precision", "magnificsub_retouch", "magnificsub_generate"]
CREDITS = "(90 credits)"


class Stop(Exception):
    """A step the rest stands on failed (its line is printed already)."""


PRE = """(async () => {
    const commands = window.__msCmds.commands, host = window.__msHost, shell = window.__msShell;
    const run = (n, a) => commands.run(n, a || {});
    const ednow = (id) => host.editors().find((e) => e.node.id === id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms) => { const t = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > t) return null; await wait(50); } };
    const subRow = () => document.querySelector('.shell-provider[data-id="magnificsub"]');
    const rows = () => Array.from(document.querySelectorAll("#set-providers .shell-provider")).map((r) => ({
        label: r.firstElementChild ? r.firstElementChild.textContent : "",
        input: !!r.querySelector('input[type="password"]'),
        buttons: Array.from(r.querySelectorAll("button")).map((b) => b.textContent),
        state: (r.querySelector(".shell-key-state") || {}).textContent || "",
    }));
    const others = () => JSON.stringify(rows().filter((r) => r.label !== __LABEL__));
    const sameOthers = (when) => { const now = others(); if (now !== window.__ms.otherRows) throw new Error("the other provider rows changed " + when + ": " + now.slice(0, 300) + " against " + window.__ms.otherRows.slice(0, 300)); };
    const optionOf = (id) => { const s = document.querySelector('.shell-recipe[data-id="' + id + '"] select'); const o = s && Array.from(s.options).find((x) => x.value === "magnificsub"); return o ? o.textContent : null; };
    const openSettings = async () => { if (!document.getElementById("shell-settings").open) { await shell.openSettings(); await wait(300); } };
    const closeSettings = () => { const d = document.getElementById("shell-settings"); if (d.open) d.close(); };
    %s
})()"""

SETUP = """
window.__ms = null;
window.__msDoc = null;
const had = await window.scumble.keys.list();
if ((had.keys || {}).magnificsub && had.keys.magnificsub.set) throw new Error("this profile holds a Magnific (subscription) sign-in; the test never overwrites one");
const s = await window.scumble.settings.get();
window.__ms = { saved: { magnificsub: s.magnificsub, recipeProviders: s.recipeProviders || {}, recipe: s.recipe, recipeByMode: s.recipeByMode }, recipe: host.recipe };
await window.scumble.settings.set({ magnificsub: { base: __MOCK__ } });
const d = await run("new_document");
window.__msDoc = d.id;
const ed = ednow(d.id);
host.shell.activate(ed);
await run("new_canvas", { doc: d.id, width: 160, height: 120, color: "#708090" });
return { size: [ed.width, ed.height], recipe: host.recipe && host.recipe.id };
"""

SIGNED_OUT = """
const list = await window.scumble.providers.list();
const want = list.filter((p) => !p.sharesKey).map((p) => p.label);
const keyRows = list.filter((p) => !p.sharesKey && p.id !== "magnificsub").map((p) => p.label);
await openSettings();
const got = rows();
if (JSON.stringify(got.map((r) => r.label)) !== JSON.stringify(want)) throw new Error("the rows " + got.map((r) => r.label).join(", ") + " against main's list " + want.join(", "));
const bad = got.filter((r) => r.label !== __LABEL__ && (!r.input || JSON.stringify(r.buttons) !== '["Save","Clear"]'));
if (bad.length) throw new Error("key rows without their input or buttons: " + JSON.stringify(bad));
window.__ms.otherRows = others();   // compared again signed in and after Sign out
const sub = got.find((r) => r.label === __LABEL__);
if (!sub || sub.input || JSON.stringify(sub.buttons) !== '["Sign in"]' || sub.state !== "not signed in") throw new Error("the sign-in row signed out: " + JSON.stringify(sub));
const options = {};
for (const id of __RECIPES__) {
    options[id] = optionOf(id);
    if (options[id] !== __LABEL__ + " (not signed in)") throw new Error(id + ": the option reads " + options[id]);
}
const meta = (document.querySelector('.shell-recipe[data-id="magnificsub_creative"] .shell-recipe-meta') || {}).textContent || "";
if (!/not signed in/.test(meta)) throw new Error("the recipe row's meta: " + meta);
const status = await window.scumble.providers.status("magnificsub");
if (status.signedIn || status.pending) throw new Error("providers:status " + JSON.stringify(status));
return { rows: got.length, keyRows: keyRows.length, row: sub, option: options.magnificsub_creative, meta };
"""

SIGN_IN_START = """
await openSettings();
const btn = Array.from(subRow().querySelectorAll("button")).find((b) => b.textContent === "Sign in");
if (!btn) throw new Error("no Sign in button");
btn.click();
const st = await until(async () => { const s = await window.scumble.providers.status("magnificsub"); return s.url ? s : null; }, 10000);
if (!st) throw new Error("no authorization URL in providers:status");
const row = await until(() => { const r = rows().find((x) => x.label === __LABEL__); return r && /waiting for the browser/.test(r.state) ? r : null; }, 5000);
if (!row || JSON.stringify(row.buttons) !== '["Cancel"]' || row.input) throw new Error("the row while waiting: " + JSON.stringify(rows().find((x) => x.label === __LABEL__)));
return { url: st.url, pending: st.pending, row };
"""

SIGNED_IN = """
const row = await until(() => { const r = rows().find((x) => x.label === __LABEL__); return r && /^signed in/.test(r.state) ? r : null; }, 15000);
if (!row) throw new Error("the row never read signed in: " + JSON.stringify(rows().find((x) => x.label === __LABEL__)));
if (!/^signed in \\(Mock Plan\\)/.test(row.state) || JSON.stringify(row.buttons) !== '["Sign out"]' || row.input || !/check balance/.test(row.state)) throw new Error("the signed-in row: " + JSON.stringify(row));
const k = await window.scumble.keys.list();
const hint = (k.keys || {}).magnificsub && k.keys.magnificsub.hint;
if (hint && row.state.includes(hint)) throw new Error("the row shows keys.js's hint");
const link = subRow().querySelector(".shell-balance");
link.click();
const out = subRow().querySelector(".shell-balance-out");
const balance = await until(() => out.textContent && !/checking/.test(out.textContent) ? out.textContent.trim() : null, 15000);
if (balance !== "1000 credits (Mock Plan)") throw new Error("check balance answered " + balance);
sameOthers("after the sign-in");
const options = {};
for (const id of __RECIPES__) {
    options[id] = optionOf(id);
    if (options[id] !== __LABEL__) throw new Error(id + ": the option reads " + options[id]);
}
closeSettings();
const ed = ednow(window.__msDoc);
const backends = host.cutoutBackends().map((b) => b.id);
const sel = ed.cutoutSel ? Array.from(ed.cutoutSel.options).map((o) => o.value) : null;
if (!backends.includes("magnificsub") || (sel && sel[sel.length - 1] !== "magnificsub")) throw new Error("the cutout backends: " + JSON.stringify({ backends, sel }));
// never the default: with no free backend in this profile the list shows the "no model" entry until it is picked
if (ed.cutoutSel && ed.cutoutSel.value !== "") throw new Error("the cutout list defaults to " + ed.cutoutSel.value);
return { row: row.state, balance, options: options.magnificsub_creative, cutout: sel || backends };
"""

UPSCALE = """
const ed = ednow(window.__msDoc);
host.shell.activate(ed);
await run("new_canvas", { doc: window.__msDoc, width: 160, height: 120, color: "#708090" });
await run("select_recipe", { id: "magnificsub_creative", provider: "magnificsub" });
if (!host.recipe || host.recipe.provider !== "magnificsub") throw new Error("select_recipe gave " + JSON.stringify(host.recipe && [host.recipe.id, host.recipe.provider]));
await run("set_prompt", { doc: window.__msDoc, text: "crisp detail" });
const out = await run("upscale", { doc: window.__msDoc, scope: "document", factor: 2, timeout: 120 });
return { size: [ed.width, ed.height], info: out.info, status: ed.status };
"""

RETOUCH = """
const ed = ednow(window.__msDoc);
host.shell.activate(ed);
await run("new_canvas", { doc: window.__msDoc, width: 400, height: 300, color: "#708090" });
await run("select_recipe", { id: "magnificsub_retouch", provider: "magnificsub" });
await run("select_rect", { doc: window.__msDoc, x: 120, y: 80, width: 160, height: 120 });
await run("set_prompt", { doc: window.__msDoc, text: "a red hat" });
const before = new Set(ed.layers.map((l) => l.id));
const out = await run("generate", { doc: window.__msDoc, timeout: 120 });
const layer = ed.layers.find((l) => !before.has(l.id));
return { layer: layer ? { id: layer.id, box: [layer.x, layer.y, layer.w, layer.h] } : null, status: ed.status, sent: out && out.prompt_sent };
"""

CUTOUT = """
const ed = ednow(window.__msDoc);
host.shell.activate(ed);
const layer = ed.layers.find((l) => l.id === __LAYER__);
if (!layer) throw new Error("the retouch's layer is gone");
// picked in the list, as a person picks it
ed.cutoutSel.value = "magnificsub";
ed.cutoutSel.dispatchEvent(new Event("change"));
if (ed.cutoutSettings.backend !== "magnificsub") throw new Error("the cutout select did not take magnificsub");
await ed.cutoutLayer(layer);
await until(() => !ed.cutoutPending, 60000);
await wait(300);   // the credits go on after applyCutoutImage's own line
const m = /(\\d+)% kept/.exec(ed.status);
return { mask: !!layer.maskPx, kept: m ? +m[1] : null, status: ed.status };
"""

NOT_PICKED = """
const ed = ednow(window.__msDoc);
host.shell.activate(ed);
const layer = ed.layers.find((l) => l.id === __LAYER__);
if (!layer) throw new Error("the retouch's layer is gone");
ed.cutoutSettings.backend = "auto";   // nothing picked
ed.refreshCutoutBackends();
const shown = ed.cutoutSel ? ed.cutoutSel.value : null;
await ed.cutoutLayer(layer);
await wait(200);
return { shown, pending: !!ed.cutoutPending, mask: !!layer.maskPx, status: ed.status };
"""

GENERATE_NEW = """
const ed = ednow(window.__msDoc);
host.shell.activate(ed);
await run("select_recipe", { id: "magnificsub_generate", provider: "magnificsub" });
const out = await run("generate_new", { doc: window.__msDoc, prompt: "a lighthouse at dusk", aspect: "1:1", resolution: 1024, timeout: 120 });
return { size: [ed.width, ed.height], info: out.info, status: ed.status };
"""

SIGN_OUT = """
await openSettings();
const btn = Array.from(subRow().querySelectorAll("button")).find((b) => b.textContent === "Sign out");
if (!btn) throw new Error("no Sign out button");
btn.click();
const row = await until(() => { const r = rows().find((x) => x.label === __LABEL__); return r && r.state === "not signed in" ? r : null; }, 10000);
if (!row || JSON.stringify(row.buttons) !== '["Sign in"]') throw new Error("after Sign out: " + JSON.stringify(rows().find((x) => x.label === __LABEL__)));
const k = await window.scumble.keys.list();
if ((k.keys || {}).magnificsub && k.keys.magnificsub.set) throw new Error("keys still hold magnificsub");
const option = optionOf("magnificsub_generate");
if (option !== __LABEL__ + " (not signed in)") throw new Error("the option after Sign out: " + option);
sameOthers("after the sign-out");
closeSettings();
const backends = host.cutoutBackends().map((b) => b.id);
if (backends.includes("magnificsub")) throw new Error("the cutout list still offers magnificsub");
return { row: row.state, option, backends };
"""

CLEANUP = """
const out = {};
const t = window.__ms;
for (const d of document.querySelectorAll("dialog[open]")) d.close();
try { await window.scumble.providers.cancelSignIn("magnificsub"); } catch (_) { /* none */ }
const k0 = await window.scumble.keys.list();
if (t && (k0.keys || {}).magnificsub && k0.keys.magnificsub.set) { await window.scumble.providers.signOut("magnificsub"); out.signedOut = true; }
if (t) {
    const s = t.saved;
    // every recipe goes back through selectRecipe first (the window's own view of the providers); selectRecipe writes
    // the settings file without waiting, so the saved settings are written last, and openSettings re-reads the shell's copy
    for (const id of __RECIPES__) { const want = (s.recipeProviders || {})[id]; if (want) host.shell.selectRecipe(id, want); }
    if (t.recipe && t.recipe.id === s.recipe) host.shell.selectRecipe(t.recipe.id);
    else if (t.recipe) host.setRecipe(t.recipe);
    await wait(800);
    await window.scumble.settings.set({ magnificsub: s.magnificsub, recipeProviders: s.recipeProviders, recipe: s.recipe, recipeByMode: s.recipeByMode });
    await shell.openSettings();
    document.getElementById("shell-settings").close();
}
if (window.__msDoc) { try { await run("close_document", { doc: window.__msDoc, force: true }); } catch (_) { /* gone */ } }
const k = await window.scumble.keys.list();
out.signInLeft = !!((k.keys || {}).magnificsub && k.keys.magnificsub.set);
if (t) {
    if (out.signInLeft) throw new Error("the test sign-in is still stored");
    const now = await window.scumble.settings.get();
    const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
    out.restored = same(now.magnificsub, t.saved.magnificsub) && same(now.recipeProviders, t.saved.recipeProviders) && same(now.recipe, t.saved.recipe);
    if (!out.restored) throw new Error("the settings are not back: " + JSON.stringify({ magnificsub: now.magnificsub, recipeProviders: now.recipeProviders, recipe: now.recipe }));
}
window.__ms = null; window.__msDoc = null;
return out;
"""


def node_step():
    r = subprocess.run(["node", NODE_TEST], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=300)
    tail = (r.stdout + r.stderr).strip()
    if r.returncode != 0 or not tail.endswith("PASS"):
        lines = tail.splitlines()
        failed = [ln for ln in lines if ln.startswith("[FAIL]")]
        counted = [ln for ln in lines if " checks passed" in ln]
        shown = "\n    ".join([ln[:400] for ln in failed] + counted[-1:]) if failed else tail[-1500:]
        raise Exception("tools/magnificsub_test.js (rc %d):\n    %s" % (r.returncode, shown))
    return {"checks": tail.count("[ok]")}


class Mock:
    """tools/magnificsub_mock.js --app in a child process; its base and its tool calls."""

    def __init__(self):
        self.proc = subprocess.Popen(["node", MOCK, "--port", "0", "--app"], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8")
        line = self.proc.stdout.readline()
        if " on http://127.0.0.1:" not in line:
            self.stop()
            raise Exception("the mock did not start: %r" % line)
        self.url = line.split(" on ", 1)[1].split(" ", 1)[0]

    def calls(self):
        with urllib.request.urlopen(self.url + "/__mock/calls", timeout=10) as r:
            return json.loads(r.read().decode("utf-8"))

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


def browse(url):
    """The browser of the sign-in: a GET that follows the realm's 302 to the app's loopback redirect."""
    if not url.startswith("http://127.0.0.1:"):
        raise Exception("the authorization URL is not the mock's: %s" % url[:80])
    with urllib.request.urlopen(url, timeout=30) as r:
        return r.status, r.read().decode("utf-8", "replace")


def check_credits(name, res):
    if CREDITS not in str(res.get("status", "")):
        raise Exception("%s: the status line names no credits: %s" % (name, res.get("status")))


async def run_all(c):
    mock = Mock()
    print("mock Magnific (subscription) on", mock.url)
    ok = True

    async def ev(body, **subs):
        subs.setdefault("__LABEL__", json.dumps(LABEL))
        subs.setdefault("__RECIPES__", json.dumps(RECIPES))
        body = PRE % body
        for k, v in subs.items():
            body = body.replace(k, v)
        return await c.eval(body, timeout=240)

    def done(name, res):
        print("[ok] %s: %s" % (name, json.dumps(res, ensure_ascii=False)[:700]))

    async def step(name, fn):
        nonlocal ok
        try:
            await fn()
            return True
        except Exception as err:  # noqa: BLE001
            ok = False
            print("[FAIL] %s: %s" % (name, err))
            return False

    try:
        async def adapter():
            done("adapter_in_plain_node", node_step())
        await step("adapter_in_plain_node", adapter)

        await c.eval("(async () => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); window.__msCmds = await import('./commands.js'); window.__msHost = (await import('./editor/host.js')).host; window.__msShell = await import('./shell.js'); return 1; })()")

        async def setup():
            done("setup", await ev(SETUP, __MOCK__=json.dumps(mock.url)))
        if not await step("setup", setup):
            raise Stop()

        async def signed_out():
            done("the_rows_signed_out", await ev(SIGNED_OUT))
        if not await step("the_rows_signed_out", signed_out):
            raise Stop()

        async def sign_in():
            res = await ev(SIGN_IN_START)
            status, page = browse(res["url"])
            if status != 200 or "Signed in to Magnific" not in page:
                raise Exception("the loopback answered %s: %s" % (status, page[:200]))
            done("sign_in_from_the_row", {"pending": res["pending"], "row": res["row"]["state"], "page": page[:60]})
            done("the_row_signed_in", await ev(SIGNED_IN))
        if not await step("sign_in_from_the_row", sign_in):
            raise Stop()

        seen = {}

        async def upscale():
            n0 = len(mock.calls())
            res = await ev(UPSCALE)
            if res["size"] != [320, 240]:
                raise Exception("the document after a 2x upscale is %s: %s" % (res["size"], res["status"]))
            check_credits("upscale", res)
            seen["upscale"] = mock.calls()[n0:]
            done("a_creative_upscale_of_a_small_picture", {"size": res["size"], "status": res["status"][-120:]})
        await step("a_creative_upscale_of_a_small_picture", upscale)

        retouched = {}

        async def retouch():
            n0 = len(mock.calls())
            res = await ev(RETOUCH)
            if not res["layer"]:
                raise Exception("no result layer: %s" % res["status"])
            check_credits("retouch", res)
            seen["retouch"] = mock.calls()[n0:]
            retouched["id"] = res["layer"]["id"]
            done("a_retouch_of_a_selection", {"layer": res["layer"], "status": res["status"][-120:]})
        await step("a_retouch_of_a_selection", retouch)

        async def not_picked():
            if "id" not in retouched:
                raise Exception("no layer to cut out (the retouch failed)")
            n0 = len(mock.calls())
            res = await ev(NOT_PICKED, __LAYER__=json.dumps(retouched["id"]))
            calls = mock.calls()[n0:]
            if res["shown"] not in ("", None) or res["pending"] or res["mask"] or calls:
                raise Exception("a cutout ran without the paid backend picked: %s, the mock saw %s" % (res, [x["tool"] for x in calls]))
            if "No background removal model" not in res["status"] or "Or pick %s" % LABEL not in res["status"]:
                raise Exception("the status line: %s" % res["status"])
            done("a_cutout_click_never_spends_credits_unless_picked", {"shown": res["shown"], "status": res["status"], "requests": 0})
        await step("a_cutout_click_never_spends_credits_unless_picked", not_picked)

        async def cutout():
            if "id" not in retouched:
                raise Exception("no layer to cut out (the retouch failed)")
            n0 = len(mock.calls())
            res = await ev(CUTOUT, __LAYER__=json.dumps(retouched["id"]))
            if not res["mask"] or res["kept"] is None or not 30 <= res["kept"] <= 70:
                raise Exception("the layer's mask: %s" % res)
            if "with %s" % LABEL not in res["status"]:
                raise Exception("the status line: %s" % res["status"])
            check_credits("cutout", res)
            seen["cutout"] = mock.calls()[n0:]
            done("a_cutout_of_a_layer", res)
        await step("a_cutout_of_a_layer", cutout)

        async def generate_new():
            n0 = len(mock.calls())
            res = await ev(GENERATE_NEW)
            if res["size"] != [1024, 1024]:
                raise Exception("the base after Generate new is %s: %s" % (res["size"], res["status"]))
            check_credits("generate new", res)
            seen["generate"] = mock.calls()[n0:]
            done("generate_new", {"size": res["size"], "status": res["status"][-120:]})
        await step("generate_new", generate_new)

        async def tools():
            want = {"upscale": "images_upscale", "retouch": "images_retouch", "cutout": "images_remove_background", "generate": "images_generate"}
            out = {}
            for k, tool in want.items():
                got = seen.get(k)
                if got is None:
                    continue
                creations = [x for x in got if x["tool"].startswith("images_")]
                errors = [x for x in got if x.get("error")]
                if [x["tool"] for x in creations] != [tool] or errors:
                    raise Exception("%s: the mock saw %s, errors %s" % (k, [x["tool"] for x in got], errors[:2]))
                out[k] = {kk: vv for kk, vv in creations[0]["args"].items() if kk not in ("creationIdentifier", "maskCreationIdentifier")}
            if out.get("upscale", {}).get("mode", "creative") != "creative":
                raise Exception("the upscale went as %s" % out["upscale"])
            done("one_valid_creation_per_run", out)
        await step("one_valid_creation_per_run", tools)

        async def sign_out():
            done("sign_out_from_the_row", await ev(SIGN_OUT))
        await step("sign_out_from_the_row", sign_out)
    except Stop:
        pass
    except Exception as err:  # noqa: BLE001
        ok = False
        print("[FAIL]", err)
    finally:
        try:
            res = await ev(CLEANUP)
            print("[ok] cleanup: %s" % json.dumps(res))
        except Exception as err:  # noqa: BLE001
            ok = False
            print("[FAIL] cleanup:", err)
        mock.stop()
    for level, text in (await c.logs())[-15:]:
        if level == "error":
            print("  console error:", text[:220])
    print("PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run_all)) else 1)
