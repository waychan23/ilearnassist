/**
 * Which attachment types carry extractable text, and which local extractor handles them.
 *
 * This deliberately does *not* extend `isTextLike()` in `attachments.ts`. Text-like files
 * are inlined verbatim; documents go through parsing, and conflating the two would make a
 * PDF take the "read it as utf8" branch. Two separate questions, two separate predicates.
 */

export type DocumentFormat = "pdf" | "docx" | "xlsx" | "pptx" | "odt" | "ods";

const FORMAT_BY_MIME: Record<string, DocumentFormat> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
};

/** Human labels, used in errors and the UI. */
export const FORMAT_LABEL: Record<DocumentFormat, string> = {
  pdf: "PDF",
  docx: "Word",
  xlsx: "Excel",
  pptx: "PowerPoint",
  odt: "OpenDocument 文本",
  ods: "OpenDocument 表格",
};

export function documentFormatFor(mimeType: string): DocumentFormat | undefined {
  return FORMAT_BY_MIME[mimeType];
}

export function isDocumentMime(mimeType: string): boolean {
  return mimeType in FORMAT_BY_MIME;
}
