// The platform the editor runs on, as far as keys and paths care. A leaf module (no imports) that both hosts carry: the
// app loads it from here, tools/build_node.py copies it into the ComfyUI node, where a plain browser runs it (it only
// reads `navigator`, which workers have too).

/** macOS: Cmd does what Ctrl does elsewhere (the key handlers already take either), and Ctrl+click is the context menu. */
export const IS_MAC = typeof navigator !== "undefined" && /^mac/i.test(String(navigator.platform || ""));

/** Ctrl, or Cmd on a Mac, held during a mouse or drag event. */
export function cmdKey(e) { return !!(e && (e.ctrlKey || e.metaKey)); }

/**
 * A text with shortcuts as the user types them: "Ctrl" reads "Cmd" on a Mac ("Ctrl+Z", and "Ctrl keeps it square" for a
 * modifier held while dragging), unchanged elsewhere.
 */
export function keyText(s) { return IS_MAC && typeof s === "string" ? s.replace(/\bCtrl\b/g, "Cmd") : s; }
