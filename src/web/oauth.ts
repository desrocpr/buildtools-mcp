/**
 * MCP OAuth 2.1 endpoints (MOS-328 Phase 5).
 *
 * This is what Claude Desktop talks to. Claude discovers our metadata,
 * dynamically registers itself, runs the PKCE auth-code flow (which
 * we bounce through Microsoft Entra ID so the user actually signs
 * in), and exchanges the resulting code for an access+refresh pair.
 *
 * Routes:
 *   GET  /.well-known/oauth-authorization-server   RFC 8414
 *   POST /oauth/register                           RFC 7591
 *   GET  /oauth/authorize                          PKCE auth-code start
 *   GET  /oauth/azure-callback                     Azure returns here
 *   POST /oauth/token                              code + refresh grants
 *   POST /oauth/revoke                             RFC 7009
 *
 * No JWT, no signing keys to manage — tokens are opaque (32-byte
 * random body), stored hashed in `mcp_oauth_tokens`. Revocation is
 * immediate.
 *
 * State during the Azure round-trip is sealed (AES-256-GCM) into the
 * Azure `state` parameter so the callback can recover all of Claude's
 * original request without server state.
 */

import express, { type Request, type Response, type Router } from "express";
import type { Configuration } from "openid-client";

import {
  assertAllowedDomain,
  buildAuthorizationUrl,
  exchangeCode,
  type AzureConfig,
} from "../auth/azure.js";
import type { Db } from "../auth/db.js";
import {
  consumeAuthCode,
  createAuthCode,
  getClient,
  issueTokenPair,
  registerClient,
  resolveAccessToken,
  revokeToken,
  rotateRefreshToken,
  verifyPkce,
} from "../auth/oauth-store.js";
import { openState, sealState } from "../auth/session.js";
import {
  generateAccessToken,
  generateRefreshToken,
} from "../auth/tokens.js";
import { upsertHumanUser } from "../auth/users.js";

export interface OAuthDeps {
  db: Db;
  encryptionKey: Buffer;
  azure: AzureConfig;
  azureDiscovery: Configuration;
  publicOrigin: string;
}

interface AzureStateForOAuth {
  kind: "oauth";
  // Claude's original auth request, carried across the Microsoft hop:
  clientId: string;
  redirectUri: string;
  clientState: string;
  scope: string | null;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  // Our own PKCE/nonce for the Azure leg:
  azureCodeVerifier: string;
  azureNonce: string;
}

export function mountOAuthRoutes(router: Router, deps: OAuthDeps): void {
  // ----- Discovery (RFC 8414) -------------------------------------------------

  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: deps.publicOrigin,
      authorization_endpoint: `${deps.publicOrigin}/oauth/authorize`,
      token_endpoint: `${deps.publicOrigin}/oauth/token`,
      registration_endpoint: `${deps.publicOrigin}/oauth/register`,
      revocation_endpoint: `${deps.publicOrigin}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
      // Per MCP 2025-03-26 spec: streamable_http transport, PKCE required.
      service_documentation: `${deps.publicOrigin}/enroll`,
    });
  });

  // ----- Dynamic client registration (RFC 7591) -------------------------------

  router.post("/oauth/register", express.json(), async (req, res) => {
    try {
      const body = req.body ?? {};
      const redirectUris = Array.isArray(body.redirect_uris)
        ? body.redirect_uris.filter((u: unknown) => typeof u === "string")
        : [];
      if (redirectUris.length === 0) {
        res
          .status(400)
          .json({ error: "invalid_redirect_uri", error_description: "redirect_uris required" });
        return;
      }
      const client = await registerClient(deps.db, {
        clientName: typeof body.client_name === "string" ? body.client_name : null,
        redirectUris,
        scope: typeof body.scope === "string" ? body.scope : "mcp",
      });
      res.status(201).json({
        client_id: client.clientId,
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        grant_types: client.grantTypes,
        token_endpoint_auth_method: client.tokenEndpointAuthMethod,
        scope: client.scope,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: "server_error", error_description: msg });
    }
  });

  // ----- /oauth/authorize → kick off Azure auth -------------------------------

  router.get("/oauth/authorize", async (req, res) => {
    const clientId = stringQuery(req, "client_id");
    const redirectUri = stringQuery(req, "redirect_uri");
    const responseType = stringQuery(req, "response_type");
    const clientState = stringQuery(req, "state") ?? "";
    const scope = stringQuery(req, "scope");
    const codeChallenge = stringQuery(req, "code_challenge");
    const codeChallengeMethod = stringQuery(req, "code_challenge_method");

    if (!clientId || !redirectUri || responseType !== "code") {
      res.status(400).send("invalid_request");
      return;
    }
    if (!codeChallenge || codeChallengeMethod !== "S256") {
      res.status(400).send("invalid_request: PKCE S256 required");
      return;
    }

    const client = await getClient(deps.db, clientId);
    if (!client) {
      res.status(400).send("invalid_client");
      return;
    }
    if (!client.redirectUris.includes(redirectUri)) {
      res.status(400).send("invalid_redirect_uri");
      return;
    }

    // Generate our own PKCE/nonce for the Azure leg, seal everything
    // into the state we send to Microsoft.
    const oidc = await import("openid-client");
    const azureCodeVerifier = oidc.randomPKCECodeVerifier();
    const azureNonce = oidc.randomNonce();
    // 90-second TTL closes the replay window without affecting real
    // flows — Microsoft sign-in normally completes in 5–30s.
    // (Per multi-reviewer feedback on the initial 10-minute default.)
    const sealedState = sealState<AzureStateForOAuth>(
      {
        kind: "oauth",
        clientId,
        redirectUri,
        clientState,
        scope: scope ?? null,
        codeChallenge,
        codeChallengeMethod: "S256",
        azureCodeVerifier,
        azureNonce,
      },
      deps.encryptionKey,
      { ttlSeconds: 90 },
    );

    const result = await buildAuthorizationUrl(deps.azureDiscovery, {
      redirectUri: `${deps.publicOrigin}/oauth/azure-callback`,
      state: sealedState,
      codeVerifier: azureCodeVerifier,
      nonce: azureNonce,
    });
    res.redirect(result.url);
  });

  // ----- /oauth/azure-callback → mint MCP code, bounce to Claude --------------

  router.get("/oauth/azure-callback", async (req, res) => {
    const stateParam = stringQuery(req, "state");
    if (!stateParam) {
      res.status(400).send("missing state");
      return;
    }
    const state = openState<AzureStateForOAuth>(stateParam, deps.encryptionKey);
    if (!state || state.kind !== "oauth") {
      res.status(400).send("invalid or expired state");
      return;
    }

    try {
      const currentUrl = new URL(`${deps.publicOrigin}${req.originalUrl}`);
      const identity = await exchangeCode(deps.azureDiscovery, {
        currentUrl,
        expectedState: stateParam,
        codeVerifier: state.azureCodeVerifier,
        expectedNonce: state.azureNonce,
      });
      assertAllowedDomain(identity.email, deps.azure.allowedDomain);
      const user = await upsertHumanUser(deps.db, {
        azureSub: identity.sub,
        email: identity.email,
        displayName: identity.name ?? null,
      });

      // Mint our own auth code and redirect Claude back with it.
      const created = await createAuthCode(deps.db, {
        userId: user.id,
        clientId: state.clientId,
        scope: state.scope,
        redirectUri: state.redirectUri,
        codeChallenge: state.codeChallenge,
        codeChallengeMethod: state.codeChallengeMethod,
      });

      const redirectUrl = new URL(state.redirectUri);
      redirectUrl.searchParams.set("code", created.code);
      if (state.clientState) redirectUrl.searchParams.set("state", state.clientState);
      res.redirect(redirectUrl.toString());
    } catch (err) {
      // Log full error to stderr; user-facing message is generic.
      process.stderr.write(
        `[oauth] azure callback error: ${(err as Error)?.message ?? err}\n`,
      );
      res.status(400).send("sign-in failed");
    }
  });

  // ----- /oauth/token → code + refresh grants ---------------------------------

  router.post("/oauth/token", express.urlencoded({ extended: false }), express.json(), async (req, res) => {
    const grantType = typeof req.body?.grant_type === "string" ? req.body.grant_type : "";
    try {
      if (grantType === "authorization_code") {
        await handleAuthCodeGrant(req, res, deps);
        return;
      }
      if (grantType === "refresh_token") {
        await handleRefreshGrant(req, res, deps);
        return;
      }
      res.status(400).json({ error: "unsupported_grant_type" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: "server_error", error_description: msg });
    }
  });

  // ----- /oauth/revoke (RFC 7009) ---------------------------------------------

  router.post("/oauth/revoke", express.urlencoded({ extended: false }), express.json(), async (req, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token : null;
    if (!token) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    await revokeToken(deps.db, token);
    res.status(200).json({ revoked: true });
  });
}

async function handleAuthCodeGrant(
  req: Request,
  res: Response,
  deps: OAuthDeps,
): Promise<void> {
  const code = typeof req.body?.code === "string" ? req.body.code : null;
  const codeVerifier =
    typeof req.body?.code_verifier === "string" ? req.body.code_verifier : null;
  const clientId =
    typeof req.body?.client_id === "string" ? req.body.client_id : null;
  const redirectUri =
    typeof req.body?.redirect_uri === "string" ? req.body.redirect_uri : null;

  if (!code || !codeVerifier || !clientId || !redirectUri) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  const consumed = await consumeAuthCode(deps.db, code);
  if (!consumed) {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }
  if (
    consumed.clientId !== clientId ||
    consumed.redirectUri !== redirectUri ||
    !verifyPkce(codeVerifier, consumed.codeChallenge)
  ) {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }

  const pair = await issueTokenPair(
    deps.db,
    {
      userId: consumed.userId,
      clientId: consumed.clientId,
      scope: consumed.scope,
    },
    generateAccessToken,
    generateRefreshToken,
  );
  res.json({
    access_token: pair.accessToken,
    token_type: "Bearer",
    expires_in: Math.floor((pair.accessExpiresAt.getTime() - Date.now()) / 1000),
    refresh_token: pair.refreshToken,
    scope: consumed.scope,
  });
}

async function handleRefreshGrant(
  req: Request,
  res: Response,
  deps: OAuthDeps,
): Promise<void> {
  const refreshToken =
    typeof req.body?.refresh_token === "string" ? req.body.refresh_token : null;
  if (!refreshToken) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }
  try {
    const pair = await rotateRefreshToken(
      deps.db,
      refreshToken,
      generateAccessToken,
      generateRefreshToken,
    );
    res.json({
      access_token: pair.accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(
        (pair.accessExpiresAt.getTime() - Date.now()) / 1000,
      ),
      refresh_token: pair.refreshToken,
      scope: pair.scope,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "invalid_grant") {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    throw err;
  }
}

function stringQuery(req: Request, name: string): string | null {
  const v = req.query[name];
  return typeof v === "string" && v.length > 0 ? v : null;
}

// Export the access-token resolver path for use by the MCP dispatch
// layer (Phase 6).
export { resolveAccessToken };
