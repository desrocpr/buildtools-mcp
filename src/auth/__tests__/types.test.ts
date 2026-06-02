import { describe, expect, it } from "vitest";

import { hasPermission } from "../types.js";

describe("hasPermission", () => {
  it("matches an exact permission", () => {
    expect(hasPermission(["read"], "read")).toBe(true);
  });

  it("does not match a different permission", () => {
    expect(hasPermission(["read"], "delete")).toBe(false);
  });

  it("matches the global wildcard", () => {
    expect(hasPermission(["*"], "delete")).toBe(true);
    expect(hasPermission(["*"], "read")).toBe(true);
    expect(hasPermission(["*"], "write:budget")).toBe(true);
  });

  it("matches a domain wildcard", () => {
    expect(hasPermission(["write:*"], "write:budget")).toBe(true);
    expect(hasPermission(["write:*"], "write:financial")).toBe(true);
  });

  it("domain wildcard does not cross domains", () => {
    expect(hasPermission(["write:*"], "delete")).toBe(false);
    expect(hasPermission(["write:*"], "read")).toBe(false);
  });

  it("returns false on empty permissions", () => {
    expect(hasPermission([], "read")).toBe(false);
  });

  it("returns false when required has no colon and isn't matched exactly", () => {
    expect(hasPermission(["write:budget"], "read")).toBe(false);
  });
});
