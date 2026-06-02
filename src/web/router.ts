/**
 * Mounts enrollment + OAuth routes onto an Express app (MOS-328
 * Phase 4-5). Gated by `MCP_OAUTH_ENABLED=true` in the calling
 * transport — when off, none of this runs and the server behaves
 * exactly as before.
 *
 * The caller is responsible for:
 *   - parsing application/x-www-form-urlencoded and application/json
 *     bodies (we don't add the middleware here; the transport already
 *     has its own opinions about body parsing)
 *   - excluding /oauth/*, /enroll/*, and /.well-known/* paths from
 *     its existing bearer-token middleware (those routes have their
 *     own auth)
 */

import express, { type Application, type Router } from "express";

import {
  discoverAzureConfig,
  loadAzureConfig,
  type AzureConfig,
} from "../auth/azure.js";
import { createDb, type Db } from "../auth/db.js";
import { loadEncryptionKey } from "../auth/encryption.js";
import { mountEnrollRoutes } from "./enroll.js";
import { mountOAuthRoutes } from "./oauth.js";

export interface MountWebRoutesOptions {
  /** Public base URL — e.g. https://buildtools-mcp.mossbuildinganddesign.com */
  publicOrigin: string;
  /** Optional injection points for tests. */
  db?: Db;
  encryptionKey?: Buffer;
  azure?: AzureConfig;
}

export interface WebRouteHandles {
  /** Same Db instance that's wired into all routes — re-use from the dispatcher. */
  db: Db;
  encryptionKey: Buffer;
  azure: AzureConfig;
}

/**
 * Resolve all auth dependencies, build a router, mount enrollment +
 * OAuth routes on it, and return the router plus the shared
 * dependencies (the dispatcher needs them for token resolution).
 */
export async function mountWebRoutes(
  app: Application,
  opts: MountWebRoutesOptions,
): Promise<WebRouteHandles> {
  const db = opts.db ?? createDb();
  const encryptionKey = opts.encryptionKey ?? loadEncryptionKey();
  const azure = opts.azure ?? loadAzureConfig();
  const azureDiscovery = await discoverAzureConfig(azure);

  // One router holds enrollment + OAuth so they can be mounted together.
  const router: Router = express.Router();
  router.use(express.urlencoded({ extended: false }));
  router.use(express.json());

  mountEnrollRoutes(router, {
    db,
    encryptionKey,
    azure,
    azureDiscovery,
    publicOrigin: opts.publicOrigin,
  });
  mountOAuthRoutes(router, {
    db,
    encryptionKey,
    azure,
    azureDiscovery,
    publicOrigin: opts.publicOrigin,
  });

  app.use(router);
  return { db, encryptionKey, azure };
}

/**
 * Path prefixes that should be EXCLUDED from the transport's bearer
 * middleware. Used by `transports/http.ts` to decide whether to
 * delegate auth to the OAuth/enrollment routes.
 */
export const PUBLIC_ROUTE_PREFIXES = [
  "/oauth/",
  "/.well-known/",
  "/enroll",
];

export function isPublicRoute(path: string): boolean {
  // Equality match for /enroll, prefix match for the rest.
  if (path === "/enroll") return true;
  return PUBLIC_ROUTE_PREFIXES.some((p) =>
    p.endsWith("/") ? path.startsWith(p) : path === p,
  );
}
