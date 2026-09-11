import type { DocumentParserKind, DriverInfo } from "@guided-learning/shared";
import { isDocumentMime } from "../formats.js";
import { llamaparseDriver } from "./llamaparse.js";
import { mineruDriver } from "./mineru.js";
import { syncDriver } from "./sync.js";
import type { ParseDriver } from "./types.js";

export type { DriverConfig, DriverResult, DriverTuning, ParseDriver, ParseRequest } from "./types.js";
export { sleep } from "./async.js";
export type { DriverInfo } from "@guided-learning/shared";

/**
 * The closed set of supported protocols.
 *
 * `kind` names a wire protocol, not a vendor: adding a service that speaks one of these
 * needs no code, and adding a genuinely new protocol means one file here plus a new
 * `DocumentParserKind`. That split is what lets the settings screen treat parsers as
 * ordinary user-managed records with a `baseURL` and a key.
 */
export const DRIVERS: Record<DocumentParserKind, ParseDriver> = {
  sync: syncDriver,
  mineru: mineruDriver,
  llamaparse: llamaparseDriver,
};

export const DRIVER_KINDS = Object.keys(DRIVERS) as DocumentParserKind[];

export function isDocumentParserKind(value: unknown): value is DocumentParserKind {
  return typeof value === "string" && value in DRIVERS;
}

export function driverFor(kind: DocumentParserKind): ParseDriver {
  return DRIVERS[kind];
}

/**
 * Metadata for the settings form: which kinds exist, what they need, and where to get a
 * credential. Served through the API so the UI never hard-codes the driver list.
 */
export function driverInfos(): DriverInfo[] {
  return DRIVER_KINDS.map((kind) => {
    const driver = DRIVERS[kind];
    return {
      kind,
      label: driver.label,
      requiresApiKey: driver.requiresApiKey,
      defaultBaseURL: driver.defaultBaseURL,
      helpURL: driver.helpURL,
    };
  });
}

/**
 * Whether a document parser is even applicable, and why not if it isn't.
 *
 * Text-like files never reach a parser (they are inlined verbatim), and neither do images
 * — those go to the model as multimodal content. Only the formats with a real extractor
 * are candidates, which keeps the cloud round-trip off the path for everything else.
 */
export function isParseableAttachment(mimeType: string): boolean {
  return isDocumentMime(mimeType);
}
