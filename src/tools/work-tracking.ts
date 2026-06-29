/**
 * MCP read-only tools for BuildTools work-tracking entities (MOS-295).
 *
 * Four tools — simple datatable wrappers:
 *   - list_certificates   — `getCertificates()` or `searchCertificates()` when
 *                           a free-text `query` is supplied.
 *   - list_daily_logs     — `getDailyLogs()`.
 *   - list_weekly_reports — `getWeeklyReports()`.
 *   - list_work_days      — `getWorkDays()`.
 *
 * Design notes:
 *
 *   - Mirrors `src/tools/projects.ts` / `src/tools/customers.ts` conventions:
 *     Zod-validated input, Markdown text response, `isError: true` content
 *     branch on `BuildToolsError`, never throws to the SDK. Empty / null
 *     datatable envelopes render as plain Markdown (no `isError`).
 *   - Schemas are authored against `zod/v3` (Zod 4 ships the v3 surface under
 *     that sub-export) so `zod-to-json-schema` keeps working — matches the
 *     pattern established in `projects.ts` / `customers.ts`.
 *   - Per the planner contract: helpers (`stripHtml`, `orDash`, `markdown`,
 *     `errorMarkdown`, `formatError`, `formatZodError`) are intentionally
 *     redeclared locally rather than extracted to a shared module — the
 *     sibling read-tool files (projects/financial/customers/attachments) all
 *     follow the same copy-by-redeclaration convention.
 *   - Status codes ship as raw integers from the API (e.g. `status: 1`). Per
 *     the issue's "no status enums, no special parsing" constraint, we render
 *     the value as-is rather than mapping to a label set.
 */

import { z } from "zod/v3";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { BuildToolsAPI } from "../client/BuildToolsAPI.js";
import { BuildToolsError } from "../client/errors.js";

import type { ToolDefinition, ToolResult } from "./projects.js";

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

/** Shared datatable envelope projection. */
interface WorkTrackingDatatable {
  data?: Array<Record<string, unknown>>;
  recordsTotal?: number;
  recordsFiltered?: number;
}

/** Truncate long free-text blobs so bullet lines stay scannable. */
function truncate(value: unknown, max = 80): string {
  const s = stripHtml(value);
  if (s.length === 0) return "";
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/** Pull a row id from the standard `{id, DT_RowId}` envelope. */
function rowId(row: Record<string, unknown>): string | number {
  return (
    (row.id as string | number | undefined) ??
    (row.DT_RowId as string | undefined) ??
    "?"
  );
}

// ---------------------------------------------------------------------------
// list_certificates
// ---------------------------------------------------------------------------

const ListCertificatesInputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      "Optional free-text search across certificate name / type / company.",
    ),
  limit: z
    .number()
    .min(1)
    .max(200)
    .optional()
    .describe("Max certificates to return. Default 50, max 200."),
});

export type ListCertificatesInput = z.infer<typeof ListCertificatesInputSchema>;

/**
 * Render a single certificate datatable row as a Markdown bullet. Fixture
 * fields: `id`, `status`, `name`, `type`, `company`, `issuer`, `issue_date`,
 * `expiry_date`. Any missing field becomes an em-dash via `orDash(...)`.
 */
function formatCertificateRow(row: Record<string, unknown>): string {
  const id = rowId(row);
  const status = orDash(row.status);
  const name = orDash(row.name);
  const type = orDash(row.type);
  const company = orDash(row.company);
  const issueDate = orDash(row.issue_date);
  const expiryDate = orDash(row.expiry_date);
  const issuer = stripHtml(row.issuer);
  const issuerTrailer = issuer ? ` — issuer: ${issuer}` : "";
  return `- #${id} [${status}] ${name} — ${type} — ${company} — issued ${issueDate}, expires ${expiryDate}${issuerTrailer}`;
}

async function listCertificatesHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = ListCertificatesInputSchema.safeParse(args ?? {});
  if (!parsed.success) return formatZodError(parsed.error, "list_certificates");
  const { query, limit } = parsed.data;
  const effectiveLimit = limit ?? 50;

  try {
    const result = query
      ? await (api.db ?? api).searchCertificates<WorkTrackingDatatable>(
          query,
          effectiveLimit,
        )
      : await (api.db ?? api).getCertificates<WorkTrackingDatatable>({
          length: effectiveLimit,
        });
    const rows = result?.data ?? [];
    if (rows.length === 0) {
      const trailer = query ? ` matching "${query}"` : "";
      return markdown(`No certificates found${trailer}.`);
    }
    const header = `**${rows.length} certificate${rows.length === 1 ? "" : "s"}**${query ? ` matching "${query}"` : ""}:`;
    const body = rows.map(formatCertificateRow).join("\n");
    return markdown(`${header}\n\n${body}`);
  } catch (err) {
    return formatError(err, "list_certificates");
  }
}

export const listCertificatesTool: ToolDefinition = {
  name: "list_certificates",
  description:
    "List BuildTools certificates (insurance, licensing, etc.) with optional free-text search.",
  inputSchema: zodToJsonSchema(ListCertificatesInputSchema),
  permission: "read",
  handler: listCertificatesHandler,
};

// ---------------------------------------------------------------------------
// list_daily_logs
// ---------------------------------------------------------------------------

const LimitOnlyInputSchema = z.object({
  limit: z
    .number()
    .min(1)
    .max(200)
    .optional()
    .describe("Max rows to return. Default 50, max 200."),
});

export type LimitOnlyInput = z.infer<typeof LimitOnlyInputSchema>;

/**
 * Render a daily-log row. Fixture fields: `id`, `status`, `project`, `date`,
 * `weather`, `hours_worked`, `notes`. Notes are truncated to keep bullets
 * readable.
 */
function formatDailyLogRow(row: Record<string, unknown>): string {
  const id = rowId(row);
  const status = orDash(row.status);
  const date = orDash(row.date);
  const project = orDash(row.project);
  const hours = orDash(row.hours_worked);
  const weather = orDash(row.weather);
  const notes = truncate(row.notes);
  const notesTrailer = notes ? ` — ${notes}` : "";
  return `- #${id} [${status}] ${date} — ${project} — ${hours}h — ${weather}${notesTrailer}`;
}

async function listDailyLogsHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = LimitOnlyInputSchema.safeParse(args ?? {});
  if (!parsed.success) return formatZodError(parsed.error, "list_daily_logs");
  const effectiveLimit = parsed.data.limit ?? 50;

  try {
    const result = await (api.db ?? api).getDailyLogs<WorkTrackingDatatable>({
      length: effectiveLimit,
    });
    const rows = result?.data ?? [];
    if (rows.length === 0) return markdown(`No daily logs found.`);
    const header = `**${rows.length} daily log${rows.length === 1 ? "" : "s"}**:`;
    const body = rows.map(formatDailyLogRow).join("\n");
    return markdown(`${header}\n\n${body}`);
  } catch (err) {
    return formatError(err, "list_daily_logs");
  }
}

export const listDailyLogsTool: ToolDefinition = {
  name: "list_daily_logs",
  description:
    "List BuildTools daily logs (per-project per-day status entries).",
  inputSchema: zodToJsonSchema(LimitOnlyInputSchema),
  permission: "read",
  handler: listDailyLogsHandler,
};

// ---------------------------------------------------------------------------
// list_weekly_reports
// ---------------------------------------------------------------------------

/**
 * Render a weekly-report row. Fixture fields: `id`, `status`, `project`,
 * `week_start`, `week_end`, `total_hours`, `summary`. Summary is truncated.
 */
function formatWeeklyReportRow(row: Record<string, unknown>): string {
  const id = rowId(row);
  const status = orDash(row.status);
  const weekStart = orDash(row.week_start);
  const weekEnd = orDash(row.week_end);
  const project = orDash(row.project);
  const hours = orDash(row.total_hours);
  const summary = truncate(row.summary);
  const summaryTrailer = summary ? ` — ${summary}` : "";
  return `- #${id} [${status}] ${weekStart} → ${weekEnd} — ${project} — ${hours}h${summaryTrailer}`;
}

async function listWeeklyReportsHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = LimitOnlyInputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return formatZodError(parsed.error, "list_weekly_reports");
  }
  const effectiveLimit = parsed.data.limit ?? 50;

  try {
    const result = await (api.db ?? api).getWeeklyReports<WorkTrackingDatatable>({
      length: effectiveLimit,
    });
    const rows = result?.data ?? [];
    if (rows.length === 0) return markdown(`No weekly reports found.`);
    const header = `**${rows.length} weekly report${rows.length === 1 ? "" : "s"}**:`;
    const body = rows.map(formatWeeklyReportRow).join("\n");
    return markdown(`${header}\n\n${body}`);
  } catch (err) {
    return formatError(err, "list_weekly_reports");
  }
}

export const listWeeklyReportsTool: ToolDefinition = {
  name: "list_weekly_reports",
  description:
    "List BuildTools weekly reports (per-project weekly progress summaries).",
  inputSchema: zodToJsonSchema(LimitOnlyInputSchema),
  permission: "read",
  handler: listWeeklyReportsHandler,
};

// ---------------------------------------------------------------------------
// list_work_days
// ---------------------------------------------------------------------------

/**
 * Render a work-day row. Fixture fields: `id`, `status`, `project`, `date`,
 * `user`, `hours`.
 */
function formatWorkDayRow(row: Record<string, unknown>): string {
  const id = rowId(row);
  const status = orDash(row.status);
  const date = orDash(row.date);
  const user = orDash(row.user);
  const project = orDash(row.project);
  const hours = orDash(row.hours);
  return `- #${id} [${status}] ${date} — ${user} — ${project} — ${hours}h`;
}

async function listWorkDaysHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = LimitOnlyInputSchema.safeParse(args ?? {});
  if (!parsed.success) return formatZodError(parsed.error, "list_work_days");
  const effectiveLimit = parsed.data.limit ?? 50;

  try {
    const result = await (api.db ?? api).getWorkDays<WorkTrackingDatatable>({
      length: effectiveLimit,
    });
    const rows = result?.data ?? [];
    if (rows.length === 0) return markdown(`No work days found.`);
    const header = `**${rows.length} work day${rows.length === 1 ? "" : "s"}**:`;
    const body = rows.map(formatWorkDayRow).join("\n");
    return markdown(`${header}\n\n${body}`);
  } catch (err) {
    return formatError(err, "list_work_days");
  }
}

export const listWorkDaysTool: ToolDefinition = {
  name: "list_work_days",
  description:
    "List BuildTools work-day entries (per-user per-day hours logged on projects).",
  inputSchema: zodToJsonSchema(LimitOnlyInputSchema),
  permission: "read",
  handler: listWorkDaysHandler,
};

// ---------------------------------------------------------------------------
// Exported registry
// ---------------------------------------------------------------------------

export const workTrackingTools: ToolDefinition[] = [
  listCertificatesTool,
  listDailyLogsTool,
  listWeeklyReportsTool,
  listWorkDaysTool,
];
