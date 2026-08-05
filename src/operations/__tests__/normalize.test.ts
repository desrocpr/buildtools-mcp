/**
 * Tests for row normalisation at the adapter boundary (MOS-747, Phase 1).
 *
 * `DT_RowId` is a jQuery DataTables wire artifact of the form `"row_37904"`.
 * It has no business crossing a provider-neutral interface, yet today it leaks
 * all the way into the tool layer: 7 files strip the `row_` prefix at 12 sites
 * to recover an id, and `MossDb` FABRICATES the string (`row_${r.id}`) at 10+
 * sites purely so the SQL read path imitates the HTTP one — even though the
 * replica has a real `id` column.
 *
 * Normalising here is what lets both of those disappear.
 */

import { describe, expect, it } from "vitest";

import { normalizeEnvelope, normalizeRow } from "../normalize.js";

describe("normalizeRow", () => {
  it("derives a numeric id from DT_RowId when no id column is present", () => {
    // Several BuildTools datatables carry the id ONLY here — `companies` is the
    // documented case (src/tools/companies.ts).
    expect(normalizeRow({ DT_RowId: "row_37904", name: "Katchmark" })).toEqual({
      id: 37904,
      name: "Katchmark",
    });
  });

  it("prefers a real id column over DT_RowId", () => {
    expect(normalizeRow({ id: 12, DT_RowId: "row_99", name: "x" })).toEqual({
      id: 12,
      name: "x",
    });
  });

  it("strips DT_RowId so the vendor artifact never crosses the boundary", () => {
    const row = normalizeRow({ DT_RowId: "row_5", name: "x" });
    expect(row).not.toHaveProperty("DT_RowId");
  });

  it("keeps a non-numeric DT_RowId suffix as a string rather than coercing to NaN", () => {
    expect(normalizeRow({ DT_RowId: "row_a7" })).toEqual({ id: "a7" });
  });

  it("leaves a row with neither id nor DT_RowId untouched", () => {
    // Some grids are genuinely id-less (aggregate rows). Inventing an id would
    // be worse than admitting there isn't one.
    expect(normalizeRow({ name: "Totals", total: "$1.00" })).toEqual({
      name: "Totals",
      total: "$1.00",
    });
  });

  it("preserves every other field verbatim", () => {
    const row = normalizeRow({
      DT_RowId: "row_1",
      status: 4,
      total: "$ 13,800.00",
      nested: { a: 1 },
    });
    expect(row.status).toBe(4);
    expect(row.total).toBe("$ 13,800.00");
    expect(row.nested).toEqual({ a: 1 });
  });
});

describe("normalizeEnvelope", () => {
  it("normalises every row of a datatable envelope", () => {
    const out = normalizeEnvelope({
      draw: 1,
      recordsTotal: 2,
      data: [{ DT_RowId: "row_1" }, { DT_RowId: "row_2", name: "b" }],
    });

    expect(out.data).toEqual([{ id: 1 }, { id: 2, name: "b" }]);
    // Envelope metadata is preserved — callers page on it.
    expect(out.recordsTotal).toBe(2);
    expect(out.draw).toBe(1);
  });

  it("passes through a value that is not a datatable envelope", () => {
    // Plenty of reads return bespoke shapes (e.g. getFinancialStatements
    // returns {statusCount, statements}). Those must survive untouched.
    const bespoke = { statusCount: { Sent: 2 }, statements: [{ id: "7" }] };
    expect(normalizeEnvelope(bespoke)).toEqual(bespoke);
  });

  it("passes through null", () => {
    // HTTP reads return `T | null`; null means "not found", not "empty".
    expect(normalizeEnvelope(null)).toBeNull();
  });

  it("tolerates a data array holding non-objects", () => {
    const out = normalizeEnvelope({ data: ["raw", 3, null] });
    expect(out.data).toEqual(["raw", 3, null]);
  });
});
