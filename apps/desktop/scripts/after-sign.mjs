import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * Ad-hoc sign the app when nothing better is available.
 *
 * Without this the `.dmg` installs an app that macOS refuses to open with **"ilearnassist
 * is damaged and can't be opened"** — and unlike the ordinary unsigned-app warning, that one
 * cannot be dismissed with right-click → Open, because it is not a trust decision. It is the
 * signature being *inconsistent with the bundle*: Electron ships its binary linker-signed,
 * electron-builder then adds our whole application under `Contents/Resources/`, and the
 * result is a signature that says "no sealed resources" on a bundle that now has some. The
 * user's only recourse is a terminal.
 *
 * Re-signing the finished bundle ad-hoc produces a seal over what is actually there, which
 * turns that into the *ordinary* "unidentified developer" prompt — one that right-click →
 * Open does dismiss, and that a `xattr -dr com.apple.quarantine` clears. That is the honest
 * ceiling without a Developer ID certificate; see the Signing section of `docs/desktop.md`.
 *
 * **It deliberately does nothing when the app is already validly signed.** Overwriting a
 * Developer ID signature with an ad-hoc one would downgrade a real release to exactly the
 * unopenable state this hook exists to prevent, and it would do it silently.
 *
 * `--deep` is deprecated for signing in general, because it cannot express entitlements that
 * differ between nested binaries. Ad-hoc signing has no entitlements to express, and the
 * nested code here is an unmodified Electron distribution, so the shortcut is safe — and
 * `codesign --verify --deep --strict` is what the assertion below actually checks.
 */

/** Whether the bundle already carries a signature that verifies. */
function isAlreadySigned(appPath) {
  try {
    execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export default async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  if (isAlreadySigned(appPath)) {
    console.log(`[desktop] ${appPath} is already validly signed; leaving it alone`);
    return;
  }

  console.log("[desktop] no signing identity: ad-hoc signing so the app can be opened");
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });

  // Failing here is better than shipping a `.dmg` that cannot be opened by anyone — and the
  // verification is cheap enough that there is no reason to take it on trust.
  if (!isAlreadySigned(appPath)) {
    throw new Error(
      `Ad-hoc signing did not produce a valid signature for ${appPath}. ` +
        "The .dmg would install an app macOS reports as damaged; refusing to build it."
    );
  }
}
