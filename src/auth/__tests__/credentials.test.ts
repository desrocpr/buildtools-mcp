/**
 * Encrypted-credential storage round-trip (MOS-328).
 *
 * Uses a tiny STATEFUL fake of the one table this module touches
 * (`mcp_service_credentials`) so the test exercises real behavior —
 * encrypt → store as a `\x` bytea hex literal → read back → decrypt — rather
 * than asserting which builder methods were called. This is the layer that
 * had the documented "supabase-js JSON-stringifies a Buffer" bug, so a real
 * round-trip is the high-signal guard.
 */
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  upsertServiceCredentials,
  getServiceCredentials,
  hasCredentialsFor,
  deleteServiceCredentials,
} from "../credentials.js";
import type { Db } from "../db.js";

const KEY = () => randomBytes(32); // AES-256

/** Minimal stateful fake covering exactly the chains credentials.ts uses. */
function fakeCredsDb() {
  const rows = new Map<string, Record<string, unknown>>();
  const k = (u: unknown, s: unknown) => `${u}::${s}`;
  const db = {
    from() {
      const f: Record<string, unknown> = {};
      let mode: "select" | "delete" | "count" | "upsert" = "select";
      let payload: Record<string, unknown> | null = null;
      const b: Record<string, unknown> = {
        upsert(obj: Record<string, unknown>) {
          mode = "upsert";
          payload = obj;
          return b;
        },
        select(_cols?: unknown, opts?: { head?: boolean }) {
          if (opts?.head) mode = "count";
          return b;
        },
        delete() {
          mode = "delete";
          return b;
        },
        eq(col: string, val: unknown) {
          f[col] = val;
          return b;
        },
        maybeSingle() {
          return Promise.resolve({
            data: rows.get(k(f.user_id, f.service)) ?? null,
            error: null,
          });
        },
        then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) {
          let out: unknown;
          if (mode === "upsert" && payload) {
            rows.set(k(payload.user_id, payload.service), { ...payload });
            out = { error: null };
          } else if (mode === "delete") {
            rows.delete(k(f.user_id, f.service));
            out = { error: null };
          } else if (mode === "count") {
            out = { count: rows.has(k(f.user_id, f.service)) ? 1 : 0, error: null };
          } else {
            out = { data: rows.get(k(f.user_id, f.service)) ?? null, error: null };
          }
          return Promise.resolve(out).then(res, rej);
        },
      };
      return b;
    },
  } as unknown as Db;
  return { db, rows };
}

describe("service credentials round-trip", () => {
  it("stores encrypted and reads back the exact plaintext", async () => {
    const key = KEY();
    const { db, rows } = fakeCredsDb();
    const creds = { email: "user@example.com", password: "s3cr3t!" };

    await upsertServiceCredentials(db, "u1", "buildtools", creds, key);
    // Persisted as a Postgres bytea hex literal, NOT a JSON-stringified Buffer.
    const stored = rows.get("u1::buildtools")!;
    expect(stored.credentials_encrypted).toMatch(/^\\x[0-9a-f]+$/);
    expect(String(stored.credentials_encrypted)).not.toContain("Buffer");

    const got = await getServiceCredentials(db, "u1", "buildtools", key);
    expect(got).toEqual(creds);
  });

  it("hasCredentialsFor reflects presence, and delete removes it", async () => {
    const key = KEY();
    const { db } = fakeCredsDb();
    expect(await hasCredentialsFor(db, "u1", "buildtools")).toBe(false);
    await upsertServiceCredentials(db, "u1", "buildtools", { email: "a@b.co", password: "x" }, key);
    expect(await hasCredentialsFor(db, "u1", "buildtools")).toBe(true);
    await deleteServiceCredentials(db, "u1", "buildtools");
    expect(await hasCredentialsFor(db, "u1", "buildtools")).toBe(false);
    expect(await getServiceCredentials(db, "u1", "buildtools", key)).toBeNull();
  });

  it("returns null when no row exists", async () => {
    const { db } = fakeCredsDb();
    expect(await getServiceCredentials(db, "nobody", "buildtools", KEY())).toBeNull();
  });

  it("decodes base64 bytea (the alternate PostgREST encoding)", async () => {
    const key = KEY();
    const { db, rows } = fakeCredsDb();
    await upsertServiceCredentials(db, "u1", "buildtools", { email: "a@b.co", password: "pw" }, key);
    // Rewrite the stored value from `\x<hex>` to base64 to simulate a project
    // with pgrst.bytea_to_base64 = true.
    const row = rows.get("u1::buildtools")!;
    const hex = String(row.credentials_encrypted).slice(2);
    row.credentials_encrypted = Buffer.from(hex, "hex").toString("base64");
    const got = await getServiceCredentials(db, "u1", "buildtools", key);
    expect(got).toEqual({ email: "a@b.co", password: "pw" });
  });

  it("throws (never silently returns null) when the row exists but the key is wrong", async () => {
    const { db } = fakeCredsDb();
    await upsertServiceCredentials(db, "u1", "buildtools", { email: "a@b.co", password: "pw" }, KEY());
    await expect(
      getServiceCredentials(db, "u1", "buildtools", randomBytes(32)),
    ).rejects.toThrow();
  });
});
