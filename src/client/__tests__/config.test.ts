/**
 * Tests for `loadConfigFromEnv()`.
 *
 * These tests mutate `process.env` and so must save/restore the three target
 * vars around each `it` block (we use a small per-test snapshot rather than
 * touching unrelated env entries).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfigFromEnv, type BuildToolsConfig } from "../config.js";

const VARS = [
  "BUILDTOOLS_TENANT",
  "BUILDTOOLS_USERNAME",
  "BUILDTOOLS_PASSWORD",
] as const;

describe("loadConfigFromEnv()", () => {
  const snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const v of VARS) {
      snapshot[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const v of VARS) {
      if (snapshot[v] === undefined) delete process.env[v];
      else process.env[v] = snapshot[v];
    }
  });

  it("returns a fully-resolved config when all three vars are set", () => {
    process.env.BUILDTOOLS_TENANT = "moss";
    process.env.BUILDTOOLS_USERNAME = "paul@example.com";
    process.env.BUILDTOOLS_PASSWORD = "hunter2";

    const cfg: BuildToolsConfig = loadConfigFromEnv();
    expect(cfg.tenant).toBe("moss");
    expect(cfg.username).toBe("paul@example.com");
    expect(cfg.password).toBe("hunter2");
    expect(cfg.baseUrl).toBe("https://moss.buildtools.app");
    expect(cfg.sessionTimeoutMinutes).toBe(30);
  });

  it("derives baseUrl from tenant", () => {
    process.env.BUILDTOOLS_TENANT = "acme";
    process.env.BUILDTOOLS_USERNAME = "u";
    process.env.BUILDTOOLS_PASSWORD = "p";
    const cfg = loadConfigFromEnv();
    expect(cfg.baseUrl).toBe("https://acme.buildtools.app");
  });

  it("throws with per-user-config substrings when BUILDTOOLS_TENANT is missing", () => {
    process.env.BUILDTOOLS_USERNAME = "u";
    process.env.BUILDTOOLS_PASSWORD = "p";
    // No BUILDTOOLS_TENANT.
    try {
      loadConfigFromEnv();
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as Error;
      expect(e).toBeInstanceOf(Error);
      // Both required substrings per the spec's documentation requirement.
      expect(e.message).toContain("YOUR claude_desktop_config.json");
      expect(e.message).toContain("do NOT share credentials");
      // Surfaces which var(s) are missing (by NAME — never by value).
      expect(e.message).toContain("BUILDTOOLS_TENANT");
      // Must NOT echo any credential values.
      expect(e.message).not.toContain("hunter2");
    }
  });

  it("throws when BUILDTOOLS_USERNAME is missing", () => {
    process.env.BUILDTOOLS_TENANT = "moss";
    process.env.BUILDTOOLS_PASSWORD = "p";
    expect(() => loadConfigFromEnv()).toThrow(/BUILDTOOLS_USERNAME/);
  });

  it("throws when BUILDTOOLS_PASSWORD is missing", () => {
    process.env.BUILDTOOLS_TENANT = "moss";
    process.env.BUILDTOOLS_USERNAME = "u";
    expect(() => loadConfigFromEnv()).toThrow(/BUILDTOOLS_PASSWORD/);
  });

  it("treats empty-string env vars as missing", () => {
    process.env.BUILDTOOLS_TENANT = "";
    process.env.BUILDTOOLS_USERNAME = "u";
    process.env.BUILDTOOLS_PASSWORD = "p";
    expect(() => loadConfigFromEnv()).toThrow(/BUILDTOOLS_TENANT/);
  });

  it("lists ALL missing vars when several are unset", () => {
    // No vars set at all.
    try {
      loadConfigFromEnv();
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as Error;
      expect(e.message).toContain("BUILDTOOLS_TENANT");
      expect(e.message).toContain("BUILDTOOLS_USERNAME");
      expect(e.message).toContain("BUILDTOOLS_PASSWORD");
    }
  });
});
