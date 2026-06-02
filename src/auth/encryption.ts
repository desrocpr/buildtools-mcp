/**
 * AES-256-GCM symmetric encryption for credentials at rest (MOS-328).
 *
 * Used by the enrollment flow to encrypt BuildTools passwords before
 * storing them in Supabase. The encryption key is loaded once at server
 * boot from MCP_ENCRYPTION_KEY (Doppler) and never logged.
 *
 * Storage format (a single bytea column in Postgres):
 *
 *   ┌─────────┬──────────────┬───────────────────┬──────────────────┐
 *   │ version │ iv (12 byte) │ authTag (16 byte) │   ciphertext     │
 *   │ 1 byte  │  random IV   │ GCM authenticator │ AES-256-GCM body │
 *   └─────────┴──────────────┴───────────────────┴──────────────────┘
 *
 * The leading version byte exists so we can rotate the master key
 * later without re-enrolling every user: encrypt new writes under
 * version 2, decrypt either version 1 or 2 from disk, then back-fill
 * by re-encrypting at read time.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const VERSION = 1;
const IV_LENGTH = 12; // GCM standard
const AUTH_TAG_LENGTH = 16; // GCM standard
const KEY_LENGTH = 32; // AES-256 = 256 bits

/**
 * Encrypt a UTF-8 string. Returns the concatenated payload ready to
 * store in a bytea column.
 */
export function encrypt(plaintext: string, key: Buffer): Buffer {
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `MCP_ENCRYPTION_KEY must be ${KEY_LENGTH} bytes; got ${key.length}`,
    );
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  if (authTag.length !== AUTH_TAG_LENGTH) {
    // Safety net: Node's GCM implementation always returns 16 bytes here,
    // but if someone ever swaps the cipher we want a loud failure.
    throw new Error(`unexpected authTag length: ${authTag.length}`);
  }
  return Buffer.concat([Buffer.from([VERSION]), iv, authTag, ciphertext]);
}

/**
 * Decrypt a payload previously produced by `encrypt()`. Throws on any
 * tamper / wrong-key / wrong-version condition.
 */
export function decrypt(payload: Buffer, key: Buffer): string {
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `MCP_ENCRYPTION_KEY must be ${KEY_LENGTH} bytes; got ${key.length}`,
    );
  }
  if (payload.length < 1 + IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("encrypted payload is too short");
  }
  const version = payload[0];
  if (version !== VERSION) {
    throw new Error(`unsupported encryption version: ${version}`);
  }
  const iv = payload.subarray(1, 1 + IV_LENGTH);
  const authTag = payload.subarray(
    1 + IV_LENGTH,
    1 + IV_LENGTH + AUTH_TAG_LENGTH,
  );
  const ciphertext = payload.subarray(1 + IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/**
 * Load the master key from `MCP_ENCRYPTION_KEY` env, base64-decoding it
 * to a 32-byte Buffer. Throws if missing or the wrong length so a
 * misconfigured deployment fails loud at boot, not on first enrollment.
 */
export function loadEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.MCP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("MCP_ENCRYPTION_KEY env var is required");
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new Error("MCP_ENCRYPTION_KEY must be base64-encoded");
  }
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `MCP_ENCRYPTION_KEY must decode to ${KEY_LENGTH} bytes; got ${key.length}`,
    );
  }
  return key;
}

/**
 * Constant-time equality for two `Buffer`s of equal length. Re-exported
 * for callers that need to compare ciphertexts or hashes safely.
 */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const ENCRYPTION_VERSION = VERSION;
