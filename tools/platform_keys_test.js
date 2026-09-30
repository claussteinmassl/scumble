// Plain-Node checks of renderer/editor/platform.js (Cmd for Ctrl on a Mac) on both sides of its platform flag: on a
// Mac Cmd held with a click or drag counts as Ctrl and "Ctrl" in a label reads "Cmd"; elsewhere only Ctrl counts (the
// Windows or Super key does not) and a label stays as it is. IS_MAC is read once, when the module loads, so each
// platform imports its own copy of the module (a query string makes a separate instance) under a stand-in navigator.
//
//     node tools/platform_keys_test.js
"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

const URL_ = pathToFileURL(path.join(__dirname, "..", "renderer", "editor", "platform.js")).href;

/** The module as a browser on `platform` (navigator.platform) loads it. */
async function load(platform) {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value: { platform }, configurable: true });
    try { return await import(URL_ + "?platform=" + encodeURIComponent(platform)); } finally {
        if (saved) Object.defineProperty(globalThis, "navigator", saved); else delete globalThis.navigator;
    }
}

(async () => {
    let fails = 0;
    const check = (name, fn) => {
        try { const r = fn(); console.log("[ok] " + name + (r ? ": " + r : "")); } catch (err) { fails++; console.log("[FAIL] " + name + ": " + err.message); }
    };
    const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: ${JSON.stringify(a)} instead of ${JSON.stringify(b)}`); };

    const LABELS = ["Ctrl+Z", "Ctrl+Shift+Z", "Ctrl keeps it square", "Ctrl+click", "Controls", "CtrlX", "", null, undefined, 3];
    const mac = await load("MacIntel"), win = await load("Win32"), linux = await load("Linux x86_64");

    check("the_flag_follows_navigator_platform", () => {
        eq(mac.IS_MAC, true, "MacIntel");
        eq(win.IS_MAC, false, "Win32");
        eq(linux.IS_MAC, false, "Linux x86_64");
        return "MacIntel, Win32, Linux x86_64";
    });

    check("cmdKey_on_a_mac_takes_cmd_or_ctrl", () => {
        eq(mac.cmdKey({ metaKey: true }), true, "Cmd");
        eq(mac.cmdKey({ ctrlKey: true }), true, "Ctrl");
        eq(mac.cmdKey({ ctrlKey: true, metaKey: true }), true, "both");
        eq(mac.cmdKey({ shiftKey: true, altKey: true }), false, "Shift+Alt");
        eq(mac.cmdKey(null), false, "no event");
    });

    check("cmdKey_off_a_mac_takes_ctrl_only", () => {
        for (const [name, m] of [["windows", win], ["linux", linux]]) {
            eq(m.cmdKey({ ctrlKey: true }), true, name + " Ctrl");
            eq(m.cmdKey({ metaKey: true }), false, name + " Windows / Super key");
            eq(m.cmdKey({ ctrlKey: true, metaKey: true }), true, name + " both");
            eq(m.cmdKey({ shiftKey: true, altKey: true }), false, name + " Shift+Alt");
            eq(m.cmdKey(undefined), false, name + " no event");
        }
    });

    check("keyText_on_a_mac_reads_cmd_for_the_word_ctrl", () => {
        const want = ["Cmd+Z", "Cmd+Shift+Z", "Cmd keeps it square", "Cmd+click", "Controls", "CtrlX", "", null, undefined, 3];
        LABELS.forEach((s, i) => eq(mac.keyText(s), want[i], JSON.stringify(s)));
    });

    check("keyText_off_a_mac_is_the_identity", () => {
        for (const [name, m] of [["windows", win], ["linux", linux]]) LABELS.forEach((s) => eq(m.keyText(s), s, name + " " + JSON.stringify(s)));
    });

    console.log(fails ? "FAIL" : "PASS");
    process.exit(fails ? 1 : 0);
})();
