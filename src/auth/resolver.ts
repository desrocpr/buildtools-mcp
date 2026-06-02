/**
 * Bearer-token resolver (MOS-328 Phase 6a).
 *
 * Takes a raw bearer string (post-`Bearer ` strip) and returns an
 * `AuthContext` if recognised, or null if not. Used by the HTTP
 * transport's auth middleware to decide whether to 401 or to attach
 * the resolved identity to the request.
 *
 * Three token kinds, distinguished by prefix:
 *
 *   - `mcpa_...` (OAuth access token): looks up in `mcp_oauth_tokens`,
 *     joins to `mcp_users` for the user record + roles, last_used_at
 *     touched best-effort.
 *
 *   - `mcps_...` (service token): looks up in `mcp_service_tokens`,
 *     joins to `mcp_users` for the service user + roles.
 *
 *   - LEGACY (anything else): if it matches the configured
 *     `HTTP_BEARER_TOKEN` via constant-time compare, returns a
 *     synthetic legacy context with no user or permissions. This is
 *     intentionally degraded — legacy callers still go through the
 *     existing `set_session_credentials` path, and once we drop
 *     backwards compat (Phase 9 cutover) this branch goes away.
 */

import { timingSafeEqual } from "node:crypto";

import type { Db } from "./db.js";
import {
  resolveAccessToken,
  touchTokenLastUsed,
} from "./oauth-store.js";
import {
  resolveServiceToken,
  touchServiceTokenLastUsed,
} from "./service-tokens.js";
import { detectTokenKind } from "./tokens.js";
import type { McpUserWithRoles } from "./types.js";
import { getUserWithRoles, touchLastSeen } from "./users.js";

export type AuthKind = "human" | "service" | "legacy";

export interface AuthContext {
  kind: AuthKind;
  /** User row + role-resolved permissions. Null for legacy bearer. */
  user: McpUserWithRoles | null;
  /** Token row PK, used to correlate audit entries. Null for legacy. */
  tokenId: string | null;
  /** `oauth-access` or `service`. Null for legacy. */
  tokenKind: "oauth-access" | "service" | null;
}

export interface ResolverDeps {
  db: Db;
  /** Optional legacy bearer for backwards compat. Pass empty to disable. */
  legacyBearer?: string;
}

const LEGACY_CONTEXT: AuthContext = {
  kind: "legacy",
  user: null,
  tokenId: null,
  tokenKind: null,
};

/**
 * Resolve a bearer string into an `AuthContext`. Returns null when:
 *   - prefix-matched OAuth/service token doesn't exist, is revoked,
 *     or has expired
 *   - token doesn't match any known prefix AND doesn't equal the
 *     legacy bearer
 *
 * Touches `last_seen_at` / `last_used_at` best-effort on success.
 */
export async function resolveBearer(
  bearer: string,
  deps: ResolverDeps,
): Promise<AuthContext | null> {
  if (!bearer) return null;

  const kind = detectTokenKind(bearer);

  if (kind === "access") {
    const access = await resolveAccessToken(deps.db, bearer);
    if (!access) return null;
    const user = await getUserWithRoles(deps.db, access.userId);
    if (!user || user.status !== "active") return null;
    // Best-effort timestamps; failure here mustn't block the request.
    void touchTokenLastUsed(deps.db, access.tokenId);
    void touchLastSeen(deps.db, user.id);
    return {
      kind: "human",
      user,
      tokenId: access.tokenId,
      tokenKind: "oauth-access",
    };
  }

  if (kind === "service") {
    const svc = await resolveServiceToken(deps.db, bearer);
    if (!svc) return null;
    const user = await getUserWithRoles(deps.db, svc.userId);
    if (!user || user.status !== "active") return null;
    void touchServiceTokenLastUsed(deps.db, svc.tokenId);
    void touchLastSeen(deps.db, user.id);
    return {
      kind: "service",
      user,
      tokenId: svc.tokenId,
      tokenKind: "service",
    };
  }

  // Legacy fallback — constant-time compare against the configured
  // HTTP_BEARER_TOKEN so we don't leak its length via timing.
  if (deps.legacyBearer && deps.legacyBearer.length > 0) {
    if (constantTimeStringEqual(bearer, deps.legacyBearer)) {
      return LEGACY_CONTEXT;
    }
  }

  return null;
}

function constantTimeStringEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
