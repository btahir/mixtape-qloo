export type QlooErrorKind =
  | "input"
  | "auth"
  | "permission"
  | "not_found"
  | "rate_limit"
  | "network"
  | "timeout"
  | "cancelled"
  | "upstream"
  | "contract";

export interface QlooErrorDetails {
  status?: number;
  retryable?: boolean;
  retryAfterMs?: number;
  /** Paths and codes only; never upstream payloads, URLs, keys or user values. */
  issues?: readonly { path: string; code: string }[];
}

export class QlooError extends Error {
  readonly name = "QlooError";
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly issues: readonly { path: string; code: string }[] | undefined;
  constructor(
    readonly kind: QlooErrorKind,
    message: string,
    details: QlooErrorDetails = {},
  ) {
    super(message);
    this.status = details.status;
    this.retryable = details.retryable ?? false;
    this.retryAfterMs = details.retryAfterMs;
    this.issues = details.issues;
  }
}

export const inputError = () =>
  new QlooError("input", "Invalid Qloo request or configuration.");
export const cancelledError = () =>
  new QlooError("cancelled", "Qloo request cancelled.");

/** A runtime boundary without a Next.js/server-only dependency. */
export function assertServer(): void {
  if (typeof globalThis === "object" && "window" in globalThis) {
    throw new QlooError("input", "Qloo clients must run on the server.");
  }
}
