/**
 * Unit tests for the confirmation framework (MOS-217, Phase 4).
 *
 * The store uses an injectable clock (`now: () => number` constructor arg) so
 * TTL behaviour can be tested deterministically — no real-time `setTimeout`
 * waits, per the planner contract.
 */

import { describe, expect, it, vi } from "vitest";

import {
  ConfirmationStore,
  requiresConfirmation,
  type ToolResult,
} from "../Confirmation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a `ConfirmationStore` with a controllable virtual clock. Tests can
 * tick the clock forward without touching real timers.
 */
function storeWithClock(ttlMinutes = 5) {
  let virtualNow = 0;
  const store = new ConfirmationStore(ttlMinutes, () => virtualNow);
  return {
    store,
    advanceMs(ms: number) {
      virtualNow += ms;
    },
    setNow(ms: number) {
      virtualNow = ms;
    },
    nowMs() {
      return virtualNow;
    },
  };
}

/** Full-string UUID v4 match (anchored). Used when asserting `create()`'s return. */
const UUID_FULL_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Unanchored UUID match. Used when scanning a Markdown prompt for the id. */
const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function textOf(result: ToolResult): string {
  return result.content.map((c) => ("text" in c ? c.text : "")).join("");
}

// ---------------------------------------------------------------------------
// ConfirmationStore
// ---------------------------------------------------------------------------

describe("ConfirmationStore", () => {
  it("defaults TTL to 5 minutes when unspecified", () => {
    const store = new ConfirmationStore();
    expect(store.ttlMinutes).toBe(5);
    expect(store.ttlMilliseconds).toBe(5 * 60_000);
  });

  it("create() returns a non-empty UUID and stores a single entry", () => {
    const { store } = storeWithClock();
    const id = store.create("create_project", { name: "X" }, "desc");
    expect(id).toMatch(UUID_FULL_RE);
    expect(store.size).toBe(1);
  });

  it("create() then consume() returns the entry exactly once with all fields populated", () => {
    const { store, setNow } = storeWithClock(5);
    setNow(1_700_000_000_000);
    const args = { project_id: 42, note: "hi" };
    const id = store.create("update_project", args, "Update project 42");
    const entry = store.consume<typeof args>(id);
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe(id);
    expect(entry!.toolName).toBe("update_project");
    expect(entry!.args).toEqual(args);
    expect(entry!.description).toBe("Update project 42");
    expect(entry!.createdAt).toBe(1_700_000_000_000);
    expect(entry!.expiresAt).toBe(1_700_000_000_000 + 5 * 60_000);
    // Single-use: store empties after consume.
    expect(store.size).toBe(0);
  });

  it("consume() called a second time on the same id returns null (single-use)", () => {
    const { store } = storeWithClock();
    const id = store.create("t", { a: 1 }, "d");
    expect(store.consume(id)).not.toBeNull();
    expect(store.consume(id)).toBeNull();
    // And again, just in case.
    expect(store.consume(id)).toBeNull();
  });

  it("consume() with an unknown/invalid id returns null and does not throw", () => {
    const { store } = storeWithClock();
    expect(store.consume("does-not-exist")).toBeNull();
    expect(store.consume("")).toBeNull();
    expect(store.consume("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("consume() after the TTL elapses returns null and drops the entry", () => {
    const { store, advanceMs } = storeWithClock(5);
    const id = store.create("t", { a: 1 }, "d");
    // 5 min = 300_000 ms exactly is still the boundary; one ms past is expired.
    advanceMs(5 * 60_000 + 1);
    expect(store.consume(id)).toBeNull();
    // And the map shouldn't be leaking the stale entry either.
    expect(store.size).toBe(0);
  });

  it("consume() just before the TTL boundary still returns the entry", () => {
    const { store, advanceMs } = storeWithClock(5);
    const id = store.create("t", { a: 1 }, "d");
    // One ms before expiry — entry must still be live.
    advanceMs(5 * 60_000 - 1);
    expect(store.consume(id)).not.toBeNull();
  });

  it("100 parallel create() calls produce 100 unique IDs each consumable exactly once", async () => {
    const { store } = storeWithClock();
    const N = 100;
    const ids = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        Promise.resolve().then(() =>
          store.create(`tool_${i % 3}`, { idx: i }, `desc ${i}`),
        ),
      ),
    );
    // All UUIDs and all unique.
    for (const id of ids) expect(id).toMatch(UUID_FULL_RE);
    expect(new Set(ids).size).toBe(N);
    expect(store.size).toBe(N);

    const consumed = await Promise.all(
      ids.map((id) =>
        Promise.resolve().then(() => store.consume<{ idx: number }>(id)),
      ),
    );
    // Each consume returns the matching entry.
    for (let i = 0; i < N; i++) {
      expect(consumed[i]).not.toBeNull();
      expect(consumed[i]!.id).toBe(ids[i]);
      expect(consumed[i]!.args.idx).toBe(i);
    }
    expect(store.size).toBe(0);

    // A second pass of consumes should all return null.
    const second = ids.map((id) => store.consume(id));
    expect(second.every((r) => r === null)).toBe(true);
  });

  it("sweep() removes expired entries while leaving live entries intact", () => {
    const { store, setNow } = storeWithClock(5);

    setNow(0);
    const idOld = store.create("t", { kind: "old" }, "d");

    setNow(4 * 60_000); // 4 minutes later
    const idNew = store.create("t", { kind: "new" }, "d");

    expect(store.size).toBe(2);

    // Advance to 5 min + 1 ms: idOld is expired, idNew is still live.
    setNow(5 * 60_000 + 1);
    store.sweep();
    expect(store.size).toBe(1);
    expect(store.consume(idOld)).toBeNull();
    expect(store.consume(idNew)).not.toBeNull();
  });

  it("sweep() is idempotent and a no-op when nothing is expired", () => {
    const { store } = storeWithClock();
    store.create("t", { a: 1 }, "d");
    store.create("t", { a: 2 }, "d");
    expect(store.size).toBe(2);
    store.sweep();
    store.sweep();
    expect(store.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// requiresConfirmation
// ---------------------------------------------------------------------------

describe("requiresConfirmation", () => {
  type Args = { project_id: number; note?: string };

  it("first call (no confirmation_id) returns a prompt with toolName + id + description; executor is NOT called", async () => {
    const { store } = storeWithClock(5);
    const executor = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "executed" }],
    }));
    const handler = requiresConfirmation<Args>(
      "create_project",
      (args) => `Create project for ${args.project_id}`,
      executor,
    );

    const result = await handler({ project_id: 42 }, store);
    const text = textOf(result);

    // Executor must not have run.
    expect(executor).not.toHaveBeenCalled();
    // Tool name is surfaced.
    expect(text).toContain("create_project");
    // Description is surfaced.
    expect(text).toContain("Create project for 42");
    // A UUID confirmation_id is surfaced.
    const idMatch = text.match(UUID_RE);
    expect(idMatch).not.toBeNull();
    // Store now holds the pending entry under that id.
    expect(store.size).toBe(1);
    // No isError flag on a re-invoke prompt.
    expect(result.isError).toBeUndefined();
  });

  it("second call (matching confirmation_id) invokes executor exactly once with the ORIGINAL args", async () => {
    const { store } = storeWithClock(5);
    const executor = vi.fn(async (args: Args) => ({
      content: [
        { type: "text" as const, text: `done ${args.project_id} ${args.note}` },
      ],
    }));
    const handler = requiresConfirmation<Args>(
      "create_project",
      (a) => `desc ${a.project_id}`,
      executor,
    );

    // First call — capture the id from the prompt.
    const first = await handler({ project_id: 7, note: "alpha" }, store);
    const id = textOf(first).match(UUID_RE)![0];

    // Second call — DIFFERENT args alongside the confirmation_id. The
    // executor must still see the ORIGINAL args (project_id: 7, note: "alpha").
    const result = await handler(
      { project_id: 999, note: "TAMPERED", confirmation_id: id },
      store,
    );
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0][0]).toEqual({ project_id: 7, note: "alpha" });
    expect(textOf(result)).toBe("done 7 alpha");
    // Confirmation is consumed.
    expect(store.size).toBe(0);
  });

  it("second call with an unknown confirmation_id returns a re-invoke message; executor not called", async () => {
    const { store } = storeWithClock(5);
    const executor = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "should not run" }],
    }));
    const handler = requiresConfirmation<Args>(
      "create_project",
      () => "d",
      executor,
    );

    const result = await handler(
      { project_id: 1, confirmation_id: "nope" } as Args & {
        confirmation_id?: string;
      },
      store,
    );
    expect(executor).not.toHaveBeenCalled();
    expect(textOf(result).toLowerCase()).toContain("re-invoke");
    expect(result.isError).toBeUndefined();
  });

  it("second call after TTL expiry returns a re-invoke message; executor not called", async () => {
    const { store, advanceMs } = storeWithClock(5);
    const executor = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "should not run" }],
    }));
    const handler = requiresConfirmation<Args>(
      "create_project",
      () => "d",
      executor,
    );

    const first = await handler({ project_id: 1 }, store);
    const id = textOf(first).match(UUID_RE)![0];

    advanceMs(5 * 60_000 + 1);

    const result = await handler({ project_id: 1, confirmation_id: id }, store);
    expect(executor).not.toHaveBeenCalled();
    expect(textOf(result).toLowerCase()).toContain("re-invoke");
  });

  it("second call with a confirmation_id minted for a DIFFERENT tool returns a re-invoke message; executor not called", async () => {
    const { store } = storeWithClock(5);

    // Mint a confirmation for tool A.
    const idForA = store.create("delete_project", { project_id: 1 }, "d");

    // Try to consume it via tool B's handler.
    const executorB = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "should not run" }],
    }));
    const handlerB = requiresConfirmation<Args>(
      "create_project",
      () => "d",
      executorB,
    );

    const result = await handlerB(
      { project_id: 1, confirmation_id: idForA },
      store,
    );
    expect(executorB).not.toHaveBeenCalled();
    expect(textOf(result).toLowerCase()).toContain("re-invoke");
  });

  it("the stored args do NOT include confirmation_id (it is stripped before storage)", async () => {
    const { store } = storeWithClock(5);
    const executor = vi.fn(async (args: Args) => ({
      content: [{ type: "text" as const, text: JSON.stringify(args) }],
    }));
    const handler = requiresConfirmation<Args>(
      "create_project",
      (a) => `desc ${a.project_id}`,
      executor,
    );

    const first = await handler({ project_id: 5 }, store);
    const id = textOf(first).match(UUID_RE)![0];
    const second = await handler(
      { project_id: 5, confirmation_id: id },
      store,
    );

    expect(executor).toHaveBeenCalledTimes(1);
    const passed = executor.mock.calls[0][0] as Args & {
      confirmation_id?: string;
    };
    expect(passed.confirmation_id).toBeUndefined();
    expect(textOf(second)).toBe(JSON.stringify({ project_id: 5 }));
  });
});
