/**
 * Adapter conformance (MOS-747).
 *
 * Phase 3 rewrites ~150 tool tests onto the mock adapter. From that point on, a
 * green test proves the tool works *against the mock* — which is only useful if
 * the mock and the real adapter agree. Where they diverge, a test passes and
 * production breaks, which is worse than having no mock at all.
 *
 * So this file pins the places the two MUST behave identically, and documents
 * the places they legitimately cannot.
 */

import { describe, expect, it } from "vitest";

import {
  assertStatusFilterSupported,
  toDatatableParams,
  type GridName,
} from "../adapters/buildtools/query.js";
import { MockOperationsApi } from "../adapters/mock.js";

/** Every grid reachable through the interface, and its list method. */
const GRIDS: Array<{ grid: GridName; call: keyof MockOperationsApi }> = [
  { grid: "projects", call: "getProjects" },
  { grid: "companies", call: "getCompanies" },
  { grid: "purchaseOrders", call: "getPurchaseOrders" },
  { grid: "tasks", call: "getTasks" },
  { grid: "rfis", call: "getRFIs" },
  { grid: "services", call: "getServices" },
  { grid: "users", call: "getUsers" },
  { grid: "certificates", call: "getCertificates" },
  { grid: "dailyLogs", call: "getDailyLogs" },
  { grid: "weeklyReports", call: "getWeeklyReports" },
  { grid: "workDays", call: "getWorkDays" },
];

describe("status filtering: mock and BuildTools adapter agree on throw-vs-filter", () => {
  it.each(GRIDS)(
    "$grid behaves the same in both adapters",
    async ({ grid, call }) => {
      // Ask the real translator whether this grid supports status filtering.
      let realThrows = false;
      try {
        assertStatusFilterSupported(grid);
      } catch {
        realThrows = true;
      }

      // Ask the mock the same question by actually calling it.
      const mock = new MockOperationsApi({ [grid]: [{ id: 1, status: 1 }] });
      const invoke = mock[call] as (q: unknown) => Promise<unknown>;
      let mockThrows = false;
      try {
        await invoke.call(mock, { status: 1 });
      } catch {
        mockThrows = true;
      }

      // The point of the file: identical failure surface. A mock that filtered
      // where production throws would make a Phase 3 test green and the real
      // call explode.
      expect(mockThrows).toBe(realThrows);
    },
  );

  it("confirms the verified/unverified split is what we think it is", () => {
    // Guards against someone "fixing" a throw by guessing a column index.
    expect(() => toDatatableParams("projects", { status: 1 })).not.toThrow();
    expect(() => toDatatableParams("tasks", { status: 1 })).not.toThrow();
    expect(() => toDatatableParams("companies", { status: 1 })).not.toThrow();
    expect(() => toDatatableParams("changeOrders", { status: 1 })).not.toThrow();

    for (const grid of [
      "purchaseOrders",
      "rfis",
      "services",
      "users",
      "certificates",
      "dailyLogs",
      "weeklyReports",
      "workDays",
    ] as GridName[]) {
      expect(() => toDatatableParams(grid, { status: 1 })).toThrow(
        /not verified/,
      );
    }
  });
});

describe("non-status facets are accepted by both on every grid", () => {
  it.each(GRIDS)("$grid accepts search and paging", async ({ grid, call }) => {
    expect(() =>
      toDatatableParams(grid, { search: "x", limit: 5, offset: 1 }),
    ).not.toThrow();

    const mock = new MockOperationsApi({ [grid]: [{ id: 1, name: "x" }] });
    const invoke = mock[call] as (q: unknown) => Promise<unknown>;
    await expect(
      invoke.call(mock, { search: "x", limit: 5, offset: 1 }),
    ).resolves.toBeDefined();
  });
});

describe("documented divergences", () => {
  // These are NOT bugs in the mock — they are places the mock cannot faithfully
  // model the back ends, recorded so a green mock-backed test is not read as
  // proof about production.

  it("search scope: the mock matches any string field; the DB path does not", () => {
    // MossDb.getProjects ignores search entirely (no search[value] handling),
    // and MossDb.getCompanies/getTasks narrow to specific columns via SQL LIKE.
    // So a passing mock search test says nothing about the DB fast path — which
    // is the production path whenever MYSQL_* is configured.
    const mock = new MockOperationsApi({
      projects: [{ id: 1, city: "Fairfax" }],
    });

    // The mock finds it by a non-name field. MossDb would not.
    return mock
      .getProjects({ search: "fairfax" })
      .then((r) => {
        expect((r as { data: unknown[] }).data).toHaveLength(1);
      });
  });

  it("recordsTotal: the mock reports the filtered count, not a grand total", () => {
    // Real DataTables envelopes carry recordsTotal (unfiltered grand total)
    // distinct from recordsFiltered. Every current call site reads
    // `recordsFiltered ?? recordsTotal ?? rows.length`, so this is invisible
    // today — but code that reads recordsTotal expecting "how many exist"
    // would get the filtered count from the mock.
    const mock = new MockOperationsApi({
      projects: [
        { id: 1, name: "a" },
        { id: 2, name: "b" },
      ],
    });

    return mock.getProjects({ search: "a" }).then((r) => {
      const env = r as { recordsTotal: number; recordsFiltered: number };
      expect(env.recordsTotal).toBe(env.recordsFiltered);
    });
  });
});
