/**
 * MCP read-only tools for BuildTools tasks (MOS-293).
 *
 * Two tools:
 *   - list_tasks   — paged datatable, optionally filtered by status / project.
 *   - search_tasks — free-text fuzzy match across task rows.
 *
 * Design notes:
 *
 *   - Mirrors `src/tools/projects.ts` (MOS-214) and `src/tools/customers.ts`
 *     (MOS-216): Zod-validated input, Markdown text response, `isError: true`
 *     content branch on `BuildToolsError`, never throws to the SDK. Empty
 *     results render as plain Markdown (no `isError`).
 *   - Schemas are authored against `zod/v3` (Zod 4 ships the v3 surface under
 *     that sub-export) so `zod-to-json-schema` keeps working — same convention
 *     as every other tool module.
 *   - Status column is index 1 on the tasks datatable; filter via
 *     `columns[1][search][value]` with the numeric code as a string.
 *   - `project_name`: forwarded as the datatable's free-text `search[value]`,
 *     consistent with how `list_projects` handles `customer_name`.
 *   - The `linked_schedule` field is an object `{ linkedSchedule, scheduleType,
 *     scheduleTask }` and is intentionally NOT rendered.
 *   - `assigned_to` comes back as an HTML `<div>` (a truncate tooltip on the
 *     UI side); we run it through `stripHtml(...)` for clean text output.
 */

import { z } from "zod/v3";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { BuildToolsAPI } from "../client/BuildToolsAPI.js";
import { BuildToolsError } from "../client/errors.js";

import type { ToolDefinition, ToolResult } from "./projects.js";

// ---------------------------------------------------------------------------
// Status + priority mappings — verified against desrocpr/buildtools CLAUDE.md
// ---------------------------------------------------------------------------

/** Task status label → numeric code on the datatable. */
const STATUS_LABEL_TO_CODE: Record<string, string> = {
  Open: "1",
  "In Progress": "2",
  Complete: "3",
};

const STATUS_CODE_TO_LABEL: Record<number, string> = {
  1: "Open",
  2: "In Progress",
  3: "Complete",
};

const PRIORITY_CODE_TO_LABEL: Record<number, string> = {
  1: "Normal",
  2: "High",
  3: "Urgent",
};

function statusLabel(code: string | number | undefined | null): string {
  if (code === undefined || code === null || code === "") return "—";
  const num = typeof code === "number" ? code : Number(code);
  if (!Number.isFinite(num)) return String(code);
  return STATUS_CODE_TO_LABEL[num] ?? String(code);
}

function priorityLabel(code: string | number | undefined | null): string {
  if (code === undefined || code === null || code === "") return "—";
  const num = typeof code === "number" ? code : Number(code);
  if (!Number.isFinite(num)) return String(code);
  return PRIORITY_CODE_TO_LABEL[num] ?? String(code);
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

/** Render a single task datatable row as a Markdown list line. */
function formatTaskRow(row: Record<string, unknown>): string {
  const id =
    (row.id as string | number | undefined) ??
    (row.DT_RowId as string | undefined) ??
    "?";
  const status = statusLabel(row.status as string | number | undefined);
  const name = (row.name as string | undefined) ?? "(unnamed task)";
  const project = orDash(row.project);
  const assignedTo = orDash(stripHtml(row.assigned_to));
  const dueDate = orDash(row.due_date);
  const priority = priorityLabel(row.priority as string | number | undefined);
  const location = orDash(row.location);
  return (
    `- #${id} [${status}] ${name}` +
    ` — project: ${project}` +
    ` · assigned: ${assignedTo}` +
    ` · due: ${dueDate}` +
    ` · priority: ${priority}` +
    ` · location: ${location}`
  );
}

/** Minimal projection of a tasks datatable envelope. */
interface TasksDatatable {
  data?: Array<Record<string, unknown>>;
  recordsTotal?: number;
  recordsFiltered?: number;
}

// ---------------------------------------------------------------------------
// list_tasks
// ---------------------------------------------------------------------------

const ListTasksInputSchema = z.object({
  project_name: z
    .string()
    .optional()
    .describe(
      "Substring match against the task's project (free-text search across all columns).",
    ),
  status: z
    .enum(["Open", "In Progress", "Complete", "All"])
    .optional()
    .describe(
      'Filter by task status. Default: "All" (no status filter applied).',
    ),
  limit: z
    .number()
    .min(1)
    .max(200)
    .optional()
    .describe("Max tasks to return. Default 50."),
});

export type ListTasksInput = z.infer<typeof ListTasksInputSchema>;

async function listTasksHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = ListTasksInputSchema.safeParse(args ?? {});
  if (!parsed.success) return formatZodError(parsed.error, "list_tasks");
  const input = parsed.data;

  const status = input.status ?? "All";
  const limit = input.limit ?? 50;

  const params: Record<string, string | number> = {
    length: limit,
  };

  // Column index 1 is the status column on the tasks datatable.
  // "All" => emit no status filter, mirroring `list_projects`.
  if (status !== "All") {
    const code = STATUS_LABEL_TO_CODE[status];
    if (code !== undefined) {
      params["columns[1][search][value]"] = code;
    }
  }

  if (input.project_name) {
    params["search[value]"] = input.project_name;
  }

  try {
    const result = await api.getTasks<TasksDatatable>(params);
    const rows = result?.data ?? [];
    if (rows.length === 0) {
      const filterDesc: string[] = [`status: ${status}`];
      if (input.project_name) {
        filterDesc.push(`project_name: "${input.project_name}"`);
      }
      return markdown(`No tasks matched the filter (${filterDesc.join(", ")}).`);
    }
    const total = result?.recordsFiltered ?? result?.recordsTotal ?? rows.length;
    const header = `**${rows.length} task${rows.length === 1 ? "" : "s"}** (filtered ${total} total, status: ${status}):`;
    const body = rows.map(formatTaskRow).join("\n");
    return markdown(`${header}\n\n${body}`);
  } catch (err) {
    return formatError(err, "list_tasks");
  }
}

export const listTasksTool: ToolDefinition = {
  name: "list_tasks",
  description:
    "List BuildTools tasks with optional filters (project substring, status). Returns up to 50 tasks by default.",
  inputSchema: zodToJsonSchema(ListTasksInputSchema),
  handler: listTasksHandler,
};

// ---------------------------------------------------------------------------
// search_tasks
// ---------------------------------------------------------------------------

const SearchTasksInputSchema = z.object({
  query: z.string().min(2).describe("Search query."),
});

export type SearchTasksInput = z.infer<typeof SearchTasksInputSchema>;

/** Maximum results surfaced by `search_tasks` (matches `searchProjects`). */
const SEARCH_TASKS_LIMIT = 20;

async function searchTasksHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = SearchTasksInputSchema.safeParse(args ?? {});
  if (!parsed.success) return formatZodError(parsed.error, "search_tasks");
  const { query } = parsed.data;

  try {
    const result = await api.searchTasks<TasksDatatable>(
      query,
      SEARCH_TASKS_LIMIT,
    );
    const rows = result?.data ?? [];
    if (rows.length === 0) {
      return markdown(`No tasks matched query "${query}".`);
    }
    const header = `**${rows.length} match${rows.length === 1 ? "" : "es"}** for "${query}":`;
    const body = rows.slice(0, SEARCH_TASKS_LIMIT).map(formatTaskRow).join("\n");
    return markdown(`${header}\n\n${body}`);
  } catch (err) {
    return formatError(err, "search_tasks");
  }
}

export const searchTasksTool: ToolDefinition = {
  name: "search_tasks",
  description:
    "Free-text search across BuildTools tasks (matches name, project, assignee, location).",
  inputSchema: zodToJsonSchema(SearchTasksInputSchema),
  handler: searchTasksHandler,
};

// ---------------------------------------------------------------------------
// Exported registry
// ---------------------------------------------------------------------------

export const taskTools: ToolDefinition[] = [listTasksTool, searchTasksTool];
