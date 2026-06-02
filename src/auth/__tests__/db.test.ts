import { describe, expect, it } from "vitest";

import { createDb } from "../db.js";

describe("createDb", () => {
  it("throws when SUPABASE_URL is missing", () => {
    expect(() =>
      createDb({ env: { SUPABASE_SERVICE_ROLE_KEY: "anything" } }),
    ).toThrow(/SUPABASE_URL/);
  });

  it("throws when SUPABASE_SERVICE_ROLE_KEY is missing", () => {
    expect(() =>
      createDb({ env: { SUPABASE_URL: "https://example.supabase.co" } }),
    ).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("returns a client when both vars are set", () => {
    const db = createDb({
      env: {
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      },
    });
    expect(db).toBeDefined();
    expect(typeof db.from).toBe("function");
  });
});
