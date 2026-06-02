import { describe, expect, it } from "vitest";

import {
  assertAllowedDomain,
  identityFromClaims,
  isAllowedDomain,
  loadAzureConfig,
} from "../azure.js";

describe("loadAzureConfig", () => {
  const baseEnv = {
    AZURE_AD_TENANT_ID: "tenant-uuid",
    AZURE_AD_SSO_CLIENT_ID: "client-uuid",
    AZURE_AD_SSO_CLIENT_SECRET: "secret",
  };

  it("returns config when all required vars are present", () => {
    expect(loadAzureConfig(baseEnv)).toEqual({
      tenantId: "tenant-uuid",
      clientId: "client-uuid",
      clientSecret: "secret",
      allowedDomain: "mossbuildinganddesign.com",
    });
  });

  it("respects MCP_ALLOWED_EMAIL_DOMAIN override", () => {
    expect(
      loadAzureConfig({
        ...baseEnv,
        MCP_ALLOWED_EMAIL_DOMAIN: "example.com",
      }).allowedDomain,
    ).toBe("example.com");
  });

  it("throws when AZURE_AD_TENANT_ID missing", () => {
    const { AZURE_AD_TENANT_ID: _drop, ...rest } = baseEnv;
    expect(() => loadAzureConfig(rest)).toThrow(/TENANT_ID/);
  });

  it("throws when AZURE_AD_SSO_CLIENT_ID missing", () => {
    const { AZURE_AD_SSO_CLIENT_ID: _drop, ...rest } = baseEnv;
    expect(() => loadAzureConfig(rest)).toThrow(/CLIENT_ID/);
  });

  it("throws when AZURE_AD_SSO_CLIENT_SECRET missing", () => {
    const { AZURE_AD_SSO_CLIENT_SECRET: _drop, ...rest } = baseEnv;
    expect(() => loadAzureConfig(rest)).toThrow(/CLIENT_SECRET/);
  });
});

describe("identityFromClaims", () => {
  it("extracts sub + email + name from valid claims", () => {
    expect(
      identityFromClaims({
        sub: "abc123",
        email: "Alice@Moss.example",
        name: "Alice Smith",
      }),
    ).toEqual({
      sub: "abc123",
      email: "alice@moss.example",
      name: "Alice Smith",
      claims: {
        sub: "abc123",
        email: "Alice@Moss.example",
        name: "Alice Smith",
      },
    });
  });

  it("falls back to preferred_username when no email claim", () => {
    expect(
      identityFromClaims({
        sub: "x",
        preferred_username: "Bob@example.com",
      }).email,
    ).toBe("bob@example.com");
  });

  it("returns null name when not present", () => {
    expect(
      identityFromClaims({ sub: "x", email: "a@b.com" }).name,
    ).toBeNull();
  });

  it("throws when sub is missing", () => {
    expect(() =>
      identityFromClaims({ email: "a@b.com" }),
    ).toThrow(/sub/);
  });

  it("throws when no email-like claim is present", () => {
    expect(() => identityFromClaims({ sub: "x" })).toThrow(/email/);
  });
});

describe("isAllowedDomain / assertAllowedDomain", () => {
  it("matches on case-insensitive domain", () => {
    expect(
      isAllowedDomain("p@MossBuildingAndDesign.com", "mossbuildinganddesign.com"),
    ).toBe(true);
  });

  it("rejects different domain", () => {
    expect(isAllowedDomain("p@example.com", "mossbuildinganddesign.com")).toBe(false);
  });

  it("rejects emails without an @", () => {
    expect(isAllowedDomain("not-an-email", "moss.example")).toBe(false);
  });

  it("assertAllowedDomain throws with a helpful message", () => {
    expect(() => assertAllowedDomain("p@evil.com", "mossbuildinganddesign.com")).toThrow(
      /mossbuildinganddesign\.com/,
    );
  });
});
