import { promises as fs } from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { ParseError } from "../errors.js";

/**
 * PDF text extraction with `pdfjs-dist`.
 *
 * The **legacy** build is the one that runs outside a browser: it needs no DOM and no
 * worker thread, which is what lets this run inside a Fastify request. `pdfjs-dist@4` is
 * pinned deliberately — 5.7+ and 6.x require Node ≥ 22.13, while this project supports
 * Node ≥ 20 (see the `engines` field in the root `package.json`).
 *
 * Extraction is text-layer only. A scanned PDF has no text layer and yields nothing,
 * which is reported as `no_text_layer` rather than an empty string — the parse policy
 * then hands those files to a cloud parser, and the UI can say something useful. Silently
 * returning "" would let the model answer questions about a document it never saw.
 */

/** Marker inserted before each page, mirroring the convention chatbox uses. */
function pageMarker(pageNumber: number): string {
  return `==== Page ${pageNumber} ====`;
}

interface TextItemLike {
  str: string;
  hasEOL?: boolean;
}

/** Concatenate a page's text runs, honouring pdfjs's end-of-line hints. */
function pageText(items: readonly unknown[]): string {
  let out = "";
  for (const raw of items) {
    const item = raw as TextItemLike;
    if (typeof item.str !== "string") continue; // marked-content markers carry no text
    out += item.str;
    if (item.hasEOL) out += "\n";
  }
  return out.trim();
}

function isPasswordException(err: unknown): boolean {
  return (err as { name?: string } | undefined)?.name === "PasswordException";
}

export interface LocalTextResult {
  text: string;
  pageCount: number;
}

export async function parsePdfLocal(path: string): Promise<LocalTextResult> {
  const data = new Uint8Array(await fs.readFile(path));

  let doc: pdfjs.PDFDocumentProxy;
  try {
    doc = await pdfjs.getDocument({
      data,
      useSystemFonts: true,
      isEvalSupported: false,
      disableFontFace: true,
      // Keep the library quiet: malformed-font warnings on stderr would otherwise be
      // indistinguishable from real errors in the server log.
      verbosity: 0,
    }).promise;
  } catch (err) {
    if (isPasswordException(err)) {
      throw new ParseError("password_protected", "PDF is encrypted.");
    }
    throw new ParseError("corrupt", err instanceof Error ? err.message : String(err));
  }

  const sections: string[] = [];
  let sawText = false;

  try {
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      try {
        const content = await page.getTextContent();
        // A damaged page yields "" rather than aborting the whole document — losing one
        // page beats losing the file, and the page markers keep the numbering honest.
        const body = pageText(content.items);
        if (body) sawText = true;
        sections.push(`${pageMarker(i)}\n\n${body}`);
      } finally {
        page.cleanup();
      }
    }

    // A document with no text on any page is a scan, not a document whose text is the page
    // markers. Returning the markers would make `parseLocal`'s emptiness check pass and the
    // model would be told it had read a file it never saw — so report nothing instead.
    if (!sawText) return { text: "", pageCount: doc.numPages };

    return { text: sections.join("\n\n").trim(), pageCount: doc.numPages };
  } finally {
    await doc.destroy();
  }
}
