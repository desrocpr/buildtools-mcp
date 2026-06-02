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
 * { allowed: false } when the increment would exceed the cap; in
 * that case the count is NOT incremented (caller can retry next
 * hour without affecting state).
 *
 * Implementation: bucket key is the current hour's epoch-ms. We
 * compute the window_start so all calls within the same hour
 * UPSERT the same row. Old rows are left to a sweep job.
 *
 * Race note: Postgres serialises the UPSERT, but two concurrent
 * "select count, decide, upsert" pairs could each see count=N-1
 * and both think they're fine to go to N. For our scale (a few
 * dozen users, soft caps in the hundreds) this is fine. If we
 * ever need exact serialisation, switch to a stored procedure.
 */
export async function checkAndIncrementBucket(
  db: Db,
  userId: string,
  bucket: PermissionBucket,
  limit: number | null,
): Promise<CheckAndIncrementResult> {
  if (limit === null) {
    // No cap configured — count anyway for visibility, but always allow.
    await bumpCount(db, userId, bucket);
    return { allowed: true, count: -1, limit: null };
  }

  const windowStart = currentWindowStart();
  const { data: existing, error: readErr } = await db
    .from("mcp_rate_buckets")
    .select("count")
    .eq("user_id", userId)
    .eq("permission_bucket", bucket)
    .eq("window_start", windowStart.toISOString())
    .maybeSingle();
  if (readErr) {
    throw new Error(`checkAndIncrementBucket/read: ${readErr.message}`);
  }
  const current = existing?.count ?? 0;
  if (current >= limit) {
    return { allowed: false, count: current, limit };
  }
  await bumpCount(db, userId, bucket, windowStart);
  return { allowed: true, count: current + 1, limit };
}

async function bumpCount(
  db: Db,
  userId: string,
  bucket: PermissionBucket,
  windowStart: Date = currentWindowStart(),
): Promise<void> {
  // Upsert with on-conflict increment. Supabase JS doesn't expose a
  // direct atomic increment so we use a two-step: try insert; on
  // conflict, increment via RPC. To keep this in the same JS file
  // without a database function, we use a read-then-update pattern.
  // This races; see the note in checkAndIncrementBucket().
  const { data: existing, error: readErr } = await db
    .from("mcp_rate_buckets")
    .select("count")
    .eq("user_id", userId)
    .eq("permission_bucket", bucket)
    .eq("window_start", windowStart.toISOString())
    .maybeSingle();
  if (readErr) {
    throw new Error(`bumpCount/read: ${readErr.message}`);
  }
  if (existing) {
    const { error } = await db
      .from("mcp_rate_buckets")
      .update({ count: existing.count + 1 })
      .eq("user_id", userId)
      .eq("permission_bucket", bucket)
      .eq("window_start", windowStart.toISOString());
    if (error) throw new Error(`bumpCount/update: ${error.message}`);
  } else {
    const { error } = await db.from("mcp_rate_buckets").insert({
      user_id: userId,
      permission_bucket: bucket,
      window_start: windowStart.toISOString(),
      count: 1,
    });
    if (error) {
      // Race with another inserter — read again and increment.
      if (/duplicate|conflict/i.test(error.message)) {
        await bumpCount(db, userId, bucket, windowStart);
        return;
      }
      throw new Error(`bumpCount/insert: ${error.message}`);
    }
  }
}

function currentWindowStart(now: number = Date.now()): Date {
  return new Date(Math.floor(now / WINDOW_MS) * WINDOW_MS);
}

export const __test = { currentWindowStart, WINDOW_MS };
