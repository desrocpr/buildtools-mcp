/**
 * BuildToolsAPI — typed HTTP client for the BuildTools SaaS platform.
 *
 * Authentication model: session cookie issued by a login-form POST.
 *   authenticate() → POST /login (application/x-www-form-urlencoded)
 *                  → stores Set-Cookie headers in a manual cookie jar
 *   all subsequent requests attach the stored cookies via the Cookie header
 *
 * Resilience: none (retries / back-off deferred to a later phase).
 * Transport:  native global fetch (Node ≥ 18; this project targets Node 22).
 *
 * Endpoint paths are in the ENDPOINTS constant below — edit in one place.
 *
 * TODO(MOS-211): reconcile endpoint paths against API_REFERENCE.md once the
 * reference source (~/code/buildtools/) is available in the build environment.
 */

import { z } from "zod";

import {
  BuildToolsAuthError,
  BuildToolsClientError,
  BuildToolsNetworkError,
  BuildToolsServerError,
} from "./errors.js";
import {
  AttachmentSchema,
  BuildToolsClientOptionsSchema,
  ChangeOrderSchema,
  CustomerSchema,
  FinancialStatementSchema,
  ProjectFiltersSchema,
  ProjectSchema,
  type Attachment,
  type BuildToolsClientOptions,
  type ChangeOrder,
  type Customer,
  type FinancialStatement,
  type Project,
  type ProjectFilters,
} from "./types.js";

// ---------------------------------------------------------------------------
// Endpoint map — change paths here when the real API reference is available
// ---------------------------------------------------------------------------
const ENDPOINTS = {
  login: "/login",
  projects: "/api/projects",
  project: (id: number) => `/api/projects/${id}`,
  projectSearch: "/api/projects/search",
  changeOrders: (projectId: number) =>
    `/api/projects/${projectId}/change-orders`,
  changeOrder: (coId: number) => `/api/change-orders/${coId}`,
  unbilledChangeOrders: "/api/change-orders/unbilled",
  financialStatement: (projectId: number) =>
    `/api/projects/${projectId}/financial-statement`,
  customers: "/api/customers",
  customer: (id: number) => `/api/customers/${id}`,
  attachments: (projectId: number) =>
    `/api/projects/${projectId}/attachments`,
} as const;

const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// BuildToolsAPI
// ---------------------------------------------------------------------------
export class BuildToolsAPI {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly timeoutMs: number;

  /** Manual cookie jar: raw cookie strings collected from Set-Cookie headers. */
  private cookies: string[] = [];
  private authenticated = false;

  constructor(opts: BuildToolsClientOptions) {
    // Validate options at construction time so callers get immediate feedback.
    const parsed = BuildToolsClientOptionsSchema.parse(opts);
    this.baseUrl =
      parsed.baseUrl ?? `https://${parsed.tenant}.buildtools.app`;
    this.username = parsed.username;
    this.password = parsed.password;
    this.timeoutMs = parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  /**
   * Log in via the BuildTools login form and capture the session cookie.
   * Throws BuildToolsAuthError on invalid credentials (non-2xx or redirect
   * to a login-error page).
   */
  async authenticate(): Promise<void> {
    const body = new URLSearchParams({
      username: this.username,
      password: this.password,
    });

    const response = await this.rawFetch(ENDPOINTS.login, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      // Don't follow redirects automatically so we can inspect the response.
      redirect: "manual",
    });

    // The server may redirect (302) to the dashboard on success or back to
    // /login?error on failure.  Both 2xx and 3xx are acceptable here; we
    // check whether we received any cookies.
    if (!response.ok && response.status !== 302 && response.status !== 301) {
      const text = await this.safeText(response);
      throw new BuildToolsAuthError(
        `Authentication failed: HTTP ${response.status} — ${text}`
      );
    }

    const setCookieHeaders = this.extractSetCookieHeaders(response);
    if (setCookieHeaders.length === 0) {
      throw new BuildToolsAuthError(
        "Authentication succeeded (HTTP status OK) but no session cookie was returned. " +
          "The server may have rejected the credentials silently."
      );
    }

    this.cookies = setCookieHeaders;
    this.authenticated = true;
  }

  /** Returns true after a successful authenticate() call. */
  isAuthenticated(): boolean {
    return this.authenticated;
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  async listProjects(filters?: ProjectFilters): Promise<Project[]> {
    const params = filters
      ? buildQueryString(ProjectFiltersSchema.parse(filters))
      : "";
    const url = ENDPOINTS.projects + (params ? `?${params}` : "");
    const data = await this.get(url);
    return parseArrayWith(ProjectSchema, data, "projects");
  }

  async getProject(id: number): Promise<Project | null> {
    const data = await this.get(ENDPOINTS.project(id), true);
    if (data === null) return null;
    return parseSingleWith(ProjectSchema, data, "project");
  }

  async searchProjects(query: string): Promise<Project[]> {
    const params = new URLSearchParams({ q: query });
    const url = `${ENDPOINTS.projectSearch}?${params.toString()}`;
    const data = await this.get(url);
    return parseArrayWith(ProjectSchema, data, "projects");
  }

  // -------------------------------------------------------------------------
  // Change orders
  // -------------------------------------------------------------------------

  async listChangeOrders(projectId: number): Promise<ChangeOrder[]> {
    const data = await this.get(ENDPOINTS.changeOrders(projectId));
    return parseArrayWith(ChangeOrderSchema, data, "change orders");
  }

  async getChangeOrder(coId: number): Promise<ChangeOrder | null> {
    const data = await this.get(ENDPOINTS.changeOrder(coId), true);
    if (data === null) return null;
    return parseSingleWith(ChangeOrderSchema, data, "change order");
  }

  async findUnbilledChangeOrders(): Promise<ChangeOrder[]> {
    const data = await this.get(ENDPOINTS.unbilledChangeOrders);
    return parseArrayWith(ChangeOrderSchema, data, "unbilled change orders");
  }

  // -------------------------------------------------------------------------
  // Financials
  // -------------------------------------------------------------------------

  /** Throws BuildToolsClientError (404) if no financial statement exists. */
  async getFinancialStatement(projectId: number): Promise<FinancialStatement> {
    // Note: intentionally does NOT return null — a missing statement is an
    // error condition for the caller (unlike getProject / getCustomer).
    const data = await this.get(ENDPOINTS.financialStatement(projectId));
    return parseSingleWith(FinancialStatementSchema, data, "financial statement");
  }

  // -------------------------------------------------------------------------
  // Customers
  // -------------------------------------------------------------------------

  async listCustomers(): Promise<Customer[]> {
    const data = await this.get(ENDPOINTS.customers);
    return parseArrayWith(CustomerSchema, data, "customers");
  }

  async getCustomer(id: number): Promise<Customer | null> {
    const data = await this.get(ENDPOINTS.customer(id), true);
    if (data === null) return null;
    return parseSingleWith(CustomerSchema, data, "customer");
  }

  // -------------------------------------------------------------------------
  // Attachments
  // -------------------------------------------------------------------------

  /**
   * @param projectId  Required project ID.
   * @param entityType Optional entity type filter (e.g. "change_order").
   * @param entityId   Optional entity ID filter; only meaningful when entityType is set.
   */
  async listAttachments(
    projectId: number,
    entityType?: string,
    entityId?: number
  ): Promise<Attachment[]> {
    const qp: Record<string, string> = {};
    if (entityType !== undefined) qp["entity_type"] = entityType;
    if (entityId !== undefined) qp["entity_id"] = String(entityId);
    const params = Object.keys(qp).length > 0
      ? "?" + new URLSearchParams(qp).toString()
      : "";
    const url = ENDPOINTS.attachments(projectId) + params;
    const data = await this.get(url);
    return parseArrayWith(AttachmentSchema, data, "attachments");
  }

  // -------------------------------------------------------------------------
  // Private HTTP helpers
  // -------------------------------------------------------------------------

  /**
   * Perform a GET request. By default a 404 throws BuildToolsClientError.
   * Pass `allow404 = true` to receive `null` for missing resources instead.
   */
  private async get(path: string, allow404 = false): Promise<unknown> {
    const response = await this.rawFetch(path, { method: "GET" });

    if (allow404 && response.status === 404) {
      return null;
    }

    await this.throwIfError(response);
    return this.parseJson(response);
  }

  /**
   * Low-level fetch wrapper that:
   *  – prepends baseUrl
   *  – attaches cookies
   *  – enforces a per-request timeout via AbortController
   *  – wraps network-level errors in BuildToolsNetworkError
   */
  private async rawFetch(
    path: string,
    init: RequestInit & { redirect?: RequestRedirect }
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const url = `${this.baseUrl}${path}`;

    const headers = new Headers(init.headers as HeadersInit | undefined);
    if (this.cookies.length > 0) {
      headers.set("Cookie", this.cookies.join("; "));
    }

    try {
      return await fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new BuildToolsNetworkError(
          `Request to ${url} timed out after ${this.timeoutMs}ms`,
          err
        );
      }
      throw new BuildToolsNetworkError(
        `Network error fetching ${url}: ${String(err)}`,
        err
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Inspect a response and throw the appropriate error for 4xx / 5xx.
   * No-op for 2xx.
   */
  private async throwIfError(response: Response): Promise<void> {
    if (response.ok) return;

    const body = await this.safeText(response);
    const { status } = response;

    if (status === 401 || status === 403) {
      throw new BuildToolsAuthError(
        `HTTP ${status} — not authenticated or not authorised. Body: ${body}`
      );
    }

    if (status >= 400 && status < 500) {
      throw new BuildToolsClientError(
        `HTTP ${status} client error. Body: ${body}`,
        status,
        body
      );
    }

    if (status >= 500) {
      throw new BuildToolsServerError(
        `HTTP ${status} server error. Body: ${body}`,
        status,
        body
      );
    }
  }

  /** Safely read response body as text, never throwing. */
  private async safeText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return "(could not read response body)";
    }
  }

  /** Parse JSON response, wrapping ZodError / parse failures in BuildToolsClientError. */
  private async parseJson(response: Response): Promise<unknown> {
    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      throw new BuildToolsNetworkError(
        "Failed to read response body",
        err
      );
    }

    try {
      return JSON.parse(text);
    } catch (err) {
      throw new BuildToolsClientError(
        `Failed to parse JSON response: ${String(err)}`,
        response.status,
        text
      );
    }
  }

  /**
   * Extract Set-Cookie header values from a Response.
   * In Node's native fetch, `response.headers.getSetCookie()` is available on
   * Node 18+ and returns an array; fall back to the legacy `get()` for safety.
   */
  private extractSetCookieHeaders(response: Response): string[] {
    // Node 18+ native fetch exposes getSetCookie() for multi-value headers.
    if (typeof (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function") {
      return (response.headers as unknown as { getSetCookie: () => string[] }).getSetCookie();
    }
    const raw = response.headers.get("set-cookie");
    return raw ? [raw] : [];
  }
}

// ---------------------------------------------------------------------------
// Module-private utilities
// ---------------------------------------------------------------------------

/** Safely parse a single value against a Zod schema, wrapping ZodError. */
function parseSingleWith<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
  label: string
): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new BuildToolsClientError(
      `Response parse error (${label}): ${result.error.message}`,
      200,
      JSON.stringify(data)
    );
  }
  return result.data as z.infer<T>;
}

/** Safely parse an array of values, wrapping ZodError. */
function parseArrayWith<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
  label: string
): Array<z.infer<T>> {
  if (!Array.isArray(data)) {
    // Some APIs wrap arrays in { data: [...] } or { items: [...] }
    if (
      data !== null &&
      typeof data === "object" &&
      ("data" in data || "items" in data)
    ) {
      const wrapper = data as Record<string, unknown>;
      const inner = wrapper["data"] ?? wrapper["items"];
      return parseArrayWith(schema, inner, label);
    }
    throw new BuildToolsClientError(
      `Expected array for ${label}, got ${typeof data}`,
      200,
      JSON.stringify(data)
    );
  }

  const results: Array<z.infer<T>> = [];
  for (const item of data as unknown[]) {
    const result = schema.safeParse(item);
    if (!result.success) {
      throw new BuildToolsClientError(
        `Response parse error (${label} item): ${result.error.message}`,
        200,
        JSON.stringify(item)
      );
    }
    results.push(result.data as z.infer<T>);
  }
  return results;
}

/** Convert a plain object to a URL query string. */
function buildQueryString(params: Record<string, unknown>): string {
  const qp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      qp.set(key, String(value));
    }
  }
  return qp.toString();
}
