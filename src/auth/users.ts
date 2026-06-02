/**
 * User + role CRUD against `mcp_users`, `mcp_roles`, `mcp_user_roles`
 * (MOS-328 Phase 2).
 *
 * Used by:
 *   - Enrollment flow: provisions a human user the first time they
 *     sign in with Microsoft, assigns the `viewer` default role.
 *   - Admin endpoints: list/promote/revoke.
 *   - Token resolver: looks up the user behind a bearer token and
 *     resolves their effective permission set.
 *
 * Snake_case ↔ camelCase boundary lives here. The rest of the codebase
 * only sees the camelCase shapes from `./types.ts`.
 */

import type { Db } from "./db.js";
import type { McpRole, McpUser, McpUserWithRoles, UserKind, UserStatus } from "./types.js";

// ---------------------------------------------------------------------------
// Row-to-shape converters
// ---------------------------------------------------------------------------

interface UserRow {
  id: string;
  kind: UserKind;
  azure_sub: string | null;
  email: string;
  display_name: string | null;
  status: UserStatus;
  created_at: string;
  last_seen_at: string | null;
}

interface RoleRow {
  id: string;
  name: string;
  permissions: string[];
}

function rowToUser(row: UserRow): McpUser {
  return {
    id: row.id,
    kind: row.kind,
    azureSub: row.azure_sub,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    createdAt: new Date(row.created_at),
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at) : null,
  };
}

function rowToRole(row: RoleRow): McpRole {
  return { id: row.id, name: row.name, permissions: row.permissions };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getUserByAzureSub(
  db: Db,
  azureSub: string,
): Promise<McpUser | null> {
  const { data, error } = await db
    .from("mcp_users")
    .select("*")
    .eq("azure_sub", azureSub)
    .maybeSingle();
  if (error) throw new Error(`getUserByAzureSub: ${error.message}`);
  return data ? rowToUser(data as UserRow) : null;
}

export async function getUserById(db: Db, id: string): Promise<McpUser | null> {
  const { data, error } = await db
    .from("mcp_users")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getUserById: ${error.message}`);
  return data ? rowToUser(data as UserRow) : null;
}

export async function getUserWithRoles(
  db: Db,
  id: string,
): Promise<McpUserWithRoles | null> {
  const user = await getUserById(db, id);
  if (!user) return null;
  const roles = await getRolesForUser(db, id);
  const permissions = Array.from(
    new Set(roles.flatMap((r) => r.permissions)),
  );
  return { ...user, roles, permissions };
}

export async function getRolesForUser(
  db: Db,
  userId: string,
): Promise<McpRole[]> {
  const { data, error } = await db
    .from("mcp_user_roles")
    .select("role:mcp_roles(*)")
    .eq("user_id", userId);
  if (error) throw new Error(`getRolesForUser: ${error.message}`);
  // The PostgREST embed gives us [{role: {...} | null}, ...]; the
  // generic supabase-js typing assumes the inner shape is always an
  // array, hence the unknown widening.
  const embed = data as unknown as Array<{ role: RoleRow | null }> | null;
  return (
    embed
      ?.map((row) => row.role)
      .filter((r): r is RoleRow => r !== null)
      .map(rowToRole) ?? []
  );
}

export async function getRoleByName(
  db: Db,
  name: string,
): Promise<McpRole | null> {
  const { data, error } = await db
    .from("mcp_roles")
    .select("*")
    .eq("name", name)
    .maybeSingle();
  if (error) throw new Error(`getRoleByName: ${error.message}`);
  return data ? rowToRole(data as RoleRow) : null;
}

export async function listUsers(db: Db): Promise<McpUserWithRoles[]> {
  const { data, error } = await db
    .from("mcp_users")
    .select("*, mcp_user_roles(role:mcp_roles(*))")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listUsers: ${error.message}`);
  const rows = data as unknown as Array<
    UserRow & { mcp_user_roles: Array<{ role: RoleRow | null }> }
  > | null;
  return (
    rows?.map((row) => {
      const user = rowToUser(row);
      const roles = (row.mcp_user_roles ?? [])
        .map((r) => r.role)
        .filter((r): r is RoleRow => r !== null)
        .map(rowToRole);
      const permissions = Array.from(
        new Set(roles.flatMap((r) => r.permissions)),
      );
      return { ...user, roles, permissions };
    }) ?? []
  );
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface UpsertHumanUserInput {
  azureSub: string;
  email: string;
  displayName?: string | null;
  /** Role name to assign on FIRST insert only. Default `'viewer'`. */
  defaultRoleName?: string;
}

/**
 * Idempotent upsert for human users. If a row already exists for the
 * given Azure `sub`, returns it (and assigns no roles — that's
 * managed via assignRole). Otherwise creates the row, assigns the
 * default role, and returns the newly-resolved user.
 */
export async function upsertHumanUser(
  db: Db,
  input: UpsertHumanUserInput,
): Promise<McpUserWithRoles> {
  const existing = await getUserByAzureSub(db, input.azureSub);
  if (existing) {
    // Touch last_seen_at and refresh email/display_name in case Azure
    // returns updated values. Don't change status or roles.
    const { data, error } = await db
      .from("mcp_users")
      .update({
        email: input.email,
        display_name: input.displayName ?? existing.displayName,
        last_seen_at: new Date().toISOString(),
      })
      .eq("id", existing.id)
      .select()
      .single();
    if (error) throw new Error(`upsertHumanUser/update: ${error.message}`);
    const updated = rowToUser(data as UserRow);
    const roles = await getRolesForUser(db, updated.id);
    const permissions = Array.from(
      new Set(roles.flatMap((r) => r.permissions)),
    );
    return { ...updated, roles, permissions };
  }

  // New user.
  const { data, error } = await db
    .from("mcp_users")
    .insert({
      kind: "human",
      azure_sub: input.azureSub,
      email: input.email,
      display_name: input.displayName ?? null,
      status: "active",
      last_seen_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw new Error(`upsertHumanUser/insert: ${error.message}`);
  const created = rowToUser(data as UserRow);

  // Assign the default role.
  const defaultRoleName = input.defaultRoleName ?? "viewer";
  await assignRoleByName(db, created.id, defaultRoleName);

  const roles = await getRolesForUser(db, created.id);
  const permissions = Array.from(new Set(roles.flatMap((r) => r.permissions)));
  return { ...created, roles, permissions };
}

export async function createServiceUser(
  db: Db,
  email: string,
  displayName: string,
  roleName: string,
): Promise<McpUser> {
  const { data, error } = await db
    .from("mcp_users")
    .insert({
      kind: "service",
      azure_sub: null,
      email,
      display_name: displayName,
      status: "active",
    })
    .select()
    .single();
  if (error) throw new Error(`createServiceUser: ${error.message}`);
  const created = rowToUser(data as UserRow);
  await assignRoleByName(db, created.id, roleName);
  return created;
}

export async function assignRoleByName(
  db: Db,
  userId: string,
  roleName: string,
  assignedBy: string | null = null,
): Promise<void> {
  const role = await getRoleByName(db, roleName);
  if (!role) {
    throw new Error(`assignRoleByName: role '${roleName}' not found`);
  }
  const { error } = await db
    .from("mcp_user_roles")
    .upsert(
      { user_id: userId, role_id: role.id, assigned_by: assignedBy },
      { onConflict: "user_id,role_id" },
    );
  if (error) throw new Error(`assignRoleByName: ${error.message}`);
}

export async function removeRoleByName(
  db: Db,
  userId: string,
  roleName: string,
): Promise<void> {
  const role = await getRoleByName(db, roleName);
  if (!role) return;
  const { error } = await db
    .from("mcp_user_roles")
    .delete()
    .eq("user_id", userId)
    .eq("role_id", role.id);
  if (error) throw new Error(`removeRoleByName: ${error.message}`);
}

export async function setUserStatus(
  db: Db,
  userId: string,
  status: UserStatus,
): Promise<void> {
  const { error } = await db
    .from("mcp_users")
    .update({ status })
    .eq("id", userId);
  if (error) throw new Error(`setUserStatus: ${error.message}`);
}

export async function touchLastSeen(db: Db, userId: string): Promise<void> {
  const { error } = await db
    .from("mcp_users")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", userId);
  if (error) throw new Error(`touchLastSeen: ${error.message}`);
}
