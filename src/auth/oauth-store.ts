/**
 * OAuth 2.1 store: dynamic clients (RFC 7591), authorization codes
 * (PKCE/S256), access + refresh tokens with rotation (MOS-328 Phase 2).
 *
 * Tokens are SHA-256 hashed at rest; plaintext bearer strings never
 * persist past the response to the registering caller. Authorization
 * codes have a 60-second TTL; access tokens default to 1 hour;
 * refresh tokens default to 30 days with rotation on each use.
 *
 * No JWT — everything is opaque + DB-backed. This means revocation
 * is immediate (delete/flag the row) and we don't need to manage
 * signing keys.
 */

import { randomUUID, randomBytes, createHash } from "node:crypto";

import type { Db } from "./db.js";
import { hashToken } from "./tokens.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const AUTH_CODE_TTL_SECONDS = 60;
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591)
// ---------------------------------------------------------------------------

export interface RegisterClientInput {
  clientName?: string;
  redirectUris: string[];
  scope?: string;
  registeredByUserId?: string | null;
}

export interface OAuthClient {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: string;
  scope: string | null;
  createdAt: Date;
}

interface ClientRow {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method: string;
  scope: string | null;
  created_at: string;
}

function rowToClient(row: ClientRow): OAuthClient {
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUris: row.redirect_uris,
    grantTypes: row.grant_types,
    tokenEndpointAuthMethod: row.token_endpoint_auth_method,
    scope: row.scope,
    createdAt: new Date(row.created_at),
  };
}

export async function registerClient(
  db: Db,
  input: RegisterClientInput,
): Promise<OAuthClient> {
  // Generate a non-secret client_id. Public clients (PKCE) only.
  const clientId = `mcpc_${randomBytes(16).toString("base64url")}`;
  const { data, error } = await db
    .from("mcp_oauth_clients")
    .insert({
      client_id: clientId,
      client_name: input.clientName ?? null,
      redirect_uris: input.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
      scope: input.scope ?? null,
      registered_by_user_id: input.registeredByUserId ?? null,
    })
    .select()
    .single();
  if (error) throw new Error(`registerClient: ${error.message}`);
  return rowToClient(data as ClientRow);
}

export async function getClient(
  db: Db,
  clientId: string,
): Promise<OAuthClient | null> {
  const { data, error } = await db
    .from("mcp_oauth_clients")
    .select("*")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw new Error(`getClient: ${error.message}`);
  return data ? rowToClient(data as ClientRow) : null;
}

// ---------------------------------------------------------------------------
// Authorization codes (PKCE/S256, 60-second TTL)
// ---------------------------------------------------------------------------

export interface CreateAuthCodeInput {
  userId: string;
  clientId: string;
  scope?: string | null;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod?: "S256";
}

export interface AuthCodeRecord {
  /** Plaintext code — given to caller exactly once. */
  code: string;
  /** Stored hash (sha256 hex). Mostly internal. */
  codeHash: string;
  expiresAt: Date;
}

export async function createAuthCode(
  db: Db,
  input: CreateAuthCodeInput,
): Promise<AuthCodeRecord> {
  const code = `mcpc_code_${randomBytes(32).toString("base64url")}`;
  const codeHash = hashToken(code);
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000);
  const { error } = await db.from("mcp_oauth_codes").insert({
    code_hash: codeHash,
    user_id: input.userId,
    client_id: input.clientId,
    scope: input.scope ?? null,
    redirect_uri: input.redirectUri,
    code_challenge: input.codeChallenge,
    code_challenge_method: input.codeChallengeMethod ?? "S256",
    expires_at: expiresAt.toISOString(),
  });
  if (error) throw new Error(`createAuthCode: ${error.message}`);
  return { code, codeHash, expiresAt };
}

export interface ConsumedAuthCode {
  userId: string;
  clientId: string;
  scope: string | null;
  redirectUri: string;
  codeChallenge: string;
}

/**
 * Atomically consume a code: marks `consumed_at = now()` and returns
 * the row IFF the code (a) exists, (b) has not been used, (c) is not
 * expired. Returns null otherwise — callers should treat null as
 * "invalid grant".
 *
 * Single-use enforcement is critical for OAuth 2.1 — a leaked code
 * must not be replayable.
 */
export async function consumeAuthCode(
  db: Db,
  code: string,
): Promise<ConsumedAuthCode | null> {
  const codeHash = hashToken(code);
  // Use RPC-style chained update with explicit conditions so we never
  // burn a valid code on a stale row.
  const nowIso = new Date().toISOString();
  const { data, error } = await db
    .from("mcp_oauth_codes")
    .update({ consumed_at: nowIso })
    .eq("code_hash", codeHash)
    .is("consumed_at", null)
    .gt("expires_at", nowIso)
    .select()
    .maybeSingle();
  if (error) throw new Error(`consumeAuthCode: ${error.message}`);
  if (!data) return null;
  return {
    userId: data.user_id,
    clientId: data.client_id,
    scope: data.scope,
    redirectUri: data.redirect_uri,
    codeChallenge: data.code_challenge,
  };
}

/**
 * Verify a PKCE code_verifier against the stored code_challenge.
 *
 * For S256: `BASE64URL-NO-PAD(SHA256(verifier)) === code_challenge`
 */
export function verifyPkce(verifier: string, challenge: string): boolean {
  const computed = createHash("sha256").update(verifier).digest("base64url");
  return computed === challenge;
}

// ---------------------------------------------------------------------------
// Access + refresh tokens
// ---------------------------------------------------------------------------

export interface IssueTokenPairInput {
  userId: string;
  clientId: string;
  scope?: string | null;
  /** ms since epoch; defaults to 1h ahead. */
  accessExpiresAt?: Date;
  /** ms since epoch; defaults to 30d ahead. */
  refreshExpiresAt?: Date;
  /** For rotation: id of the refresh token that minted this pair. */
  parentTokenId?: string | null;
}

export interface IssuedTokenPair {
  accessToken: string;
  refreshToken: string;
  accessTokenId: string;
  refreshTokenId: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
}

export async function issueTokenPair(
  db: Db,
  input: IssueTokenPairInput,
  generateAccess: () => { token: string; hash: string },
  generateRefresh: () => { token: string; hash: string },
): Promise<IssuedTokenPair> {
  const now = Date.now();
  const accessExpiresAt =
    input.accessExpiresAt ?? new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000);
  const refreshExpiresAt =
    input.refreshExpiresAt ?? new Date(now + REFRESH_TOKEN_TTL_SECONDS * 1000);

  const access = generateAccess();
  const refresh = generateRefresh();

  const accessId = randomUUID();
  const refreshId = randomUUID();

  const { error } = await db.from("mcp_oauth_tokens").insert([
    {
      id: accessId,
      token_hash: access.hash,
      kind: "access",
      user_id: input.userId,
      client_id: input.clientId,
      scope: input.scope ?? null,
      expires_at: accessExpiresAt.toISOString(),
      parent_token_id: input.parentTokenId ?? null,
    },
    {
      id: refreshId,
      token_hash: refresh.hash,
      kind: "refresh",
      user_id: input.userId,
      client_id: input.clientId,
      scope: input.scope ?? null,
      expires_at: refreshExpiresAt.toISOString(),
      parent_token_id: input.parentTokenId ?? null,
    },
  ]);
  if (error) throw new Error(`issueTokenPair: ${error.message}`);

  return {
    accessToken: access.token,
    refreshToken: refresh.token,
    accessTokenId: accessId,
    refreshTokenId: refreshId,
    accessExpiresAt,
    refreshExpiresAt,
  };
}

export interface ResolvedAccessToken {
  tokenId: string;
  userId: string;
  clientId: string | null;
  scope: string | null;
  expiresAt: Date;
}

/**
 * Look up an access token by its bearer value. Returns null if the
 * token doesn't exist, is revoked, has expired, or is the wrong kind.
 */
export async function resolveAccessToken(
  db: Db,
  token: string,
): Promise<ResolvedAccessToken | null> {
  const tokenHash = hashToken(token);
  const nowIso = new Date().toISOString();
  const { data, error } = await db
    .from("mcp_oauth_tokens")
    .select("*")
    .eq("token_hash", tokenHash)
    .eq("kind", "access")
    .is("revoked_at", null)
    .gt("expires_at", nowIso)
    .maybeSingle();
  if (error) throw new Error(`resolveAccessToken: ${error.message}`);
  if (!data) return null;
  return {
    tokenId: data.id,
    userId: data.user_id,
    clientId: data.client_id,
    scope: data.scope,
    expiresAt: new Date(data.expires_at),
  };
}

export interface ResolvedRefreshToken {
  tokenId: string;
  userId: string;
  clientId: string | null;
  scope: string | null;
  expiresAt: Date;
}

export async function resolveRefreshToken(
  db: Db,
  token: string,
): Promise<ResolvedRefreshToken | null> {
  const tokenHash = hashToken(token);
  const nowIso = new Date().toISOString();
  const { data, error } = await db
    .from("mcp_oauth_tokens")
    .select("*")
    .eq("token_hash", tokenHash)
    .eq("kind", "refresh")
    .is("revoked_at", null)
    .gt("expires_at", nowIso)
    .maybeSingle();
  if (error) throw new Error(`resolveRefreshToken: ${error.message}`);
  if (!data) return null;
  return {
    tokenId: data.id,
    userId: data.user_id,
    clientId: data.client_id,
    scope: data.scope,
    expiresAt: new Date(data.expires_at),
  };
}

/**
 * Mark a token as revoked. Idempotent — safe to call on an already-
 * revoked or unknown token.
 */
export async function revokeToken(
  db: Db,
  token: string,
): Promise<void> {
  const tokenHash = hashToken(token);
  const { error } = await db
    .from("mcp_oauth_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("token_hash", tokenHash)
    .is("revoked_at", null);
  if (error) throw new Error(`revokeToken: ${error.message}`);
}

/** Revoke ALL tokens (access + refresh) for a user. Used by /admin/revoke. */
export async function revokeAllTokensForUser(
  db: Db,
  userId: string,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { error } = await db
    .from("mcp_oauth_tokens")
    .update({ revoked_at: nowIso })
    .eq("user_id", userId)
    .is("revoked_at", null);
  if (error) throw new Error(`revokeAllTokensForUser: ${error.message}`);
}

/** Touch last_used_at on an access token. Best-effort; failures swallowed. */
export async function touchTokenLastUsed(
  db: Db,
  tokenId: string,
): Promise<void> {
  await db
    .from("mcp_oauth_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", tokenId);
}
