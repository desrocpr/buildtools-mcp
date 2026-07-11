/**
 * Unit tests for the per-request session-auth refresh guard (MOS-631).
 *
 * `shouldRefreshSessionAuth` is the security boundary that lets an admin role
 * change take effect mid-session (the bug fixed in PR #87) WITHOUT letting a
 * request bearing a different — or legacy — token overwrite another session's
 * identity and strip its RBAC/rate-limit enforcement.
 */
import { describe, it, expect } from "vitest";
import { SessionStore, shouldRefreshSessionAuth } from "../session-store.js";

const human = (id: string) => ({ kind: "human", user: { id } });
const service = (id: string) => ({ kind: "service", user: { id } });
const legacy = { kind: "legacy", user: null };

describe("shouldRefreshSessionAuth", () => {
  it("refreshes when the request resolves to the SAME user (the role-change fix)", () => {
    // Session opened as this user; a later request for the same user carries
    // freshly-resolved (e.g. newly-promoted) permissions — must be applied.
    expect(shouldRefreshSessionAuth(human("u1"), human("u1"))).toBe(true);
  });

  it("refreshes same-user service (harness) sessions too", () => {
    expect(shouldRefreshSessionAuth(service("svc1"), service("svc1"))).toBe(true);
  });

  it("does NOT let a different user overwrite the session's identity", () => {
    // Cross-session overwrite: attacker's token + victim's sessionId.
    expect(shouldRefreshSessionAuth(human("victim"), human("attacker"))).toBe(false);
  });

  it("does NOT apply a legacy context (would strip RBAC + rate limiting)", () => {
    expect(shouldRefreshSessionAuth(human("u1"), legacy)).toBe(false);
  });

  it("does NOT establish identity on a session that has none yet", () => {
    // Identity is pinned at connect time by /sse; this guard only refreshes,
    // never bootstraps or upgrades an unidentified/legacy session.
    expect(shouldRefreshSessionAuth(legacy, human("u1"))).toBe(false);
    expect(shouldRefreshSessionAuth(undefined, human("u1"))).toBe(false);
  });

  it("ignores an absent or identity-less incoming context", () => {
    expect(shouldRefreshSessionAuth(human("u1"), undefined)).toBe(false);
    expect(shouldRefreshSessionAuth(human("u1"), { kind: "human", user: null })).toBe(false);
    expect(shouldRefreshSessionAuth(human("u1"), { kind: "human", user: { id: "" } })).toBe(false);
  });
});

describe("SessionStore auth round-trip", () => {
  it("stores and returns the auth context the guard relies on, and clears it on delete", () => {
    const store = new SessionStore();
    const ctx = human("u1");
    store.setAuth("sess-a", ctx);
    expect(store.getAuth("sess-a")).toEqual(ctx);
    // A refresh for the same user replaces the stored permissions.
    const promoted = { kind: "human", user: { id: "u1", permissions: ["read", "write:budget"] } };
    store.setAuth("sess-a", promoted);
    expect(store.getAuth("sess-a")).toEqual(promoted);
    store.delete("sess-a");
    expect(store.getAuth("sess-a")).toBeUndefined();
  });
});
