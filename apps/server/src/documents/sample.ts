/**
 * A minimal, valid, text-bearing PDF built in memory.
 *
 * Two callers need one: the "test connection" button sends a throwaway document through a
 * parser to prove the round trip works, and the test suite needs PDF bytes without
 * committing a binary fixture. PDF is an ASCII container, so generating one is a few
 * string concatenations — and unlike a checked-in fixture, the text is visible in the
 * source of every test that asserts on it.
 *
 * Deliberately not a general-purpose writer: one font, no compression, no images.
 */

function escapeText(text: string): string {
  return text.replace(/[\\()]/g, (c) => `\\${c}`);
}

/**
 * Break a line at roughly what fits across a Letter page at 14 pt.
 *
 * Wrapping is not cosmetic. pdfjs drops text that falls outside the page box, so a
 * fixture written as one very long `Tj` string loses everything past the right margin —
 * extraction "succeeds" and silently returns a prefix, which is a maddening thing to
 * debug from an assertion that only checks the text is present.
 */
const LINE_CHARS = 76;

function wrap(text: string, width = LINE_CHARS): string[] {
  const lines: string[] = [];
  let rest = text;
  while (rest.length > width) {
    // Break on a space when there is one, so wrapped output still reads as prose.
    const space = rest.lastIndexOf(" ", width);
    const cut = space > 0 ? space : width;
    lines.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^ /, "");
  }
  lines.push(rest);
  return lines;
}

export function buildPdf(pages: readonly string[]): Buffer {
  if (pages.length === 0) throw new Error("A PDF needs at least one page.");

  // Object layout: 1 catalog, 2 page tree, then a (page, content) pair per page, then font.
  const firstPageObj = 3;
  const fontObj = firstPageObj + pages.length * 2;

  const pageRefs = pages.map((_, i) => `${firstPageObj + i * 2} 0 R`).join(" ");

  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>`,
  ];

  pages.forEach((text, i) => {
    const contentObj = firstPageObj + i * 2 + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Contents ${contentObj} 0 R /Resources << /Font << /F1 ${fontObj} 0 R >> >> >>`
    );
    // `TL` sets the leading `T*` uses, so each line lands 16 pt below the previous one.
    const lines = wrap(text);
    const body = lines
      .map((line, index) => `(${escapeText(line)}) Tj${index < lines.length - 1 ? " T*" : ""}`)
      .join("\n");
    const stream = `BT /F1 14 Tf 72 720 Td 16 TL\n${body}\nET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });

  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  // Byte offsets and string indices coincide here only because everything above is ASCII,
  // which `Buffer.from(..., "latin1")` preserves one-for-one. A non-ASCII page text would
  // break the xref table — pdfjs would still recover, but the file would be malformed.
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(out, "latin1");
}

/** The one-page document the connection probe sends. */
export function probePdf(): Buffer {
  return buildPdf(["Guided Learning document parser connection test."]);
}
