/**
 * Encrypted-credential storage (MOS-328 Phase 2).
 *
 * Wraps `mcp_service_credentials` + `encryption.ts`. The plaintext
 * password is held in memory only as long as it takes to:
 *
 *   - Validate a BuildTools login at enrollment time
 *   - Construct a `BuildToolsAPI` instance at tool-call time
 *
 * On disk it's always AES-256-GCM ciphertext, keyed by Doppler's
 * `MCP_ENCRYPTION_KEY`. Storage format is documented in
 * `encryption.ts`.
 */

import type { Db } from "./db.js";
import { decrypt, encrypt, ENCRYPTION_VERSION } from "./encryption.js";
import type { BuildToolsCredentials } from "./types.js";

interface ServiceCredentialRowDb {
  id: string;
  user_id: string;
  service: string;
  credentials_encrypted: string; // bytea comes back as hex-prefixed string or base64 depending on PostgREST config
  encryption_version: number;
  encrypted_at: string;
  updated_at: string;
}

/**
 * Postgres bytea over PostgREST is returned as either:
 *   - `\xDEADBEEF...` (hex format, the default)
 *   - or base64 if `pgrst.bytea_to_base64 = true`
 *
 * Handle both — we don't control the project setting and want robustness.
 */
function byteaToBuffer(value: string | Buffer): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value !== "string") {
    throw new Error(`unexpected bytea value type: ${typeof value}`);
  }
  if (value.startsWith("\\x")) {
    return Buffer.from(value.slice(2), "hex");
  }
  // Best-effort base64.
  return Buffer.from(value, "base64");
}

/**
 * Insert-or-update encrypted credentials for `(userId, service)`. The
 * caller supplies the plaintext; this fn does the encryption so the
 * key never leaks past `encryption.ts`.
 */
export async function upsertServiceCredentials(
  db: Db,
  userId: string,
  service: string,
  credentials: BuildToolsCredentials,
  encryptionKey: Buffer,
): Promise<void> {
  // We serialize the credential payload as JSON so future services
  // with extra fields (e.g. tenant slug) extend cleanly. The
  // BuildTools shape is just {email, password}.
  const plaintext = JSON.stringify(credentials);
  const ciphertext = encrypt(plaintext, encryptionKey);

  // Send as Postgres bytea hex literal (`\x...`). supabase-js doesn't
  // know how to serialize a Buffer to bytea, so without the explicit
  // hex wrapper it JSON-stringifies the Buffer (storing the literal
  // `{"type":"Buffer","data":[...]}` bytes instead of our ciphertext).
  const hexLiteral = "\\x" + ciphertext.toString("hex");

  const { error } = await db
    .from("mcp_service_credentials")
    .upsert(
      {
        user_id: userId,
        service,
        credentials_encrypted: hexLiteral,
        encryption_version: ENCRYPTION_VERSION,
        encrypted_at: new Date().toISOString(),
      },
      { onConflict: "user_id,service" },
    );
  if (error) {
    throw new Error(`upsertServiceCredentials: ${error.message}`);
  }
}

/**
 * Fetch + decrypt credentials. Returns null if no row exists for
 * `(userId, service)`. Throws if the row exists but decryption fails
 * — that's a sign of key rotation or corruption and shouldn't be
 * silently downgraded to "missing credential".
 */
export async function getServiceCredentials(
  db: Db,
  userId: string,
  service: string,
  encryptionKey: Buffer,
): Promise<BuildToolsCredentials | null> {
  const { data, error } = await db
    .from("mcp_service_credentials")
    .select("*")
    .eq("user_id", userId)
    .eq("service", service)
    .maybeSingle();
  if (error) {
    throw new Error(`getServiceCredentials: ${error.message}`);
  }
  if (!data) return null;
  const row = data as ServiceCredentialRowDb;
  const ciphertext = byteaToBuffer(row.credentials_encrypted);
  const plaintext = decrypt(ciphertext, encryptionKey);
  return JSON.parse(plaintext) as BuildToolsCredentials;
}

export async function hasCredentialsFor(
  db: Db,
  userId: string,
  service: string,
): Promise<boolean> {
  const { count, error } = await db
    .from("mcp_service_credentials")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("service", service);
  if (error) {
    throw new Error(`hasCredentialsFor: ${error.message}`);
  }
  return (count ?? 0) > 0;
}

export async function deleteServiceCredentials(
  db: Db,
  userId: string,
  service: string,
): Promise<void> {
  const { error } = await db
    .from("mcp_service_credentials")
    .delete()
    .eq("user_id", userId)
    .eq("service", service);
  if (error) {
    throw new Error(`deleteServiceCredentials: ${error.message}`);
  }
}
