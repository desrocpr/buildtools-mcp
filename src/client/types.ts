/**
 * Zod schemas and inferred TypeScript types for the BuildTools API.
 *
 * All schemas use .passthrough() so that unknown fields returned by the API
 * don't cause parse failures.
 *
 * TODO(MOS-211): reconcile field names against api-data-sample.json once the
 * reference source (~/code/buildtools/) is available in the build environment.
 * These schemas represent a minimum-viable surface based on the issue spec.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Client options / filters
// ---------------------------------------------------------------------------

export const BuildToolsClientOptionsSchema = z.object({
  /** BuildTools tenant slug, e.g. "moss" → base URL https://moss.buildtools.app */
  tenant: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
  /**
   * Override the base URL (useful in tests and staging environments).
   * Defaults to `https://${tenant}.buildtools.app`.
   */
  baseUrl: z.string().url().optional(),
  /** Request timeout in milliseconds. Defaults to 30 000. */
  timeoutMs: z.number().int().positive().optional(),
});
export type BuildToolsClientOptions = z.infer<typeof BuildToolsClientOptionsSchema>;

export const ProjectFiltersSchema = z
  .object({
    status: z.string().optional(),
    customerId: z.number().int().optional(),
    search: z.string().optional(),
    page: z.number().int().positive().optional(),
    perPage: z.number().int().positive().optional(),
  })
  .passthrough();
export type ProjectFilters = z.infer<typeof ProjectFiltersSchema>;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

// TODO(MOS-211): reconcile against api-data-sample.json
export const ProjectSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    status: z.string(),
    description: z.string().nullish(),
    customer_id: z.number().int().nullish(),
    address: z.string().nullish(),
    start_date: z.string().nullish(),
    end_date: z.string().nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
  })
  .passthrough();
export type Project = z.infer<typeof ProjectSchema>;

// TODO(MOS-211): reconcile against api-data-sample.json
export const ChangeOrderSchema = z
  .object({
    id: z.number().int(),
    project_id: z.number().int(),
    title: z.string(),
    status: z.string(),
    amount: z.number().nullish(),
    description: z.string().nullish(),
    billed: z.boolean().nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
  })
  .passthrough();
export type ChangeOrder = z.infer<typeof ChangeOrderSchema>;

// TODO(MOS-211): reconcile against api-data-sample.json
export const FinancialStatementSchema = z
  .object({
    project_id: z.number().int(),
    contract_value: z.number().nullish(),
    billed_to_date: z.number().nullish(),
    payments_received: z.number().nullish(),
    outstanding_balance: z.number().nullish(),
    change_orders_total: z.number().nullish(),
    revised_contract_value: z.number().nullish(),
    generated_at: z.string().nullish(),
  })
  .passthrough();
export type FinancialStatement = z.infer<typeof FinancialStatementSchema>;

// TODO(MOS-211): reconcile against api-data-sample.json
export const CustomerSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    email: z.string().nullish(),
    phone: z.string().nullish(),
    address: z.string().nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
  })
  .passthrough();
export type Customer = z.infer<typeof CustomerSchema>;

// TODO(MOS-211): reconcile against api-data-sample.json
export const AttachmentSchema = z
  .object({
    id: z.number().int(),
    project_id: z.number().int(),
    entity_type: z.string().nullish(),
    entity_id: z.number().int().nullish(),
    filename: z.string(),
    content_type: z.string().nullish(),
    size: z.number().int().nullish(),
    url: z.string().nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
  })
  .passthrough();
export type Attachment = z.infer<typeof AttachmentSchema>;
