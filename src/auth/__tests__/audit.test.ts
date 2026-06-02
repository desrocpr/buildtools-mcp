import { describe, expect, it } from "vitest";

import {
  RATE_LIMITS_BY_ROLE,
  bucketFor,
  maxLimitFor,
} from "../audit.js";

describe("bucketFor", () => {
  it("maps read", () => {
    expect(bucketFor("read")).toBe("read");
  });

  it("maps delete", () => {
    expect(bucketFor("delete")).toBe("delete");
  });

  it("maps any write:* into 'write'", () => {
    expect(bucketFor("write:budget")).toBe("write");
    expect(bucketFor("write:selections")).toBe("write");
    expect(bucketFor("write")).toBe("write");
  });

  it("returns null for unknown permissions", () => {
    expect(bucketFor("admin")).toBeNull();
    expect(bucketFor("*")).toBeNull();
  });
});

describe("maxLimitFor", () => {
  it("returns the higher of two role caps", () => {
    // harness has 5000 reads, viewer has 1000 reads.
    expect(maxLimitFor(["viewer", "harness"], "read")).toBe(5000);
  });

  it("returns null when no role applies", () => {
    expect(maxLimitFor(["unknown-role"], "read")).toBeNull();
    expect(maxLimitFor([], "delete")).toBeNull();
  });

  it("returns null when none of the user's roles configure the bucket", () => {
    // viewer has no 'delete' bucket.
    expect(maxLimitFor(["viewer"], "delete")).toBeNull();
  });

  it("admin has the only delete bucket cap", () => {
    expect(maxLimitFor(["admin"], "delete")).toBe(50);
    expect(maxLimitFor(["admin"], "write")).toBe(500);
    expect(maxLimitFor(["admin"], "read")).toBe(1000);
  });
});

describe("RATE_LIMITS_BY_ROLE", () => {
  it("has the four documented roles", () => {
    expect(Object.keys(RATE_LIMITS_BY_ROLE).sort()).toEqual([
      "admin",
      "editor",
      "harness",
      "viewer",
    ]);
  });

  it("viewer is read-only", () => {
    const limits = RATE_LIMITS_BY_ROLE.viewer;
    expect(limits).toHaveLength(1);
    expect(limits[0]).toEqual({ bucket: "read", perHour: 1000 });
  });

  it("harness gets 5000 reads + 500 writes, no deletes", () => {
    const limits = RATE_LIMITS_BY_ROLE.harness;
    const map = Object.fromEntries(limits.map((l) => [l.bucket, l.perHour]));
    expect(map).toEqual({ read: 5000, write: 500 });
  });
});
