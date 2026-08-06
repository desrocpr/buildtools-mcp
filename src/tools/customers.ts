/**
 * MCP read-only tools for BuildTools customers (MOS-216, Phase 3.3).
 *
 * Two tools:
 *   - list_customers — datatable wrapper over `getCompanies()` with optional
 *                      `has_active_project` / `name_search` filters.
 *   - get_customer   — full detail by ID (address, primary contact, associated
 *                      projects) via the `/companies/:id/form` endpoint.
 *
 * Design notes:
 *
 *   - Mirrors `src/tools/projects.ts` (MOS-214) + `src/tools/financial.ts`
 *     (MOS-215): Zod-validated input, Markdown text response, `isError: true`
 *     content branch on `BuildToolsError`, never throws to the SDK. Empty /
 *     null results render as plain Markdown (no `isError`).
 *   - Schemas are authored against `zod/v3` (Zod 4 ships the v3 surface under
 *     that sub-export) so `zod-to-json-schema` keeps working.
 *   - `has_active_project` filter: BuildTools' `/companies/datatable` row does
 *     not expose a canonical project-active flag. We use a heuristic — treat
 *     the row as having an active project when `budget_relations` (which the
 *     fixture ships as an HTML blob) has non-empty visible text. Document this
 *     inline; refine after live verification (MOS-222).
 *   - `name_search`: forwarded as the datatable's free-text `search[value]`,
 *     consistent with how `list_projects` handles `customer_name`.
 */

import { z } from "zod/v3";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { BuildToolsAPI } from "../client/BuildToolsAPI.js";
import { BuildToolsError } from "../client/errors.js";

import type { ListQuery } from "../operations/types.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./projects.js";

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/** Strip HTML tags + collapse whitespace; safe for null/undefined input. */
function stripHtml(input: unknown): string {
  if (input === undefined || input === null) return "";
  return String(input).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

/** Em-dash when value is empty / nullish / placeholder "-". */
function orDash(value: unknown): string {
  if (value === undefined || value === null) return "—";
  const s = typeof value === "string" ? value.trim() : String(value);
  if (s === "" || s === "-") return "—";
  return s;
}

/** Markdown response shorthand. */
function markdown(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** Error Markdown response shorthand. */
function errorMarkdown(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Normalise unknown errors into a Markdown body. Distinguishes our own
 * `BuildToolsError` (caller-actionable) from anything else.
 */
function formatError(err: unknown, toolName: string): ToolResult {
  if (err instanceof BuildToolsError) {
    return errorMarkdown(
      `**Error calling \`${toolName}\`** (${err.name}): ${err.message}`,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return errorMarkdown(`**Error calling \`${toolName}\`**: ${message}`);
}

/** Pretty-print a Zod error as a bulleted list. */
function formatZodError(err: z.ZodError, toolName: string): ToolResult {
  const issues = err.issues
    .map((i) => {
      const path = i.path.length > 0 ? i.path.join(".") : "(root)";
      return `- \`${path}\`: ${i.message}`;
    })
    .join("\n");
  return errorMarkdown(`**Invalid input for \`${toolName}\`:**\n${issues}`);
}

/**
 * Best-effort "has an active project link" predicate. The customers datatable
 * row ships a `budget_relations` HTML blob; non-empty visible text indicates
 * the customer is linked to at least one project record. Document the
 * heuristic inline; live refinement is a MOS-222 concern.
 */
function hasActiveProjectLink(row: Record<string, unknown>): boolean {
  const raw = row.budget_relations;
  if (typeof raw !== "string") return false;
  return stripHtml(raw).length > 0;
}

/** Render a single customer list row as a Markdown line. */
function formatCustomerRow(row: Record<string, unknown>): string {
  const id =
    (row.id as string | number | undefined) ??
    (row.DT_RowId as string | undefined) ??
    "?";
  const name = (row.name as string | undefined) ?? "(unnamed customer)";
  const status = orDash(row.status);
  const typeName = (row.type_name as string | undefined) ?? "";
  const cityState = [row.city, row.state].filter(Boolean).join(", ");
  const contact = stripHtml(row.main_contact);
  const locator = cityState ? ` — ${stripHtml(cityState)}` : "";
  const typeTag = typeName ? ` (${typeName})` : "";
  const contactTrailer = contact ? ` — contact: ${contact}` : "";
  return `- #${id} [${status}] ${name}${typeTag}${locator}${contactTrailer}`;
}

// ---------------------------------------------------------------------------
// list_customers
// ---------------------------------------------------------------------------

const ListCustomersInputSchema = z.object({
  has_active_project: z
    .boolean()
    .optional()
    .describe(
      "Only customers with at least one active project link (heuristic: non-empty budget_relations).",
    ),
  name_search: z
    .string()
    .optional()
    .describe("Substring match against the customer name (free-text search)."),
});

export type ListCustomersInput = z.infer<typeof ListCustomersInputSchema>;

/** Minimal projection of a datatable envelope. */
interface CustomersDatatable {
  data?: Array<Record<string, unknown>>;
  recordsTotal?: number;
  recordsFiltered?: number;
}

async function listCustomersHandler(
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = ListCustomersInputSchema.safeParse(args ?? {});
  if (!parsed.success) return formatZodError(parsed.error, "list_customers");
  const { has_active_project, name_search } = parsed.data;

  // Bump the page size to 200 to surface a wider sweep than the 50-row
  // default — customers list is typically small.
  const query: ListQuery = { limit: 200 };
  if (name_search) query.search = name_search;

  try {
    const result = await ctx.ops.getCompanies<CustomersDatatable>(query);
    let rows = result?.data ?? [];

    if (has_active_project === true) {
      rows = rows.filter(hasActiveProjectLink);
    } else if (has_active_project === false) {
      rows = rows.filter((r) => !hasActiveProjectLink(r));
    }

    if (rows.length === 0) {
      const filterDesc: string[] = [];
      if (has_active_project !== undefined) {
        filterDesc.push(`has_active_project: ${has_active_project}`);
      }
      if (name_search) filterDesc.push(`name_search: "${name_search}"`);
      const trailer =
        filterDesc.length > 0 ? ` (filters: ${filterDesc.join(", ")})` : "";
      return markdown(`No customers matched the filter${trailer}.`);
    }

    const header = `**${rows.length} customer${rows.length === 1 ? "" : "s"}**:`;
    const body = rows.map(formatCustomerRow).join("\n");
    return markdown(`${header}\n\n${body}`);
  } catch (err) {
    return formatError(err, "list_customers");
  }
}

export const listCustomersTool: ToolDefinition<ToolContext> = {
  name: "list_customers",
  description:
    "List BuildTools customers (people / companies tied to projects). Optionally filter by activity.",
  inputSchema: zodToJsonSchema(ListCustomersInputSchema),
  permission: "read",
  handler: listCustomersHandler,
};

// ---------------------------------------------------------------------------
// get_customer
// ---------------------------------------------------------------------------

const GetCustomerInputSchema = z.object({
  customer_id: z.number().describe("BuildTools customer ID (numeric)."),
});

export type GetCustomerInput = z.infer<typeof GetCustomerInputSchema>;

/**
 * Minimal projection of a `/companies/:id/form` payload. Many more fields
 * ship on the wire; the `[k: string]: unknown` index handles them.
 */
interface CustomerDetailPayload {
  id?: string | number;
  name?: string;
  status?: string | number;
  type_name?: string;
  main_contact?: string;
  email?: string;
  phone?: string;
  address?: string;
  zip?: string;
  city?: string;
  state?: string;
  country?: string;
  country_code?: string;
  rating?: string | number;
  notes?: string;
  /** Associated projects. Shape varies; tolerated client-side. */
  projects?: unknown;
  project_ids?: Array<string | number>;
  budget_relations?: string;
  created_at?: string;
  updated_at?: string;
  [k: string]: unknown;
}

/**
 * Normalize the project-association field across the many shapes BuildTools'
 * form payload may emit. Returns a list of `{id?, name?}` rows; empty when
 * none surface.
 */
function extractAssociatedProjects(
  customer: CustomerDetailPayload,
): Array<{ id?: string | number; name?: string }> {
  // Shape A: explicit array of {id, name}.
  if (Array.isArray(customer.projects)) {
    return customer.projects
      .map((p) => {
        if (p && typeof p === "object") {
          const obj = p as Record<string, unknown>;
          return {
            id: obj.id as string | number | undefined,
            name: (obj.name as string | undefined) ?? undefined,
          };
        }
        if (typeof p === "string" || typeof p === "number") {
          return { id: p as string | number };
        }
        return {};
      })
      .filter((r) => r.id !== undefined || r.name !== undefined);
  }

  // Shape B: list of IDs.
  if (Array.isArray(customer.project_ids)) {
    return customer.project_ids.map((id) => ({ id }));
  }

  return [];
}

function formatCustomerDetail(customer: CustomerDetailPayload): string {
  const id = customer.id ?? "?";
  const name = customer.name ?? "(unnamed customer)";
  const status = orDash(customer.status);
  const typeName = orDash(customer.type_name);
  const contact = stripHtml(customer.main_contact);

  const addressLine = [
    customer.address,
    [customer.city, customer.state].filter(Boolean).join(", "),
    customer.zip,
    customer.country ?? customer.country_code,
  ]
    .filter(Boolean)
    .join(" · ");

  const projects = extractAssociatedProjects(customer);

  const lines: string[] = [];
  lines.push(`## Customer #${id} — ${name}`);
  lines.push("");
  lines.push(`- **Status**: ${status}`);
  lines.push(`- **Type**: ${typeName}`);
  lines.push(`- **Primary contact**: ${orDash(contact)}`);
  lines.push(`- **Email**: ${orDash(customer.email)}`);
  lines.push(`- **Phone**: ${orDash(customer.phone)}`);
  lines.push(`- **Address**: ${orDash(addressLine)}`);
  lines.push(`- **Rating**: ${orDash(customer.rating)}`);
  lines.push(`- **Created**: ${orDash(customer.created_at)}`);
  if (customer.updated_at !== undefined) {
    lines.push(`- **Updated**: ${orDash(customer.updated_at)}`);
  }

  if (projects.length > 0) {
    lines.push("");
    lines.push("### Associated projects");
    lines.push("");
    for (const p of projects) {
      const projId = p.id !== undefined ? `#${p.id}` : "";
      const projName = p.name ?? "";
      const sep = projId && projName ? " — " : "";
      lines.push(`- ${projId}${sep}${projName}`.trim());
    }
  } else if (customer.budget_relations) {
    const blob = stripHtml(customer.budget_relations);
    if (blob.length > 0) {
      lines.push("");
      lines.push("### Associated projects");
      lines.push("");
      lines.push(`- ${blob}`);
    }
  }

  if (customer.notes) {
    lines.push("");
    lines.push("### Notes");
    lines.push("");
    lines.push(stripHtml(customer.notes));
  }

  return lines.join("\n");
}

async function getCustomerHandler(
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = GetCustomerInputSchema.safeParse(args ?? {});
  if (!parsed.success) return formatZodError(parsed.error, "get_customer");
  const { customer_id } = parsed.data;

  try {
    const customer = await ctx.ops.getCustomer<CustomerDetailPayload>(customer_id);
    if (!customer) {
      return markdown(`No customer found with ID #${customer_id}.`);
    }
    return markdown(formatCustomerDetail(customer));
  } catch (err) {
    return formatError(err, "get_customer");
  }
}

export const getCustomerTool: ToolDefinition<ToolContext> = {
  name: "get_customer",
  description:
    "Get full detail for a single BuildTools customer by ID, including address, primary contact, and associated projects.",
  inputSchema: zodToJsonSchema(GetCustomerInputSchema),
  permission: "read",
  handler: getCustomerHandler,
};

// ---------------------------------------------------------------------------
// Exported registry
// ---------------------------------------------------------------------------

export const customerTools: ToolDefinition<ToolContext>[] = [
  listCustomersTool,
  getCustomerTool,
];
