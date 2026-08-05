/**
 * Row normalisation at the provider boundary (MOS-747, Phase 1).
 *
 * WHAT THIS KILLS
 *
 * `DT_RowId` is a jQuery DataTables wire artifact — `"row_37904"` — and it has
 * leaked through the entire codebase:
 *
 *   - 7 tool files strip the `row_` prefix at 12 sites to recover an id, each
 *     with its own ad-hoc inline expression (only `work-tracking.ts` bothered
 *     with a shared helper).
 *   - `MossDb` FABRICATES it at 10+ sites (`DT_RowId: \`row_${r.id}\``) so the
 *     SQL read path imitates the HTTP one — despite the replica having a real
 *     `id` column. CLAUDE.md calls that shape parity "non-negotiable"; what it
 *     actually preserves is a vendor detail the neutral layer exists to remove.
 *
 * Normalising once, here, lets both disappear: the adapter guarantees `id`, and
 * `DT_RowId` never crosses into neutral territory.
 *
 * This module is vendor-neutral in the sense that matters — it removes a vendor
 * artifact rather than propagating one — and is deliberately dependency-free so
 * it can be applied from any adapter.
 */

/** A row that has crossed the boundary: `id` present when upstream had one. */
export interface NormalizedRow {
  id?: string | number;
  [key: string]: unknown;
}

/** The DataTables envelope shape BuildTools' grid endpoints return. */
export interface DatatableEnvelope<R = NormalizedRow> {
  data: R[];
  draw?: number;
  recordsTotal?: number;
  recordsFiltered?: number;
  [key: string]: unknown;
}

/**
 * Guarantee `id` on a single row and drop the DataTables artifact.
 *
 * Precedence: a real `id` column always wins. `DT_RowId` is only consulted as
 * a fallback, because several BuildTools grids (companies, users) carry the id
 * nowhere else.
 *
 * A row with neither is returned unchanged — some grids are genuinely id-less
 * (aggregate/total rows), and inventing an id would be worse than admitting
 * there isn't one.
 */
export function normalizeRow(row: Record<string, unknown>): NormalizedRow {
  const { DT_RowId, ...rest } = row;

  if (rest.id !== undefined && rest.id !== null) {
    return rest as NormalizedRow;
  }

  const derived = idFromRowMarker(DT_RowId);
  if (derived !== undefined) {
    return { id: derived, ...rest };
  }

  return rest as NormalizedRow;
}

/**
 * Pull the id out of a `row_<n>` marker.
 *
 * Numeric suffixes become numbers (callers compare and sort on them); anything
 * else is kept as a string rather than coerced into `NaN`.
 */
function idFromRowMarker(marker: unknown): string | number | undefined {
  if (typeof marker !== "string") return undefined;
  const suffix = marker.startsWith("row_") ? marker.slice(4) : marker;
  if (suffix.length === 0) return undefined;
  return /^\d+$/.test(suffix) ? Number(suffix) : suffix;
}

/**
 * Normalise every row of a datatable envelope, leaving anything else alone.
 *
 * Many reads return bespoke shapes rather than an envelope (e.g.
 * `getFinancialStatements` returns `{statusCount, statements}`), and HTTP reads
 * return `T | null` where null means "not found". Both must survive untouched,
 * so this only acts on a recognisable `{ data: [...] }`.
 */
export function normalizeEnvelope<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;

  const envelope = value as { data?: unknown };
  if (!Array.isArray(envelope.data)) return value;

  return {
    ...value,
    data: envelope.data.map((row) =>
      typeof row === "object" && row !== null && !Array.isArray(row)
        ? normalizeRow(row as Record<string, unknown>)
        : row,
    ),
  } as T;
}
