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
 * Status-code mapping: BuildTools uses team-based project statuses, not generic
 * lifecycle states. Active projects are assigned to teams: Nexus (5), Omega (6),
 * Invicta (7), Alpha (8). Verified against desrocpr/buildtools CLAUDE.md and
 * docs/BUSINESS_LOGIC.md.
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
export type ToolResultContent =
  | { type: "text"; text: string }
  | {
      type: "resource";
      resource: {
        uri: string;
        mimeType?: string;
        text?: string;
        blob?: string;
      };
    };

export interface ToolResult {
  content: ToolResultContent[];
  isError?: boolean;
}

/** MCP tool definition (name + description + JSON Schema for input). */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ReturnType<typeof zodToJsonSchema>;
  handler: (args: unknown, api: BuildToolsAPI) => Promise<ToolResult>;
  /**
   * Permission required to call this tool, evaluated against the
   * caller's role-resolved permission set (MOS-328 Phase 6b).
   *
   * Examples: `"read"`, `"write:financial"`, `"write:budget"`,
   * `"delete"`. Use `hasPermission()` from `src/auth/types.ts` to
   * evaluate against a permission list (supports `*` and domain
   * wildcards like `write:*`).
   *
   * Stdio transport does NOT enforce these (single-user). HTTP/SSE
   * with OAuth enabled filters `tools/list` and rejects
   * `tools/call` based on this field.
   */
  permission: string;
}

// ---------------------------------------------------------------------------
// Status mapping — verified against desrocpr/buildtools CLAUDE.md + BUSINESS_LOGIC.md
// ---------------------------------------------------------------------------

const STATUS_LABEL_TO_CODES: Record<string, number[]> = {
  Nexus: [5],
  Omega: [6],
  Invicta: [7],
  Alpha: [8],
  Active: [5, 6, 7, 8],
  "On Hold": [2],
  Warranty: [3],
  Completed: [4],
  "Maintenance Plans": [10],
  Cancelled: [12],
  Templates: [1],
  "Excluded Reporting": [14],
  All: [],
};

const STATUS_CODE_TO_LABEL: Record<number, string> = {
  1: "Templates",
  2: "On Hold",
  3: "Warranty",
  4: "Completed",
  5: "Nexus",
  6: "Omega",
  7: "Invicta",
  8: "Alpha",
  10: "Maintenance Plans",
  12: "Cancelled",
  14: "Excluded Reporting",
};

function statusLabel(code: string | number | undefined): string {
  if (code === undefined || code === null || code === "") return "—";
  const num = typeof code === "number" ? code : Number(code);
  if (!Number.isFinite(num)) return String(code);
  return STATUS_CODE_TO_LABEL[num] ?? String(code);
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
    .enum([
      "Active",
      "Nexus",
      "Omega",
      "Invicta",
      "Alpha",
      "On Hold",
      "Warranty",
      "Completed",
      "Maintenance Plans",
      "Cancelled",
      "Templates",
      "Excluded Reporting",
      "All",
    ])
    .optional()
    .describe(
      'Filter by project status. "Active" matches all four active teams (Nexus/Omega/Invicta/Alpha). Default: Active.',
    ),
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

  // Column index 1 is the status column on the projects datatable.
  // For single-code statuses we filter directly; for multi-code (e.g. "Active"
  // = [5,6,7,8]) we use the pipe-separated syntax that DataTables supports.
  const codes = STATUS_LABEL_TO_CODES[status] ?? [];
  if (codes.length === 1) {
    params["columns[1][search][value]"] = String(codes[0]);
  } else if (codes.length > 1) {
    params["columns[1][search][value]"] = codes.join("|");
    params["columns[1][search][regex]"] = "true";
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
  permission: "read",
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
  permission: "read",
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
  permission: "read",
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
