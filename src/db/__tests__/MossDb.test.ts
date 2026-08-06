import { describe, expect, it } from "vitest";

import { __test__, buildMossDbFromEnv, MossDb } from "../MossDb.js";

describe("MossDb — env-gated factory", () => {
  it("buildMossDbFromEnv returns null when MYSQL_HOST is absent", () => {
    expect(buildMossDbFromEnv({})).toBeNull();
    expect(buildMossDbFromEnv({ MYSQL_HOST: "x" })).toBeNull();
    expect(buildMossDbFromEnv({ MYSQL_HOST: "x", MYSQL_USER: "u" })).toBeNull();
  });

  it("buildMossDbFromEnv returns a MossDb instance when all 4 vars are set", () => {
    const db = buildMossDbFromEnv({
      MYSQL_HOST: "h", MYSQL_USER: "u", MYSQL_PASSWORD: "p", MYSQL_DATABASE: "d",
    });
    expect(db).toBeInstanceOf(MossDb);
    // Don't await close — pool was never used and ending it sync would log noise.
    db?.close().catch(() => {});
  });
});

describe("MossDb — FS status labeling", () => {
  const { fsStatusLabel, mmddyyyy } = __test__;

  it("status=4 paid=0 → 'Sent'", () => {
    expect(fsStatusLabel(4, 0, 1000)).toBe("Sent");
  });
  it("status=4 paid<amount → 'Partly Paid'", () => {
    expect(fsStatusLabel(4, 500, 1000)).toBe("Partly Paid");
  });
  it("status=4 paid≈amount → 'Paid'", () => {
    expect(fsStatusLabel(4, 1000, 1000)).toBe("Paid");
  });
  it("status=6 → 'Paid'", () => {
    expect(fsStatusLabel(6, 1000, 1000)).toBe("Paid");
  });
  it("status=1 → 'Draft'", () => {
    expect(fsStatusLabel(1, 0, 1000)).toBe("Draft");
  });

  it("mmddyyyy formats Date", () => {
    expect(mmddyyyy(new Date(2026, 5, 28))).toBe("06/28/2026");
  });
  it("mmddyyyy empty for null", () => {
    expect(mmddyyyy(null)).toBe("");
    expect(mmddyyyy(undefined)).toBe("");
  });
});

describe("MossDb — search handling (search[value])", () => {
  const { searchClause, rejectUnsupportedSearch } = __test__;

  // Five list methods silently ignored search[value]. The HTTP path honours it,
  // so with MYSQL_* configured (production) a searched read returned the first
  // N rows UNFILTERED and the tool rendered them as matches. list_projects with
  // a `query` argument was live-affected, with no client-side fallback.

  it("builds an OR-LIKE clause over the given columns", () => {
    const out = searchClause({ "search[value]": "Katch" }, ["p.name", "p.city"]);

    expect(out.sql).toBe("(p.name LIKE ? OR p.city LIKE ?)");
    expect(out.params).toEqual(["%Katch%", "%Katch%"]);
  });

  it("emits nothing when no search term was supplied", () => {
    expect(searchClause({}, ["p.name"]).sql).toBeNull();
    expect(searchClause({ "search[value]": "" }, ["p.name"]).sql).toBeNull();
    expect(searchClause({ "search[value]": "   " }, ["p.name"]).sql).toBeNull();
  });

  it("keeps one bind parameter per column, so the SQL stays parameterised", () => {
    // Guards the injection surface as much as the behaviour: the term is never
    // interpolated into the statement.
    const out = searchClause({ "search[value]": "'; DROP TABLE projects;--" }, [
      "a",
      "b",
      "c",
    ]);

    expect(out.params).toHaveLength(3);
    expect(out.sql).not.toContain("DROP");
  });

  it("rejects a search on a grid with no searchable columns mapped", () => {
    // Failing loudly beats returning unfiltered rows that present as matches —
    // that silence is exactly how this bug class stayed invisible.
    expect(() =>
      rejectUnsupportedSearch({ "search[value]": "x" }, "getWorkDays"),
    ).toThrow(/cannot honour search\[value\]/);
  });

  it("allows a call with no search term through unharmed", () => {
    expect(() => rejectUnsupportedSearch({}, "getWorkDays")).not.toThrow();
    expect(() =>
      rejectUnsupportedSearch({ "search[value]": "" }, "getWorkDays"),
    ).not.toThrow();
  });
});
