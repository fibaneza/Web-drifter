/** Error taxonomy. Exit codes: 0 clean, 1 findings over budget, 2 tool failure. */

export class DrifterError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The user's config file is missing, unparseable, or fails schema validation. */
export class ConfigError extends DrifterError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'E_CONFIG', options);
  }
}

/** A page could not be captured (navigation failure, timeout, browser crash). */
export class CaptureError extends DrifterError {
  constructor(
    message: string,
    readonly url: string,
    options?: { cause?: unknown },
  ) {
    super(message, 'E_CAPTURE', options);
  }
}

/** The on-disk artifact store is missing, corrupt, or of an incompatible version. */
export class StoreError extends DrifterError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'E_STORE', options);
  }
}

/** No usable Chromium could be located. */
export class BrowserError extends DrifterError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'E_BROWSER', options);
  }
}

export function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
