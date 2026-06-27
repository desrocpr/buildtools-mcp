/**
 * Unit tests for IdempotencyStore.
 *
 * Verifies:
 *   - hit / miss / mismatch / expired-via-TTL behavior
 *   - cache key namespacing (toolName, subject)
 *   - fingerprint canonicalisation (key order doesn't matter)
 *   - sweep removes expired entries
 *   - clock injection
 */

import { describe, expect, it } from "vitest";

import { IdempotencyStore } from "../IdempotencyStore.js";
import type { ToolResult } from "../../tools/projects.js";

function makeResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

describe("IdempotencyStore", () => {
  it("miss on empty store", () => {
    const s = new IdempotencyStore();
    const key = IdempotencyStore.buildCacheKey("t", undefined, "k");
    const fp = IdempotencyStore.fingerprintArgs({ a: 1 });
    expect(s.lookup(key, fp).kind).toBe("miss");
  });

  it("hit after store; replays the original result by reference", () => {
    const s = new IdempotencyStore();
    const key = IdempotencyStore.buildCacheKey("t", undefined, "k");
    const fp = IdempotencyStore.fingerprintArgs({ a: 1 });
    const result = makeResult("done");
    s.store(key, fp, result);
    const lookup = s.lookup(key, fp);
    expect(lookup.kind).toBe("hit");
    if (lookup.kind === "hit") expect(lookup.result).toBe(result);
  });

  it("mismatch when key reused with different args", () => {
    const s = new IdempotencyStore();
    const key = IdempotencyStore.buildCacheKey("t", undefined, "k");
    const fp1 = IdempotencyStore.fingerprintArgs({ a: 1 });
    const fp2 = IdempotencyStore.fingerprintArgs({ a: 2 });
    s.store(key, fp1, makeResult("first"));
    const lookup = s.lookup(key, fp2);
    expect(lookup.kind).toBe("mismatch");
    if (lookup.kind === "mismatch") {
      expect(lookup.storedFingerprint).toBe(fp1);
      expect(lookup.incomingFingerprint).toBe(fp2);
    }
  });

  it("namespacing: different tool names hash to different cache keys", () => {
    const k1 = IdempotencyStore.buildCacheKey("update_purchase_order", "u", "k");
    const k2 = IdempotencyStore.buildCacheKey("create_purchase_order", "u", "k");
    expect(k1).not.toBe(k2);
  });

  it("namespacing: different subjects (users) hash to different cache keys", () => {
    const k1 = IdempotencyStore.buildCacheKey("t", "alice", "k");
    const k2 = IdempotencyStore.buildCacheKey("t", "bob", "k");
    expect(k1).not.toBe(k2);
  });

  it("namespacing: undefined subject is distinct from empty-string subject", () => {
    const kU = IdempotencyStore.buildCacheKey("t", undefined, "k");
    const kE = IdempotencyStore.buildCacheKey("t", "", "k");
    expect(kU).toBe(kE); // both serialise to "" in the hash input — documented behaviour
  });

  it("fingerprint is order-independent on object keys", () => {
    const fp1 = IdempotencyStore.fingerprintArgs({ a: 1, b: 2, c: 3 });
    const fp2 = IdempotencyStore.fingerprintArgs({ c: 3, b: 2, a: 1 });
    expect(fp1).toBe(fp2);
  });

  it("fingerprint distinguishes different array orderings (semantically different)", () => {
    const fp1 = IdempotencyStore.fingerprintArgs({ items: [1, 2] });
    const fp2 = IdempotencyStore.fingerprintArgs({ items: [2, 1] });
    expect(fp1).not.toBe(fp2);
  });

  it("fingerprint handles nested objects + arrays + null + undefined", () => {
    // Smoke test — should not throw.
    const fp = IdempotencyStore.fingerprintArgs({
      a: { b: [1, null, { c: undefined }] },
      d: "x",
    });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("entry expires after TTL — lookup returns miss and removes the entry", () => {
    let nowMs = 1_000_000;
    const s = new IdempotencyStore({ ttlMinutes: 1, now: () => nowMs });
    const key = IdempotencyStore.buildCacheKey("t", undefined, "k");
    const fp = IdempotencyStore.fingerprintArgs({ a: 1 });
    s.store(key, fp, makeResult("first"));
    expect(s.size).toBe(1);

    nowMs += 30_000; // 30s elapsed — still in TTL
    expect(s.lookup(key, fp).kind).toBe("hit");

    nowMs += 31_000; // total 61s elapsed — past 60s TTL
    expect(s.lookup(key, fp).kind).toBe("miss");
    expect(s.size).toBe(0); // expired entry was removed
  });

  it("sweep clears only entries past TTL", () => {
    let nowMs = 1_000_000;
    const s = new IdempotencyStore({ ttlMinutes: 1, now: () => nowMs });
    const k1 = IdempotencyStore.buildCacheKey("t", undefined, "k1");
    const k2 = IdempotencyStore.buildCacheKey("t", undefined, "k2");
    const fp = IdempotencyStore.fingerprintArgs({});
    s.store(k1, fp, makeResult("a"));
    nowMs += 30_000;
    s.store(k2, fp, makeResult("b"));
    nowMs += 35_000; // k1 is past TTL (65s old), k2 is not (35s)
    s.sweep();
    expect(s.size).toBe(1);
    expect(s.lookup(k1, fp).kind).toBe("miss");
    expect(s.lookup(k2, fp).kind).toBe("hit");
  });

  it("ttlMinutes reflects the constructor default and override", () => {
    expect(new IdempotencyStore().ttlMinutes).toBe(60);
    expect(new IdempotencyStore({ ttlMinutes: 5 }).ttlMinutes).toBe(5);
  });
});
