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
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Spread the defaults — assigning `exclude` REPLACES them, which would
    // silently re-enable test discovery inside node_modules.
    //
    // The extra entry guards against a nested clone of this repo at the root
    // (there was one, committed as a stale gitlink). Such a copy is outside
    // the coverage `include` but inside vitest's discovery glob, so its
    // duplicate tests ran against dead source without failing anything.
    exclude: [...configDefaults.exclude, "buildtools-mcp/**"],

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
      // Raised from 69/69/75/70 (MOS-747 Phase 5). Measured coverage has sat
      // at ~72/75/81 for several slices while the floor stayed where it was
      // set months ago, which means it had stopped catching anything. Set just
      // under the current numbers again, per this file's own instruction.
      thresholds: {
        lines: 71,
        statements: 71,
        functions: 79,
        branches: 73,
      },
    },
  },
});
