/**
 * Custom error classes for BuildToolsAPI.
 *
 * Hierarchy:
 *   BuildToolsAuthError    – authentication / session failures
 *   BuildToolsClientError  – 4xx HTTP responses
 *   BuildToolsServerError  – 5xx HTTP responses
 *   BuildToolsNetworkError – network-level failures (DNS, TLS, ECONNREFUSED, timeout)
 */

export class BuildToolsAuthError extends Error {
  override readonly name = "BuildToolsAuthError";

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, BuildToolsAuthError.prototype);
  }
}

export class BuildToolsClientError extends Error {
  override readonly name = "BuildToolsClientError";
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.status = status;
    this.body = body;
    Object.setPrototypeOf(this, BuildToolsClientError.prototype);
  }
}

export class BuildToolsServerError extends Error {
  override readonly name = "BuildToolsServerError";
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.status = status;
    this.body = body;
    Object.setPrototypeOf(this, BuildToolsServerError.prototype);
  }
}

export class BuildToolsNetworkError extends Error {
  override readonly name = "BuildToolsNetworkError";

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    Object.setPrototypeOf(this, BuildToolsNetworkError.prototype);
  }
}
