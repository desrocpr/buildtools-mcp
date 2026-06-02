import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { csrfHiddenInput, csrfTokenFor, verifyCsrfToken } from "../csrf.js";

const KEY = randomBytes(32);

describe("csrfTokenFor", () => {
  it("is deterministic for the same (userId, key)", () => {
    const userId = "abc-123";
    expect(csrfTokenFor(userId, KEY)).toBe(csrfTokenFor(userId, KEY));
  });

  it("differs across users", () => {
    expect(csrfTokenFor("a", KEY)).not.toBe(csrfTokenFor("b", KEY));
  });

  it("differs across keys", () => {
    const other = randomBytes(32);
    expect(csrfTokenFor("a", KEY)).not.toBe(csrfTokenFor("a", other));
  });
});

describe("verifyCsrfToken", () => {
  it("accepts a token derived from the same (userId, key)", () => {
    const token = csrfTokenFor("alice", KEY);
    expect(verifyCsrfToken(token, "alice", KEY)).toBe(true);
  });

  it("rejects a token derived for a different user", () => {
    const token = csrfTokenFor("alice", KEY);
    expect(verifyCsrfToken(token, "bob", KEY)).toBe(false);
  });

  it("rejects undefined/empty/wrong-shape inputs", () => {
    expect(verifyCsrfToken(undefined, "alice", KEY)).toBe(false);
    expect(verifyCsrfToken(null, "alice", KEY)).toBe(false);
    expect(verifyCsrfToken("", "alice", KEY)).toBe(false);
    expect(verifyCsrfToken("not-a-token", "alice", KEY)).toBe(false);
  });
});

describe("csrfHiddenInput", () => {
  it("renders an <input type=hidden> with the token value", () => {
    const token = csrfTokenFor("u1", KEY);
    expect(csrfHiddenInput(token)).toBe(
      `<input type="hidden" name="_csrf" value="${token}">`,
    );
  });
});
