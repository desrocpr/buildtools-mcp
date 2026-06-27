/**
 * MCP read-only tools for BuildTools operations: RFIs, services, users
 * (MOS-294).
 *
 * Three tools (PR #71: search_users folded into list_users with `query`):
 *   - list_rfis     — datatable wrapper over `getRFIs()`; optional project /
 *                     limit filters.
 *   - list_services — datatable wrapper over `getServices()`; optional project /
 *                     limit filters.
 *   - list_users    — datatable wrapper over `getUsers()` / `getEmployees()`;
 *                     optional `role` enum + `query` + `limit`.
 *
 * Design notes:
 *
 *   - Mirrors `src/tools/projects.ts` / `src/tools/customers.ts`: Zod-validated
 *     input, Markdown text response, `isError: true` content branch on
 *     `BuildToolsError`, never throws to the SDK. Empty / null results render
 *     as plain Markdown (no `isError`).
 *   - Schemas are authored against `zod/v3` (Zod 4 ships the v3 surface under
 *     that sub-export) so `zod-to-json-schema` keeps working.
 *   - Helpers (`stripHtml`, `orDash`, `markdown`, `errorMarkdown`,
 *     `formatError`, `formatZodError`) are inline-duplicated rather than
 *     factored, matching the convention of `customers.ts`.
 *   - RFI / service / task status share the same numeric enum
 *     (1=Open, 2=In Progress, 3=Complete). Unknown codes (e.g. service code 4
 *     in the fixture) render as the raw number — we do not invent labels.
 *   - RFI priorities use a parallel enum (1=Normal, 2=High, 3=Urgent); unknown
 *     codes likewise render raw.
 *   - User roles arrive as strings on the datatable row (`"Client"`,
 *     `"Employee"`, etc.) and render verbatim — no numeric translation.
 *   - `project_name` filter: BuildTools' RFI / service datatables do not
 *     expose a clean per-column project filter to us, so we forward the value
 *     as the global free-text `search[value]` parameter (same approach
 *     `list_projects` uses for `customer_name`).
 *   - `assigned_to` ships as an HTML blob whose visible name lives inside a
 *     `title="..."` attribute; `stripHtml()` returns the inner text content
 *     which matches the visible name in both fixtures.
 */

import { z } from "zod/v3";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { BuildToolsAPI } from "../client/BuildToolsAPI.js";
import { BuildToolsError } from "../client/errors.js";

import type { ToolDefinition, ToolResult } from "./projects.js";

// ---------------------------------------------------------------------------
// Rendering helpers (intentionally inline-duplicated, see file header)
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

// ---------------------------------------------------------------------------
// Enum labels (shared by RFIs and services)
// ---------------------------------------------------------------------------

const RFI_STATUS_LABEL: Record<number, string> = {
  1: "Open",
  2: "In Progress",
  3: "Complete",
};

const RFI_PRIORITY_LABEL: Record<number, string> = {
  1: "Normal",
  2: "High",
  3: "Urgent",
};

/** Render a status code; unknown numeric codes return the raw number string. */
function rfiStatusLabel(code: unknown): string {
  if (code === undefined || code === null || code === "") return "—";
  const num = typeof code === "number" ? code : Number(code);
  if (!Number.isFinite(num)) return String(code);
  return RFI_STATUS_LABEL[num] ?? String(num);
}

/** Render a priority code; unknown numeric codes return the raw number string. */
function rfiPriorityLabel(code: unknown): string {
  if (code === undefined || code === null || code === "") return "—";
  const num = typeof code === "number" ? code : Number(code);
  if (!Number.isFinite(num)) return String(code);
  return RFI_PRIORITY_LABEL[num] ?? String(num);
}

// ---------------------------------------------------------------------------
// Datatable envelope projection
// ---------------------------------------------------------------------------

interface Datatable {
  data?: Array<Record<string, unknown>>;
  recordsTotal?: number;
  recordsFiltered?: number;
}

// ---------------------------------------------------------------------------
// list_rfis
// ---------------------------------------------------------------------------

const ListRfisInputSchema = z.object({
  project_name: z
    .string()
    .optional()
    .describe("Substring match against the project name (free-text search)."),
  limit: z
    .number()
    .min(1)
    .max(200)
    .optional()
    .describe("Max RFIs to return. Default 50."),
});

export type ListRfisInput = z.infer<typeof ListRfisInputSchema>;

/** Render a single RFI list-row as a Markdown line. */
function formatRfiRow(row: Record<string, unknown>): string {
  const id =
    (row.id as string | number | undefined) ??
    (row.DT_RowId as string | undefined) ??
    "?";
  const status = rfiStatusLabel(row.status);
  const priority = rfiPriorityLabel(row.priority);
  const number = orDash(row.number);
  const subject = orDash(row.subject);
  const project = orDash(row.project);
  const assignedTo = stripHtml(row.assigned_to);
  const location = orDash(row.location);
  return (
    `- #${id} [${status}] ${number} — ${subject} — project: ${project} — ` +
    `assigned: ${orDash(assignedTo)} — priority: ${priority} — location: ${location}`
  );
}

async function listRfisHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = ListRfisInputSchema.safeParse(args ?? {});
  if (!parsed.success) return formatZodError(parsed.error, "list_rfis");
  const { project_name, limit } = parsed.data;

  const length = limit ?? 50;
  const params: Record<string, string | number> = { length };
  if (project_name) {
    params["search[value]"] = project_name;
  }

  try {
    const result = await api.getRFIs<Datatable>(params);
    const rows = result?.data ?? [];
    if (rows.length === 0) {
      const trailer = project_name ? ` (project_name: "${project_name}")` : "";
      return markdown(`No RFIs matched the filter${trailer}.`);
    }
    const header = `**${rows.length} RFI${rows.length === 1 ? "" : "s"}**:`;
    const body = rows.map(formatRfiRow).join("\n");
    return markdown(`${header}\n\n${body}`);
  } catch (err) {
    return formatError(err, "list_rfis");
  }
}

export const listRfisTool: ToolDefinition = {
  name: "list_rfis",
  description:
    "List BuildTools RFIs (requests for information) with optional project-name filter.",
  inputSchema: zodToJsonSchema(ListRfisInputSchema),
  permission: "read",
  handler: listRfisHandler,
};

// ---------------------------------------------------------------------------
// list_services
// ---------------------------------------------------------------------------

const ListServicesInputSchema = z.object({
  project_name: z
    .string()
    .optional()
    .describe("Substring match against the project name (free-text search)."),
  limit: z
    .number()
    .min(1)
    .max(200)
    .optional()
    .describe("Max services to return. Default 50."),
});

export type ListServicesInput = z.infer<typeof ListServicesInputSchema>;

/** Render a single service list-row as a Markdown line. */
function formatServiceRow(row: Record<string, unknown>): string {
  // The services datatable uses `info` as the numeric service id (same pattern
  // as change-orders), not `id`. Fall back to DT_RowId only if `info` is
  // absent.
  const id =
    (row.info as string | number | undefined) ??
    (row.DT_RowId as string | undefined) ??
    "?";
  const status = rfiStatusLabel(row.status);
  const name = orDash(row.name);
  const project = orDash(row.project);
  const assignedTo = stripHtml(row.assigned_to);
  const dueDate = orDash(row.due_date);
  const createdAt = orDash(row.created_at);
  return (
    `- #${id} [${status}] ${name} — project: ${project} — ` +
    `assigned: ${orDash(assignedTo)} — due: ${dueDate} — created: ${createdAt}`
  );
}

async function listServicesHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = ListServicesInputSchema.safeParse(args ?? {});
  if (!parsed.success) return formatZodError(parsed.error, "list_services");
  const { project_name, limit } = parsed.data;

  const length = limit ?? 50;
  const params: Record<string, string | number> = { length };
  if (project_name) {
    params["search[value]"] = project_name;
  }

  try {
    const result = await api.getServices<Datatable>(params);
    const rows = result?.data ?? [];
    if (rows.length === 0) {
      const trailer = project_name ? ` (project_name: "${project_name}")` : "";
      return markdown(`No services matched the filter${trailer}.`);
    }
    const header = `**${rows.length} service${rows.length === 1 ? "" : "s"}**:`;
    const body = rows.map(formatServiceRow).join("\n");
    return markdown(`${header}\n\n${body}`);
  } catch (err) {
    return formatError(err, "list_services");
  }
}

export const listServicesTool: ToolDefinition = {
  name: "list_services",
  description:
    "List BuildTools services (project service-line tasks) with optional project-name filter.",
  inputSchema: zodToJsonSchema(ListServicesInputSchema),
  permission: "read",
  handler: listServicesHandler,
};

// ---------------------------------------------------------------------------
// list_users  /  search_users
// ---------------------------------------------------------------------------

const USER_ROLE_VALUES = [
  "Core Admin",
  "Employee",
  "Client",
  "Company Rep",
  "All",
] as const;

const ListUsersInputSchema = z.object({
  role: z
    .enum(USER_ROLE_VALUES)
    .optional()
    .describe(
      'Filter by user role. "All" (default) returns all roles. "Employee" routes through the employees endpoint.',
    ),
  query: z
    .string()
    .min(2)
    .optional()
    .describe(
      "Free-text substring search across user name, email, phone, and company. Min 2 chars. ",
    ),
  limit: z
    .number()
    .min(1)
    .max(500)
    .optional()
    .describe("Max users to return. Default 100."),
});

export type ListUsersInput = z.infer<typeof ListUsersInputSchema>;

/** Extract the numeric user id from a DT_RowId of the form `row_<n>`. */
function parseUserId(row: Record<string, unknown>): string {
  const raw = row.DT_RowId;
  if (typeof raw !== "string") {
    if (raw === undefined || raw === null) return "?";
    return String(raw);
  }
  return raw.replace(/^row_/, "");
}

/** Render a single user list-row as a Markdown line. */
function formatUserRow(row: Record<string, unknown>): string {
  const id = parseUserId(row);
  const role = orDash(row.role);
  const first = (row.first_name as string | undefined) ?? "";
  const last = (row.last_name as string | undefined) ?? "";
  const name = orDash([first, last].filter(Boolean).join(" "));
  const email = orDash(row.email);
  const phone = orDash(row.phone);
  const company = orDash(row.company);
  const createdAt = orDash(row.created_at);
  return (
    `- #${id} [${role}] ${name} — email: ${email} — phone: ${phone} — ` +
    `company: ${company} — created: ${createdAt}`
  );
}

async function listUsersHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = ListUsersInputSchema.safeParse(args ?? {});
  if (!parsed.success) return formatZodError(parsed.error, "list_users");
  const { role, query, limit } = parsed.data;

  const targetLimit = limit ?? 100;
  const effectiveRole = role ?? "All";

  // BuildTools' /users/datatable does NOT honor any server-side role
  // filter — neither `columns[N][search][value]=Employee` nor `role=`
  // nor `role=<numeric>` change the response. The UI tabs filter
  // client-side. Match that behaviour: fetch a big batch, filter
  // locally, then take `limit`.
  const fetchLength = effectiveRole === "All" ? targetLimit : 10000;

  try {
    const params: Record<string, string | number> = { length: fetchLength };
    // PR #71: query forwarded as global free-text search (was the
    // entire job of the standalone search_users tool).
    if (query) {
      params["search[value]"] = query;
    }
    const result = await api.getUsers<Datatable>(params);
    const allRows = result?.data ?? [];
    const filtered =
      effectiveRole === "All"
        ? allRows
        : allRows.filter(
            (u) => String((u as { role?: unknown }).role ?? "") === effectiveRole,
          );
    const rows = filtered.slice(0, targetLimit);

    if (rows.length === 0) {
      // PR #71 review HIGH 2: include query in the no-match message
      // (mirrors list_projects / list_tasks / list_purchase_orders).
      const filterDesc = [`role: ${effectiveRole}`];
      if (query) filterDesc.push(`query: "${query}"`);
      return markdown(`No users matched the filter (${filterDesc.join(", ")}).`);
    }
    const header =
      `**${rows.length} user${rows.length === 1 ? "" : "s"}** ` +
      `(role: ${effectiveRole}` +
      (effectiveRole !== "All" && filtered.length > targetLimit
        ? `, showing first ${targetLimit} of ${filtered.length}`
        : "") +
      `):`;
    const body = rows.map(formatUserRow).join("\n");
    return markdown(`${header}\n\n${body}`);
  } catch (err) {
    return formatError(err, "list_users");
  }
}

export const listUsersTool: ToolDefinition = {
  name: "list_users",
  description:
    "List or search BuildTools users. " +
    "Pass `role` to filter by Core Admin / Employee / Client / Company Rep. " +
    "Pass `query` for free-text search across name, email, phone, company. " +
    "",
  inputSchema: zodToJsonSchema(ListUsersInputSchema),
  permission: "read",
  handler: listUsersHandler,
};


// ---------------------------------------------------------------------------
// Exported registry
// ---------------------------------------------------------------------------

export const operationTools: ToolDefinition[] = [
  listRfisTool,
  listServicesTool,
  listUsersTool,
];
