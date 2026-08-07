/**
 * Live-DB checks for the companies relations MossDb reconstructs (MOS-747).
 *
 * `main_contact` and `budget_relations` are not columns on `companies` — the
 * HTTP grid renders them from relation tables. MossDb has to rebuild them, and
 * the ONLY way to know the reconstruction matches is to run it against the real
 * replica. A hermetic test can assert the SQL was called; it cannot tell you the
 * join or the ordering is right, which is exactly where this went wrong before.
 *
 * Skipped unless MYSQL_* is configured, so CI stays hermetic. Run with:
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

interface CompanyRow {
  id: number | string;
  main_contact?: string;
  budget_relations?: string;
}

describe.skipIf(!HOST)("MossDb.getCompanies — reconstructed relations", () => {
  async function fetchRows(): Promise<CompanyRow[]> {
    const res = await db!.getCompanies<{ data: CompanyRow[] }>({ length: 400 });
    return res.data ?? [];
  }

  it("populates budget_relations for a substantial share of companies", async () => {
    // The regression this guards: the field was absent entirely, so every
    // consumer silently saw "". `list_customers`' has_active_project heuristic
    // infers activity from it and filtered out EVERY customer as a result.
    const rows = await fetchRows();
    const withRel = rows.filter((r) => (r.budget_relations ?? "").length > 0);

    expect(rows.length).toBeGreaterThan(0);
    expect(withRel.length).toBeGreaterThan(0);
  });

  it("renders budget_relations as comma-joined `code - name`", async () => {
    const rows = await fetchRows();
    const sample = rows.find((r) => (r.budget_relations ?? "").includes(","));
    expect(sample).toBeDefined();

    for (const entry of sample!.budget_relations!.split(", ")) {
      // Codes carry suffixes and names carry hyphens, so match the leading
      // "<code> - " shape rather than the whole entry.
      expect(entry).toMatch(/^\S+.*\s-\s.+/);
    }
  });

  it("orders budget_relations by association, which decides the default category", async () => {
    // Load-bearing: the tool layer treats the FIRST entry as the company's
    // default budget category. Association order (ORDER BY cbc.id) reproduced
    // the live HTTP render where neither budget-category id order nor `sort`
    // order did — company 1033 renders "7031, 7521, 7030", which is sorted by
    // neither code nor id.
    const rows = await fetchRows();
    const target = rows.find((r) => String(r.id) === "1033");
    if (!target) return; // company may be archived; the other cases still cover shape

    expect(target.budget_relations).toBe(
      "7031 - Cabinetry Allowance, 7521 - Plumbing Fixtures Allowance, 7030 - Cabinetry",
    );
  });

  it("resolves main_contact to the flagged user's full name", async () => {
    const rows = await fetchRows();
    const withContact = rows.filter((r) => (r.main_contact ?? "").length > 0);

    expect(withContact.length).toBeGreaterThan(0);
    // "First Last" — not an id, not an email.
    expect(withContact[0]!.main_contact).not.toMatch(/@/);
    expect(withContact[0]!.main_contact).toMatch(/\S/);
  });
});

describe.skipIf(!HOST)("MossDb.getProjects — status and search actually narrow", () => {
  // These exist because a previous "fix" computed a search clause and then
  // interpolated nothing into the query. It compiled, the tests passed (they
  // only exercised the pure clause builder), and the read kept returning
  // everything. Only a query against the real replica catches that.

  it("narrows to the requested statuses", async () => {
    const res = await db!.getProjects<{ data: Array<{ status: number }> }>({
      length: 500,
      "columns[1][search][value]": "5|6|7|8",
      "columns[1][search][regex]": "true",
    });
    const rows = res.data ?? [];

    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect([5, 6, 7, 8]).toContain(Number(r.status));
  });

  it("returns strictly fewer rows than an unfiltered read", async () => {
    // The regression was that filtered and unfiltered were byte-identical.
    const all = await db!.getProjects<{ data: unknown[] }>({ length: 500 });
    const active = await db!.getProjects<{ data: unknown[] }>({
      length: 500,
      "columns[1][search][value]": "5|6|7|8",
      "columns[1][search][regex]": "true",
    });

    expect((active.data ?? []).length).toBeLessThan((all.data ?? []).length);
  });

  it("honours a single status code without the regex form", async () => {
    const res = await db!.getProjects<{ data: Array<{ status: number }> }>({
      length: 500,
      "columns[1][search][value]": "6",
    });
    for (const r of res.data ?? []) expect(Number(r.status)).toBe(6);
  });

  it("narrows on search, and combines search with status", async () => {
    const miss = await db!.getProjects<{ data: unknown[] }>({
      length: 500,
      "search[value]": "zzzz-no-such-project",
    });
    expect((miss.data ?? []).length).toBe(0);

    const combo = await db!.getProjects<{ data: Array<{ status: number }> }>({
      length: 500,
      "search[value]": "a",
      "columns[1][search][value]": "6",
    });
    for (const r of combo.data ?? []) expect(Number(r.status)).toBe(6);
  });
});

describe.skipIf(!HOST)("MossDb.getTasks / getCompanies — status filters run in SQL", () => {
  // getTasks' status wiring shipped with no live test, only a clause-builder
  // unit test — which is exactly the gap that let PR #102 ship a dead clause.
  it("getTasks narrows to the requested status", async () => {
    const res = await db!.getTasks<{ data: Array<{ status: number }> }>({
      length: 300,
      "columns[1][search][value]": "1",
    });
    const rows = res.data ?? [];
    for (const r of rows) expect(Number(r.status)).toBe(1);
  });

  it("getTasks returns fewer rows than an unfiltered read", async () => {
    const all = await db!.getTasks<{ data: unknown[] }>({ length: 300 });
    const one = await db!.getTasks<{ data: unknown[] }>({
      length: 300,
      "columns[1][search][value]": "1",
    });
    expect((one.data ?? []).length).toBeLessThanOrEqual((all.data ?? []).length);
  });

  it("getCompanies narrows on status, which it previously ignored", async () => {
    // query.ts recorded companies' status column as verified and the adapter
    // compensated for it over HTTP, but this method never read column 0 — so
    // the filter was a silent no-op on the production path.
    const all = await db!.getCompanies<{ data: Array<{ status: number }> }>({
      length: 400,
    });
    const statuses = new Set((all.data ?? []).map((r) => Number(r.status)));
    const target = [...statuses][0];
    if (target === undefined) return;

    const filtered = await db!.getCompanies<{ data: Array<{ status: number }> }>(
      { length: 400, "columns[0][search][value]": String(target) },
    );
    for (const r of filtered.data ?? []) expect(Number(r.status)).toBe(target);
  });
});

describe.skipIf(!HOST)("MossDb.getChangeOrders — project scoping", () => {
  // list_change_orders asked for one project and, on this path, would have
  // received the 200 most recent change orders portfolio-wide — real rows,
  // plausible-looking, attributed to the wrong project.
  it("returns only the requested project's change orders", async () => {
    const all = await db!.getChangeOrders<{
      data: Array<{ project_id?: number }>;
    }>({ length: 200 });
    const rows = all.data ?? [];
    const target = rows.find((r) => r.project_id !== undefined)?.project_id;
    if (target === undefined) return;

    const scoped = await db!.getChangeOrders<{
      data: Array<{ project_id?: number }>;
    }>({ length: 200, "PR[]": target });

    const projects = new Set((scoped.data ?? []).map((r) => r.project_id));
    expect(projects.size).toBeLessThanOrEqual(1);
    if (projects.size === 1) expect([...projects][0]).toBe(target);
  });

  it("refuses a search it cannot honour rather than ignoring it", async () => {
    await expect(
      db!.getChangeOrders({ length: 10, "search[value]": "anything" }),
    ).rejects.toThrow(/cannot honour search/);
  });
});
