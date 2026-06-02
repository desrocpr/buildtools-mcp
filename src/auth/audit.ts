/**
 * Audit log + sliding-window rate limiter (MOS-328 Phase 2).
 *
 * The audit log records every tool call (success or failure) keyed by
 * user, tool, and result. The rate limiter is a counter-per-bucket
 * keyed by (user, permission_bucket) with a 1-hour sliding window.
 *
 * Both write to Supabase. Audit log writes are fire-and-forget from
 * the dispatcher's perspective — they don't fail tool calls.
 */

import type { Db } from "./db.js";

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export type AuditResult = "ok" | "error" | "denied" | "rate_limited";

export type AuditTokenKind = "oauth-access" | "service";

export interface AuditEvent {
  userId: string | null;
  mcpServer?: string;
  tool: string;
  projectId?: number | null;
  result: AuditResult;
  errorMessage?: string | null;
  tokenId?: string | null;
  tokenKind?: AuditTokenKind | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Insert one audit row. Errors are swallowed and stderr-logged so that
 * a transient Supabase blip can't take down tool dispatch.
 */
export async function logAuditEvent(
  db: Db,
  event: AuditEvent,
): Promise<void> {
  try {
    const { error } = await db.from("mcp_audit_log").insert({
      user_id: event.userId,
      mcp_server: event.mcpServer ?? "buildtools",
      tool: event.tool,
      project_id: event.projectId ?? null,
      result: event.result,
      error_message: event.errorMessage ?? null,
      token_id: event.tokenId ?? null,
      token_kind: event.tokenKind ?? null,
      metadata: event.metadata ?? null,
    });
    if (error) {
      // eslint-disable-next-line no-console
      console.error(`[audit] insert failed: ${error.message}`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[audit] unexpected: ${(err as Error)?.message ?? err}`);
  }
}

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

/**
 * The sliding-window granularity. We bucket by the hour for both
 * write efficiency (one upsert per bucket per hour) and acceptable
 * accuracy (the cap is "around N per hour", not millisecond-perfect).
 */
const WINDOW_MS = 60 * 60 * 1000;

export type PermissionBucket = "read" | "write" | "delete";

export interface RateLimit {
  bucket: PermissionBucket;
  /** Max events allowed within one sliding 1-hour window. */
  perHour: number;
}

/**
 * Per-role rate ceilings. Looked up by `roleName` after permission
 * resolution.
 */
export const RATE_LIMITS_BY_ROLE: Record<string, RateLimit[]> = {
  viewer: [{ bucket: "read", perHour: 1000 }],
  editor: [
    { bucket: "read", perHour: 1000 },
    { bucket: "write", perHour: 200 },
  ],
  admin: [
    { bucket: "read", perHour: 1000 },
    { bucket: "write", perHour: 500 },
    { bucket: "delete", perHour: 50 },
  ],
  harness: [
    { bucket: "read", perHour: 5000 },
    { bucket: "write", perHour: 500 },
  ],
};

/**
 * Map a permission tag to a bucket name. `read` → `read`,
 * `write:*` → `write`, `delete` → `delete`.
 */
export function bucketFor(permission: string): PermissionBucket | null {
  if (permission === "read") return "read";
  if (permission === "delete") return "delete";
  if (permission.startsWith("write")) return "write";
  return null;
}

/**
 * Pick the most restrictive limit across this user's roles for a
 * given bucket. (We take the MIN, not the SUM — being in multiple
 * roles shouldn't multiply your ceiling.)
 *
 * Actually we MAX — the harness role + viewer role should get the
 * harness's higher ceiling, not viewer's lower. Verified against
 * the role table: there's no "permission stripping" role.
 */
export function maxLimitFor(
  roleNames: string[],
  bucket: PermissionBucket,
): number | null {
  let limit: number | null = null;
  for (const role of roleNames) {
    const limits = RATE_LIMITS_BY_ROLE[role];
    if (!limits) continue;
    for (const l of limits) {
      if (l.bucket !== bucket) continue;
      if (limit === null || l.perHour > limit) limit = l.perHour;
    }
  }
  return limit;
}

export interface CheckAndIncrementResult {
  allowed: boolean;
  /** Current count in the window AFTER this attempt. */
  count: number;
  /** The ceiling that applied. Null = no limit configured. */
  limit: number | null;
}

/**
 * Atomically check + increment the bucket count for a user. Returns
 * `{ allowed: false }` when the increment would exceed the cap; in
 * that case the count is NOT incremented (caller can retry next
 * hour without affecting state).
 *
 * Implementation (Phase 6.5): delegates to the Postgres function
 * `public.increment_rate_bucket`, which does an INSERT-ON-CONFLICT
 * + row-locked UPDATE in a single transaction — replaces the
 * previous select-then-write pattern that allowed two concurrent
 * calls to both pass the limit check.
 */
export async function checkAndIncrementBucket(
  db: Db,
  userId: string,
  bucket: PermissionBucket,
  limit: number | null,
): Promise<CheckAndIncrementResult> {
  const windowStart = currentWindowStart();
  const { data, error } = await db.rpc("increment_rate_bucket", {
    p_user_id: userId,
    p_bucket: bucket,
    p_window_start: windowStart.toISOString(),
    p_limit: limit,
  });
  if (error) {
    throw new Error(`checkAndIncrementBucket: ${error.message}`);
  }
  // RPC returns a single-row table; supabase-js gives us an array.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    throw new Error("checkAndIncrementBucket: empty RPC response");
  }
  return {
    allowed: Boolean(row.allowed),
    count: typeof row.new_count === "number" ? row.new_count : 0,
    limit,
  };
}

function currentWindowStart(now: number = Date.now()): Date {
  return new Date(Math.floor(now / WINDOW_MS) * WINDOW_MS);
}

export const __test = { currentWindowStart, WINDOW_MS };
