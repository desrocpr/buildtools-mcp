/**
 * Admin endpoints (MOS-328 Phase 7).
 *
 * Browser-facing surface for users with the `admin` role:
 *   - List + manage enrolled users (assign/remove roles, revoke)
 *   - Provision service accounts (e.g., the harness) and issue
 *     long-lived `mcps_…` bearer tokens
 *   - Page through the audit log
 *
 * Auth: reuses the existing `mcp_enroll_session` cookie. The
 * `requireAdmin` middleware looks up the signed-in user, verifies
 * they hold the `admin` role, and 403s otherwise. No separate
 * admin login.
 *
 * CSRF: SameSite=Lax on the session cookie blocks cross-origin POSTs.
 * Forms post back to same-origin only, so no separate CSRF token
 * scheme is needed.
 */

import express, { type NextFunction, type Request, type Response, type Router } from "express";

import { BuildToolsAPI } from "../client/BuildToolsAPI.js";
import { logAuditEvent } from "../auth/audit.js";
import { upsertServiceCredentials } from "../auth/credentials.js";
import type { Db } from "../auth/db.js";
import { revokeAllTokensForUser } from "../auth/oauth-store.js";
import {
  createServiceTokenRow,
  revokeAllServiceTokensForUser,
  revokeServiceToken,
} from "../auth/service-tokens.js";
import {
  assignRoleByName,
  countActiveAdmins,
  createServiceUser,
  getUserWithRoles,
  listUsers,
  removeRoleByName,
  setUserStatus,
} from "../auth/users.js";
import { isKnownRole, type McpUserWithRoles } from "../auth/types.js";
import { csrfTokenFor, verifyCsrfToken } from "./csrf.js";
import { readSession } from "./enroll.js";

/** UUIDs from `gen_random_uuid()` — strict format check on all :id path params. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdminDeps {
  db: Db;
  encryptionKey: Buffer;
}

interface AdminRequest extends Request {
  admin?: McpUserWithRoles;
}

export function mountAdminRoutes(router: Router, deps: AdminDeps): void {
  const requireAdmin = async (
    req: AdminRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const session = readSession(req, deps.encryptionKey);
    if (!session) {
      res.redirect("/enroll");
      return;
    }
    const user = await getUserWithRoles(deps.db, session.userId);
    if (!user || user.status !== "active") {
      res.redirect("/enroll");
      return;
    }
    if (!user.roles.some((r) => r.name === "admin")) {
      const { errorPage } = await import("./pages.js");
      res
        .status(403)
        .type("html")
        .send(errorPage("This page requires the admin role."));
      return;
    }
    req.admin = user;
    next();
  };

  /** Helper that all admin POSTs run before mutating anything. */
  const guardPost = (
    req: AdminRequest,
    res: Response,
  ): { ok: false } | { ok: true; csrf: string } => {
    const presented =
      typeof req.body?._csrf === "string" ? req.body._csrf : null;
    if (!verifyCsrfToken(presented, req.admin!.id, deps.encryptionKey)) {
      res.status(403).type("text/plain").send("CSRF check failed");
      return { ok: false };
    }
    return { ok: true, csrf: presented as string };
  };

  /** Validate a route :id param looks like a UUID before passing to PostgREST. */
  const validateUuidParam = (req: Request, res: Response): string | null => {
    const id = String(req.params.id ?? "");
    if (!UUID_RE.test(id)) {
      res.status(400).type("text/plain").send("invalid id");
      return null;
    }
    return id;
  };

  // ----- GET /admin — dashboard ----------------------------------------------

  router.get("/admin", requireAdmin, async (req: AdminRequest, res) => {
    const { adminDashboardPage } = await import("./pages.js");
    res.type("html").send(adminDashboardPage({ userEmail: req.admin!.email }));
  });

  // ----- GET /admin/users ----------------------------------------------------

  router.get("/admin/users", requireAdmin, async (req: AdminRequest, res) => {
    const { adminUsersPage } = await import("./pages.js");
    const users = await listUsers(deps.db);
    res.type("html").send(
      adminUsersPage({
        currentUserId: req.admin!.id,
        userEmail: req.admin!.email,
        csrfToken: csrfTokenFor(req.admin!.id, deps.encryptionKey),
        users,
      }),
    );
  });

  // ----- POST /admin/users/:id/role -----------------------------------------

  router.post(
    "/admin/users/:id/role",
    requireAdmin,
    express.urlencoded({ extended: false }),
    async (req: AdminRequest, res) => {
      if (!guardPost(req, res).ok) return;
      const userId = validateUuidParam(req, res);
      if (!userId) return;
      const role = typeof req.body?.role === "string" ? req.body.role : "";
      const action = req.body?.action === "remove" ? "remove" : "add";
      if (!role || !isKnownRole(role)) {
        res.status(400).type("text/plain").send("unknown role");
        return;
      }
      // Last-admin guard: don't let an admin remove the `admin` role
      // from the last remaining active admin.
      if (action === "remove" && role === "admin") {
        const remaining = await countActiveAdmins(deps.db, userId);
        if (remaining === 0) {
          const { errorPage } = await import("./pages.js");
          res.status(400).type("html").send(
            errorPage(
              "Refusing to remove the admin role from the last remaining active admin. Promote another user first.",
            ),
          );
          return;
        }
      }
      try {
        if (action === "add") {
          await assignRoleByName(deps.db, userId, role, req.admin!.id);
        } else {
          await removeRoleByName(deps.db, userId, role);
        }
        await logAuditEvent(deps.db, {
          userId: req.admin!.id,
          mcpServer: "admin",
          tool: `admin:${action}_role`,
          result: "ok",
          metadata: { target_user_id: userId, role },
        });
        res.redirect("/admin/users");
      } catch (err) {
        const { errorPage } = await import("./pages.js");
        const msg = err instanceof Error ? err.message : String(err);
        await logAuditEvent(deps.db, {
          userId: req.admin!.id,
          mcpServer: "admin",
          tool: `admin:${action}_role`,
          result: "error",
          errorMessage: msg,
          metadata: { target_user_id: userId, role },
        });
        res.status(400).type("html").send(errorPage(`Role change failed: ${msg}`));
      }
    },
  );

  // ----- POST /admin/users/:id/revoke ---------------------------------------

  router.post(
    "/admin/users/:id/revoke",
    requireAdmin,
    express.urlencoded({ extended: false }),
    async (req: AdminRequest, res) => {
      if (!guardPost(req, res).ok) return;
      const userId = validateUuidParam(req, res);
      if (!userId) return;
      if (userId === req.admin!.id) {
        const { errorPage } = await import("./pages.js");
        res
          .status(400)
          .type("html")
          .send(errorPage("Cannot revoke yourself. Have another admin do it."));
        return;
      }
      // Last-admin guard: refuse if the target is the last active admin.
      const target = await getUserWithRoles(deps.db, userId);
      if (target?.roles.some((r) => r.name === "admin")) {
        const remaining = await countActiveAdmins(deps.db, userId);
        if (remaining === 0) {
          const { errorPage } = await import("./pages.js");
          res.status(400).type("html").send(
            errorPage(
              "Refusing to revoke the last remaining active admin. Promote another user first.",
            ),
          );
          return;
        }
      }
      try {
        await setUserStatus(deps.db, userId, "revoked");
        await revokeAllTokensForUser(deps.db, userId);
        // Also revoke service tokens — the row-level state should
        // match the functional state. (Without this, the admin UI
        // would show the user's `mcps_…` tokens as active even though
        // the resolver blocks them via user.status check.)
        await revokeAllServiceTokensForUser(deps.db, userId, req.admin!.id);
        await logAuditEvent(deps.db, {
          userId: req.admin!.id,
          mcpServer: "admin",
          tool: "admin:revoke_user",
          result: "ok",
          metadata: { target_user_id: userId },
        });
        res.redirect("/admin/users");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await logAuditEvent(deps.db, {
          userId: req.admin!.id,
          mcpServer: "admin",
          tool: "admin:revoke_user",
          result: "error",
          errorMessage: msg,
          metadata: { target_user_id: userId },
        });
        const { errorPage } = await import("./pages.js");
        res.status(500).type("html").send(errorPage(`Revoke failed: ${msg}`));
      }
    },
  );

  // ----- GET /admin/service-accounts/new ------------------------------------

  router.get(
    "/admin/service-accounts/new",
    requireAdmin,
    async (req: AdminRequest, res) => {
      const { adminNewServiceAccountPage } = await import("./pages.js");
      res.type("html").send(
        adminNewServiceAccountPage({
          userEmail: req.admin!.email,
          csrfToken: csrfTokenFor(req.admin!.id, deps.encryptionKey),
        }),
      );
    },
  );

  // ----- POST /admin/service-accounts/new -----------------------------------

  router.post(
    "/admin/service-accounts/new",
    requireAdmin,
    express.urlencoded({ extended: false }),
    async (req: AdminRequest, res) => {
      if (!guardPost(req, res).ok) return;
      const displayName =
        typeof req.body?.display_name === "string"
          ? req.body.display_name.trim()
          : "";
      const email =
        typeof req.body?.email === "string" ? req.body.email.trim() : "";
      const roleName =
        typeof req.body?.role === "string" ? req.body.role : "harness";
      const btEmail =
        typeof req.body?.bt_email === "string" ? req.body.bt_email.trim() : "";
      const btPassword =
        typeof req.body?.bt_password === "string" ? req.body.bt_password : "";

      const csrf = csrfTokenFor(req.admin!.id, deps.encryptionKey);

      if (!isKnownRole(roleName)) {
        const { adminNewServiceAccountPage } = await import("./pages.js");
        res.status(400).type("html").send(
          adminNewServiceAccountPage({
            userEmail: req.admin!.email,
            csrfToken: csrf,
            errorMessage: "Unknown role.",
            prefill: { displayName, email, roleName, btEmail },
          }),
        );
        return;
      }

      if (!displayName || !email || !btEmail || !btPassword) {
        const { adminNewServiceAccountPage } = await import("./pages.js");
        res.status(400).type("html").send(
          adminNewServiceAccountPage({
            userEmail: req.admin!.email,
            csrfToken: csrf,
            errorMessage:
              "display_name, email, bt_email, and bt_password are all required.",
            prefill: { displayName, email, roleName, btEmail },
          }),
        );
        return;
      }

      // Validate the BT login first — refuse to provision a service
      // account whose BT credentials don't actually work. Errors from
      // the upstream BT API are logged to stderr (full message) but
      // surfaced to the user generically — they may include echoed
      // form values that we shouldn't render back into HTML.
      const api = new BuildToolsAPI({
        tenant: process.env.BUILDTOOLS_TENANT ?? "moss",
        baseUrl: process.env.BUILDTOOLS_BASE_URL,
      });
      try {
        await api.authenticate(btEmail, btPassword);
      } catch (err) {
        process.stderr.write(
          `[admin] BT auth failed during SA provisioning: ${(err as Error)?.message ?? err}\n`,
        );
        const { adminNewServiceAccountPage } = await import("./pages.js");
        res.status(400).type("html").send(
          adminNewServiceAccountPage({
            userEmail: req.admin!.email,
            csrfToken: csrf,
            errorMessage:
              "BuildTools authentication failed. Check the email and password and try again.",
            prefill: { displayName, email, roleName, btEmail },
          }),
        );
        return;
      }

      try {
        const svcUser = await createServiceUser(
          deps.db,
          email,
          displayName,
          roleName,
        );
        await upsertServiceCredentials(
          deps.db,
          svcUser.id,
          "buildtools",
          { email: btEmail, password: btPassword },
          deps.encryptionKey,
        );
        const issued = await createServiceTokenRow(deps.db, {
          userId: svcUser.id,
          displayName,
          createdBy: req.admin!.id,
        });
        await logAuditEvent(deps.db, {
          userId: req.admin!.id,
          mcpServer: "admin",
          tool: "admin:create_service_account",
          result: "ok",
          metadata: {
            service_user_id: svcUser.id,
            display_name: displayName,
            role: roleName,
          },
        });
        const { adminServiceTokenCreatedPage } = await import("./pages.js");
        res.type("html").send(
          adminServiceTokenCreatedPage({
            userEmail: req.admin!.email,
            displayName,
            token: issued.token,
            serviceUserId: svcUser.id,
          }),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[admin] SA provisioning failed: ${msg}\n`,
        );
        await logAuditEvent(deps.db, {
          userId: req.admin!.id,
          mcpServer: "admin",
          tool: "admin:create_service_account",
          result: "error",
          errorMessage: msg,
          metadata: { display_name: displayName, role: roleName },
        });
        const { errorPage } = await import("./pages.js");
        res
          .status(500)
          .type("html")
          .send(errorPage("Service account creation failed. See server logs."));
      }
    },
  );

  // ----- POST /admin/service-tokens/:id/revoke ------------------------------

  router.post(
    "/admin/service-tokens/:id/revoke",
    requireAdmin,
    express.urlencoded({ extended: false }),
    async (req: AdminRequest, res) => {
      if (!guardPost(req, res).ok) return;
      const tokenId = validateUuidParam(req, res);
      if (!tokenId) return;
      try {
        await revokeServiceToken(deps.db, tokenId, req.admin!.id);
        await logAuditEvent(deps.db, {
          userId: req.admin!.id,
          mcpServer: "admin",
          tool: "admin:revoke_service_token",
          result: "ok",
          metadata: { service_token_id: tokenId },
        });
        res.redirect("/admin/users");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await logAuditEvent(deps.db, {
          userId: req.admin!.id,
          mcpServer: "admin",
          tool: "admin:revoke_service_token",
          result: "error",
          errorMessage: msg,
          metadata: { service_token_id: tokenId },
        });
        const { errorPage } = await import("./pages.js");
        res.status(500).type("html").send(errorPage(`Revoke failed: ${msg}`));
      }
    },
  );

  // ----- GET /admin/audit ---------------------------------------------------

  router.get("/admin/audit", requireAdmin, async (req: AdminRequest, res) => {
    const pageSize = 50;
    const page = Math.max(1, Number(req.query.page) || 1);
    const offset = (page - 1) * pageSize;
    const filterUserId =
      typeof req.query.user_id === "string" ? req.query.user_id : null;
    // .range is INCLUSIVE on both ends in supabase-js. Fetch pageSize+1
    // rows so we can drive hasNext without an extra COUNT, then slice
    // off the peek row so it doesn't render twice on the next page.
    let q = deps.db
      .from("mcp_audit_log")
      .select("id,created_at,user_id,tool,project_id,result,error_message")
      .order("created_at", { ascending: false })
      .range(offset, offset + pageSize); // 0..50 inclusive = 51 rows
    if (filterUserId) {
      q = q.eq("user_id", filterUserId);
    }
    const { data, error } = await q;
    if (error) {
      const { errorPage } = await import("./pages.js");
      res.status(500).type("html").send(errorPage(`Audit fetch failed: ${error.message}`));
      return;
    }
    const rows = (data ?? []) as Array<{
      id: number;
      created_at: string;
      user_id: string | null;
      tool: string;
      project_id: number | null;
      result: string;
      error_message: string | null;
    }>;
    const hasNext = rows.length > pageSize;
    // Drop the peek row so it doesn't appear on this page AND the next.
    const visible = hasNext ? rows.slice(0, pageSize) : rows;
    const { adminAuditPage } = await import("./pages.js");
    res.type("html").send(
      adminAuditPage({
        userEmail: req.admin!.email,
        rows: visible,
        page,
        hasNext,
        filterUserId,
      }),
    );
  });
}
