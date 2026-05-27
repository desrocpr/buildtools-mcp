/**
 * BuildToolsAPI — TypeScript port of `desrocpr/buildtools` `src/api-client.js`.
 *
 * Source-fidelity port: same method names, same endpoint paths, same
 * form-encoded shapes, same two-host (auth + base) flow, same hostname-keyed
 * cookie jar, same XSRF-TOKEN propagation. The transport is native `fetch`
 * instead of `node:https`, and the redirect-follow loop is implemented
 * manually (rather than letting fetch follow) so that we can re-emit cookies
 * for each hop just like the source did.
 *
 * Intentional deviations from source (documented per the planner contract):
 *
 *   - `authenticate(...)` THROWS `BuildToolsAuthError` instead of returning
 *     `false` and logging. This is cleaner for async/await.
 *   - No `console.log` calls (would corrupt MCP stdio).
 *   - `datatable(...)` uses GET with a query string, which is what the source
 *     actually does (L188–210). The Linear issue description incorrectly says
 *     POST — we follow the source. Noted inline at the helper.
 *
 * Session lifecycle (MOS-212):
 *
 *   - **Credential storage**: one mechanism — credentials are cached on the
 *     instance. They may be seeded via `BuildToolsClientOptions.username`/
 *     `password` (the cleanest path when constructing from `loadConfigFromEnv`)
 *     OR captured by the explicit `authenticate(email, password)` call. The
 *     most-recent value wins. The 2-arg `authenticate(email, password)`
 *     signature remains backward-compatible.
 *   - **`isAuthenticated()`** returns true only when (a) a successful
 *     `authenticate()` has occurred AND (b) the session timestamp is within
 *     `sessionTimeoutMinutes` of `Date.now()`. As a back-compat affordance,
 *     setting `api.authenticated = true` directly (used heavily by Phase 2.1
 *     tests) is treated as a "session of unknown age" and is never expired
 *     until `sessionTimestamp` is also set.
 *   - **Auto re-auth**: every data-method calls `ensureAuthenticated()`,
 *     which silently re-authenticates with cached credentials when
 *     `isAuthenticated()` is false. With no cached credentials, it throws
 *     `BuildToolsAuthError("Not authenticated")` (matches Phase 2.1 behavior).
 *   - **401 retry**: the generic helpers (`datatable`, `get`, `post`) trigger
 *     a one-shot re-auth + replay when the server returns 401. A still-401
 *     replay surfaces the original response (no infinite loops). Higher-level
 *     mutation methods that call `request()` directly are NOT wrapped in the
 *     401-retry to avoid accidental re-auth loops on per-form CSRF flows;
 *     they still call `ensureAuthenticated()` up-front.
 */

import {
  BuildToolsAuthError,
  BuildToolsNetworkError,
  BuildToolsServerError,
} from "./errors.js";
import type {
  BuildToolsClientOptions,
  DatatableParams,
} from "./types.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface NormalizedResponse {
  status: number;
  headers: Headers;
  body: string;
  location: string | null;
  url: string;
}

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/** Accepted value-types for the form-encoded `post(...)` helper. */
type PostFieldValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Array<string | number | boolean>;

export type PostData = Record<string, PostFieldValue>;

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export class BuildToolsAPI {
  /** Hostname-keyed cookie jar: { hostname → { cookieName → cookieValue } }. */
  private cookies: Record<string, Record<string, string>> = {};

  /** CSRF `_token` harvested from login HTML. */
  private csrfToken: string | null = null;

  /** Decoded `XSRF-TOKEN` cookie value, sent as `X-XSRF-TOKEN` header. */
  private xsrfToken: string | null = null;

  /** Application host (default `https://moss.buildtools.app`). */
  public readonly baseUrl: string;

  /** Auth host (default `https://core.buildtools.app`). */
  public readonly authUrl: string;

  /** Optional default fetch timeout in ms (per-request override wins). */
  private readonly defaultTimeoutMs: number | undefined;

  /** Resolved fetch implementation (override or `globalThis.fetch`). */
  private readonly fetchImpl: typeof fetch;

  /**
   * Cached credentials for transparent re-authentication. Seeded by
   * constructor options and/or by the explicit `authenticate(email, pw)`
   * call. Never logged. May be `null` if the API was constructed without
   * credentials AND `authenticate(...)` has never been called.
   */
  private username: string | null = null;
  private password: string | null = null;

  /**
   * `Date.now()` of the last successful `authenticate()`. `null` when
   * either (a) the API has never authenticated, OR (b) a test has flipped
   * `api.authenticated = true` directly (Phase 2.1 back-compat). In case
   * (b), the session is treated as fresh until a `sessionTimestamp` is set.
   */
  private sessionTimestamp: number | null = null;

  /** Defensive client-side session expiry in minutes. */
  private readonly sessionTimeoutMinutes: number;

  public authenticated = false;
  public userId: string | number | null = null;

  /**
   * @param options - See `BuildToolsClientOptions`. `tenant` derives `baseUrl`
   *                  ONLY (not `authUrl`); explicit overrides win.
   */
  constructor(options: BuildToolsClientOptions = {}) {
    const envBase =
      typeof process !== "undefined" ? process.env?.BUILDTOOLS_BASE_URL : undefined;
    const envAuth =
      typeof process !== "undefined" ? process.env?.BUILDTOOLS_AUTH_URL : undefined;

    const derivedBase =
      options.tenant !== undefined
        ? `https://${options.tenant}.buildtools.app`
        : undefined;

    this.baseUrl =
      options.baseUrl ?? envBase ?? derivedBase ?? "https://moss.buildtools.app";
    this.authUrl = options.authUrl ?? envAuth ?? "https://core.buildtools.app";
    this.defaultTimeoutMs = options.defaultTimeoutMs;

    // Per the JSDoc on the class: cached credentials live on the instance,
    // seeded by constructor options OR by the explicit authenticate(...) call.
    this.username = options.username ?? null;
    this.password = options.password ?? null;

    // Default applied at API construction (NOT at loadConfigFromEnv) so that
    // callers passing a partial config still get a safe expiry.
    this.sessionTimeoutMinutes = options.sessionTimeoutMinutes ?? 30;

    const resolvedFetch = options.fetch ?? globalThis.fetch;
    if (typeof resolvedFetch !== "function") {
      throw new BuildToolsNetworkError(
        "No fetch implementation available. Provide options.fetch or run on Node ≥18.",
      );
    }
    // Bind so detached references behave (some test harnesses care).
    this.fetchImpl = resolvedFetch.bind(globalThis) as typeof fetch;
  }

  // -------------------------------------------------------------------------
  // Cookie jar
  // -------------------------------------------------------------------------

  /**
   * Mirrors source L62–82. Parses `Set-Cookie` headers, stores under hostname,
   * mirrors `domain=.buildtools.app` cookies under that parent domain key, and
   * decodes `XSRF-TOKEN` for header injection.
   *
   * `fetch`'s `Headers` collapses multiple `Set-Cookie` headers into a single
   * comma-separated string when accessed via `.get('set-cookie')`. We use
   * `Headers.getSetCookie()` when available (Node ≥20.0; spec-compliant) and
   * fall back to splitting on commas-NOT-inside-expires for older runtimes.
   */
  private parseCookies(response: NormalizedResponse, hostname: string): void {
    const setCookies = this.extractSetCookies(response.headers);
    if (!this.cookies[hostname]) this.cookies[hostname] = {};

    for (const cookie of setCookies) {
      const [nameValue, ...attrs] = cookie.split(";");
      const eq = nameValue.indexOf("=");
      if (eq < 0) continue;
      const name = nameValue.slice(0, eq).trim();
      const value = nameValue.slice(eq + 1);
      if (!name) continue;
      this.cookies[hostname][name] = value;

      if (name === "XSRF-TOKEN") {
        try {
          this.xsrfToken = decodeURIComponent(value);
        } catch {
          this.xsrfToken = value;
        }
      }

      const domainAttr = attrs.find((a) => /^\s*domain=/i.test(a));
      if (domainAttr) {
        const domain = domainAttr.split("=")[1]?.trim().replace(/^\./, "");
        if (domain) {
          if (!this.cookies[domain]) this.cookies[domain] = {};
          this.cookies[domain][name] = value;
        }
      }
    }
  }

  /**
   * Returns Set-Cookie header values as a string array, using the spec-correct
   * `Headers.getSetCookie()` when available, with a permissive fallback for
   * older runtimes that collapse Set-Cookie into a single comma-joined value.
   */
  private extractSetCookies(headers: Headers): string[] {
    // Node 20+ / spec-compliant fetch: spec method returns an array.
    const getSetCookie = (headers as Headers & {
      getSetCookie?: () => string[];
    }).getSetCookie;
    if (typeof getSetCookie === "function") {
      return getSetCookie.call(headers);
    }
    const raw = headers.get("set-cookie");
    if (!raw) return [];
    // Split on commas that are followed by a cookie-name=, i.e. not inside
    // an `Expires=Wed, 09 Jun 2021 ...` attribute.
    return raw.split(/,(?=\s*[A-Za-z0-9_\-]+=)/);
  }

  /**
   * Mirrors source L84–92. Returns the merged Cookie header value for the
   * target hostname: parent-domain cookies first, then host-specific overrides.
   */
  private getCookieString(hostname: string): string {
    const domainCookies = this.cookies[hostname] ?? {};
    const parentDomain = hostname.split(".").slice(-2).join(".");
    const parentCookies = this.cookies[parentDomain] ?? {};
    const allCookies = { ...parentCookies, ...domainCookies };
    return Object.entries(allCookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  // -------------------------------------------------------------------------
  // request() — redirect-following, XSRF-injecting fetch wrapper
  // -------------------------------------------------------------------------

  /**
   * Mirrors source L94–151. Wraps `fetch` so that:
   *   - we inject `Cookie` and `X-XSRF-TOKEN` headers,
   *   - we parse `Set-Cookie` per-hostname,
   *   - we manually follow 301/302 redirects (up to depth 10) so that cookies
   *     set by the redirect-issuing host are visible on the next hop.
   *
   * Visible for testing.
   */
  public async request(
    urlString: string,
    options: RequestOptions = {},
    followRedirects = true,
    depth = 0,
  ): Promise<NormalizedResponse> {
    const url = new URL(urlString);

    const headers: Record<string, string> = {
      Cookie: this.getCookieString(url.hostname),
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      ...options.headers,
    };

    if (this.xsrfToken && headers["X-XSRF-TOKEN"] === undefined) {
      headers["X-XSRF-TOKEN"] = this.xsrfToken;
    }

    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => controller.abort(), timeoutMs);
    }

    let rawResponse: Response;
    try {
      rawResponse = await this.fetchImpl(urlString, {
        method: options.method ?? "GET",
        headers,
        body: options.body,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (err) {
      throw new BuildToolsNetworkError(
        `Network error fetching ${urlString}: ${(err as Error)?.message ?? String(err)}`,
        { cause: err, url: urlString },
      );
    } finally {
      if (timer) clearTimeout(timer);
    }

    const body = await rawResponse.text();
    const result: NormalizedResponse = {
      status: rawResponse.status,
      headers: rawResponse.headers,
      body,
      location: rawResponse.headers.get("location"),
      url: urlString,
    };

    this.parseCookies(result, url.hostname);

    if (
      followRedirects &&
      (rawResponse.status === 301 || rawResponse.status === 302) &&
      result.location &&
      depth < 10
    ) {
      const redirectUrl = result.location.startsWith("http")
        ? result.location
        : `https://${url.hostname}${result.location}`;
      try {
        return await this.request(redirectUrl, { method: "GET" }, true, depth + 1);
      } catch {
        // Source preserves the original response on redirect failure.
        return result;
      }
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // authenticate() — two-phase login
  // -------------------------------------------------------------------------

  /**
   * Mirrors source L153–186 with one intentional deviation: we throw
   * `BuildToolsAuthError` on failure instead of returning `false`. No stdout
   * logging (would corrupt MCP stdio).
   *
   * MOS-212: caches `email`/`password` on the instance so subsequent data
   * calls can transparently re-authenticate after session expiry or a 401.
   * Stamps `sessionTimestamp` on success.
   */
  async authenticate(email: string, password: string): Promise<boolean> {
    // Cache credentials BEFORE the request — this way, if the auth flow
    // throws partway through and a caller catches it, a subsequent
    // ensureAuthenticated() can still find credentials and retry.
    // (Most-recent call wins over constructor-seeded values.)
    this.username = email;
    this.password = password;

    // 1. GET login page (NO redirect follow) to harvest CSRF `_token`.
    const loginPage = await this.request(
      `${this.authUrl}/login?m=1&o=0ye79w`,
      {},
      false,
    );
    const csrfMatch = loginPage.body.match(/name="_token"[^>]*value="([^"]+)"/);
    if (csrfMatch) this.csrfToken = csrfMatch[1];

    if (!this.csrfToken) {
      throw new BuildToolsAuthError(
        "Could not harvest CSRF _token from login page",
        { status: loginPage.status, url: loginPage.url },
      );
    }

    // 2. POST login form to authUrl (follow redirects).
    const formData = new URLSearchParams({
      _token: this.csrfToken,
      email,
      password,
      remember: "on",
    }).toString();

    await this.request(
      `${this.authUrl}/login`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": String(Buffer.byteLength(formData)),
          Origin: this.authUrl,
          Referer: `${this.authUrl}/login?m=1&o=0ye79w`,
        },
        body: formData,
      },
      true,
    );

    // 3. GET baseUrl to complete cross-domain session.
    const appResponse = await this.request(this.baseUrl, {}, true);
    this.authenticated =
      appResponse.body.includes("logout") ||
      appResponse.body.includes("dashboard");

    if (!this.authenticated) {
      throw new BuildToolsAuthError(
        "Authentication failed: dashboard markers not found in response",
        { status: appResponse.status, url: appResponse.url },
      );
    }
    this.sessionTimestamp = Date.now();
    return this.authenticated;
  }

  // -------------------------------------------------------------------------
  // Session lifecycle (MOS-212)
  // -------------------------------------------------------------------------

  /**
   * Returns `true` iff a successful authentication has occurred AND the
   * session has not exceeded `sessionTimeoutMinutes`. Used both by the
   * built-in `ensureAuthenticated()` guard and (publicly) by any caller
   * that wants to introspect session state.
   *
   * Back-compat: `api.authenticated = true` set directly (without an
   * accompanying `sessionTimestamp`) is treated as "session of unknown
   * age" and is NOT considered expired — this preserves Phase 2.1 tests
   * that bypass `authenticate()`.
   */
  isAuthenticated(): boolean {
    if (!this.authenticated) return false;
    if (this.sessionTimestamp === null) return true;
    const elapsedMs = Date.now() - this.sessionTimestamp;
    return elapsedMs < this.sessionTimeoutMinutes * 60_000;
  }

  /**
   * If the session is missing or expired, transparently calls `authenticate()`
   * with the cached credentials. With no cached credentials, throws
   * `BuildToolsAuthError("Not authenticated")` — matches Phase 2.1's explicit
   * auth-required behavior.
   */
  private async ensureAuthenticated(): Promise<void> {
    if (this.isAuthenticated()) return;
    if (!this.username || !this.password) {
      throw new BuildToolsAuthError("Not authenticated");
    }
    await this.authenticate(this.username, this.password);
  }

  /**
   * Performs `request()` and, on a 401, transparently re-authenticates with
   * cached credentials and replays the request exactly once. If the replay
   * is still 401 — OR if no credentials are cached — the original (or
   * still-401) response is returned without further retries.
   *
   * Applied at the data-method layer (`datatable`/`get`/`post`) ONLY, NOT in
   * the generic `request()` — so per-form CSRF flows (e.g. invoice save)
   * can't accidentally trigger a re-auth loop on a deliberately 401-able
   * login redirect.
   */
  private async requestWithReauthRetry(
    urlString: string,
    options: RequestOptions,
    followRedirects: boolean,
  ): Promise<NormalizedResponse> {
    const first = await this.request(urlString, options, followRedirects);
    if (first.status !== 401) return first;
    if (!this.username || !this.password) return first;

    // Force the next isAuthenticated() check to fall through to authenticate().
    this.authenticated = false;
    this.sessionTimestamp = null;
    try {
      await this.authenticate(this.username, this.password);
    } catch {
      return first;
    }
    return this.request(urlString, options, followRedirects);
  }

  // -------------------------------------------------------------------------
  // datatable() / get() / post() generic helpers
  // -------------------------------------------------------------------------

  /**
   * Mirrors source L188–210. NOTE: this uses GET with a query string. The
   * Linear issue description says POST, but the actual source uses GET — we
   * follow the source. Returns the parsed JSON envelope (DataTables shape)
   * or `null` if the body isn't JSON.
   */
  async datatable<T = unknown>(
    resource: string,
    params: DatatableParams = {},
  ): Promise<T | null> {
    await this.ensureAuthenticated();

    const defaultParams: Record<string, string> = {
      draw: "1",
      start: "0",
      length: "50",
    };
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) defaultParams[k] = String(v);
    }
    const queryString = new URLSearchParams(defaultParams).toString();
    const url = `${this.baseUrl}/${resource}/datatable?${queryString}`;

    const response = await this.requestWithReauthRetry(
      url,
      {
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json",
        },
      },
      false,
    );

    if (response.status === 200) {
      try {
        return JSON.parse(response.body) as T;
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Mirrors source L212–231. JSON-aware GET; returns parsed JSON, raw body, or null. */
  async get<T = unknown>(path: string): Promise<T | string | null> {
    await this.ensureAuthenticated();

    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const response = await this.requestWithReauthRetry(
      url,
      {
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json",
        },
      },
      false,
    );

    if (response.status === 200) {
      try {
        return JSON.parse(response.body) as T;
      } catch {
        return response.body;
      }
    }
    return null;
  }

  /**
   * Mirrors source L233–266. Form-urlencoded POST helper. Array values
   * serialize as `key[]=v1&key[]=v2` (source L240–246). Always sends the
   * current `X-XSRF-TOKEN` header.
   */
  async post<T = unknown>(
    path: string,
    data: PostData,
  ): Promise<T | { status: number; body: string }> {
    await this.ensureAuthenticated();

    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;

    const formData = new URLSearchParams();
    for (const [key, value] of Object.entries(data)) {
      if (Array.isArray(value)) {
        for (const v of value) formData.append(`${key}[]`, String(v));
      } else if (value !== undefined && value !== null) {
        formData.append(key, String(value));
      }
    }
    const body = formData.toString();

    const response = await this.requestWithReauthRetry(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json",
          ...(this.xsrfToken ? { "X-XSRF-TOKEN": this.xsrfToken } : {}),
        },
        body,
      },
      false,
    );

    try {
      return JSON.parse(response.body) as T;
    } catch {
      return { status: response.status, body: response.body };
    }
  }

  // ========================================================================
  // PROJECT METHODS
  // ========================================================================

  /** Source L270–296. */
  async createProject(projectData: {
    name: string;
    status?: string | number;
    projectManager?: string | number | Array<string | number>;
    employees?: string | number | Array<string | number>;
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
    country?: string;
    description?: string;
    clientIds?: string | number | Array<string | number>;
  }): Promise<{ success: boolean; projectId?: string | number; errors?: unknown }> {
    await this.ensureAuthenticated();

    const data: PostData = {
      "Project[name]": projectData.name,
      "Project[status]": projectData.status ?? "6",
      employees: this.toFormFieldValue(
        projectData.projectManager ?? projectData.employees,
      ),
    };

    if (projectData.address) data["Project[address]"] = projectData.address;
    if (projectData.city) data["Project[city]"] = projectData.city;
    if (projectData.state) data["Project[state]"] = projectData.state;
    if (projectData.zip) data["Project[zip]"] = projectData.zip;
    if (projectData.country) data["Project[country_code]"] = projectData.country;
    if (projectData.description) data["Project[description]"] = projectData.description;
    if (projectData.clientIds !== undefined) {
      data["Client[ids]"] = this.toFormFieldValue(projectData.clientIds);
    }

    const result = (await this.post("/projects/save", data)) as {
      r?: number;
      projectId?: string | number;
      e?: unknown;
      errors?: unknown;
    };

    if (result?.r === 1) {
      return { success: true, projectId: result.projectId };
    }
    return { success: false, errors: result?.e ?? result?.errors };
  }

  /** Source L298–300. */
  async getProjects<T = unknown>(options: DatatableParams = {}): Promise<T | null> {
    return this.datatable<T>("projects", options);
  }

  /** Source L302–304. */
  async searchProjects<T = unknown>(
    query: string,
    limit: number = 50,
  ): Promise<T | null> {
    return this.datatable<T>("projects", {
      "search[value]": query,
      length: limit,
    });
  }

  /**
   * Fetches a single project by ID. BuildTools does not expose a JSON detail
   * endpoint — `/projects/:id/form` returns 404. Instead we pull from the
   * projects datatable and match by the `id` field client-side.
   */
  async getProject<T = unknown>(projectId: string | number): Promise<T | null> {
    const numericId = Number(projectId);
    const result = await this.datatable<{
      data?: Array<Record<string, unknown>>;
    }>("projects", { length: 5000 });

    const rows = result?.data ?? [];
    const match = rows.find(
      (r) =>
        r.id === numericId ||
        r.id === String(numericId) ||
        r.DT_RowId === `row_${numericId}`,
    );
    return (match as T) ?? null;
  }

  /** Source L333–365. */
  async updateProject(
    projectId: string | number,
    projectData: {
      projectManager: string | number | Array<string | number>;
      name?: string;
      status?: string | number;
      address?: string;
      city?: string;
      state?: string;
      zip?: string;
      country?: string;
      description?: string;
    },
  ): Promise<{ success: boolean; projectId?: string | number; errors?: unknown }> {
    await this.ensureAuthenticated();
    if (!projectData.projectManager) {
      throw new BuildToolsAuthError("projectManager is required for updates");
    }

    const data: PostData = {
      id: projectId,
      "Project[id]": projectId,
      employees: this.toFormFieldValue(projectData.projectManager),
    };

    if (projectData.name) data["Project[name]"] = projectData.name;
    if (projectData.status) data["Project[status]"] = projectData.status;
    if (projectData.address) data["Project[address]"] = projectData.address;
    if (projectData.city) data["Project[city]"] = projectData.city;
    if (projectData.state) data["Project[state]"] = projectData.state;
    if (projectData.zip) data["Project[zip]"] = projectData.zip;
    if (projectData.country) data["Project[country_code]"] = projectData.country;
    if (projectData.description) data["Project[description]"] = projectData.description;

    const result = (await this.post("/projects/save", data)) as {
      r?: number;
      projectId?: string | number;
      e?: unknown;
      errors?: unknown;
    };

    if (result?.r === 1) {
      return { success: true, projectId: result.projectId ?? projectId };
    }
    return { success: false, errors: result?.e ?? result?.errors };
  }

  // ========================================================================
  // COMPANY METHODS
  // ========================================================================

  /** Source L369–371. */
  async getCompanies<T = unknown>(options: DatatableParams = {}): Promise<T | null> {
    return this.datatable<T>("companies", options);
  }

  /**
   * Fetches a single customer/company by ID. BuildTools does not expose a JSON
   * detail endpoint — `/companies/:id/form` returns 404. Instead we pull from
   * the companies datatable and match by `DT_RowId` client-side (companies use
   * `row_${id}` format; the raw `id` field is not in the datatable row).
   */
  async getCustomer<T = unknown>(
    customerId: string | number,
  ): Promise<T | null> {
    const numericId = Number(customerId);
    const result = await this.datatable<{
      data?: Array<Record<string, unknown>>;
    }>("companies", { length: 5000 });

    const rows = result?.data ?? [];
    const rowIdKey = `row_${numericId}`;
    const match = rows.find(
      (r) =>
        r.DT_RowId === rowIdKey ||
        r.id === numericId ||
        r.id === String(numericId),
    );
    return (match as T) ?? null;
  }

  /**
   * Phase 3.3 (MOS-216). Lists ALL attachments for a project (any module),
   * via `/documents?PR[]=:id` with no `list=` filter. This is the
   * module-agnostic listing path documented inline in source — the
   * `list=m-<projectId>-<module>-0` filter selects a single module (e.g.
   * 600=Change Orders); omitting `list` returns everything visible to the
   * user on the project's Documents tab. **Path semantics are inferred and
   * pending live verification** (MOS-222 smoke).
   *
   * Returns the raw snake_case items as returned by BuildTools (no camelCase
   * mapping — the Phase 3.3 tool renders the markdown directly). Returns
   * `[]` on non-200 or unparseable body.
   */
  async getProjectAttachments(
    projectId: string | number,
  ): Promise<Array<Record<string, unknown>>> {
    await this.ensureAuthenticated();
    if (!projectId) throw new BuildToolsServerError("projectId is required");

    const response = await this.request(
      `${this.baseUrl}/documents?PR[]=${projectId}`,
      {
        method: "GET",
        headers: { "X-Requested-With": "XMLHttpRequest" },
      },
      false,
    );

    if (response.status !== 200) return [];

    try {
      const data = JSON.parse(response.body) as {
        items?: Array<Record<string, unknown>>;
      };
      return data.items ?? [];
    } catch {
      return [];
    }
  }

  // ========================================================================
  // SELECTION METHODS
  // ========================================================================

  /**
   * Fetches selections for a project by parsing the HTML grid returned by
   * GET /selections?PR[]=<projectId>. Returns structured selection rows
   * extracted from the HTML table rows.
   */
  async getSelections(
    projectId: string | number,
  ): Promise<{
    statusCount: Record<string, number>;
    selections: Array<{
      id: string;
      statusCode: number;
      status: string;
      category: string;
      location: string;
      item: string;
      price: string;
      dueDate: string;
      selection: string;
      notes: string;
    }>;
  }> {
    await this.ensureAuthenticated();

    const response = await this.request(
      `${this.baseUrl}/selections?PR[]=${projectId}`,
      {
        headers: {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
      },
      false,
    );

    if (response.status !== 200) {
      return { statusCount: {}, selections: [] };
    }

    let data: { grids?: string; statusCount?: Record<string, number> };
    try {
      data = JSON.parse(response.body);
    } catch {
      return { statusCount: {}, selections: [] };
    }

    const statusCount = data.statusCount ?? {};
    const html = data.grids ?? "";
    const selections: Array<{
      id: string;
      statusCode: number;
      status: string;
      category: string;
      location: string;
      item: string;
      price: string;
      dueDate: string;
      selection: string;
      notes: string;
    }> = [];

    const STATUS_MAP: Record<number, string> = {
      1: "Open",
      2: "Selected",
      3: "Approved",
      4: "Rejected",
      5: "Complete",
    };

    const strip = (s: string): string =>
      s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/\s+/g, " ").trim();

    // Each grid section has a category header
    const gridRegex = /<div[^>]*class="[^"]*tables-content grid-item[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*tables-content grid-item|$)/g;
    let gridMatch: RegExpExecArray | null;

    while ((gridMatch = gridRegex.exec(html)) !== null) {
      const gridHtml = gridMatch[1];
      const headerMatch = gridHtml.match(/<h2>([^<]+)<\/h2>/);
      const category = headerMatch ? strip(headerMatch[1]) : "Unknown";
      if (category === "Typical Room") continue; // skip empty typical room shells

      const rowRegex = /<tr[^>]*id="sgRow_\d+"[^>]*data-id="(\d+)"[^>]*data-status="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;
      let rowMatch: RegExpExecArray | null;

      while ((rowMatch = rowRegex.exec(gridHtml)) !== null) {
        const id = rowMatch[1];
        const statusCode = Number(rowMatch[2]);
        const rowHtml = rowMatch[3];

        const cells: string[] = [];
        const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
        let cellMatch: RegExpExecArray | null;
        while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
          cells.push(strip(cellMatch[1]));
        }

        // Column layout: [expand] [checkbox] status [icon] category location item price dueDate [relations] spec selection notes [actions]
        // Indices vary by whether the "# REL." column is present, so find by content
        const nonEmpty = cells.filter((c) => c.length > 0);

        selections.push({
          id,
          statusCode,
          status: STATUS_MAP[statusCode] ?? String(statusCode),
          category,
          location: nonEmpty.find((c) => /^(Kitchen|Bathroom|Bedroom|Living|Dining|Basement|Attic|Office|Garage|Non-specified|Typical|Master|Hall|Laundry|Closet|Exterior|Porch|Deck|Foyer|Family|Great|Mud|Pantry|Powder|Study|Sun|Breezeway)/i.test(c)) ?? "",
          item: nonEmpty.find((c) => c.length > 3 && !/^\d{4}\s*-/.test(c) && !/^\$/.test(c) && !/^(Open|Selected|Approved|Rejected|Complete|Purchased|No|Yes)$/i.test(c)) ?? "",
          price: nonEmpty.find((c) => /^\$\s*[\d,]+\.\d{2}$/.test(c)) ?? "",
          dueDate: nonEmpty.find((c) => /^\d{2}\/\d{2}\/\d{4}$/.test(c)) ?? "",
          selection: nonEmpty.find((c) => c.includes("SELECT OPTION") || c.length > 20) ?? "",
          notes: "",
        });
      }
    }

    return { statusCount, selections };
  }

  /**
   * Fetches allowance budget categories for a project. Parses the budget HTML
   * from GET /budget?PR[]=<projectId> and extracts rows whose category name
   * contains "Allowance".
   */
  async getAllowances(
    projectId: string | number,
  ): Promise<Array<{
    id: string;
    categoryId: string;
    name: string;
    budgetedAmount: number;
    revisedAmount: string;
    cells: string[];
  }>> {
    await this.ensureAuthenticated();

    const response = await this.request(
      `${this.baseUrl}/budget?PR[]=${projectId}`,
      {
        headers: {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
      },
      false,
    );

    if (response.status !== 200) return [];

    let data: { content?: string };
    try {
      data = JSON.parse(response.body);
    } catch {
      return [];
    }

    const html = data.content ?? "";
    const strip = (s: string): string =>
      s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/\s+/g, " ").trim();

    const allowances: Array<{
      id: string;
      categoryId: string;
      name: string;
      budgetedAmount: number;
      revisedAmount: string;
      cells: string[];
    }> = [];

    // Budget rows have data-id and data-category attributes (order varies)
    const rowRegex = /<tr[^>]*data-id="(\d+)"[^>]*data-category="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;
    const rowRegex2 = /<tr[^>]*data-category="(\d+)"[^>]*data-id="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;

    for (const re of [rowRegex, rowRegex2]) {
      let match: RegExpExecArray | null;
      while ((match = re.exec(html)) !== null) {
        const id = re === rowRegex ? match[1] : match[2];
        const categoryId = re === rowRegex ? match[2] : match[1];
        const rowHtml = match[3];

        const cells: string[] = [];
        const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
        let cellMatch: RegExpExecArray | null;
        while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
          cells.push(strip(cellMatch[1]));
        }

        const name = cells[0] ?? "";
        if (!/allowance/i.test(name)) continue;

        // Avoid duplicates
        if (allowances.some((a) => a.id === id)) continue;

        const dataValue = match[0].match(/data-value="([^"]*)"/);
        const budgetedAmount = dataValue ? Number(dataValue[1]) || 0 : 0;

        // Find the revised amount (typically a $ value in the cells)
        const amounts = cells.filter((c) => /^\$\s*[\d,]+\.\d{2}/.test(c));
        const revisedAmount = amounts[0] ?? "";

        allowances.push({ id, categoryId, name, budgetedAmount, revisedAmount, cells });
      }
    }

    return allowances;
  }

  // ========================================================================
  // CHANGE ORDER METHODS
  // ========================================================================

  /** Source L375–377. */
  async getChangeOrders<T = unknown>(
    options: DatatableParams = {},
  ): Promise<T | null> {
    return this.datatable<T>("change-orders", options);
  }

  /** Source L379–381. */
  async searchChangeOrders<T = unknown>(
    query: string,
    limit: number = 50,
  ): Promise<T | null> {
    return this.datatable<T>("change-orders", {
      "search[value]": query,
      length: limit,
    });
  }

  /** Source L383–418. */
  async createChangeOrder(coData: {
    name: string;
    projectId: string | number;
    status?: string | number;
    description?: string;
    total?: number;
    items?: Array<{
      name: string;
      total: number;
      budget_category_id: number;
    }>;
  }): Promise<{
    success: boolean;
    changeOrderId?: string | number;
    message?: unknown;
    errors?: unknown;
  }> {
    await this.ensureAuthenticated();

    const items = coData.items ?? [
      { name: "Item", total: coData.total ?? 0, budget_category_id: 0 },
    ];

    const formData = new URLSearchParams();
    formData.append("ChangeOrder[name]", coData.name);
    formData.append("ChangeOrder[project_id]", String(coData.projectId));
    formData.append("ChangeOrder[status]", String(coData.status ?? "1"));
    formData.append("ChangeOrderItems[items]", JSON.stringify({ items }));
    if (coData.description) {
      formData.append("ChangeOrder[description]", coData.description);
    }

    const response = await this.request(
      `${this.baseUrl}/change-orders/save`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json",
          ...(this.xsrfToken ? { "X-XSRF-TOKEN": this.xsrfToken } : {}),
        },
        body: formData.toString(),
      },
      false,
    );

    try {
      const result = JSON.parse(response.body) as {
        result?: string;
        id?: string | number;
        message?: unknown;
      };
      if (result?.result === "success") {
        return { success: true, changeOrderId: result.id, message: result.message };
      }
      return { success: false, errors: result?.message };
    } catch {
      return { success: false, errors: "Server error" };
    }
  }

  /**
   * Fetches a single change order by ID. BuildTools does not expose a JSON
   * detail endpoint — `/change-orders/:id/form` returns 404. Instead we pull
   * from the change-orders datatable and match by the `info` field (which
   * holds the CO's numeric ID) client-side.
   */
  async getChangeOrder<T = unknown>(
    changeOrderId: string | number,
  ): Promise<T | null> {
    const numericId = Number(changeOrderId);
    const result = await this.datatable<{
      data?: Array<Record<string, unknown>>;
    }>("change-orders", { length: 10000 });

    const rows = result?.data ?? [];
    const match = rows.find(
      (r) =>
        r.info === numericId ||
        r.info === String(numericId) ||
        r.id === numericId ||
        r.DT_RowId === `row_${numericId}`,
    );
    return (match as T) ?? null;
  }

  /**
   * Reads a project's financial overview by parsing the FS form HTML.
   *
   * The /financial/statements/form?PR[]=<id> endpoint returns HTML (not JSON).
   * The key data lives in a hidden input named `budgetOverviewTotals` whose
   * value is an HTML-encoded JSON blob. This matches the pattern used by
   * createFinancialStatementWithAmount in api-client.js:737-768.
   *
   * Returns a structured object with budget totals extracted from the form,
   * or null on non-200.
   */
  async getFinancialStatement<T = unknown>(
    projectId: string | number,
  ): Promise<T | null> {
    await this.ensureAuthenticated();

    const response = await this.request(
      `${this.baseUrl}/financial/statements/form?PR[]=${projectId}`,
      {
        headers: {
          Accept: "text/html",
          "X-Requested-With": "XMLHttpRequest",
        },
      },
      false,
    );

    if (response.status !== 200) return null;

    const html = response.body;
    const grab = (re: RegExp): string | null => {
      const m = html.match(re);
      return m ? m[1] : null;
    };

    const decodeHtmlEntities = (s: string): string =>
      s
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#039;/g, "'");

    const botRaw = grab(/name="budgetOverviewTotals"[^>]*value="([^"]+)"/);
    if (!botRaw) return null;

    let budgetOverviewTotals: Record<string, unknown>;
    try {
      budgetOverviewTotals = JSON.parse(decodeHtmlEntities(botRaw));
    } catch {
      return null;
    }

    const result: Record<string, unknown> = {
      project_id: projectId,
      budgetOverviewTotals,
      ...budgetOverviewTotals,
    };

    const nameMatch = grab(/name="FinancialStatement\[name\]"[^>]*value="([^"]*)"/);
    if (nameMatch) result.name = decodeHtmlEntities(nameMatch);

    const statusMatch = grab(/name="FinancialStatement\[status\]"[^>]*value="([^"]*)"/);
    if (statusMatch) result.status = statusMatch;

    return result as T;
  }

  /**
   * Project-level unbilled change order analysis. Matches the logic in the
   * reference implementation (find-unbilled-cos.js:39-71):
   *
   *   unbilled_gap = budget_revised - requested_amount
   *
   * Where budget_revised = budget_total + approved_co_total (from the projects
   * datatable) and requested_amount = sum of financial statement amounts (from
   * the FS form's budgetOverviewTotals).
   *
   * The reference uses raw MySQL. We replicate it over HTTP:
   *   1. Get active projects (status 5-8) from the projects datatable
   *   2. Filter to projects with change_orders_approved > 0
   *   3. For each, fetch the FS form to parse budgetOverviewTotals
   *   4. Compute the gap; return projects where gap >= 0.01
   *
   * Returns project-level rows (not individual COs).
   */
  async findUnbilledChangeOrders(
    filters: { min_amount?: number; older_than_days?: number } = {},
  ): Promise<
    Array<
      Record<string, unknown> & {
        total_value: number;
      }
    >
  > {
    await this.ensureAuthenticated();

    const parseCurrency = (v: unknown): number => {
      if (typeof v === "number") return v;
      if (typeof v === "string" && v !== "-" && v.trim() !== "") {
        const n = Number(v.replace(/[^\d.-]/g, ""));
        return Number.isFinite(n) ? n : 0;
      }
      return 0;
    };

    // Step 1: Get active projects (status 5-8).
    const projectsResult = (await this.datatable<{
      data?: Array<Record<string, unknown>>;
    }>("projects", {
      length: 500,
      "columns[1][search][value]": "5|6|7|8",
      "columns[1][search][regex]": "true",
    })) ?? { data: [] };

    const activeStatuses = new Set([5, 6, 7, 8]);
    const candidates: Array<Record<string, unknown>> = [];
    for (const proj of projectsResult.data ?? []) {
      const status = typeof proj.status === "number" ? proj.status : Number(proj.status);
      if (!activeStatuses.has(status)) continue;
      const approvedCOs = parseCurrency(proj.change_orders_approved);
      if (approvedCOs <= 0) continue;
      candidates.push(proj);
    }

    // Step 2: For each candidate, fetch FS form to get budgetOverviewTotals.
    const matches: Array<Record<string, unknown> & { total_value: number }> = [];
    const minAmount = filters.min_amount;

    for (const proj of candidates) {
      const projectId = proj.id;
      if (!projectId) continue;

      const budgetRevised = parseCurrency(proj.budget_revised);
      if (budgetRevised <= 0) continue;

      // Fetch the FS form HTML and parse budgetOverviewTotals.
      let requestedAmount = 0;
      try {
        const fsData = await this.getFinancialStatement<Record<string, unknown>>(projectId as number);
        if (fsData?.financial_current_amount !== undefined) {
          requestedAmount = parseCurrency(fsData.financial_current_amount);
        }
      } catch {
        // If FS form fails, assume 0 requested (conservative — will surface the project).
      }

      const gap = budgetRevised - requestedAmount;
      if (gap < 0.01) continue;

      if (minAmount !== undefined && gap < minAmount) continue;

      matches.push({
        ...proj,
        budget_revised_value: budgetRevised,
        requested_amount: requestedAmount,
        unbilled_gap: gap,
        total_value: gap,
      });
    }

    matches.sort((a, b) => (b.total_value ?? 0) - (a.total_value ?? 0));
    return matches;
  }

  /**
   * Source L428–472. Lists files in module 600 (Change Orders) for a project,
   * optionally filtered by a specific change-order id.
   */
  async getChangeOrderAttachments(
    projectId: string | number,
    changeOrderId: string | number | null = null,
  ): Promise<
    Array<{
      id: string | number;
      name: string;
      changeOrderId: string | number;
      extension: string;
      publicUrl: string;
      key: string;
      size: string | number;
      createdAt: string;
      userId: string | number;
      userName: string;
    }>
  > {
    await this.ensureAuthenticated();
    if (!projectId) throw new BuildToolsServerError("projectId is required");

    const listKey = `m-${projectId}-600-0`;
    const response = await this.request(
      `${this.baseUrl}/documents?PR[]=${projectId}&list=${listKey}`,
      {
        method: "GET",
        headers: { "X-Requested-With": "XMLHttpRequest" },
      },
      false,
    );

    if (response.status !== 200) return [];

    try {
      const data = JSON.parse(response.body) as {
        items?: Array<Record<string, unknown>>;
      };
      let files = data.items ?? [];
      if (changeOrderId !== null && changeOrderId !== undefined) {
        files = files.filter(
          (f) => String(f.module_id) === String(changeOrderId),
        );
      }
      return files.map((f) => ({
        id: f.id as string | number,
        name: f.name as string,
        changeOrderId: f.module_id as string | number,
        extension: f.extension as string,
        publicUrl: f.public_url as string,
        key: f.key as string,
        size: f.size as string | number,
        createdAt: f.created_at as string,
        userId: f.user_id as string | number,
        userName: f.user_name as string,
      }));
    } catch {
      return [];
    }
  }

  // ========================================================================
  // PURCHASE ORDER METHODS
  // ========================================================================

  /** Source L476–478. */
  async getPurchaseOrders<T = unknown>(
    options: DatatableParams = {},
  ): Promise<T | null> {
    return this.datatable<T>("purchase-orders", options);
  }

  /** Source L480–482. */
  async searchPurchaseOrders<T = unknown>(
    query: string,
    limit: number = 50,
  ): Promise<T | null> {
    return this.datatable<T>("purchase-orders", {
      "search[value]": query,
      length: limit,
    });
  }

  /** Source L484–521. */
  async createPurchaseOrder(poData: {
    name: string;
    projectId: string | number;
    companyId: string | number;
    prefix?: string;
    status?: string | number;
    notes?: string;
    total?: number;
    items?: Array<{ name: string; total: number }>;
  }): Promise<{
    success: boolean;
    purchaseOrderId?: string | number;
    message?: unknown;
    errors?: unknown;
  }> {
    await this.ensureAuthenticated();

    const items = poData.items ?? [
      { name: "Item", total: poData.total ?? 0 },
    ];

    const formData = new URLSearchParams();
    formData.append("PurchaseOrder[name]", poData.name);
    formData.append("PurchaseOrder[project_id]", String(poData.projectId));
    formData.append("PurchaseOrder[company_id]", String(poData.companyId));
    formData.append("PurchaseOrder[prefix]", String(poData.prefix ?? "PO"));
    formData.append("PurchaseOrder[status]", String(poData.status ?? "1"));
    formData.append("PurchaseOrderItems[items]", JSON.stringify({ items }));
    if (poData.notes) formData.append("PurchaseOrder[notes]", poData.notes);

    const response = await this.request(
      `${this.baseUrl}/purchase-orders/save`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json",
          ...(this.xsrfToken ? { "X-XSRF-TOKEN": this.xsrfToken } : {}),
        },
        body: formData.toString(),
      },
      false,
    );

    try {
      const result = JSON.parse(response.body) as {
        result?: string;
        id?: string | number;
        message?: unknown;
      };
      if (result?.result === "success") {
        return {
          success: true,
          purchaseOrderId: result.id,
          message: result.message,
        };
      }
      return { success: false, errors: result?.message };
    } catch {
      return { success: false, errors: "Server error" };
    }
  }

  // ========================================================================
  // TASK METHODS
  // ========================================================================

  /** Source L525–527. */
  async getTasks<T = unknown>(options: DatatableParams = {}): Promise<T | null> {
    return this.datatable<T>("tasks", options);
  }

  /** Source L529–531. */
  async searchTasks<T = unknown>(
    query: string,
    limit: number = 50,
  ): Promise<T | null> {
    return this.datatable<T>("tasks", {
      "search[value]": query,
      length: limit,
    });
  }

  /** Source L533–555. */
  async createTask(taskData: {
    name: string;
    projectId: string | number;
    locationId?: string | number;
    status?: string | number;
    priority?: string | number;
    dueDate?: string;
    assignedTo?: string | number;
    description?: string;
  }): Promise<{
    success: boolean;
    taskId?: string | number;
    message?: unknown;
    errors?: unknown;
  }> {
    await this.ensureAuthenticated();

    const data: PostData = {
      "Task[name]": taskData.name,
      "Task[project_id]": taskData.projectId,
      "Task[locations_room_id]": taskData.locationId ?? "2",
      "Task[status]": taskData.status ?? "1",
      "Task[priority]": taskData.priority ?? "1",
    };
    if (taskData.dueDate) data["Task[due_date]"] = taskData.dueDate;
    if (taskData.assignedTo) data["Task[assigned_to]"] = taskData.assignedTo;
    if (taskData.description) data["Task[description]"] = taskData.description;

    const result = (await this.post("/tasks/save", data)) as {
      result?: string;
      id?: string | number;
      message?: unknown;
    };
    if (result?.result === "success") {
      return { success: true, taskId: result.id, message: result.message };
    }
    return { success: false, errors: result?.message };
  }

  // ========================================================================
  // RFI METHODS
  // ========================================================================

  /** Source L559–561. */
  async getRFIs<T = unknown>(options: DatatableParams = {}): Promise<T | null> {
    return this.datatable<T>("rfis", options);
  }

  /** Source L563–598. */
  async createRFI(rfiData: {
    subject: string;
    projectId: string | number;
    locationId?: string | number;
    status?: string | number;
    priority?: string | number;
    question?: string;
    assignedTo?: string | number;
  }): Promise<{
    success: boolean;
    rfiId?: string | number;
    message?: unknown;
    errors?: unknown;
  }> {
    await this.ensureAuthenticated();

    const formData = new URLSearchParams();
    formData.append("Rfi[subject]", rfiData.subject);
    formData.append("Rfi[project_id]", String(rfiData.projectId));
    formData.append("Rfi[locations_room_id]", String(rfiData.locationId ?? "2"));
    formData.append("Rfi[status]", String(rfiData.status ?? "1"));
    formData.append("Rfi[priority]", String(rfiData.priority ?? "1"));
    if (rfiData.question) formData.append("Rfi[question]", rfiData.question);
    if (rfiData.assignedTo) {
      formData.append("Rfi[assigned_to]", String(rfiData.assignedTo));
    }

    const response = await this.request(
      `${this.baseUrl}/rfis/save`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json",
          ...(this.xsrfToken ? { "X-XSRF-TOKEN": this.xsrfToken } : {}),
        },
        body: formData.toString(),
      },
      false,
    );

    try {
      const result = JSON.parse(response.body) as {
        result?: string;
        id?: string | number;
        message?: unknown;
      };
      if (result?.result === "success") {
        return { success: true, rfiId: result.id, message: result.message };
      }
      return { success: false, errors: result?.message };
    } catch {
      return { success: false, errors: "Server error" };
    }
  }

  // ========================================================================
  // INVOICE METHODS
  // ========================================================================

  /**
   * Source L602–652. Harvests a fresh `_token` from `/invoices/form` before
   * submitting, because the invoice save endpoint validates a per-form token.
   */
  async createInvoice(invoiceData: {
    companyId: string | number;
    number: string | number;
    date: string;
    dueDate: string;
    status?: string | number;
    paymentDays?: string | number;
    notes?: string;
  }): Promise<{
    success: boolean;
    invoiceId?: string | number;
    message?: unknown;
    errors?: unknown;
  }> {
    await this.ensureAuthenticated();

    const formResp = await this.request(
      `${this.baseUrl}/invoices/form`,
      {
        headers: { Accept: "text/html", "X-Requested-With": "XMLHttpRequest" },
      },
      false,
    );

    let csrfToken: string | null = this.xsrfToken;
    if (formResp.status === 200) {
      const tokenMatch = formResp.body.match(
        /name=['"]_token['"][^>]*value=['"]([^'"]+)['"]/i,
      );
      if (tokenMatch) csrfToken = tokenMatch[1];
    }

    const formData = new URLSearchParams();
    if (csrfToken) formData.append("_token", csrfToken);
    formData.append("from", "buildtools");
    formData.append("Invoice[company_id]", String(invoiceData.companyId));
    formData.append("Invoice[status]", String(invoiceData.status ?? "1"));
    formData.append("Invoice[number]", String(invoiceData.number));
    formData.append("Invoice[date]", invoiceData.date);
    formData.append("Invoice[due_date]", invoiceData.dueDate);
    formData.append("Invoice[payment_days]", String(invoiceData.paymentDays ?? "30"));
    if (invoiceData.notes) formData.append("Invoice[notes]", invoiceData.notes);
    formData.append("items", "[]");
    formData.append("approvals", "[]");
    formData.append("pos", "[]");
    formData.append("payments", "[]");

    const response = await this.request(
      `${this.baseUrl}/invoices/save`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json",
          ...(this.xsrfToken ? { "X-XSRF-TOKEN": this.xsrfToken } : {}),
        },
        body: formData.toString(),
      },
      false,
    );

    try {
      const result = JSON.parse(response.body) as {
        result?: string;
        id?: string | number;
        message?: unknown;
      };
      if (result?.result === "success") {
        return { success: true, invoiceId: result.id, message: result.message };
      }
      return { success: false, errors: result?.message };
    } catch {
      return { success: false, errors: "Server error" };
    }
  }

  // ========================================================================
  // FINANCIAL STATEMENT METHODS
  // ========================================================================

  /**
   * Source L670–704. Creates a $0 shell statement. For statements with a
   * dollar amount use `createFinancialStatementWithAmount`.
   */
  async createFinancialStatement(statementData: {
    projectId: string | number;
    name?: string;
    reportPreviousBalance?: string | number;
    creditAmount?: string | number;
    notes?: string;
    financialMethod?: string | number;
  }): Promise<{
    success: boolean;
    statementId?: string | number;
    message?: unknown;
    errors?: unknown;
  }> {
    await this.ensureAuthenticated();
    if (!statementData.projectId) {
      throw new BuildToolsServerError("projectId is required");
    }

    const formData = new URLSearchParams();
    formData.append("FinancialStatement[name]", statementData.name ?? "Financial Statement");
    formData.append(
      "FinancialStatement[report_previous_balance]",
      String(statementData.reportPreviousBalance ?? "0"),
    );
    formData.append(
      "FinancialStatement[credit_amount]",
      String(statementData.creditAmount ?? "0"),
    );
    formData.append("FinancialStatement[notes]", statementData.notes ?? "");
    formData.append("financial_method", String(statementData.financialMethod ?? "3"));

    const saveUrl = `${this.baseUrl}/financial/statements/save?PR[]=${statementData.projectId}`;

    const response = await this.request(
      saveUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json",
          ...(this.xsrfToken ? { "X-XSRF-TOKEN": this.xsrfToken } : {}),
        },
        body: formData.toString(),
      },
      false,
    );

    try {
      const result = JSON.parse(response.body) as {
        result?: string;
        id?: string | number;
        message?: unknown;
      };
      if (result?.result === "success") {
        return { success: true, statementId: result.id, message: result.message };
      }
      return { success: false, errors: result?.message };
    } catch {
      return { success: false, errors: "Server error" };
    }
  }

  /**
   * Source L730–827. Loads `/financial/statements/form` to harvest CSRF and
   * `budgetOverviewTotals`, patches `financial_current_amount`, and POSTs
   * the save with the patched payload.
   */
  async createFinancialStatementWithAmount(data: {
    projectId: string | number;
    name: string;
    amount: string | number;
    notes?: string;
    status?: string | number;
    reportPreviousBalance?: string | number;
    creditAmount?: string | number;
    assignedTo?: string | number;
  }): Promise<{
    success: boolean;
    statementId?: string | number;
    amount?: string;
    message?: unknown;
    errors?: unknown;
  }> {
    await this.ensureAuthenticated();
    if (!data.projectId) throw new BuildToolsServerError("projectId is required");
    if (data.amount === undefined || data.amount === null) {
      throw new BuildToolsServerError("amount is required");
    }
    if (!data.name) throw new BuildToolsServerError("name is required");

    const formResp = await this.request(
      `${this.baseUrl}/financial/statements/form?PR[]=${data.projectId}`,
      {
        headers: { Accept: "text/html", "X-Requested-With": "XMLHttpRequest" },
      },
      false,
    );
    if (formResp.status !== 200) {
      return { success: false, errors: `Form load failed: HTTP ${formResp.status}` };
    }

    const decodeHtml = (s: string): string =>
      s
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#039;/g, "'");

    const grab = (re: RegExp): string | null => {
      const m = formResp.body.match(re);
      return m ? m[1] : null;
    };
    const csrfToken = grab(/name="_token"[^>]*value="([^"]+)"/);
    const tempToken = grab(/name="temp_token"[^>]*value="([^"]+)"/);
    const financialMethod =
      grab(/name="financial_method"[^>]*value="([^"]+)"/) ?? "3";
    const botRaw = grab(/name="budgetOverviewTotals"[^>]*value="([^"]+)"/);

    if (!csrfToken || !botRaw) {
      return {
        success: false,
        errors: "Could not parse CSRF token or budgetOverviewTotals from form",
      };
    }

    const totals = JSON.parse(decodeHtml(botRaw)) as Record<string, unknown>;
    totals.financial_current_amount = Number(data.amount);
    const botPatched = JSON.stringify(totals);

    let assignedTo: string | number | undefined = data.assignedTo;
    if (assignedTo === undefined) {
      const selBlock = formResp.body.match(
        /<select[^>]*name="assigned_to\[\]"[\s\S]*?<\/select>/,
      );
      const sel =
        selBlock && selBlock[0].match(/<option[^>]*selected[^>]*value="(\d+)"/);
      assignedTo = sel ? sel[1] : undefined;
    }

    const fd = new URLSearchParams();
    fd.append("_token", csrfToken);
    if (tempToken) fd.append("temp_token", tempToken);
    fd.append("FinancialStatement[name]", data.name);
    fd.append("FinancialStatement[status]", String(data.status ?? 1));
    fd.append(
      "FinancialStatement[report_previous_balance]",
      String(data.reportPreviousBalance ?? 0),
    );
    fd.append("FinancialStatement[credit_amount]", String(data.creditAmount ?? 0));
    fd.append("FinancialStatement[notes]", data.notes ?? "");
    fd.append("financial_method", financialMethod);
    fd.append("items", "[]");
    fd.append("approvals", "[]");
    fd.append("payments", "[]");
    fd.append("budgetOverviewTotals", botPatched);
    fd.append("hide_employee", "1");
    fd.append("hide_client", "1");
    fd.append("hide_representative", "1");
    fd.append("status_send", "");
    fd.append("report_send", "");
    fd.append("apradio", "amount");
    if (assignedTo !== undefined) fd.append("assigned_to[]", String(assignedTo));

    const saveResp = await this.request(
      `${this.baseUrl}/financial/statements/save?PR[]=${data.projectId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json",
          "X-CSRF-TOKEN": csrfToken,
          ...(this.xsrfToken ? { "X-XSRF-TOKEN": this.xsrfToken } : {}),
        },
        body: fd.toString(),
      },
      false,
    );

    try {
      const result = JSON.parse(saveResp.body) as {
        result?: string;
        id?: string | number;
        message?: unknown;
      };
      if (result?.result === "success") {
        return {
          success: true,
          statementId: result.id,
          amount: String(data.amount),
          message: result.message,
        };
      }
      return { success: false, errors: result?.message ?? result };
    } catch {
      return {
        success: false,
        errors: `Non-JSON response (HTTP ${saveResp.status}): ${saveResp.body.slice(0, 300)}`,
      };
    }
  }

  /** Source L840–886. */
  async deleteFinancialStatement(
    statementIds: string | number | Array<string | number>,
    projectId: string | number,
  ): Promise<{
    success: boolean;
    succeeded?: number;
    failed?: number;
    raw?: unknown;
    errors?: unknown;
  }> {
    await this.ensureAuthenticated();
    if (!projectId) throw new BuildToolsServerError("projectId is required");
    const ids = Array.isArray(statementIds) ? statementIds : [statementIds];
    if (ids.length === 0) {
      throw new BuildToolsServerError("statementIds is required");
    }

    const formResp = await this.request(
      `${this.baseUrl}/financial/statements/form?PR[]=${projectId}`,
      {
        headers: { Accept: "text/html", "X-Requested-With": "XMLHttpRequest" },
      },
      false,
    );
    const csrf = (formResp.body.match(/name="_token"[^>]*value="([^"]+)"/) ?? [])[1];
    if (!csrf) {
      return { success: false, errors: "Could not harvest CSRF token" };
    }

    const fd = new URLSearchParams();
    fd.append("_token", csrf);
    for (const id of ids) fd.append("ids[]", String(id));

    const resp = await this.request(
      `${this.baseUrl}/financial/statements/delete?PR[]=${projectId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json",
          "X-CSRF-TOKEN": csrf,
          ...(this.xsrfToken ? { "X-XSRF-TOKEN": this.xsrfToken } : {}),
        },
        body: fd.toString(),
      },
      false,
    );

    try {
      const result = JSON.parse(resp.body) as {
        r?: number;
        s?: number;
        f?: number;
      };
      return {
        success: result.r === 1 && (result.s ?? 0) > 0,
        succeeded: result.s ?? 0,
        failed: result.f ?? 0,
        raw: result,
      };
    } catch {
      return {
        success: false,
        errors: `HTTP ${resp.status}: ${resp.body.slice(0, 200)}`,
      };
    }
  }

  // ========================================================================
  // USER METHODS
  // ========================================================================

  /** Source L901–903. */
  async getUsers<T = unknown>(options: DatatableParams = {}): Promise<T | null> {
    return this.datatable<T>("users", options);
  }

  /** Source L905–907. */
  async searchUsers<T = unknown>(
    query: string,
    limit: number = 50,
  ): Promise<T | null> {
    return this.datatable<T>("users", {
      "search[value]": query,
      length: limit,
    });
  }

  /** Source L909–917. column[4] filter for role=Employee. */
  async getEmployees<T = unknown>(
    options: DatatableParams = {},
  ): Promise<T | null> {
    const params: DatatableParams = {
      ...options,
      "columns[4][search][value]": "Employee",
    };
    return this.datatable<T>("users", params);
  }

  // ========================================================================
  // SERVICE METHODS
  // ========================================================================

  /** Source L921–923. */
  async getServices<T = unknown>(options: DatatableParams = {}): Promise<T | null> {
    return this.datatable<T>("services", options);
  }

  /** Source L925–946. */
  async createService(serviceData: {
    name: string;
    projectId: string | number;
    description?: string;
    locationId?: string | number;
    status?: string | number;
    dueDate?: string;
    assignedTo?: string | number;
  }): Promise<{
    success: boolean;
    serviceId?: string | number;
    message?: unknown;
    errors?: unknown;
  }> {
    await this.ensureAuthenticated();

    const data: PostData = {
      "Service[name]": serviceData.name,
      "Service[project_id]": serviceData.projectId,
      "Service[description]": serviceData.description ?? null,
      "Service[locations_room_id]": serviceData.locationId ?? "2",
      "Service[status]": serviceData.status ?? "1",
    };
    if (serviceData.dueDate) data["Service[due_date]"] = serviceData.dueDate;
    if (serviceData.assignedTo) data["Service[assigned_to]"] = serviceData.assignedTo;

    const result = (await this.post("/services/save", data)) as {
      result?: string;
      id?: string | number;
      message?: unknown;
    };
    if (result?.result === "success") {
      return { success: true, serviceId: result.id, message: result.message };
    }
    return { success: false, errors: result?.message };
  }

  // ========================================================================
  // WORK TRACKING METHODS
  // ========================================================================

  /** Source L950–952. */
  async getDailyLogs<T = unknown>(
    options: DatatableParams = {},
  ): Promise<T | null> {
    return this.datatable<T>("daily-logs", options);
  }

  /** Source L954–956. */
  async getWeeklyReports<T = unknown>(
    options: DatatableParams = {},
  ): Promise<T | null> {
    return this.datatable<T>("weekly-reports", options);
  }

  /** Source L958–960. */
  async getWorkDays<T = unknown>(
    options: DatatableParams = {},
  ): Promise<T | null> {
    return this.datatable<T>("work-days", options);
  }

  // ========================================================================
  // CERTIFICATE METHODS
  // ========================================================================

  /** Source L964–966. */
  async getCertificates<T = unknown>(
    options: DatatableParams = {},
  ): Promise<T | null> {
    return this.datatable<T>("certificates", options);
  }

  /** Source L968–970. */
  async searchCertificates<T = unknown>(
    query: string,
    limit: number = 50,
  ): Promise<T | null> {
    return this.datatable<T>("certificates", {
      "search[value]": query,
      length: limit,
    });
  }

  // -------------------------------------------------------------------------
  // private helpers
  // -------------------------------------------------------------------------

  /** Normalize array-or-scalar form-field values for `post(...)`. */
  private toFormFieldValue(
    value: string | number | Array<string | number> | undefined,
  ): PostFieldValue {
    if (value === undefined) return undefined;
    if (Array.isArray(value)) return value;
    return value;
  }
}
