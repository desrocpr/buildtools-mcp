/**
 * CSRF tokens for admin form POSTs (MOS-328 Phase 7.5 hardening).
 *
 * The previous design relied on `SameSite=Lax` to block cross-origin
 * POSTs. That's correct for fetch/XHR but does NOT block top-level
 * `<form method=POST>` navigations from a malicious page — the browser
 * sends Lax cookies on those. A drive-by malicious page could
 * auto-submit a form to `/admin/users/:id/revoke` and the session
 * cookie would attach.
 *
 * Defense: HMAC-SHA256-derived per-user CSRF token. Stateless — we
 * derive it from the session user id + a stable key, so no separate
 * store is needed. Every admin form embeds the token in a hidden
 * input; every POST handler verifies it.
 *
 * Constant-time compare to prevent token-validity oracles.
 */

import { createHmac } from "node:crypto";

import { constantTimeStringEqual } from "../auth/tokens.js";

/**
 * Derive a CSRF token for an authenticated user. The token is
 * deterministic per (userId, key) so the same form rendering produces
 * the same token a second later — necessary because we have no
 * server-side per-form state.
 *
 * Security: the token is bound to the user's id. A different user
 * (or an unauthenticated caller) can't predict it without the
 * encryption key. SameSite=Lax + this token together cover both the
 * XHR and the form-navigation vectors.
 */
export function csrfTokenFor(userId: string, key: Buffer): string {
  return createHmac("sha256", key)
    .update("csrf:")
    .update(userId)
    .digest("base64url");
}

/**
 * Returns true iff the supplied token matches the one we'd derive
 * for this user. Constant-time comparison.
 */
export function verifyCsrfToken(
  presented: string | undefined | null,
  userId: string,
  key: Buffer,
): boolean {
  if (typeof presented !== "string" || presented.length === 0) return false;
  const expected = csrfTokenFor(userId, key);
  return constantTimeStringEqual(presented, expected);
}

/** Hidden input HTML for embedding in forms. Caller is responsible for HTML escaping the value. */
export function csrfHiddenInput(token: string): string {
  return `<input type="hidden" name="_csrf" value="${token}">`;
}
