/**
 * Unit tests for `src/tools/customers.ts` (MOS-216, Phase 3.3).
 *
 * These tests exercise the tool handlers with a hand-rolled stub for
 * `BuildToolsAPI`. We do NOT instantiate the real class — handlers must not
 * depend on `loadConfigFromEnv()`, must not hit the network, and must not
 * require live credentials.
 *
 * Coverage per the planner contract (criterion 12):
 *   (a) happy-path Markdown shape
 *   (b) empty result
 *   (c) API-error path returns Markdown error content with isError: true
 *   (d) Zod-invalid input returns Markdown error content with isError: true
 */

import { describe, expect, it, vi } from "vitest";

import type { OperationsManagementApi } from "../../operations/types.js";
import {
  BuildToolsAuthError,
  BuildToolsServerError,
} from "../../client/errors.js";

import {
  customerTools,
  getCustomerTool,
  listCustomersTool,
} from "../customers.js";
import { type ToolContext, type ToolResult } from "../projects.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake tool context. These handlers read through the neutral operations
 * interface (MOS-747), so the stubs hang off `ops`.
 */
function fakeApi(overrides: {
  getCompanies?: OperationsManagementApi["getCompanies"];
  getCustomer?: OperationsManagementApi["getCustomer"];
}): ToolContext {
  return { ops: overrides } as unknown as ToolContext;
}

function textOf(result: ToolResult): string {
  return result.content.map((c) => "text" in c ? c.text : "").join("");
}

const sampleActiveCustomerRow = {
  DT_RowId: "row_300001",
  id: 300001,
  status: "Active",
  name: "Acme Subcontractors LLC",
  type_name: "Subcontractor",
  main_contact: "Pat Sample",
  email: "vendor@example.com",
  phone: "555-010-0001",
  address: "100 Industrial Way",
  zip: "22030",
  city: "Anytown",
  state: "VA",
  country: "United States",
  rating: 4,
  budget_relations:
    '<div class="text-truncate" title="Jones Addition">Jones Addition</div>',
  created_at: "01/19/2026",
};

const sampleInactiveCustomerRow = {
  DT_RowId: "row_300003",
  id: 300003,
  status: "Inactive",
  name: "Test Architects",
  type_name: "Designer",
  main_contact: "Robin Designer",
  email: "design@example.com",
  phone: "555-010-0003",
  address: "",
  zip: "",
  city: "",
  state: "",
  country: "United States",
  rating: 0,
  budget_relations: "",
  created_at: "07/10/2024",
};

const sampleCustomerDetail = {
  id: 300001,
  name: "Acme Subcontractors LLC",
  status: "Active",
  type_name: "Subcontractor",
  main_contact: "Pat Sample",
  email: "vendor@example.com",
  phone: "555-010-0001",
  address: "100 Industrial Way",
  zip: "22030",
  city: "Anytown",
  state: "VA",
  country: "United States",
  rating: 4,
  created_at: "01/19/2026",
  updated_at: "03/01/2026",
  projects: [
    { id: 100002, name: "Jones Addition" },
    { id: 100007, name: "Smith Pool House" },
  ],
};

// ---------------------------------------------------------------------------
// Registry sanity
// ---------------------------------------------------------------------------

describe("customerTools registry", () => {
  it("exports exactly two tools with the contract-mandated names in order", () => {
    const names = customerTools.map((t) => t.name);
    expect(names).toEqual(["list_customers", "get_customer"]);
  });

  it("each tool exposes a JSON Schema for its input", () => {
    for (const tool of customerTools) {
      expect(tool.inputSchema).toBeDefined();
      const schema = tool.inputSchema as { type?: string };
      expect(schema.type).toBe("object");
    }
  });
});

// ---------------------------------------------------------------------------
// list_customers
// ---------------------------------------------------------------------------

describe("list_customers", () => {
  it("returns Markdown list rows on the happy path", async () => {
    const getCompanies = vi.fn().mockResolvedValue({
      data: [sampleActiveCustomerRow, sampleInactiveCustomerRow],
      recordsTotal: 2,
      recordsFiltered: 2,
    });
    const api = fakeApi({
      getCompanies: getCompanies as OperationsManagementApi["getCompanies"],
    });

    const result = await listCustomersTool.handler({}, api);

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("**2 customers**");
    expect(text).toContain("Acme Subcontractors LLC");
    expect(text).toContain("Test Architects");
    expect(text).toContain("[Active]");
    expect(text).toContain("[Inactive]");
    expect(text).toContain("(Subcontractor)");
    expect(text).toContain("Anytown, VA");
    expect(text).toContain("contact: Pat Sample");
    expect(getCompanies).toHaveBeenCalledTimes(1);
  });

  it("forwards name_search as the neutral search facet", async () => {
    const getCompanies = vi.fn().mockResolvedValue({
      data: [sampleActiveCustomerRow],
    });
    const api = fakeApi({
      getCompanies: getCompanies as OperationsManagementApi["getCompanies"],
    });

    await listCustomersTool.handler({ name_search: "Acme" }, api);

    // The tool names the facet; the adapter encodes it as the grid's
    // `search[value]` / `length` keys (MOS-747).
    const callArgs = getCompanies.mock.calls[0][0];
    expect(callArgs).toMatchObject({
      limit: 200,
      search: "Acme",
    });
  });

  it("filters to active-project customers when has_active_project=true", async () => {
    const getCompanies = vi.fn().mockResolvedValue({
      data: [sampleActiveCustomerRow, sampleInactiveCustomerRow],
    });
    const api = fakeApi({
      getCompanies: getCompanies as OperationsManagementApi["getCompanies"],
    });

    const result = await listCustomersTool.handler(
      { has_active_project: true },
      api,
    );

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("**1 customer**");
    expect(text).toContain("Acme Subcontractors LLC");
    expect(text).not.toContain("Test Architects");
  });

  it("filters to no-active-project customers when has_active_project=false", async () => {
    const getCompanies = vi.fn().mockResolvedValue({
      data: [sampleActiveCustomerRow, sampleInactiveCustomerRow],
    });
    const api = fakeApi({
      getCompanies: getCompanies as OperationsManagementApi["getCompanies"],
    });

    const result = await listCustomersTool.handler(
      { has_active_project: false },
      api,
    );

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("**1 customer**");
    expect(text).toContain("Test Architects");
    expect(text).not.toContain("Acme Subcontractors LLC");
  });

  it("returns a Markdown 'no customers matched' message when result is empty (no isError)", async () => {
    const getCompanies = vi.fn().mockResolvedValue({ data: [] });
    const api = fakeApi({
      getCompanies: getCompanies as OperationsManagementApi["getCompanies"],
    });

    const result = await listCustomersTool.handler(
      { name_search: "zzz" },
      api,
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/No customers matched/);
    expect(textOf(result)).toContain('name_search: "zzz"');
  });

  it("returns 'no customers matched' for has_active_project=true with no matching rows", async () => {
    const getCompanies = vi
      .fn()
      .mockResolvedValue({ data: [sampleInactiveCustomerRow] });
    const api = fakeApi({
      getCompanies: getCompanies as OperationsManagementApi["getCompanies"],
    });

    const result = await listCustomersTool.handler(
      { has_active_project: true },
      api,
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/No customers matched/);
    expect(textOf(result)).toContain("has_active_project: true");
  });

  it("handles a null datatable envelope gracefully (treats as empty)", async () => {
    const getCompanies = vi.fn().mockResolvedValue(null);
    const api = fakeApi({
      getCompanies: getCompanies as OperationsManagementApi["getCompanies"],
    });

    const result = await listCustomersTool.handler({}, api);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/No customers matched/);
  });

  it("returns Markdown error content (isError: true) on BuildToolsError", async () => {
    const getCompanies = vi
      .fn()
      .mockRejectedValue(new BuildToolsAuthError("Not authenticated"));
    const api = fakeApi({
      getCompanies: getCompanies as OperationsManagementApi["getCompanies"],
    });

    const result = await listCustomersTool.handler({}, api);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Not authenticated");
    expect(textOf(result)).toContain("BuildToolsAuthError");
  });

  it("returns Markdown error content (isError: true) on Zod-invalid input", async () => {
    const result = await listCustomersTool.handler(
      // name_search must be a string
      { name_search: 42 },
      fakeApi({}),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid input for `list_customers`");
    expect(textOf(result)).toContain("name_search");
  });
});

// ---------------------------------------------------------------------------
// get_customer
// ---------------------------------------------------------------------------

describe("get_customer", () => {
  it("renders a structured Markdown detail view on the happy path", async () => {
    const getCustomer = vi.fn().mockResolvedValue(sampleCustomerDetail);
    const api = fakeApi({
      getCustomer: getCustomer as OperationsManagementApi["getCustomer"],
    });

    const result = await getCustomerTool.handler({ customer_id: 300001 }, api);

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("## Customer #300001 — Acme Subcontractors LLC");
    expect(text).toContain("- **Status**: Active");
    expect(text).toContain("- **Type**: Subcontractor");
    expect(text).toContain("- **Primary contact**: Pat Sample");
    expect(text).toContain("- **Email**: vendor@example.com");
    expect(text).toContain("- **Phone**: 555-010-0001");
    expect(text).toContain("100 Industrial Way");
    expect(text).toContain("Anytown, VA");
    expect(text).toContain("United States");
    expect(text).toContain("### Associated projects");
    expect(text).toContain("#100002");
    expect(text).toContain("Jones Addition");
    expect(text).toContain("#100007");
    expect(text).toContain("Smith Pool House");
    expect(getCustomer).toHaveBeenCalledWith(300001);
  });

  it("uses budget_relations as a fallback when no projects[] is present", async () => {
    const getCustomer = vi.fn().mockResolvedValue({
      id: 300001,
      name: "Acme",
      budget_relations:
        '<div title="Jones Addition">Jones Addition</div>',
    });
    const api = fakeApi({
      getCustomer: getCustomer as OperationsManagementApi["getCustomer"],
    });

    const result = await getCustomerTool.handler({ customer_id: 300001 }, api);

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("### Associated projects");
    expect(text).toContain("Jones Addition");
  });

  it("renders missing fields as em-dashes rather than throwing", async () => {
    const getCustomer = vi
      .fn()
      .mockResolvedValue({ id: 5, name: "Bare bones" });
    const api = fakeApi({
      getCustomer: getCustomer as OperationsManagementApi["getCustomer"],
    });

    const result = await getCustomerTool.handler({ customer_id: 5 }, api);
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("## Customer #5 — Bare bones");
    expect(text).toContain("- **Status**: —");
    expect(text).toContain("- **Primary contact**: —");
    expect(text).toContain("- **Email**: —");
    expect(text).toContain("- **Address**: —");
  });

  it("returns a Markdown 'not found' message when the client returns null", async () => {
    const getCustomer = vi.fn().mockResolvedValue(null);
    const api = fakeApi({
      getCustomer: getCustomer as OperationsManagementApi["getCustomer"],
    });

    const result = await getCustomerTool.handler({ customer_id: 999 }, api);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("No customer found with ID #999");
  });

  it("returns Markdown error content (isError: true) on BuildToolsError", async () => {
    const getCustomer = vi
      .fn()
      .mockRejectedValue(
        new BuildToolsServerError("Internal server error", { status: 500 }),
      );
    const api = fakeApi({
      getCustomer: getCustomer as OperationsManagementApi["getCustomer"],
    });

    const result = await getCustomerTool.handler({ customer_id: 7 }, api);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Internal server error");
    expect(textOf(result)).toContain("BuildToolsServerError");
  });

  it("returns Markdown error content (isError: true) on Zod-invalid input", async () => {
    const result = await getCustomerTool.handler(
      { customer_id: "not-a-number" },
      fakeApi({}),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid input for `get_customer`");
    expect(textOf(result)).toContain("customer_id");
  });

  it("returns Markdown error content (isError: true) when customer_id is missing", async () => {
    const result = await getCustomerTool.handler({}, fakeApi({}));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("customer_id");
  });
});
