/**
 * Unit tests for session owner-binding + the per-request auth context
 * (MOS-631 follow-up).
 *
 * `sessionOwnerKey` + `SessionStore.setOwner/getOwner` are the boundary that
 * lets `/messages` reject a request whose bearer resolves to a different
 * principal than the one that opened the session — closing the cross-session
 * message-injection path. `runWithRequestAuth/currentRequestAuth` carry the
 * live request identity into the MCP handlers (replacing the mutable snapshot).
 */
import { describe, it, expect } from "vitest";
import { SessionStore, sessionOwnerKey } from "../session-store.js";
import { runWithRequestAuth, currentRequestAuth } from "../request-context.js";
import type { AuthContext } from "../../auth/resolver.js";

const human = (id: string) => ({ kind: "human", user: { id } });
const service = (id: string) => ({ kind: "service", user: { id } });
const legacy = { kind: "legacy", user: null };
// The ALS store is opaque (identity in, identity out); cast the minimal
// fixtures to AuthContext for the typed `runWithRequestAuth` boundary.
const asAuth = (v: unknown) => v as unknown as AuthContext;

describe("sessionOwnerKey", () => {
  it("keys OAuth/service identities on the user id", () => {
    expect(sessionOwnerKey(human("u1"))).toBe("u:u1");
    expect(sessionOwnerKey(service("svc1"))).toBe("u:svc1");
  });

  it("collapses all legacy-bearer callers to one shared key", () => {
    expect(sessionOwnerKey(legacy)).toBe("legacy");
  });

  it("returns null when there is no identity to bind", () => {
    expect(sessionOwnerKey(undefined)).toBeNull();
    expect(sessionOwnerKey({ kind: "human", user: null })).toBeNull();
  });

  it("distinguishes principals so a mismatch is detectable", () => {
    // The /messages guard compares these keys; different users must differ,
    // and an OAuth identity must never equal the legacy key.
    expect(sessionOwnerKey(human("victim"))).not.toBe(sessionOwnerKey(human("attacker")));
    expect(sessionOwnerKey(human("u1"))).not.toBe(sessionOwnerKey(legacy));
  });
});

describe("SessionStore owner-binding round-trip", () => {
  it("stores, returns, and clears the owner key", () => {
    const store = new SessionStore();
    expect(store.getOwner("s1")).toBeUndefined(); // unbound → no enforcement
    store.setOwner("s1", "u:u1");
    expect(store.getOwner("s1")).toBe("u:u1");
    store.delete("s1");
    expect(store.getOwner("s1")).toBeUndefined();
  });
});

describe("request-context (AsyncLocalStorage)", () => {
  it("exposes the request auth inside the scope and nothing outside it", () => {
    expect(currentRequestAuth()).toBeUndefined();
    const ctx = asAuth(human("u1"));
    const inside = runWithRequestAuth(ctx, () => currentRequestAuth());
    expect(inside).toBe(ctx);
    expect(currentRequestAuth()).toBeUndefined();
  });

  it("propagates the context across awaits within the scope", async () => {
    const ctx = asAuth(human("u2"));
    const seen = await runWithRequestAuth(ctx, async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      return currentRequestAuth();
    });
    expect(seen).toBe(ctx);
  });
});
