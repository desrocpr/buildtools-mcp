/**
 * Environment-variable-driven configuration for the BuildTools MCP server.
 *
 * Credentials are PER-USER (NOT a shared service account): each operator who
 * installs the MCP server provides their own BuildTools username + password
 * via their own `claude_desktop_config.json` env block (Claude Desktop spawns
 * one MCP server process per user, so credentials never cross processes).
 *
 * Rationale:
 *   - Each user's BuildTools actions appear in the audit trail under their
 *     own account, not under a shared bot user.
 *   - BuildTools' native role-based access controls apply naturally per user.
 *   - A compromised credential is bounded to one user — not the whole team.
 *
 * Wiring `loadConfigFromEnv()` into the MCP server entrypoint is intentionally
 * deferred to MOS-214 (Phase 3.1) when the first read tool needs a client.
 */

/** Default client-side session expiry (defensive — BuildTools cookies carry no TTL). */
const DEFAULT_SESSION_TIMEOUT_MINUTES = 30;

/**
 * Resolved configuration for a single BuildTools user.
 *
 * `tenant` (e.g. `"moss"`) derives `baseUrl` as `https://${tenant}.buildtools.app`.
 * The auth host (`https://core.buildtools.app`) is shared across all tenants
 * and is NOT derived from `tenant`; the API class hardcodes its default.
 */
export interface BuildToolsConfig {
  /** BuildTools tenant subdomain (BUILDTOOLS_TENANT, e.g. `"moss"`). */
  tenant: string;
  /** Per-user BuildTools email/username (BUILDTOOLS_USERNAME). */
  username: string;
  /** Per-user BuildTools password (BUILDTOOLS_PASSWORD). */
  password: string;
  /** Derived: `https://${tenant}.buildtools.app`. */
  baseUrl: string;
  /** Defensive client-side session expiry; defaults to 30 if omitted. */
  sessionTimeoutMinutes?: number;
}

/**
 * Read BuildTools credentials from `process.env` and return a fully-resolved
 * `BuildToolsConfig`.
 *
 * Required env vars (all three must be set):
 *   - `BUILDTOOLS_TENANT`   — tenant subdomain (e.g. `"moss"`)
 *   - `BUILDTOOLS_USERNAME` — per-user BuildTools email
 *   - `BUILDTOOLS_PASSWORD` — per-user BuildTools password
 *
 * If any required var is missing, throws an `Error` whose message tells the
 * user where to set the variables AND explicitly warns against sharing
 * credentials between users.
 *
 * NOTE: env-var VALUES are never echoed in the error message (only var NAMES),
 * to avoid accidental credential leakage to stderr / logs.
 */
export function loadConfigFromEnv(): BuildToolsConfig {
  const tenant = process.env.BUILDTOOLS_TENANT;
  const username = process.env.BUILDTOOLS_USERNAME;
  const password = process.env.BUILDTOOLS_PASSWORD;

  if (!tenant || !username || !password) {
    const missing: string[] = [];
    if (!tenant) missing.push("BUILDTOOLS_TENANT");
    if (!username) missing.push("BUILDTOOLS_USERNAME");
    if (!password) missing.push("BUILDTOOLS_PASSWORD");
    throw new Error(
      `Missing required BuildTools env var(s): ${missing.join(", ")}. ` +
        "BuildTools credentials must be set in YOUR claude_desktop_config.json " +
        "env block — do NOT share credentials between users. " +
        "See docs/INSTALL.md for the full Claude Desktop config snippet.",
    );
  }

  return {
    tenant,
    username,
    password,
    baseUrl: `https://${tenant}.buildtools.app`,
    sessionTimeoutMinutes: DEFAULT_SESSION_TIMEOUT_MINUTES,
  };
}
