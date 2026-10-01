// The curated, static lists of "Magnific (subscription)" (magnificsub.js): what the recipes' rows offer, by label, and
// what each label sends. docs/PLAN_MAGNIFIC_SUB.md §3 chose them; the catalogs they come from are copied to
// tools/refs/magnificsub/catalog_*.txt (read 2026-10-01 with the user's account). Models the account's catalog lists
// are offered; beta or private ones are marked (beta), and a live run confirms them: `private` means hidden from the
// general listings, not unusable (simulate_cost priced both private generate models, 2026-10-01). Each label is the
// catalog's name, plus " (beta)" for such a model (tools/magnificsub_test.js holds the tables to the catalogs).
//
// A row's value is the label; pick() also takes the slug (or an alias) itself, for an agent that names it.
"use strict";

const LABEL = "Magnific (subscription)";

// images_generate's aspectRatio enum (tools/refs/magnificsub/images_generate.json): a model's own list is cut to it
const GENERATE_ASPECTS = Object.freeze(["1:1", "21:9", "16:9", "9:16", "2:3", "3:4", "1:2", "2:1", "5:4", "4:5", "3:2", "4:3"]);

const CREATIVE_KEYS = ["presets", "optimised", "creativity", "resemblance", "hdr", "fractality", "engine", "prompt"];
const PRECISION_KEYS = ["sharpness", "grain", "ultraDetail", "precisionPreset"];
const ALL_SCALES = ["2x", "4x", "8x", "16x"];

// catalog_images_upscale_modes_list.txt: each mode's scales and the keys it takes ("supply only that mode's optional
// params"); `kind` is the recipe it belongs to (recipes/magnificsub_creative.json, recipes/magnificsub_precision.json)
const UPSCALE_MODES = Object.freeze({
    "Creative": { slug: "creative", scales: ALL_SCALES, keys: CREATIVE_KEYS, kind: "creative" },
    "Precision sublime": { slug: "ultra-sublime", scales: ALL_SCALES, keys: PRECISION_KEYS.filter((k) => k !== "ultraDetail"), kind: "precision" },
    "Precision photo": { slug: "ultra-photo", scales: ["2x"], keys: PRECISION_KEYS, kind: "precision" },
    "Precision photo denoiser": { slug: "ultra-denoiser", scales: ["2x"], keys: PRECISION_KEYS, kind: "precision" },
    "Precision v1": { slug: "ultra", scales: ["2x"], keys: PRECISION_KEYS, kind: "precision" },
});
// Creative's presets; "Custom (sliders)" sends presets "custom" with the four sliders (a named preset sets them itself)
const CREATIVE_PRESETS = Object.freeze({
    "Subtle": { slug: "subtle" },
    "Vivid": { slug: "vivid" },
    "Wild": { slug: "wild" },
    "Custom (sliders)": { slug: "custom", aliases: ["Custom"] },
});
// the Precision macros; "None (sliders)" sends the sliders instead (a macro sets them on Magnific's side)
const PRECISION_PRESETS = Object.freeze({
    "None (sliders)": { slug: null, aliases: ["none"] },
    "Balanced": { slug: "balanced" },
    "Portraits": { slug: "portraits" },
    "Grainy analog": { slug: "grainyAnalog" },
});
const UPSCALE_OPTIMISED = Object.freeze({
    "Standard": { slug: "StandardUltra" },
    "Soft portraits": { slug: "SoftPortrait" },
    "Hard portraits": { slug: "HardPortrait" },
    "Art and illustration": { slug: "ArtAndIllustration" },
    "Video game assets": { slug: "VideoGameAssets" },
    "Nature and landscapes": { slug: "NatureAndLandscapes" },
    "Film and photography": { slug: "FilmAndPhotography" },
    "3D renders": { slug: "ThreeDRenders" },
    "Science fiction and horror": { slug: "ScienceFictionAndHorror" },
});
const UPSCALE_ENGINES = Object.freeze({
    "Automatic": { slug: "automatic" },
    "Illusio": { slug: "magnific_illusio" },
    "Sharpy": { slug: "magnific_sharpy" },
    "Sparkle": { slug: "magnific_sparkle" },
});
// the integer rows: the request key -> [key, min, max] (the catalog's ranges)
const UPSCALE_SLIDERS = Object.freeze({
    creativity: ["creativity", -10, 10], resemblance: ["resemblance", -10, 10], hdr: ["hdr", -10, 10], fractality: ["fractality", -10, 10],
    sharpness: ["sharpness", 0, 100], grain: ["grain", 0, 100], ultraDetail: ["ultraDetail", 0, 100],
});

const RETOUCH_MODES = Object.freeze({
    "Replace": { slug: "replace" },
    "Erase": { slug: "erase" },
});
// catalog_retouch_models_list.txt, the spec's curated list (none of them beta or private); Auto sends no model
const RETOUCH_MODELS = Object.freeze({
    "Auto": { slug: null, modes: ["replace", "erase"], aliases: ["auto", "retouch-auto"] },
    "Classic": { slug: "retouch-classic", modes: ["replace"] },
    "Erase": { slug: "retouch-erase", modes: ["erase"] },
    "Google Nano Banana Pro": { slug: "retouch-imagen-nano-banana-2", modes: ["replace"], resolutions: ["2k", "4k"] },
    "Google Nano Banana 2": { slug: "retouch-imagen-nano-banana-2-flash", modes: ["replace"], resolutions: ["1k", "2k", "4k"] },
});

// catalog_images_models_list.txt: each model's aspect ratios as listed, and how a reference layer goes: as "image"
// where the model takes one, as "style" (a creation as a style picture) where it takes only that. The spec's list, in
// its order; GPT 2.5 is beta, Ideogram 4.5 and Qwen Image 3.0 Pro are beta and private.
const GENERATE_MODELS = Object.freeze({
    "Auto": { slug: "auto", ref: "image", aspects: ["1:1", "16:9", "9:16", "2:3", "3:4", "1:2", "2:1", "4:5", "3:2", "4:3"] },
    "Flux.2 Pro": { slug: "flux-2", ref: "image", aspects: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "1:2", "2:1", "4:5"] },
    "Flux.2 Max": { slug: "flux-2-max", ref: "image", aspects: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "1:2", "2:1", "4:5"] },
    "GPT 2": { slug: "gpt-2", ref: "image", aspects: ["1:1", "2:1", "3:1", "2:3", "3:2", "3:4", "4:3", "16:9", "9:16", "21:9"] },
    "GPT 2.5 (beta)": { slug: "gpt-2-mini", ref: "image", aspects: ["1:1", "2:1", "3:1", "2:3", "3:2", "3:4", "4:3", "16:9", "9:16", "21:9"] },
    "Google Nano Banana Pro": { slug: "imagen-nano-banana-2", ref: "image", aspects: ["1:1", "21:9", "16:9", "9:16", "4:3", "4:5", "5:4", "3:4", "3:2", "2:3"] },
    "Google Nano Banana 2": { slug: "imagen-nano-banana-2-flash", ref: "image", aspects: ["1:1", "21:9", "8:1", "4:1", "16:9", "9:16", "1:4", "1:8", "4:3", "4:5", "5:4", "3:4", "3:2", "2:3"] },
    "Seedream 5 Pro": { slug: "seedream-5-pro", ref: "image", aspects: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"] },
    "Ideogram 4.5 (beta)": { slug: "ideogram-4-5", ref: "image", aspects: ["1:1", "4:5", "5:4", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "1:2", "2:1", "1:3", "3:1"] },
    "Mystic 2.5": { slug: "mystic-2-5", ref: "style", aspects: ["1:1", "16:9", "9:16", "2:3", "3:4", "1:2", "2:1", "4:5", "3:2", "4:3"] },
    "Recraft V4.1": { slug: "recraft-v4-1", ref: "style", aspects: ["1:1", "2:1", "1:2", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16"] },
    "Qwen Image 3.0 Pro (beta)": { slug: "qwen-image-3-0-pro", ref: "image", aspects: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "1:2", "2:1", "4:5"] },
});

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** The entry of a label table for a row's value (its label, its slug or an alias); `fallback` for an empty row. */
function pick(table, value, fallback, what) {
    const v = value == null || value === "" ? fallback : String(value);
    if (own(table, v)) return { label: v, ...table[v] };
    const hit = Object.entries(table).find(([, t]) => (t.slug != null && t.slug === v) || (t.aliases || []).includes(v));
    if (hit) return { label: hit[0], ...hit[1] };
    throw new Error(`${LABEL}: no ${what} "${v}" (${Object.keys(table).join(", ")}).`);
}

/** "2x, 4x and 8x". */
function words(list) {
    return list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** A row's integer, or undefined when the row is empty (the server's default holds); out of range is refused. */
function int(value, [key, min, max]) {
    if (value === "" || value == null) return undefined;
    const n = Math.round(+value);
    if (!Number.isFinite(n)) throw new Error(`${LABEL}: ${key} "${value}" is not a number.`);
    if (n < min || n > max) throw new Error(`${LABEL}: ${key} goes from ${min} to ${max}, not ${n}.`);
    return n;
}

module.exports = {
    LABEL, GENERATE_ASPECTS, UPSCALE_MODES, CREATIVE_PRESETS, PRECISION_PRESETS, UPSCALE_OPTIMISED, UPSCALE_ENGINES,
    UPSCALE_SLIDERS, RETOUCH_MODES, RETOUCH_MODELS, GENERATE_MODELS, pick, words, int,
};
