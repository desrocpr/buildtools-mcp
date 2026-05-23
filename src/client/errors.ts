/**
 * Custom error classes for BuildToolsAPI.
 *
 * Each error carries a structured `context` field so callers can introspect
 * the failure (status code, validation issues, network cause, etc.) without
 * having to regex error messages.
 */

/** Base class so callers can `instanceof BuildToolsError` to catch any of ours. */
export class BuildToolsError extends Error {
  public readonly context: Record<string, unknown>;

  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = "BuildToolsError";
    this.context = context;
    // Preserve the prototype chain across transpilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Authentication / login flow failure (bad credentials, missing CSRF, etc.). */
export class BuildToolsAuthError extends BuildToolsError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, context);
    this.name = "BuildToolsAuthError";
  }
}

/** Network-layer failure (fetch threw, aborted, DNS, TLS, etc.). */
export class BuildToolsNetworkError extends BuildToolsError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, context);
    this.name = "BuildToolsNetworkError";
  }
}

/** Schema / Zod validation failure on a response payload or an input shape. */
export class BuildToolsValidationError extends BuildToolsError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, context);
    this.name = "BuildToolsValidationError";
  }
}

/** Non-2xx response from the BuildTools server (or unparseable success body). */
export class BuildToolsServerError extends BuildToolsError {
  public readonly status: number | undefined;

  constructor(
    message: string,
    context: Record<string, unknown> & { status?: number } = {},
  ) {
    super(message, context);
    this.name = "BuildToolsServerError";
    this.status = context.status;
  }
}
