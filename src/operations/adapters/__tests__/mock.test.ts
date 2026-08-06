/**
 * Tests for the in-memory mock adapter (MOS-747).
 *
 * The mock is only useful if its filtering is REAL. A mock that accepted a
 * query and ignored it would let a tool ship with a filter that never filtered
 * — the test would pass on data the mock never narrowed. So the cases below are
 * mostly about the mock actually honouring `ListQuery`.
 */

import { describe, expect, it } from "vitest";

import { getOperationsManagementApi } from "../../factory.js";
import { MockOperationsApi, type MockRow } from "../mock.js";

const PROJECTS: MockRow[] = [
  { id: 101, name: "Smith Renovation", status: 6, city: "Fairfax" },
  { id: 102, name: "Jones Addition", status: 6, city: "Vienna" },
  { id: 103, name: "Smith Kitchen", status: 12, city: "Reston" },
];

describe("list queries are honoured, not ignored", () => {
  it("filters by free-text search across string fields", async () => {
    const api = new MockOperationsApi({ projects: PROJECTS });

    const result = (await api.getProjects({ search: "smith" })) as {
      data: MockRow[];
    };

    expect(result.data.map((r) => r.id)).toEqual([101, 103]);
  });

  it("filters by a single status", async () => {
    const api = new MockOperationsApi({ projects: PROJECTS });

    const result = (await api.getProjects({ status: 12 })) as {
      data: MockRow[];
    };

    expect(result.data.map((r) => r.id)).toEqual([103]);
  });

  it("ORs multiple statuses", async () => {
    const api = new MockOperationsApi({ projects: PROJECTS });

    const result = (await api.getProjects({ status: [6, 12] })) as {
      data: MockRow[];
    };

    expect(result.data).toHaveLength(3);
  });

  it("applies limit and offset, and reports the pre-paging total", async () => {
    // recordsTotal must reflect the filtered set, not the returned page —
    // callers page on it.
    const api = new MockOperationsApi({ projects: PROJECTS });

    const result = (await api.getProjects({ offset: 1, limit: 1 })) as {
      data: MockRow[];
      recordsTotal: number;
    };

    expect(result.data.map((r) => r.id)).toEqual([102]);
    expect(result.recordsTotal).toBe(3);
  });

  it("filters companies by type, separately from status", async () => {
    const api = new MockOperationsApi({
      companies: [
        { id: 1, name: "Acme", status: 1, type_name: "Vendor" },
        { id: 2, name: "Bolt", status: 1, type_name: "Subcontractor" },
      ],
    });

    const result = (await api.getCompanies({ companyType: "Vendor" })) as {
      data: MockRow[];
    };

    expect(result.data.map((r) => r.id)).toEqual([1]);
  });
});

describe("unseeded grids", () => {
  it("answer empty rather than throwing, so a test seeds only what it uses", async () => {
    const api = new MockOperationsApi();

    const result = (await api.getWorkDays()) as { data: MockRow[] };

    expect(result.data).toEqual([]);
  });

  it("return null from single-record reads", async () => {
    expect(await new MockOperationsApi().getProject(999)).toBeNull();
  });
});

describe("single-record reads", () => {
  it("match on id regardless of string/number form", async () => {
    const api = new MockOperationsApi({ projects: PROJECTS });

    expect(await api.getProject("101")).toMatchObject({ id: 101 });
    expect(await api.getProject(101)).toMatchObject({ id: 101 });
  });

  it("fall back to companies for a customer, mirroring BuildTools", async () => {
    // BuildTools keeps customers in the companies table; a test that seeds only
    // `companies` should behave the way production does.
    const api = new MockOperationsApi({
      companies: [{ id: 7, name: "Homeowner", type_name: "Customer" }],
    });

    expect(await api.getCustomer(7)).toMatchObject({ name: "Homeowner" });
  });
});

describe("derived views", () => {
  it("derives allowances from the seeded budget", async () => {
    // Mirrors the real back ends, which both derive allowances from the budget
    // rather than storing them separately — so a test seeding one gets both.
    const api = new MockOperationsApi({
      budget: {
        "1": {
          columns: [],
          items: [
            {
              id: "a",
              categoryId: "c1",
              name: "Tile",
              isAllowance: true,
              publishedBudget: 100,
              workingBudget: 100,
              approvedCOs: 0,
              publishedRevised: 100,
              workingRevised: 100,
              cells: [],
            },
            {
              id: "b",
              categoryId: "c2",
              name: "Framing",
              isAllowance: false,
              publishedBudget: 500,
              workingBudget: 500,
              approvedCOs: 0,
              publishedRevised: 500,
              workingRevised: 500,
              cells: [],
            },
          ],
        },
      },
    });

    const allowances = await api.getAllowances(1);

    expect(allowances.map((a) => a.name)).toEqual(["Tile"]);
    expect(allowances[0]).not.toHaveProperty("isAllowance");
  });

  it("filters unbilled change orders by minimum amount", async () => {
    const api = new MockOperationsApi({
      unbilledChangeOrders: [
        { id: 1, total_value: 500 },
        { id: 2, total_value: 5000 },
      ],
    });

    const rows = await api.findUnbilledChangeOrders({ min_amount: 1000 });

    expect(rows.map((r) => r.id)).toEqual([2]);
  });
});

describe("statefulness", () => {
  it("reseeds mid-test, so a write's effect can be simulated", async () => {
    const api = new MockOperationsApi({ projects: [] });
    expect(((await api.getProjects()) as { data: MockRow[] }).data).toHaveLength(
      0,
    );

    api.reseed({ projects: [{ id: 1, name: "New" }] });

    expect(((await api.getProjects()) as { data: MockRow[] }).data).toHaveLength(
      1,
    );
  });

  it("records calls so ordering can be asserted when it matters", async () => {
    const api = new MockOperationsApi();

    await api.getBudget(1);
    await api.getSchedule(1);

    expect(api.calls.map((c) => c.method)).toEqual(["getBudget", "getSchedule"]);
  });
});

describe("factory integration", () => {
  it("builds the mock provider with a seed and no vendor client", async () => {
    // The point: the tool layer can run with no credentials and no vendor.
    const api = getOperationsManagementApi(
      { provider: "mock" },
      { mockSeed: { projects: PROJECTS } },
    );

    expect(api.provider).toBe("mock");
    expect(((await api.getProjects()) as { data: MockRow[] }).data).toHaveLength(
      3,
    );
  });
});
