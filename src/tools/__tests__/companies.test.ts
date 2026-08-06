/**
 * Registry + minimal handler tests for the company tools.
 *
 * The tools are thin wrappers over `BuildToolsAPI.searchCompanies` /
 * `getCompany`; live behaviour has been smoke-tested against the moss
 * tenant (search_companies("Kai Muten") returns row 977,
 * get_company(977) populates the PO-history block). These tests pin the
 * tool contract — input schemas, registry order, name → handler wiring —
 * so future refactors can't silently drop them.
 */

import { describe, expect, it, vi } from "vitest";

import type { OperationsManagementApi } from "../../operations/types.js";
import type { ToolContext } from "../projects.js";
import {
  companyTools,
  getCompanyTool,
  searchCompaniesTool,
} from "../companies.js";

/**
 * Build a fake tool context. These handlers read through the neutral operations
 * interface (MOS-747), so the stubs hang off `ops`.
 */
function fakeApi(overrides: Partial<OperationsManagementApi> = {}): ToolContext {
  return { ops: overrides } as unknown as ToolContext;
}

describe("companyTools registry", () => {
  it("exports the two tools in declared order", () => {
    expect(companyTools.map((t) => t.name)).toEqual([
      "search_companies",
      "get_company",
    ]);
  });

  it("both tools are read-only", () => {
    expect(searchCompaniesTool.permission).toBe("read");
    expect(getCompanyTool.permission).toBe("read");
  });

  it("descriptions are version-tagged", () => {
    expect(searchCompaniesTool.description).toMatch(/^\[v\d+ \d{4}-\d{2}-\d{2}\]/);
    expect(getCompanyTool.description).toMatch(/^\[v\d+ \d{4}-\d{2}-\d{2}\]/);
  });
});

describe("search_companies handler", () => {
  it("rejects queries shorter than 2 chars", async () => {
    const out = await searchCompaniesTool.handler({ query: "a" }, fakeApi());
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toContain("Invalid input");
  });

  it("passes role + limit through to the API", async () => {
    const searchCompanies = vi.fn().mockResolvedValue({
      data: [
        {
          DT_RowId: "row_977",
          name: "Kai Muten, LLC",
          type_name: "Subcontractor",
          phone: "555-1212",
          email: "kai@example.com",
          address: "1 Foo St",
          city: "Bar",
          state: "VA",
          zip: "20000",
          budget_relations:
            "<div>1510 - Demolition, 6030 - Plumbing Subcontractor</div>",
        },
      ],
      recordsTotal: 1095,
      recordsFiltered: 1,
    });
    const api = fakeApi({ getCompanies: searchCompanies } as Partial<OperationsManagementApi>);

    const out = await searchCompaniesTool.handler(
      { query: "Kai Muten", role: "Subcontractor", limit: 25 },
      api,
    );
    // search_companies now reads through getCompanies with named facets; the
    // role→column-3 encoding is the adapter's job (MOS-747).
    expect(searchCompanies).toHaveBeenCalledWith({
      search: "Kai Muten",
      companyType: "Subcontractor",
      limit: 25,
    });
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain("**1 company**");
    expect(text).toContain("| 977 | Kai Muten, LLC | Subcontractor | 1510 - Demolition |");
  });

  it("omits role from the API call when 'All' is selected", async () => {
    const searchCompanies = vi.fn().mockResolvedValue({ data: [], recordsFiltered: 0 });
    const api = fakeApi({ getCompanies: searchCompanies } as Partial<OperationsManagementApi>);
    await searchCompaniesTool.handler({ query: "abc", role: "All" }, api);
    expect(searchCompanies).toHaveBeenCalledWith({
      search: "abc",
      companyType: undefined,
      limit: 25,
    });
  });
});

describe("get_company handler", () => {
  it("renders the company body and best-effort PO history", async () => {
    const getCompany = vi.fn().mockResolvedValue({
      DT_RowId: "row_977",
      name: "Kai Muten, LLC",
      type_name: "Subcontractor",
      status: "Active",
      main_contact: "Kai Muten",
      email: "kai@example.com",
      phone: "555-1212",
      address: "1 Foo St",
      city: "Bar",
      state: "VA",
      zip: "20000",
      country: "United States",
      budget_relations:
        "<div>1510 - Demolition, 6030 - Plumbing Subcontractor</div>",
      created_at: "02/05/2019",
    });
    const searchPurchaseOrders = vi.fn().mockResolvedValue({
      data: [
        {
          DT_RowId: "row_28278",
          info: 28278,
          name: "Bacon credit",
          company: "Kai Muten, LLC",
          total: "$ -100.00",
          project_name: "Bacon 1 Laundry",
          created_at: "08/08/2023",
        },
      ],
      recordsFiltered: 1,
    });
    const api = fakeApi({
      getCompany,
      getPurchaseOrders: searchPurchaseOrders,
    } as Partial<OperationsManagementApi>);

    const out = await getCompanyTool.handler({ company_id: 977 }, api);
    const text = (out.content[0] as { text: string }).text;

    expect(text).toContain("## Company #977 — Kai Muten, LLC");
    expect(text).toContain("**Role**: Subcontractor");
    expect(text).toContain("**Default budget category**: 1510 - Demolition");
    expect(text).toContain("**Purchase order history**: 1 PO");
    expect(text).toContain("Most recent: PO #28278");
    // The PO search must use the comma-stripped query so the BuildTools
    // tokenizer matches — verbatim "Kai Muten, LLC" returns zero hits.
    expect(searchPurchaseOrders).toHaveBeenCalledWith({
      search: "Kai Muten",
      limit: 50,
    });
  });

  it("handles 'company not found' cleanly", async () => {
    const getCompany = vi.fn().mockResolvedValue(null);
    const api = fakeApi({ getCompany } as Partial<OperationsManagementApi>);
    const out = await getCompanyTool.handler({ company_id: 99999 }, api);
    expect((out.content[0] as { text: string }).text).toContain(
      "No company found for ID **99999**",
    );
  });
});
