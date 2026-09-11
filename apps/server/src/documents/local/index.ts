import { ParseError } from "../errors.js";
import { documentFormatFor } from "../formats.js";
import { parseOfficeLocal } from "./ooxml.js";
import { parsePdfLocal } from "./pdf.js";

export interface LocalParseInput {
  path: string;
  mimeType: string;
  size: number;
  /** Above this, skip extraction rather than stalling the parser on a huge file. */
  maxBytes: number;
}

export interface LocalParseResult {
  text: string;
  pageCount?: number;
}

/**
 * Extract text with the in-process extractors.
 *
 * Refusing oversize files here is not just a guard against slow work: it is what makes
 * `too_large` a *recoverable* failure, so the policy can hand the file to a cloud parser
 * whose ceiling is an order of magnitude higher.
 */
export async function parseLocal(input: LocalParseInput): Promise<LocalParseResult> {
  const format = documentFormatFor(input.mimeType);
  if (!format) {
    throw new ParseError("unsupported_type", `No local extractor for ${input.mimeType}.`);
  }
  if (input.size > input.maxBytes) {
    throw new ParseError(
      "too_large",
      `File is ${input.size} bytes, over the ${input.maxBytes}-byte local parsing limit.`
    );
  }

  const result =
    format === "pdf"
      ? await parsePdfLocal(input.path)
      : { text: await parseOfficeLocal(input.path, format) };

  // An empty result means the extractor found no text layer, not that the file is empty
  // — the overwhelmingly common cause is a scanned PDF. Reporting it distinctly lets the
  // policy retry against an OCR-capable cloud parser.
  if (!result.text.trim()) {
    throw new ParseError("no_text_layer", `${format} extraction produced no text.`);
  }

  return result;
}
