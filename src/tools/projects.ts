/**
 * MCP read-only tools for BuildTools projects (MOS-214, Phase 3.1).
 *
 * Three tools:
 *   - list_projects   — paged datatable, optionally filtered by status / customer.
 *   - get_project     — full detail view by numeric ID.
 *   - search_projects — free-text fuzzy match across project rows.
 *
 * Design notes:
 *
 *   - Handlers NEVER throw to the SDK. Both Zod validation failures and
 *     `BuildToolsError` from the client are caught and rendered as Markdown
 *     `isError: true` responses so Claude Desktop can surface them inline
 *     without killing the stdio session.
 *   - Schemas are authored against `zod/v3` (Zod 4 ships the v3 surface under
 *     this sub-export) so that `zod-to-json-schema` — which still expects v3
 *     internals — keeps working. Zod 4 has a native `z.toJSONSchema`, but the
 *     issue + planning contract pin `zod-to-json-schema` explicitly.
 *   - The client's actual surface is `getProjects` / `getProject` /
 *     `searchProjects`; the issue prose used `listProjects` as shorthand. We
 *     adapt to the existing client and document the mapping in code rather
 *     than touching `src/client/**` (out-of-scope per the planner contract).
 *
 * Status-code mapping: BuildTools wire values are numeric (fixture shows 1, 5,
 * 6) but there is no documented mapping. We use the best-guess assumption
 * below and round-trip the same map when rendering rows, falling back to the
 * raw value when unknown. Refine after live verification (MOS-222 smoke).
 */

import { z } from "zod/v3";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { BuildToolsAPI } from "../client/BuildToolsAPI.js";
import { BuildToolsError } from "../client/errors.js";

// ---------------------------------------------------------------------------
// Types shared by handlers
// ---------------------------------------------------------------------------

/**
 * MCP tool-call response shape. Mirrors the SDK's `CallToolResult` — we keep
 * a local alias so this module doesn't depend on the SDK's deep types.
 */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** MCP tool definition (name + description + JSON Schema for input). */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ReturnType<typeof zodToJsonSchema>;
  handler: (args: unknown, api: BuildToolsAPI) => Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// Status mapping (best-guess pending live verification)
// ---------------------------------------------------------------------------

/**
 * Best-guess BuildTools project-status label → wire-code mapping. Source
 * fixtures show codes 1, 5, 6. Refine once verified against a live tenant.
 *
 * NOTE: when adding a new label, also add it to the `z.enum` in
 * `ListProjectsInputSchema` below.
 */
const STATUS_LABEL_TO_CODES: Record<"Active" | "Complete" | "Lost" | "All", number[]> = {
  Active: [1],
  Complete: [6],
  Lost: [5],
  All: [],
};

/** Inverse mapping for rendering: wire code → label, or `String(code)` fallback. */
function statusLabel(code: string | number | undefined): string {
  if (code === undefined || code === null || code === "") return "—";
  const num = typeof code === "number" ? code : Number(code);
  for (const [label, codes] of Object.entries(STATUS_LABEL_TO_CODES)) {
    if (label === "All") continue;
    if (codes.includes(num)) return label;
  }
  return String(code);
}

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

/** Render a single project list-row as a Markdown line. */
function formatProjectRow(row: Record<string, unknown>): string {
  const id = (row.id ?? row.DT_RowId ?? "?") as string | number;
  const status = statusLabel(row.status as string | number | undefined);
  const name = (row.name as string | undefined) ?? "(unnamed project)";
  // The list row has no clean customer name (only a `managers` HTML blob),
  // so we surface address city/state as the project locator instead.
  const cityState = [row.city, row.state].filter(Boolean).join(", ");
  const locator = cityState ? ` — ${stripHtml(cityState)}` : "";
  // The list row exposes `budget_revised` as a formatted currency string.
  // The issue calls this "contract value"; we label it that way for the
  // user-facing surface but preserve the raw string as-is.
  const budget = orDash(row.budget_revised);
  return `- #${id} [${status}] ${name}${locator} — ${budget} contract value`;
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
 * `BuildToolsError` (caller-actionable: auth / network / server / validation)
 * from anything else (likely a programming bug — still surface, but flag).
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
  return errorMarkdown(
    `**Invalid input for \`${toolName}\`:**\n${issues}`,
  );
}

// ---------------------------------------------------------------------------
// list_projects
// ---------------------------------------------------------------------------

const ListProjectsInputSchema = z.object({
  status: z
    .enum(["Active", "Complete", "Lost", "All"])
    .optional()
    .describe("Filter by project status. Default: Active."),
  customer_name: z
    .string()
    .optional()
    .describe("Substring match against customer name."),
  limit: z
    .number()
    .min(1)
    .max(200)
    .optional()
    .describe("Max projects to return. Default 50."),
});

export type ListProjectsInput = z.infer<typeof ListProjectsInputSchema>;

/**
 * Datatable envelope shape we care about. The client returns the raw envelope
 * (`.passthrough()`-compatible) so we cast to this minimal projection.
 */
interface ProjectsDatatable {
  data?: Array<Record<string, unknown>>;
  recordsTotal?: number;
  recordsFiltered?: number;
}

async function listProjectsHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = ListProjectsInputSchema.safeParse(args ?? {});
  if (!parsed.success) return formatZodError(parsed.error, "list_projects");
  const input = parsed.data;

  const status = input.status ?? "Active";
  const limit = input.limit ?? 50;

  const params: Record<string, string | number> = {
    length: limit,
  };

  // Status filter: BuildTools' datatable is column-keyed. We don't know the
  // exact column index without live inspection, so we pass status both as a
  // generic `search[value]` (broad match) AND in a column-specific slot when
  // a single code maps. `All` means "no filter".
  const codes = STATUS_LABEL_TO_CODES[status];
  if (codes.length === 1) {
    // Column index 1 is the documented `status` column on the datatable.
    params["columns[1][search][value]"] = String(codes[0]);
  }

  // Customer-name filter: there is no canonical column for "customer name" on
  // the project datatable (the row's `managers` HTML blob is project managers,
  // not customers). We pass the user's substring via the global free-text
  // `search[value]` — the datatable searches across all column values.
  if (input.customer_name) {
    params["search[value]"] = input.customer_name;
  }

  try {
    const result = await api.getProjects<ProjectsDatatable>(params);
    const rows = result?.data ?? [];
    if (rows.length === 0) {
      return markdown(
        `No projects matched the filter (status: ${status}` +
          (input.customer_name ? `, customer: ${input.customer_name}` : "") +
          `).`,
      );
    }
    const total = result?.recordsFiltered ?? result?.recordsTotal ?? rows.length;
    const header = `**${rows.length} project${rows.length === 1 ? "" : "s"}** (filtered ${total} total, status: ${status}):`;
    const body = rows.map(formatProjectRow).join("\n");
    return markdown(`${header}\n\n${body}`);
  } catch (err) {
    return formatError(err, "list_projects");
  }
}

export const listProjectsTool: ToolDefinition = {
  name: "list_projects",
  description:
    "List BuildTools projects with optional filters. Returns up to 50 projects by default. Use filters to narrow scope.",
  inputSchema: zodToJsonSchema(ListProjectsInputSchema),
  handler: listProjectsHandler,
};

// ---------------------------------------------------------------------------
// get_project
// ---------------------------------------------------------------------------

const GetProjectInputSchema = z.object({
  project_id: z.number().describe("BuildTools project ID (numeric)."),
});

export type GetProjectInput = z.infer<typeof GetProjectInputSchema>;

/** Minimal projection of the `/projects/:id/form` payload. */
interface ProjectDetail {
  id?: string | number;
  name?: string;
  status?: string | number;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  country_code?: string;
  description?: string;
  budget_revised?: string;
  created_at?: string;
  updated_at?: string;
  managers?: string[] | string;
  client_ids?: Array<string | number>;
  [k: string]: unknown;
}

function formatProjectDetail(project: ProjectDetail): string {
  const id = project.id ?? "?";
  const name = project.name ?? "(unnamed project)";
  const status = statusLabel(project.status);
  const addressLine = [
    project.address,
    [project.city, project.state].filter(Boolean).join(", "),
    project.zip,
    project.country_code,
  ]
    .filter(Boolean)
    .join(" · ");
  const managers = Array.isArray(project.managers)
    ? project.managers.join(", ")
    : stripHtml(project.managers ?? "");
  const clients = Array.isArray(project.client_ids) && project.client_ids.length > 0
    ? project.client_ids.map((c) => `#${c}`).join(", ")
    : "—";

  const lines: string[] = [];
  lines.push(`## Project #${id} — ${name}`);
  lines.push("");
  lines.push(`- **Status**: ${status}`);
  lines.push(`- **Contract value**: ${orDash(project.budget_revised)}`);
  lines.push(`- **Address**: ${orDash(addressLine)}`);
  lines.push(`- **Project managers**: ${orDash(managers)}`);
  lines.push(`- **Client IDs**: ${clients}`);
  lines.push(`- **Created**: ${orDash(project.created_at)}`);
  lines.push(`- **Updated**: ${orDash(project.updated_at)}`);
  if (project.description) {
    lines.push("");
    lines.push(`### Description`);
    lines.push("");
    lines.push(String(project.description));
  }
  return lines.join("\n");
}

async function getProjectHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = GetProjectInputSchema.safeParse(args ?? {});
  if (!parsed.success) return formatZodError(parsed.error, "get_project");
  const { project_id } = parsed.data;

  try {
    const project = await api.getProject<ProjectDetail>(project_id);
    if (!project) {
      return markdown(`No project found with ID #${project_id}.`);
    }
    return markdown(formatProjectDetail(project));
  } catch (err) {
    return formatError(err, "get_project");
  }
}

export const getProjectTool: ToolDefinition = {
  name: "get_project",
  description: "Get full detail for a single BuildTools project by ID.",
  inputSchema: zodToJsonSchema(GetProjectInputSchema),
  handler: getProjectHandler,
};

// ---------------------------------------------------------------------------
// search_projects
// ---------------------------------------------------------------------------

const SearchProjectsInputSchema = z.object({
  query: z.string().min(2).describe("Search query."),
});

export type SearchProjectsInput = z.infer<typeof SearchProjectsInputSchema>;

/** Maximum results surfaced by `search_projects`. */
const SEARCH_PROJECTS_LIMIT = 20;

async function searchProjectsHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = SearchProjectsInputSchema.safeParse(args ?? {});
  if (!parsed.success) return formatZodError(parsed.error, "search_projects");
  const { query } = parsed.data;

  try {
    const result = await api.searchProjects<ProjectsDatatable>(
      query,
      SEARCH_PROJECTS_LIMIT,
    );
    const rows = result?.data ?? [];
    if (rows.length === 0) {
      return markdown(`No projects matched query "${query}".`);
    }
    const header = `**${rows.length} match${rows.length === 1 ? "" : "es"}** for "${query}":`;
    const body = rows.slice(0, SEARCH_PROJECTS_LIMIT).map(formatProjectRow).join("\n");
    return markdown(`${header}\n\n${body}`);
  } catch (err) {
    return formatError(err, "search_projects");
  }
}

export const searchProjectsTool: ToolDefinition = {
  name: "search_projects",
  description:
    "Free-text search across BuildTools projects (matches name, customer, address, project number).",
  inputSchema: zodToJsonSchema(SearchProjectsInputSchema),
  handler: searchProjectsHandler,
};

// ---------------------------------------------------------------------------
// Exported registry
// ---------------------------------------------------------------------------

export const projectTools: ToolDefinition[] = [
  listProjectsTool,
  getProjectTool,
  searchProjectsTool,
];
