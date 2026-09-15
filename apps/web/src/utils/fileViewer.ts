import type { ResolvedTheme } from "../composables/theme";
import type { Locale } from "./locale";

/**
 * The preview viewer's decisions: which files are worth a viewer, and how it is configured.
 *
 * No DOM and **no import of the library** — and that second part is load-bearing rather than
 * tidy. `FilePreviewDialog` is always mounted and imports this module eagerly, so anything
 * reachable from here is in the initial bundle. The library is ~25 runtime dependencies
 * behind one entry point with no `sideEffects` field, which measures at ~826 kB raw for its
 * core alone; it lives in `utils/openFileViewer.ts`, which is only ever reached through a
 * dynamic `import()`. `apps/web/test/utils/fileViewer.test.ts` pins the separation.
 *
 * This is `utils/mermaid.ts`'s split once more — the part with no DOM in one module, the async
 * library in another — with one difference that dictated the file boundary: mermaid has no
 * stylesheet, so it can keep both halves together, and this library does.
 */

/**
 * Extensions this build offers the viewer.
 *
 * Only formats the **server calls `binary`** can arrive here. A `.svg`, a `.csv`, a `.geojson`
 * or a `.kml` is valid UTF-8, so `classify` sends it down the `text` path and it never reaches
 * a viewer at all — listing one here would be dead weight. That is a real limit on "preview
 * everything", and `docs/file-preview.md` records it as the next step rather than pretending
 * otherwise.
 *
 * **A superset is the safe direction, and an under-claim is the failure.** A file this says no
 * to never reaches `isPreviewSupported`, so a format the library gained that is missing here
 * is a format a user simply cannot open. A file this says yes to costs one lazy chunk and, if
 * no plugin matches, an honest "unsupported" panel — the library's own answer, not a wrong
 * render. So this list is the *product* answer — the formats this build promises — and
 * `isPreviewSupported` stays the authority once the chunk has landed, which is what keeps a
 * stale entry from rendering badly.
 *
 * Note what is deliberately absent: any extension `BINARY_EXTENSIONS` does not contain and the
 * sniff therefore calls text, plus the executables and fonts the server refuses
 * (`.exe`, `.class`, `.jar`) — the viewer has plugins for some of those, and offering a font
 * specimen or a JAR listing is not what a file preview in this app is for.
 */
const VIEWER_EXTENSIONS = new Set([
  // Images. `psd` is absent from `BINARY_EXTENSIONS`, so it arrives by sniff — which it does,
  // being full of NUL bytes.
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff", "avif", "heic", "heif", "psd",
  // Video and audio.
  "mp4", "webm", "mov", "m4v", "avi", "mkv", "flv", "wmv", "m3u8", "m2ts",
  "mp3", "wav", "ogg", "aac", "m4a", "flac", "opus", "mid", "wma",
  // Documents.
  "pdf", "epub", "xps", "oxps", "ofd", "rtf",
  // Office. Both the OOXML families and the legacy binary ones, which the library reads
  // through an OLE path rather than by uploading anything.
  "docx", "docm", "dot", "odt", "wps",
  "xlsx", "xlsm", "xlsb", "xls", "et",
  "pptx", "pps", "ppsx", "pptm", "ppt", "odp", "dps",
  // Archives.
  "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz",
  // Mail.
  "eml", "msg", "mbox",
  // Drawings and mind maps.
  "drawio", "dio", "excalidraw", "tldraw", "xmind",
  // 3D.
  "gltf", "glb", "obj", "stl", "fbx", "dae", "ply", "3mf", "usd", "usdz",
  // GIS. The text-based members of this family (`geojson`, `topojson`, `kml`, `gpx`) are
  // excluded above for the `text` reason; these are the binary ones.
  "kmz", "shp",
  // Assets the library can describe without decoding them to a picture.
  "ttf", "woff2", "ai", "eps", "sqlite", "wasm", "parquet", "avro",
]);

/**
 * Whether this file is worth loading the viewer chunk for.
 *
 * Cheap, synchronous and extension-only, so the store can ask it *before* it fetches any
 * bytes — which is what keeps a `.bin` from costing a request at all, not merely a render.
 */
export function fileViewerSupported(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return VIEWER_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * Our locale, in the library's vocabulary.
 *
 * The library ships its own catalog (`PreviewLocale` is exactly `zh-CN | en-US`), so the
 * viewer's chrome — loading, unsupported, download, zoom, page numbers, the whole toolbar —
 * is translated by the dependency rather than by us. That is why there is no `files.viewer.*`
 * namespace in our catalogs: a second translation of strings we do not own would be a copy to
 * keep in step with nothing.
 *
 * A total mapping, because ours is the smaller set: anything that is not Chinese is English,
 * which is also `FALLBACK_LOCALE`'s rule one layer up.
 */
export function viewerLocale(locale: Locale): "zh-CN" | "en-US" {
  return locale === "zh-CN" ? "zh-CN" : "en-US";
}

/**
 * The theme the viewer is told to draw in.
 *
 * **Never `"auto"`, and that is the whole point of the function.** `<html data-theme>` holds
 * the *mode*, not the resolved theme — `auto` means "the CSS media query decides" — so handing
 * `"auto"` to a library that reads `prefers-color-scheme` itself gets the right answer only
 * when the user has not overridden it. A forced-light theme on a dark OS would render a dark
 * document, and a forced-dark one would render a light document. `useTheme().resolved` has
 * already resolved that; this narrows the type so there is no way to pass the mode back in.
 */
export function viewerThemeOption(resolved: ResolvedTheme): "light" | "dark" {
  return resolved;
}
