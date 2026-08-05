/**
 * Tests for neutral-query → BuildTools wire translation (MOS-747).
 *
 * The point of this module: without it, the "neutral" interface would still
 * take jQuery-DataTables wire keys (`search[value]`,
 * `columns[1][search][value]`). A second vendor's adapter would have to
 * reverse-engineer `columns[1][search][value]=3` to learn "filter to status
 * Completed", which is not an abstraction — it is the vendor's request format
 * with a different name on the box.
 *
 * Doing this BEFORE Phase 3 matters: afterwards, ~40 call sites would have the
 * DataTables vocabulary baked in.
 */

import { describe, expect, it } from "vitest";

import { toDatatableParams } from "../query.js";

describe("toDatatableParams", () => {
  it("maps free-text search onto the grid's global search key", () => {
    expect(toDatatableParams({ search: "Katchmark" })).toEqual({
      "search[value]": "Katchmark",
    });
  });

  it("maps limit and offset onto the grid's paging keys", () => {
    expect(toDatatableParams({ limit: 50, offset: 100 })).toEqual({
      length: 50,
      start: 100,
    });
  });

  it("maps a single status onto the status column filter", () => {
    expect(toDatatableParams({ status: 3 })).toEqual({
      "columns[1][search][value]": "3",
    });
  });

  it("ORs multiple statuses via the grid's regex mode", () => {
    // BuildTools expresses OR as a pipe-joined value plus regex=true —
    // BuildToolsAPI.ts:2975 and tools/projects.ts:274 both rely on this.
    expect(toDatatableParams({ status: [5, 6, 7, 8] })).toEqual({
      "columns[1][search][value]": "5|6|7|8",
      "columns[1][search][regex]": "true",
    });
  });

  it("passes role through as a named option, not a column index", () => {
    // getUsers already accepts `role` semantically and resolves the column
    // itself (BuildToolsAPI.ts:1049), so the neutral name maps straight over.
    expect(toDatatableParams({ role: "Employee" })).toEqual({
      role: "Employee",
    });
  });

  it("emits nothing for an empty query", () => {
    // An empty query must not inject defaults — `length` in particular changes
    // how many rows the grid returns.
    expect(toDatatableParams({})).toEqual({});
    expect(toDatatableParams()).toEqual({});
  });

  it("omits an empty search rather than filtering on the empty string", () => {
    expect(toDatatableParams({ search: "" })).toEqual({});
  });

  it("treats a single-element status array like a scalar", () => {
    // No spurious regex flag — regex mode changes matching semantics.
    expect(toDatatableParams({ status: ["3"] })).toEqual({
      "columns[1][search][value]": "3",
    });
  });

  it("drops an empty status array", () => {
    expect(toDatatableParams({ status: [] })).toEqual({});
  });

  it("combines every facet in one query", () => {
    expect(
      toDatatableParams({ search: "deck", status: [1, 2], limit: 25 }),
    ).toEqual({
      "search[value]": "deck",
      "columns[1][search][value]": "1|2",
      "columns[1][search][regex]": "true",
      length: 25,
    });
  });
});
