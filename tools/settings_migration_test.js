// electron/main/settings.js without Electron: the default of "Prompt and recipe in the PNG" (settings.embedRecipe, on
// since 0.1.32) reaches a profile that 0.1.30 or 0.1.31 wrote, and a choice the user made stays theirs.
//
//     node tools/settings_migration_test.js
//
// settings.set() writes the whole merged object, so the old default `embedRecipe: false` sits in every profile that
// saved anything since 0.1.30; get() drops it unless the switch itself wrote it (`embedRecipeChosen`, host.setEmbedRecipe).
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let failures = 0;
function check(name, ok, detail = "") {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
    if (!ok) failures++;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-settings-"));
// electron's app stood in for: only getPath("userData") is asked
const load = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === "electron") return { app: { getPath: () => dir } };
    return load.call(this, request, parent, isMain);
};
const SETTINGS = path.join(__dirname, "..", "electron", "main", "settings.js");
const fresh = (stored) => {
    if (stored === undefined) { try { fs.unlinkSync(path.join(dir, "settings.json")); } catch (_) { /* none */ } }
    else fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(stored));
    for (const k of Object.keys(require.cache)) if (k.includes(path.join("electron", "main"))) delete require.cache[k];
    return require(SETTINGS);
};

try {
    let s = fresh(undefined);
    check("a new profile has the switch on", s.get().embedRecipe === true && s.DEFAULTS.embedRecipe === true);
    s = fresh({ embedRecipe: false, recipe: "sdxl_inpaint" });
    check("the old default a 0.1.31 profile stored gives way to the new one", s.get().embedRecipe === true && s.get().recipe === "sdxl_inpaint");
    s.set({ apiSize: "x2" });
    const written = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
    check("the next write stores the new default", written.embedRecipe === true && written.apiSize === "x2");
    s = fresh({ embedRecipe: false, embedRecipeChosen: true });
    check("a switch the user turned off stays off", s.get().embedRecipe === false);
    s = fresh({ embedRecipe: true });
    check("an unmarked true stays true", s.get().embedRecipe === true);
    s = fresh({ embedRecipe: false, embedRecipeChosen: true });
    s.set({ recipe: "x" });
    const again = fresh(JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")));
    check("the user's off survives a write and a restart", again.get().embedRecipe === false);

    // the subscription's removed recipes (docs/PLAN_MAGNIFIC_SUB.md "Restructure"): a stored selection moves to the
    // recipe that replaced it, on the provider magnificsub
    s = fresh({ recipe: "magnificsub_generate", recipeByMode: { api: "magnificsub_generate", local: "flux2_klein_local" }, upscaleRecipe: "magnificsub_precision", recipeProviders: { magnificsub_creative: "magnificsub", flux2_pro: "bfl" } });
    let g = s.get();
    check("recipe, recipeByMode and upscaleRecipe naming a removed id move to its replacement",
        g.recipe === "magnific_auto" && g.recipeByMode.api === "magnific_auto" && g.recipeByMode.local === "flux2_klein_local" && g.upscaleRecipe === "magnific_precision", JSON.stringify([g.recipe, g.recipeByMode, g.upscaleRecipe]));
    check("each replacement runs on magnificsub; the removed ids leave recipeProviders, the other entries stay",
        g.recipeProviders.magnific_auto === "magnificsub" && g.recipeProviders.magnific_precision === "magnificsub" && g.recipeProviders.magnific_creative === "magnificsub"
        && g.recipeProviders.flux2_pro === "bfl" && !Object.keys(g.recipeProviders).some((k) => k.startsWith("magnificsub_")), JSON.stringify(g.recipeProviders));
    s.set({ apiSize: "x1" });
    const moved = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
    check("the next write stores the moved selection", moved.recipe === "magnific_auto" && moved.recipeProviders.magnific_auto === "magnificsub" && !("magnificsub_generate" in moved.recipeProviders));
    s = fresh({ recipe: "magnificsub_creative", recipeProviders: { magnific_creative: "comfycloud" } });
    g = s.get();
    check("a selected removed recipe takes its provider along, over an older choice for the replacement", g.recipe === "magnific_creative" && g.recipeProviders.magnific_creative === "magnificsub", JSON.stringify(g.recipeProviders));
    s = fresh({ recipe: "flux2_pro", recipeProviders: { magnificsub_creative: "magnificsub", magnific_creative: "comfycloud" } });
    g = s.get();
    check("a leftover recipeProviders entry of a removed id does not override the replacement's own choice", g.recipeProviders.magnific_creative === "comfycloud" && !("magnificsub_creative" in g.recipeProviders), JSON.stringify(g.recipeProviders));
    s = fresh({ recipe: "magnific_creative", recipeByMode: { api: "seedream_5_pro" }, recipeProviders: { seedream_5_pro: "fal" } });
    g = s.get();
    check("a profile without a removed id is left as it was", g.recipe === "magnific_creative" && g.recipeByMode.api === "seedream_5_pro" && JSON.stringify(g.recipeProviders) === JSON.stringify({ seedream_5_pro: "fal" }));
    const recipeDir = path.join(__dirname, "..", "recipes");
    const gone = Object.keys(s.MOVED_RECIPES).filter((id) => fs.existsSync(path.join(recipeDir, id + ".json")));
    const bad = Object.values(s.MOVED_RECIPES).filter((m) => { const r = JSON.parse(fs.readFileSync(path.join(recipeDir, m.id + ".json"), "utf8")); return !r.providers[m.provider]; });
    check("the removed recipes are gone, and each replacement is shipped with that provider", !gone.length && !bad.length, JSON.stringify({ gone, bad }));
} finally {
    Module._load = load;
    fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `${failures} FAILED` : "PASS");
process.exit(failures ? 1 : 0);
