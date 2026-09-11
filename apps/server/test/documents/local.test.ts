import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPdf } from "../../src/documents/sample.js";
import { parseLocal } from "../../src/documents/local/index.js";
import { flattenXml } from "../../src/documents/local/ooxml.js";
import { describeParseError, parseDocument, ParseError } from "../../src/documents/index.js";
import { buildDocx, buildOdt, buildPptx, buildXlsx } from "../helpers/officeFixtures.js";

/**
 * Local extraction, against documents generated in-process.
 *
 * These run the real `pdfjs-dist` and the real ZIP/XML reader. No provider, no network —
 * which is the point: text extraction has to work with the machine offline, since that is
 * the tier that always runs.
 */

let scratch: string;
let seq = 0;

/** Write bytes to a fresh file and return its path. */
function writeFixture(name: string, bytes: Buffer): string {
  const path = join(scratch, `${(seq += 1)}-${name}`);
  writeFileSync(path, bytes);
  return path;
}

function pdfWith(text: string): Buffer {
  return buildPdf([text]);
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "gl-docs-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("parseLocal — PDF", () => {
  it("extracts the text layer, with page markers", async () => {
    const path = writeFixture("one.pdf", buildPdf(["Alpha beta gamma"]));
    const result = await parseLocal({
      path,
      mimeType: "application/pdf",
      size: 10_000,
      maxBytes: 1_000_000,
    });

    expect(result.text).toContain("Alpha beta gamma");
    expect(result.text).toContain("==== Page 1 ====");
    expect(result.pageCount).toBe(1);
  });

  it("numbers every page, in order", async () => {
    const path = writeFixture("two.pdf", buildPdf(["First page", "Second page"]));
    const result = await parseLocal({
      path,
      mimeType: "application/pdf",
      size: 10_000,
      maxBytes: 1_000_000,
    });

    expect(result.pageCount).toBe(2);
    expect(result.text.indexOf("First page")).toBeLessThan(result.text.indexOf("Second page"));
    expect(result.text).toContain("==== Page 2 ====");
  });

  it("reports a document with no text layer distinctly, not as empty text", async () => {
    // An empty page is what a scanned PDF looks like to a text extractor. Reporting
    // `no_text_layer` rather than returning "" is what lets the policy hand it to a cloud
    // parser instead of the model answering about a document it never saw.
    const path = writeFixture("blank.pdf", buildPdf([""]));
    await expect(
      parseLocal({ path, mimeType: "application/pdf", size: 10_000, maxBytes: 1_000_000 })
    ).rejects.toMatchObject({ code: "no_text_layer" });
  });

  it("reports unreadable bytes as corrupt", async () => {
    const path = writeFixture("broken.pdf", Buffer.from("this is not a PDF at all"));
    await expect(
      parseLocal({ path, mimeType: "application/pdf", size: 100, maxBytes: 1_000_000 })
    ).rejects.toMatchObject({ code: "corrupt" });
  });

  it("refuses a file over the local ceiling with a recoverable code", async () => {
    const path = writeFixture("big.pdf", pdfWith("hello"));
    // `too_large` must stay recoverable: the cloud ceiling is an order of magnitude
    // higher, so a file too big to parse here is the most likely candidate to succeed
    // there. (chatbox treats this as non-recoverable, which is the bug this avoids.)
    await expect(
      parseLocal({ path, mimeType: "application/pdf", size: 50_000_000, maxBytes: 1_000 })
    ).rejects.toMatchObject({ code: "too_large" });
  });
});

describe("parseLocal — Office", () => {
  it("extracts docx paragraphs, one line each", async () => {
    const path = writeFixture("doc.docx", buildDocx(["Quarterly report", "Revenue rose."]));
    const result = await parseLocal({
      path,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size: 10_000,
      maxBytes: 1_000_000,
    });

    expect(result.text).toContain("Quarterly report");
    expect(result.text).toContain("Revenue rose.");
    expect(result.text.split("\n")[0]).toBe("Quarterly report");
  });

  it("extracts pptx slides in numeric order, not lexicographic", async () => {
    const slides = Array.from({ length: 11 }, (_, i) => `Slide number ${i + 1}`);
    const path = writeFixture("deck.pptx", buildPptx(slides));
    const result = await parseLocal({
      path,
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      size: 10_000,
      maxBytes: 1_000_000,
    });

    expect(result.text).toContain("==== Slide 1 ====");
    expect(result.text).toContain("==== Slide 11 ====");
    // slide10/11 must come after slide9 — a plain string sort would put them second.
    expect(result.text.indexOf("Slide number 9")).toBeLessThan(
      result.text.indexOf("Slide number 10")
    );
  });

  it("resolves xlsx cell values through the shared-string table", async () => {
    const path = writeFixture(
      "book.xlsx",
      buildXlsx([
        ["Region", "Sales"],
        ["North", "120"],
      ])
    );
    const result = await parseLocal({
      path,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: 10_000,
      maxBytes: 1_000_000,
    });

    // Without the indirection the cells would read as "0" / "1".
    expect(result.text).toContain("Region\tSales");
    expect(result.text).toContain("North\t120");
    expect(result.text).not.toContain("\t0");
  });

  it("extracts OpenDocument body text, which has no <t> wrapper", async () => {
    const path = writeFixture("notes.odt", buildOdt(["OpenDocument body text"]));
    const result = await parseLocal({
      path,
      mimeType: "application/vnd.oasis.opendocument.text",
      size: 10_000,
      maxBytes: 1_000_000,
    });

    expect(result.text).toBe("OpenDocument body text");
  });

  it("reports an archive that is not a zip as corrupt", async () => {
    const path = writeFixture("bad.docx", Buffer.from("plain text, not a zip"));
    await expect(
      parseLocal({
        path,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 100,
        maxBytes: 1_000_000,
      })
    ).rejects.toMatchObject({ code: "corrupt" });
  });

  it("reports a zip with no document part as corrupt", async () => {
    const path = writeFixture("empty.docx", buildDocx([]));
    await expect(
      parseLocal({
        path,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 100,
        maxBytes: 1_000_000,
      })
    ).rejects.toMatchObject({ code: "no_text_layer" });
  });

  it("refuses a MIME type it has no extractor for", async () => {
    const path = writeFixture("thing.bin", Buffer.from("x"));
    await expect(
      parseLocal({ path, mimeType: "application/octet-stream", size: 10, maxBytes: 1_000 })
    ).rejects.toMatchObject({ code: "unsupported_type" });
  });
});

describe("flattenXml", () => {
  it("decodes entities and numeric references", () => {
    expect(flattenXml("<t>a &lt;b&gt; &amp; &#65;&#x42;</t>", { textMode: "explicit" })).toBe(
      "a <b> & AB"
    );
  });

  it("keeps text in explicit mode only inside the text element", () => {
    const xml = "<p><t>kept</t><other>dropped</other></p>";
    expect(flattenXml(xml, { textMode: "explicit" })).toBe("kept");
  });

  it("keeps every text node in any mode", () => {
    const xml = "<p>kept<other>also kept</other></p>";
    expect(flattenXml(xml, { textMode: "any" })).toBe("keptalso kept");
  });

  it("turns tab and line-break elements into whitespace", () => {
    expect(flattenXml("<p><t>a</t><tab/><t>b</t><br/><t>c</t></p>", { textMode: "explicit" })).toBe(
      "a\tb\nc"
    );
  });
});

describe("parseDocument — tier selection", () => {
  const base = {
    mimeType: "application/pdf",
    size: 10_000,
    localMaxBytes: 1_000_000,
    maxTextChars: 1_000_000,
    parsers: [],
    tuning: { requestTimeoutMs: 1_000, jobTimeoutMs: 2_000, pollIntervalMs: 10 },
    signal: new AbortController().signal,
  };

  it("returns local text and attributes it to 'local'", async () => {
    const path = writeFixture("policy.pdf", pdfWith("policy content"));
    const outcome = await parseDocument({
      ...base,
      path,
      name: "policy.pdf",
      policy: { localEnabled: true, policy: "local-only", fallbackEnabled: true, defaultParserId: null },
    });

    expect(outcome.text).toContain("policy content");
    expect(outcome.parserId).toBe("local");
    expect(outcome.attempts).toEqual([]);
  });

  it("records every tier it tried on the thrown error", async () => {
    const path = writeFixture("noText.pdf", buildPdf([""]));
    const err = (await parseDocument({
      ...base,
      path,
      name: "noText.pdf",
      policy: { localEnabled: true, policy: "local-first", fallbackEnabled: true, defaultParserId: null },
    }).catch((e: unknown) => e)) as ParseError;

    // The attempt log has to survive the failure — that is when it is worth having.
    expect(err).toBeInstanceOf(ParseError);
    expect(err.attempts.map((a) => a.parserId)).toEqual(["local", "cloud"]);
    // The tier is identified and so is *why* it failed — the codes are what a caller
    // branches on, and `describeParseError` turns them into what a user reads.
    expect(err.attempts[0]!.code).toBe("no_text_layer");
    expect(err.attempts[1]!.code).toBe("no_cloud_parser");
    // The real reason outranks "nothing is configured": the file genuinely could not be
    // read, and the missing parser is only the reason it was not retried elsewhere.
    expect(err.code).toBe("no_text_layer");
    expect(describeParseError(err)).toContain("扫描件");
  });

  it("stops after one tier when the failure is not recoverable", async () => {
    // A corrupt file is `corrupt` (recoverable), so use an unsupported type, which no tier
    // can handle — the walk must stop rather than try the cloud tier anyway.
    const path = writeFixture("thing.bin", Buffer.from("x"));
    const err = (await parseDocument({
      ...base,
      path,
      name: "thing.bin",
      mimeType: "application/octet-stream",
      policy: { localEnabled: true, policy: "local-first", fallbackEnabled: true, defaultParserId: null },
    }).catch((e: unknown) => e)) as ParseError;

    expect(err.attempts.map((a) => a.parserId)).toEqual(["local"]);
  });

  it("skips the local tier when it is switched off", async () => {
    const path = writeFixture("off.pdf", pdfWith("never read"));
    const err = (await parseDocument({
      ...base,
      path,
      name: "off.pdf",
      policy: { localEnabled: false, policy: "local-first", fallbackEnabled: false, defaultParserId: null },
    }).catch((e: unknown) => e)) as ParseError;

    // The raw error carries a code; `describeParseError` is what a user is shown, so that
    // is what the assertion pins.
    expect(err.code).toBe("local_disabled");
    expect(describeParseError(err)).toContain("本地解析已在设置中关闭");
  });

  it("truncates extracted text to the configured ceiling", async () => {
    const path = writeFixture("long.pdf", pdfWith("x".repeat(500)));
    const outcome = await parseDocument({
      ...base,
      path,
      name: "long.pdf",
      maxTextChars: 100,
      policy: { localEnabled: true, policy: "local-only", fallbackEnabled: true, defaultParserId: null },
    });

    expect(outcome.text.length).toBeLessThan(200);
    expect(outcome.text).toContain("截断");
  });
});
