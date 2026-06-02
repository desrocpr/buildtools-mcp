import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  buildClearCookieHeader,
  buildCookieHeader,
  openState,
  parseCookieHeader,
  sealState,
  signCookie,
  verifyCookie,
} from "../session.js";

const KEY = randomBytes(32);

describe("signCookie / verifyCookie", () => {
  it("round-trips a payload", () => {
    const token = signCookie({ userId: "u1", email: "x@y.z" }, KEY);
    expect(verifyCookie<{ userId: string; email: string }>(token, KEY)).toEqual({
      userId: "u1",
      email: "x@y.z",
    });
  });

  it("returns null for malformed token", () => {
    expect(verifyCookie("not-a-token", KEY)).toBeNull();
    expect(verifyCookie("a.b.c", KEY)).toBeNull();
  });

  it("returns null when MAC doesn't match", () => {
    const token = signCookie({ x: 1 }, KEY);
    const [body] = token.split(".");
    expect(verifyCookie(`${body}.AAAAAA`, KEY)).toBeNull();
  });

  it("returns null when signed with a different key", () => {
    const token = signCookie({ x: 1 }, KEY);
    const otherKey = randomBytes(32);
    expect(verifyCookie(token, otherKey)).toBeNull();
  });

  it("returns null when expired", () => {
    vi.useFakeTimers();
    const start = new Date("2026-06-01T00:00:00Z");
    vi.setSystemTime(start);
    const token = signCookie({ x: 1 }, KEY, { ttlSeconds: 60 });
    vi.setSystemTime(new Date(start.getTime() + 61_000));
    expect(verifyCookie(token, KEY)).toBeNull();
    vi.useRealTimers();
  });
});

describe("sealState / openState", () => {
  it("round-trips a payload", () => {
    const token = sealState({ clientId: "abc", scope: "read" }, KEY);
    expect(openState<{ clientId: string; scope: string }>(token, KEY)).toEqual({
      clientId: "abc",
      scope: "read",
    });
  });

  it("two seals of the same payload produce different tokens (random nonce)", () => {
    const a = sealState({ x: 1 }, KEY);
    const b = sealState({ x: 1 }, KEY);
    expect(a).not.toBe(b);
  });

  it("returns null on tampered ciphertext", () => {
    const token = sealState({ x: 1 }, KEY);
    const tampered = token.slice(0, -2) + "AA";
    expect(openState(tampered, KEY)).toBeNull();
  });

  it("returns null when sealed with a different key", () => {
    const token = sealState({ x: 1 }, KEY);
    const otherKey = randomBytes(32);
    expect(openState(token, otherKey)).toBeNull();
  });

  it("returns null when expired", () => {
    vi.useFakeTimers();
    const start = new Date("2026-06-01T00:00:00Z");
    vi.setSystemTime(start);
    const token = sealState({ x: 1 }, KEY, { ttlSeconds: 30 });
    vi.setSystemTime(new Date(start.getTime() + 31_000));
    expect(openState(token, KEY)).toBeNull();
    vi.useRealTimers();
  });
});

describe("buildCookieHeader", () => {
  it("emits Path + HttpOnly + Secure + SameSite=Lax by default", () => {
    expect(buildCookieHeader({ name: "x", value: "y" })).toBe(
      "x=y; Path=/; HttpOnly; Secure; SameSite=Lax",
    );
  });

  it("includes Max-Age when provided", () => {
    expect(buildCookieHeader({ name: "x", value: "y", maxAge: 60 })).toContain(
      "Max-Age=60",
    );
  });

  it("respects opt-outs for Secure/HttpOnly", () => {
    expect(
      buildCookieHeader({ name: "x", value: "y", secure: false, httpOnly: false }),
    ).toBe("x=y; Path=/; SameSite=Lax");
  });
});

describe("buildClearCookieHeader", () => {
  it("emits Max-Age=0", () => {
    expect(buildClearCookieHeader("x")).toContain("Max-Age=0");
  });
});

describe("parseCookieHeader", () => {
  it("parses a single cookie", () => {
    expect(parseCookieHeader("session=abc")).toEqual({ session: "abc" });
  });

  it("parses multiple cookies", () => {
    expect(parseCookieHeader("a=1; b=2; c=3")).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("trims whitespace", () => {
    expect(parseCookieHeader("  a = 1 ; b=2 ")).toEqual({ a: "1", b: "2" });
  });

  it("returns empty for undefined header", () => {
    expect(parseCookieHeader(undefined)).toEqual({});
  });

  it("ignores entries without =", () => {
    expect(parseCookieHeader("a; b=2")).toEqual({ b: "2" });
  });
});
