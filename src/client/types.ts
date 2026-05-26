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
    /**
     * Per-user BuildTools username/email. When provided, the API caches it
     * for transparent auto re-authentication on session expiry or 401.
     * Tests / callers may also pass credentials to `authenticate(email, pw)`
     * directly; the most-recent value wins.
     */
    username: z.string().optional(),
    /**
     * Per-user BuildTools password. Cached on the instance for transparent
     * re-authentication. Treat as a secret: never log or surface in errors.
     */
    password: z.string().optional(),
    /**
     * Defensive client-side session expiry in minutes (default 30). After
     * this window the API will force re-auth on the next data-method call.
     */
    sessionTimeoutMinutes: z.number().int().positive().optional(),
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

// ---------------------------------------------------------------------------
// Additional entity schemas (MOS-213)
//
// These are intentionally minimal. They cover the well-known fields that the
// snapshot tests in `__tests__/BuildToolsAPI.fixtures.test.ts` assert on, and
// use `.passthrough()` so any extra columns that BuildTools' DataTables
// envelope ships with (HTML widgets, etc.) are preserved rather than dropped.
//
// Per the MOS-213 contract: these are NOT re-exported from `src/client/index.ts`
// (the barrel) — that work belongs to MOS-214 / 215 / 216, where the
// downstream MCP tool definitions actually need to consume them. Tests import
// directly from `../types.js`.
// ---------------------------------------------------------------------------

/**
 * Customer (BuildTools' /companies datatable row). BuildTools labels these
 * "companies" internally but the user-facing concept — and the MOS-213 spec —
 * calls them customers.
 */
export const CustomerSchema = z
  .object({
    DT_RowId: z.string().optional(),
    name: z.string(),
    status: z.union([z.string(), z.number()]).optional(),
    type_name: z.string().optional(),
    main_contact: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    address: z.string().optional(),
    zip: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
    rating: z.union([z.string(), z.number()]).optional(),
    created_at: z.string().optional(),
  })
  .passthrough();
export type Customer = z.infer<typeof CustomerSchema>;

/**
 * Change order (BuildTools' /change-orders datatable row). The `total` field
 * is surfaced as a formatted currency string (e.g. `"$ 13,800.00"`) — callers
 * that need a numeric value must parse it themselves; the schema preserves
 * the source string.
 */
export const ChangeOrderSchema = z
  .object({
    DT_RowId: z.string().optional(),
    status: z.union([z.string(), z.number()]).optional(),
    info: z.union([z.string(), z.number()]).optional(),
    project_name: z.string().optional(),
    number: z.union([z.string(), z.number()]).optional(),
    approved_number: z.union([z.string(), z.number()]).nullable().optional(),
    name: z.string(),
    total: z.string().optional(),
    dates: z.string().optional(),
    relations: z.string().optional(),
    created_at: z.string().optional(),
  })
  .passthrough();
export type ChangeOrder = z.infer<typeof ChangeOrderSchema>;

/**
 * Financial statement (single-record shape returned by the form/save endpoints,
 * and also the analogous fields surfaced on the project datatable row prefixed
 * with `financial_statements_*`). Like ChangeOrder, currency comes as a
 * formatted string; the optional `current_amount_value` carries the numeric
 * equivalent when the source includes it.
 */
export const FinancialStatementSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    project_id: z.union([z.string(), z.number()]).optional(),
    name: z.string(),
    status: z.union([z.string(), z.number()]).optional(),
    current_amount: z.string().optional(),
    current_amount_value: z.number().optional(),
    report_previous_balance: z.union([z.string(), z.number()]).optional(),
    credit_amount: z.union([z.string(), z.number()]).optional(),
    notes: z.string().optional(),
    financial_method: z.union([z.string(), z.number()]).optional(),
    created_at: z.string().optional(),
    due_date: z.string().optional(),
    payment_last: z.string().optional(),
    amount_paid: z.string().optional(),
    amount_unpaid: z.string().optional(),
    aging_days: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();
export type FinancialStatement = z.infer<typeof FinancialStatementSchema>;

/**
 * Document attachment as returned by the `/documents` listing endpoint
 * (snake_case from the wire, before `getChangeOrderAttachments()` maps to its
 * camelCase shape). Distinct from `ChangeOrderAttachmentSchema` which models
 * the post-mapping shape. Reused by `getProjectAttachments()` (MOS-216) which
 * returns the snake_case wire shape directly.
 */
export const AttachmentSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    name: z.string(),
    module_id: z.union([z.string(), z.number()]).optional(),
    module_code: z.union([z.string(), z.number()]).optional(),
    module_name: z.string().optional(),
    extension: z.string().optional(),
    public_url: z.string().optional(),
    key: z.string().optional(),
    size: z.union([z.string(), z.number()]).optional(),
    created_at: z.string().optional(),
    user_id: z.union([z.string(), z.number()]).optional(),
    user_name: z.string().optional(),
  })
  .passthrough();
export type Attachment = z.infer<typeof AttachmentSchema>;

// ---------------------------------------------------------------------------
// CustomerDetail (MOS-216) — single-customer form payload
// ---------------------------------------------------------------------------

/**
 * Customer detail payload as returned by `/companies/:id/form` (MOS-216,
 * Phase 3.3). Like `CustomerSchema`, every field is optional + the schema is
 * `.passthrough()` because BuildTools' form payloads include many more fields
 * than the documented surface (CSRF tokens, audit blobs, etc.). The fields
 * listed here are the ones the `get_customer` tool surfaces in its Markdown
 * detail view.
 */
export const CustomerDetailSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    name: z.string().optional(),
    status: z.union([z.string(), z.number()]).optional(),
    type_name: z.string().optional(),
    main_contact: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    address: z.string().optional(),
    zip: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
    country_code: z.string().optional(),
    rating: z.union([z.string(), z.number()]).optional(),
    notes: z.string().optional(),
    /**
     * Associated projects. BuildTools' form payload uses a variety of shapes
     * for this — sometimes an array of {id, name} objects, sometimes a list
     * of IDs, sometimes an HTML blob in `budget_relations`. Tools normalize
     * client-side; we tolerate any shape here via `z.unknown()` + passthrough.
     */
    projects: z.unknown().optional(),
    project_ids: z.array(z.union([z.string(), z.number()])).optional(),
    budget_relations: z.string().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  })
  .passthrough();
export type CustomerDetail = z.infer<typeof CustomerDetailSchema>;
