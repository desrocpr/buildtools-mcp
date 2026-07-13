/**
 * User/role reads + permission resolution (MOS-328). The valuable logic here
 * is the snake_case↔camelCase mapping and the permission UNION across roles
 * (dedup) that the RBAC gate depends on. A read-only fake returns configured
 * rows per table so the test targets that logic, not the query builder.
 */
import { describe, it, expect } from "vitest";
import {
  getUserById,
  getUserByAzureSub,
  getRolesForUser,
  getUserWithRoles,
} from "../users.js";
import type { Db } from "../db.js";

/** Read-only fake: `from(table)` resolves to the configured response for that
 * table regardless of filters (these are single-table reads). */
function fakeReadDb(byTable: Record<string, { data?: unknown; error?: unknown }>) {
  return {
    from(table: string) {
      const resp = byTable[table] ?? { data: null, error: null };
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        is: () => b,
        order: () => b,
        maybeSingle: () => Promise.resolve(resp),
        single: () => Promise.resolve(resp),
        then: (r: (v: unknown) => unknown, j: (e: unknown) => unknown) =>
          Promise.resolve(resp).then(r, j),
      };
      return b;
    },
  } as unknown as Db;
}

const USER_ROW = {
  id: "u1",
  kind: "human",
  azure_sub: "azure-123",
  email: "alice@example.com",
  display_name: "Alice",
  status: "active",
  created_at: "2026-01-01T00:00:00.000Z",
  last_seen_at: null,
};

describe("getUserById / getUserByAzureSub — row mapping", () => {
  it("maps snake_case columns to the camelCase domain shape", async () => {
    const db = fakeReadDb({ mcp_users: { data: USER_ROW } });
    const u = await getUserById(db, "u1");
    expect(u).toMatchObject({
      id: "u1",
      kind: "human",
      azureSub: "azure-123",
      email: "alice@example.com",
      displayName: "Alice",
      status: "active",
      lastSeenAt: null,
    });
    expect(u?.createdAt).toBeInstanceOf(Date);
  });

  it("returns null for a missing user", async () => {
    const db = fakeReadDb({ mcp_users: { data: null } });
    expect(await getUserById(db, "nope")).toBeNull();
    expect(await getUserByAzureSub(db, "nope")).toBeNull();
  });

  it("throws on a DB error rather than masking it", async () => {
    const db = fakeReadDb({ mcp_users: { error: { message: "boom" } } });
    await expect(getUserById(db, "u1")).rejects.toThrow(/getUserById: boom/);
  });
});

describe("getRolesForUser — embed unwrapping", () => {
  it("unwraps the {role: ...} embed and drops null rows", async () => {
    const db = fakeReadDb({
      mcp_user_roles: {
        data: [
          { role: { id: "r1", name: "viewer", permissions: ["read"] } },
          { role: null }, // orphaned membership — must be filtered out
          { role: { id: "r2", name: "editor", permissions: ["read", "write:tasks"] } },
        ],
      },
    });
    const roles = await getRolesForUser(db, "u1");
    expect(roles.map((r) => r.name)).toEqual(["viewer", "editor"]);
  });

  it("returns [] when the user has no roles", async () => {
    const db = fakeReadDb({ mcp_user_roles: { data: [] } });
    expect(await getRolesForUser(db, "u1")).toEqual([]);
  });
});

describe("getUserWithRoles — permission union", () => {
  it("dedups permissions across roles into a single effective set", async () => {
    const db = fakeReadDb({
      mcp_users: { data: USER_ROW },
      mcp_user_roles: {
        data: [
          { role: { id: "r1", name: "viewer", permissions: ["read"] } },
          { role: { id: "r2", name: "editor", permissions: ["read", "write:tasks", "write:budget"] } },
        ],
      },
    });
    const u = await getUserWithRoles(db, "u1");
    expect(u?.roles.map((r) => r.name)).toEqual(["viewer", "editor"]);
    // "read" appears in both roles but must be listed once.
    expect([...(u?.permissions ?? [])].sort()).toEqual(
      ["read", "write:budget", "write:tasks"].sort(),
    );
  });

  it("returns null when the user does not exist (no role lookup needed)", async () => {
    const db = fakeReadDb({ mcp_users: { data: null } });
    expect(await getUserWithRoles(db, "ghost")).toBeNull();
  });

  it("yields an empty permission set for a user with no roles", async () => {
    const db = fakeReadDb({
      mcp_users: { data: USER_ROW },
      mcp_user_roles: { data: [] },
    });
    const u = await getUserWithRoles(db, "u1");
    expect(u?.permissions).toEqual([]);
  });
});
