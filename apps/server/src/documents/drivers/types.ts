import type { DocumentParserKind } from "@ilearnassist/shared";

/** A configured parser record, as the drivers see it (includes the key). */
export interface DriverConfig {
  id: string;
  name: string;
  baseURL: string;
  apiKey?: string;
}

export interface ParseRequest {
  /** Absolute path to the stored bytes. */
  path: string;
  /** Original filename — some services key behaviour off the extension. */
  name: string;
  mimeType: string;
  size: number;
}

export interface DriverResult {
  text: string;
  pageCount?: number;
}

/** Knobs the async drivers need, sourced from config so tests can shrink them. */
export interface DriverTuning {
  /** Per-request budget for a single HTTP call. */
  requestTimeoutMs: number;
  /** Total budget for an async job, polling included. */
  jobTimeoutMs: number;
  pollIntervalMs: number;
}

/**
 * One wire protocol. A driver is bound to a closed `kind`, while the endpoint and
 * credential come from the user's record — so two `mineru` records can point at the
 * hosted service and a self-hosted box without a second implementation.
 */
export interface ParseDriver {
  kind: DocumentParserKind;
  /** Shown in the settings form. */
  label: string;
  requiresApiKey: boolean;
  defaultBaseURL?: string;
  /** Where to send a user who needs a credential. */
  helpURL?: string;
  /** Extract text from one file. Throws `ParseError` on any failure. */
  parse(req: ParseRequest, cfg: DriverConfig, tuning: DriverTuning, signal: AbortSignal): Promise<DriverResult>;
  /**
   * A cheap round trip proving the endpoint is reachable and the credential is accepted.
   * Throws `ParseError` with `cloud_auth` when the key is rejected.
   */
  probe(cfg: DriverConfig, tuning: DriverTuning, signal: AbortSignal): Promise<void>;
}
