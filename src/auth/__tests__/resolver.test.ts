import { describe, expect, it, vi } from "vitest";

import { resolveBearer } from "../resolver.js";

function fakeDb(): import("../db.js").Db {
  // The resolver only touches `db` via methods exposed by other modules
  // (resolveAccessToken etc.), which we'll mock via vi.mock below. We
  // pass a noop sentinel for the actual db object.
  return {} as unknown as import("../db.js").Db;
}

vi.mock("../oauth-store.js", () => ({
  resolveAccessToken: vi.fn(),
  touchTokenLastUsed: vi.fn(),
}));
vi.mock("../service-tokens.js", () => ({
  resolveServiceToken: vi.fn(),
  touchServiceTokenLastUsed: vi.fn(),
}));
vi.mock("../users.js", () => ({
  getUserWithRoles: vi.fn(),
  touchLastSeen: vi.fn(),
}));

import { resolveAccessToken } from "../oauth-store.js";
import { resolveServiceToken } from "../service-tokens.js";
import { getUserWithRoles } from "../users.js";

const aliceUser = {
  id: "u-alice",
  kind: "human" as const,
  azureSub: "azure-alice",
  email: "alice@example.com",
  displayName: "Alice",
  status: "active" as const,
  createdAt: new Date(),
  lastSeenAt: null,
  roles: [{ id: "r-viewer", name: "viewer", permissions: ["read"] }],
  permissions: ["read"],
};

const harnessUser = {
  ...aliceUser,
  id: "u-harness",
  kind: "service" as const,
  azureSub: null,
  email: "harness@example.invalid",
  displayName: "harness",
  roles: [{ id: "r-harness", name: "harness", permissions: ["read", "write:*"] }],
  permissions: ["read", "write:*"],
};

describe("resolveBearer — OAuth access token (mcpa_)", () => {
  it("returns a human AuthContext when the token resolves", async () => {
    vi.mocked(resolveAccessToken).mockResolvedValueOnce({
      tokenId: "tok-1",
      userId: "u-alice",
      clientId: "client-1",
      scope: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    vi.mocked(getUserWithRoles).mockResolvedValueOnce(aliceUser);

    const ctx = await resolveBearer("mcpa_abc", { db: fakeDb() });
    expect(ctx).toMatchObject({
      kind: "human",
      tokenId: "tok-1",
      tokenKind: "oauth-access",
    });
    expect(ctx?.user?.email).toBe("alice@example.com");
  });

  it("returns null when the token has expired or is unknown", async () => {
    vi.mocked(resolveAccessToken).mockResolvedValueOnce(null);
    expect(await resolveBearer("mcpa_xyz", { db: fakeDb() })).toBeNull();
  });

  it("returns null when the bound user is revoked", async () => {
    vi.mocked(resolveAccessToken).mockResolvedValueOnce({
      tokenId: "tok-1",
      userId: "u-alice",
      clientId: null,
      scope: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    vi.mocked(getUserWithRoles).mockResolvedValueOnce({
      ...aliceUser,
      status: "revoked",
    });
    expect(await resolveBearer("mcpa_abc", { db: fakeDb() })).toBeNull();
  });
});

describe("resolveBearer — service token (mcps_)", () => {
  it("returns a service AuthContext when the token resolves", async () => {
    vi.mocked(resolveServiceToken).mockResolvedValueOnce({
      tokenId: "svc-1",
      userId: "u-harness",
    });
    vi.mocked(getUserWithRoles).mockResolvedValueOnce(harnessUser);

    const ctx = await resolveBearer("mcps_abc", { db: fakeDb() });
    expect(ctx).toMatchObject({
      kind: "service",
      tokenId: "svc-1",
      tokenKind: "service",
    });
    expect(ctx?.user?.kind).toBe("service");
  });

  it("returns null for unknown service token", async () => {
    vi.mocked(resolveServiceToken).mockResolvedValueOnce(null);
    expect(await resolveBearer("mcps_xyz", { db: fakeDb() })).toBeNull();
  });
});

describe("resolveBearer — legacy bearer", () => {
  it("returns a legacy AuthContext on constant-time match", async () => {
    const ctx = await resolveBearer("classic-bearer-value", {
      db: fakeDb(),
      legacyBearer: "classic-bearer-value",
    });
    expect(ctx).toEqual({
      kind: "legacy",
      user: null,
      tokenId: null,
      tokenKind: null,
    });
  });

  it("rejects mismatching legacy bearer", async () => {
    expect(
      await resolveBearer("nope", {
        db: fakeDb(),
        legacyBearer: "classic-bearer-value",
      }),
    ).toBeNull();
  });

  it("returns null when legacy bearer is not configured", async () => {
    expect(
      await resolveBearer("anything-no-prefix", { db: fakeDb() }),
    ).toBeNull();
  });

  it("returns null on empty bearer", async () => {
    expect(await resolveBearer("", { db: fakeDb() })).toBeNull();
  });
});
