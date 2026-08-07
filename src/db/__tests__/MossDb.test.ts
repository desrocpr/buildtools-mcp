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

describe("MossDb — statusClause", () => {
  const { statusClause } = __test__;
  const KEY = "columns[1][search][value]";

  it("builds an IN clause from a single code", () => {
    const out = statusClause({ [KEY]: "6" }, 1, "p.status");
    expect(out.sql).toBe("p.status IN (?)");
    expect(out.params).toEqual([6]);
  });

  it("builds an IN clause from the pipe-joined multi-code form", () => {
    const out = statusClause({ [KEY]: "5|6|7|8" }, 1, "p.status");
    expect(out.sql).toBe("p.status IN (?, ?, ?, ?)");
    expect(out.params).toEqual([5, 6, 7, 8]);
  });

  it("emits no clause when the key is absent", () => {
    expect(statusClause({}, 1, "p.status").sql).toBeNull();
  });

  it("treats an empty value as 'no filter', not as status 0", () => {
    // Number("") is 0 and passes Number.isFinite, so the first version built
    // `IN (0)` — which matches nothing, since codes start at 1.
    expect(statusClause({ [KEY]: "" }, 1, "p.status").sql).toBeNull();
    expect(statusClause({ [KEY]: "   " }, 1, "p.status").sql).toBeNull();
  });

  it("THROWS on an unparseable value rather than dropping the filter", () => {
    // Silently returning "no filter" is precisely the bug this function exists
    // to prevent: the caller asked to narrow and would get everything back,
    // rendered as filtered. Mixing status and companyType is the easy slip.
    expect(() => statusClause({ [KEY]: "Vendor" }, 1, "p.status")).toThrow(
      /not a valid code/,
    );
  });

  it("THROWS on a partially-numeric list rather than silently narrowing", () => {
    // "5|abc|7" must not quietly become IN (5,7) — that is a different query
    // than the caller asked for.
    expect(() => statusClause({ [KEY]: "5|abc|7" }, 1, "p.status")).toThrow(
      /not a valid code/,
    );
  });

  it("bounds the number of codes it will turn into placeholders", () => {
    const many = Array.from({ length: 200 }, (_, i) => i + 1).join("|");
    expect(() => statusClause({ [KEY]: many }, 1, "p.status")).toThrow(/max/);
  });

  it("binds values as parameters rather than interpolating them", () => {
    const out = statusClause({ [KEY]: "5|6" }, 1, "p.status");
    expect(out.sql).not.toContain("5");
    expect(out.params).toEqual([5, 6]);
  });
});
