/**
 * OAuth 2.1 endpoint handlers (MOS-328). Mounts the real routes in-process and
 * mocks ONLY the DB-touching store functions (keeping the real `verifyPkce`),
 * so these tests exercise the protocol logic that matters — request validation,
 * PKCE verification, client/redirect matching, single-use error mapping, and
 * response shaping — without a live Supabase or Azure. The store itself is
 * covered by the env-gated live suite.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";

vi.mock("../../auth/oauth-store.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual, // keep the real verifyPkce, createAuthCode, etc.
    consumeAuthCode: vi.fn(),
    registerClient: vi.fn(),
    issueTokenPair: vi.fn(),
    rotateRefreshToken: vi.fn(),
    revokeToken: vi.fn(),
  };
});

import { mountOAuthRoutes } from "../oauth.js";
import {
  consumeAuthCode,
  registerClient,
  issueTokenPair,
  rotateRefreshToken,
  revokeToken,
} from "../../auth/oauth-store.js";

const challengeFor = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  const router = express.Router();
  mountOAuthRoutes(router, {
    db: {} as never,
    encryptionKey: randomBytes(32),
    azure: {} as never,
    azureDiscovery: {} as never,
    publicOrigin: "https://mcp.test",
  });
  app.use(router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});
afterAll(() => server?.close());
beforeEach(() => vi.clearAllMocks());

const postJson = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("GET /.well-known/oauth-authorization-server", () => {
  it("advertises the endpoints, PKCE S256, and public-client auth", async () => {
    const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const meta = await res.json();
    expect(meta.issuer).toBe("https://mcp.test");
    expect(meta.token_endpoint).toBe("https://mcp.test/oauth/token");
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.token_endpoint_auth_methods_supported).toEqual(["none"]);
  });
});

describe("POST /oauth/register", () => {
  it("400s when redirect_uris is missing", async () => {
    const res = await postJson("/oauth/register", { client_name: "x" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_redirect_uri");
  });

  it("registers a public client and echoes it back", async () => {
    vi.mocked(registerClient).mockResolvedValueOnce({
      clientId: "mcpc_abc",
      clientName: "Claude",
      redirectUris: ["https://claude.test/cb"],
      grantTypes: ["authorization_code", "refresh_token"],
      tokenEndpointAuthMethod: "none",
      scope: "mcp",
      createdAt: new Date(),
    });
    const res = await postJson("/oauth/register", {
      client_name: "Claude",
      redirect_uris: ["https://claude.test/cb"],
    });
    expect(res.status).toBe(201);
    expect((await res.json()).client_id).toBe("mcpc_abc");
  });
});

describe("POST /oauth/token — authorization_code grant", () => {
  const good = {
    grant_type: "authorization_code",
    code: "the-code",
    code_verifier: "verifier-1234567890",
    client_id: "mcpc_abc",
    redirect_uri: "https://claude.test/cb",
  };

  it("400 invalid_request when a required field is missing", async () => {
    const res = await postJson("/oauth/token", { ...good, code_verifier: undefined });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_request");
  });

  it("400 invalid_grant when the code is unknown/used/expired", async () => {
    vi.mocked(consumeAuthCode).mockResolvedValueOnce(null);
    const res = await postJson("/oauth/token", good);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("400 invalid_grant when the PKCE verifier does not match", async () => {
    vi.mocked(consumeAuthCode).mockResolvedValueOnce({
      userId: "u1",
      clientId: good.client_id,
      redirectUri: good.redirect_uri,
      scope: "mcp",
      codeChallenge: challengeFor("a-DIFFERENT-verifier"),
    });
    const res = await postJson("/oauth/token", good);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("400 invalid_grant when the client_id or redirect_uri does not match the code", async () => {
    vi.mocked(consumeAuthCode).mockResolvedValueOnce({
      userId: "u1",
      clientId: "someone-else",
      redirectUri: good.redirect_uri,
      scope: "mcp",
      codeChallenge: challengeFor(good.code_verifier),
    });
    const res = await postJson("/oauth/token", good);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("issues an access+refresh pair on a valid PKCE exchange", async () => {
    vi.mocked(consumeAuthCode).mockResolvedValueOnce({
      userId: "u1",
      clientId: good.client_id,
      redirectUri: good.redirect_uri,
      scope: "mcp",
      codeChallenge: challengeFor(good.code_verifier),
    });
    vi.mocked(issueTokenPair).mockResolvedValueOnce({
      accessToken: "mcpa_access",
      refreshToken: "mcpr_refresh",
      accessTokenId: "at1",
      refreshTokenId: "rt1",
      accessExpiresAt: new Date(Date.now() + 3600_000),
      refreshExpiresAt: new Date(Date.now() + 30 * 86400_000),
    });
    const res = await postJson("/oauth/token", good);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      access_token: "mcpa_access",
      token_type: "Bearer",
      refresh_token: "mcpr_refresh",
      scope: "mcp",
    });
    expect(body.expires_in).toBeGreaterThan(0);
  });
});

describe("POST /oauth/token — refresh_token grant", () => {
  it("unsupported_grant_type for an unknown grant", async () => {
    const res = await postJson("/oauth/token", { grant_type: "password" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unsupported_grant_type");
  });

  it("maps a rotation invalid_grant to a 400", async () => {
    vi.mocked(rotateRefreshToken).mockRejectedValueOnce(new Error("invalid_grant"));
    const res = await postJson("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: "stale",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("rotates and returns a new pair", async () => {
    vi.mocked(rotateRefreshToken).mockResolvedValueOnce({
      accessToken: "mcpa_new",
      refreshToken: "mcpr_new",
      accessTokenId: "at2",
      refreshTokenId: "rt2",
      accessExpiresAt: new Date(Date.now() + 3600_000),
      refreshExpiresAt: new Date(Date.now() + 30 * 86400_000),
      scope: "mcp",
    } as never);
    const res = await postJson("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: "valid",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).access_token).toBe("mcpa_new");
  });
});

describe("POST /oauth/revoke", () => {
  it("400 invalid_request without a token", async () => {
    const res = await postJson("/oauth/revoke", {});
    expect(res.status).toBe(400);
  });
  it("revokes and returns {revoked:true}", async () => {
    vi.mocked(revokeToken).mockResolvedValueOnce(undefined);
    const res = await postJson("/oauth/revoke", { token: "mcpa_x" });
    expect(res.status).toBe(200);
    expect((await res.json()).revoked).toBe(true);
    expect(revokeToken).toHaveBeenCalledWith(expect.anything(), "mcpa_x");
  });
});
