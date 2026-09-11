import { strToU8, zipSync } from "fflate";

/**
 * Minimal Office/OpenDocument archives, built in memory.
 *
 * Same reasoning as `buildPdf` in `src/documents/sample.ts`: a committed binary fixture is
 * opaque, and the text a test asserts on should be visible in the test. These archives are
 * deliberately incomplete — they contain only the parts the extractor reads, which is also
 * what makes them useful as a spec of that behaviour.
 */

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

function zip(files: Record<string, string>): Buffer {
  const encoded: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) encoded[name] = strToU8(content);
  return Buffer.from(zipSync(encoded));
}

/** Paragraphs become separate `<w:p>` runs, so newline handling is exercised. */
export function buildDocx(paragraphs: readonly string[]): Buffer {
  const body = paragraphs
    .map((text) => `<w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p>`)
    .join("");
  return zip({
    "word/document.xml": `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
  });
}

export function buildPptx(slides: readonly string[]): Buffer {
  const files: Record<string, string> = {};
  slides.forEach((text, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] =
      `<?xml version="1.0"?><p:sld ${P} ${A}><p:cSld><p:spTree><p:sp><p:txBody>` +
      `<a:p><a:r><a:t>${escapeXml(text)}</a:t></a:r></a:p>` +
      `</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  });
  return zip(files);
}

/**
 * Cell values live in `sharedStrings.xml` and the sheet holds indexes into it — modelling
 * that indirection is the whole point, since it is where a naive extractor gets it wrong.
 */
export function buildXlsx(rows: readonly (readonly string[])[]): Buffer {
  const strings: string[] = [];
  const indexOf = (value: string): number => {
    const existing = strings.indexOf(value);
    if (existing !== -1) return existing;
    strings.push(value);
    return strings.length - 1;
  };

  const rowXml = rows
    .map((cells) => {
      const cellXml = cells
        .map((value) => `<c t="s"><v>${indexOf(value)}</v></c>`)
        .join("");
      return `<row>${cellXml}</row>`;
    })
    .join("");

  return zip({
    "xl/sharedStrings.xml":
      `<?xml version="1.0"?><sst>` +
      strings.map((s) => `<si><t>${escapeXml(s)}</t></si>`).join("") +
      `</sst>`,
    "xl/worksheets/sheet1.xml":
      `<?xml version="1.0"?><worksheet><sheetData>${rowXml}</sheetData></worksheet>`,
  });
}

/** ODF puts body text directly inside `<text:p>`, with no `<t>` wrapper element. */
export function buildOdt(paragraphs: readonly string[]): Buffer {
  const body = paragraphs
    .map((text) => `<text:p>${escapeXml(text)}</text:p>`)
    .join("");
  return zip({
    "content.xml":
      `<?xml version="1.0"?>` +
      `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ` +
      `xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">` +
      `<office:body><office:text>${body}</office:text></office:body>` +
      `</office:document-content>`,
  });
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
