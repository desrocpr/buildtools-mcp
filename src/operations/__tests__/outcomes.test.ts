/**
 * Tests for the neutral write-outcome vocabulary (MOS-747).
 *
 * Vendor-specific classification is tested next to its adapter, in
 * `adapters/buildtools/__tests__/classify.test.ts`.
 */

import { describe, expect, it } from "vitest";

import {
  ambiguous,
  failed,
  isCacheable,
  isOk,
  needsReconcile,
  ok,
  redactUrls,
} from "../outcomes.js";

describe("redactUrls", () => {
  it("strips the query string from a presigned URL but keeps the path", () => {
    // BuildTools' download path follows 302s to presigned S3 URLs whose query
    // strings carry X-Amz-Signature / X-Amz-Credential. Outcomes cross into MCP
    // output and the HTTP gateway, so this is the last place to sanitise.
    const presigned =
      "https://moss-bt.s3.amazonaws.com/doc.pdf" +
      "?X-Amz-Credential=AKIAEXAMPLE%2F20260804&X-Amz-Signature=deadbeefcafe";

    const cleaned = redactUrls(`Network error downloading ${presigned}: reset`);

    expect(cleaned).not.toMatch(/X-Amz-Signature/i);
    expect(cleaned).not.toMatch(/deadbeefcafe/);
    expect(cleaned).not.toMatch(/AKIAEXAMPLE/);
    expect(cleaned).toContain("moss-bt.s3.amazonaws.com/doc.pdf");
  });

  it("leaves text without URLs untouched", () => {
    expect(redactUrls("upstream rejected the write")).toBe(
      "upstream rejected the write",
    );
  });

  it("is applied by the ambiguous and failed constructors", () => {
    const url = "https://moss.buildtools.app/save?token=sekrit";

    expect(ambiguous(`boom ${url}`).reason).not.toContain("sekrit");
    expect(failed(`boom ${url}`).reason).not.toContain("sekrit");
  });

  it("redacts `details` too, not just `reason`", () => {
    // Both are derived from the same upstream string, so redacting one and
    // forwarding the other leaks the credential anyway.
    const url = "https://moss-bt.s3.amazonaws.com/f.pdf?X-Amz-Signature=leakme";

    expect(JSON.stringify(failed("rejected", `see ${url}`))).not.toContain(
      "leakme",
    );
    expect(JSON.stringify(failed("rejected", [`see ${url}`]))).not.toContain(
      "leakme",
    );
    expect(
      JSON.stringify(failed("rejected", { message: `see ${url}` })),
    ).not.toContain("leakme");
  });
});

describe("narrowing helpers", () => {
  it("isOk narrows to the data payload", () => {
    const outcome = ok({ id: 7 });
    expect(isOk(outcome)).toBe(true);
    if (!isOk(outcome)) throw new Error("expected ok");
    expect(outcome.data.id).toBe(7);
  });

  it("needsReconcile is true only for ambiguous", () => {
    expect(needsReconcile(ambiguous("unknown"))).toBe(true);
    expect(needsReconcile(failed("nope"))).toBe(false);
    expect(needsReconcile(ok(1))).toBe(false);
  });
});

describe("isCacheable", () => {
  // This encodes the idempotency decision. `storeIdempotencyResult` refuses to
  // cache errors, on the rationale that a failure should get a fresh attempt.
  // That is right for `failed` and wrong for `ambiguous`: not caching an
  // ambiguous write means a retry with the same idempotency_key re-fires it,
  // creating the duplicate the whole model exists to prevent.
  it("caches ok and ambiguous, but not failed", () => {
    expect(isCacheable(ok({ id: 1 }))).toBe(true);
    expect(isCacheable(ambiguous("unknown"))).toBe(true);
    expect(isCacheable(failed("validation"))).toBe(false);
  });
});

describe("probe", () => {
  it("carries a structured reconcile handle, not prose", () => {
    // A remote caller across the gateway must be able to act on this without
    // parsing English back into a query.
    const outcome = ambiguous("unknown", {
      kind: "marker",
      marker: "cambium:t1:p1",
    });

    expect(outcome.probe).toEqual({ kind: "marker", marker: "cambium:t1:p1" });
  });
});
