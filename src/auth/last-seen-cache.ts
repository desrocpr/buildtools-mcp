/**
 * In-memory debounce for `mcp_users.last_seen_at` writes (MOS-328 Phase 7.5).
 *
 * Without this, every bearer resolution fires an UPDATE — a hot-path
 * write that produces WAL with no functional value at sub-minute
 * granularity. We dedupe by user, only firing the underlying write
 * if at least `LAST_SEEN_DEBOUNCE_MS` has elapsed since the previous
 * fire for that user.
 *
 * Single process scope; restart clears the cache (which is correct —
 * after a restart we want a fresh `last_seen_at` recorded). A future
 * multi-process deploy can either accept the duplicate writes (one
 * per process) or move this to Redis if it becomes a hot path.
 */

import type { Db } from "./db.js";
import { touchLastSeen } from "./users.js";

const LAST_SEEN_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes

const lastFireAt = new Map<string, number>();

/**
 * Best-effort throttled `last_seen_at` write. Returns immediately;
 * the DB call happens in the background if it's allowed through.
 *
 * Failures are swallowed with a stderr log — this is fire-and-forget
 * by design.
 */
export function touchLastSeenDebounced(db: Db, userId: string): void {
  const now = Date.now();
  const previous = lastFireAt.get(userId) ?? 0;
  if (now - previous < LAST_SEEN_DEBOUNCE_MS) return;
  lastFireAt.set(userId, now);
  touchLastSeen(db, userId).catch((err) => {
    process.stderr.write(
      `[last-seen-cache] touchLastSeen failed: ${(err as Error)?.message ?? err}\n`,
    );
  });
}

/** Exposed for tests / manual cache resets. */
export function __clearLastSeenCache(): void {
  lastFireAt.clear();
}

export const __test = { LAST_SEEN_DEBOUNCE_MS };
