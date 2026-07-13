/**
 * Vitest config — coverage gate for the whole `src/` tree (MOS-631).
 *
 * `npm test` runs `vitest run` (see package.json); `coverage.enabled` makes the
 * v8 report + thresholds run on every `npm test` (and in CI — see
 * `.github/workflows/ci.yml`).
 *
 * The thresholds are a RATCHETING FLOOR set just below the current measured
 * coverage: they pass today and block regressions, and should be raised as
 * coverage improves. They are intentionally global (not per-file) — much of the
 * auth/web/db surface is still thinly covered (see the testing-coverage notes),
 * so a per-file gate would fail until that backfill lands. Raise the floor as
 * those areas get real tests rather than leaving it permanently loose.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/__tests__/**",
        "src/**/*.d.ts",
        "src/index.ts", // process entrypoint (transport selection + boot)
      ],
      thresholds: {
        lines: 65,
        statements: 65,
        functions: 75,
        branches: 70,
      },
    },
  },
});
