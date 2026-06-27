/**
 * Outer-handler helpers for the idempotency pattern (PR #67).
 *
 * The four consolidator tools (update_purchase_order, apply_vendor_quote,
 * create_draw_request, transition_purchase_order_status) all run the same
 * skeleton:
 *
 *   1. Compute idempotency cache key + fingerprint
 *   2. Look up the cache — return cached on hit, error on mismatch,
 *      proceed on miss
 *   3. Do the actual work (resolution + confirmation flow + execute)
 *   4. Store result on success (only when this was the execute call —
 *      confirmation_id was present — and the result wasn't an error)
 *
 * This module extracts steps 1+2 (`checkIdempotency`) and step 4
 * (`storeIdempotencyResult`) so each tool's handler just calls them
 * around its tool-specific code.
 *
 * Why two functions instead of one wrapper:
 *   - The cache lookup runs BEFORE resolution; the store runs AFTER
 *     execution. A single-function wrapper would have to take a
 *     callback for the work in the middle, which obscures the
 *     control flow at the call site.
 *   - The tools have different "tool-specific" work between the
 *     lookup and store (e.g. apply_vendor_quote does vendor disambig;
 *     update_purchase_order does pre-snapshot). Forcing this into a
 *     callback shape would either bloat the helper signature or
 *     require ergonomically awkward closures.
 *
 * The two functions form a pair — `checkIdempotency` returns an
 * `IdempotencyContext` that you pass to `storeIdempotencyResult`
 * after running your work.
 */

import type { ToolResult } from "../tools/projects.js";

import { IdempotencyStore } from "./IdempotencyStore.js";

// ---------------------------------------------------------------------------
// Markdown helpers — minimal, local to this module so we don't have to
// thread the existing tool-layer helpers through.
// ---------------------------------------------------------------------------

function escapeMarkdownInline(s: unknown): string {
  if (s === undefined || s === null) return "";
  return String(s)
    .replace(/[\r\n]+/g, " ")
    .replace(/[\\`*_[\]<>]/g, (c) => `\\${c}`);
}

function errorMarkdown(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IdempotencyContext {
  /**
   * Set when caller passed an idempotency_key AND the store is wired.
   * If undefined, the store-step is a no-op (and there can be no
   * replay/mismatch responses).
   */
  cacheKey?: string;
  argsFingerprint?: string;
  /**
   * On cache hit: the cached result, ready to return verbatim. The
   * caller's outer handler should return this immediately without
   * doing any resolution work.
   */
  replayResult?: ToolResult;
  /**
   * On cache mismatch (same key, different args): an error result
   * the caller should return immediately.
   */
  mismatchError?: ToolResult;
}

export interface CheckIdempotencyOptions {
  /** Name of the calling tool — used in the cache key namespace. */
  toolName: string;
  /**
   * The shared store. When omitted, the helper short-circuits as if
   * no idempotency_key was passed (returns an empty context).
   */
  idempotencyStore?: IdempotencyStore;
  /** Owning subject — `user.id` for OAuth sessions; undefined for stdio. */
  sessionId?: string;
  /**
   * The caller-supplied idempotency key (from the tool args). When
   * undefined, the helper short-circuits.
   */
  idempotencyKey?: string;
  /**
   * The args object to fingerprint. Caller is responsible for
   * stripping meta fields (confirmation_id, idempotency_key) and
   * substituting heavy fields (file_base64 → SHA-256) before passing
   * this in — the helper just canonicalises whatever it receives.
   */
  fingerprintInput: unknown;
}

export interface StoreIdempotencyResultOptions {
  /** The context returned by `checkIdempotency` for this call. */
  context: IdempotencyContext;
  /** The shared store. Pass through verbatim from the caller. */
  idempotencyStore?: IdempotencyStore;
  /** The tool's final result. */
  result: ToolResult;
  /**
   * True when this call was the execute step (confirmation_id was
   * passed in). The cache only stores on execute calls, never on
   * the first/prompt call.
   */
  isExecuteCall: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check the idempotency cache for a prior result.
 *
 * Returns an `IdempotencyContext`. The caller's outer handler should:
 *   - return `context.replayResult` immediately if set (cache hit)
 *   - return `context.mismatchError` immediately if set (key reuse)
 *   - otherwise proceed with the normal flow, eventually calling
 *     `storeIdempotencyResult` with the same context
 *
 * When `idempotencyStore` or `idempotencyKey` is undefined, returns
 * an empty context — the caller doesn't need to special-case the
 * "no-idempotency" path.
 */
export function checkIdempotency(
  opts: CheckIdempotencyOptions,
): IdempotencyContext {
  if (!opts.idempotencyStore || !opts.idempotencyKey) {
    return {};
  }
  const cacheKey = IdempotencyStore.buildCacheKey(
    opts.toolName,
    opts.sessionId,
    opts.idempotencyKey,
  );
  const argsFingerprint = IdempotencyStore.fingerprintArgs(opts.fingerprintInput);
  const lookup = opts.idempotencyStore.lookup(cacheKey, argsFingerprint);

  if (lookup.kind === "hit") {
    const original = lookup.result;
    const banner =
      `_Idempotency replay: returning cached result for key \`${escapeMarkdownInline(opts.idempotencyKey)}\` — no BT call was made. Cache TTL ${opts.idempotencyStore.ttlMinutes} min._\n\n`;
    return {
      cacheKey,
      argsFingerprint,
      replayResult: {
        ...original,
        content: original.content.map((c) =>
          "text" in c ? { ...c, text: banner + (c.text ?? "") } : c,
        ),
      },
    };
  }
  if (lookup.kind === "mismatch") {
    return {
      cacheKey,
      argsFingerprint,
      mismatchError: errorMarkdown(
        `**Idempotency key reused with different args.** The key \`${escapeMarkdownInline(opts.idempotencyKey)}\` was previously used (within the last ${opts.idempotencyStore.ttlMinutes} min) with a DIFFERENT set of args. Use a fresh key per distinct write, or wait for the cache to expire.`,
      ),
    };
  }
  return { cacheKey, argsFingerprint };
}

/**
 * Store the tool's result in the idempotency cache.
 *
 * Stores ONLY when ALL of these are true:
 *   - The context has a cacheKey + fingerprint (caller passed key + store)
 *   - `isExecuteCall` is true (this was the execute step, not the prompt)
 *   - The result isn't an error (`isError` is not `true`)
 *
 * Returns nothing — the cache write is a side effect.
 */
export function storeIdempotencyResult(opts: StoreIdempotencyResultOptions): void {
  if (
    !opts.idempotencyStore ||
    !opts.context.cacheKey ||
    !opts.context.argsFingerprint ||
    !opts.isExecuteCall ||
    opts.result.isError === true
  ) {
    return;
  }
  opts.idempotencyStore.store(
    opts.context.cacheKey,
    opts.context.argsFingerprint,
    opts.result,
  );
}
