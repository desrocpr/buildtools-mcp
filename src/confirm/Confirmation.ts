/**
 * Confirmation framework for mutating MCP tools (MOS-217, Phase 4).
 *
 * Every mutation tool registered by Phase 5 (MOS-218 / MOS-219) routes its
 * handler through this two-step pattern:
 *
 *   1. The first invocation (no `confirmation_id`) records the pending
 *      mutation in the in-process `ConfirmationStore` and returns a Markdown
 *      prompt telling Claude Desktop to re-invoke the same tool with the
 *      generated `confirmation_id`.
 *   2. The second invocation (with `confirmation_id`) consumes the pending
 *      entry exactly once and runs the supplied `executor`.
 *
 * The store is intentionally process-local and in-memory: Phase 4 only needs
 * to gate writes from a single stdio Claude Desktop client. Phase 6
 * (MOS-220 — HTTP/SSE transport) will revisit isolation if/when multiple
 * concurrent sessions become real.
 *
 * Design choices flagged by the planner contract:
 *
 *   - **Clock injection**. The constructor accepts an optional `now: () =>
 *     number` so TTL behaviour can be tested deterministically without
 *     real-time waits. This is preferred over `vi.useFakeTimers()` here
 *     because the store is itself a long-lived singleton (boot-time
 *     `setInterval`), and we don't want test fake-timer state leaking into
 *     the helper's runtime use.
 *   - **Sweep cadence** matches the TTL (default 5 min). `src/index.ts` is
 *     responsible for scheduling `sweep()` on an `.unref()`ed interval so the
 *     stdio process can still exit cleanly when Claude Desktop disconnects.
 *   - **Helper return shape**. `requiresConfirmation` returns a handler with
 *     signature `(args, store) => Promise<ToolResult>`. It does NOT match the
 *     existing read-tool `ToolDefinition.handler` signature on purpose: no
 *     tool is being registered here. Phase 5 will adapt at the registration
 *     site by closing over the boot-time `ConfirmationStore` and a
 *     `BuildToolsAPI` reference.
 *   - **`describer` args are pre-validation.** Phase 5 mutation tools are
 *     expected to Zod-validate their inputs BEFORE calling the confirmation
 *     flow — consistent with how the existing read tools in
 *     `src/tools/projects.ts` wrap their handlers. The describer should
 *     therefore assume well-typed `T`.
 *   - **Error shape for re-invoke prompts.** Confirmation-mismatch / expired
 *     responses leave `isError` unset — this is a user-flow message
 *     ("re-invoke me"), not a genuine error. Genuine BuildTools failures
 *     surfaced by the underlying `executor` continue to set `isError: true`
 *     the way read tools do today.
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single pending mutation awaiting confirmation. */
export interface PendingMutation<T> {
  /** Opaque, single-use confirmation token (UUID v4). */
  id: string;
  /** Tool name that created the pending entry — used to bind the token. */
  toolName: string;
  /**
   * Owning subject — `user.id` for OAuth/service sessions so the same
   * user can complete a two-step mutation across multiple SSE sessions
   * (Claude Desktop opens a fresh session per call). `undefined` for
   * stdio + legacy-bearer sessions (no per-user isolation needed).
   *
   * Field name kept as `sessionId` for backwards compat — the semantic
   * is "subject scoping the entry", not literally a session ID.
   */
  sessionId?: string;
  /** Original tool args captured at create-time, replayed on consume. */
  args: T;
  /** Human-readable summary of the action (rendered back to Claude). */
  description: string;
  /** Epoch ms — when this entry was created. */
  createdAt: number;
  /** Epoch ms — when this entry expires (createdAt + ttlMs). */
  expiresAt: number;
}

/**
 * Local copy of the MCP tool-call response shape. Duplicated rather than
 * imported from `src/tools/projects.ts` to keep `src/confirm/**` independent
 * of the read-tool surface — Phase 5 will eventually unify these.
 */
export type ToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | {
      type: "resource";
      resource: {
        uri: string;
        mimeType?: string;
        text?: string;
        blob?: string;
        _meta?: Record<string, unknown>;
      };
    };

export interface ToolResult {
  content: ToolResultContent[];
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * In-memory map of `confirmation_id` → pending mutation. Single-use:
 * `consume(id)` always deletes (whether it returns the entry or `null`
 * because of expiry).
 */
export class ConfirmationStore {
  private readonly pending = new Map<string, PendingMutation<unknown>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  /**
   * @param ttlMinutes — confirmation TTL in minutes. Default 5.
   * @param now — clock injection point for tests. Default `Date.now`.
   */
  constructor(ttlMinutes: number = 5, now: () => number = () => Date.now()) {
    this.ttlMs = ttlMinutes * 60_000;
    this.now = now;
  }

  /** TTL in minutes (round-tripped from the constructor). For tests + docs. */
  get ttlMinutes(): number {
    return this.ttlMs / 60_000;
  }

  /** TTL in milliseconds (for tests / internal use). */
  get ttlMilliseconds(): number {
    return this.ttlMs;
  }

  /** Number of pending entries currently held. Exposed for tests. */
  get size(): number {
    return this.pending.size;
  }

  /**
   * Record a pending mutation and return its single-use confirmation ID.
   * Callers re-render that ID into a Markdown prompt for Claude Desktop.
   *
   * When `sessionId` is provided (HTTP/SSE multi-user transport), the
   * entry is bound to that session — only a consume() call with the
   * same sessionId can read it. stdio callers omit sessionId.
   */
  create<T>(
    toolName: string,
    args: T,
    description: string,
    sessionId?: string,
  ): string {
    const id = randomUUID();
    const createdAt = this.now();
    this.pending.set(id, {
      id,
      toolName,
      sessionId,
      args,
      description,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    });
    return id;
  }

  /**
   * Atomically delete + return the pending entry. Returns `null` if the ID is
   * unknown OR the entry has expired OR the entry's sessionId doesn't match
   * the requested `sessionId`.
   *
   * **Session mismatch does NOT delete the entry** — that would let User B
   * deny-of-service User A's pending mutations by guessing IDs. The
   * legitimate owner can still consume.
   *
   * Single-use: a successful `consume(id, ...)` followed by another consume
   * with the same ID returns `null` the second time.
   */
  consume<T>(id: string, sessionId?: string): PendingMutation<T> | null {
    const entry = this.pending.get(id) as PendingMutation<T> | undefined;
    if (!entry) return null;
    // Session check first — do NOT touch the map if the caller can't claim
    // this entry. Allows the legitimate owner to consume later.
    if (entry.sessionId !== sessionId) return null;
    // Drop the entry whether it's expired or live — the only way to keep an
    // entry across calls is to NOT call consume() on it.
    this.pending.delete(id);
    if (entry.expiresAt < this.now()) return null;
    return entry;
  }

  /**
   * Sweep + drop expired entries. Idempotent. Intended to be called on a
   * timer by the server boot code; tests call it directly.
   */
  sweep(): void {
    const now = this.now();
    for (const [id, entry] of this.pending) {
      if (entry.expiresAt < now) this.pending.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Higher-order helper
// ---------------------------------------------------------------------------

/**
 * Wrap a mutation `executor` in the two-step confirmation handshake.
 *
 * - On the FIRST call (no `confirmation_id` on `args`) the helper records a
 *   pending entry, then returns a Markdown prompt that contains the
 *   describer text, the generated `confirmation_id`, and the tool name. The
 *   `executor` is NOT invoked.
 *
 * - On the SECOND call (with `confirmation_id` matching a live entry whose
 *   `toolName` matches) the helper consumes the entry and invokes the
 *   `executor` exactly once, passing the ORIGINAL args captured at create
 *   time (NOT the second-call args — so a malicious or accidental arg
 *   substitution between confirm and execute is ignored).
 *
 * - On the SECOND call with an unknown / expired / wrong-tool ID, the helper
 *   returns a "please re-invoke" Markdown message; the `executor` is NOT
 *   invoked.
 *
 * The `describer` runs on the user-supplied args before any Zod validation
 * inside the executor; Phase 5 tools are expected to validate args BEFORE
 * calling into this helper (see file-level comment).
 */
export function requiresConfirmation<T extends object>(
  toolName: string,
  describer: (args: T) => string,
  executor: (args: T) => Promise<ToolResult>,
): (
  args: T & { confirmation_id?: string },
  store: ConfirmationStore,
  sessionId?: string,
) => Promise<ToolResult> {
  return async (args, store, sessionId) => {
    // Strip the confirmation_id BEFORE describing or storing — the describer
    // shouldn't see it, and the stored `args` should not embed a token that
    // will be replaced on the second call anyway.
    const { confirmation_id, ...rest } = args as T & {
      confirmation_id?: string;
    };
    const cleanArgs = rest as unknown as T;

    if (!confirmation_id) {
      const description = describer(cleanArgs);
      const id = store.create(toolName, cleanArgs, description, sessionId);
      const ttlMinutes = store.ttlMinutes;
      return {
        content: [
          {
            type: "text",
            text:
              `⚠️ This will modify BuildTools production data via \`${toolName}\`.\n\n` +
              `${description}\n\n` +
              `To proceed, re-invoke \`${toolName}\` with ` +
              `confirmation_id: "${id}". ` +
              `This confirmation expires in ${ttlMinutes} minute${ttlMinutes === 1 ? "" : "s"}.`,
          },
        ],
      };
    }

    const entry = store.consume<T>(confirmation_id, sessionId);
    if (!entry || entry.toolName !== toolName) {
      return markNotExecuted({
        content: [
          {
            type: "text",
            text:
              `Confirmation \`${confirmation_id}\` is expired, unknown, or does not match \`${toolName}\`. ` +
              `Please re-invoke \`${toolName}\` without a confirmation_id to get a fresh prompt.`,
          },
        ],
      });
    }
    return executor(entry.args);
  };
}

/**
 * Results the confirmation framework produced INSTEAD of running the executor.
 *
 * A caller cannot tell these apart from a real result by inspection: the
 * expired/unknown-confirmation message deliberately leaves `isError` unset (see
 * the note at the top of this file), and outer handlers infer "this was the
 * execute call" from `confirmation_id` merely being PRESENT — which it is on a
 * request carrying an expired one.
 *
 * That combination poisons the idempotency cache. Sequence: call with
 * `idempotency_key: "X"` and a stale `confirmation_id` -> the framework returns
 * "expired" without executing -> the outer handler sees a confirmation_id and
 * a non-error result -> it caches "expired" under "X". Every later call with
 * that key, including a correct two-step confirm, replays the stale message
 * until the cache TTL elapses. No write was ever attempted, and the key is
 * unusable for an hour.
 *
 * Marking the result is what lets `storeIdempotencyResult` refuse to cache it,
 * and it fixes every tool at once rather than one call site.
 */
const NOT_EXECUTED = new WeakSet<ToolResult>();

function markNotExecuted(result: ToolResult): ToolResult {
  NOT_EXECUTED.add(result);
  return result;
}

/** False only when the confirmation framework short-circuited the executor. */
export function didExecute(result: ToolResult): boolean {
  return !NOT_EXECUTED.has(result);
}
