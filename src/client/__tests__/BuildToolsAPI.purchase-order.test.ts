/**
 * Regression test for `BuildToolsAPI.getPurchaseOrder` parser.
 *
 * The fixture (`po-form.html`) is a minimised slice of the live PO edit
 * form, capturing the two shapes the parser must handle:
 *   - The editable `<select id="select_company_id">` with a disabled
 *     placeholder option (`value=""`, "Select or add a Company") and
 *     the chosen vendor option carrying `selected` BEFORE `value=` —
 *     the historical parser missed this attribute order and returned
 *     the first listed vendor (e.g. "84 Lumber") instead of the actual
 *     selected one (e.g. "Kai Muten, LLC").
 *   - The hidden `<input name="items">` with HTML-entity-encoded JSON.
 *
 * Both behaviours are pinned here so a future refactor can't silently
 * regress them.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { BuildToolsAPI } from "../BuildToolsAPI.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const poFormHtml = readFileSync(
  join(__dirname, "fixtures", "po-form.html"),
  "utf-8",
);

const poFormReadOnlyHtml = readFileSync(
  join(__dirname, "fixtures", "po-form-readonly.html"),
  "utf-8",
);

const poFormConfirmedHtml = readFileSync(
  join(__dirname, "fixtures", "po-form-confirmed.html"),
  "utf-8",
);

function makeStub(body: string, status = 200) {
  const stub: typeof fetch = (async () =>
    new Response(body, { status })) as typeof fetch;
  return stub;
}

/**
 * Build a fetch stub that returns `formHtml` on GET requests to the form
 * URL, and tracks every other request in `recorded`. Used to assert
 * whether the API layer attempted a save call when it shouldn't have.
 */
function makeRecordingStub(formHtml: string) {
  const recorded: Array<{ url: string; method: string }> = [];
  const stub: typeof fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    recorded.push({ url, method });
    // Form fetch
    if (url.includes("/purchase-orders/form/")) {
      return new Response(formHtml, { status: 200 });
    }
    // Anything else (save) — if this fires, the test fails because the
    // proactive lock check should have prevented it.
    return new Response("UNEXPECTED CALL", { status: 500 });
  }) as typeof fetch;
  return { stub, recorded };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("BuildToolsAPI.getPurchaseOrder", () => {
  it("extracts the selected vendor regardless of attribute order, skipping the disabled placeholder", async () => {
    const api = new BuildToolsAPI({ fetch: makeStub(poFormHtml) } as any);
    (api as unknown as { authenticated: boolean }).authenticated = true;

    const po = await api.getPurchaseOrder(39743);
    expect(po).not.toBeNull();
    expect(po!.id).toBe(39743);
    expect(po!.projectId).toBe(185966);
    expect(po!.prefix).toBe("PO");
    expect(po!.number).toBe("333123306");
    // HTML entities (&mdash;) must be decoded — entity gap caught earlier.
    expect(po!.name).toBe("MCP-smoke 1 — Kai Muten Plumbing Sub");

    // The historical bug: parser returned 84 Lumber (first non-placeholder
    // option). The fix uses a lookahead for `selected` so the actual
    // chosen option is matched regardless of attribute order.
    expect(po!.companyId).toBe(977);
    expect(po!.companyName).toBe("Kai Muten, LLC");

    // Items decoded from the HTML-entity-escaped JSON input.
    expect(po!.items).toHaveLength(1);
    expect(po!.items[0].budgetCategoryCode).toBe("3510");
    expect(po!.items[0].budgetCategoryName).toBe("Roofing Sub");
    expect(po!.items[0].companyId).toBe(977);
    expect(po!.items[0].companyName).toBe("Kai Muten, LLC");
    expect(po!.totalNumeric).toBe(300);
  });

  it("falls back to first numeric-value option on the read-only `disabled` select variant (older POs)", async () => {
    const api = new BuildToolsAPI({
      fetch: makeStub(poFormReadOnlyHtml),
    } as any);
    (api as unknown as { authenticated: boolean }).authenticated = true;

    const po = await api.getPurchaseOrder(39741);
    expect(po).not.toBeNull();
    // Critical: the read-only `<select>` has no `selected` attribute, only
    // a single `<option value="62">`. The `optSelected` lookahead misses;
    // the parser must fall back to `optFirst` and still return 62.
    expect(po!.companyId).toBe(62);
    expect(po!.companyName).toBe("Charles Home");
    // Also: the project_id input has `value=` BEFORE `name=` in this
    // fixture — exercises the `inputValue` attribute-order lookahead fix.
    expect(po!.projectId).toBe(185936);
    expect(po!.name).toBe("Roof repair for remote blower");
    expect(po!.items).toHaveLength(1);
    expect(po!.items[0].budgetCategoryCode).toBe("3510");
  });

  it("returns null on non-200 responses", async () => {
    const api = new BuildToolsAPI({ fetch: makeStub("not found", 404) } as any);
    (api as unknown as { authenticated: boolean }).authenticated = true;
    const po = await api.getPurchaseOrder(99999);
    expect(po).toBeNull();
  });

  it("returns null for non-numeric input", async () => {
    const api = new BuildToolsAPI({ fetch: makeStub(poFormHtml) } as any);
    (api as unknown as { authenticated: boolean }).authenticated = true;
    const po = await api.getPurchaseOrder("not-a-number");
    expect(po).toBeNull();
  });
});

describe("BuildToolsAPI.updatePurchaseOrder — proactive lock detection", () => {
  it("does NOT attempt the save call when current status is Confirmed (locked)", async () => {
    // Critical correctness guarantee of PR #57: a Confirmed PO never
    // sends a save request, no matter what fields the caller wants to
    // update. The previous test suite mocked updatePurchaseOrder itself,
    // which only proved the tool-layer wired the error through — it
    // did NOT prove the API layer's proactive lock check fires.
    const { stub, recorded } = makeRecordingStub(poFormConfirmedHtml);
    const api = new BuildToolsAPI({ fetch: stub } as any);
    (api as unknown as { authenticated: boolean }).authenticated = true;

    const result = await api.updatePurchaseOrder({
      purchaseOrderId: 39201,
      items: [
        {
          budgetCategoryId: 1680,
          description: "should not be saved",
          total: 19533.81,
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.currentStatus).toBe(3);
    expect(String(result.errors)).toContain("Confirmed");
    // PR #61 rewording: now says "refuses ALL writes" and points the
    // caller at `unlock_if_locked: true` for auto-transition. The
    // assertion is intentionally lenient on exact phrasing so future
    // wording tweaks don't break the test — what matters is the lock
    // is named and the workaround is surfaced.
    expect(String(result.errors)).toMatch(/refuses ALL writes|locks ALL writes/);
    expect(String(result.errors)).toContain("unlock_if_locked");

    // Only the form fetch should have happened — NO save POST.
    const saveCalls = recorded.filter((r) =>
      r.url.includes("/purchase-orders/save/"),
    );
    expect(saveCalls).toHaveLength(0);
  });

  // (The `force: true` bypass flag was deleted in PR #57 review round 3
  // — there's no known unlock path to wire it through to, so it was
  // pure speculative API surface. If BT ever exposes an unlock workflow,
  // re-add `force` + this test together.)
});

