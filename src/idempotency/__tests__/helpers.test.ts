/**
 * Tests for the idempotency outer-handler helpers (PR #67).
 *
 * These cover the helper functions in isolation. End-to-end behavior
 * via the consolidator tools is already covered by the existing per-tool
 * suites (mutations.test.ts) — those tests didn't change in PR #67
 * because the helpers preserve the existing outer-handler semantics.
 */

import { describe, expect, it } from "vitest";

import { IdempotencyStore } from "../IdempotencyStore.js";
import { checkIdempotency, storeIdempotencyResult } from "../helpers.js";
import type { ToolResult } from "../../tools/projects.js";

function mkResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}
function mkError(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

describe("checkIdempotency", () => {
  it("returns empty context when idempotencyStore is undefined", () => {
    const ctx = checkIdempotency({
      toolName: "x",
      idempotencyKey: "key12345",
      fingerprintInput: { a: 1 },
    });
    expect(ctx).toEqual({});
  });

  it("returns empty context when idempotencyKey is undefined (caller didn't ask for idempotency)", () => {
    const store = new IdempotencyStore();
    const ctx = checkIdempotency({
      toolName: "x",
      idempotencyStore: store,
      fingerprintInput: { a: 1 },
    });
    expect(ctx).toEqual({});
  });

  it("returns context with cacheKey + fingerprint on miss (first call with a key)", () => {
    const store = new IdempotencyStore();
    const ctx = checkIdempotency({
      toolName: "x",
      idempotencyStore: store,
      idempotencyKey: "key12345",
      fingerprintInput: { a: 1 },
    });
    expect(ctx.cacheKey).toBeDefined();
    expect(ctx.argsFingerprint).toBeDefined();
    expect(ctx.replayResult).toBeUndefined();
    expect(ctx.mismatchError).toBeUndefined();
  });

  it("returns replayResult with banner on cache hit (same key + same args)", () => {
    const store = new IdempotencyStore();
    const ctx1 = checkIdempotency({
      toolName: "x",
      idempotencyStore: store,
      sessionId: "u",
      idempotencyKey: "key12345",
      fingerprintInput: { a: 1 },
    });
    storeIdempotencyResult({
      context: ctx1,
      result: mkResult("original result"),
      isExecuteCall: true,
    });

    const ctx2 = checkIdempotency({
      toolName: "x",
      idempotencyStore: store,
      sessionId: "u",
      idempotencyKey: "key12345",
      fingerprintInput: { a: 1 },
    });
    expect(ctx2.replayResult).toBeDefined();
    const text = (ctx2.replayResult!.content[0] as { text: string }).text;
    expect(text).toContain("Idempotency replay");
    expect(text).toContain("key12345");
    expect(text).toContain("original result");
  });

  it("returns mismatchError on key reuse with DIFFERENT args", () => {
    const store = new IdempotencyStore();
    const ctx1 = checkIdempotency({
      toolName: "x",
      idempotencyStore: store,
      idempotencyKey: "shared-key-99",
      fingerprintInput: { a: 1 },
    });
    storeIdempotencyResult({
      context: ctx1,
      result: mkResult("first"),
      isExecuteCall: true,
    });

    const ctx2 = checkIdempotency({
      toolName: "x",
      idempotencyStore: store,
      idempotencyKey: "shared-key-99",
      fingerprintInput: { a: 2 },
    });
    expect(ctx2.mismatchError).toBeDefined();
    expect(ctx2.mismatchError!.isError).toBe(true);
    // PR #67 review LOW 4: tighten assertion against the full wording
    // (was just the prefix, which masked drift from the inline forms).
    expect((ctx2.mismatchError!.content[0] as { text: string }).text).toMatch(
      /within the last \d+ min.*Use a fresh key per distinct write/,
    );
  });

  it("namespacing: same key in different tools doesn't collide", () => {
    const store = new IdempotencyStore();
    const ctxA = checkIdempotency({
      toolName: "tool_a",
      idempotencyStore: store,
      idempotencyKey: "shared-key-99",
      fingerprintInput: { a: 1 },
    });
    storeIdempotencyResult({
      context: ctxA,
      result: mkResult("from A"),
      isExecuteCall: true,
    });

    const ctxB = checkIdempotency({
      toolName: "tool_b",
      idempotencyStore: store,
      idempotencyKey: "shared-key-99",
      fingerprintInput: { a: 1 },
    });
    expect(ctxB.replayResult).toBeUndefined(); // miss because different toolName
  });

  it("namespacing: same key in different sessions doesn't collide", () => {
    const store = new IdempotencyStore();
    const ctxA = checkIdempotency({
      toolName: "x",
      idempotencyStore: store,
      sessionId: "alice",
      idempotencyKey: "k12345678",
      fingerprintInput: { a: 1 },
    });
    storeIdempotencyResult({
      context: ctxA,
      result: mkResult("alice's"),
      isExecuteCall: true,
    });

    const ctxB = checkIdempotency({
      toolName: "x",
      idempotencyStore: store,
      sessionId: "bob",
      idempotencyKey: "k12345678",
      fingerprintInput: { a: 1 },
    });
    expect(ctxB.replayResult).toBeUndefined();
  });
});

describe("storeIdempotencyResult", () => {
  it("does NOT store when isExecuteCall is false (prompt phase)", () => {
    const store = new IdempotencyStore();
    const ctx = checkIdempotency({
      toolName: "x",
      idempotencyStore: store,
      idempotencyKey: "key12345",
      fingerprintInput: { a: 1 },
    });
    storeIdempotencyResult({
      context: ctx,
      result: mkResult("prompt"),
      isExecuteCall: false,
    });
    expect(store.size).toBe(0);
  });

  it("does NOT store when result is an error", () => {
    const store = new IdempotencyStore();
    const ctx = checkIdempotency({
      toolName: "x",
      idempotencyStore: store,
      idempotencyKey: "key12345",
      fingerprintInput: { a: 1 },
    });
    storeIdempotencyResult({
      context: ctx,
      result: mkError("BT failed"),
      isExecuteCall: true,
    });
    expect(store.size).toBe(0);
  });

  it("does NOT store when context has no cacheKey (caller didn't pass idempotency_key)", () => {
    const store = new IdempotencyStore();
    const ctx = checkIdempotency({
      toolName: "x",
      idempotencyStore: store,
      // No idempotencyKey
      fingerprintInput: { a: 1 },
    });
    storeIdempotencyResult({
      context: ctx,
      result: mkResult("success"),
      isExecuteCall: true,
    });
    expect(store.size).toBe(0);
  });

  it("stores when ALL conditions met (isExecuteCall + !isError + cacheKey set)", () => {
    const store = new IdempotencyStore();
    const ctx = checkIdempotency({
      toolName: "x",
      idempotencyStore: store,
      idempotencyKey: "key12345",
      fingerprintInput: { a: 1 },
    });
    storeIdempotencyResult({
      context: ctx,
      result: mkResult("success"),
      isExecuteCall: true,
    });
    expect(store.size).toBe(1);
  });

  it("no-op when context has no store (caller didn't use idempotency at all)", () => {
    const ctx = { cacheKey: "k", argsFingerprint: "f" }; // no store
    // Should not throw.
    storeIdempotencyResult({
      context: ctx,
      result: mkResult("x"),
      isExecuteCall: true,
    });
  });
});
