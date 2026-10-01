"use strict";
// electron-builder `afterAllArtifactBuild` hook (build-time only, in no `files` list).
//
// electron-builder signs, notarizes and staples the .app but only signs the .dmg (`dmg.sign`), it never
// notarizes or staples it. This hook submits every built .dmg to Apple and staples the ticket, with the same
// credentials electron-builder reads for the app (APPLE_KEYCHAIN_PROFILE [+ APPLE_KEYCHAIN], or APPLE_ID +
// APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, or APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER).
// It does nothing without a .dmg (Windows and Linux builds) or without credentials (an unsigned build).
//
// A publish run must not upload from electron-builder itself (it uploads a file the moment it is built, before
// this hook): CI builds with `--publish never` and uploads afterwards. Stapling changes the dmg's bytes, so the
// dmg's sha512 and blockmap in latest-mac.yml are stale (electron-builder writes that file after this hook); the
// macOS updater is off and only reads the zip entry.

const { execFileSync } = require("node:child_process");
const path = require("node:path");

/**
 * Builds the notarytool credential arguments from the environment.
 * @returns {string[] | null} The arguments, or null when no credentials are set.
 */
function credentialArgs(env) {
  if (env.APPLE_KEYCHAIN_PROFILE) {
    const args = ["--keychain-profile", env.APPLE_KEYCHAIN_PROFILE];
    if (env.APPLE_KEYCHAIN) args.push("--keychain", env.APPLE_KEYCHAIN);
    return args;
  }
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) {
    return ["--apple-id", env.APPLE_ID, "--password", env.APPLE_APP_SPECIFIC_PASSWORD, "--team-id", env.APPLE_TEAM_ID];
  }
  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) {
    return ["--key", env.APPLE_API_KEY, "--key-id", env.APPLE_API_KEY_ID, "--issuer", env.APPLE_API_ISSUER];
  }
  return null;
}

module.exports = async function notarizeDmg(buildResult) {
  const dmgs = (buildResult.artifactPaths || []).filter((p) => p.endsWith(".dmg"));
  if (process.platform !== "darwin" || dmgs.length === 0) return [];
  const creds = credentialArgs(process.env);
  if (!creds) {
    console.log("  • notarize-dmg: skipped, no notarization credentials in the environment");
    return [];
  }
  for (const dmg of dmgs) {
    console.log("  • notarize-dmg: submitting " + path.basename(dmg) + " (waits for Apple)");
    execFileSync("xcrun", ["notarytool", "submit", dmg, ...creds, "--wait"], { stdio: "inherit" });
    execFileSync("xcrun", ["stapler", "staple", dmg], { stdio: "inherit" });
  }
  return [];
};
