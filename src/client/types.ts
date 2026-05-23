/**
 * Zod schemas + inferred TypeScript types for BuildToolsAPI.
 *
 * All entity schemas use `.passthrough()` because the BuildTools form/datatable
 * payloads carry many fields beyond what's documented in `api-client.js`. We
 * tolerate (and preserve) those extras rather than silently dropping them.
 *
 * Phase 2.1 ships the minimum surface needed by the client and its tests.
 * Comprehensive per-method fixtures and schemas land in MOS-213 (Phase 2.3).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Client construction options
// ---------------------------------------------------------------------------

/**
 * Options for constructing a `BuildToolsAPI` instance.
 *
 * NOTE on `tenant` derivation: the Linear issue suggested `tenant` would derive
 * BOTH `authUrl` and `baseUrl`, but in practice only `baseUrl` is naturally
 * tenanted (e.g. `moss.buildtools.app`). The auth host (`core.buildtools.app`)
 * is shared across all tenants. So we let `tenant` derive ONLY `baseUrl`
 * (`https://${tenant}.buildtools.app`); `authUrl` always defaults to
 * `https://core.buildtools.app` unless explicitly overridden.
 *
 * Explicit `baseUrl` / `authUrl` always win over derivations.
 *
 * Env-var fallbacks (`BUILDTOOLS_BASE_URL` / `BUILDTOOLS_AUTH_URL`) mirror
 * source `api-client.js` L56–57.
 */
export const BuildToolsClientOptionsSchema = z
  .object({
    /** Tenant subdomain — derives `baseUrl` as `https://${tenant}.buildtools.app`. */
    tenant: z.string().min(1).optional(),
    /** Override the application host (default `https://moss.buildtools.app`). */
    baseUrl: z.string().url().optional(),
    /** Override the auth host (default `https://core.buildtools.app`). */
    authUrl: z.string().url().optional(),
    /** Optional default fetch timeout (milliseconds) for every request. */
    defaultTimeoutMs: z.number().int().positive().optional(),
    /**
     * Optional fetch implementation override (primarily for tests). If unset,
     * `globalThis.fetch` is used (Node ≥18).
     */
    fetch: z.custom<typeof fetch>().optional(),
  })
  .strict();

export type BuildToolsClientOptions = z.infer<typeof BuildToolsClientOptionsSchema>;

// ---------------------------------------------------------------------------
// DataTable response (generic)
// ---------------------------------------------------------------------------

/**
 * Server-side DataTables response envelope used by `/datatable` endpoints.
 * The `data` array's element shape varies by resource; callers supply it.
 */
export const DatatableResponseSchema = <T extends z.ZodTypeAny>(rowSchema: T) =>
  z
    .object({
      draw: z.number().optional(),
      recordsTotal: z.number().optional(),
      recordsFiltered: z.number().optional(),
      data: z.array(rowSchema),
    })
    .passthrough();

export type DatatableResponse<T> = {
  draw?: number;
  recordsTotal?: number;
  recordsFiltered?: number;
  data: T[];
  [k: string]: unknown;
};

// ---------------------------------------------------------------------------
// Project (the one domain entity Phase 2.1 schemas; MOS-213 adds the rest)
// ---------------------------------------------------------------------------

export const ProjectSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    name: z.string(),
    status: z.union([z.string(), z.number()]).optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    zip: z.string().optional(),
    country_code: z.string().optional(),
    description: z.string().optional(),
  })
  .passthrough();

export type Project = z.infer<typeof ProjectSchema>;

// ---------------------------------------------------------------------------
// Save-result envelopes returned by the source's create/update methods
// ---------------------------------------------------------------------------

/**
 * Shape returned by `createProject` / `updateProject` (source emits `r:1` on
 * success along with `projectId`, or `e`/`errors` on failure).
 */
export const ProjectSaveResultSchema = z.object({
  success: z.boolean(),
  projectId: z.union([z.string(), z.number()]).optional(),
  errors: z.unknown().optional(),
});
export type ProjectSaveResult = z.infer<typeof ProjectSaveResultSchema>;

/** Generic save-result for change-order / RFI / PO / task / service / invoice. */
export const SuccessSaveResultSchema = z.object({
  success: z.boolean(),
  id: z.union([z.string(), z.number()]).optional(),
  message: z.unknown().optional(),
  errors: z.unknown().optional(),
});
export type SuccessSaveResult = z.infer<typeof SuccessSaveResultSchema>;

// ---------------------------------------------------------------------------
// Datatable param helper
// ---------------------------------------------------------------------------

/**
 * Accepted shape for `datatable(...)` params. We accept strings and numbers
 * (both are common — `length: 50` and `'search[value]': 'foo'`).
 */
export type DatatableParams = Record<string, string | number | undefined>;

// ---------------------------------------------------------------------------
// Change-order attachment (returned by getChangeOrderAttachments)
// ---------------------------------------------------------------------------

export const ChangeOrderAttachmentSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    name: z.string().optional(),
    changeOrderId: z.union([z.string(), z.number()]).optional(),
    extension: z.string().optional(),
    publicUrl: z.string().optional(),
    key: z.string().optional(),
    size: z.union([z.string(), z.number()]).optional(),
    createdAt: z.string().optional(),
    userId: z.union([z.string(), z.number()]).optional(),
    userName: z.string().optional(),
  })
  .passthrough();
export type ChangeOrderAttachment = z.infer<typeof ChangeOrderAttachmentSchema>;
