/**
 * Service-account bearer tokens (MOS-328 Phase 2).
 *
 * Long-lived, opaque tokens prefixed `mcps_`. Used by headless callers
 * that can't run a browser-based OAuth flow — e.g., the harness on
 * Lightsail. Each service token is bound to a user with `kind=service`
 * (created via `createServiceUser`). The token is shown to the
 * caller ONCE at provisioning; only the SHA-256 hash persists.
 *
 * Revocation is immediate — flipping `revoked_at` to a timestamp
 * makes the next resolution return null.
 */

import { randomUUID } from "node:crypto";

import type { Db } from "./db.js";
import { generateServiceToken, hashToken } from "./tokens.js";

export interface CreateServiceTokenInput {
  userId: string;
  displayName: string;
  /** Optional expiry. Default: never expires (admin-revoked only). */
  expiresAt?: Date;
  createdBy?: string | null;
}

export interface IssuedServiceToken {
  /** Plaintext bearer string. Show once. */
  token: string;
  tokenId: string;
  displayName: string;
  expiresAt: Date | null;
}

export async function createServiceTokenRow(
  db: Db,
  input: CreateServiceTokenInput,
): Promise<IssuedServiceToken> {
  const { token, hash } = generateServiceToken();
  const tokenId = randomUUID();
  const { error } = await db.from("mcp_service_tokens").insert({
    id: tokenId,
    token_hash: hash,
    user_id: input.userId,
    display_name: input.displayName,
    expires_at: input.expiresAt ? input.expiresAt.toISOString() : null,
    created_by: input.createdBy ?? null,
  });
  if (error) throw new Error(`createServiceTokenRow: ${error.message}`);
  return {
    token,
    tokenId,
    displayName: input.displayName,
    expiresAt: input.expiresAt ?? null,
  };
}

export interface ResolvedServiceToken {
  tokenId: string;
  userId: string;
}

/**
 * Look up a service token by its bearer value. Returns null if it
 * doesn't exist, is revoked, or has expired.
 */
export async function resolveServiceToken(
  db: Db,
  token: string,
): Promise<ResolvedServiceToken | null> {
  const tokenHash = hashToken(token);
  const nowIso = new Date().toISOString();
  const { data, error } = await db
    .from("mcp_service_tokens")
    .select("*")
    .eq("token_hash", tokenHash)
    .is("revoked_at", null)
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .maybeSingle();
  if (error) throw new Error(`resolveServiceToken: ${error.message}`);
  if (!data) return null;
  return { tokenId: data.id, userId: data.user_id };
}

export async function revokeServiceToken(
  db: Db,
  tokenId: string,
  revokedBy: string | null = null,
): Promise<void> {
  const { error } = await db
    .from("mcp_service_tokens")
    .update({
      revoked_at: new Date().toISOString(),
      revoked_by: revokedBy,
    })
    .eq("id", tokenId);
  if (error) throw new Error(`revokeServiceToken: ${error.message}`);
}

export async function listServiceTokens(
  db: Db,
): Promise<
  Array<{
    id: string;
    userId: string;
    displayName: string;
    createdAt: Date;
    lastUsedAt: Date | null;
    expiresAt: Date | null;
    revokedAt: Date | null;
  }>
> {
  const { data, error } = await db
    .from("mcp_service_tokens")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listServiceTokens: ${error.message}`);
  return (data ?? []).map((row) => ({
    id: row.id,
    userId: row.user_id,
    displayName: row.display_name,
    createdAt: new Date(row.created_at),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
  }));
}

export async function touchServiceTokenLastUsed(
  db: Db,
  tokenId: string,
): Promise<void> {
  await db
    .from("mcp_service_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", tokenId);
}
