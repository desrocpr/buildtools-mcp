/**
 * Admin endpoints (MOS-328). Mounts the real admin router with a REAL signed
 * session cookie and REAL CSRF tokens (only the DB layer is mocked), so these
 * cover the security gates: the `requireAdmin` role check, CSRF enforcement on
 * POSTs, UUID path validation, known-role validation, the self-revoke and
 * last-admin guards, and the happy-path mutations.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";

vi.mock("../../auth/users.js", async (o) => ({
  ...(await o()),
  getUserWithRoles: vi.fn(),
  listUsers: vi.fn(),
  assignRoleByName: vi.fn(),
  removeRoleByName: vi.fn(),
  setUserStatus: vi.fn(),
  countActiveAdmins: vi.fn(),
  createServiceUser: vi.fn(),
}));
vi.mock("../../auth/service-tokens.js", async (o) => ({
  ...(await o()),
  createServiceTokenRow: vi.fn(),
  revokeServiceToken: vi.fn(),
  revokeAllServiceTokensForUser: vi.fn(),
}));
vi.mock("../../auth/oauth-store.js", async (o) => ({
  ...(await o()),
  revokeAllTokensForUser: vi.fn(),
}));
vi.mock("../../auth/credentials.js", async (o) => ({
  ...(await o()),
  upsertServiceCredentials: vi.fn(),
}));
vi.mock("../../auth/audit.js", async (o) => ({
  ...(await o()),
  logAuditEvent: vi.fn(),
}));

import { mountAdminRoutes } from "../admin.js";
import { signCookie } from "../../auth/session.js";
import { csrfTokenFor } from "../csrf.js";
import {
  getUserWithRoles,
  listUsers,
  assignRoleByName,
  countActiveAdmins,
} from "../../auth/users.js";
import type { McpUserWithRoles } from "../../auth/types.js";

const KEY = randomBytes(32);
const ADMIN_ID = randomUUID();
const TARGET_ID = randomUUID();

const mkUser = (id: string, roles: string[]): McpUserWithRoles =>
  ({
    id,
    kind: "human",
    azureSub: "az",
    email: `${id}@moss.test`,
    displayName: "T",
    status: "active",
    createdAt: new Date(),
    lastSeenAt: null,
    roles: roles.map((name) => ({ id: `r-${name}`, name, permissions: [] })),
    permissions: [],
  }) as McpUserWithRoles;

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  const router = express.Router();
  mountAdminRoutes(router, { db: {} as never, encryptionKey: KEY });
  app.use(router);
  await new Promise<void>((r) => {
    server = app.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      r();
    });
  });
});
afterAll(() => server?.close());
beforeEach(() => vi.clearAllMocks());

const adminCookie = (id = ADMIN_ID) =>
  `mcp_enroll_session=${signCookie({ userId: id, email: `${id}@moss.test` }, KEY, { ttlSeconds: 1800 })}`;

const get = (path: string, cookie?: string) =>
  fetch(`${base}${path}`, { headers: cookie ? { Cookie: cookie } : {}, redirect: "manual" });
const postForm = (path: string, form: Record<string, string>, cookie?: string) =>
  fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: new URLSearchParams(form).toString(),
  });

// requireAdmin loads the acting user by session id.
const asAdmin = () =>
  vi.mocked(getUserWithRoles).mockImplementation(async (_db, id) =>
    id === ADMIN_ID ? mkUser(ADMIN_ID, ["admin"]) : null,
  );

describe("requireAdmin", () => {
  it("redirects to /enroll when there is no session cookie", async () => {
    const res = await get("/admin");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/enroll");
  });

  it("redirects to /enroll when the session user no longer exists", async () => {
    vi.mocked(getUserWithRoles).mockResolvedValue(null);
    const res = await get("/admin", adminCookie());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/enroll");
  });

  it("403s a signed-in non-admin", async () => {
    vi.mocked(getUserWithRoles).mockResolvedValue(mkUser(ADMIN_ID, ["viewer"]));
    const res = await get("/admin", adminCookie());
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/admin role/i);
  });

  it("serves the dashboard to an admin", async () => {
    asAdmin();
    const res = await get("/admin", adminCookie());
    expect(res.status).toBe(200);
  });
});

describe("GET /admin/users", () => {
  it("renders the user list with an embedded CSRF token", async () => {
    asAdmin();
    vi.mocked(listUsers).mockResolvedValue([
      {
        id: TARGET_ID,
        kind: "human",
        email: "u@moss.test",
        displayName: "U",
        status: "active",
        lastSeenAt: null,
        roles: [{ name: "viewer" }],
      },
    ] as never);
    const res = await get("/admin/users", adminCookie());
    expect(res.status).toBe(200);
    // The CSRF token is embedded in the per-user mutation forms.
    expect(await res.text()).toContain(csrfTokenFor(ADMIN_ID, KEY));
  });
});

describe("POST /admin/users/:id/role — CSRF, UUID, role validation", () => {
  it("403s a POST without a valid CSRF token", async () => {
    asAdmin();
    const res = await postForm(`/admin/users/${TARGET_ID}/role`, { role: "editor" }, adminCookie());
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/csrf/i);
  });

  it("400s a non-UUID :id even with a valid CSRF token", async () => {
    asAdmin();
    const res = await postForm(
      "/admin/users/not-a-uuid/role",
      { role: "editor", _csrf: csrfTokenFor(ADMIN_ID, KEY) },
      adminCookie(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/invalid id/i);
  });

  it("400s an unknown role", async () => {
    asAdmin();
    const res = await postForm(
      `/admin/users/${TARGET_ID}/role`,
      { role: "superuser", _csrf: csrfTokenFor(ADMIN_ID, KEY) },
      adminCookie(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/unknown role/i);
  });

  it("assigns a known role and redirects", async () => {
    asAdmin();
    vi.mocked(assignRoleByName).mockResolvedValue(undefined);
    const res = await postForm(
      `/admin/users/${TARGET_ID}/role`,
      { role: "editor", action: "add", _csrf: csrfTokenFor(ADMIN_ID, KEY) },
      adminCookie(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/users");
    expect(assignRoleByName).toHaveBeenCalledWith(expect.anything(), TARGET_ID, "editor", ADMIN_ID);
  });
});

describe("POST /admin/users/:id/revoke — self + last-admin guards", () => {
  it("refuses to revoke yourself", async () => {
    asAdmin();
    const res = await postForm(
      `/admin/users/${ADMIN_ID}/revoke`,
      { _csrf: csrfTokenFor(ADMIN_ID, KEY) },
      adminCookie(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/revoke yourself/i);
  });

  it("refuses to revoke the last remaining admin", async () => {
    vi.mocked(getUserWithRoles).mockImplementation(async (_db, id) =>
      id === ADMIN_ID ? mkUser(ADMIN_ID, ["admin"]) : mkUser(TARGET_ID, ["admin"]),
    );
    vi.mocked(countActiveAdmins).mockResolvedValue(0);
    const res = await postForm(
      `/admin/users/${TARGET_ID}/revoke`,
      { _csrf: csrfTokenFor(ADMIN_ID, KEY) },
      adminCookie(),
    );
    expect(res.status).toBe(400);
  });
});
