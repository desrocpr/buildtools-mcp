/**
 * Bearer token generation, hashing, and classification (MOS-328).
 *
 * Three token kinds, distinguished by prefix:
 *
 *   - `mcps_...` — service tokens (harness, future automation). Long-lived,
 *                  revocable by admin. Issued by /admin/service-accounts/new.
 *   - `mcpa_...` — OAuth 2.1 access tokens. Short-lived (~1h). Bound to a
 *                  human user via the OAuth code flow through Azure AD.
 *   - `mcpr_...` — OAuth 2.1 refresh tokens. Long-lived (~30d). Single-use
 *                  with rotation; each refresh mints a new pair.
 *
 * The plaintext token is shown to the recipient ONCE (in the OAuth token
 * response, or the admin SA-creation response). Only the SHA-256 hash is
 * stored in Postgres, so a database compromise alone can't produce valid
 * bearer values.
 *
 * Token bodies carry 256 bits of entropy (32 random bytes, base64url) —
 * more than enough that even an in-the-clear hash collision is
 * cryptographically improbable.
 */

import { createHash, randomBytes } from "node:crypto";

export const SERVICE_TOKEN_PREFIX = "mcps_";
export const ACCESS_TOKEN_PREFIX = "mcpa_";
export const REFRESH_TOKEN_PREFIX = "mcpr_";

export type TokenKind = "service" | "access" | "refresh" | "unknown";

const TOKEN_ENTROPY_BYTES = 32;

export interface GeneratedToken {
  /** The plaintext bearer string (give to caller exactly once). */
  token: string;
  /** SHA-256 hex digest of `token` (store this, not the plaintext). */
  hash: string;
}

function generate(prefix: string): GeneratedToken {
  const random = randomBytes(TOKEN_ENTROPY_BYTES).toString("base64url");
  const token = `${prefix}${random}`;
  return { token, hash: hashToken(token) };
}

export function generateServiceToken(): GeneratedToken {
  return generate(SERVICE_TOKEN_PREFIX);
}

export function generateAccessToken(): GeneratedToken {
  return generate(ACCESS_TOKEN_PREFIX);
}

export function generateRefreshToken(): GeneratedToken {
  return generate(REFRESH_TOKEN_PREFIX);
}

/**
 * SHA-256 hex digest. Deterministic — the same input produces the same
 * output, so we can look up tokens in Postgres without storing plaintext.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Classify a bearer string by its prefix. Returns `"unknown"` for anything
 * we don't recognise (legacy bearer, malformed, etc.) so the resolver can
 * fall back to the deprecated `HTTP_BEARER_TOKEN` path.
 */
export function detectTokenKind(token: string): TokenKind {
  if (typeof token !== "string" || token.length === 0) return "unknown";
  if (token.startsWith(SERVICE_TOKEN_PREFIX)) return "service";
  if (token.startsWith(ACCESS_TOKEN_PREFIX)) return "access";
  if (token.startsWith(REFRESH_TOKEN_PREFIX)) return "refresh";
  return "unknown";
}

/**
 * Strip a `Bearer ` prefix from an Authorization header value (case
 * insensitive). Returns the raw token or null when the header isn't a
 * Bearer credential.
 */
export function parseBearerHeader(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const match = trimmed.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}
