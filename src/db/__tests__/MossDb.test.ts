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

  // These previously asserted status=4 renders "Sent"/"Partly Paid"/"Paid" by
  // paid amount. That was the implementation restated, not BuildTools'
  // behaviour: pulling statements of each code from the replica and reading
  // what the HTTP grid showed for those same ids gives the mapping below, and
  // the code ALONE decides it.
  it("status=4 → 'To Pay', whatever the paid amount", () => {
    expect(fsStatusLabel(4, 0, 1000)).toBe("To Pay");
    expect(fsStatusLabel(4, 500, 1000)).toBe("To Pay");
  });
  it("status=5 → 'Partly Paid', even when fully paid", () => {
    // Verified: a code-5 statement paid in full still renders "Partly Paid",
    // as does one with a negative paid amount. BuildTools' own oddity, mirrored.
    expect(fsStatusLabel(5, 0, 1000)).toBe("Partly Paid");
    expect(fsStatusLabel(5, 1000, 1000)).toBe("Partly Paid");
  });
  it("status=6 → 'Paid', even when nothing is recorded as paid", () => {
    expect(fsStatusLabel(6, 1000, 1000)).toBe("Paid");
    expect(fsStatusLabel(6, 0, 1000)).toBe("Paid");
  });
  it("status=1 → 'Draft'", () => {
    expect(fsStatusLabel(1, 0, 1000)).toBe("Draft");
  });
  it("status=2 → 'Unknown', which is what BuildTools itself shows", () => {
    expect(fsStatusLabel(2, 0, 1000)).toBe("Unknown");
  });

  it("mmddyyyy formats Date", () => {
    expect(mmddyyyy(new Date(2026, 5, 28))).toBe("06/28/2026");
  });
  it("mmddyyyy empty for null", () => {
    expect(mmddyyyy(null)).toBe("");
    expect(mmddyyyy(undefined)).toBe("");
  });
});

describe("MossDb — selection status labeling", () => {
  const { selectionStatusLabel } = __test__;

  // The map this pins was SHIFTED BY ONE and shipped that way. It labelled status 4 "Approved"
  // when status 4 is Rejected — 31 of 31 rows carry a rejected_date and none carries an
  // approved_date — so every rejected pick was reported to a user as approved. Counts and date
  // coverage below are from the replica on 2026-08-21.

  it("status=4 → 'Rejected' — the one that was reported as 'Approved'", () => {
    // 31 rows, 0 approved_date, 31 rejected_date. Unambiguous.
    expect(selectionStatusLabel(4)).toBe("Rejected");
  });

  it("status=3 → 'Approved' — the largest bucket, previously labelled 'Selected'", () => {
    // 9,615 rows, 9,033 with approved_date.
    expect(selectionStatusLabel(3)).toBe("Approved");
  });

  it("status=5 → 'Complete' — downstream of approval, 100% carry approved_date", () => {
    // 4,258 rows, 4,258 with approved_date. BuildTools' own UI calls this "Complete".
    expect(selectionStatusLabel(5)).toBe("Complete");
  });

  it("status=1/2 → 'Open'/'Selected'", () => {
    expect(selectionStatusLabel(1)).toBe("Open");
    expect(selectionStatusLabel(2)).toBe("Selected");
  });

  it("status=6 does not exist — an unmapped code is named, never guessed", () => {
    // The old map assigned "Rejected" to 6. No status-6 row exists, so that label could never
    // be applied to anything while the real rejected bucket was called "Approved".
    expect(selectionStatusLabel(6)).toBe("Status6");
  });

  it("the labels match what listSelections offers as a filter", () => {
    // These two drifted apart: filtering "Complete" matched nothing (the map emitted
    // "Purchased") and filtering "Approved" returned the rejected picks.
    const filterable = ["Open", "Selected", "Approved", "Rejected", "Complete"];
    expect([1, 2, 3, 4, 5].map(selectionStatusLabel)).toEqual(filterable);
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
