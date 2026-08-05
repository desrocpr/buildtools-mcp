/**
 * Neutral list query → BuildTools DataTables wire params (MOS-747).
 *
 * WHY THIS EXISTS
 *
 * The first cut of the neutral interface took `ListParams` — which was
 * `DatatableParams` renamed, character for character. Call sites passed jQuery
 * DataTables wire keys directly: `search[value]`,
 * `columns[1][search][value]`, `length`. That is the vendor's request format
 * wearing a neutral name: a second vendor's adapter would have to
 * reverse-engineer `columns[1][search][value]=3` to discover that the caller
 * meant "filter to status Completed".
 *
 * This module is where that translation belongs. The neutral side names the
 * FACET (search / status / role / paging); the vendor side owns the encoding —
 * including the positional column index, which is a pure DataTables artifact.
 *
 * Both back ends consume the wire form: `MossDb.getCompanies` reads
 * `opts["columns[1][search][value]"]` directly (`MossDb.ts:587`), so the
 * translation has to happen before either is called, not just before HTTP.
 */

import type { ListQuery } from "../../types.js";

/** BuildTools' DataTables parameter bag. */
export type DatatableParams = Record<string, string | number | undefined>;

/**
 * Column index carrying the primary status/type facet on BuildTools' grids.
 *
 * Positional and vendor-specific: column 1 is status on the projects and tasks
 * grids, and `type_name` on companies. Callers name the facet; only this file
 * knows the index.
 */
const STATUS_COLUMN = 1;

export function toDatatableParams(query: ListQuery = {}): DatatableParams {
  const params: DatatableParams = {};

  if (query.search !== undefined && query.search !== "") {
    params["search[value]"] = query.search;
  }

  if (query.limit !== undefined) params.length = query.limit;
  if (query.offset !== undefined) params.start = query.offset;

  if (query.status !== undefined) {
    const values = (
      Array.isArray(query.status) ? query.status : [query.status]
    ).map(String);

    if (values.length === 1) {
      params[`columns[${STATUS_COLUMN}][search][value]`] = values[0];
    } else if (values.length > 1) {
      // BuildTools expresses OR as a pipe-joined value plus regex mode
      // (BuildToolsAPI.ts:2975, tools/projects.ts:274). The regex flag is only
      // set for genuine multi-value queries, because it changes match
      // semantics for the single-value case.
      params[`columns[${STATUS_COLUMN}][search][value]`] = values.join("|");
      params[`columns[${STATUS_COLUMN}][search][regex]`] = "true";
    }
  }

  // `getUsers` already accepts `role` semantically and resolves the column
  // itself (BuildToolsAPI.ts:1049), so the neutral name maps straight over.
  if (query.role !== undefined) params.role = query.role;

  return params;
}
