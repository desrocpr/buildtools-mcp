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

import { randomBytes } from "node:crypto";

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

/**
 * PO status code → human label. Verified live against moss.buildtools.app
 * on 2026-06-24 from the form's `<select name="PurchaseOrder[status]">`
 * dropdown. The previous "Pending" / "Approved" mapping was inferred from
 * change orders and was WRONG for POs — BT calls them "Sent" and
 * "Confirmed". Unknown codes fall back to `String(code)`.
 *
 * Note: BT's UI relabels code 1 as "Cancel (Draft)" when transitioning
 * FROM a higher state — same code, context-dependent label. We use the
 * canonical "Draft" label here.
 */
export const PURCHASE_ORDER_STATUS_LABELS: Record<number, string> = {
  1: "Draft",
  2: "Sent",
  3: "Confirmed",
  4: "Rejected",
};

/** Inverse map for label-to-code lookup (used by `update_purchase_order`'s `status` arg). */
export const PURCHASE_ORDER_STATUS_CODES: Record<string, number> = {
  Draft: 1,
  Sent: 2,
  Confirmed: 3,
  Rejected: 4,
};

/**
 * Statuses BT locks against writes via /purchase-orders/save. Verified
 * 2026-06-24: a save call (even status-only, even no-op preserve-all)
 * returns HTTP 403 with empty body when current status is 3 (Confirmed).
 * There is no alternate unlock endpoint exposed by the UI — only /save.
 *
 * TODO: if BT silently locks another code in future (e.g. code 2/Sent
 * becomes write-locked too), the symptom is the executor returning
 * `HTTP 403 — result: (absent) ...` instead of our proactive lock
 * message. Add the new code to this Set when that happens. Live-probe
 * technique: POST a no-op save (current values re-submitted) and check
 * for 403 vs 200 across each candidate status. Documented in PR #57.
 */
export const PURCHASE_ORDER_WRITE_LOCKED_STATUSES: ReadonlySet<number> = new Set([3]);

/**
 * Input shape for a single PO line item in `updatePurchaseOrder`. Caller
 * MUST provide exactly one of `budgetCategoryId`, `budgetItemId`, or
 * `budgetCode` — the method resolves the others internally via
 * `getBudget(projectId)`. Providing zero or multiple returns a clean
 * error before any save attempt.
 *
 * - `budgetCategoryId` (e.g. 1680) is the catalog ID BT actually wants
 *   on the line item record.
 * - `budgetItemId` (e.g. 56990) is the per-project budget row ID
 *   surfaced by `list_budget`. Common confusion point — many callers
 *   reflexively copy the "ID" column from list_budget.
 * - `budgetCode` (e.g. "7051") is the human-facing budget code. Most
 *   ergonomic for LLM callers who can read the code from the budget
 *   listing.
 */
export interface UpdatePurchaseOrderItemInput {
  budgetCategoryId?: string | number;
  budgetItemId?: string | number;
  budgetCode?: string;
  description: string;
  total: number | string;
  quantity?: number | string;
  unit?: string;
  notes?: string;
  internalNotes?: string;
  companyId?: string | number;
}

/**
 * Build the actionable error message returned when a caller attempts to
 * update a PO whose current status is in PURCHASE_ORDER_WRITE_LOCKED_STATUSES.
 * Extracted from the inline string so adding a new lock state (or refining
 * the workaround wording) is a single-site edit.
 */
export function formatPurchaseOrderLockError(poId: number, statusCode: number): string {
  const label = PURCHASE_ORDER_STATUS_LABELS[statusCode] ?? `code ${statusCode}`;
  return (
    `PO #${poId} is in **${label}** state (code ${statusCode}) — ` +
    `BuildTools' /purchase-orders/save endpoint refuses ALL writes on it ` +
    `(verified live: even a no-op save returns HTTP 403). ` +
    `**To apply changes anyway, re-invoke with \`unlock_if_locked: true\`** ` +
    `— the tool will demote → apply edits → restore to Sent (so the vendor ` +
    `re-acknowledges the change) via the workflow endpoint ` +
    `\`/purchase-orders/status/update\`. ` +
    `Alternatives: (a) void this PO in the BT web UI and create a replacement ` +
    `via create_purchase_order, or (b) edit in the BT web UI directly.`
  );
}

/**
 * Decode the common HTML entities BuildTools emits on form inputs.
 * Shared by every form-HTML parser (selection name, PO name, etc.) —
 * keep the entity list in one place so a gap (`&hellip;`!) caught for
 * one parser benefits them all.
 */
function decodeFormEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * Shape returned by `getPurchaseOrder()`. Scalar fields come from the
 * `<input name="PurchaseOrder[...]">` hidden inputs on the edit form;
 * `companyId` comes from `<select id="select_company_id">`; `items[]` is
 * decoded from the hidden `<input name="items">` (JSON, HTML-entity
 * escaped).
 */
export interface PurchaseOrderDetail {
  id: number;
  projectId: number | null;
  name: string;
  number: string;
  prefix: string;
  /**
   * Status code from `<select name="PurchaseOrder[status]">` selected
   * option. `null` only when the form parse couldn't find a selected
   * option (e.g. BT template drift). Use PURCHASE_ORDER_STATUS_LABELS
   * to render.
   */
  status: number | null;
  /**
   * Description body from the `<textarea name="PurchaseOrder[description]">`,
   * HTML-entities decoded. Empty string when the textarea is empty.
   */
  description: string;
  companyId: number | null;
  companyName: string;
  items: Array<{
    id: number | null;
    budgetCategoryId: number | null;
    budgetCategoryCode: string;
    budgetCategoryName: string;
    total: string;
    notes: string;
    internalNotes: string;
    invoiceRelated: string;
    amounts: Array<Record<string, unknown>>;
    companyId: number | null;
    companyName: string;
  }>;
  /** Sum of line item totals (best-effort; numeric parsed from item.total). */
  totalNumeric: number;
}

// ---------------------------------------------------------------------------
// Budget cell helpers
// ---------------------------------------------------------------------------

/**
 * Parse the first "$ X.XX" amount from a string (handles negatives).
 * Returns 0 if no match or if the captured value isn't numeric. Used for
 * single-value columns (APPROVED CO's, REMAINING BUDGET, etc.).
 */
function parseFirstAmount(s: string): number {
  if (!s || s === "-") return 0;
  // Match $X.XX or -$X.XX (sign attached, no whitespace between sign and $).
  // A standalone "- " before $ is the BuildTools placeholder for "empty", not a sign.
  const m = s.match(/(-)?\$\s*-?[\d,]+\.\d{2}/);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  const digits = m[0].replace(/[^\d.-]/g, "").replace(/^-/, "");
  const n = Number(digits);
  return Number.isFinite(n) ? sign * n : 0;
}

/**
 * Parse two "$ X.XX" amounts from a string into [published, working].
 * Cells in the BUDGET / REVISED BUDGET columns concatenate published and
 * working values like "$ 2,200.00 $ 2,200.00" or "- $ 1,500.00" (published
 * empty, working = 1500). Returns [0, 0] if no amounts found.
 */
function parseDualAmount(s: string): [number, number] {
  if (!s) return [0, 0];
  // Match each "$X.XX" or "-$X.XX" — sign must be attached to $ (no whitespace).
  // A standalone "- " before $ is the BuildTools placeholder for "empty".
  const matches = s.match(/(-)?\$\s*-?[\d,]+\.\d{2}/g) ?? [];
  const toNum = (raw: string | undefined): number => {
    if (!raw) return 0;
    const sign = raw.startsWith("-") ? -1 : 1;
    const digits = raw.replace(/[^\d.-]/g, "").replace(/^-/, "");
    const n = Number(digits);
    return Number.isFinite(n) ? sign * n : 0;
  };
  if (matches.length === 0) return [0, 0];
  if (matches.length === 1) {
    // One value present. The leading "-" placeholder (e.g. "- $ 1,500.00")
    // indicates published is empty/zero and the single value is working.
    if (/^\s*-\s/.test(s)) return [0, toNum(matches[0])];
    return [toNum(matches[0]), toNum(matches[0])];
  }
  return [toNum(matches[0]), toNum(matches[1])];
}

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

    // Invalidate the cached App.bt.token from any prior session — the
    // value is session-bound and the upload retry logic in
    // `uploadAttachment` only re-harvests on a 401/403, not on every
    // re-auth. Without this clear, a session rotation on the BT side
    // followed by a manual `authenticate()` call would leave the
    // upload path using a stale token until the first failure.
    this.uploadToken = null;

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
   *
   * Limitation: requests up to 5000 rows. If the tenant has more projects,
   * older ones may be silently missed. The moss tenant has ~3500 total.
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
      throw new BuildToolsServerError("projectManager is required for updates");
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
   * Free-text search across the companies/vendors directory (the same
   * endpoint that powers the "Add Vendor to PO" picker). Optionally
   * filtered by role via the DataTables column-search on `type_name`
   * (column 3 in the live grid). Verified against moss.buildtools.app on
   * 2026-06-23.
   *
   * Returns the standard datatable envelope `{ recordsTotal,
   * recordsFiltered, data: Row[] }`. Each row carries the row id in
   * `DT_RowId` as `row_<id>` (BuildTools companies do not expose a top-
   * level `id` field on this endpoint — strip the `row_` prefix to get
   * the numeric id).
   */
  async searchCompanies<T = unknown>(
    query: string,
    options: {
      role?: "Vendor" | "Subcontractor" | "Customer";
      limit?: number;
    } = {},
  ): Promise<T | null> {
    const params: Record<string, string | number> = {
      "search[value]": query,
      length: options.limit ?? 25,
    };
    if (options.role) {
      // Column 3 in the live grid is `type_name`. Passing
      // `columns[3][search][value]` exercises the same path BuildTools
      // uses internally when a user picks a role from the filter dropdown.
      params["columns[3][search][value]"] = options.role;
    }
    return this.datatable<T>("companies", params);
  }

  /**
   * Fetches a single row from the `companies` table by ID. BuildTools
   * doesn't expose `/companies/:id/form` (returns 404), so we pull from
   * the companies datatable and match by `DT_RowId === "row_<id>"`.
   * Up to 5000 rows scanned; Moss tenant has ~1100.
   *
   * Note: BuildTools stores customers, vendors, and subcontractors in
   * one `companies` table differentiated by `type_name`. This is the
   * canonical lookup; `getCustomer` is a legacy alias that delegates
   * here for the existing `get_customer` tool.
   */
  async getCompany<T = unknown>(
    companyId: string | number,
  ): Promise<T | null> {
    const numericId = Number(companyId);
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
   * Legacy alias for `getCompany` — kept so the existing `get_customer`
   * MCP tool continues to work. BuildTools stores customers, vendors,
   * and subcontractors in one `companies` table; this method just
   * forwards to the canonical lookup. New callers should use
   * `getCompany` directly.
   */
  async getCustomer<T = unknown>(
    customerId: string | number,
  ): Promise<T | null> {
    return this.getCompany<T>(customerId);
  }

  /**
   * Lists attachments and folders for a project's Documents tab.
   *
   * - **Root listing** (no `folderId`): `GET /documents?PR[]=<id>` returns
   *   the full HTML page with the root tree embedded as a
   *   `mapInit([...], rootId)` JS call. We parse the array literal out.
   * - **Folder drilldown** (with `folderId`): `GET /documents?PR[]=<id>&list=d-<projectId>-<folderId>`
   *   returns JSON `{ r: 1, items: [...] }` with the folder's direct children.
   *
   * Both paths return the same item shape (raw snake_case). Each item carries
   * `is_dir` (true for folders), `id`, `name`, `parent_id`, `extension`,
   * `size`, `created_at`, `user_name`, `public_url`, `url_main`, and `key`
   * (e.g. `d-185936-134629` for folders, `f-185936-137530` for files).
   *
   * Returns `[]` on non-200 or unparseable body.
   */
  async getProjectAttachments(
    projectId: string | number,
    options?: { folderId?: string | number },
  ): Promise<Array<Record<string, unknown>>> {
    await this.ensureAuthenticated();
    if (!projectId) throw new BuildToolsServerError("projectId is required");

    const drilldown = options?.folderId !== undefined && options.folderId !== null;
    const listParam = drilldown
      ? `&list=d-${projectId}-${options!.folderId}`
      : "";

    const response = await this.request(
      `${this.baseUrl}/documents?PR[]=${projectId}${listParam}`,
      {
        method: "GET",
        headers: {
          Accept: drilldown ? "application/json" : "text/html",
          "X-Requested-With": "XMLHttpRequest",
        },
      },
      false,
    );

    if (response.status !== 200) return [];

    if (drilldown) {
      try {
        const data = JSON.parse(response.body) as {
          items?: Array<Record<string, unknown>>;
        };
        return data.items ?? [];
      } catch {
        return [];
      }
    }

    const match = response.body.match(/mapInit\(\[([\s\S]*?)\],\s*rootId\)/);
    if (!match) return [];
    const inner = match[1].trim();
    if (inner === "") return [];
    try {
      return JSON.parse("[" + inner + "]") as Array<Record<string, unknown>>;
    } catch {
      return [];
    }
  }

  /**
   * Downloads the bytes of a BuildTools-hosted attachment using the
   * authenticated session. Designed for the public download URLs surfaced by
   * `getProjectAttachments` (typically `https://file.buildtools.app/...`),
   * which 302 to short-lived presigned S3 URLs. We follow that redirect chain
   * in-process so cookies stay per-host (BuildTools cookies don't leak to S3
   * and the S3 hop doesn't need any auth header of its own).
   *
   * SSRF guard: only URLs under `*.buildtools.app` (or the configured base
   * tenant host) and `*.amazonaws.com` (the redirected S3 location) are
   * followed. Size cap defaults to 25 MB to keep responses inside MCP
   * tool-result limits; throws on overrun.
   */
  async downloadAttachment(
    urlString: string,
    options: { maxSizeBytes?: number; timeoutMs?: number } = {},
  ): Promise<{ buffer: Buffer; mimeType: string; filename: string; finalUrl: string }> {
    await this.ensureAuthenticated();
    if (!urlString) throw new BuildToolsServerError("url is required");

    const maxSize = options.maxSizeBytes ?? 25 * 1024 * 1024;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    const isAllowedHost = (host: string): boolean =>
      /(^|\.)buildtools\.app$/i.test(host) || /\.amazonaws\.com$/i.test(host);

    let currentUrl = urlString;
    for (let hop = 0; hop < 10; hop++) {
      const url = new URL(currentUrl);
      if (!isAllowedHost(url.hostname)) {
        throw new BuildToolsServerError(
          `Refusing to download from non-allowlisted host: ${url.hostname}`,
        );
      }

      const headers: Record<string, string> = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "*/*",
      };
      const cookie = this.getCookieString(url.hostname);
      if (cookie) headers.Cookie = cookie;

      const controller = new AbortController();
      const timer =
        timeoutMs !== undefined
          ? setTimeout(() => controller.abort(), timeoutMs)
          : undefined;

      let resp: Response;
      try {
        resp = await this.fetchImpl(currentUrl, {
          method: "GET",
          headers,
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (err) {
        throw new BuildToolsNetworkError(
          `Network error downloading ${currentUrl}: ${(err as Error)?.message ?? String(err)}`,
          { cause: err, url: currentUrl },
        );
      } finally {
        if (timer) clearTimeout(timer);
      }

      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get("location");
        if (!location) {
          throw new BuildToolsServerError(
            `Redirect with no Location header at ${currentUrl}`,
          );
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (resp.status !== 200) {
        throw new BuildToolsServerError(
          `Download failed: HTTP ${resp.status} for ${currentUrl}`,
        );
      }

      const contentLengthHeader = resp.headers.get("content-length");
      if (contentLengthHeader !== null) {
        const declared = Number(contentLengthHeader);
        if (Number.isFinite(declared) && declared > maxSize) {
          throw new BuildToolsServerError(
            `Attachment too large: ${declared} bytes (max ${maxSize}).`,
          );
        }
      }

      const ab = await resp.arrayBuffer();
      if (ab.byteLength > maxSize) {
        throw new BuildToolsServerError(
          `Attachment too large: ${ab.byteLength} bytes (max ${maxSize}).`,
        );
      }
      const buffer = Buffer.from(ab);

      const mimeType =
        resp.headers.get("content-type")?.split(";")[0].trim() ||
        "application/octet-stream";

      let filename = "";
      const disposition = resp.headers.get("content-disposition") ?? "";
      const dispMatch = disposition.match(
        /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i,
      );
      if (dispMatch) {
        try {
          filename = decodeURIComponent(dispMatch[1]);
        } catch {
          filename = dispMatch[1];
        }
      } else {
        const lastSegment = new URL(currentUrl).pathname.split("/").pop();
        filename = lastSegment ? decodeURIComponent(lastSegment) : "download";
      }

      return { buffer, mimeType, filename, finalUrl: currentUrl };
    }
    throw new BuildToolsServerError(
      `Too many redirects fetching ${urlString}`,
    );
  }

  /**
   * App.bt.token cache. The token is emitted as inline JSON on most
   * authenticated pages (e.g. /documents?PR[]=<id>). One value per
   * authenticated session — re-harvested if the session is rotated.
   */
  private uploadToken: string | null = null;

  /**
   * Harvest the `App.bt.token` value used by the file-upload endpoint.
   * Lazily fetches the project's documents page (which is small enough
   * for a cheap one-time scrape) and caches the result. Re-thrown on
   * non-200 / unparseable response — uploads can't proceed without it.
   */
  private async getUploadToken(projectId: string | number): Promise<string> {
    if (this.uploadToken) return this.uploadToken;
    await this.ensureAuthenticated();
    const resp = await this.request(
      `${this.baseUrl}/documents?PR[]=${projectId}`,
      {
        headers: {
          Accept: "text/html",
          "X-Requested-With": "XMLHttpRequest",
        },
      },
      false,
    );
    if (resp.status !== 200) {
      throw new BuildToolsServerError(
        `Could not load documents page to harvest upload token (HTTP ${resp.status})`,
      );
    }
    // The token is emitted as: bt: { token: '11134.6.764751e99c', ... }
    const match = resp.body.match(/bt:\s*\{\s*token:\s*['"]([^'"]+)['"]/);
    if (!match) {
      throw new BuildToolsServerError(
        "Could not find App.bt.token in the documents page HTML — BuildTools template may have drifted.",
      );
    }
    this.uploadToken = match[1];
    return this.uploadToken;
  }

  /**
   * Uploads a file to BuildTools and associates it with the given
   * entity. Verified live 2026-06-27 against `https://file.buildtools.app/files`.
   *
   * Mechanism: POST multipart/form-data to file.buildtools.app/files
   * carrying the App.bt.token harvested from /documents?PR[]=<id>, the
   * file payload as `files[]`, plus entity-context fields:
   *   - `project_id` (required — every entity sits under a project)
   *   - `module`     (1000 = project documents, 1500 = purchase order,
   *                   …extensible per BT's module catalog)
   *   - `module_id`  (the entity's primary key in its module)
   *
   * Returns the file metadata BuildTools assigns: its file_id, hashes,
   * download/public URLs, etc. The same file then appears in
   * `getProjectAttachments(projectId)` and (for module=1500) on the PO's
   * email/attachments tab.
   *
   * Size cap defaults to 25 MB to match the download path's limit. The
   * BuildTools UI reports cleaner errors for oversize than the server's
   * raw 413, so we reject early.
   */
  async uploadAttachment(opts: {
    projectId: string | number;
    /** Module code: 1000=documents, 1500=purchase-orders. */
    module: number;
    /** Entity id within the module (project_id for module=1000; PO id for module=1500). */
    moduleId: string | number;
    /** Raw bytes of the file. */
    fileBuffer: Buffer;
    /** Original filename including extension. */
    filename: string;
    /** MIME type. Defaults to application/octet-stream. */
    contentType?: string;
    /** Max upload size in bytes. Default 25 MB. */
    maxSizeBytes?: number;
  }): Promise<{
    fileId: number;
    hash: string;
    name: string;
    extension: string;
    mimeType: string;
    size: number;
    downloadUrl: string;
    publicUrl: string;
    module: string;
    moduleId: string;
    projectId: string;
    createdAt: string;
  }> {
    await this.ensureAuthenticated();
    const maxSize = opts.maxSizeBytes ?? 25 * 1024 * 1024;
    if (opts.fileBuffer.length > maxSize) {
      throw new BuildToolsServerError(
        `File ${opts.filename} is ${opts.fileBuffer.length} bytes; exceeds max ${maxSize} bytes.`,
      );
    }
    if (!opts.filename) {
      throw new BuildToolsServerError("filename is required");
    }

    // Sanitize the filename + content-type BEFORE interpolating into
    // the multipart header. Any literal `\r` / `\n` (or `"`) in either
    // string would let an attacker close the header early and inject
    // arbitrary new headers — classic CRLF injection in a multipart
    // boundary. We strip control chars; non-ASCII filenames lose
    // fidelity here (RFC 5987's `filename*=UTF-8''...` would preserve
    // them, but BT's parser is the bottleneck and we haven't probed
    // that surface).
    const safeFilename = opts.filename.replace(/["\r\n]/g, "");
    const safeContentType = (opts.contentType ?? "application/octet-stream")
      .replace(/[\r\n]/g, "");

    // Build a manual multipart body — we don't pull in form-data as a
    // dep for a single call site. CRLF line endings per RFC 7578.
    // Boundary: 32 hex chars from crypto.randomBytes (~128 bits of
    // entropy) so a binary payload can never collide with it — the
    // previous `Math.random()` form was non-crypto and gave only ~50
    // bits, theoretically race-able for large file uploads.
    const CRLF = "\r\n";
    const uploadUrl = "https://file.buildtools.app/files";

    // Retry-once wrapper around the actual upload — if BT returns 401/403
    // we assume the cached App.bt.token has been rotated server-side,
    // clear the cache, re-harvest, and try again. Without this a long-
    // running MCP session would silently fail uploads after the first
    // session rotation.
    let attempt = 0;
    let resp: Response;
    let respText = "";
    while (true) {
      const token = await this.getUploadToken(opts.projectId);
      const boundary = `----BTMCPBoundary${randomBytes(16).toString("hex")}`;
      const enc = (s: string) => Buffer.from(s, "utf8");
      const fieldPart = (name: string, value: string): Buffer =>
        enc(
          `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}` +
            `${value}${CRLF}`,
        );
      const filePartHeader = enc(
        `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="files[]"; filename="${safeFilename}"${CRLF}` +
          `Content-Type: ${safeContentType}${CRLF}${CRLF}`,
      );
      const body = Buffer.concat([
        fieldPart("token", token),
        fieldPart("project_id", String(opts.projectId)),
        fieldPart("module", String(opts.module)),
        fieldPart("module_id", String(opts.moduleId)),
        filePartHeader,
        opts.fileBuffer,
        enc(`${CRLF}--${boundary}--${CRLF}`),
      ]);

      resp = await this.fetchImpl(uploadUrl, {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          Accept: "application/json",
          // Cookie jar is keyed by HOSTNAME — passing the full URL
          // resolves to an empty jar entry and sends no cookies. The
          // upload currently succeeds because file.buildtools.app
          // authenticates via the `token` form field alone, but BT
          // could add session validation at any time and we'd silently
          // 403; doing this right today removes that latent risk.
          Cookie: this.getCookieString(new URL(uploadUrl).hostname),
        },
        body,
      });
      respText = await resp.text();
      if (resp.status === 200) break;
      // Retry once on auth-style failures with a fresh token.
      if ((resp.status === 401 || resp.status === 403) && attempt === 0) {
        attempt++;
        this.uploadToken = null;
        continue;
      }
      throw new BuildToolsServerError(
        `Upload failed (HTTP ${resp.status}): ${respText.slice(0, 300)}`,
      );
    }

    let parsed: { data?: { file?: Record<string, unknown> } };
    try {
      parsed = JSON.parse(respText);
    } catch {
      throw new BuildToolsServerError(
        `Upload returned non-JSON response: ${respText.slice(0, 200)}`,
      );
    }
    const file = parsed.data?.file;
    if (!file || typeof file !== "object") {
      throw new BuildToolsServerError(
        `Upload response missing data.file: ${respText.slice(0, 200)}`,
      );
    }

    return {
      fileId: Number(file.file_id) || 0,
      hash: String(file.hash ?? ""),
      name: String(file.display_name ?? file.name ?? ""),
      extension: String(file.extension ?? ""),
      mimeType: String(file.mime_type ?? ""),
      size: Number(file.size) || 0,
      downloadUrl: String(file.download_url ?? ""),
      publicUrl: String(file.public_url ?? ""),
      module: String(file.module ?? ""),
      moduleId: String(file.module_id ?? ""),
      projectId: String(file.project_id ?? ""),
      createdAt: String(file.created_at ?? ""),
    };
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
      /** Date the selection row was first created (ISO YYYY-MM-DD). */
      createdAt: string | null;
      /** Last modification — useful for cycle-time approximations when
       *  approvedDate is null. */
      updatedAt: string | null;
      /** Set when status transitioned to Approved/Purchased. */
      approvedDate: string | null;
      /** Set when status transitioned to Rejected. */
      rejectedDate: string | null;
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
      createdAt: string | null;
      updatedAt: string | null;
      approvedDate: string | null;
      rejectedDate: string | null;
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

        // Preserve raw cell HTML so we can do class-based extraction for
        // the "selection" (chosen option) cell, which sits at a variable
        // index depending on whether the "# REL." column is present.
        const cellsRaw: string[] = [];
        const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
        let cellMatch: RegExpExecArray | null;
        while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
          cellsRaw.push(cellMatch[1]);
        }

        // Column layout (stable across all statuses, verified live 2026-06-12):
        //   [0] expand  [1] checkbox  [2] status  [3] icon
        //   [4] category  [5] location  [6] item  [7] price  [8] dueDate
        //   then variable: [# REL.] [No] selection [info] [actions].
        // The first 9 cells are positionally reliable; the prior parser
        // tried to find them by content and bled Location/status-badge
        // titles ("Kitchen"/"Pending"/"Incomplete") into `item`.
        const cellAt = (i: number): string =>
          i < cellsRaw.length ? strip(cellsRaw[i]) : "";

        // Approved (status=3) rows drop the `edit-*` classes from the
        // category/location/item divs (the row is locked from editing),
        // so we can't rely on `class="edit-name"` etc. — we read by
        // position instead. The category cell does also still carry the
        // canonical name; fall back to the h2 category if cells[4] is empty.
        const categoryFromCell = cellAt(4);
        const locationFromCell = cellAt(5);
        const itemFromCell = cellAt(6);
        const priceFromCell = cellAt(7);
        const dueDateFromCell = cellAt(8);

        // The "chosen option" text lives in a div tagged `sgItemSelectText`
        // (editable rows) or a plain div containing the option name with a
        // checkmark icon (approved rows). Search by class first, fall back
        // to scanning later cells for the icon-0012 marker.
        let selectionFromCell = "";
        for (const cellHtml of cellsRaw) {
          const sgMatch = cellHtml.match(
            /<div[^>]*class="[^"]*\bsgItemSelectText\b[^"]*"[^>]*>([\s\S]*?)<\/div>/,
          );
          if (sgMatch) {
            selectionFromCell = strip(sgMatch[1]);
            break;
          }
          // Approved rows: <div ...><span class="icon-0012" ...></span> NAME</div>
          if (cellHtml.includes("icon-0012")) {
            const txt = strip(cellHtml);
            if (txt.length > 0) {
              selectionFromCell = txt;
              break;
            }
          }
        }

        selections.push({
          id,
          statusCode,
          status: STATUS_MAP[statusCode] ?? String(statusCode),
          // Prefer the per-row category cell when populated; else fall
          // back to the grid section h2.
          category: categoryFromCell || category,
          location: locationFromCell,
          item: itemFromCell,
          price: /^\$\s*[\d,]+\.\d{2}$/.test(priceFromCell) ? priceFromCell : "",
          dueDate: /^\d{2}\/\d{2}\/\d{4}$/.test(dueDateFromCell) ? dueDateFromCell : "",
          selection: selectionFromCell,
          notes: "",
          // Lifecycle dates aren't in the dashboard HTML — they come
          // from the MySQL replica merge below.
          createdAt: null,
          updatedAt: null,
          approvedDate: null,
          rejectedDate: null,
        });
      }
    }

    // Merge lifecycle dates from the read replica. Best-effort: if
    // the replica isn't configured/available, every selection just
    // keeps its null dates and the renderer omits them.
    if (selections.length > 0) {
      const { getSelectionDates } = await import("./MysqlReadReplica.js");
      const dateMap = await getSelectionDates(projectId);
      for (const s of selections) {
        const d = dateMap.get(s.id);
        if (d) {
          s.createdAt = d.createdAt;
          s.updatedAt = d.updatedAt;
          s.approvedDate = d.approvedDate;
          s.rejectedDate = d.rejectedDate;
          // Prefer the structured DB due_date over the HTML cell when both exist.
          if (d.dueDate && !s.dueDate) s.dueDate = d.dueDate;
        }
      }
    }

    return { statusCount, selections };
  }

  // (parseDualAmount and parseFirstAmount are defined at module scope below.)

  /**
   * Fetches allowance budget categories for a project. Parses the budget HTML
   * from GET /budget?PR[]=<projectId> and extracts rows whose category name
   * contains "Allowance".
   *
   * Each budget row has 16 cells. The key columns are:
   *   [1]  category name
   *   [6]  BUDGET           — original (published + working)
   *   [7]  APPROVED CO's
   *   [8]  REVISED BUDGET   — after approved COs (published + working)
   *
   * Cells [6] and [8] often contain TWO concatenated dollar values
   * (published + working). We split them and surface both. The user-facing
   * "budgeted amount" for allowance reconciliation is the working revised
   * value (cell[8] second amount), which reflects the current allowance
   * after change orders.
   */
  async getAllowances(
    projectId: string | number,
  ): Promise<Array<{
    id: string;
    categoryId: string;
    name: string;
    publishedBudget: number;
    workingBudget: number;
    approvedCOs: number;
    publishedRevised: number;
    workingRevised: number;
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
      s.replace(/<[^>]*>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&bullet;/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/\s+/g, " ")
        .trim();

    const allowances: Array<{
      id: string;
      categoryId: string;
      name: string;
      publishedBudget: number;
      workingBudget: number;
      approvedCOs: number;
      publishedRevised: number;
      workingRevised: number;
      cells: string[];
    }> = [];

    // Budget rows have data-id and data-category attrs in any order.
    const rowRegex = /<tr([^>]*data-id="[^"]*"[^>]*data-category="[^"]*"[^>]*|[^>]*data-category="[^"]*"[^>]*data-id="[^"]*"[^>]*)>([\s\S]*?)<\/tr>/g;
    let match: RegExpExecArray | null;
    while ((match = rowRegex.exec(html)) !== null) {
      const attrs = match[1];
      const idMatch = attrs.match(/data-id="(\d+)"/);
      const catMatch = attrs.match(/data-category="(\d+)"/);
      if (!idMatch || !catMatch) continue;

      const id = idMatch[1];
      const categoryId = catMatch[1];
      const rowHtml = match[2];

      const cells: string[] = [];
      const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
        cells.push(strip(cellMatch[1]));
      }

      const name = cells.find((c) => /^\d{3,5}\s*-\s*\S/.test(c)) ?? "";
      if (!/allowance/i.test(name)) continue;
      if (allowances.some((a) => a.id === id)) continue;

      const [publishedBudget, workingBudget] = parseDualAmount(cells[6] ?? "");
      const approvedCOs = parseFirstAmount(cells[7] ?? "");
      const [publishedRevised, workingRevised] = parseDualAmount(cells[8] ?? "");

      allowances.push({
        id, categoryId, name,
        publishedBudget, workingBudget, approvedCOs,
        publishedRevised, workingRevised,
        cells,
      });
    }

    return allowances;
  }

  /**
   * Fetches the full budget for a project. Returns all line-item categories
   * (not just allowances) with all 16 financial columns.
   *
   * GET /budget?PR[]=<projectId> returns JSON with `content` (HTML grid).
   * Each <tr> has data-id (budget item id), data-category (category id),
   * data-value (working budget amount), data-published/data-working flags.
   */
  async getBudget(projectId: string | number): Promise<{
    items: Array<{
      id: string;
      categoryId: string;
      name: string;
      isAllowance: boolean;
      publishedBudget: number;
      workingBudget: number;
      approvedCOs: number;
      publishedRevised: number;
      workingRevised: number;
      cells: string[];
    }>;
    columns: string[];
  }> {
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

    if (response.status !== 200) return { items: [], columns: [] };

    let data: { content?: string };
    try {
      data = JSON.parse(response.body);
    } catch {
      return { items: [], columns: [] };
    }

    const html = data.content ?? "";
    const strip = (s: string): string =>
      s
        .replace(/<[^>]*>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&bullet;/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/\s+/g, " ")
        .trim();

    // Pull column headers from <thead>
    const columns: string[] = [];
    const theadMatch = html.match(/<thead[\s\S]*?<\/thead>/);
    if (theadMatch) {
      const thRegex = /<th[^>]*>([\s\S]*?)<\/th>/g;
      let thMatch: RegExpExecArray | null;
      while ((thMatch = thRegex.exec(theadMatch[0])) !== null) {
        columns.push(strip(thMatch[1]));
      }
    }

    const items: Array<{
      id: string;
      categoryId: string;
      name: string;
      isAllowance: boolean;
      publishedBudget: number;
      workingBudget: number;
      approvedCOs: number;
      publishedRevised: number;
      workingRevised: number;
      cells: string[];
    }> = [];

    // Match all <tr> with data-id (any attribute order)
    const rowRegex = /<tr([^>]*data-id="[^"]*"[^>]*)>([\s\S]*?)<\/tr>/g;
    let match: RegExpExecArray | null;
    while ((match = rowRegex.exec(html)) !== null) {
      const attrs = match[1];
      const idMatch = attrs.match(/data-id="(\d+)"/);
      const catMatch = attrs.match(/data-category="(\d+)"/);
      if (!idMatch || !catMatch) continue;

      const id = idMatch[1];
      const categoryId = catMatch[1];
      const rowHtml = match[2];

      const cells: string[] = [];
      const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
        cells.push(strip(cellMatch[1]));
      }

      const name = cells.find((c) => /^\d{3,5}\s*-\s*\S/.test(c)) ?? "";
      if (!name) continue;

      const isAllowance = /allowance/i.test(name);
      if (items.some((it) => it.id === id)) continue;

      const [publishedBudget, workingBudget] = parseDualAmount(cells[6] ?? "");
      const approvedCOs = parseFirstAmount(cells[7] ?? "");
      const [publishedRevised, workingRevised] = parseDualAmount(cells[8] ?? "");

      items.push({
        id, categoryId, name, isAllowance,
        publishedBudget, workingBudget, approvedCOs,
        publishedRevised, workingRevised,
        cells,
      });
    }

    return { items, columns };
  }

  /**
   * Creates a new budget line item on a project. Adds a budget category
   * (must be a leaf category, e.g. "4520 - Interior Trim Materials").
   *
   * POST /budget/save?PR[]=<projectId> with `Budget[budget_category_id]=<leafCatId>`
   * Returns: { result: "success", id: <newBudgetItemId>, message: "..." }
   *
   * Verified live: works against both Templates and active projects.
   */
  async createBudgetItem(data: {
    projectId: string | number;
    budgetCategoryId: string | number;
    ifExists?: "skip" | "error" | "force";
  }): Promise<{
    success: boolean;
    budgetItemId?: number;
    existed?: boolean;
    errors?: unknown;
  }> {
    await this.ensureAuthenticated();
    if (!data.projectId) throw new BuildToolsServerError("projectId is required");
    if (!data.budgetCategoryId) {
      throw new BuildToolsServerError("budgetCategoryId is required");
    }

    // Idempotency: BuildTools' `budgets` table has a natural unique key on
    // (project_id, budget_category_id) for active (deleted_working=0) rows,
    // but the /budget/save endpoint is a plain INSERT — calling it twice with
    // the same category produces duplicate rows that break downstream reports
    // (Power BI's `m budgets_selections` model keys on category||project and
    // chokes on the dupe). Default behavior here is `skip`: look up the
    // existing row first and return it without writing.
    const ifExists = data.ifExists ?? "skip";
    if (ifExists !== "force") {
      try {
        const grid = await this.getBudget(data.projectId);
        const existing = grid.items.find(
          (i) => Number(i.categoryId) === Number(data.budgetCategoryId),
        );
        if (existing) {
          if (ifExists === "error") {
            return {
              success: false,
              budgetItemId: Number(existing.id),
              existed: true,
              errors: `A budget item for category ${data.budgetCategoryId} already exists on project ${data.projectId} (budget_item_id=${existing.id}). Pass ifExists: "skip" to return the existing row, or "force" to insert a duplicate (not recommended).`,
            };
          }
          return {
            success: true,
            budgetItemId: Number(existing.id),
            existed: true,
          };
        }
      } catch (err) {
        // If the dup-check fetch itself fails (network blip, auth churn),
        // don't fall through silently to an INSERT — that's how dupes get
        // created. Surface the error.
        throw err;
      }
    }

    const fd = new URLSearchParams();
    fd.append("Budget[budget_category_id]", String(data.budgetCategoryId));

    const resp = await this.request(
      `${this.baseUrl}/budget/save?PR[]=${data.projectId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json",
          "X-XSRF-TOKEN": this.xsrfToken ?? "",
        },
        body: fd.toString(),
      },
      false,
    );

    try {
      const result = JSON.parse(resp.body) as {
        result?: string;
        id?: number;
        message?: string;
      };
      if (result.result === "success") {
        return { success: true, budgetItemId: result.id, existed: false };
      }
      return { success: false, errors: result.message };
    } catch {
      return {
        success: false,
        errors: `HTTP ${resp.status}: ${resp.body.slice(0, 200)}`,
      };
    }
  }

  /**
   * Updates a budget item's working amount and/or allowance flag.
   *
   * POST /budget/save/<budgetItemId>?PR[]=<projectId> with form fields
   * including CSRF token harvested from /budget/form/<id>.
   *
   * Verified live: changing amount_working updates data-value attr.
   */
  async updateBudgetItem(data: {
    projectId: string | number;
    budgetItemId: string | number;
    budgetCategoryId: string | number;
    amountWorking?: number;
    isAllowance?: boolean;
  }): Promise<{ success: boolean; errors?: unknown }> {
    await this.ensureAuthenticated();
    if (!data.projectId) throw new BuildToolsServerError("projectId is required");
    if (!data.budgetItemId) throw new BuildToolsServerError("budgetItemId is required");
    if (!data.budgetCategoryId) {
      throw new BuildToolsServerError("budgetCategoryId is required");
    }

    // Harvest CSRF from the edit form
    const formResp = await this.request(
      `${this.baseUrl}/budget/form/${data.budgetItemId}?published=0&PR[]=${data.projectId}`,
      {
        headers: {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
      },
      false,
    );
    const csrf = (formResp.body.match(/name="_token"[^>]*value="([^"]+)"/) ?? [])[1];
    if (!csrf) {
      return { success: false, errors: "Could not harvest CSRF token from budget form" };
    }

    const fd = new URLSearchParams();
    fd.append("_token", csrf);
    fd.append("Budget[budget_category_id]", String(data.budgetCategoryId));
    if (data.amountWorking !== undefined) {
      fd.append("Budget[amount_working]", String(data.amountWorking));
    }
    if (data.isAllowance) {
      fd.append("Budget[allowance]", "1");
    }

    const resp = await this.request(
      `${this.baseUrl}/budget/save/${data.budgetItemId}?PR[]=${data.projectId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json",
          "X-CSRF-TOKEN": csrf,
          "X-XSRF-TOKEN": this.xsrfToken ?? "",
        },
        body: fd.toString(),
      },
      false,
    );

    try {
      const result = JSON.parse(resp.body) as {
        result?: string;
        message?: string;
      };
      if (result.result === "success") return { success: true };
      return { success: false, errors: result.message };
    } catch {
      return {
        success: false,
        errors: `HTTP ${resp.status}: ${resp.body.slice(0, 200)}`,
      };
    }
  }

  /**
   * Deletes a budget line item from a project.
   *
   * POST /budget/delete?PR[]=<projectId> with `ids[]=<budgetItemId>` (array).
   * Must include the form's _token plus X-CSRF-TOKEN header — without them
   * the server returns 200 with {r:1, s:0, f:0} and silently no-ops.
   * Response: { r: 1, s: <succeeded>, f: <failed>, mg: <error details> }.
   * Deletion fails (f > 0) if the budget item has related change orders.
   */
  async deleteBudgetItem(
    budgetItemId: string | number,
    projectId: string | number,
  ): Promise<{ success: boolean; succeeded: number; failed: number; errors?: unknown }> {
    await this.ensureAuthenticated();
    if (!projectId) throw new BuildToolsServerError("projectId is required");
    if (!budgetItemId) throw new BuildToolsServerError("budgetItemId is required");

    // Harvest a fresh CSRF token from the budget edit form. Without `_token`
    // in the form body the server returns 200 with {r:1,s:0,f:0} and silently
    // ignores the delete — we'd never know it didn't fire.
    const formResp = await this.request(
      `${this.baseUrl}/budget/form/${budgetItemId}?published=0&PR[]=${projectId}`,
      {
        headers: {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
      },
      false,
    );
    const csrf = (formResp.body.match(/name="_token"[^>]*value="([^"]+)"/) ?? [])[1];

    const fd = new URLSearchParams();
    if (csrf) fd.append("_token", csrf);
    fd.append("ids[]", String(budgetItemId));

    const resp = await this.request(
      `${this.baseUrl}/budget/delete?PR[]=${projectId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json",
          "X-CSRF-TOKEN": csrf ?? "",
          "X-XSRF-TOKEN": this.xsrfToken ?? "",
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
        mg?: unknown;
      };
      const succeeded = result.s ?? 0;
      const failed = result.f ?? 0;
      // Real success requires r=1, no failures, AND at least one row deleted.
      // The server returns {r:1, s:0, f:0} for silent no-ops (e.g. missing
      // CSRF, or attempting to delete a row that doesn't exist) — that's NOT
      // success.
      const success = result.r === 1 && failed === 0 && succeeded > 0;
      return { success, succeeded, failed, errors: failed > 0 ? result.mg : undefined };
    } catch {
      return {
        success: false,
        succeeded: 0,
        failed: 1,
        errors: `HTTP ${resp.status}: ${resp.body.slice(0, 200)}`,
      };
    }
  }

  /**
   * Fetches detail for a single selection including its items/options, files,
   * descriptions, vendor info, and prices.
   *
   * GET /selections/form/{selectionId}?itemsData=1&PR[]={projectId}
   * Returns: { r: 1, itemsData: [{ id, selection_id, title, description,
   *   model, url, price, company_id, company_name, selected, files: [...],
   *   subitems: [...] }] }
   *
   * Verified against live BuildTools — files[] contains download URLs at
   * file.buildtools.app for attached specs/documents.
   */
  async getSelectionDetail(
    selectionId: string | number,
    projectId: string | number,
  ): Promise<null | {
    items: Array<{
      id: number;
      selectionId: number;
      title: string;
      description: string;
      model: string;
      url: string;
      price: number | null;
      companyId: number | null;
      companyName: string;
      selected: boolean;
      files: Array<{
        id: number;
        name: string;
        size: number;
        type: string;
        url: string;
        isImage: boolean;
      }>;
      subitems: Array<Record<string, unknown>>;
    }>;
  } | null> {
    await this.ensureAuthenticated();

    const numSelId = Number(selectionId);
    const numProjId = Number(projectId);
    if (!Number.isFinite(numSelId) || !Number.isFinite(numProjId)) return null;

    const response = await this.requestWithReauthRetry(
      `${this.baseUrl}/selections/form/${numSelId}?itemsData=1&PR[]=${numProjId}`,
      {
        headers: {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
      },
      false,
    );

    if (response.status !== 200) return null;

    let data: {
      r?: number;
      itemsData?: Array<Record<string, unknown>>;
    };
    try {
      data = JSON.parse(response.body);
    } catch {
      return null;
    }

    if (data.r !== 1 || !Array.isArray(data.itemsData)) return null;

    const items = data.itemsData.map((item) => ({
      id: Number(item.id) || 0,
      selectionId: Number(item.selection_id) || 0,
      title: String(item.title ?? ""),
      description: String(item.description ?? ""),
      model: String(item.model ?? ""),
      url: String(item.url ?? ""),
      price: item.price !== null && item.price !== undefined ? Number(item.price) : null,
      companyId: item.company_id !== null && item.company_id !== undefined ? Number(item.company_id) : null,
      companyName: String(item.company_name ?? ""),
      selected: item.selected === 1 || item.selected === true,
      files: Array.isArray(item.files)
        ? item.files.map((f: Record<string, unknown>) => ({
            id: Number(f.id) || 0,
            name: String(f.name ?? ""),
            size: Number(f.size) || 0,
            type: String(f.type ?? ""),
            url: String(f.url ?? ""),
            isImage: f.is_image === 1 || f.is_image === true,
          }))
        : [],
      subitems: Array.isArray(item.subitems) ? item.subitems as Array<Record<string, unknown>> : [],
    }));

    return { items };
  }

  /**
   * Fetches the parent selection's name (the `Selection[name]` input value
   * on the edit form). The /selections/form/{id}?itemsData=1 JSON endpoint
   * carries the items but not the parent name; the unsuffixed HTML form
   * does. Returns null when the form 404s or doesn't contain the input —
   * callers should treat null as "name unavailable" and degrade gracefully.
   */
  async getSelectionName(
    selectionId: string | number,
    projectId: string | number,
  ): Promise<string | null> {
    await this.ensureAuthenticated();

    const numSelId = Number(selectionId);
    const numProjId = Number(projectId);
    if (!Number.isFinite(numSelId) || !Number.isFinite(numProjId)) return null;

    const response = await this.requestWithReauthRetry(
      `${this.baseUrl}/selections/form/${numSelId}?PR[]=${numProjId}`,
      {
        headers: {
          "X-Requested-With": "XMLHttpRequest",
        },
      },
      false,
    );

    if (response.status !== 200) return null;

    const m = response.body.match(
      /<input[^>]*name="Selection\[name\]"[^>]*value="([^"]*)"/,
    );
    if (!m) return null;
    // Decode common HTML entities the form may emit.
    return m[1]
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }

  /**
   * Creates a selection on a project. Requires CSRF from the form.
   * Verified working against live BuildTools.
   *
   * POST /selections/save?PR[]=<projectId>
   * Response: { result: "success", id: <number>, message: "..." }
   */
  async createSelection(selectionData: {
    projectId: string | number;
    name: string;
    budgetCategoryId: string | number;
    status?: string | number;
    locationRoomId?: string | number;
    notes?: string;
    dueDate?: string;
    items?: Array<{
      title: string;
      price?: number | string;
      description?: string;
      model?: string;
      url?: string;
      companyId?: string | number;
      selected?: boolean;
    }>;
  }): Promise<{ success: boolean; selectionId?: number; itemsSaved?: number; errors?: unknown }> {
    await this.ensureAuthenticated();
    if (!selectionData.projectId) throw new BuildToolsServerError("projectId is required");
    if (!selectionData.name) throw new BuildToolsServerError("name is required");
    if (!selectionData.budgetCategoryId) throw new BuildToolsServerError("budgetCategoryId is required");

    const formResp = await this.request(
      `${this.baseUrl}/selections/form?PR[]=${selectionData.projectId}`,
      { headers: { Accept: "text/html", "X-Requested-With": "XMLHttpRequest" } },
      false,
    );
    const csrf = (formResp.body.match(/name="_token"[^>]*value="([^"]+)"/) ?? [])[1];
    if (!csrf) return { success: false, errors: "Could not harvest CSRF token from selections form" };

    // Build the items JSON in the EXACT shape BuildTools accepts. All keys
    // must be present (even empty strings) or the server returns 500.
    // Schema verified live: required keys are id, selection_id, title,
    // description, model, url, price, subitems, company_id, company_name,
    // selected, files. Use id=0/selection_id=0 sentinels for new items.
    const itemsJson = JSON.stringify(
      (selectionData.items ?? []).map((it) => ({
        id: 0,
        selection_id: 0,
        title: it.title,
        description: it.description ?? "",
        model: it.model ?? "",
        url: it.url ?? "",
        price: it.price !== undefined ? String(it.price) : "",
        subitems: [],
        company_id: it.companyId !== undefined ? String(it.companyId) : "",
        company_name: "",
        selected: it.selected === false ? 0 : 1,
        files: [],
      })),
    );

    const fd = new URLSearchParams();
    fd.append("_token", csrf);
    fd.append("Selection[name]", selectionData.name);
    fd.append("Selection[project_id]", String(selectionData.projectId));
    fd.append("Selection[budget_category_id]", String(selectionData.budgetCategoryId));
    fd.append("Selection[status]", String(selectionData.status ?? 1));
    fd.append("Selection[locations_room_id][]", String(selectionData.locationRoomId ?? 2));
    if (selectionData.notes) fd.append("Selection[notes]", selectionData.notes);
    if (selectionData.dueDate) fd.append("Selection[due_date]", selectionData.dueDate);
    fd.append("items", itemsJson);

    const resp = await this.request(
      `${this.baseUrl}/selections/save?PR[]=${selectionData.projectId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json",
          "X-CSRF-TOKEN": csrf,
          "X-XSRF-TOKEN": this.xsrfToken ?? "",
        },
        body: fd.toString(),
      },
      false,
    );

    try {
      const result = JSON.parse(resp.body) as {
        result?: string;
        id?: number;
        message?: string | string[];
        returnParams?: { selectionsItem?: number };
      };
      if (result.result === "success") {
        return {
          success: true,
          selectionId: result.id,
          itemsSaved: result.returnParams?.selectionsItem ?? 0,
        };
      }
      return { success: false, errors: result.message };
    } catch {
      return { success: false, errors: `HTTP ${resp.status}: ${resp.body.slice(0, 200)}` };
    }
  }

  /**
   * Deletes one or more selections from a project.
   * Verified working against live BuildTools.
   *
   * POST /selections/delete?PR[]=<projectId> with ids[]=<id>
   * Response: { r: 1, s: <succeeded>, f: <failed> }
   */
  async deleteSelection(
    selectionIds: number | number[],
    projectId: string | number,
  ): Promise<{ success: boolean; succeeded: number; failed: number }> {
    await this.ensureAuthenticated();
    if (!projectId) throw new BuildToolsServerError("projectId is required");
    const ids = Array.isArray(selectionIds) ? selectionIds : [selectionIds];
    if (!ids.length) throw new BuildToolsServerError("selectionIds is required");

    const formResp = await this.request(
      `${this.baseUrl}/selections/form?PR[]=${projectId}`,
      { headers: { Accept: "text/html", "X-Requested-With": "XMLHttpRequest" } },
      false,
    );
    const csrf = (formResp.body.match(/name="_token"[^>]*value="([^"]+)"/) ?? [])[1];
    if (!csrf) return { success: false, succeeded: 0, failed: ids.length };

    const fd = new URLSearchParams();
    fd.append("_token", csrf);
    for (const id of ids) fd.append("ids[]", String(id));

    const resp = await this.request(
      `${this.baseUrl}/selections/delete?PR[]=${projectId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json",
          "X-CSRF-TOKEN": csrf,
          "X-XSRF-TOKEN": this.xsrfToken ?? "",
        },
        body: fd.toString(),
      },
      false,
    );

    try {
      const result = JSON.parse(resp.body) as { r?: number; s?: number; f?: number };
      return {
        success: result.r === 1 && (result.s ?? 0) > 0,
        succeeded: result.s ?? 0,
        failed: result.f ?? 0,
      };
    } catch {
      return { success: false, succeeded: 0, failed: ids.length };
    }
  }

  /**
   * Returns the available budget categories for the selections form on a project.
   * Parses the bcSelectProject select element from the form HTML.
   */
  async getSelectionBudgetCategories(
    projectId: string | number,
  ): Promise<Array<{ id: string; name: string }>> {
    await this.ensureAuthenticated();

    const formResp = await this.request(
      `${this.baseUrl}/selections/form?PR[]=${projectId}`,
      { headers: { Accept: "text/html", "X-Requested-With": "XMLHttpRequest" } },
      false,
    );
    if (formResp.status !== 200) return [];

    const html = formResp.body;
    const selectMatch = html.match(/id="bcSelectProject"[\s\S]*?<\/select>/);
    if (!selectMatch) return [];

    const categories: Array<{ id: string; name: string }> = [];
    const optRegex = /<option[^>]*value="(\d+)"[^>]*>([^<]+)/g;
    let m: RegExpExecArray | null;
    while ((m = optRegex.exec(selectMatch[0])) !== null) {
      const name = m[2].replace(/&nbsp;/g, "").replace(/&amp;/g, "&").trim();
      if (name) categories.push({ id: m[1], name });
    }
    return categories;
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
   *
   * Limitation: requests up to 10000 rows. Moss tenant has ~7800 COs.
   * If the corpus grows past 10000, older COs may be silently missed.
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
   * Lists individual financial statements for a project.
   *
   * GET /financial/statements?PR[]=<projectId> returns JSON with `content`
   * (HTML table of statements) and `statusCount`. Each <tr> has data-id,
   * data-amount, data-paid, data-balance attributes. The BuildTools datatable
   * layout for cells is, in order: [icon, status_label, name, amount,
   * paid, fees, balance, date]. The status label is rendered text — one of
   * Draft / Pending / Partial / Sent / Paid / Partly Paid / To Pay — so the
   * parser reads it directly rather than mapping numeric codes.
   */
  async getFinancialStatements(
    projectId: string | number,
  ): Promise<{
    statusCount: Record<string, number>;
    statements: Array<{
      id: string;
      name: string;
      status: string;
      amount: number;
      paid: number;
      balance: number;
      date: string;
    }>;
  }> {
    await this.ensureAuthenticated();

    const response = await this.request(
      `${this.baseUrl}/financial/statements?PR[]=${projectId}`,
      {
        headers: {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
      },
      false,
    );

    if (response.status !== 200) {
      return { statusCount: {}, statements: [] };
    }

    let data: { r?: number; content?: string; statusCount?: Record<string, number> };
    try {
      data = JSON.parse(response.body);
    } catch {
      return { statusCount: {}, statements: [] };
    }

    const statusCount = data.statusCount ?? {};
    const html = data.content ?? "";
    const statements: Array<{
      id: string;
      name: string;
      status: string;
      amount: number;
      paid: number;
      balance: number;
      date: string;
    }> = [];

    const strip = (s: string): string =>
      s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

    const parseCurrency = (s: string): number => {
      const n = Number(s.replace(/[^\d.-]/g, ""));
      return Number.isFinite(n) ? n : 0;
    };

    // The seven canonical status labels rendered by BuildTools. Anything
    // outside this set is collapsed to "Unknown" as a defensive fallback.
    const KNOWN_STATUSES = new Set([
      "Draft",
      "Pending",
      "Partial",
      "Sent",
      "Paid",
      "Partly Paid",
      "To Pay",
    ]);

    // Match <tr> tags containing data-id (attribute order may vary).
    const rowRegex = /<tr([^>]*data-id="[^"]*"[^>]*)>([\s\S]*?)<\/tr>/g;
    let match: RegExpExecArray | null;

    const attr = (tag: string, name: string): string => {
      const m = tag.match(new RegExp(`${name}="([^"]*)"`));
      return m?.[1] ?? "";
    };

    while ((match = rowRegex.exec(html)) !== null) {
      const attrs = match[1];
      const id = attr(attrs, "data-id");
      if (!id || !/^\d+$/.test(id)) continue;

      const amount = parseCurrency(attr(attrs, "data-amount"));
      const paid = parseCurrency(attr(attrs, "data-paid"));
      const balance = parseCurrency(attr(attrs, "data-balance"));
      const rowHtml = match[2];

      const cells: string[] = [];
      const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
        cells.push(strip(cellMatch[1]));
      }

      // BuildTools datatable layout: cells[0] is an icon/empty cell,
      // cells[1] is the rendered status label, cells[2] is the statement
      // name. Read by index so the status label never leaks into `name`.
      const statusLabel = cells[1] ?? "";
      const name = cells[2] ?? "";
      const date = cells.find((c) => /^\d{2}\/\d{2}\/\d{4}$/.test(c)) ?? "";
      const status = KNOWN_STATUSES.has(statusLabel) ? statusLabel : "Unknown";

      statements.push({
        id,
        name,
        status,
        amount,
        paid,
        balance,
        date,
      });
    }

    return { statusCount, statements };
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
      // financial_amount = sum of all FS amounts (the total requested billing).
      // financial_current_amount = amount for the NEW statement being created (always 0 on a blank form).
      let requestedAmount = 0;
      try {
        const fsData = await this.getFinancialStatement<Record<string, unknown>>(projectId as number);
        if (fsData?.financial_amount !== undefined) {
          requestedAmount = parseCurrency(fsData.financial_amount);
        } else if (fsData?.financial_past_amount !== undefined) {
          requestedAmount = parseCurrency(fsData.financial_past_amount);
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

  /**
   * Fetches full detail for a single purchase order by scraping the form
   * HTML (BuildTools does not expose a JSON detail endpoint). Returns the
   * scalar fields off the hidden inputs, the company_id off the
   * `select#select_company_id` widget, and the line items off the hidden
   * `name="items"` input (JSON-encoded, HTML-entity escaped).
   *
   * Returns null on 404 / unparseable response. Items may be empty.
   */
  async getPurchaseOrder(
    purchaseOrderId: string | number,
  ): Promise<null | PurchaseOrderDetail> {
    await this.ensureAuthenticated();

    const numId = Number(purchaseOrderId);
    if (!Number.isFinite(numId)) return null;

    const response = await this.requestWithReauthRetry(
      `${this.baseUrl}/purchase-orders/form/${numId}`,
      {
        headers: { "X-Requested-With": "XMLHttpRequest" },
      },
      false,
    );

    if (response.status !== 200) return null;

    const body = response.body;

    const stripValue = decodeFormEntities;

    const inputValue = (fieldName: string): string => {
      // Use a lookahead for `name="PurchaseOrder[<field>]"` so we accept
      // ANY ordering of attributes — Yii/Laravel scaffold sometimes emits
      // `value=` before `name=` (especially for `type="text"` inputs), and
      // a literal-order regex silently returns empty without surfacing the
      // miss. Same defensive shape as the `<option selected>` lookahead
      // used for the company `<select>` below.
      const re = new RegExp(
        `<input(?=[^>]*name="PurchaseOrder\\[${fieldName}\\]")[^>]*value="([^"]*)"`,
      );
      const m = body.match(re);
      return m ? stripValue(m[1]) : "";
    };

    // Company is rendered as a hidden read-only `<select id="select_company_id">`
    // alongside an interactive picker (`#companyQuickAdd`). The read-only
    // select carries the chosen option on the edit form. We extract the
    // FULL select block first (lazy `</select>` boundary), then read the
    // option inside it — a single regex with `[\s\S]*?` across the document
    // would walk into the next `<select>` and pull a `selected` option from
    // there.
    const selectBlock = body.match(
      /<select[^>]*id="select_company_id"[^>]*>([\s\S]*?)<\/select>/,
    );
    let companyId: number | null = null;
    let companyName = "";
    if (selectBlock) {
      const inner = selectBlock[1];
      // BuildTools renders the chosen vendor on the edit form one of two
      // ways: (a) a disabled read-only `<select>` with only the chosen
      // option in it (older POs) or (b) the full ~1100-vendor dropdown
      // with the chosen option carrying a `selected` attribute (newly
      // created POs). The `selected` attribute can appear before OR after
      // `value="…"` — use a lookahead so we accept any order, and require
      // a numeric value to skip the disabled `value=""` placeholder
      // ("Select or add a Company").
      const optSelected = inner.match(
        /<option(?=[^>]*\bselected\b)[^>]*\bvalue="(\d+)"[^>]*>([^<]+)<\/option>/,
      );
      const optFirst = inner.match(/<option[^>]*value="(\d+)"[^>]*>([^<]+)<\/option>/);
      const opt = optSelected ?? optFirst;
      if (opt) {
        companyId = Number(opt[1]);
        companyName = stripValue(opt[2]).trim();
      }
    }

    // Hidden items input — JSON array of line items, HTML-entity escaped.
    const itemsMatch = body.match(/<input[^>]*name="items"[^>]*value="([^"]+)"/);
    let items: PurchaseOrderDetail["items"] = [];
    if (itemsMatch) {
      try {
        const decoded = stripValue(itemsMatch[1]);
        const arr = JSON.parse(decoded) as Array<Record<string, unknown>>;
        items = arr.map((it) => ({
          id: it.id != null ? Number(it.id) : null,
          budgetCategoryId:
            it.budget_category_id != null ? Number(it.budget_category_id) : null,
          budgetCategoryCode: String(it.code ?? ""),
          budgetCategoryName: String(it.name ?? ""),
          total: String(it.total ?? ""),
          notes: String(it.notes ?? ""),
          internalNotes: String(it.internal_notes ?? ""),
          invoiceRelated: String(it.invoice_related ?? ""),
          amounts: Array.isArray(it.amounts)
            ? (it.amounts as Array<Record<string, unknown>>)
            : [],
          companyId: it.company_id != null ? Number(it.company_id) : null,
          companyName: String(it.company_name ?? ""),
        }));
      } catch {
        items = [];
      }
    }

    const projectIdStr = inputValue("project_id");
    const projectId = projectIdStr ? Number(projectIdStr) : null;

    const totalNumeric = items.reduce(
      (acc, it) => acc + (Number(it.total) || 0),
      0,
    );

    // Status: read from the selected option in
    // `<select name="PurchaseOrder[status]">`. BT emits `selected`
    // either before or after `value=` depending on form state, hence
    // the two-branch lookahead. Null when no selected option found.
    const statusBlock = body.match(
      /<select[^>]*name="PurchaseOrder\[status\]"[^>]*>([\s\S]*?)<\/select>/,
    );
    let statusCode: number | null = null;
    if (statusBlock) {
      const opt =
        statusBlock[1].match(
          /<option(?=[^>]*\bselected\b)[^>]*\bvalue="(\d+)"/,
        ) ?? statusBlock[1].match(/<option[^>]*\bvalue="(\d+)"[^>]*\bselected\b/);
      if (opt) statusCode = Number(opt[1]);
    }

    // Description: textarea contents, entity-decoded. BT round-trips
    // HTML-entity-encodes on save, so we decode here to match what the
    // caller originally sent.
    const descMatch = body.match(
      /<textarea[^>]*name="PurchaseOrder\[description\]"[^>]*>([\s\S]*?)<\/textarea>/,
    );
    const description = descMatch ? stripValue(descMatch[1]) : "";

    return {
      id: numId,
      projectId: Number.isFinite(projectId as number) ? projectId : null,
      name: inputValue("name"),
      number: inputValue("number"),
      prefix: inputValue("prefix"),
      status: statusCode,
      description,
      companyId,
      companyName,
      items,
      totalNumeric,
    };
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

  /**
   * Updates an existing purchase order.
   *
   * POST /purchase-orders/save/<purchaseOrderId>
   *
   * Required payload shape (verified live 2026-06-23 on moss tenant):
   *   - `_token` — CSRF harvested from the edit form
   *   - `PurchaseOrder[project_id]`, `PurchaseOrder[company_id]`,
   *     `PurchaseOrder[prefix]`, `PurchaseOrder[status]`,
   *     `PurchaseOrder[name]` — all need to be re-submitted; BuildTools
   *     doesn't merge partial payloads, so we fetch current values from
   *     the form first and overlay updates on top
   *   - `items` (bare, NOT `PurchaseOrderItems[items]`) — JSON-encoded
   *     ARRAY (not `{items:[...]}` wrapper). Each item needs the full
   *     shape: `{ id, budget_category_id, name, code, amounts[], total,
   *     notes, internal_notes, company_id, company_name, invoice_related }`.
   *     Missing fields silently drop the line item.
   *
   * The caller passes a minimal shape and this method enriches:
   *   - budget category `name`/`code` looked up via `getBudget(projectId)`
   *   - line-level `company_id`/`company_name` default to the parent PO's
   *
   * `items` semantics:
   *   - `undefined` → leave the existing items untouched
   *   - `[]` → clear ALL items (replace with empty)
   *   - `[…]` → REPLACE all items with the provided list (no partial diff)
   *
   * Returns `{ success, purchaseOrderId, message }` on 200/success,
   * `{ success: false, errors }` otherwise. Does NOT throw on a 500;
   * BuildTools' save endpoint occasionally returns 500 even when the
   * scalar fields persisted (only items failed) — the caller should
   * re-fetch via `getPurchaseOrder` to verify.
   */
  async updatePurchaseOrder(poData: {
    purchaseOrderId: string | number;
    name?: string;
    prefix?: string;
    status?: string | number;
    description?: string;
    companyId?: string | number;
    /**
     * Full replacement for the line items. Mutually exclusive with
     * `itemsAppend`. Pass `[]` to clear all items. Caller passes exactly
     * one of `budgetCategoryId`, `budgetItemId`, or `budgetCode` per
     * line — the method resolves the others internally via getBudget.
     */
    items?: Array<UpdatePurchaseOrderItemInput>;
    /**
     * Items to APPEND to the PO's existing line items. Preserves all
     * current ids/descriptions/amounts and adds the new ones at the end.
     * Mutually exclusive with `items`. Useful for delta entries
     * (e.g., a +$2,153.34 correction line) where the caller doesn't
     * have or want to re-send the original lines.
     */
    itemsAppend?: Array<UpdatePurchaseOrderItemInput>;
  }): Promise<{
    success: boolean;
    purchaseOrderId?: string | number;
    message?: unknown;
    errors?: unknown;
    /** Set when the call returned without attempting save due to lock detection. */
    currentStatus?: number;
  }> {
    await this.ensureAuthenticated();

    const poId = Number(poData.purchaseOrderId);
    if (!Number.isFinite(poId)) {
      return { success: false, errors: "purchase_order_id is not a number" };
    }

    // Step 1 — fetch the form HTML to: (a) harvest CSRF, (b) snapshot
    // current scalar values for fields the caller isn't updating, and
    // (c) get the parent project_id (so we know which budget to look up
    // categories from).
    const formResp = await this.requestWithReauthRetry(
      `${this.baseUrl}/purchase-orders/form/${poId}`,
      { headers: { "X-Requested-With": "XMLHttpRequest" } },
      false,
    );
    if (formResp.status !== 200) {
      return {
        success: false,
        errors: `Could not fetch PO form (status ${formResp.status})`,
      };
    }

    const formBody = formResp.body;
    const csrf = formBody.match(/name="_token"[^>]*value="([^"]+)"/)?.[1];
    if (!csrf) {
      return { success: false, errors: "Could not harvest CSRF _token from PO form" };
    }

    const readInput = (field: string): string => {
      const re = new RegExp(
        `<input(?=[^>]*name="PurchaseOrder\\[${field}\\]")[^>]*value="([^"]*)"`,
      );
      return formBody.match(re)?.[1] ?? "";
    };

    /** Read the selected `<option value="N">` from `<select name="PurchaseOrder[<field>]">`. */
    const readSelectedOption = (field: string): string => {
      const block = formBody.match(
        new RegExp(
          `<select[^>]*name="PurchaseOrder\\[${field}\\]"[^>]*>([\\s\\S]*?)<\\/select>`,
        ),
      );
      if (!block) return "";
      const opt =
        block[1].match(
          /<option(?=[^>]*\bselected\b)[^>]*\bvalue="([^"]+)"/,
        ) ?? block[1].match(/<option[^>]*\bvalue="([^"]+)"[^>]*\bselected\b/);
      return opt?.[1] ?? "";
    };

    /** Read the inner text of `<textarea name="PurchaseOrder[<field>]">`. */
    const readTextarea = (field: string): string => {
      const m = formBody.match(
        new RegExp(
          `<textarea[^>]*name="PurchaseOrder\\[${field}\\]"[^>]*>([\\s\\S]*?)<\\/textarea>`,
        ),
      );
      return m ? decodeFormEntities(m[1]) : "";
    };

    // Snapshot current scalar state — re-submitted unless overridden.
    // BuildTools does NOT merge partial payloads: every field omitted from
    // the POST is interpreted as cleared/reset. Status especially: a missing
    // status silently downgrades the PO to whatever default Yii picks
    // (often "1" / Draft) — so we must echo the current value back when
    // the caller didn't specify one.
    const currentProjectId = readInput("project_id");
    const currentPrefix = readInput("prefix") || "PO";
    const currentNumber = readInput("number");
    const currentName = decodeFormEntities(readInput("name"));
    const currentStatus = readSelectedOption("status") || "1";
    const currentDescription = readTextarea("description");
    // Company: same `<select id="select_company_id">` block the parser
    // uses (selected attribute may precede or follow `value=`).
    const selectBlock = formBody.match(
      /<select[^>]*id="select_company_id"[^>]*>([\s\S]*?)<\/select>/,
    );
    let currentCompanyId = "";
    if (selectBlock) {
      const inner = selectBlock[1];
      const opt =
        inner.match(
          /<option(?=[^>]*\bselected\b)[^>]*\bvalue="(\d+)"[^>]*>([^<]+)<\/option>/,
        ) ?? inner.match(/<option[^>]*value="(\d+)"[^>]*>([^<]+)<\/option>/);
      if (opt) currentCompanyId = opt[1];
    }
    // Items: snapshot the existing items JSON so we can pass through
    // unchanged when caller omits `items`.
    const itemsInput = formBody.match(
      /<input[^>]*name="items"[^>]*value="([^"]+)"/,
    );
    const currentItemsJson = itemsInput ? decodeFormEntities(itemsInput[1]) : "[]";

    // Step 1.5 — proactive lock check. BT returns HTTP 403 + empty body
    // for ANY /save call when current status is in
    // PURCHASE_ORDER_WRITE_LOCKED_STATUSES (verified live 2026-06-24:
    // status=3 / "Confirmed" blocks all writes, including status-only
    // transitions away from Confirmed). There is no alternate unlock
    // endpoint exposed by the UI — /save is the only path.
    //
    // We detect this BEFORE attempting the save so the caller gets a
    // clear actionable message instead of an opaque 403.
    if (PURCHASE_ORDER_WRITE_LOCKED_STATUSES.has(Number(currentStatus))) {
      return {
        success: false,
        currentStatus: Number(currentStatus),
        errors: formatPurchaseOrderLockError(poId, Number(currentStatus)),
      };
    }

    // Step 2 — handle item updates. Three call shapes are supported:
    //   - `items` undefined          → preserve existing items as-is
    //   - `items: []`                → clear all items
    //   - `items: [...]`             → full replacement
    //   - `itemsAppend: [...]`       → preserve existing + append new ones
    // Caller passes EXACTLY ONE of `items` / `itemsAppend` per call.
    let itemsJson = currentItemsJson;
    if (poData.items !== undefined && poData.itemsAppend !== undefined) {
      return {
        success: false,
        errors:
          "Pass either `items` (full replacement) OR `items_append` (append to existing) — not both. " +
          "If you want to fully replace items, use `items`; if you want to add a delta line without re-sending originals, use `items_append`.",
      };
    }
    const callerNewItems: UpdatePurchaseOrderItemInput[] | undefined =
      poData.items ?? poData.itemsAppend;
    if (callerNewItems !== undefined && callerNewItems.length > 0) {
      const projectIdForBudget = Number(currentProjectId);
      if (!Number.isFinite(projectIdForBudget) || projectIdForBudget === 0) {
        // Without a project_id we can't look up budget categories, and
        // items posted with name="Unknown"/code="" silently corrupt the
        // line. Fail loudly so the caller knows the form parse drifted.
        return {
          success: false,
          errors:
            "Could not extract project_id from PO form HTML — cannot enrich items with budget category names. " +
            "This usually means the BuildTools form template changed; re-run get_purchase_order to verify the PO exists.",
        };
      }
      const budgetItems = (await this.getBudget(projectIdForBudget)).items;
      // Build three lookups from one fetch: by category id (catalog id
      // BT actually wants), by budget item id (the per-project row id
      // surfaced as the "ID" column in list_budget), and by human code
      // ("7051"). All resolve to the same enrichment data so the caller
      // can pass whichever they have without knowing the difference.
      const categoryLookup = new Map<string, { code: string; name: string; categoryId: string }>();
      const itemIdLookup = new Map<string, string>(); // budget item id → category id
      // code → category id. BuildTools doesn't enforce code uniqueness
      // at the DB level (it's a display string parsed from `name`), so
      // we track ambiguities and reject a `budget_code` resolution when
      // multiple categories share that code — better than silently
      // picking one. Empty codes (rows like "- Misc" with no prefix)
      // are skipped because you can't look up by an empty string.
      const codeLookup = new Map<string, string>();
      const ambiguousCodes = new Set<string>();
      for (const bi of budgetItems) {
        const display = bi.name;
        const dash = display.indexOf(" - ");
        const code = dash > 0 ? display.slice(0, dash).trim() : "";
        const name = dash > 0 ? display.slice(dash + 3).trim() : display;
        categoryLookup.set(bi.categoryId, { code, name, categoryId: bi.categoryId });
        itemIdLookup.set(bi.id, bi.categoryId);
        if (code) {
          if (codeLookup.has(code) && codeLookup.get(code) !== bi.categoryId) {
            ambiguousCodes.add(code);
          } else {
            codeLookup.set(code, bi.categoryId);
          }
        }
      }

      const fallbackCompanyId =
        poData.companyId !== undefined
          ? String(poData.companyId)
          : currentCompanyId;

      // Resolve each caller item's budget_category_id from whichever of
      // the three fields was provided. Accumulate clean per-item errors
      // so the caller sees ALL mistakes at once, not just the first.
      const resolutionErrors: string[] = [];
      const enriched = callerNewItems.map((it, i) => {
        const provided = [
          it.budgetCategoryId !== undefined ? "budget_category_id" : null,
          it.budgetItemId !== undefined ? "budget_item_id" : null,
          it.budgetCode !== undefined && it.budgetCode !== "" ? "budget_code" : null,
        ].filter(Boolean);
        if (provided.length === 0) {
          resolutionErrors.push(
            `items[${i}]: provide one of \`budget_category_id\`, \`budget_item_id\`, or \`budget_code\`.`,
          );
          return null;
        }
        if (provided.length > 1) {
          resolutionErrors.push(
            `items[${i}]: provide EXACTLY one of ${provided.join(", ")} — got ${provided.length}.`,
          );
          return null;
        }

        let resolvedCategoryId: string | undefined;
        if (it.budgetCategoryId !== undefined) {
          resolvedCategoryId = String(it.budgetCategoryId);
          if (!categoryLookup.has(resolvedCategoryId)) {
            resolutionErrors.push(
              `items[${i}]: budget_category_id ${resolvedCategoryId} not found on project #${projectIdForBudget}. Run \`list_budget\` to see available categories.`,
            );
            return null;
          }
        } else if (it.budgetItemId !== undefined) {
          resolvedCategoryId = itemIdLookup.get(String(it.budgetItemId));
          if (!resolvedCategoryId) {
            resolutionErrors.push(
              `items[${i}]: budget_item_id ${it.budgetItemId} not found on project #${projectIdForBudget}. The ID column from \`list_budget\` is what this field expects.`,
            );
            return null;
          }
        } else if (it.budgetCode !== undefined) {
          if (ambiguousCodes.has(it.budgetCode)) {
            resolutionErrors.push(
              `items[${i}]: budget_code "${it.budgetCode}" matches multiple categories on project #${projectIdForBudget}. Use \`budget_category_id\` or \`budget_item_id\` instead to be precise.`,
            );
            return null;
          }
          resolvedCategoryId = codeLookup.get(it.budgetCode);
          if (!resolvedCategoryId) {
            resolutionErrors.push(
              `items[${i}]: budget_code "${it.budgetCode}" not found on project #${projectIdForBudget}. Codes are the prefix (e.g. "7051" for "7051 - Countertops Allowance").`,
            );
            return null;
          }
        }
        const cat = categoryLookup.get(resolvedCategoryId!)!;

        // The single-amount path: qty defaults to 1, so unit price === total
        // for the common case. We use total directly when qty===1 to avoid
        // floating-point drift (`400 / 3 === 133.333…` rounds to 133.33 and
        // amounts[0].a * q ≠ total). For qty>1 the rounded unit price IS
        // what BuildTools' UI does, so we match.
        const qty = Number(it.quantity ?? 1);
        const totalNum = Number(it.total) || 0;
        const unitPrice =
          qty === 1
            ? totalNum.toFixed(2)
            : qty > 1
              ? (totalNum / qty).toFixed(2)
              : totalNum.toFixed(2);
        return {
          id: null,
          budget_category_id: Number(resolvedCategoryId),
          name: cat.name,
          code: cat.code,
          amounts: [
            {
              a: unitPrice,
              q: String(qty || 1),
              d: it.description,
              u: it.unit ?? "1",
            },
          ],
          total: totalNum.toFixed(2),
          notes: it.notes ?? "",
          internal_notes: it.internalNotes ?? "",
          company_id: Number(it.companyId ?? fallbackCompanyId) || 0,
          company_name: "",
          invoice_related: "0.00",
        };
      });

      if (resolutionErrors.length > 0) {
        return {
          success: false,
          errors:
            `Budget resolution failed:\n` +
            resolutionErrors.map((e) => `  - ${e}`).join("\n"),
        };
      }

      // Build the final items JSON. For append: prepend the existing
      // items (parsed from the form snapshot) so their ids/descriptions
      // are preserved. For replace: just use the new items directly.
      const validEnriched = enriched.filter((x) => x !== null) as Array<Record<string, unknown>>;
      if (poData.itemsAppend !== undefined) {
        let existing: Array<Record<string, unknown>> = [];
        try {
          existing = JSON.parse(currentItemsJson) as Array<Record<string, unknown>>;
        } catch {
          existing = [];
        }
        itemsJson = JSON.stringify([...existing, ...validEnriched]);
      } else {
        itemsJson = JSON.stringify(validEnriched);
      }
    } else if (poData.items !== undefined && poData.items.length === 0) {
      // Explicit clear.
      itemsJson = "[]";
    }
    // itemsAppend: [] is a no-op (nothing to append) — leave currentItemsJson.

    // Step 3 — build the save payload. Re-submit current values for every
    // scalar; overlay updates from poData.
    const form = new URLSearchParams();
    form.append("_token", csrf);
    form.append("PurchaseOrder[project_id]", currentProjectId);
    form.append(
      "PurchaseOrder[company_id]",
      String(poData.companyId ?? currentCompanyId),
    );
    form.append("PurchaseOrder[prefix]", String(poData.prefix ?? currentPrefix));
    form.append("PurchaseOrder[number]", currentNumber);
    form.append("PurchaseOrder[name]", poData.name ?? currentName);
    form.append("PurchaseOrder[status]", String(poData.status ?? currentStatus));
    form.append(
      "PurchaseOrder[description]",
      poData.description ?? currentDescription,
    );
    form.append("items", itemsJson);

    // Step 4 — POST and parse.
    const response = await this.request(
      `${this.baseUrl}/purchase-orders/save/${poId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json",
          ...(this.xsrfToken ? { "X-XSRF-TOKEN": this.xsrfToken } : {}),
        },
        body: form.toString(),
      },
      false,
    );

    // Step 4 (cont.) — parse + report. The previous implementation
    // collapsed both branches of failure to a near-useless `Failed: ""`
    // when BT returned `{message:""}` (which it does on 403/lock errors,
    // confirmed live 2026-06-24). Now we always include the HTTP status
    // code AND the raw body preview in the error, AND log the full
    // request/response context to stderr so the operator can debug.
    const status = response.status;
    const bodyPreview = response.body.slice(0, 500);
    let parsed: { result?: string; id?: string | number; message?: unknown } | null = null;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      /* non-JSON body — keep parsed === null */
    }

    if (parsed?.result === "success") {
      return {
        success: true,
        purchaseOrderId: parsed.id ?? poId,
        message: parsed.message,
      };
    }

    // Failure path. Compose a maximally-useful error: HTTP status + the
    // server's `message` field (if non-empty) + a body preview as a fallback.
    //
    // Security: when the body is non-JSON HTML (Laravel debug page, WAF
    // block, edge error page), DO NOT embed it in the returned error —
    // those pages can contain environment variables or other internal
    // state that would otherwise flow into the LLM context. The full
    // body still lands in stderr below so operators can inspect via
    // journalctl without exposing it to the model.
    const errorParts: string[] = [`HTTP ${status}`];
    const serverMsg = String(parsed?.message ?? "").trim();
    const looksLikeHtml = bodyPreview.trimStart().startsWith("<");
    if (serverMsg) errorParts.push(`message: ${serverMsg}`);
    else if (parsed) {
      // Field is absent (not `unknown` — that read ambiguously as a type
      // statement). Make it explicit.
      const resultField = parsed.result === undefined ? "(absent)" : String(parsed.result);
      errorParts.push(`result: ${resultField} (empty message body — BT often returns this on 403/write-locked POs)`);
    } else if (bodyPreview.trim() && !looksLikeHtml) {
      errorParts.push(`body: ${bodyPreview}`);
    } else if (looksLikeHtml) {
      errorParts.push(`(non-JSON HTML response — body redacted; check operator logs for full content)`);
    } else {
      errorParts.push(`(empty body)`);
    }
    process.stderr.write(
      `[updatePurchaseOrder] po=${poId} project=${currentProjectId} save FAILED status=${status} body=${JSON.stringify(bodyPreview)}\n`,
    );
    return { success: false, errors: errorParts.join(" — ") };
  }

  /**
   * Transitions a PO's status via the dedicated workflow endpoint.
   *
   * Discovered 2026-06-27: BuildTools' edit form has a hidden
   * `data-url-status="/purchase-orders/status/update"` attribute that
   * status-only changes route to. The PO form's `#cancelPO` button and
   * the status `<select>`'s `.status-access` class both feed into this
   * endpoint via the bundled app.js. CRITICAL property: this endpoint
   * accepts transitions that `/purchase-orders/save` REFUSES — most
   * notably Confirmed (3) → Draft (1), which the save endpoint returns
   * 403 for and which I'd previously documented as impossible.
   *
   * Payload shape (verified live):
   *   _token: <csrf>
   *   ids[]: <po-id>           (the endpoint is multi-id capable; we
   *                             use it single-id for now)
   *   status: <numeric code>
   *
   * Success response: `{r:1, msg:[], s:1, f:0, l:["Purchase Order", ...]}`.
   * Failure response is also JSON with `r:0` and `msg:[<reason>]`.
   *
   * Some transitions still validate — most notably promote to Confirmed
   * (3) requires a non-empty signature field, which we don't surface
   * yet. That'll come as a follow-up if a real use case appears.
   */
  async transitionPurchaseOrderStatus(opts: {
    purchaseOrderId: string | number;
    status: number;
  }): Promise<{
    success: boolean;
    message?: unknown;
    errors?: unknown;
  }> {
    await this.ensureAuthenticated();

    const poId = Number(opts.purchaseOrderId);
    if (!Number.isFinite(poId)) {
      return { success: false, errors: "purchase_order_id is not a number" };
    }

    // Harvest CSRF from the PO's edit form (cheap fetch; reuses the
    // same path the other write methods use).
    const formResp = await this.requestWithReauthRetry(
      `${this.baseUrl}/purchase-orders/form/${poId}`,
      { headers: { "X-Requested-With": "XMLHttpRequest" } },
      false,
    );
    if (formResp.status !== 200) {
      return {
        success: false,
        errors: `Could not fetch PO form to harvest CSRF (HTTP ${formResp.status})`,
      };
    }
    const csrf = formResp.body.match(/name="_token"[^>]*value="([^"]+)"/)?.[1];
    if (!csrf) {
      return {
        success: false,
        errors: "Could not harvest CSRF _token from PO form",
      };
    }

    const form = new URLSearchParams();
    form.append("_token", csrf);
    form.append("ids[]", String(poId));
    form.append("status", String(opts.status));

    const resp = await this.request(
      `${this.baseUrl}/purchase-orders/status/update`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json",
          ...(this.xsrfToken ? { "X-XSRF-TOKEN": this.xsrfToken } : {}),
        },
        body: form.toString(),
      },
      false,
    );

    // Response shape: `{r: 0|1, msg: string[], s: <success count>, f:
    // <failure count>, l: [singular, plural]}`. Non-numeric `r:1`
    // means the call's wire succeeded; we also need `f === 0` to know
    // no per-id failure occurred.
    let parsed: { r?: number; msg?: unknown; s?: number; f?: number };
    try {
      parsed = JSON.parse(resp.body) as typeof parsed;
    } catch {
      return {
        success: false,
        errors: `Non-JSON response from /status/update (HTTP ${resp.status}): ${resp.body.slice(0, 200)}`,
      };
    }
    if (parsed.r !== 1 || (parsed.f ?? 0) > 0) {
      const msg = Array.isArray(parsed.msg)
        ? (parsed.msg as unknown[]).join("; ")
        : String(parsed.msg ?? "");
      process.stderr.write(
        `[transitionPurchaseOrderStatus] po=${poId} status=${opts.status} FAILED body=${JSON.stringify(resp.body.slice(0, 300))}\n`,
      );
      return {
        success: false,
        errors: msg || `HTTP ${resp.status} — ${resp.body.slice(0, 200)}`,
      };
    }
    return { success: true, message: "Status updated." };
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
