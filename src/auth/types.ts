/**
 * Auth-layer types (MOS-328).
 *
 * Mirror the Supabase schema; the db-access layer (Phase 2) converts
 * between snake_case rows and these camelCase TypeScript shapes.
 */

export type UserKind = "human" | "service";
export type UserStatus = "active" | "revoked";

/**
 * Permission strings tagged on each MCP tool at registration time.
 *
 *   `read`               — list/get/search/find/download tools.
 *   `write:<domain>`     — mutation tools narrowed by domain.
 *   `delete`             — destructive operations.
 *   `*`                  — admin wildcard, matches anything.
 *
 * Domains in use (extend as new tools land):
 *
 *   `financial`   — invoices, financial statements, change orders
 *   `selections`  — selections + selection options
 *   `budget`      — budget items
 *   `tasks`       — tasks, RFIs
 *   `operations`  — services, users
 *   `project`     — create_project, project mutations
 */
export type Permission = string;

export interface McpUser {
  id: string;
  kind: UserKind;
  /** Azure AD `sub` claim. Required for humans, null for service accounts. */
  azureSub: string | null;
  email: string;
  displayName: string | null;
  status: UserStatus;
  createdAt: Date;
  lastSeenAt: Date | null;
}

export interface McpRole {
  id: string;
  name: string;
  permissions: Permission[];
}

export interface McpUserWithRoles extends McpUser {
  roles: McpRole[];
  /** Flattened union of permissions across all assigned roles. */
  permissions: Permission[];
}

/** Per-(user, downstream-service) credential record. */
export interface ServiceCredentialRow {
  id: string;
  userId: string;
  service: string;
  encryptionVersion: number;
  encryptedAt: Date;
  updatedAt: Date;
  /** The raw bytea — decrypt before reading. */
  credentialsEncrypted: Buffer;
}

/** Plaintext credential payload (post-decrypt). */
export interface BuildToolsCredentials {
  email: string;
  password: string;
}

/**
 * What `hasPermission` checks. Tools declare a required permission like
 * `write:budget`; the resolver checks whether any of the user's
 * permissions match (including the `*` wildcard).
 */
export function hasPermission(
  userPermissions: Permission[],
  required: Permission,
): boolean {
  if (userPermissions.includes("*")) return true;
  if (userPermissions.includes(required)) return true;
  // Allow domain wildcards too: `write:*` matches `write:budget`.
  const colon = required.indexOf(":");
  if (colon === -1) return false;
  const head = required.slice(0, colon);
  return userPermissions.includes(`${head}:*`);
}
