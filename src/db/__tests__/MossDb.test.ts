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
