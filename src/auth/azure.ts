/**
 * Microsoft Entra ID (Azure AD) OIDC integration (MOS-328 Phase 3).
 *
 * Used by:
 *   - `/enroll` to identify the Moss user before they paste their
 *     BuildTools credentials.
 *   - `/oauth/authorize` to identify the user when Claude Desktop
 *     kicks off its own OAuth flow.
 *
 * Both flows are PKCE-protected authorization code grants against the
 * same Azure AD enterprise app ("Moss Internal Tools"). The IdP gives
 * us back an ID token; we validate it, extract `sub` and `email`,
 * enforce the `@mossbuildinganddesign.com` domain, and the caller
 * provisions/updates the `mcp_users` row.
 *
 * We use `openid-client` v6 — the discovery + grant primitives are
 * the only Azure-specific code in the codebase. Everything else
 * speaks generic OIDC.
 */

import * as oidc from "openid-client";

export interface AzureConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Domain to which we restrict enrollment. */
  allowedDomain: string;
}

export function loadAzureConfig(env: NodeJS.ProcessEnv = process.env): AzureConfig {
  const tenantId = env.AZURE_AD_TENANT_ID;
  const clientId = env.AZURE_AD_SSO_CLIENT_ID;
  const clientSecret = env.AZURE_AD_SSO_CLIENT_SECRET;
  const allowedDomain = env.MCP_ALLOWED_EMAIL_DOMAIN ?? "mossbuildinganddesign.com";
  if (!tenantId) throw new Error("AZURE_AD_TENANT_ID env var is required");
  if (!clientId) throw new Error("AZURE_AD_SSO_CLIENT_ID env var is required");
  if (!clientSecret) throw new Error("AZURE_AD_SSO_CLIENT_SECRET env var is required");
  return { tenantId, clientId, clientSecret, allowedDomain };
}

/**
 * Discover the Azure AD endpoints + key set. Cached at server boot;
 * re-discovery is rare so caching beyond per-process isn't worth it.
 */
export async function discoverAzureConfig(
  cfg: AzureConfig,
): Promise<oidc.Configuration> {
  const issuer = new URL(
    `https://login.microsoftonline.com/${cfg.tenantId}/v2.0`,
  );
  return oidc.discovery(issuer, cfg.clientId, cfg.clientSecret);
}

// ---------------------------------------------------------------------------
// Authorization request
// ---------------------------------------------------------------------------

export interface BuildAuthorizationUrlInput {
  redirectUri: string;
  /** Random string the caller stores to bind a CSRF state. */
  state: string;
  /** PKCE verifier (we generate it and return for the caller to store). */
  codeVerifier?: string;
  /** Nonce passed to Azure + expected back on the ID token. Generated if absent. */
  nonce?: string;
  /** Space-separated scopes. Default 'openid email profile'. */
  scope?: string;
  /** Login hint to pre-fill the Microsoft sign-in form. Optional. */
  loginHint?: string;
}

export interface BuildAuthorizationUrlResult {
  url: string;
  codeVerifier: string;
  codeChallenge: string;
  state: string;
  nonce: string;
}

export async function buildAuthorizationUrl(
  config: oidc.Configuration,
  input: BuildAuthorizationUrlInput,
): Promise<BuildAuthorizationUrlResult> {
  const codeVerifier = input.codeVerifier ?? oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const nonce = input.nonce ?? oidc.randomNonce();
  const scope = input.scope ?? "openid email profile";

  const params: Record<string, string> = {
    redirect_uri: input.redirectUri,
    scope,
    response_type: "code",
    state: input.state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  };
  if (input.loginHint) params.login_hint = input.loginHint;

  const url = oidc.buildAuthorizationUrl(config, params).toString();
  return { url, codeVerifier, codeChallenge, state: input.state, nonce };
}

// ---------------------------------------------------------------------------
// Callback / code exchange
// ---------------------------------------------------------------------------

export interface ExchangeCodeInput {
  /** Full URL that Azure redirected back to (includes ?code=&state=). */
  currentUrl: URL;
  /** State value we stashed before redirecting to Azure. */
  expectedState: string;
  /** PKCE verifier we stashed. */
  codeVerifier: string;
  /** Nonce we passed in the auth request, for ID token validation. */
  expectedNonce: string;
}

export interface AzureIdentity {
  /** Stable Azure AD user identifier ('sub' claim). */
  sub: string;
  email: string;
  /** Display name when Azure returned one. */
  name: string | null;
  /** Raw ID token claims. */
  claims: Record<string, unknown>;
}

/**
 * Exchange the authorization code for tokens, validate the ID token,
 * and return the identity claims. Throws if state/nonce/PKCE don't
 * match — those errors must reach the user as "auth failed", not be
 * silently degraded.
 */
export async function exchangeCode(
  config: oidc.Configuration,
  input: ExchangeCodeInput,
): Promise<AzureIdentity> {
  const tokens = await oidc.authorizationCodeGrant(
    config,
    input.currentUrl,
    {
      pkceCodeVerifier: input.codeVerifier,
      expectedState: input.expectedState,
      expectedNonce: input.expectedNonce,
    },
  );
  const claims = tokens.claims();
  if (!claims) {
    throw new Error("Azure response missing ID token claims");
  }
  return identityFromClaims(claims);
}

/**
 * Extract the identity we care about from ID-token claims. Exposed
 * separately so tests can pass synthetic claims without going through
 * a full OIDC exchange.
 */
export function identityFromClaims(
  claims: Record<string, unknown>,
): AzureIdentity {
  const sub = claims.sub;
  if (typeof sub !== "string") {
    throw new Error("ID token missing 'sub' claim");
  }
  const email = pickEmail(claims);
  if (!email) {
    throw new Error("ID token missing email / preferred_username");
  }
  const name = typeof claims.name === "string" ? claims.name : null;
  return { sub, email, name, claims };
}

function pickEmail(claims: Record<string, unknown>): string | null {
  // Azure AD usually returns `email` only when the user has a verified
  // email on their tenant. Otherwise it falls back to
  // `preferred_username`, which IS an email for org accounts.
  if (typeof claims.email === "string") return claims.email.toLowerCase();
  if (typeof claims.preferred_username === "string") {
    return claims.preferred_username.toLowerCase();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Domain enforcement
// ---------------------------------------------------------------------------

export function isAllowedDomain(email: string, allowedDomain: string): boolean {
  const at = email.lastIndexOf("@");
  if (at === -1) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return domain === allowedDomain.toLowerCase();
}

export function assertAllowedDomain(
  email: string,
  allowedDomain: string,
): void {
  if (!isAllowedDomain(email, allowedDomain)) {
    throw new Error(
      `Email domain not allowed. This MCP is restricted to @${allowedDomain}.`,
    );
  }
}
