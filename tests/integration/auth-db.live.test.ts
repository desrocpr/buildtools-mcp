/**
 * Live auth data-layer round-trips against the real Supabase project.
 *
 * This is the "live probe" the repo convention prefers for the DB layer over
 * builder mocks — codified as a repeatable, self-cleaning test. It is SKIPPED
 * in hermetic CI (no `SUPABASE_URL`) and runs locally / in a nightly via:
 *
 *   doppler run --project buildtools-mcp --config prd -- npm test
 *
 * Every test creates uniquely-named throwaway rows and deletes them in a
 * `finally`, so a partial failure never leaves residue.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb, type Db } from "../../src/auth/db.js";
import {
  createServiceUser,
  getUserWithRoles,
  setUserStatus,
  removeRoleByName,
  assignRoleByName,
} from "../../src/auth/users.js";
import {
  createServiceTokenRow,
  resolveServiceToken,
  revokeServiceToken,
} from "../../src/auth/service-tokens.js";
import {
  registerClient,
  createAuthCode,
  consumeAuthCode,
  issueTokenPair,
  resolveAccessToken,
  rotateRefreshToken,
  revokeToken,
} from "../../src/auth/oauth-store.js";
import { generateAccessToken, generateRefreshToken } from "../../src/auth/tokens.js";
import {
  upsertServiceCredentials,
  getServiceCredentials,
  deleteServiceCredentials,
} from "../../src/auth/credentials.js";
import { randomBytes } from "node:crypto";

const LIVE = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
const uniq = (p: string) => `test-${p}-${randomBytes(6).toString("hex")}`;

describe.skipIf(!LIVE)("auth data layer — live Supabase round-trips", () => {
  let db: Db;
  const createdUsers: string[] = [];

  beforeAll(() => {
    db = createDb();
  });
  afterAll(async () => {
    for (const id of createdUsers) {
      await db.from("mcp_service_tokens").delete().eq("user_id", id);
      await db.from("mcp_service_credentials").delete().eq("user_id", id);
      await db.from("mcp_user_roles").delete().eq("user_id", id);
      await db.from("mcp_users").delete().eq("id", id);
    }
  });

  async function newServiceUser(role = "viewer") {
    const u = await createServiceUser(db, `${uniq("u")}@example.invalid`, "live-test", role);
    createdUsers.push(u.id);
    return u;
  }

  it("service token: create → resolve → revoke → resolve=null", async () => {
    const u = await newServiceUser();
    const issued = await createServiceTokenRow(db, { userId: u.id, displayName: "live" });
    const resolved = await resolveServiceToken(db, issued.token);
    expect(resolved).toMatchObject({ userId: u.id, tokenId: issued.tokenId });
    await revokeServiceToken(db, issued.tokenId);
    expect(await resolveServiceToken(db, issued.token)).toBeNull();
  });

  it("user roles: createServiceUser assigns the role and getUserWithRoles unions permissions", async () => {
    const u = await newServiceUser("editor");
    const withRoles = await getUserWithRoles(db, u.id);
    expect(withRoles?.roles.map((r) => r.name)).toContain("editor");
    expect(withRoles?.permissions).toContain("write:tasks");
    // add viewer too, permissions stay deduped
    await assignRoleByName(db, u.id, "viewer");
    const after = await getUserWithRoles(db, u.id);
    expect(after?.permissions.filter((p) => p === "read")).toHaveLength(1);
    await removeRoleByName(db, u.id, "viewer");
  });

  it("revoked user status: setUserStatus persists", async () => {
    const u = await newServiceUser();
    await setUserStatus(db, u.id, "revoked");
    const after = await getUserWithRoles(db, u.id);
    expect(after?.status).toBe("revoked");
  });

  it("credentials round-trip against real bytea", async () => {
    const key = randomBytes(32);
    const u = await newServiceUser();
    const creds = { email: "svc@example.invalid", password: uniq("pw") };
    try {
      await upsertServiceCredentials(db, u.id, "buildtools", creds, key);
      expect(await getServiceCredentials(db, u.id, "buildtools", key)).toEqual(creds);
    } finally {
      await deleteServiceCredentials(db, u.id, "buildtools");
    }
  });

  it("token pair: issue → resolve access → rotate refresh (old refresh dies) → revoke access", async () => {
    const u = await newServiceUser();
    const client = await registerClient(db, { redirectUris: ["https://example.invalid/cb"] });
    try {
      const pair = await issueTokenPair(
        db,
        { userId: u.id, clientId: client.clientId, scope: "mcp" },
        generateAccessToken,
        generateRefreshToken,
      );
      // Access token resolves to the user.
      const resolved = await resolveAccessToken(db, pair.accessToken);
      expect(resolved?.userId).toBe(u.id);

      // Rotating the refresh token mints a new pair and invalidates the old refresh.
      const rotated = await rotateRefreshToken(
        db,
        pair.refreshToken,
        generateAccessToken,
        generateRefreshToken,
      );
      expect(rotated.accessToken).not.toBe(pair.accessToken);
      await expect(
        rotateRefreshToken(db, pair.refreshToken, generateAccessToken, generateRefreshToken),
      ).rejects.toThrow(/invalid_grant/);

      // Revoking an access token makes it stop resolving.
      await revokeToken(db, rotated.accessToken);
      expect(await resolveAccessToken(db, rotated.accessToken)).toBeNull();
    } finally {
      await db.from("mcp_oauth_tokens").delete().eq("user_id", u.id);
      await db.from("mcp_oauth_clients").delete().eq("client_id", client.clientId);
    }
  });

  it("oauth authorization code is single-use (OAuth 2.1 replay protection)", async () => {
    const u = await newServiceUser();
    const client = await registerClient(db, { redirectUris: ["https://example.invalid/cb"] });
    const { code } = await createAuthCode(db, {
      userId: u.id,
      clientId: client.clientId,
      redirectUri: "https://example.invalid/cb",
      codeChallenge: "x".repeat(43),
    });
    try {
      const first = await consumeAuthCode(db, code);
      expect(first).toMatchObject({ userId: u.id, clientId: client.clientId });
      // Replay must fail.
      expect(await consumeAuthCode(db, code)).toBeNull();
    } finally {
      await db.from("mcp_oauth_codes").delete().eq("client_id", client.clientId);
      await db.from("mcp_oauth_clients").delete().eq("client_id", client.clientId);
    }
  });
});
