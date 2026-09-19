import { extname } from "node:path";
import { DIAGRAM_FILE_EXTENSIONS } from "@ilearnassist/shared";
import type { FileCategory } from "@ilearnassist/shared";
import { isDocumentMime } from "./documents/formats.js";

/**
 * What a file *is*: one MIME type and one coarse category, from a name.
 *
 * A registry needs this and a browser needs it twice — once to filter a list of files, once
 * to decide whether anything has to be *parsed* before a model can read it. Doing it here,
 * once, is the whole reason the module exists: this codebase has already paid for a second
 * extension table once, when a `.mmd` compiled cleanly and rendered as highlighted source in
 * one dialog and as a diagram in another.
 *
 * So the rule is stated rather than implied: **`category` is a label, not a gate.** What
 * decides whether a document is parsed is still `isDocumentMime` in `documents/formats.ts`,
 * and what decides whether bytes are text is still the sniff in `files.ts`. This answers a
 * third question — "what kind of thing is this, for a human reading a list" — and where the
 * three overlap, a test pins that they agree.
 *
 * Two neighbours it deliberately does **not** merge with:
 *
 * - `attachments.ts`'s `MIME_EXT`/`EXT_MIME` is the *upload acceptance list*: which types a
 *   user may attach, and what extension each is stored under. That is a whitelist and it is
 *   short on purpose; this is a description of whatever is found on disk, so it is long. The
 *   `.mmd` that can never be uploaded is a diagram here all the same.
 * - `files.ts`'s `BINARY_EXTENSIONS` is a *read-avoidance list* — a name that says "do not
 *   spend a quarter-megabyte finding out". This one must never disagree with it, and the test
 *   iterates that set to prove it does not.
 */

/** Text with syntax. Split from plain text because the client colours it. */
const CODE_EXTENSIONS = new Set([
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts", "vue", "svelte",
  "py", "rb", "go", "rs", "java", "kt", "kts", "scala", "cs", "c", "cc", "cpp", "cxx",
  "h", "hh", "hpp", "m", "mm", "swift", "php", "pl", "lua", "r", "jl", "dart", "ex", "exs",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "sql", "graphql", "gql", "proto", "tf", "hcl",
  "css", "scss", "sass", "less", "styl",
  "html", "htm", "xml", "xsl", "svg",
  "json", "jsonl", "ndjson", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
  "diff", "patch", "gradle", "cmake", "mk", "dockerfile", "makefile", "properties",
]);

/** Names that are code without needing an extension to say so. */
const CODE_BASENAMES = new Set([
  "makefile", "dockerfile", "rakefile", "gemfile", "procfile", "brewfile",
  "cargo.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", ".gitignore",
  ".dockerignore", ".npmrc", ".editorconfig",
]);

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx"]);

const DIAGRAM_EXTENSIONS = new Set<string>(DIAGRAM_FILE_EXTENSIONS);

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff", "tif", "avif", "heic", "heif", "svgz",
]);

/**
 * Extensions that carry their own MIME type, for a file found on disk rather than uploaded.
 *
 * A superset of the upload list in spirit and not in fact: an archive, a font and a video have
 * no MIME the upload route accepts and every one of them can sit in a workspace directory.
 * Anything absent falls to `application/octet-stream`, which is the honest answer.
 */
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", tiff: "image/tiff",
  avif: "image/avif", heic: "image/heic",
  txt: "text/plain", log: "text/plain", csv: "text/csv", tsv: "text/tab-separated-values",
  md: "text/markdown", markdown: "text/markdown", mdx: "text/markdown",
  html: "text/html", htm: "text/html", css: "text/css", xml: "text/xml",
  json: "application/json", jsonl: "application/x-ndjson",
  js: "application/javascript", mjs: "application/javascript", cjs: "application/javascript",
  ts: "application/typescript", tsx: "application/typescript",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
  "7z": "application/x-7z-compressed", rar: "application/vnd.rar",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac",
  m4a: "audio/mp4", aac: "audio/aac",
  mp4: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo",
  mkv: "video/x-matroska", webm: "video/webm",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  sqlite: "application/vnd.sqlite3", db: "application/vnd.sqlite3",
  wasm: "application/wasm", class: "application/java-vm", jar: "application/java-archive",
  exe: "application/x-msdownload",
  mmd: "text/x-mermaid", mermaid: "text/x-mermaid",
};

/** The extension of a name, lowercased, without the dot. `""` when there is none. */
export function extensionOf(name: string): string {
  return extname(name).slice(1).toLowerCase();
}

/**
 * The MIME type to record for a name, when the caller has not got a better one.
 *
 * A caller *with* a better one passes it: an upload knows what the browser said, and a fetched
 * page knows it was HTML whatever the URL's tail looks like.
 */
export function mimeForName(name: string, mimeType?: string): string {
  if (mimeType && mimeType !== "application/octet-stream") return mimeType;
  return MIME_BY_EXT[extensionOf(name)] ?? "application/octet-stream";
}

/**
 * The category a name and MIME type describe.
 *
 * Order matters, and the first two arms are the ones that must not be reordered. A `page` is
 * only ever decided by its *origin* — a fetched URL — never by a name, so an `.html` file in a
 * workspace is code rather than a page; and the document arm is asked before the binary
 * catch-all so a `.pdf` is a document rather than "other".
 */
export function categoryFor(name: string, mimeType?: string): FileCategory {
  const mime = mimeForName(name, mimeType);
  const ext = extensionOf(name);

  if (mime.startsWith("image/") || IMAGE_EXTENSIONS.has(ext)) return "image";
  if (isDocumentMime(mime)) return "document";
  if (DIAGRAM_EXTENSIONS.has(ext)) return "diagram";
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (CODE_EXTENSIONS.has(ext)) return "code";
  if (!ext && CODE_BASENAMES.has(name.toLowerCase())) return "code";
  if (mime.startsWith("text/")) return "text";
  if (ext === "") return "text";
  return "other";
}

/**
 * Both answers at once, for the two callers that always want both.
 *
 * The MIME comes back resolved rather than as it arrived, so a caller that only had a filename
 * stores a real type instead of an empty string it would then have to remember to fill in.
 */
export function classifyFile(
  name: string,
  mimeType?: string
): { category: FileCategory; mimeType: string } {
  const mime = mimeForName(name, mimeType);
  return { category: categoryFor(name, mime), mimeType: mime };
}
