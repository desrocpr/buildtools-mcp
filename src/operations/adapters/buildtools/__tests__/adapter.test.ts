/**
 * Tests for the BuildTools operations adapter (MOS-747, Phase 1).
 *
 * The adapter's job is to absorb two things the tool layer should never have
 * known about: which read back end serves a call, and the DataTables `DT_RowId`
 * artifact. Both are tested here behaviourally — with stateful fakes standing in
 * for the HTTP client and the DB fast path — rather than by asserting on call
 * spies.
 */

import { describe, expect, it } from "vitest";

import type { BuildToolsAPI } from "../../../../client/BuildToolsAPI.js";
import { getOperationsManagementApi } from "../../../factory.js";
import { BuildToolsOperationsAdapter } from "../adapter.js";

/**
 * A fake standing in for either back end. Records nothing — the tests assert on
 * the DATA that comes back, which is what distinguishes the two paths.
 */
function fakeBackend(label: string, rows: Array<Record<string, unknown>>) {
  return {
    async getProjects() {
      return { data: rows, recordsTotal: rows.length, source: label };
    },
    async getProject(id: string | number) {
      return { id, source: label };
    },
    async getBudget() {
      return { items: [], columns: [label] };
    },
  };
}

/** Build an adapter over a fake client, optionally with a DB fast path. */
function adapterOver(opts: {
  http: ReturnType<typeof fakeBackend>;
  db?: ReturnType<typeof fakeBackend>;
}) {
  const api = { ...opts.http, db: opts.db ?? null } as unknown as BuildToolsAPI;
  return new BuildToolsOperationsAdapter(api);
}

describe("read-path selection", () => {
  it("prefers the DB fast path when one is attached", async () => {
    const adapter = adapterOver({
      http: fakeBackend("http", []),
      db: fakeBackend("db", []),
    });

    const result = (await adapter.getProjects()) as { source: string };

    expect(result.source).toBe("db");
  });

  it("falls back to HTTP when no DB is attached", async () => {
    // This is the local-dev and test configuration: MYSQL_* unset, api.db null.
    const adapter = adapterOver({ http: fakeBackend("http", []) });

    const result = (await adapter.getProjects()) as { source: string };

    expect(result.source).toBe("http");
  });

  it("re-resolves the back end per call rather than caching it", async () => {
    // The transport attaches `api.db` at startup; a cached reader captured at
    // construction would pin whichever value happened to exist first.
    const api = {
      ...fakeBackend("http", []),
      db: null,
    } as unknown as BuildToolsAPI;
    const adapter = new BuildToolsOperationsAdapter(api);

    expect(((await adapter.getProjects()) as { source: string }).source).toBe(
      "http",
    );

    // Written through a loosened view: `db` is typed `MossDb | null`, and the
    // fake deliberately implements only the methods this test exercises.
    (api as unknown as { db: unknown }).db = fakeBackend("db", []);

    expect(((await adapter.getProjects()) as { source: string }).source).toBe(
      "db",
    );
  });
});

describe("id normalisation across the boundary", () => {
  it("normalises rows from the HTTP path", async () => {
    // The HTTP datatable carries the id only in DT_RowId for several grids.
    const adapter = adapterOver({
      http: fakeBackend("http", [{ DT_RowId: "row_37904", name: "Katchmark" }]),
    });

    const result = (await adapter.getProjects()) as {
      data: Array<Record<string, unknown>>;
    };

    expect(result.data[0]).toEqual({ id: 37904, name: "Katchmark" });
    expect(result.data[0]).not.toHaveProperty("DT_RowId");
  });

  it("normalises rows from the DB path too", async () => {
    // MossDb fabricates `row_${id}` purely to imitate the HTTP envelope. The
    // adapter strips it on both paths, so callers see one shape.
    const adapter = adapterOver({
      http: fakeBackend("http", []),
      db: fakeBackend("db", [{ id: 12, DT_RowId: "row_12", name: "x" }]),
    });

    const result = (await adapter.getProjects()) as {
      data: Array<Record<string, unknown>>;
    };

    expect(result.data[0]).toEqual({ id: 12, name: "x" });
  });

  it("normalises single-record reads, which return a BARE row not an envelope", async () => {
    // getProject/getCompany/getCustomer/getChangeOrder scan a datatable and
    // return the matched row directly — there is no {data: [...]} wrapper for
    // envelope normalisation to latch onto. The companies grid is the sharp
    // case: it carries NO top-level id, so the row's only identity is DT_RowId
    // (BuildToolsAPI.getCompany matches on `row_${id}` for exactly that reason).
    const api = {
      async getCompany() {
        return { DT_RowId: "row_977", name: "Acme Supply", type_name: "Vendor" };
      },
      db: null,
    } as unknown as BuildToolsAPI;
    const adapter = new BuildToolsOperationsAdapter(api);

    const company = (await adapter.getCompany(977)) as Record<string, unknown>;

    expect(company.id).toBe(977);
    expect(company).not.toHaveProperty("DT_RowId");
  });

  it("returns null from a single-record read rather than an empty row", async () => {
    // null means "not found" and must survive normalisation untouched.
    const api = {
      async getProject() {
        return null;
      },
      db: null,
    } as unknown as BuildToolsAPI;

    expect(await new BuildToolsOperationsAdapter(api).getProject(1)).toBeNull();
  });

  it("leaves bespoke, non-envelope shapes alone", async () => {
    const adapter = adapterOver({ http: fakeBackend("http", []) });

    const budget = await adapter.getBudget(1);

    expect(budget).toEqual({ items: [], columns: ["http"] });
  });

  it("reports its provider", async () => {
    expect(adapterOver({ http: fakeBackend("http", []) }).provider).toBe(
      "buildtools",
    );
  });
});

describe("schedule session priming", () => {
  // BuildTools' HTTP /schedule/*/data only returns the full task list AFTER
  // /budget has been requested for that project (live probe 2026-06-28,
  // recorded in briefs.ts). Without the prime it returns a project-root stub.
  // The DB path is project-scoped in SQL and needs no prime.
  //
  // This lived in the tool layer, gated on `api.db`. The neutral interface has
  // no `api.db`, so if the adapter does not own the precondition a retarget
  // silently produces stub schedules — with no compile error to catch it.
  function scheduleFake() {
    const calls: string[] = [];
    return {
      calls,
      async getBudget() {
        calls.push("budget");
        return { items: [], columns: [] };
      },
      async getSchedule() {
        calls.push("schedule");
        return { tasks: [], links: [] };
      },
    };
  }

  it("primes the session with a budget fetch before the HTTP schedule read", async () => {
    const http = scheduleFake();
    const adapter = new BuildToolsOperationsAdapter({
      ...http,
      db: null,
    } as unknown as BuildToolsAPI);

    await adapter.getSchedule(42);

    expect(http.calls).toEqual(["budget", "schedule"]);
  });

  it("skips the prime on the DB path, which is project-scoped in SQL", async () => {
    // The prime costs ~2s/project because it triggers the expensive
    // per-category budget aggregation — real money on a team-wide forecast.
    const http = scheduleFake();
    const db = scheduleFake();
    const adapter = new BuildToolsOperationsAdapter({
      ...http,
      db,
    } as unknown as BuildToolsAPI);

    await adapter.getSchedule(42);

    expect(db.calls).toEqual(["schedule"]);
    expect(http.calls).toEqual([]);
  });

  it("still returns the schedule when priming fails", async () => {
    // A failed prime degrades the result; it must not fail the read outright.
    const adapter = new BuildToolsOperationsAdapter({
      async getBudget() {
        throw new Error("budget exploded");
      },
      async getSchedule() {
        return { tasks: [{ id: 1 }], links: [] };
      },
      db: null,
    } as unknown as BuildToolsAPI);

    const schedule = await adapter.getSchedule(42);

    expect(schedule.tasks).toHaveLength(1);
  });
});

describe("delegation wiring", () => {
  // 27 near-identical hand-written delegating methods is exactly where a
  // copy-paste slip hides — `getServices` quietly calling `getUsers` would pass
  // every other test in this file. This asserts each method reaches its
  // same-named counterpart on the back end.
  const READS = [
    ["getProjects", []],
    ["getCompanies", []],
    ["getPurchaseOrders", []],
    ["getTasks", []],
    ["getRFIs", []],
    ["getServices", []],
    ["getUsers", []],
    ["getCertificates", []],
    ["getDailyLogs", []],
    ["getWeeklyReports", []],
    ["getWorkDays", []],
    ["searchCertificates", ["query", 10]],
    ["getProject", [1]],
    ["getCompany", [1]],
    ["getCustomer", [1]],
    ["getChangeOrder", [1]],
    ["getPurchaseOrder", [1]],
    ["getFinancialStatement", [1]],
    ["getBudget", [1]],
    ["getAllowances", [1]],
    ["getSelections", [1]],
    ["getFinancialStatements", [1]],
    ["getSchedule", [1]],
    ["getSelectionBudgetCategories", [1]],
    ["getSelectionName", [1, 2]],
    ["getSelectionDetail", [1, 2]],
    ["findUnbilledChangeOrders", [{}]],
  ] as const;

  it.each(READS)("%s reaches the identically named back-end method", async (
    method,
    args,
  ) => {
    // Every method answers with its own name, so a mis-wired delegation
    // surfaces as the wrong name coming back.
    const backend: Record<string, unknown> = {};
    for (const [name] of READS) {
      backend[name] = async () => ({ called: name });
    }
    const api = { ...backend, db: null } as unknown as BuildToolsAPI;
    const adapter = new BuildToolsOperationsAdapter(api);

    const call = adapter[method] as (...a: unknown[]) => Promise<unknown>;
    const result = (await call.apply(adapter, [...args])) as {
      called: string;
    };

    expect(result.called).toBe(method);
  });
});

describe("factory", () => {
  it("builds the BuildTools adapter when configured for it", () => {
    const api = fakeBackend("http", []) as unknown as BuildToolsAPI;

    const api2 = getOperationsManagementApi(
      { provider: "buildtools" },
      { buildToolsApi: api },
    );

    expect(api2.provider).toBe("buildtools");
  });

  it("throws when the provider needs a client that was not supplied", () => {
    expect(() => getOperationsManagementApi({ provider: "buildtools" })).toThrow(
      /requires an authenticated BuildToolsAPI/,
    );
  });

  it("throws on an unknown provider rather than defaulting to one", () => {
    // Silently defaulting is how a mis-configured tenant writes to the wrong
    // system. Unconfigured must be structurally inert.
    expect(() => getOperationsManagementApi({ provider: "acme-pm" })).toThrow(
      /unknown provider 'acme-pm'/,
    );
  });
});
