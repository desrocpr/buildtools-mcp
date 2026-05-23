/**
 * Vitest config — enforces ≥80% line coverage on `src/client/` per MOS-265.
 *
 * `npm test` runs `vitest run` (see package.json). This config wires up the
 * v8 coverage provider with a focused include + threshold so a regression in
 * client coverage fails CI, without polluting the report with the (Phase 1)
 * server entrypoint or the transport smoke test.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/client/**/*.ts"],
      exclude: ["src/client/**/__tests__/**", "src/client/**/*.d.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});
