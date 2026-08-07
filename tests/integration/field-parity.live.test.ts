/**
 * Field parity: does the DB fast path return the fields the tools render?
 *
 * WHY THIS EXISTS
 *
 * `MossDb` mirrors `BuildToolsAPI`'s read shapes, and `CLAUDE.md` calls that
 * parity non-negotiable. It was enforced for method SIGNATURES — there is a
 * compile-time assertion in the adapter — and that check is blind to the thing
 * that actually breaks: every method returns `Record<string, unknown>`, which
 * structurally satisfies anything, so a missing KEY is invisible to tsc.
 *
 * The result has been a steady drip of the same bug: a tool renders a column,
 * the DB projection never selected it, and the field comes back `undefined`,
 * which the renderer formats as an em-dash. No error, no null, no test failure
 * — just a confident-looking report with blank columns, in production, because
 * `MYSQL_*` is the production config.
 *
 * This asserts the one thing that matters: for every grid, the keys `MossDb`
 * returns are a SUPERSET of the keys the renderer reads. It checks for the key
 * being PRESENT, not for it being non-empty — "not selected" and "no value for
 * this row" are different failures and only the first is a parity bug.
 *
 * Known gaps are listed in `KNOWN_MISSING` below. That list is a ratchet: it
 * may shrink, never grow. A field that appears in a renderer without appearing
 * in the projection fails this test on the next run.
 *
 * Live-gated, so CI stays hermetic. Run with:
 *   doppler run --project buildtools-mcp --config prd -- npm test
 */

import { afterAll, describe, expect, it } from "vitest";

import { MossDb } from "../../src/db/MossDb.js";

const HOST = process.env.MYSQL_HOST;

const db = HOST
  ? new MossDb({
      host: HOST,
      port: Number(process.env.MYSQL_PORT ?? 3306),
      user: process.env.MYSQL_USER ?? "",
      password: process.env.MYSQL_PASSWORD ?? "",
      database: process.env.MYSQL_DATABASE ?? "",
    })
  : null;

afterAll(async () => {
  await db?.close();
});

/**
 * What each tool's row renderer reads, extracted from the `format*Row`
 * functions. `DT_RowId` is deliberately excluded — the operations adapter
 * strips it and guarantees `id` instead, so requiring it would pin an artifact
 * the neutral layer exists to remove.
 */
interface GridSpec {
  grid: string;
  renderer: string;
  /** Keys the renderer reads off each row. */
  reads: string[];
  fetch: (db: MossDb) => Promise<Array<Record<string, unknown>>>;
}

const listRows =
  (method: keyof MossDb, opts: Record<string, unknown> = { length: 5 }) =>
  async (d: MossDb): Promise<Array<Record<string, unknown>>> => {
    const fn = d[method] as (o: unknown) => Promise<{
      data?: Array<Record<string, unknown>>;
    }>;
    const res = await fn.call(d, opts);
    return res?.data ?? [];
  };

const GRIDS: GridSpec[] = [
  {
    grid: "tasks",
    renderer: "tools/tasks.ts formatTaskRow",
    reads: ["id", "assigned_to", "due_date", "location", "name", "priority", "project", "status"],
    fetch: listRows("getTasks"),
  },
  {
    grid: "rfis",
    renderer: "tools/operations.ts formatRfiRow",
    reads: ["id", "assigned_to", "location", "number", "priority", "project", "status", "subject"],
    fetch: listRows("getRFIs"),
  },
  {
    grid: "services",
    renderer: "tools/operations.ts formatServiceRow",
    reads: ["assigned_to", "created_at", "due_date", "info", "name", "project", "status"],
    fetch: listRows("getServices"),
  },
  {
    grid: "users",
    renderer: "tools/operations.ts formatUserRow",
    reads: ["company", "created_at", "email", "first_name", "last_name", "phone", "role"],
    fetch: listRows("getUsers"),
  },
  {
    grid: "purchaseOrders",
    renderer: "tools/purchase-orders.ts formatPurchaseOrderRow",
    reads: [
      "company", "created_at", "difference", "info", "invoiced_amount",
      "name", "number", "prefix", "project_name", "relations", "status", "total",
    ],
    fetch: listRows("getPurchaseOrders"),
  },
  {
    grid: "certificates",
    renderer: "tools/work-tracking.ts formatCertificateRow",
    reads: ["company", "expiry_date", "issue_date", "issuer", "name", "status", "type"],
    fetch: listRows("getCertificates"),
  },
  {
    grid: "dailyLogs",
    renderer: "tools/work-tracking.ts formatDailyLogRow",
    reads: ["date", "hours_worked", "notes", "project", "status", "weather"],
    fetch: listRows("getDailyLogs"),
  },
  {
    grid: "weeklyReports",
    renderer: "tools/work-tracking.ts formatWeeklyReportRow",
    reads: ["project", "status", "summary", "total_hours", "week_end", "week_start"],
    fetch: listRows("getWeeklyReports"),
  },
  {
    grid: "workDays",
    renderer: "tools/work-tracking.ts formatWorkDayRow",
    reads: ["date", "hours", "project", "status", "user"],
    fetch: listRows("getWorkDays"),
  },
];

/**
 * Fields the DB path is KNOWN not to return today, with the consequence.
 *
 * A ratchet, not a suppression list: shrink it as gaps are closed, never add to
 * it. A new gap must fail this test rather than be waved through — that is the
 * whole point, given every one of these was found by a human reading code for
 * an unrelated reason.
 */
const KNOWN_MISSING: Record<string, string[]> = {
  // Renderer reads `project`; MossDb emits `project_name`. Same data, different
  // name — so the column renders blank rather than wrong.
  tasks: ["assigned_to", "location", "project"],
  rfis: ["assigned_to", "location", "project"],
  // `info` is the HTTP grid's name for the row id; the DB emits `id`.
  services: ["assigned_to", "info", "project"],
  // No companies_users join, so the company column is always blank.
  users: ["company", "created_at"],
  // Both derive from purchase_orders_items.invoice_related, which is not joined.
  purchaseOrders: ["difference", "invoiced_amount", "relations"],
  // The sharpest case: 6 of 7 rendered columns are missing. `issuer`,
  // `issue_date` and `name` are not columns on `certificates` at all — closing
  // this one needs a live HTTP capture first to learn where BuildTools sources
  // them, not just a join.
  certificates: ["company", "expiry_date", "issue_date", "issuer", "name", "type"],
  dailyLogs: ["hours_worked", "notes", "project", "status", "weather"],
  weeklyReports: ["project", "summary", "total_hours", "week_end", "week_start"],
  // The DB emits start_date/end_date where the renderer reads `date`.
  workDays: ["date", "hours", "project", "status", "user"],
};

describe.skipIf(!HOST)("field parity — MossDb vs what the tools render", () => {
  it.each(GRIDS)("$grid returns every field $renderer reads", async (spec) => {
    const rows = await spec.fetch(db!);
    if (rows.length === 0) return; // nothing to assert against

    // Union across sampled rows: a key present on any row was selected.
    const present = new Set<string>();
    for (const row of rows) for (const k of Object.keys(row)) present.add(k);

    const missing = spec.reads.filter((f) => !present.has(f));
    const known = KNOWN_MISSING[spec.grid] ?? [];
    const unexpected = missing.filter((f) => !known.includes(f));

    expect(
      unexpected,
      `${spec.grid}: ${spec.renderer} reads ${unexpected.join(", ")}, which the DB ` +
        `projection does not return. Those columns render as em-dashes in production. ` +
        `Add them to the SELECT, or to KNOWN_MISSING with the reason.`,
    ).toEqual([]);
  });

  it("the known-gap list has not grown stale", async () => {
    // If a gap gets fixed but stays listed, the ratchet quietly stops
    // protecting that field. Catch that too.
    const stale: string[] = [];
    for (const spec of GRIDS) {
      const rows = await spec.fetch(db!);
      if (rows.length === 0) continue;
      const present = new Set<string>();
      for (const row of rows) for (const k of Object.keys(row)) present.add(k);
      for (const f of KNOWN_MISSING[spec.grid] ?? []) {
        if (present.has(f)) stale.push(`${spec.grid}.${f}`);
      }
    }

    expect(
      stale,
      `These are listed as known-missing but ARE now returned: ${stale.join(", ")}. ` +
        `Remove them from KNOWN_MISSING so the ratchet keeps protecting them.`,
    ).toEqual([]);
  });
});
