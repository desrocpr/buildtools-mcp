/**
 * Tests for neutral-query → BuildTools wire translation (MOS-747).
 *
 * Without this layer the "neutral" interface would still take jQuery-DataTables
 * wire keys, and a second vendor's adapter would have to reverse-engineer
 * `columns[1][search][value]=3` to learn "filter to status Completed".
 *
 * The dangerous part is not the OR/regex encoding — it is the COLUMN INDEX,
 * which differs per grid. A wrong index filters the wrong column and returns
 * wrong-but-plausible rows with no error, which a green test suite happily
 * survives. Hence the per-grid cases below.
 */

import { describe, expect, it } from "vitest";

import { toDatatableParams } from "../query.js";

describe("toDatatableParams — facets", () => {
  it("maps free-text search onto the grid's global search key", () => {
    expect(toDatatableParams("projects", { search: "Katchmark" })).toEqual({
      "search[value]": "Katchmark",
    });
  });

  it("maps limit and offset onto the grid's paging keys", () => {
    expect(toDatatableParams("projects", { limit: 50, offset: 100 })).toEqual({
      length: 50,
      start: 100,
    });
  });

  it("emits nothing for an empty query", () => {
    // An empty query must not inject defaults — `length` in particular changes
    // how many rows the grid returns.
    expect(toDatatableParams("projects", {})).toEqual({});
    expect(toDatatableParams("projects")).toEqual({});
  });

  it("omits an empty search rather than filtering on the empty string", () => {
    expect(toDatatableParams("projects", { search: "" })).toEqual({});
  });
});

describe("toDatatableParams — status column is per grid", () => {
  it("uses column 1 for projects, whose grid leads with a sort handle", () => {
    // docs: sorting_1(0), status(1), name(2) — the drag handle shifts by one.
    expect(toDatatableParams("projects", { status: 3 })).toEqual({
      "columns[1][search][value]": "3",
    });
  });

  it("uses column 1 for tasks", () => {
    expect(toDatatableParams("tasks", { status: 3 })).toEqual({
      "columns[1][search][value]": "3",
    });
  });

  it("uses column 0 for companies, NOT column 1", () => {
    // docs: status(0), sync_status(1), name(2), type_name(3). A shared
    // STATUS_COLUMN=1 constant filtered QuickBooks sync status here and
    // returned plausible-looking wrong rows.
    expect(toDatatableParams("companies", { status: 1 })).toEqual({
      "columns[0][search][value]": "1",
    });
  });

  it("uses column 0 for change orders", () => {
    // docs: status(0), comments_status(1), info(2).
    expect(toDatatableParams("changeOrders", { status: 3 })).toEqual({
      "columns[0][search][value]": "3",
    });
  });

  it("throws for a grid whose status column has not been verified", () => {
    // Failing closed beats guessing an index: a wrong column filters silently.
    expect(() => toDatatableParams("workDays", { status: 1 })).toThrow(
      /not verified for the 'workDays' grid/,
    );
  });

  it("does not throw on an unverified grid when no status filter is asked for", () => {
    expect(toDatatableParams("workDays", { search: "x", limit: 5 })).toEqual({
      "search[value]": "x",
      length: 5,
    });
  });
});

describe("toDatatableParams — OR encoding", () => {
  it("ORs multiple statuses via the grid's regex mode", () => {
    // BuildTools expresses OR as a pipe-joined value plus regex=true
    // (BuildToolsAPI.ts:2975, tools/projects.ts:274).
    expect(toDatatableParams("projects", { status: [5, 6, 7, 8] })).toEqual({
      "columns[1][search][value]": "5|6|7|8",
      "columns[1][search][regex]": "true",
    });
  });

  it("treats a single-element array like a scalar, with no regex flag", () => {
    // regex mode changes matching semantics, so it must not be set spuriously.
    expect(toDatatableParams("projects", { status: ["3"] })).toEqual({
      "columns[1][search][value]": "3",
    });
  });

  it("drops an empty status array", () => {
    expect(toDatatableParams("projects", { status: [] })).toEqual({});
  });
});

describe("toDatatableParams — company type is its own column", () => {
  it("maps companyType to column 3, distinct from status", () => {
    // BuildToolsAPI.searchCompanies uses column 3 for type_name. Folding type
    // into `status` would filter the wrong column.
    expect(toDatatableParams("companies", { companyType: "Vendor" })).toEqual({
      "columns[3][search][value]": "Vendor",
    });
  });

  it("keeps status and companyType on separate columns in one query", () => {
    expect(
      toDatatableParams("companies", { status: 1, companyType: "Vendor" }),
    ).toEqual({
      "columns[0][search][value]": "1",
      "columns[3][search][value]": "Vendor",
    });
  });
});

describe("toDatatableParams — combined", () => {
  it("combines every facet in one query", () => {
    expect(
      toDatatableParams("projects", {
        search: "deck",
        status: [1, 2],
        limit: 25,
      }),
    ).toEqual({
      "search[value]": "deck",
      "columns[1][search][value]": "1|2",
      "columns[1][search][regex]": "true",
      length: 25,
    });
  });
});
