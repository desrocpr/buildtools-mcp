import { describe, expect, it } from "vitest";

import {
  ACCESS_TOKEN_PREFIX,
  REFRESH_TOKEN_PREFIX,
  SERVICE_TOKEN_PREFIX,
  detectTokenKind,
  generateAccessToken,
  generateRefreshToken,
  generateServiceToken,
  hashToken,
  parseBearerHeader,
} from "../tokens.js";

describe("token generation", () => {
  it("service tokens are prefixed mcps_", () => {
    const { token } = generateServiceToken();
    expect(token.startsWith(SERVICE_TOKEN_PREFIX)).toBe(true);
  });

  it("access tokens are prefixed mcpa_", () => {
    const { token } = generateAccessToken();
    expect(token.startsWith(ACCESS_TOKEN_PREFIX)).toBe(true);
  });

  it("refresh tokens are prefixed mcpr_", () => {
    const { token } = generateRefreshToken();
    expect(token.startsWith(REFRESH_TOKEN_PREFIX)).toBe(true);
  });

  it("returns a hash whose hex length is 64", () => {
    const { hash } = generateServiceToken();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("two generated tokens are not equal (256 bits of entropy)", () => {
    const a = generateServiceToken().token;
    const b = generateServiceToken().token;
    expect(a).not.toBe(b);
  });

  it("hash matches hashToken(token)", () => {
    const { token, hash } = generateAccessToken();
    expect(hashToken(token)).toBe(hash);
  });

  it("body has at least 32 base64url characters past the prefix", () => {
    const { token } = generateServiceToken();
    const body = token.slice(SERVICE_TOKEN_PREFIX.length);
    expect(body.length).toBeGreaterThanOrEqual(32);
    expect(body).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("hashToken", () => {
  it("is deterministic", () => {
    expect(hashToken("hello")).toBe(hashToken("hello"));
  });

  it("differs for different inputs", () => {
    expect(hashToken("hello")).not.toBe(hashToken("world"));
  });
});

describe("detectTokenKind", () => {
  it("classifies service tokens", () => {
    expect(detectTokenKind(generateServiceToken().token)).toBe("service");
  });

  it("classifies access tokens", () => {
    expect(detectTokenKind(generateAccessToken().token)).toBe("access");
  });

  it("classifies refresh tokens", () => {
    expect(detectTokenKind(generateRefreshToken().token)).toBe("refresh");
  });

  it("returns 'unknown' for legacy bearer tokens", () => {
    expect(detectTokenKind("some-random-legacy-token")).toBe("unknown");
  });

  it("returns 'unknown' for empty string", () => {
    expect(detectTokenKind("")).toBe("unknown");
  });
});

describe("parseBearerHeader", () => {
  it("extracts the token from a well-formed header", () => {
    expect(parseBearerHeader("Bearer abc123")).toBe("abc123");
  });

  it("is case-insensitive on 'Bearer'", () => {
    expect(parseBearerHeader("bearer abc")).toBe("abc");
    expect(parseBearerHeader("BEARER abc")).toBe("abc");
  });

  it("returns null for an empty header", () => {
    expect(parseBearerHeader("")).toBeNull();
    expect(parseBearerHeader(null)).toBeNull();
    expect(parseBearerHeader(undefined)).toBeNull();
  });

  it("returns null for a non-Bearer scheme", () => {
    expect(parseBearerHeader("Basic dXNlcjpwYXNz")).toBeNull();
  });

  it("returns null when missing the token after 'Bearer'", () => {
    expect(parseBearerHeader("Bearer")).toBeNull();
    expect(parseBearerHeader("Bearer ")).toBeNull();
  });
});
