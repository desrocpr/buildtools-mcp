/**
 * The ONE place an operations-management vendor is selected (MOS-747, Phase 1).
 *
 * Shape copied deliberately from Cambium's `getConstructionPmAdapter` — one
 * `case` per vendor, hard throw on anything unrecognised. An unknown provider
 * must never fall through to a default vendor: silently defaulting is how a
 * mis-configured tenant ends up writing to the wrong system.
 *
 * This switch is the entire cost of swapping operations systems. Nothing above
 * it — no tool handler, no transport, no gateway route — ever learns a vendor
 * name.
 */

import type { BuildToolsAPI } from "../client/BuildToolsAPI.js";
import { buildBuildToolsOperationsAdapter } from "./adapters/buildtools/adapter.js";
import { buildMockOperationsApi, type MockSeed } from "./adapters/mock.js";
import type {
  OperationsManagementApi,
  OperationsTenantConfig,
} from "./types.js";

export interface OperationsAdapterDeps {
  /**
   * An authenticated vendor client. Present while BuildTools is the only
   * adapter; a second vendor would take its own dependency here.
   */
  buildToolsApi?: BuildToolsAPI;
  /** Seed data for the `mock` provider. */
  mockSeed?: MockSeed;
}

export function getOperationsManagementApi(
  config: OperationsTenantConfig,
  deps: OperationsAdapterDeps = {},
): OperationsManagementApi {
  switch (config.provider) {
    case "mock":
      // A first-class provider, not a test-only escape hatch: it is the
      // rehearsal/dry-run target and the way the tool layer runs with no vendor
      // credentials at all.
      return buildMockOperationsApi(deps.mockSeed);

    case "buildtools": {
      if (!deps.buildToolsApi) {
        throw new Error(
          "operations: provider 'buildtools' requires an authenticated BuildToolsAPI instance",
        );
      }
      return buildBuildToolsOperationsAdapter(deps.buildToolsApi);
    }
    default:
      throw new Error(
        `operations: unknown provider '${config.provider}' — tenant is not enabled for operations access`,
      );
  }
}
