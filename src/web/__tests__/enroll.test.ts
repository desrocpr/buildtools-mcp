/**
 * Enrollment session cookie reads (MOS-328). `readSession` is the gate the
 * enroll + admin surfaces use to identify the signed-in user, so it must
 * reject a missing / wrong-key / tampered / expired cookie and accept only a
 * validly-signed, unexpired one.
 */
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import type { Request } from "express";
import { readSession, SESSION_COOKIE } from "../enroll.js";
import { signCookie } from "../../auth/session.js";

const KEY = randomBytes(32);
const session = { userId: "u1", email: "u1@moss.test" };
const reqWithCookie = (cookie?: string) =>
  ({ headers: cookie ? { cookie } : {} }) as unknown as Request;

describe("readSession", () => {
  it("returns the session for a validly-signed, unexpired cookie", () => {
    const token = signCookie(session, KEY, { ttlSeconds: 1800 });
    const got = readSession(reqWithCookie(`${SESSION_COOKIE}=${token}`), KEY);
    expect(got).toEqual(session);
  });

  it("returns null when there is no cookie header", () => {
    expect(readSession(reqWithCookie(), KEY)).toBeNull();
  });

  it("returns null when the session cookie is absent among others", () => {
    expect(readSession(reqWithCookie("other=abc; theme=dark"), KEY)).toBeNull();
  });

  it("returns null for a cookie signed with a different key (tamper/wrong key)", () => {
    const token = signCookie(session, randomBytes(32), { ttlSeconds: 1800 });
    expect(readSession(reqWithCookie(`${SESSION_COOKIE}=${token}`), KEY)).toBeNull();
  });

  it("returns null for an expired cookie", () => {
    const token = signCookie(session, KEY, { ttlSeconds: -1 });
    expect(readSession(reqWithCookie(`${SESSION_COOKIE}=${token}`), KEY)).toBeNull();
  });

  it("returns null for a structurally malformed token", () => {
    expect(readSession(reqWithCookie(`${SESSION_COOKIE}=not-a-real-token`), KEY)).toBeNull();
  });
});
