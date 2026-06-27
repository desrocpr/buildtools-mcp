/**
 * Idempotency cache for mutation tools.
 *
 * When a caller passes an `idempotency_key` on a write call and that
 * call subsequently times out (or the network drops) without a clean
 * response, the caller can't tell whether BT actually saved the
 * change. Naively retrying would re-apply the write and potentially
 * create duplicates (e.g., uploading the same attachment twice,
 * appending a delta line twice).
 *
 * This store caches the SUCCESSFUL result of an idempotency-keyed
 * call. A retry with the same key + same args returns the cached
 * result immediately (no BT call). A retry with the same key but
 * DIFFERENT args returns a clear error so the caller knows their key
 * is being reused incorrectly.
 *
 * Failures aren't cached — the next attempt gets a fresh shot at BT.
 * That's the desired behavior: idempotency protects against
 * ambiguous successes, not against permanent errors.
 *
 * Design mirrors `ConfirmationStore`:
 *   - In-memory Map keyed by a stable hash; process-local.
 *   - Clock injection for testable TTLs (no fake-timers needed).
 *   - Sweep-on-cadence callable from the boot wiring; the Map can't
 *     grow unboundedly during a long-lived session.
 *
 * TTL default is 1 hour — comfortably longer than any reasonable
 * retry window but short enough that the cache doesn't grow during
 * an all-day session.
 */

import { createHash } from "node:crypto";

import type { ToolResult } from "../tools/projects.js";

interface CachedEntry {
  /** Hash of the canonicalised non-meta args. */
  argsFingerprint: string;
  /** The successful tool result that's replayed to retries. */
  result: ToolResult;
  /** Epoch ms when this entry expires. */
  expiresAt: number;
}

export type IdempotencyLookup =
  | { kind: "hit"; result: ToolResult }
  | {
      kind: "mismatch";
      storedFingerprint: string;
      incomingFingerprint: string;
    }
  | { kind: "miss" };

export class IdempotencyStore {
  private readonly cache = new Map<string, CachedEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { ttlMinutes?: number; now?: () => number } = {}) {
    this.ttlMs = (opts.ttlMinutes ?? 60) * 60_000;
    this.now = opts.now ?? Date.now;
  }

  get ttlMinutes(): number {
    return this.ttlMs / 60_000;
  }

  get ttlMilliseconds(): number {
    return this.ttlMs;
  }

  get size(): number {
    return this.cache.size;
  }

  /** Build the cache key from the tool name, owning subject, and caller's key. */
  static buildCacheKey(
    toolName: string,
    subject: string | undefined,
    idempotencyKey: string,
  ): string {
    const raw = `${toolName}\x00${subject ?? ""}\x00${idempotencyKey}`;
    return createHash("sha256").update(raw).digest("hex");
  }

  /**
   * Canonical-JSON SHA-256 of an args object. Sorts keys recursively
   * so semantically-equivalent objects produce identical fingerprints.
   * Caller is expected to have stripped meta fields (confirmation_id,
   * idempotency_key) before calling — those rotate per call and
   * shouldn't affect the fingerprint.
   */
  static fingerprintArgs(args: unknown): string {
    return createHash("sha256")
      .update(canonicalStringify(args))
      .digest("hex");
  }

  lookup(cacheKey: string, argsFingerprint: string): IdempotencyLookup {
    const entry = this.cache.get(cacheKey);
    if (!entry) return { kind: "miss" };
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(cacheKey);
      return { kind: "miss" };
    }
    if (entry.argsFingerprint !== argsFingerprint) {
      return {
        kind: "mismatch",
        storedFingerprint: entry.argsFingerprint,
        incomingFingerprint: argsFingerprint,
      };
    }
    return { kind: "hit", result: entry.result };
  }

  store(
    cacheKey: string,
    argsFingerprint: string,
    result: ToolResult,
  ): void {
    this.cache.set(cacheKey, {
      argsFingerprint,
      result,
      expiresAt: this.now() + this.ttlMs,
    });
  }

  sweep(): void {
    const cutoff = this.now();
    for (const [k, v] of this.cache) {
      if (v.expiresAt <= cutoff) this.cache.delete(k);
    }
  }

  /** Test-only: clear all entries. */
  clear(): void {
    this.cache.clear();
  }
}

/**
 * Deterministic JSON: sort object keys recursively. Used as the
 * canonical input to the args fingerprint hash so two args objects
 * with the same content but different key insertion order produce
 * the same fingerprint.
 */
function canonicalStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalStringify).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          canonicalStringify((value as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}
