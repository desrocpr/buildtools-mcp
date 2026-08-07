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
 * Both back ends consume the wire form: `MossDb.getCompanies` reads
 * `opts["columns[1][search][value]"]` directly (`MossDb.ts:587`), so the
 * translation has to happen before either is called, not just before HTTP.
 *
 * THE COLUMN INDEX IS PER-GRID AND MUST BE VERIFIED
 *
 * An earlier version used a single `STATUS_COLUMN = 1` for every grid. That is
 * true for projects and tasks and WRONG elsewhere — the projects grid leads
 * with a `sorting_1` drag handle that shifts every column right by one, which
 * the other grids do not have. Per
 * `~/code/buildtools/docs/API_REFERENCE.md`, the companies grid is
 * `status`(0), `sync_status`(1), … — so a status filter through the old
 * constant would have silently filtered on QuickBooks sync status and returned
 * wrong-but-plausible rows with no error.
 *
 * So: indices are recorded per grid, ONLY where verified, and an unverified
 * grid fails loudly rather than guessing. Failing closed is the point — a
 * silent wrong-column filter is precisely the bug class this layer exists to
 * remove, and it survives a green test suite.
 */

import type { ListQuery } from "../../types.js";

/** BuildTools' DataTables parameter bag. */
export type DatatableParams = Record<string, string | number | undefined>;

/** Grids reachable through the operations interface. */
export type GridName =
  | "projects"
  | "tasks"
  | "companies"
  | "changeOrders"
  | "purchaseOrders"
  | "rfis"
  | "services"
  | "users"
  | "certificates"
  | "dailyLogs"
  | "weeklyReports"
  | "workDays";

/**
 * Column index carrying the status facet, per grid.
 *
 * Populated only where the index has been verified against
 * `~/code/buildtools/docs/API_REFERENCE.md` or against shipped, exercised code.
 * A grid absent from this map has NOT been verified — requesting a status
 * filter on it throws rather than guessing an index.
 *
 *   projects  → 1  (docs: `sorting_1`, `status`, … — the drag handle shifts by 1;
 *                   matches shipped `tools/projects.ts:272`)
 *   tasks     → 1  (shipped, exercised `tools/tasks.ts:202`)
 *   companies → 0  (docs: `status`, `sync_status`, `name`, `type_name`, …)
 *   changeOrders → 0 (docs: `status`, `comments_status`, `info`, …)
 */
const STATUS_COLUMN: Partial<Record<GridName, number>> = {
  projects: 1,
  tasks: 1,
  companies: 0,
  changeOrders: 0,
};

/**
 * Company type (`Vendor` / `Subcontractor` / `Customer`) lives in its own
 * column, separate from status — see `BuildToolsAPI.searchCompanies`, which
 * uses column 3 for exactly this.
 */
const COMPANY_TYPE_COLUMN = 3;

/**
 * Throw unless this grid's status column has been verified.
 *
 * Exported so the mock adapter enforces the SAME rule: if the mock filtered on
 * a grid where the real adapter throws, a test would pass and the identical
 * production call would explode. Divergence in the failure surface is as
 * dangerous as divergence in the results.
 */
export function assertStatusFilterSupported(grid: GridName): void {
  if (STATUS_COLUMN[grid] === undefined) {
    throw new Error(
      `operations: status filtering is not verified for the '${grid}' grid — ` +
        "the DataTables column index is unknown, and guessing would silently " +
        "filter the wrong column. Verify against ~/code/buildtools/docs/ and " +
        "add it to STATUS_COLUMN.",
    );
  }
}

export function toDatatableParams(
  grid: GridName,
  query: ListQuery = {},
): DatatableParams {
  const params: DatatableParams = {};

  if (query.search !== undefined && query.search !== "") {
    params["search[value]"] = query.search;
  }

  if (query.limit !== undefined) params.length = query.limit;
  // Project scoping uses the grid's own `PR[]` param — verified working on the
  // change-orders grid, where a search-based scope returns nothing at all.
  if (query.projectId !== undefined) params["PR[]"] = query.projectId;
  if (query.offset !== undefined) params.start = query.offset;

  if (query.status !== undefined) {
    assertStatusFilterSupported(grid);
    applyColumnFilter(params, STATUS_COLUMN[grid] as number, query.status);
  }

  if (query.companyType !== undefined) {
    applyColumnFilter(params, COMPANY_TYPE_COLUMN, query.companyType);
  }

  return params;
}

/**
 * Encode one column filter, using BuildTools' pipe + regex form for OR.
 *
 * The regex flag is set only for genuine multi-value queries — it changes match
 * semantics, so switching it on for a single value would alter behaviour
 * (`BuildToolsAPI.ts:2975`, `tools/projects.ts:274`).
 */
function applyColumnFilter(
  params: DatatableParams,
  column: number,
  value: string | number | Array<string | number>,
): void {
  const values = (Array.isArray(value) ? value : [value]).map(String);
  if (values.length === 0) return;

  if (values.length === 1) {
    params[`columns[${column}][search][value]`] = values[0];
    return;
  }
  params[`columns[${column}][search][value]`] = values.join("|");
  params[`columns[${column}][search][regex]`] = "true";
}
