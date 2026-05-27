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
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
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
   */
  create<T>(toolName: string, args: T, description: string): string {
    const id = randomUUID();
    const createdAt = this.now();
    this.pending.set(id, {
      id,
      toolName,
      args,
      description,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    });
    return id;
  }

  /**
   * Atomically delete + return the pending entry. Returns `null` if the ID is
   * unknown OR if the entry has expired (in which case the stale entry is
   * also dropped from the map).
   *
   * Single-use: a successful `consume(id)` followed by `consume(id)` always
   * returns `null` the second time.
   */
  consume<T>(id: string): PendingMutation<T> | null {
    const entry = this.pending.get(id) as PendingMutation<T> | undefined;
    if (!entry) return null;
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
) => Promise<ToolResult> {
  return async (args, store) => {
    // Strip the confirmation_id BEFORE describing or storing — the describer
    // shouldn't see it, and the stored `args` should not embed a token that
    // will be replaced on the second call anyway.
    const { confirmation_id, ...rest } = args as T & {
      confirmation_id?: string;
    };
    const cleanArgs = rest as unknown as T;

    if (!confirmation_id) {
      const description = describer(cleanArgs);
      const id = store.create(toolName, cleanArgs, description);
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

    const entry = store.consume<T>(confirmation_id);
    if (!entry || entry.toolName !== toolName) {
      return {
        content: [
          {
            type: "text",
            text:
              `Confirmation \`${confirmation_id}\` is expired, unknown, or does not match \`${toolName}\`. ` +
              `Please re-invoke \`${toolName}\` without a confirmation_id to get a fresh prompt.`,
          },
        ],
      };
    }
    return executor(entry.args);
  };
}
