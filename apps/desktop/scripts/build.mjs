import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

/**
 * Assemble everything the Electron app ships.
 *
 * Four bundles come out of this, and each has a different correct answer for `format`:
 *
 *   dist/server/index.mjs    ESM — Node's own loader, so `import.meta.url` works (the
 *                            server derives its project root from it) and the two external
 *                            packages resolve through normal upward `node_modules` lookup.
 *   dist/main/main.cjs       CJS — Electron's main process, where `.cjs` is what makes the
 *                            file CommonJS despite the package's `"type": "module"`.
 *   dist/main/preload.cjs    CJS — a preload script is loaded by Electron, not by the page.
 *   dist/renderer/panel.js   IIFE — the panel is served from `file://`, where Chromium
 *                            refuses module scripts outright (origin 'null').
 *
 * `dist/resources/` is the *unbundled* half: the built frontend and the seed config, staged
 * so `extraResources` can copy them into `Contents/Resources` verbatim. `main.ts` resolves
 * both that directory and `process.resourcesPath` to the same place, which is why
 * `pnpm desktop:dev` behaves like the packed app.
 */

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "../..");
const dist = join(desktopRoot, "dist");
const resources = join(dist, "resources");

const skipWeb = process.argv.includes("--no-web");

/**
 * Kept external rather than bundled, for two different reasons.
 *
 * `better-sqlite3` is a native addon: esbuild cannot inline a `.node` file, and the
 * prebuild it loads has to stay findable at its own package path. It ships N-API prebuilds
 * (`prebuilds/<platform>-<arch>.node`), which are ABI-stable across Node and Electron
 * versions — so no `electron-rebuild` step is needed, and the desktop package pins the same
 * version the server does rather than a rebuild of it.
 *
 * `pdfjs-dist` is external because it is large, it is already the right shape for Node (its
 * `legacy` build needs no DOM and no worker), and bundling it would mean inlining a module
 * tree that upstream intends to be resolved.
 */
const SERVER_EXTERNALS = ["better-sqlite3", "pdfjs-dist", "pdfjs-dist/*"];

/**
 * Give the ESM bundle a working `require`.
 *
 * Half of the server's dependencies are CommonJS (`yaml`, `cheerio`, `fflate`), and a CJS
 * module that calls `require("process")` internally cannot be rewritten by esbuild, which
 * emits a shim that throws "Dynamic require of … is not supported" instead. esbuild's shim
 * prefers a real `require` when one is in scope, so defining one from this module's own URL
 * makes every one of those calls resolve to the right thing.
 *
 * The alternative — building the server as CJS — would work for the dependencies and break
 * `import.meta.url`, which `config.ts` derives its project root from. One banner is a
 * smaller lie than rewriting that.
 */
const REQUIRE_BANNER = [
  "import { createRequire as __glCreateRequire } from 'node:module';",
  "const require = __glCreateRequire(import.meta.url);",
].join("\n");

function bundleServer() {
  return esbuild.build({
    entryPoints: [join(repoRoot, "apps/server/src/index.ts")],
    outfile: join(dist, "server/index.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    // Electron 44 runs Node 22. Pinning the target keeps esbuild from emitting syntax the
    // runtime would reject, and from down-levelling to Node 18 shapes it does not need.
    target: "node22",
    external: SERVER_EXTERNALS,
    banner: { js: REQUIRE_BANNER },
    // A stack trace from a packaged app names the function even without a map, and the map
    // for this bundle is several megabytes in a build whose whole point is one download.
    sourcemap: false,
    logLevel: "info",
  });
}

function bundleElectron() {
  return Promise.all([
    esbuild.build({
      entryPoints: [join(desktopRoot, "src/main/main.ts")],
      outfile: join(dist, "main/main.cjs"),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      // Provided by the Electron runtime, not by anything on disk.
      external: ["electron"],
      sourcemap: true,
    }),
    esbuild.build({
      entryPoints: [join(desktopRoot, "src/preload/preload.ts")],
      outfile: join(dist, "main/preload.cjs"),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      external: ["electron"],
      sourcemap: true,
    }),
  ]);
}

function bundleRenderer() {
  return esbuild.build({
    entryPoints: [join(desktopRoot, "src/renderer/panel.ts")],
    outfile: join(dist, "renderer/panel.js"),
    bundle: true,
    platform: "browser",
    // See the note above: an IIFE is the only script shape `file://` will run.
    format: "iife",
    target: "chrome130",
    sourcemap: true,
  });
}

function copyRendererAssets() {
  mkdirSync(join(dist, "renderer"), { recursive: true });
  for (const file of ["index.html", "panel.css"]) {
    cpSync(join(desktopRoot, "src/renderer", file), join(dist, "renderer", file));
  }
}

/**
 * The menu-bar icon, as a resource rather than as an asset.
 *
 * `assets/` is electron-builder's `buildResources` directory — the builder reads it and
 * deliberately keeps it *out* of the app bundle. The tray icon is needed at runtime, so it
 * is staged here instead, where `extraResources` copies it into `Contents/Resources/tray/`
 * and `main.ts` resolves it through `resourcesDir` in both packed and unpacked runs.
 */
function copyTrayIcons() {
  mkdirSync(join(resources, "tray"), { recursive: true });
  for (const file of ["trayTemplate.png", "trayTemplate@2x.png"]) {
    cpSync(join(desktopRoot, "assets", file), join(resources, "tray", file));
  }
}

/** The frontend, built by its own toolchain and then staged as a resource. */
function buildWeb() {
  console.log("[desktop] building the web app…");
  execFileSync("pnpm", ["--filter", "@guided-learning/web", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  const webDist = join(repoRoot, "apps/web/dist");
  if (!existsSync(join(webDist, "index.html"))) {
    throw new Error(`The web build produced no index.html in ${webDist}`);
  }
  cpSync(webDist, join(resources, "web"), { recursive: true });
}

/**
 * The config the server seeds from on first run.
 *
 * Copied from the repo rather than duplicated here so there is one description of what a
 * fresh install starts with, and so the comment block explaining `${ENV_VAR}` and the
 * seed-once contract travels with it. The desktop app overlays its own `port: 0` on top;
 * it does not fork this file.
 */
function copySeedConfig() {
  mkdirSync(join(resources, "config"), { recursive: true });
  cpSync(join(repoRoot, "config/config.yaml"), join(resources, "config/config.yaml"));
}

async function main() {
  // A stale bundle is the classic way to ship a build that does not match the source: code
  // that is no longer emitted stays behind and keeps working until it does not.
  //
  // What is *not* cleared is `dist/resources/web`. Building it takes a full Vite pass, so
  // `--no-web` exists to skip it on the dev loop — and deleting it on the way through would
  // mean every `pnpm desktop:dev` threw away the frontend and left the panel's "open" button
  // pointing at nothing. It is refreshed whenever `--no-web` is absent, which is what
  // packaging runs.
  for (const dir of ["server", "main", "renderer", "resources/config"]) {
    rmSync(join(dist, dir), { recursive: true, force: true });
  }
  mkdirSync(resources, { recursive: true });

  await Promise.all([bundleServer(), bundleElectron(), bundleRenderer()]);
  copyRendererAssets();
  copySeedConfig();
  copyTrayIcons();

  if (skipWeb) {
    const staged = existsSync(join(resources, "web", "index.html"));
    console.log(
      staged
        ? "[desktop] --no-web: reusing the frontend already staged in dist/resources/web"
        : "[desktop] --no-web: no frontend staged, so the panel's server has nothing to serve at / — run `pnpm build` once, or drop the flag"
    );
  } else {
    buildWeb();
  }

  console.log(`[desktop] built into ${dist}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
