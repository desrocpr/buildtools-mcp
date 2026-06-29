/**
 * Uncollected-invoices reporting (PR #81).
 *
 * Aggregates financial statements that have been SENT but not fully
 * paid (status ∈ {Sent, Partial, Partly Paid, To Pay}), filtered by
 * how long ago they were sent (sent_date window). Useful for AR
 * follow-up reports ("what's been sitting open >30 days?").
 *
 * Scope is the same shape as cash_flow_forecast: project_ids OR team
 * (`all_active` = whole company; design-phase projects filtered out
 * since they have nothing sent).
 *
 * Read-only. No mutations.
 */

import { z } from "zod/v3";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { BuildToolsAPI } from "../client/BuildToolsAPI.js";

import type { ToolDefinition, ToolResult } from "./projects.js";

// ---------------------------------------------------------------------------
// Markdown / formatting helpers (mirror briefs/forecasts)
// ---------------------------------------------------------------------------

function escapeMarkdownInline(s: unknown): string {
  if (s === undefined || s === null) return "";
  return String(s)
    .replace(/[\r\n]+/g, " ")
    .replace(/[\\`*_[\]<>]/g, (c) => `\\${c}`);
}

function stripHtml(s: unknown): string {
  if (s === undefined || s === null) return "";
  return String(s)
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/gi, " ")
    .trim();
}

function fmtUsd(n: number, decimals = 2): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function markdown(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errorMarkdown(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// ---------------------------------------------------------------------------
// Team mapping
// ---------------------------------------------------------------------------

const TEAM_STATUS_MAP: Record<string, number> = {
  Nexus: 5, Omega: 6, Invicta: 7, Alpha: 8,
};
const ACTIVE_TEAM_CODES = [5, 6, 7, 8];

function teamLabel(statusCode: number | undefined): string {
  switch (statusCode) {
    case 5: return "Nexus";
    case 6: return "Omega";
    case 7: return "Invicta";
    case 8: return "Alpha";
    default: return statusCode !== undefined ? `Status ${statusCode}` : "Unknown";
  }
}

// ---------------------------------------------------------------------------
// Date helpers (sent_date is MM/DD/YYYY from BT)
// ---------------------------------------------------------------------------

function parseSentDate(s: string): Date | null {
  if (!s) return null;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(year, month - 1, day);
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000));
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// PR #81: pre-canned windows shared with the renderer for aging buckets.
const AGING_BUCKETS = [
  { label: "0-7 days",   minDays: 0,  maxDays: 7 },
  { label: "8-14 days",  minDays: 8,  maxDays: 14 },
  { label: "15-30 days", minDays: 15, maxDays: 30 },
  { label: "31-60 days", minDays: 31, maxDays: 60 },
  { label: "61-90 days", minDays: 61, maxDays: 90 },
  { label: "90+ days",   minDays: 91, maxDays: Infinity },
];

const UncollectedInvoicesSchema = z.object({
  project_ids: z
    .array(z.number().int().positive())
    .min(1)
    .max(200)
    .optional()
    .describe("Explicit project IDs to query (1-200). Mutually exclusive with `team`."),
  team: z
    .enum(["Nexus", "Omega", "Invicta", "Alpha", "all_active"])
    .optional()
    .describe("Filter active-team projects. `all_active` = whole company. Mutually exclusive with `project_ids`."),
  window_days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe(
      "Filter to invoices sent within the last N days. Common values: 7 (week), 30 (month), 90 (quarter). When omitted, includes all sent-but-unpaid invoices regardless of age.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("When `team` is set, cap projects fetched. Default 100, max 200."),
})
  .refine(
    (data) => (data.project_ids === undefined) !== (data.team === undefined),
    {
      message: "Exactly one of `project_ids` or `team` must be provided.",
      path: ["project_ids"],
    },
  );

// ---------------------------------------------------------------------------
// Per-project + portfolio aggregation
// ---------------------------------------------------------------------------

type ProjectRow = {
  id?: number | string;
  DT_RowId?: string;
  name?: string;
  status_id?: string | number;
  status?: string | number;
};

interface UncollectedInvoice {
  projectId: number;
  projectName: string;
  team: number;
  id: string;
  name: string;
  status: string;
  amount: number;
  paid: number;
  balance: number;
  sentDate: string;
  ageDays: number;
}

// Statuses that mean "this FS has been sent and may have an outstanding
// balance." Mirrors BuildToolsAPI.getFinancialStatements's SENT_STATUSES.
const UNCOLLECTED_STATUSES = new Set(["Sent", "Partial", "Partly Paid", "To Pay"]);

async function collectProjectInvoices(
  api: BuildToolsAPI,
  projectId: number,
  today: Date,
): Promise<{
  projectName: string;
  team: number;
  rows: UncollectedInvoice[];
  errors: string[];
}> {
  const errors: string[] = [];
  let projectName = `#${projectId}`;
  let team = 0;
  try {
    const project = await api.getProject<ProjectRow>(projectId);
    if (project) {
      projectName = stripHtml(String(project.name ?? projectName));
      const c = Number(project.status_id ?? project.status);
      if (Number.isFinite(c)) team = c;
    }
  } catch {
    errors.push(`project ${projectId} unavailable`);
  }

  let rows: UncollectedInvoice[] = [];
  try {
    const result = await api.getFinancialStatements(projectId);
    for (const s of result?.statements ?? []) {
      if (!UNCOLLECTED_STATUSES.has(s.status)) continue;
      if (s.balance <= 0.005) continue;
      const sentDate = parseSentDate(s.sent_date || s.date);
      if (!sentDate) continue;
      const ageDays = Math.max(daysBetween(today, sentDate), 0);
      rows.push({
        projectId,
        projectName,
        team,
        id: String(s.id),
        name: s.name,
        status: s.status,
        amount: s.amount,
        paid: s.paid,
        balance: Math.round(s.balance * 100) / 100,
        sentDate: s.sent_date || s.date,
        ageDays,
      });
    }
  } catch (err) {
    errors.push(`financial statements unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { projectName, team, rows, errors };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderReport(
  invoices: UncollectedInvoice[],
  scopeLabel: string,
  windowDays: number | undefined,
  errorProjectIds: number[],
): string {
  const lines: string[] = [];
  const windowLabel = windowDays !== undefined ? ` — sent within last ${windowDays} day(s)` : "";
  lines.push(`# Uncollected invoices — ${escapeMarkdownInline(scopeLabel)}${windowLabel}`);
  lines.push("");

  if (invoices.length === 0) {
    lines.push(`No uncollected invoices found in scope${windowDays !== undefined ? ` within the last ${windowDays} day(s)` : ""}. ✓`);
    if (errorProjectIds.length > 0) {
      lines.push("");
      lines.push(`_Caveats: ${errorProjectIds.length} project(s) had fetch errors: ${errorProjectIds.slice(0, 10).join(", ")}_`);
    }
    return lines.join("\n");
  }

  const grandTotal = invoices.reduce((s, i) => s + i.balance, 0);
  const oldest = invoices.reduce((max, i) => Math.max(max, i.ageDays), 0);
  lines.push(`## Headline`);
  lines.push(`- **${fmtUsd(grandTotal)} outstanding** across ${invoices.length} invoice(s) on ${new Set(invoices.map((i) => i.projectId)).size} project(s).`);
  lines.push(`- Oldest unpaid invoice: **${oldest} day(s)**.`);
  lines.push("");

  // === Aging buckets ===
  lines.push(`## Aging`);
  lines.push("| Age bucket | Count | Outstanding |");
  lines.push("|---|---:|---:|");
  for (const b of AGING_BUCKETS) {
    const inBucket = invoices.filter((i) => i.ageDays >= b.minDays && i.ageDays <= b.maxDays);
    if (inBucket.length === 0) continue;
    const sum = inBucket.reduce((s, i) => s + i.balance, 0);
    lines.push(`| ${b.label} | ${inBucket.length} | ${fmtUsd(sum)} |`);
  }
  lines.push("");

  // === Per-team subtotals ===
  const teamSet = new Set(invoices.map((i) => i.team));
  if (teamSet.size > 1) {
    lines.push(`## By team`);
    lines.push("| Team | Count | Outstanding |");
    lines.push("|---|---:|---:|");
    const teamCodes = [...teamSet].sort();
    for (const t of teamCodes) {
      const inTeam = invoices.filter((i) => i.team === t);
      const sum = inTeam.reduce((s, i) => s + i.balance, 0);
      lines.push(`| _${teamLabel(t)}_ | ${inTeam.length} | ${fmtUsd(sum)} |`);
    }
    lines.push("");
  }

  // === Per-invoice detail (sorted by age desc, then balance desc) ===
  lines.push(`## Detail (oldest first)`);
  lines.push("| Age | Sent | Project | Invoice | Status | Amount | Paid | Outstanding |");
  lines.push("|---:|---|---|---|---|---:|---:|---:|");
  const sorted = [...invoices].sort((a, b) => {
    if (b.ageDays !== a.ageDays) return b.ageDays - a.ageDays;
    return b.balance - a.balance;
  });
  for (const i of sorted.slice(0, 60)) {
    lines.push(
      `| ${i.ageDays}d | ${escapeMarkdownInline(i.sentDate)} | #${i.projectId} ${escapeMarkdownInline(i.projectName.slice(0, 40))} _(${teamLabel(i.team)})_ | ${escapeMarkdownInline(i.name.slice(0, 50))} | _${escapeMarkdownInline(i.status)}_ | ${fmtUsd(i.amount)} | ${fmtUsd(i.paid)} | **${fmtUsd(i.balance)}** |`,
    );
  }
  if (sorted.length > 60) {
    lines.push(`\n_…${sorted.length - 60} more invoice(s) truncated from detail table._`);
  }

  if (errorProjectIds.length > 0) {
    lines.push("");
    lines.push(`_Caveats: ${errorProjectIds.length} project(s) had fetch errors: ${errorProjectIds.slice(0, 10).join(", ")}_`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const PROJECT_CONCURRENCY = 5;

function hasPublishedSchedule(p: ProjectRow & { schedule_published_duration?: string }): boolean {
  const v = String(p.schedule_published_duration ?? "").trim();
  if (!v) return false;
  if (v === "-" || v === "0" || v === "0 days") return false;
  return /\d/.test(v);
}

export const uncollectedInvoicesTool: ToolDefinition = {
  name: "uncollected_invoices",
  description:
    "Report outstanding (sent-but-unpaid) financial statements aged by sent_date. " +
    "Filters to statuses {Sent, Partial, Partly Paid, To Pay} with balance > 0. " +
    "Scope via EITHER `project_ids` (1-200) OR `team` (`all_active` = whole company). " +
    "Optional `window_days` filters to invoices sent within the last N days (common: 7=week, 30=month, 90=quarter). " +
    "Output: headline outstanding total, aging buckets (0-7 / 8-14 / 15-30 / 31-60 / 61-90 / 90+ days), per-team subtotals, and per-invoice detail sorted by age. " +
    "Read-only. " +
    "When `team` is set, only projects with a published schedule are queried (design-phase projects have nothing sent anyway).",
  inputSchema: zodToJsonSchema(UncollectedInvoicesSchema),
  permission: "read:projects",
  handler: async (rawArgs: unknown, api: BuildToolsAPI) => {
    const parsed = UncollectedInvoicesSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return errorMarkdown(
        `**Invalid input**\n\n${parsed.error.errors.map((e) => `- ${e.path.join(".")}: ${e.message}`).join("\n")}`,
      );
    }
    const data = parsed.data;

    // === Resolve project IDs ===
    let targetIds: number[];
    let scopeLabel: string;
    if (data.project_ids) {
      targetIds = data.project_ids;
      scopeLabel = `${data.project_ids.length} project(s) by id`;
    } else {
      const teamFilter = data.team!;
      scopeLabel = teamFilter === "all_active" ? "Company (all active teams)" : `Team ${teamFilter}`;
      const wantedCodes =
        teamFilter === "all_active" ? ACTIVE_TEAM_CODES : [TEAM_STATUS_MAP[teamFilter]];
      let allProjects: (ProjectRow & { schedule_published_duration?: string })[] = [];
      try {
        const result = await api.getProjects<{ data: typeof allProjects }>({ length: 300 });
        allProjects = result?.data ?? [];
      } catch (err) {
        return errorMarkdown(
          `**Could not list projects**: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const matched = allProjects.filter((p) => {
        const code = Number(p.status_id ?? p.status);
        return Number.isFinite(code) && wantedCodes.includes(code);
      }).filter(hasPublishedSchedule);
      const cap = data.limit ?? 100;
      targetIds = matched.slice(0, cap).map((p) =>
        Number(p.id ?? (p.DT_RowId ?? "").replace(/^row_/, "")),
      );
      targetIds = targetIds.filter((id) => Number.isFinite(id) && id > 0);
      if (targetIds.length === 0) {
        return markdown(
          `# Uncollected invoices\n\nNo projects with a published schedule matched \`team=${teamFilter}\`.`,
        );
      }
    }

    const today = new Date();

    // Fan out
    const allInvoices: UncollectedInvoice[] = [];
    const errorProjectIds: number[] = [];
    for (let i = 0; i < targetIds.length; i += PROJECT_CONCURRENCY) {
      const batch = targetIds.slice(i, i + PROJECT_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map((id) =>
          collectProjectInvoices(api, id, today).catch(() => ({
            projectName: `#${id}`,
            team: 0,
            rows: [],
            errors: ["fetch failed"],
          })),
        ),
      );
      for (let j = 0; j < batch.length; j++) {
        const r = batchResults[j];
        allInvoices.push(...r.rows);
        if (r.errors.length > 0) errorProjectIds.push(batch[j]);
      }
    }

    // Apply window filter
    const windowed = data.window_days !== undefined
      ? allInvoices.filter((i) => i.ageDays <= data.window_days!)
      : allInvoices;

    return markdown(renderReport(windowed, scopeLabel, data.window_days, errorProjectIds));
  },
};

export const invoiceTools: ToolDefinition[] = [uncollectedInvoicesTool];

// Exported for tests
export const __test__ = { parseSentDate, daysBetween, AGING_BUCKETS };
