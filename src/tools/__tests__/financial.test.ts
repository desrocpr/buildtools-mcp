/**
 * Unit tests for `src/tools/financial.ts` (MOS-215, Phase 3.2).
 *
 * These tests exercise the tool handlers with a hand-rolled stub for
 * `BuildToolsAPI`. We do NOT instantiate the real class — handlers must
 * not depend on `loadConfigFromEnv()`, must not hit the network, and must
 * not require live credentials.
 *
 * Coverage per the planner contract:
 *   (a) happy-path Markdown shape
 *   (b) empty result
 *   (c) API-error path returns Markdown error content with isError: true
 *   (d) Zod-invalid input returns Markdown error content with isError: true
 */

import { describe, expect, it, vi } from "vitest";

import type { BuildToolsAPI } from "../../client/BuildToolsAPI.js";
import {
  BuildToolsAuthError,
  BuildToolsServerError,
} from "../../client/errors.js";

import {
  financialTools,
  findUnbilledChangeOrdersTool,
  getChangeOrderTool,
  getFinancialStatementTool,
  listChangeOrdersTool,
} from "../financial.js";
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
  getChangeOrders?: BuildToolsAPI["getChangeOrders"];
  getChangeOrder?: BuildToolsAPI["getChangeOrder"];
  findUnbilledChangeOrders?: BuildToolsAPI["findUnbilledChangeOrders"];
  getFinancialStatement?: BuildToolsAPI["getFinancialStatement"];
}): BuildToolsAPI {
  return overrides as unknown as BuildToolsAPI;
}

function textOf(result: ToolResult): string {
  return result.content.map((c) => c.text).join("");
}

const sampleChangeOrderRow = {
  DT_RowId: "row_500001",
  id: 500001,
  status: 1,
  info: 500001,
  attachment: 0,
  email_status: 1601,
  email_status_label: "",
  project_name: "Jones Addition",
  number: 19,
  approved_number: null,
  name: "Jones - Basement Work",
  total: "$ 13,800.00",
  dates: "-",
  created_at: "02/04/2026",
};

const sampleApprovedChangeOrderRow = {
  DT_RowId: "row_500002",
  id: 500002,
  status: 3,
  info: 500002,
  email_status_label: "Approved",
  project_name: "Brown Addition",
  number: 4,
  approved_number: 4,
  name: "Brown - Master Bath Upgrades",
  total: "$ 7,500.00",
  total_value: 7500,
  created_at: "11/02/2025",
};

const sampleChangeOrderDetail = {
  id: 500001,
  name: "Jones - Basement Work",
  status: 1,
  number: 19,
  approved_number: null,
  project_id: 100002,
  project_name: "Jones Addition",
  description: "<p>Add basement framing + drywall.</p>",
  total: "$ 13,800.00",
  total_value: 13800,
  created_at: "02/04/2026",
  email_status_label: "Pending",
  items: [
    { name: "Framing labor", total: "$ 8,000.00", category: "3010 - Framing Labor" },
    { name: "Drywall materials", total: "$ 5,800.00", budget_category_id: 3620 },
  ],
};

const sampleFinancialStatement = {
  id: 700001,
  project_id: 100002,
  name: "Q1 2026 Statement",
  status: 1,
  current_amount: "$ 45,000.00",
  current_amount_value: 45000,
  contract_value: 250000,
  costs: 180000,
  amount_paid: "$ 45,000.00",
  amount_unpaid: "$ 0.00",
  aging_days: 0,
  due_date: "04/30/2026",
  payment_last: "04/30/2026",
};

// ---------------------------------------------------------------------------
// Registry sanity
// ---------------------------------------------------------------------------

describe("financialTools registry", () => {
  it("exports exactly four tools with the contract-mandated names in order", () => {
    const names = financialTools.map((t) => t.name);
    expect(names).toEqual([
      "list_change_orders",
      "get_change_order",
      "find_unbilled_change_orders",
      "get_financial_statement",
    ]);
  });

  it("each tool exposes a JSON Schema for its input", () => {
    for (const tool of financialTools) {
      expect(tool.inputSchema).toBeDefined();
      const schema = tool.inputSchema as { type?: string };
      expect(schema.type).toBe("object");
    }
  });
});

// ---------------------------------------------------------------------------
// list_change_orders
// ---------------------------------------------------------------------------

describe("list_change_orders", () => {
  it("returns Markdown list rows on the happy path", async () => {
    const getChangeOrders = vi.fn().mockResolvedValue({
      data: [sampleChangeOrderRow, sampleApprovedChangeOrderRow],
      recordsTotal: 2,
      recordsFiltered: 2,
    });
    const api = fakeApi({
      getChangeOrders: getChangeOrders as BuildToolsAPI["getChangeOrders"],
    });

    const result = await listChangeOrdersTool.handler({ project_id: 100002 }, api);

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("**2 change orders**");
    expect(text).toContain("for project #100002");
    expect(text).toContain("Jones - Basement Work");
    expect(text).toContain("Brown - Master Bath Upgrades");
    expect(text).toContain("$ 13,800.00");
    expect(text).toContain("[Draft]");
    expect(text).toContain("[Approved]");
    expect(text).toContain("(#19)");
    expect(getChangeOrders).toHaveBeenCalledTimes(1);
  });

  it("returns a Markdown 'no change orders' message when result is empty", async () => {
    const getChangeOrders = vi.fn().mockResolvedValue({ data: [] });
    const api = fakeApi({
      getChangeOrders: getChangeOrders as BuildToolsAPI["getChangeOrders"],
    });

    const result = await listChangeOrdersTool.handler({ project_id: 100002 }, api);

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("No change orders found for project #100002");
  });

  it("returns Markdown error content (isError: true) on BuildToolsError", async () => {
    const getChangeOrders = vi
      .fn()
      .mockRejectedValue(new BuildToolsAuthError("Not authenticated"));
    const api = fakeApi({
      getChangeOrders: getChangeOrders as BuildToolsAPI["getChangeOrders"],
    });

    const result = await listChangeOrdersTool.handler({ project_id: 1 }, api);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Not authenticated");
    expect(textOf(result)).toContain("BuildToolsAuthError");
  });

  it("returns Markdown error content (isError: true) on Zod-invalid input", async () => {
    // project_id is required and must be a number.
    const result = await listChangeOrdersTool.handler({}, fakeApi({}));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid input for `list_change_orders`");
    expect(textOf(result)).toContain("project_id");
  });

  it("handles a null datatable envelope gracefully (treats as empty)", async () => {
    const getChangeOrders = vi.fn().mockResolvedValue(null);
    const api = fakeApi({
      getChangeOrders: getChangeOrders as BuildToolsAPI["getChangeOrders"],
    });
    const result = await listChangeOrdersTool.handler({ project_id: 9 }, api);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("No change orders found for project #9");
  });
});

// ---------------------------------------------------------------------------
// get_change_order
// ---------------------------------------------------------------------------

describe("get_change_order", () => {
  it("renders a structured Markdown detail view on the happy path", async () => {
    const getChangeOrder = vi.fn().mockResolvedValue(sampleChangeOrderDetail);
    const api = fakeApi({
      getChangeOrder: getChangeOrder as BuildToolsAPI["getChangeOrder"],
    });

    const result = await getChangeOrderTool.handler(
      { change_order_id: 500001 },
      api,
    );

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("## Change Order #500001 — Jones - Basement Work");
    expect(text).toContain("- **Status**: Draft");
    expect(text).toContain("- **Number**: 19");
    expect(text).toContain("- **Amount**: $ 13,800.00");
    expect(text).toContain("Jones Addition");
    expect(text).toContain("### Description");
    expect(text).toContain("Add basement framing + drywall.");
    expect(text).toContain("### Line items");
    expect(text).toContain("Framing labor");
    expect(text).toContain("3010 - Framing Labor");
    expect(text).toContain("category #3620");
    expect(getChangeOrder).toHaveBeenCalledWith(500001);
  });

  it("returns a Markdown 'not found' message when the client returns null", async () => {
    const getChangeOrder = vi.fn().mockResolvedValue(null);
    const api = fakeApi({
      getChangeOrder: getChangeOrder as BuildToolsAPI["getChangeOrder"],
    });

    const result = await getChangeOrderTool.handler(
      { change_order_id: 999 },
      api,
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("No change order found with ID #999");
  });

  it("renders missing fields as em-dashes rather than throwing", async () => {
    const getChangeOrder = vi
      .fn()
      .mockResolvedValue({ id: 1, name: "Tiny CO" });
    const api = fakeApi({
      getChangeOrder: getChangeOrder as BuildToolsAPI["getChangeOrder"],
    });

    const result = await getChangeOrderTool.handler({ change_order_id: 1 }, api);

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("Tiny CO");
    expect(text).toContain("**Number**: —");
    expect(text).toContain("**Approved number**: —");
    expect(text).toContain("**Created**: —");
  });

  it("returns Markdown error content (isError: true) on BuildToolsError", async () => {
    const getChangeOrder = vi
      .fn()
      .mockRejectedValue(
        new BuildToolsServerError("Internal server error", { status: 500 }),
      );
    const api = fakeApi({
      getChangeOrder: getChangeOrder as BuildToolsAPI["getChangeOrder"],
    });

    const result = await getChangeOrderTool.handler({ change_order_id: 7 }, api);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Internal server error");
    expect(textOf(result)).toContain("BuildToolsServerError");
  });

  it("returns Markdown error content (isError: true) on Zod-invalid input", async () => {
    const result = await getChangeOrderTool.handler(
      { change_order_id: "not-a-number" },
      fakeApi({}),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid input for `get_change_order`");
    expect(textOf(result)).toContain("change_order_id");
  });
});

// ---------------------------------------------------------------------------
// find_unbilled_change_orders
// ---------------------------------------------------------------------------

describe("find_unbilled_change_orders", () => {
  it("returns a summary header + table on the happy path", async () => {
    const findUnbilled = vi.fn().mockResolvedValue([
      {
        ...sampleApprovedChangeOrderRow,
        total_value: 7500,
      },
      {
        id: 500003,
        info: 500003,
        status: 3,
        email_status_label: "Approved",
        project_name: "Smith Kitchen",
        number: 7,
        approved_number: 7,
        name: "Smith - Plumbing Upsize",
        total: "$ 12,200.00",
        total_value: 12200,
        created_at: "01/15/2026",
      },
    ]);
    const api = fakeApi({
      findUnbilledChangeOrders:
        findUnbilled as BuildToolsAPI["findUnbilledChangeOrders"],
    });

    const result = await findUnbilledChangeOrdersTool.handler({}, api);

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("**2 unbilled change orders**");
    // Summed total: 7500 + 12200 = 19700.
    expect(text).toContain("$19,700.00");
    // Table headers present.
    expect(text).toContain("| # | CO | Project | Status | Amount | Created |");
    // Rows present.
    expect(text).toContain("Brown Addition");
    expect(text).toContain("Smith Kitchen");
    expect(text).toContain("$7,500.00");
    expect(text).toContain("$12,200.00");
    expect(findUnbilled).toHaveBeenCalledWith({
      min_amount: undefined,
      older_than_days: undefined,
    });
  });

  it("passes min_amount and older_than_days through to the client", async () => {
    const findUnbilled = vi.fn().mockResolvedValue([
      {
        ...sampleApprovedChangeOrderRow,
        total_value: 7500,
      },
    ]);
    const api = fakeApi({
      findUnbilledChangeOrders:
        findUnbilled as BuildToolsAPI["findUnbilledChangeOrders"],
    });

    const result = await findUnbilledChangeOrdersTool.handler(
      { min_amount: 5000, older_than_days: 30 },
      api,
    );

    expect(result.isError).toBeFalsy();
    expect(findUnbilled).toHaveBeenCalledWith({
      min_amount: 5000,
      older_than_days: 30,
    });
    const text = textOf(result);
    // Both filter values surface in the header.
    expect(text).toContain("min $5,000.00");
    expect(text).toContain("older than 30 days");
  });

  it("returns a Markdown 'no unbilled' message when the result is empty", async () => {
    const findUnbilled = vi.fn().mockResolvedValue([]);
    const api = fakeApi({
      findUnbilledChangeOrders:
        findUnbilled as BuildToolsAPI["findUnbilledChangeOrders"],
    });

    const result = await findUnbilledChangeOrdersTool.handler(
      { min_amount: 10000 },
      api,
    );

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("No unbilled change orders found");
    expect(text).toContain("min $10,000.00");
  });

  it("returns Markdown error content (isError: true) on BuildToolsError", async () => {
    const findUnbilled = vi
      .fn()
      .mockRejectedValue(new BuildToolsAuthError("Session expired"));
    const api = fakeApi({
      findUnbilledChangeOrders:
        findUnbilled as BuildToolsAPI["findUnbilledChangeOrders"],
    });

    const result = await findUnbilledChangeOrdersTool.handler({}, api);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Session expired");
    expect(textOf(result)).toContain("BuildToolsAuthError");
  });

  it("returns Markdown error content (isError: true) on Zod-invalid input", async () => {
    // min_amount must be a number.
    const result = await findUnbilledChangeOrdersTool.handler(
      { min_amount: "lots" },
      fakeApi({}),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      "Invalid input for `find_unbilled_change_orders`",
    );
    expect(textOf(result)).toContain("min_amount");
  });
});

// ---------------------------------------------------------------------------
// get_financial_statement
// ---------------------------------------------------------------------------

describe("get_financial_statement", () => {
  it("renders the documented sections on the happy path", async () => {
    const getFinancialStatement = vi
      .fn()
      .mockResolvedValue(sampleFinancialStatement);
    const api = fakeApi({
      getFinancialStatement:
        getFinancialStatement as BuildToolsAPI["getFinancialStatement"],
    });

    const result = await getFinancialStatementTool.handler(
      { project_id: 100002 },
      api,
    );

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("## Financial Statement #700001");
    expect(text).toContain("project #100002");
    // All five required section labels (criterion 6).
    expect(text).toContain("**Contract value**");
    expect(text).toContain("**Costs**");
    expect(text).toContain("**Margin**");
    expect(text).toContain("**Billing status**");
    expect(text).toContain("**Outstanding receivables**");
    // Currency formatting via Intl: $250,000.00 / $180,000.00 / $70,000.00.
    expect(text).toContain("$250,000.00");
    expect(text).toContain("$180,000.00");
    expect(text).toContain("$70,000.00");
    expect(getFinancialStatement).toHaveBeenCalledWith(100002);
  });

  it("renders missing fields as em-dashes rather than throwing", async () => {
    const getFinancialStatement = vi
      .fn()
      .mockResolvedValue({ id: 99, name: "Stub" });
    const api = fakeApi({
      getFinancialStatement:
        getFinancialStatement as BuildToolsAPI["getFinancialStatement"],
    });

    const result = await getFinancialStatementTool.handler(
      { project_id: 1 },
      api,
    );

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("**Contract value**: —");
    expect(text).toContain("**Costs**: —");
    expect(text).toContain("**Margin**: —");
    expect(text).toContain("**Outstanding receivables**: —");
  });

  it("returns a Markdown 'not found' message when the client returns null", async () => {
    const getFinancialStatement = vi.fn().mockResolvedValue(null);
    const api = fakeApi({
      getFinancialStatement:
        getFinancialStatement as BuildToolsAPI["getFinancialStatement"],
    });

    const result = await getFinancialStatementTool.handler(
      { project_id: 999 },
      api,
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain(
      "No financial statement found for project #999",
    );
  });

  it("returns Markdown error content (isError: true) on BuildToolsError", async () => {
    const getFinancialStatement = vi
      .fn()
      .mockRejectedValue(new BuildToolsServerError("Bad gateway", { status: 502 }));
    const api = fakeApi({
      getFinancialStatement:
        getFinancialStatement as BuildToolsAPI["getFinancialStatement"],
    });

    const result = await getFinancialStatementTool.handler(
      { project_id: 1 },
      api,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Bad gateway");
    expect(textOf(result)).toContain("BuildToolsServerError");
  });

  it("returns Markdown error content (isError: true) on Zod-invalid input", async () => {
    const result = await getFinancialStatementTool.handler(
      { project_id: "not-a-number" },
      fakeApi({}),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      "Invalid input for `get_financial_statement`",
    );
    expect(textOf(result)).toContain("project_id");
  });

  it("returns Markdown error content (isError: true) when project_id is missing", async () => {
    const result = await getFinancialStatementTool.handler({}, fakeApi({}));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("project_id");
  });
});
