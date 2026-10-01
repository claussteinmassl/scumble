"use strict";
// electron-builder `afterAllArtifactBuild` hook (build-time only, in no `files` list).
//
// electron-builder signs, notarizes and staples the .app but only signs the .dmg (`dmg.sign`), it never
// notarizes or staples it. This hook submits every built .dmg to Apple and staples the ticket, with the same
// credentials electron-builder reads for the app (APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD +
// APPLE_TEAM_ID, then APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, then APPLE_KEYCHAIN_PROFILE [+ APPLE_KEYCHAIN],
// the precedence of electron-builder's getNotarizeOptions).
// It does nothing without a .dmg (Windows and Linux builds), without credentials, or when the dmg is not signed
// (CSC_IDENTITY_AUTO_DISCOVERY=false, no Developer ID certificate): Apple would reject an unsigned dmg.
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
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) {
    return ["--apple-id", env.APPLE_ID, "--password", env.APPLE_APP_SPECIFIC_PASSWORD, "--team-id", env.APPLE_TEAM_ID];
  }
  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) {
    return ["--key", env.APPLE_API_KEY, "--key-id", env.APPLE_API_KEY_ID, "--issuer", env.APPLE_API_ISSUER];
  }
  if (env.APPLE_KEYCHAIN_PROFILE) {
    const args = ["--keychain-profile", env.APPLE_KEYCHAIN_PROFILE];
    if (env.APPLE_KEYCHAIN) args.push("--keychain", env.APPLE_KEYCHAIN);
    return args;
  }
  return null;
}

function isSigned(file) {
  try {
    execFileSync("codesign", ["--verify", file], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

module.exports = async function notarizeDmg(buildResult) {
  const dmgs = (buildResult.artifactPaths || []).filter((p) => p.endsWith(".dmg"));
  if (process.platform !== "darwin" || dmgs.length === 0) return [];
  const creds = credentialArgs(process.env);
  if (!creds) {
    console.log("  • notarize-dmg: skipped, no notarization credentials in the environment");
    return [];
  }
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === "false") {
    console.log("  • notarize-dmg: skipped, code signing is off (CSC_IDENTITY_AUTO_DISCOVERY=false)");
    return [];
  }
  for (const dmg of dmgs) {
    const name = path.basename(dmg);
    if (!isSigned(dmg)) {
      console.log("  • notarize-dmg: skipped " + name + ", it is not signed (no Developer ID certificate?)");
      continue;
    }
    console.log("  • notarize-dmg: submitting " + name + " (waits for Apple)");
    const out = execFileSync("xcrun", ["notarytool", "submit", dmg, ...creds, "--wait", "--output-format", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    const result = JSON.parse(out.slice(out.indexOf("{")));
    if (result.status !== "Accepted") {
      let log = "";
      try {
        log = execFileSync("xcrun", ["notarytool", "log", result.id, ...creds], { encoding: "utf8" });
      } catch (e) {
        log = "(could not fetch the log: " + e.message + ")";
      }
      throw new Error("notarization of " + name + " ended " + result.status + " (id " + result.id + ")\n" + log);
    }
    console.log("  • notarize-dmg: " + name + " accepted (id " + result.id + ")");
    execFileSync("xcrun", ["stapler", "staple", dmg], { stdio: "inherit" });
  }
  return [];
};
