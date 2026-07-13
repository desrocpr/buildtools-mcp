/**
 * PKCE S256 verification (MOS-328). Pure crypto — no DB. Security-critical:
 * a broken verifier check would let an intercepted auth code be redeemed
 * without the matching code_verifier.
 */
import { describe, it, expect } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { verifyPkce } from "../oauth-store.js";

const challengeFor = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

describe("verifyPkce (S256)", () => {
  it("accepts the verifier whose SHA-256 base64url matches the challenge", () => {
    const verifier = randomBytes(32).toString("base64url");
    expect(verifyPkce(verifier, challengeFor(verifier))).toBe(true);
  });

  it("rejects a wrong verifier", () => {
    const verifier = randomBytes(32).toString("base64url");
    expect(verifyPkce("not-the-verifier", challengeFor(verifier))).toBe(false);
  });

  it("rejects when the challenge is base64 (with padding) instead of base64url", () => {
    const verifier = "abc123";
    const b64 = createHash("sha256").update(verifier).digest("base64"); // + / = chars
    // Only base64url-no-pad must verify; the plain base64 form must not.
    expect(verifyPkce(verifier, b64)).toBe(false);
    expect(verifyPkce(verifier, challengeFor(verifier))).toBe(true);
  });

  it("is not fooled by an empty challenge", () => {
    expect(verifyPkce("anything", "")).toBe(false);
  });
});
