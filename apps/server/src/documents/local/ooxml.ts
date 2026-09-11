import { promises as fs } from "node:fs";
import { strFromU8, unzipSync } from "fflate";
import { ParseError } from "../errors.js";

/**
 * Text extraction for Office/OpenDocument files.
 *
 * `.docx`/`.xlsx`/`.pptx`/`.odt`/`.ods` are ZIP archives of XML, so pulling text out needs
 * a ZIP reader and an XML walk — not an OCR stack. `officeparser` was the obvious
 * dependency here, but it drags in `tesseract.js` (17 MB) plus `@napi-rs/canvas` (2 × 12 MB
 * of native binaries) and a second copy of `pdfjs-dist`, for OCR of embedded images that
 * this feature does not do. `fflate` is ~30 KB of pure JS and has no install scripts,
 * which keeps the "no native addons beyond better-sqlite3" property intact.
 *
 * Extraction is deliberately structural, not faithful: paragraphs become newlines, Excel
 * rows become tab-separated lines. Layout, styling and embedded images are dropped — the
 * consumer is a language model reading for meaning, not a renderer.
 */

/** `w:t` → `t`, `text:p` → `p`: the namespace prefix never carries the meaning we need. */
function localName(tag: string): string {
  const colon = tag.indexOf(":");
  return colon === -1 ? tag : tag.slice(colon + 1);
}

const ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

function decodeXml(text: string): string {
  return text.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z]+);/g, (whole, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity.startsWith("#x") || entity.startsWith("#X")
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/** One tag or one run of text. Attribute values are skipped: `>` must be escaped in XML. */
const TOKEN = /<(\/?)([A-Za-z0-9_:.-]+)([^>]*?)(\/?)>|([^<]+)/g;

/**
 * Remove constructs that are not elements: the XML declaration, processing instructions,
 * comments and the doctype.
 *
 * They matter because the tokenizer below skips `<` and then matches the rest of the
 * construct as *text* — `<?xml version="1.0"?>` matches neither alternative at the `<`,
 * so the scanner resumes at `?xml` and emits the declaration as document content. In
 * `textMode: "any"` (every OpenDocument file, which all start with a declaration) that
 * put `?xml version="1.0"?>` at the top of every extracted text.
 */
function stripNonElements(xml: string): string {
  return xml
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<![^>]*>/g, "");
}

interface FlattenOptions {
  /**
   * `explicit` — only text inside a `<t>` element counts (all the OOXML formats).
   * `any`      — every text node counts (OpenDocument puts body text straight inside
   *              `<text:p>` with no wrapper element).
   */
  textMode: "explicit" | "any";
}

const TEXT_LOCAL = "t";
const PARA_LOCAL = new Set(["p", "h"]);

/**
 * Flatten an XML part to plain text. Paragraph boundaries become newlines; every other
 * tag is dropped, so list items, table cells and text runs all survive as prose.
 */
export function flattenXml(rawXml: string, options: FlattenOptions): string {
  const xml = stripNonElements(rawXml);
  const out: string[] = [];
  let textDepth = 0;
  let m: RegExpExecArray | null;

  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(xml)) !== null) {
    const [, closing, rawName, , selfClosing, text] = m;

    if (text !== undefined) {
      if (options.textMode === "any" || textDepth > 0) out.push(decodeXml(text));
      continue;
    }

    const name = localName(rawName!);

    if (selfClosing) {
      // Explicit breaks, so a paragraph's internal line structure is not lost.
      if (name === "br" || name === "line-break") out.push("\n");
      else if (name === "tab") out.push("\t");
      else if (name === "s") out.push(" ");
      continue;
    }

    if (closing) {
      if (options.textMode === "explicit" && name === TEXT_LOCAL) {
        textDepth = Math.max(0, textDepth - 1);
      } else if (PARA_LOCAL.has(name)) {
        out.push("\n");
      }
      continue;
    }

    if (options.textMode === "explicit" && name === TEXT_LOCAL) textDepth += 1;
  }

  return out
    .join("")
    // Collapse the runs of blank lines that nested containers produce, but keep the
    // paragraph break itself — it is the only structure left.
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Inflate only the archive members we actually read. */
function readZip(archive: Buffer, want: (name: string) => boolean): Record<string, Uint8Array> {
  try {
    return unzipSync(new Uint8Array(archive), { filter: (file) => want(file.name) });
  } catch (err) {
    throw new ParseError("corrupt", err instanceof Error ? err.message : String(err));
  }
}

function decodePart(files: Record<string, Uint8Array>, name: string): string | undefined {
  const bytes = files[name];
  return bytes ? strFromU8(bytes) : undefined;
}

/** `slide2.xml` before `slide10.xml` — lexicographic order gets that backwards. */
function naturalEntryOrder(a: string, b: string): number {
  const num = (s: string) => Number.parseInt(s.match(/(\d+)\.xml$/)?.[1] ?? "0", 10);
  return num(a) - num(b);
}

/* ------------------------------------ docx ------------------------------------ */

function parseDocx(archive: Buffer): string {
  const files = readZip(archive, (name) => name === "word/document.xml");
  const body = decodePart(files, "word/document.xml");
  if (!body) throw new ParseError("corrupt", "docx archive has no word/document.xml");
  return flattenXml(body, { textMode: "explicit" });
}

/* ------------------------------------ pptx ------------------------------------ */

function parsePptx(archive: Buffer): string {
  const files = readZip(archive, (name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  const names = Object.keys(files).sort(naturalEntryOrder);
  if (names.length === 0) throw new ParseError("corrupt", "pptx archive has no slides");

  return names
    .map((name, i) => {
      const body = flattenXml(strFromU8(files[name]!), { textMode: "explicit" });
      return `==== Slide ${i + 1} ====\n\n${body}`;
    })
    .join("\n\n")
    .trim();
}

/* ------------------------------------ xlsx ------------------------------------ */

/** A cell holds an index into this table rather than the string itself. */
function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const out: string[] = [];
  const re = /<si\b[^>]*?(\/>|>([\s\S]*?)<\/si>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1] === "/>" ? "" : flattenXml(m[2]!, { textMode: "explicit" }));
  }
  return out;
}

const CELL = /<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;
const ROW = /<row\b[^>]*?(\/>|>([\s\S]*?)<\/row>)/g;

function parseSheet(xml: string, shared: string[]): string {
  const lines: string[] = [];
  ROW.lastIndex = 0;
  let row: RegExpExecArray | null;

  while ((row = ROW.exec(xml)) !== null) {
    if (row[1] === "/>") {
      lines.push("");
      continue;
    }

    const cells: string[] = [];
    CELL.lastIndex = 0;
    let cell: RegExpExecArray | null;
    while ((cell = CELL.exec(row[2]!)) !== null) {
      if (cell[1] === "/>") {
        cells.push("");
        continue;
      }
      const attrs = cell[1] ?? "";
      const body = cell[3] ?? "";
      const type = /\bt="([^"]*)"/.exec(attrs)?.[1];

      if (type === "inlineStr") {
        cells.push(flattenXml(body, { textMode: "explicit" }));
        continue;
      }
      const value = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
      if (value === undefined) {
        cells.push("");
      } else if (type === "s") {
        cells.push(shared[Number.parseInt(value, 10)] ?? "");
      } else {
        cells.push(decodeXml(value));
      }
    }

    // Trailing empty cells are noise; a row of them is a deliberate blank line.
    while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
    lines.push(cells.join("\t"));
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function parseXlsx(archive: Buffer): string {
  const files = readZip(
    archive,
    (name) => name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(name)
  );
  const sheetNames = Object.keys(files)
    .filter((n) => n.startsWith("xl/worksheets/"))
    .sort(naturalEntryOrder);
  if (sheetNames.length === 0) throw new ParseError("corrupt", "xlsx archive has no sheets");

  const shared = parseSharedStrings(decodePart(files, "xl/sharedStrings.xml"));

  const sections = sheetNames.map((name, i) => {
    const body = parseSheet(strFromU8(files[name]!), shared);
    return `==== Sheet ${i + 1} ====\n\n${body}`;
  });

  // Two sheets is normal; dumping empty separators for a one-sheet workbook is not.
  return sheetNames.length === 1
    ? sections[0]!
    : sections.join("\n\n").trim();
}

/* ------------------------------------ odt / ods ------------------------------------ */

function parseOpenDocument(archive: Buffer): string {
  const files = readZip(archive, (name) => name === "content.xml");
  const body = decodePart(files, "content.xml");
  if (!body) throw new ParseError("corrupt", "OpenDocument archive has no content.xml");
  // Body text sits directly in <text:p>, with no <t> wrapper — hence `any`.
  return flattenXml(body, { textMode: "any" });
}

/* ------------------------------------ dispatch ------------------------------------ */

export async function parseOfficeLocal(path: string, format: string): Promise<string> {
  const archive = await fs.readFile(path);
  switch (format) {
    case "docx":
      return parseDocx(archive);
    case "pptx":
      return parsePptx(archive);
    case "xlsx":
      return parseXlsx(archive);
    case "odt":
    case "ods":
      return parseOpenDocument(archive);
    default:
      throw new ParseError("unsupported_type", `No local extractor for "${format}".`);
  }
}
