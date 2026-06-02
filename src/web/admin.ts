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
import { upsertServiceCredentials } from "../auth/credentials.js";
import type { Db } from "../auth/db.js";
import { revokeAllTokensForUser } from "../auth/oauth-store.js";
import {
  createServiceTokenRow,
  revokeServiceToken,
} from "../auth/service-tokens.js";
import {
  assignRoleByName,
  createServiceUser,
  getUserWithRoles,
  listUsers,
  removeRoleByName,
  setUserStatus,
} from "../auth/users.js";
import type { McpUserWithRoles } from "../auth/types.js";
import { readSession } from "./enroll.js";

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
      const userId = String(req.params.id);
      const role = typeof req.body?.role === "string" ? req.body.role : "";
      const action = req.body?.action === "remove" ? "remove" : "add";
      if (!role) {
        res.status(400).type("text/plain").send("role is required");
        return;
      }
      try {
        if (action === "add") {
          await assignRoleByName(deps.db, userId, role, req.admin!.id);
        } else {
          await removeRoleByName(deps.db, userId, role);
        }
        res.redirect("/admin/users");
      } catch (err) {
        const { errorPage } = await import("./pages.js");
        const msg = err instanceof Error ? err.message : String(err);
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
      const userId = String(req.params.id);
      if (userId === req.admin!.id) {
        const { errorPage } = await import("./pages.js");
        res
          .status(400)
          .type("html")
          .send(errorPage("Cannot revoke yourself. Have another admin do it."));
        return;
      }
      await setUserStatus(deps.db, userId, "revoked");
      await revokeAllTokensForUser(deps.db, userId);
      res.redirect("/admin/users");
    },
  );

  // ----- GET /admin/service-accounts/new ------------------------------------

  router.get(
    "/admin/service-accounts/new",
    requireAdmin,
    async (req: AdminRequest, res) => {
      const { adminNewServiceAccountPage } = await import("./pages.js");
      res.type("html").send(adminNewServiceAccountPage({ userEmail: req.admin!.email }));
    },
  );

  // ----- POST /admin/service-accounts/new -----------------------------------

  router.post(
    "/admin/service-accounts/new",
    requireAdmin,
    express.urlencoded({ extended: false }),
    async (req: AdminRequest, res) => {
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

      if (!displayName || !email || !btEmail || !btPassword) {
        const { adminNewServiceAccountPage } = await import("./pages.js");
        res.status(400).type("html").send(
          adminNewServiceAccountPage({
            userEmail: req.admin!.email,
            errorMessage:
              "display_name, email, bt_email, and bt_password are all required.",
            prefill: { displayName, email, roleName, btEmail },
          }),
        );
        return;
      }

      // Validate the BT login first — refuse to provision a service
      // account whose BT credentials don't actually work.
      const api = new BuildToolsAPI({
        tenant: process.env.BUILDTOOLS_TENANT ?? "moss",
        baseUrl: process.env.BUILDTOOLS_BASE_URL,
      });
      try {
        await api.authenticate(btEmail, btPassword);
      } catch (err) {
        const { adminNewServiceAccountPage } = await import("./pages.js");
        const msg = err instanceof Error ? err.message : String(err);
        res.status(400).type("html").send(
          adminNewServiceAccountPage({
            userEmail: req.admin!.email,
            errorMessage: `BuildTools login failed: ${msg}`,
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
        const { errorPage } = await import("./pages.js");
        const msg = err instanceof Error ? err.message : String(err);
        res
          .status(400)
          .type("html")
          .send(errorPage(`Service account creation failed: ${msg}`));
      }
    },
  );

  // ----- POST /admin/service-tokens/:id/revoke ------------------------------

  router.post(
    "/admin/service-tokens/:id/revoke",
    requireAdmin,
    express.urlencoded({ extended: false }),
    async (req: AdminRequest, res) => {
      await revokeServiceToken(deps.db, String(req.params.id), req.admin!.id);
      res.redirect("/admin/users");
    },
  );

  // ----- GET /admin/audit ---------------------------------------------------

  router.get("/admin/audit", requireAdmin, async (req: AdminRequest, res) => {
    const pageSize = 50;
    const page = Math.max(1, Number(req.query.page) || 1);
    const offset = (page - 1) * pageSize;
    const filterUserId =
      typeof req.query.user_id === "string" ? req.query.user_id : null;
    let q = deps.db
      .from("mcp_audit_log")
      .select("id,created_at,user_id,tool,project_id,result,error_message")
      .order("created_at", { ascending: false })
      .range(offset, offset + pageSize);
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
