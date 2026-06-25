/**
 * Unit tests for `src/tools/purchase-orders.ts` (MOS-292).
 *
 * These tests exercise the tool handlers with a hand-rolled stub for
 * `BuildToolsAPI`. We do NOT instantiate the real class — handlers must
 * not depend on `loadConfigFromEnv()`, must not hit the network, and must
 * not require live credentials.
 *
 * Coverage per the planner contract (criterion 14):
 *   (a) registry sanity (exports 2 tools with expected names in order)
 *   (b) happy-path Markdown shape (multi-row)
 *   (c) empty result
 *   (d) BuildToolsError path returns Markdown error content with isError: true
 *   (e) Zod-invalid input returns Markdown error content with isError: true
 *   (f) null datatable envelope is treated as empty
 *
 * Fixture rows use the 20-column shape from `api-data-sample.json` L154–200.
 */

import { describe, expect, it, vi } from "vitest";

import type { BuildToolsAPI } from "../../client/BuildToolsAPI.js";
import {
  BuildToolsAuthError,
  BuildToolsServerError,
} from "../../client/errors.js";

import {
  getPurchaseOrderTool,
  listPurchaseOrdersTool,
  purchaseOrderTools,
  searchPurchaseOrdersTool,
} from "../purchase-orders.js";
import { type ToolResult } from "../projects.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake `BuildToolsAPI` with only the methods our handlers call. The
 * cast is intentional — we are stubbing exactly the surface this module uses,
 * not the entire class.
 */
function fakeApi(overrides: {
  getPurchaseOrders?: BuildToolsAPI["getPurchaseOrders"];
  searchPurchaseOrders?: BuildToolsAPI["searchPurchaseOrders"];
  getPurchaseOrder?: BuildToolsAPI["getPurchaseOrder"];
}): BuildToolsAPI {
  return overrides as unknown as BuildToolsAPI;
}

function textOf(result: ToolResult): string {
  return result.content.map((c) => "text" in c ? c.text : "").join("");
}

// 20-column shape lifted directly from api-data-sample.json L154–200.
const samplePurchaseOrderRow = {
  DT_RowId: "row_37904",
  status: 3,
  sync_status:
    '<span\n      class="material-icons text-grey"\n      style="width:100px; max-width:100px"\n      title="The item does not meet the synchronization criteria"\n    >\n        sync_disabled\n    </span>\n',
  comments_status: 1,
  info: 37904,
  attachment: 1,
  email_status: 1601,
  email_status_label: "Untracked",
  can_manage_project: true,
  project_name: "Cabero 1 Addition",
  number: 333121488,
  name: "Cabero - Wedi materials",
  company: "Best Tile",
  relations: "7730 - Tile Materials",
  total: "$ 3,855.46",
  invoiced_amount: "$ 0.00",
  difference: "$ 3,855.46",
  created_at: "02/04/2026",
  prefix: "PO",
  project_number: null,
};

const sampleDraftPurchaseOrderRow = {
  DT_RowId: "row_37905",
  status: 1,
  sync_status: "",
  comments_status: 0,
  info: 37905,
  attachment: 0,
  email_status: 1601,
  email_status_label: "",
  can_manage_project: true,
  project_name: "Jones Addition",
  number: 333121489,
  name: "Jones - Lumber",
  company: "ABC Lumber",
  // Live data sometimes ships HTML here even though sample is plain text.
  relations: '<span class="badge">3010 - Framing Labor</span>',
  total: "$ 12,500.00",
  invoiced_amount: "$ 5,000.00",
  difference: "$ 7,500.00",
  created_at: "03/12/2026",
  prefix: "PO",
  project_number: null,
};

// ---------------------------------------------------------------------------
// Registry sanity
// ---------------------------------------------------------------------------

describe("purchaseOrderTools registry", () => {
  it("exports the contract-mandated tools in order", () => {
    const names = purchaseOrderTools.map((t) => t.name);
    expect(names).toEqual([
      "list_purchase_orders",
      "search_purchase_orders",
      "get_purchase_order",
    ]);
  });

  it("each tool exposes a JSON Schema for its input", () => {
    for (const tool of purchaseOrderTools) {
      expect(tool.inputSchema).toBeDefined();
      const schema = tool.inputSchema as { type?: string };
      expect(schema.type).toBe("object");
    }
  });
});

// ---------------------------------------------------------------------------
// list_purchase_orders
// ---------------------------------------------------------------------------

describe("list_purchase_orders", () => {
  it("returns Markdown list rows on the happy path", async () => {
    const getPurchaseOrders = vi.fn().mockResolvedValue({
      data: [samplePurchaseOrderRow, sampleDraftPurchaseOrderRow],
      recordsTotal: 37644,
      recordsFiltered: 2,
    });
    const api = fakeApi({
      getPurchaseOrders:
        getPurchaseOrders as BuildToolsAPI["getPurchaseOrders"],
    });

    const result = await listPurchaseOrdersTool.handler({}, api);

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("**2 purchase orders**");
    expect(text).toContain("filtered 2 total");
    // PO number rendered as `<prefix> <number>` per criterion 6.
    expect(text).toContain("PO 333121488");
    expect(text).toContain("PO 333121489");
    // info field used as the canonical #<id>.
    expect(text).toContain("#37904");
    expect(text).toContain("#37905");
    // Status labels inferred from CO mapping.
    // Status labels verified live 2026-06-24: BT calls code 3 "Confirmed"
    // (not "Approved" — that was inferred from change orders before live
    // verification) and code 2 "Sent" (not "Pending").
    expect(text).toContain("[Confirmed]");
    expect(text).toContain("[Draft]");
    // Currency strings rendered as-is.
    expect(text).toContain("$ 3,855.46");
    expect(text).toContain("$ 12,500.00");
    expect(text).toContain("$ 5,000.00");
    expect(text).toContain("$ 7,500.00");
    // Company + project + created_at + name surfaces.
    expect(text).toContain("Best Tile");
    expect(text).toContain("ABC Lumber");
    expect(text).toContain("Cabero 1 Addition");
    expect(text).toContain("Jones Addition");
    expect(text).toContain("Cabero - Wedi materials");
    expect(text).toContain("Jones - Lumber");
    expect(text).toContain("02/04/2026");
    expect(text).toContain("03/12/2026");
    // stripHtml applied to relations — span markup must not appear in output.
    expect(text).toContain("3010 - Framing Labor");
    expect(text).not.toContain("<span");
    expect(text).not.toContain("</span>");
    // Default length used.
    expect(getPurchaseOrders).toHaveBeenCalledTimes(1);
    const callArg = getPurchaseOrders.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.length).toBe(50);
  });

  it("forwards project_name as the datatable global search and respects limit", async () => {
    const getPurchaseOrders = vi.fn().mockResolvedValue({
      data: [samplePurchaseOrderRow],
      recordsTotal: 37644,
      recordsFiltered: 1,
    });
    const api = fakeApi({
      getPurchaseOrders:
        getPurchaseOrders as BuildToolsAPI["getPurchaseOrders"],
    });

    const result = await listPurchaseOrdersTool.handler(
      { project_name: "Cabero", limit: 25 },
      api,
    );

    expect(result.isError).toBeFalsy();
    const callArg = getPurchaseOrders.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg["search[value]"]).toBe("Cabero");
    expect(callArg.length).toBe(25);
    expect(textOf(result)).toContain('project filter: "Cabero"');
  });

  it("returns a Markdown 'no purchase orders' message when result is empty", async () => {
    const getPurchaseOrders = vi.fn().mockResolvedValue({ data: [] });
    const api = fakeApi({
      getPurchaseOrders:
        getPurchaseOrders as BuildToolsAPI["getPurchaseOrders"],
    });

    const result = await listPurchaseOrdersTool.handler(
      { project_name: "Nonesuch" },
      api,
    );

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("No purchase orders matched");
    expect(text).toContain('matching project "Nonesuch"');
  });

  it("handles a null datatable envelope gracefully (treats as empty)", async () => {
    const getPurchaseOrders = vi.fn().mockResolvedValue(null);
    const api = fakeApi({
      getPurchaseOrders:
        getPurchaseOrders as BuildToolsAPI["getPurchaseOrders"],
    });

    const result = await listPurchaseOrdersTool.handler({}, api);

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("No purchase orders matched");
  });

  it("returns Markdown error content (isError: true) on BuildToolsError", async () => {
    const getPurchaseOrders = vi
      .fn()
      .mockRejectedValue(new BuildToolsAuthError("Not authenticated"));
    const api = fakeApi({
      getPurchaseOrders:
        getPurchaseOrders as BuildToolsAPI["getPurchaseOrders"],
    });

    const result = await listPurchaseOrdersTool.handler({}, api);

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Not authenticated");
    expect(text).toContain("BuildToolsAuthError");
    expect(text).toContain("list_purchase_orders");
  });

  it("returns Markdown error content (isError: true) on Zod-invalid input", async () => {
    // limit must be a number within [1, 200].
    const result = await listPurchaseOrdersTool.handler(
      { limit: "many" },
      fakeApi({}),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid input for `list_purchase_orders`");
    expect(textOf(result)).toContain("limit");
  });

  it("renders missing prefix/number/fields as em-dashes rather than throwing", async () => {
    const sparseRow = {
      DT_RowId: "row_99",
      info: 99,
      status: 99, // unknown status code
      name: "Sparse PO",
    };
    const getPurchaseOrders = vi.fn().mockResolvedValue({ data: [sparseRow] });
    const api = fakeApi({
      getPurchaseOrders:
        getPurchaseOrders as BuildToolsAPI["getPurchaseOrders"],
    });

    const result = await listPurchaseOrdersTool.handler({}, api);
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("#99");
    expect(text).toContain("Sparse PO");
    // Unknown status code falls back to its string form.
    expect(text).toContain("[99]");
    // No prefix + no number -> "—" placeholder.
    expect(text).toContain("— —"); // company em-dash precedes total em-dash etc.
  });
});

// ---------------------------------------------------------------------------
// search_purchase_orders
// ---------------------------------------------------------------------------

describe("search_purchase_orders", () => {
  it("returns Markdown list rows on the happy path", async () => {
    const searchPurchaseOrders = vi.fn().mockResolvedValue({
      data: [samplePurchaseOrderRow],
      recordsTotal: 1,
      recordsFiltered: 1,
    });
    const api = fakeApi({
      searchPurchaseOrders:
        searchPurchaseOrders as BuildToolsAPI["searchPurchaseOrders"],
    });

    const result = await searchPurchaseOrdersTool.handler(
      { query: "Cabero" },
      api,
    );

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain('**1 match** for "Cabero"');
    expect(text).toContain("PO 333121488");
    expect(text).toContain("Cabero - Wedi materials");
    expect(text).toContain("Best Tile");
    // Search delegates to client with the fixed limit of 20.
    expect(searchPurchaseOrders).toHaveBeenCalledWith("Cabero", 20);
  });

  it("returns a Markdown 'no purchase orders' message when result is empty", async () => {
    const searchPurchaseOrders = vi.fn().mockResolvedValue({ data: [] });
    const api = fakeApi({
      searchPurchaseOrders:
        searchPurchaseOrders as BuildToolsAPI["searchPurchaseOrders"],
    });

    const result = await searchPurchaseOrdersTool.handler(
      { query: "zzzzzz" },
      api,
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('No purchase orders matched query "zzzzzz"');
  });

  it("returns Markdown error content (isError: true) on BuildToolsError", async () => {
    const searchPurchaseOrders = vi
      .fn()
      .mockRejectedValue(new BuildToolsServerError("Bad gateway", { status: 502 }));
    const api = fakeApi({
      searchPurchaseOrders:
        searchPurchaseOrders as BuildToolsAPI["searchPurchaseOrders"],
    });

    const result = await searchPurchaseOrdersTool.handler(
      { query: "Cabero" },
      api,
    );

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Bad gateway");
    expect(text).toContain("BuildToolsServerError");
    expect(text).toContain("search_purchase_orders");
  });

  it("returns Markdown error content (isError: true) when query is too short", async () => {
    const result = await searchPurchaseOrdersTool.handler(
      { query: "a" },
      fakeApi({}),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid input for `search_purchase_orders`");
    expect(textOf(result)).toContain("query");
  });

  it("returns Markdown error content (isError: true) when query is missing", async () => {
    const result = await searchPurchaseOrdersTool.handler({}, fakeApi({}));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("query");
  });
});

// ---------------------------------------------------------------------------
// get_purchase_order
// ---------------------------------------------------------------------------

describe("get_purchase_order", () => {
  it("renders vendor (with id) + line items + invoiced/unpaid summary", async () => {
    const getPurchaseOrder = vi.fn().mockResolvedValue({
      id: 39741,
      projectId: 185936,
      name: "Roof repair for remote blower",
      number: "333123304",
      prefix: "PO",
      companyId: 62,
      companyName: "Charles Home",
      items: [
        {
          id: 45824,
          budgetCategoryId: 1609,
          budgetCategoryCode: "3510",
          budgetCategoryName: "Roofing Sub",
          total: "300.00",
          notes: "",
          internalNotes: "",
          invoiceRelated: "0.00",
          amounts: [{ a: "300", q: "1", d: "Roof repair", u: "1" }],
          companyId: 62,
          companyName: "Charles Home",
        },
      ],
      totalNumeric: 300,
    });
    const api = fakeApi({
      getPurchaseOrder: getPurchaseOrder as BuildToolsAPI["getPurchaseOrder"],
    });

    const result = await getPurchaseOrderTool.handler(
      { purchase_order_id: 39741 },
      api,
    );
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("## Purchase Order #39741 — Roof repair for remote blower (project #185936)");
    expect(text).toContain("**PO number**: PO 333123304");
    expect(text).toContain("**Vendor**: Charles Home (company #62)");
    expect(text).toContain("**Total** (sum of items): $300.00");
    expect(text).toContain("**Invoiced**: $0.00 — **unpaid**: $300.00");
    expect(text).toContain("| 1 | 3510 | Roofing Sub | 1 | 300 | $300.00 |");
  });

  it("handles 'PO not found' cleanly", async () => {
    const getPurchaseOrder = vi.fn().mockResolvedValue(null);
    const api = fakeApi({
      getPurchaseOrder: getPurchaseOrder as BuildToolsAPI["getPurchaseOrder"],
    });
    const result = await getPurchaseOrderTool.handler(
      { purchase_order_id: 99999 },
      api,
    );
    expect(textOf(result)).toContain(
      "No detail found for purchase order #99999",
    );
  });

  it("rejects non-number input via Zod", async () => {
    const result = await getPurchaseOrderTool.handler(
      { purchase_order_id: "not-a-number" } as unknown as Record<string, unknown>,
      fakeApi({}),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid input for `get_purchase_order`");
  });
});
