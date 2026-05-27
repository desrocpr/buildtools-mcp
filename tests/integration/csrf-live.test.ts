/**
 * Live CSRF-regex smoke test — MOS-284.
 *
 * Fetches the unauthenticated BuildTools login page over the public network
 * and asserts that the production CSRF-harvest regex (the one used in
 * `src/client/BuildToolsAPI.ts` at the login flow) still matches a
 * non-empty `_token` value in the live HTML response.
 *
 * Scope: narrow. Single unauthenticated GET; no credentials required; no
 * mutations; not a read+write+confirmation E2E (that's MOS-222).
 *
 * Gating: the entire suite is skipped unless `BUILDTOOLS_LIVE=1` is set in
 * the environment. With the env var unset, `npm test` continues to pass
 * with this suite skipped (NOT failed) — CI does not make outbound network
 * calls by default.
 *
 * To run locally:
 *
 *     BUILDTOOLS_LIVE=1 npm test
 *
 * Failure here means production HTML has drifted again and the unit
 * fixtures need updating.
 */

import { describe, expect, it } from "vitest";

const LIVE = process.env.BUILDTOOLS_LIVE === "1";

// Mirrors the production regex at src/client/BuildToolsAPI.ts (login flow).
// Tolerant to any/no intermediate attributes between `name="_token"` and
// `value="..."` (MOS-284).
const CSRF_REGEX = /name="_token"[^>]*value="([^"]+)"/;

const LOGIN_URL = "https://core.buildtools.app/login?m=1&o=0ye79w";

describe.skipIf(!LIVE)("CSRF regex — live BuildTools login HTML", () => {
  it(
    "matches a non-empty _token in the production login page",
    async () => {
      const res = await fetch(LOGIN_URL, { redirect: "manual" });
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(400);

      const body = await res.text();
      const match = body.match(CSRF_REGEX);

      expect(
        match,
        `Expected CSRF regex to find _token in live HTML from ${LOGIN_URL}`,
      ).not.toBeNull();
      // Assert non-empty value; do NOT assert on token content (it rotates).
      expect(match?.[1]?.length ?? 0).toBeGreaterThan(0);
    },
    10_000,
  );
});
