/**
 * Session cookies + Azure-state tokens (MOS-328 Phase 4-5).
 *
 * Two compact, server-only token formats sharing a single secret:
 *
 *   - `signCookie(payload)` / `verifyCookie(token)` — HMAC-signed JSON
 *     blob. Used for the post-Azure enrollment session cookie. Not
 *     encrypted; carries only the user_id + expiry.
 *
 *   - `sealState(payload)` / `openState(token)` — AES-256-GCM
 *     encrypted JSON blob. Used as the `state` parameter on outbound
 *     Azure auth requests, because it has to round-trip through
 *     Microsoft and contain values (PKCE verifier, client params)
 *     that we don't want readable in URLs.
 *
 * Both reuse the existing AES key from `MCP_ENCRYPTION_KEY`. The
 * cookie HMAC uses the same key as its MAC seed — a separate session
 * secret would be cleaner but adds another moving part. The key is
 * 32 random bytes; using it for both AES-GCM and HMAC-SHA256 is
 * standard and safe.
 */

import { createHmac, randomBytes } from "node:crypto";

import { decrypt, encrypt } from "./encryption.js";
import { constantTimeStringEqual } from "./tokens.js";

// ---------------------------------------------------------------------------
// HMAC-signed cookie (no encryption — for non-secret session data)
// ---------------------------------------------------------------------------

interface SignedEnvelope<T> {
  /** Caller-supplied payload. */
  d: T;
  /** Expiry, ms since epoch. */
  e: number;
}

export interface SignCookieOptions {
  /** Lifetime in seconds. Default 30 min. */
  ttlSeconds?: number;
}

export function signCookie<T extends object>(
  payload: T,
  key: Buffer,
  opts: SignCookieOptions = {},
): string {
  const ttl = opts.ttlSeconds ?? 30 * 60;
  const envelope: SignedEnvelope<T> = {
    d: payload,
    e: Date.now() + ttl * 1000,
  };
  const body = Buffer.from(JSON.stringify(envelope)).toString("base64url");
  const mac = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyCookie<T>(token: string, key: Buffer): T | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, mac] = parts;
  const expectedMac = createHmac("sha256", key).update(body).digest("base64url");
  // constantTimeStringEqual is imported from ./tokens.js — it wraps
  // Node's crypto.timingSafeEqual, which is genuinely constant-time.
  if (!constantTimeStringEqual(mac, expectedMac)) return null;
  let envelope: SignedEnvelope<T>;
  try {
    envelope = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!envelope || typeof envelope.e !== "number") return null;
  if (envelope.e < Date.now()) return null;
  return envelope.d as T;
}

// ---------------------------------------------------------------------------
// AES-GCM sealed state (for Azure state round-trips)
// ---------------------------------------------------------------------------

interface SealedEnvelope<T> {
  d: T;
  e: number; // expiry ms
  n: string; // random nonce, prevents identical payloads producing identical state
}

export interface SealOptions {
  ttlSeconds?: number;
}

export function sealState<T extends object>(
  payload: T,
  key: Buffer,
  opts: SealOptions = {},
): string {
  const ttl = opts.ttlSeconds ?? 10 * 60;
  const envelope: SealedEnvelope<T> = {
    d: payload,
    e: Date.now() + ttl * 1000,
    n: randomBytes(8).toString("base64url"),
  };
  const ciphertext = encrypt(JSON.stringify(envelope), key);
  return ciphertext.toString("base64url");
}

export function openState<T>(token: string, key: Buffer): T | null {
  if (typeof token !== "string" || token.length === 0) return null;
  let plaintext: string;
  try {
    plaintext = decrypt(Buffer.from(token, "base64url"), key);
  } catch {
    return null;
  }
  let envelope: SealedEnvelope<T>;
  try {
    envelope = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (!envelope || typeof envelope.e !== "number") return null;
  if (envelope.e < Date.now()) return null;
  return envelope.d as T;
}

// ---------------------------------------------------------------------------
// Cookie attributes (host-only, secure, lax)
// ---------------------------------------------------------------------------

export interface CookieAttrs {
  name: string;
  value: string;
  /** Lifetime in seconds. If omitted, session cookie (no Max-Age). */
  maxAge?: number;
  path?: string;
  /** Default true in prod (HTTPS). */
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "lax" | "strict" | "none";
}

export function buildCookieHeader(attrs: CookieAttrs): string {
  const parts: string[] = [`${attrs.name}=${attrs.value}`];
  parts.push(`Path=${attrs.path ?? "/"}`);
  if (attrs.maxAge !== undefined) parts.push(`Max-Age=${attrs.maxAge}`);
  if (attrs.httpOnly ?? true) parts.push("HttpOnly");
  if (attrs.secure ?? true) parts.push("Secure");
  parts.push(`SameSite=${attrs.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

export function buildClearCookieHeader(name: string, path: string = "/"): string {
  return buildCookieHeader({ name, value: "", maxAge: 0, path });
}

/**
 * Parse a `Cookie:` header into a name→value map. Last value wins on
 * duplicates. Doesn't validate URL-encoding because cookie values we
 * issue are base64url + dots only.
 */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

