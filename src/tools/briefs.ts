/**
 * Read-only digest tools for project status briefings (PR #66).
 *
 * `project_status_brief` — assembles a per-project digest by fanning
 * out across the existing read primitives (getProjects, getRFIs,
 * getTasks, getChangeOrders, getPurchaseOrders, getFinancialStatements).
 *
 * Designed for "Monday-morning standup" use cases: PM asks "what's on
 * fire across my active jobs?" and the tool returns a markdown digest
 * grouped by project, surfacing the highest-attention items in each
 * category.
 *
 * No confirmation framework — these are pure reads with no BT-side
 * side effects.
 */

import { z } from "zod/v3";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { BuildToolsAPI } from "../client/BuildToolsAPI.js";

import type { ToolDefinition, ToolResult } from "./projects.js";

// ---------------------------------------------------------------------------
// Markdown helpers
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

function markdown(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errorMarkdown(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// ---------------------------------------------------------------------------
// Status code → team label
// ---------------------------------------------------------------------------

const TEAM_STATUS_MAP: Record<string, number> = {
  Nexus: 5,
  Omega: 6,
  Invicta: 7,
  Alpha: 8,
};
const ACTIVE_TEAM_CODES = [5, 6, 7, 8];

function teamLabel(statusCode: number | undefined): string {
  switch (statusCode) {
    case 1: return "Templates";
    case 2: return "On Hold";
    case 3: return "Warranty";
    case 4: return "Completed";
    case 5: return "Nexus";
    case 6: return "Omega";
    case 7: return "Invicta";
    case 8: return "Alpha";
    case 10: return "Maintenance Plans";
    case 12: return "Cancelled";
    case 14: return "Excluded Reporting";
    default: return statusCode === undefined ? "—" : `status ${statusCode}`;
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ProjectStatusBriefSchema = z.object({
  project_ids: z
    .array(z.number().int().positive())
    .min(1)
    .max(30)
    .optional()
    .describe(
      "Explicit list of project IDs to brief on (1-30). Mutually exclusive with `team`.",
    ),
  team: z
    .enum(["Nexus", "Omega", "Invicta", "Alpha", "all_active"])
    .optional()
    .describe(
      "Filter active-team projects. `all_active` includes Nexus + Omega + Invicta + Alpha (statuses 5-8). Mutually exclusive with `project_ids`.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(30)
    .optional()
    .describe(
      "Cap on number of projects briefed. Default 10, max 30. Ignored when `project_ids` is set (use the array length).",
    ),
  include: z
    .array(
      z.enum([
        "schedule",
        "unbilled_cos",
        "selections_vs_allowances",
        "budget_vs_pos",
        // Legacy sections still supported but off by default — Moss workflow
        // doesn't use RFIs, and the rest are covered by the new sections.
        "rfis",
        "tasks",
        "purchase_orders",
        "change_orders",
        "draws",
      ]),
    )
    .optional()
    .describe(
      "Which sections to include per project. Default: schedule + unbilled_cos + selections_vs_allowances + budget_vs_pos. " +
        "Legacy sections (rfis, tasks, purchase_orders, change_orders, draws) are accepted but NOT in the default set.",
    ),
})
  .refine(
    (data) => (data.project_ids === undefined) !== (data.team === undefined),
    {
      message: "Exactly one of `project_ids` or `team` must be provided.",
      path: ["project_ids"],
    },
  );
type ProjectStatusBriefArgs = z.infer<typeof ProjectStatusBriefSchema>;

// ---------------------------------------------------------------------------
// Datatable row shapes (loose — BT's JSON varies per entity)
// ---------------------------------------------------------------------------

type ProjectRow = {
  id?: number | string;
  DT_RowId?: string;
  name?: string;
  status?: string | number;
  status_id?: string | number;
  // PR #72: surface extra metadata for the project summary header.
  budget_revised?: string;     // BT's pre-formatted contract value
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  managers?: string | string[];
};

type RfiRow = {
  info?: number | string;
  number?: string;
  subject?: string;
  status?: string;
  priority?: string;
  assigned_to?: string;
  date?: string;
};

type TaskRow = {
  info?: number | string;
  number?: string;
  name?: string;
  status?: string;
  priority?: string;
  due_date?: string;
  assigned_to?: string;
};

type PoRow = {
  info?: number | string;
  name?: string;
  number?: string;
  total?: string;
  status?: string;
  company?: string;
};

type CoRow = {
  info?: number | string;
  name?: string;
  number?: string;
  total?: string;
  status?: string;
  approved?: string;
};

// ---------------------------------------------------------------------------
// Per-section assemblers — best-effort; on any error we mark the
// section as "(unavailable)" rather than failing the whole brief.
// ---------------------------------------------------------------------------

interface ProjectDigest {
  id: number;
  name: string;
  status?: number;
  // PR #72 — project metadata pulled from the project row + lookups.
  contractValue?: number;        // numeric for math; rendered as currency
  contractValueRaw?: string;     // BT's pre-formatted string (e.g. "$ 665,124.94")
  address?: string;
  city?: string;
  state?: string;
  managers?: string;

  // === PR #73 — Moss-actual sections ===

  /**
   * Schedule / billing progress derived from financial statements.
   * Per the Moss workflow: Draft FS = milestones scheduled at project
   * creation; status flips to Sent when the milestone is reached and
   * billed. Last Sent/Paid FS is the "current position" anchor; pending
   * Drafts are upcoming milestones the PM must judge against the
   * physical schedule.
   */
  schedule?: {
    contractValue?: number;
    totalBilledExclDraft: number;    // sum of Sent/Paid amounts
    totalPaid: number;
    pctBilled?: number;              // % of contract billed (if contract value known)
    lastBilled?: { name: string; amount: number; status: string; date: string };
    pendingDrafts: Array<{ name: string; amount: number; date: string }>;
    fullHistory: Array<{ name: string; amount: number; paid: number; balance: number; status: string; date: string }>;
  };

  /** Approved CO total not yet on a Sent/Paid financial statement. */
  unbilledCos?: {
    pendingApprovedCount: number;
    pendingApprovedTotal: number;
    pendingCount: number;
    pendingTotal: number;
    approvedTotal: number;
    rows: Array<{ name: string; status: string; total: number }>;
  };

  /**
   * For each allowance category: did the team's selections roll up to
   * within the revised budget for that allowance? Surfaces over/under
   * + categories with no selections yet.
   */
  selectionsVsAllowances?: {
    items: Array<{
      categoryName: string;
      revisedBudget: number;
      selectionsTotal: number;
      selectionCount: number;
      variance: number;        // selectionsTotal - revisedBudget
      status: "over" | "under" | "match" | "no-selections";
    }>;
  };

  /**
   * Budget categories that have at least one Sent PO. For each: revised
   * budget vs sent PO total. Categories without POs are skipped because
   * "no PO = no buyout = budget not determined" (per Moss).
   */
  budgetVsPos?: {
    items: Array<{
      categoryName: string;
      revisedBudget: number;
      sentPoTotal: number;
      variance: number;       // sentPoTotal - revisedBudget
      pctUsed: number;        // 0..N (>1.0 means over budget)
      status: "over" | "under" | "match";
    }>;
  };

  // === Legacy sections (kept for backward compat; off by default) ===
  rfis?: { count: number; lines: string[] };
  tasks?: { count: number; lines: string[] };
  pos?: { count: number; totalApprox: number; lines: string[] };
  cos?: { count: number; totalApprox: number; lines: string[]; byStatus?: Record<string, { count: number; total: number }> };
  draws?: {
    count: number;
    totalBilled: number;
    totalPaid: number;
    totalBalance: number;
    all: Array<{ name: string; amount: number; paid: number; balance: number; status: string; date: string }>;
  };
  errors: string[];
}

function parseDollarAmount(s: unknown): number {
  if (typeof s === "number" && Number.isFinite(s)) return s;
  if (typeof s !== "string") return 0;
  const match = s.replace(/<[^>]*>/g, "").match(/[\d.,]+/);
  if (!match) return 0;
  const n = parseFloat(match[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

async function fetchRfis(api: BuildToolsAPI, projectName: string): Promise<{ count: number; lines: string[] } | null> {
  try {
    // BT lists are tenant-wide; the search query gets us NEAR the right
    // rows but substring search means a project named "Smith" matches
    // RFIs from "Smith Plumbing", "Johnsmith Master Bath", etc.
    // (PR #66 review HIGH 3). We filter post-fetch by exact project
    // name match.
    const result = await api.getRFIs<{ data: (RfiRow & { project?: string })[] }>({
      "search[value]": projectName,
      length: 50,
    });
    const rows = result?.data ?? [];
    const targetProjectKey = projectName.toLowerCase();
    const open = rows.filter((r) => {
      // Cross-project contamination filter — drop rows whose own
      // project field doesn't match exactly.
      const rowProject = stripHtml(r.project ?? "").toLowerCase();
      if (rowProject && rowProject !== targetProjectKey) return false;
      const status = stripHtml(r.status ?? "").toLowerCase();
      // PR #66 review MEDIUM: dropped speculative startsWith("1")
      // arms — RFI status column returns text labels, not numeric
      // codes; the arms were dead code that could silently over-include.
      return status.includes("open") || status.includes("in progress");
    });
    // Sort by priority (Urgent > High > Normal)
    const priorityRank = (p: string) => {
      const lp = p.toLowerCase();
      if (lp.includes("urgent")) return 3;
      if (lp.includes("high")) return 2;
      return 1;
    };
    const sorted = [...open].sort(
      (a, b) => priorityRank(stripHtml(b.priority ?? "")) - priorityRank(stripHtml(a.priority ?? "")),
    );
    const lines = sorted.slice(0, 3).map((r) => {
      const num = r.number || `#${r.info ?? "?"}`;
      const subject = stripHtml(r.subject ?? "(no subject)");
      const priority = stripHtml(r.priority ?? "Normal");
      return `  - ${escapeMarkdownInline(num)} [${escapeMarkdownInline(priority)}] ${escapeMarkdownInline(subject.slice(0, 80))}`;
    });
    return { count: open.length, lines };
  } catch (err) {
    // PR #66 review HIGH 5: log silently-degraded sections so a
    // persistent backend outage doesn't read as "permanently 0"
    // without any alerting signal.
    process.stderr.write(
      `[project_status_brief] section fetch failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

async function fetchTasks(api: BuildToolsAPI, projectName: string): Promise<{ count: number; lines: string[] } | null> {
  try {
    const result = await api.getTasks<{ data: (TaskRow & { project?: string })[] }>({
      "search[value]": projectName,
      length: 50,
    });
    const rows = result?.data ?? [];
    const targetProjectKey = projectName.toLowerCase();
    const open = rows.filter((r) => {
      const rowProject = stripHtml(r.project ?? "").toLowerCase();
      if (rowProject && rowProject !== targetProjectKey) return false;
      const status = stripHtml(r.status ?? "").toLowerCase();
      return status.includes("open") || status.includes("in progress");
    });
    // Sort: past-due first, then high priority
    const today = new Date().toISOString().slice(0, 10);
    const sorted = [...open].sort((a, b) => {
      const aPast = (a.due_date ?? "") < today ? 1 : 0;
      const bPast = (b.due_date ?? "") < today ? 1 : 0;
      if (aPast !== bPast) return bPast - aPast;
      const aPrio = stripHtml(a.priority ?? "").toLowerCase().includes("high") ? 1 : 0;
      const bPrio = stripHtml(b.priority ?? "").toLowerCase().includes("high") ? 1 : 0;
      return bPrio - aPrio;
    });
    const lines = sorted.slice(0, 3).map((r) => {
      const name = stripHtml(r.name ?? "(unnamed task)");
      // PR #66 review MEDIUM (security): due_date escaped before
      // markdown interpolation. BT can store user-supplied values
      // here and a `]( injection would otherwise create active links.
      const due = r.due_date ? ` (due ${escapeMarkdownInline(stripHtml(r.due_date))})` : "";
      const priority = stripHtml(r.priority ?? "");
      const pp = priority && !priority.toLowerCase().includes("normal") ? ` [${escapeMarkdownInline(priority)}]` : "";
      return `  - ${escapeMarkdownInline(name.slice(0, 80))}${pp}${due}`;
    });
    return { count: open.length, lines };
  } catch (err) {
    // PR #66 review HIGH 5: log silently-degraded sections so a
    // persistent backend outage doesn't read as "permanently 0"
    // without any alerting signal.
    process.stderr.write(
      `[project_status_brief] section fetch failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

async function fetchPOs(api: BuildToolsAPI, projectName: string): Promise<{ count: number; totalApprox: number; lines: string[] } | null> {
  try {
    const result = await api.getPurchaseOrders<{ data: (PoRow & { project?: string })[] }>({
      "search[value]": projectName,
      length: 30,
    });
    const rows = result?.data ?? [];
    const targetProjectKey = projectName.toLowerCase();
    // PR #66 review HIGH 1: "Open" = Draft + Sent. Original filter
    // missed Confirmed (which contains neither "rejected" nor
    // "complete") — Confirmed POs are LOCKED, not open. Add the
    // explicit exclusion.
    const open = rows.filter((r) => {
      const rowProject = stripHtml(r.project ?? "").toLowerCase();
      if (rowProject && rowProject !== targetProjectKey) return false;
      const status = stripHtml(r.status ?? "").toLowerCase();
      return !status.includes("rejected") && !status.includes("complete") && !status.includes("confirmed");
    });
    const totalApprox = open.reduce((acc, r) => acc + parseDollarAmount(r.total), 0);
    const lines = open.slice(0, 3).map((r) => {
      const name = stripHtml(r.name ?? "(unnamed PO)");
      // PR #66 review MEDIUM (security): escape BT-sourced total +
      // status + company strings before markdown interpolation —
      // stripHtml alone doesn't neutralize markdown specials, and a
      // vendor-supplied name with `](evil)` syntax could inject
      // links into the LLM context.
      const total = escapeMarkdownInline(stripHtml(r.total ?? "$0"));
      const status = escapeMarkdownInline(stripHtml(r.status ?? ""));
      const company = escapeMarkdownInline(stripHtml(r.company ?? ""));
      return `  - ${escapeMarkdownInline(name.slice(0, 60))} — ${total}${company ? ` (${company})` : ""}${status ? ` — _${status}_` : ""}`;
    });
    return { count: open.length, totalApprox, lines };
  } catch (err) {
    process.stderr.write(
      `[project_status_brief] PO section fetch failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

async function fetchCOs(api: BuildToolsAPI, projectName: string): Promise<ProjectDigest["cos"] | null> {
  try {
    const result = await api.getChangeOrders<{ data: (CoRow & { project?: string })[] }>({
      "search[value]": projectName,
      length: 30,
    });
    const rows = result?.data ?? [];
    const targetProjectKey = projectName.toLowerCase();
    const projectRows = rows.filter((r) => {
      const rowProject = stripHtml(r.project ?? "").toLowerCase();
      return !rowProject || rowProject === targetProjectKey;
    });
    // PR #72: bucket by status, not just "approved". Shows real CO
    // landscape (Pending, Approved, Rejected, etc.) with $ impact per
    // bucket. Surface in the digest so the brief is actionable.
    const byStatus: Record<string, { count: number; total: number }> = {};
    for (const r of projectRows) {
      const statusKey = stripHtml(r.status ?? "Unknown") || "Unknown";
      const t = parseDollarAmount(r.total);
      if (!byStatus[statusKey]) byStatus[statusKey] = { count: 0, total: 0 };
      byStatus[statusKey].count += 1;
      byStatus[statusKey].total += t;
    }
    // Round all status totals to cents.
    for (const k of Object.keys(byStatus)) {
      byStatus[k].total = Math.round(byStatus[k].total * 100) / 100;
    }
    const approved = projectRows.filter((r) => stripHtml(r.status ?? "").toLowerCase().includes("approved"));
    const totalApprox = approved.reduce((acc, r) => acc + parseDollarAmount(r.total), 0);
    const lines = approved.slice(0, 3).map((r) => {
      const name = stripHtml(r.name ?? "(unnamed CO)");
      const total = escapeMarkdownInline(stripHtml(r.total ?? "$0"));
      return `  - ${escapeMarkdownInline(name.slice(0, 70))} — ${total}`;
    });
    return { count: approved.length, totalApprox, lines, byStatus };
  } catch (err) {
    process.stderr.write(
      `[project_status_brief] CO section fetch failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

async function fetchDraws(api: BuildToolsAPI, projectId: number): Promise<ProjectDigest["draws"] | null> {
  try {
    const result = await api.getFinancialStatements(projectId);
    const statements = result?.statements ?? [];
    // Reverse-chronological for display.
    const sorted = [...statements].sort(
      (a, b) => (b.date ?? "").localeCompare(a.date ?? ""),
    );
    const all = sorted.map((s) => ({
      name: stripHtml(s.name ?? "(unnamed)"),
      amount: typeof s.amount === "number" ? s.amount : 0,
      paid: typeof s.paid === "number" ? s.paid : 0,
      balance: typeof s.balance === "number" ? s.balance : 0,
      status: stripHtml(s.status ?? ""),
      date: stripHtml(s.date ?? ""),
    }));
    // PR #72: roll-up totals across all draws — the high-value
    // numbers a PM looks for in a project summary.
    const round = (n: number) => Math.round(n * 100) / 100;
    const totalBilled = round(all.reduce((a, s) => a + s.amount, 0));
    const totalPaid = round(all.reduce((a, s) => a + s.paid, 0));
    const totalBalance = round(all.reduce((a, s) => a + s.balance, 0));
    return { count: statements.length, totalBilled, totalPaid, totalBalance, all };
  } catch (err) {
    process.stderr.write(
      `[project_status_brief] draws section fetch failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// PR #73 Moss-actual section assemblers
// ---------------------------------------------------------------------------

async function fetchSchedule(
  api: BuildToolsAPI,
  projectId: number,
  contractValue?: number,
): Promise<ProjectDigest["schedule"] | null> {
  try {
    const result = await api.getFinancialStatements(projectId);
    const statements = result?.statements ?? [];
    const round = (n: number) => Math.round(n * 100) / 100;
    const fullHistory = [...statements]
      .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))
      .map((s) => ({
        name: stripHtml(s.name ?? "(unnamed)"),
        amount: typeof s.amount === "number" ? s.amount : 0,
        paid: typeof s.paid === "number" ? s.paid : 0,
        balance: typeof s.balance === "number" ? s.balance : 0,
        status: stripHtml(s.status ?? ""),
        date: stripHtml(s.date ?? ""),
      }));
    const billed = fullHistory.filter((s) => {
      const st = s.status.toLowerCase();
      return st.includes("sent") || st.includes("paid");
    });
    const drafts = fullHistory.filter((s) => s.status.toLowerCase().includes("draft"));
    const totalBilledExclDraft = round(billed.reduce((a, s) => a + s.amount, 0));
    const totalPaid = round(fullHistory.reduce((a, s) => a + s.paid, 0));
    const pctBilled =
      contractValue && contractValue > 0 && totalBilledExclDraft > 0
        ? round((totalBilledExclDraft / contractValue) * 100)
        : undefined;
    // Last billed = most recent Sent/Paid by date.
    const lastBilled =
      billed.length > 0
        ? [...billed].sort((a, b) => b.date.localeCompare(a.date))[0]
        : undefined;
    return {
      contractValue,
      totalBilledExclDraft,
      totalPaid,
      pctBilled,
      lastBilled,
      pendingDrafts: drafts.map((d) => ({ name: d.name, amount: d.amount, date: d.date })),
      fullHistory,
    };
  } catch (err) {
    process.stderr.write(
      `[project_status_brief] schedule section fetch failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

async function fetchUnbilledCos(
  api: BuildToolsAPI,
  projectName: string,
): Promise<ProjectDigest["unbilledCos"] | null> {
  try {
    const result = await api.getChangeOrders<{ data: (Record<string, unknown> & { project?: string })[] }>({
      "search[value]": projectName,
      length: 100,
    });
    const rows = result?.data ?? [];
    const targetProjectKey = projectName.toLowerCase();
    const projectRows = rows.filter((r) => {
      const rowProject = stripHtml((r.project as string | undefined) ?? "").toLowerCase();
      return !rowProject || rowProject === targetProjectKey;
    });
    // Each CO row exposes both `status` (label like "Approved") and an
    // unbilled marker. Without a structured "billed" field we use a
    // heuristic: status contains "approved" AND `invoice_related` /
    // `pending` indicates not yet billed. The widely-used BT convention:
    // approved + balance > 0 (where balance = total - invoiced) = unbilled.
    // We approximate via the `total` and `invoiced_amount` (or similar)
    // columns when present. Safest fallback: count anything Approved
    // without a Paid marker.
    const round = (n: number) => Math.round(n * 100) / 100;
    const approved = projectRows.filter((r) =>
      stripHtml((r.status as string | undefined) ?? "").toLowerCase().includes("approved"),
    );
    const pending = projectRows.filter((r) =>
      stripHtml((r.status as string | undefined) ?? "").toLowerCase().includes("pending"),
    );
    const pendingApproved = approved.filter((r) => {
      const total = parseDollarAmount(r.total);
      const invoiced = parseDollarAmount(r.invoiced_amount ?? r.invoiced ?? "0");
      // "Unbilled" when total > invoiced — meaning some of the CO has yet to be billed.
      return total > invoiced + 0.005;
    });
    const approvedTotal = round(approved.reduce((a, r) => a + parseDollarAmount(r.total), 0));
    const pendingApprovedTotal = round(
      pendingApproved.reduce((a, r) => a + (parseDollarAmount(r.total) - parseDollarAmount(r.invoiced_amount ?? r.invoiced ?? "0")), 0),
    );
    const pendingTotal = round(pending.reduce((a, r) => a + parseDollarAmount(r.total), 0));
    const fmtRow = (r: Record<string, unknown>) => ({
      name: stripHtml((r.name as string | undefined) ?? "(unnamed CO)"),
      status: stripHtml((r.status as string | undefined) ?? ""),
      total: parseDollarAmount(r.total),
    });
    return {
      pendingApprovedCount: pendingApproved.length,
      pendingApprovedTotal,
      pendingCount: pending.length,
      pendingTotal,
      approvedTotal,
      rows: [...pendingApproved, ...pending].map(fmtRow),
    };
  } catch (err) {
    process.stderr.write(
      `[project_status_brief] unbilled_cos fetch failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

async function fetchSelectionsVsAllowances(
  api: BuildToolsAPI,
  projectId: number,
): Promise<ProjectDigest["selectionsVsAllowances"] | null> {
  try {
    const [budget, sel] = await Promise.all([
      api.getBudget(projectId),
      api.getSelections(projectId),
    ]);
    const allowances = (budget?.items ?? []).filter((i) => i.isAllowance);
    const round = (n: number) => Math.round(n * 100) / 100;
    const selectionsByCategory = new Map<string, { total: number; count: number }>();
    for (const s of sel?.selections ?? []) {
      const cat = s.category ?? "";
      const price = parseDollarAmount(s.price);
      const cur = selectionsByCategory.get(cat) ?? { total: 0, count: 0 };
      cur.total += price;
      cur.count += 1;
      selectionsByCategory.set(cat, cur);
    }
    const items = allowances.map((a) => {
      const sel = selectionsByCategory.get(a.name) ?? { total: 0, count: 0 };
      const revisedBudget = a.publishedRevised || 0;
      const selectionsTotal = round(sel.total);
      const variance = round(selectionsTotal - revisedBudget);
      const status: "over" | "under" | "match" | "no-selections" =
        sel.count === 0
          ? "no-selections"
          : Math.abs(variance) < 1
            ? "match"
            : variance > 0
              ? "over"
              : "under";
      return {
        categoryName: a.name,
        revisedBudget,
        selectionsTotal,
        selectionCount: sel.count,
        variance,
        status,
      };
    });
    return { items };
  } catch (err) {
    process.stderr.write(
      `[project_status_brief] selections_vs_allowances fetch failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

async function fetchBudgetVsPos(
  api: BuildToolsAPI,
  projectId: number,
): Promise<ProjectDigest["budgetVsPos"] | null> {
  try {
    const budget = await api.getBudget(projectId);
    const round = (n: number) => Math.round(n * 100) / 100;
    // cells[9] is SENT POs per the column header order
    // ["", "BUDGET CATEGORY", "SUBCONTRACTORS", "INFO", "", "", "BUDGET",
    //  "APPROVED CO'S", "REVISED BUDGET", "SENT PO'S", ...]
    // Probe verified live 2026-06-27.
    const SENT_POS_CELL_INDEX = 9;
    const items: NonNullable<ProjectDigest["budgetVsPos"]>["items"] = [];
    for (const row of budget?.items ?? []) {
      const sentPoTotal = parseDollarAmount(row.cells[SENT_POS_CELL_INDEX] ?? "0");
      // "No PO = no buyout, no budget determination" per Moss workflow.
      if (sentPoTotal <= 0.005) continue;
      const revisedBudget = row.publishedRevised || 0;
      const variance = round(sentPoTotal - revisedBudget);
      const pctUsed = revisedBudget > 0 ? round((sentPoTotal / revisedBudget) * 100) / 100 : Infinity;
      const status: "over" | "under" | "match" =
        Math.abs(variance) < 1 ? "match" : variance > 0 ? "over" : "under";
      items.push({
        categoryName: row.name,
        revisedBudget,
        sentPoTotal: round(sentPoTotal),
        variance,
        pctUsed,
        status,
      });
    }
    // Sort: over-budget categories first (most overrun), then by variance magnitude
    items.sort((a, b) => {
      if (a.status === "over" && b.status !== "over") return -1;
      if (b.status === "over" && a.status !== "over") return 1;
      return Math.abs(b.variance) - Math.abs(a.variance);
    });
    return { items };
  } catch (err) {
    process.stderr.write(
      `[project_status_brief] budget_vs_pos fetch failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-project assembler
// ---------------------------------------------------------------------------

async function buildProjectDigest(
  api: BuildToolsAPI,
  projectId: number,
  include: Set<string>,
): Promise<ProjectDigest> {
  const digest: ProjectDigest = { id: projectId, name: `#${projectId}`, errors: [] };

  // Project header — REQUIRED for name-based section fetches.
  // PR #66 review HIGH 2: if getProject fails, digest.name remains
  // "#100002" which BT's datatable text search will not match against
  // ANY real entity — all sections would return 0 rows, rendering as
  // a misleading "all clean" digest. Track success here and skip the
  // name-based fetches on failure (only `draws` uses projectId
  // directly and is safe).
  let projectLookupOk = false;
  // PR #66 review LOW (info-leak): normalized error string instead of
  // surfacing the underlying message — eliminates the differential
  // between "404 vs 403 vs timeout" that could leak project existence.
  try {
    const project = await api.getProject<ProjectRow>(projectId);
    if (project) {
      digest.name = stripHtml(String(project.name ?? `#${projectId}`));
      const statusCode = Number(project.status_id ?? project.status);
      digest.status = Number.isFinite(statusCode) ? statusCode : undefined;
      // PR #72: harvest metadata for the project summary header.
      digest.contractValueRaw = stripHtml(project.budget_revised ?? "") || undefined;
      digest.contractValue = parseDollarAmount(project.budget_revised);
      digest.address = stripHtml(project.address ?? "") || undefined;
      digest.city = stripHtml(project.city ?? "") || undefined;
      digest.state = stripHtml(project.state ?? "") || undefined;
      digest.managers = Array.isArray(project.managers)
        ? project.managers.map((m) => stripHtml(String(m))).filter(Boolean).join(", ") || undefined
        : stripHtml(String(project.managers ?? "")) || undefined;
      projectLookupOk = true;
    } else {
      digest.errors.push(`project ${projectId} unavailable`);
    }
  } catch {
    digest.errors.push(`project ${projectId} unavailable`);
  }

  // PR #73: parallel fetches for the new Moss-actual sections (schedule,
  // unbilled_cos, selections_vs_allowances, budget_vs_pos) + the legacy
  // ones for back-compat. All best-effort; failures degrade to caveats.
  const [
    schedule, unbilledCos, sva, bvp,
    rfis, tasks, pos, cos, draws,
  ] = await Promise.all([
    include.has("schedule") ? fetchSchedule(api, projectId, digest.contractValue) : Promise.resolve(undefined),
    include.has("unbilled_cos") && projectLookupOk ? fetchUnbilledCos(api, digest.name) : Promise.resolve(undefined),
    include.has("selections_vs_allowances") ? fetchSelectionsVsAllowances(api, projectId) : Promise.resolve(undefined),
    include.has("budget_vs_pos") ? fetchBudgetVsPos(api, projectId) : Promise.resolve(undefined),
    include.has("rfis") && projectLookupOk ? fetchRfis(api, digest.name) : Promise.resolve(undefined),
    include.has("tasks") && projectLookupOk ? fetchTasks(api, digest.name) : Promise.resolve(undefined),
    include.has("purchase_orders") && projectLookupOk ? fetchPOs(api, digest.name) : Promise.resolve(undefined),
    include.has("change_orders") && projectLookupOk ? fetchCOs(api, digest.name) : Promise.resolve(undefined),
    include.has("draws") ? fetchDraws(api, projectId) : Promise.resolve(undefined),
  ]);
  if (schedule === null) digest.errors.push("Schedule unavailable");
  else if (schedule !== undefined) digest.schedule = schedule;
  if (unbilledCos === null) digest.errors.push("Unbilled COs unavailable");
  else if (unbilledCos !== undefined) digest.unbilledCos = unbilledCos;
  if (sva === null) digest.errors.push("Selections-vs-allowances unavailable");
  else if (sva !== undefined) digest.selectionsVsAllowances = sva;
  if (bvp === null) digest.errors.push("Budget-vs-POs unavailable");
  else if (bvp !== undefined) digest.budgetVsPos = bvp;
  if (rfis === null) digest.errors.push("RFIs unavailable");
  else if (rfis !== undefined) digest.rfis = rfis;
  if (tasks === null) digest.errors.push("Tasks unavailable");
  else if (tasks !== undefined) digest.tasks = tasks;
  if (pos === null) digest.errors.push("POs unavailable");
  else if (pos !== undefined) digest.pos = pos;
  if (cos === null) digest.errors.push("Change orders unavailable");
  else if (cos !== undefined) digest.cos = cos;
  if (draws === null) digest.errors.push("Draws unavailable");
  else if (draws !== undefined) digest.draws = draws;

  return digest;
}

// PR #72: richer renderer — surface the project metadata that makes
// this a "real project summary" instead of just a what's-on-fire
// digest. Header now carries contract value + address + PMs, draws
// expand to full history + roll-up, change orders bucket by status.
function fmtUsd(n: number, decimals = 2): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function renderDigest(d: ProjectDigest): string {
  const lines: string[] = [];
  const teamSuffix = d.status !== undefined ? ` — _${teamLabel(d.status)} (${d.status})_` : "";
  lines.push(`## #${d.id} ${escapeMarkdownInline(d.name)}${teamSuffix}`);
  lines.push("");

  // === Project header metadata (PR #72) ===
  if (d.contractValueRaw || (d.contractValue && d.contractValue > 0)) {
    lines.push(`- **Contract value**: ${d.contractValueRaw ?? fmtUsd(d.contractValue ?? 0)}`);
  }
  const addressParts = [d.address, [d.city, d.state].filter(Boolean).join(", ")].filter(Boolean);
  if (addressParts.length > 0) {
    lines.push(`- **Address**: ${addressParts.map((p) => escapeMarkdownInline(p!)).join(" · ")}`);
  }
  if (d.managers) {
    lines.push(`- **Project managers**: ${escapeMarkdownInline(d.managers)}`);
  }

  // ====================================================================
  // PR #73 — Moss-actual sections (the things a PM actually checks)
  // ====================================================================

  // === Schedule / billing progress ===
  // Per Moss workflow: Draft FS = scheduled milestones; status flips to
  // Sent when the milestone is reached and billed. Last Sent/Paid anchors
  // current position; pending Drafts are upcoming milestones.
  if (d.schedule) {
    const sc = d.schedule;
    const pct = sc.pctBilled !== undefined ? ` (**${sc.pctBilled.toFixed(1)}%** of contract)` : "";
    lines.push("");
    lines.push(`### Schedule / billing progress`);
    lines.push(`- Billed (Sent + Paid): ${fmtUsd(sc.totalBilledExclDraft)}${pct} · received ${fmtUsd(sc.totalPaid)}`);
    if (sc.lastBilled) {
      lines.push(`- Last billed milestone: **${escapeMarkdownInline(sc.lastBilled.name)}** — ${fmtUsd(sc.lastBilled.amount)} — _${escapeMarkdownInline(sc.lastBilled.status)}_ on ${escapeMarkdownInline(sc.lastBilled.date)}`);
    }
    if (sc.pendingDrafts.length > 0) {
      lines.push(`- Pending milestones (Draft FS — verify each against the schedule before billing):`);
      for (const d of sc.pendingDrafts) {
        lines.push(`  - ${escapeMarkdownInline(d.name)} — ${fmtUsd(d.amount)}${d.date ? ` (scheduled ${escapeMarkdownInline(d.date)})` : ""}`);
      }
    } else {
      lines.push(`- No pending Draft FS — schedule is fully invoiced.`);
    }
  }

  // === Unbilled change orders ===
  if (d.unbilledCos) {
    const u = d.unbilledCos;
    lines.push("");
    lines.push(`### Change orders`);
    if (u.pendingApprovedCount === 0 && u.pendingCount === 0) {
      lines.push(`- No approved-unbilled or pending COs ✓`);
    } else {
      if (u.pendingApprovedCount > 0) {
        lines.push(`- **${u.pendingApprovedCount} approved CO(s) unbilled**, total ${fmtUsd(u.pendingApprovedTotal)} — should be added to an upcoming financial statement.`);
      } else {
        lines.push(`- All approved COs billed ✓ (approved total to date: ${fmtUsd(u.approvedTotal)})`);
      }
      if (u.pendingCount > 0) {
        lines.push(`- ${u.pendingCount} pending CO(s) totalling ${fmtUsd(u.pendingTotal)} — awaiting client approval.`);
      }
      for (const r of u.rows.slice(0, 6)) {
        lines.push(`  - _${escapeMarkdownInline(r.status)}_ ${escapeMarkdownInline(r.name.slice(0, 70))} — ${fmtUsd(r.total)}`);
      }
    }
  }

  // === Selections vs allowance budgets ===
  if (d.selectionsVsAllowances) {
    const items = d.selectionsVsAllowances.items;
    const over = items.filter((i) => i.status === "over");
    const under = items.filter((i) => i.status === "under");
    const none = items.filter((i) => i.status === "no-selections" && i.revisedBudget > 0);
    const match = items.filter((i) => i.status === "match");
    lines.push("");
    lines.push(`### Selections vs allowance budgets (${items.length} allowance categor${items.length === 1 ? "y" : "ies"})`);
    if (over.length === 0 && under.length === 0 && none.length === 0) {
      lines.push(`- All allowances are within budget ✓`);
    }
    for (const i of over) {
      lines.push(`- ⚠️ **${escapeMarkdownInline(i.categoryName)}**: revised ${fmtUsd(i.revisedBudget)}, ${i.selectionCount} selection(s) totalling ${fmtUsd(i.selectionsTotal)} — **over by ${fmtUsd(i.variance)}**`);
    }
    for (const i of under) {
      lines.push(`- _under_ **${escapeMarkdownInline(i.categoryName)}**: revised ${fmtUsd(i.revisedBudget)}, ${i.selectionCount} selection(s) totalling ${fmtUsd(i.selectionsTotal)} — $${Math.abs(i.variance).toFixed(2)} remaining`);
    }
    for (const i of none) {
      lines.push(`- _no selections yet_ **${escapeMarkdownInline(i.categoryName)}**: revised ${fmtUsd(i.revisedBudget)} — pending selections`);
    }
    if (match.length > 0) {
      lines.push(`- _${match.length} allowance categor${match.length === 1 ? "y" : "ies"} on budget_`);
    }
  }

  // === Budget vs PO over/under (only categories with a Sent PO) ===
  if (d.budgetVsPos) {
    const items = d.budgetVsPos.items;
    const over = items.filter((i) => i.status === "over");
    const under = items.filter((i) => i.status === "under");
    const match = items.filter((i) => i.status === "match");
    lines.push("");
    lines.push(`### Categories with POs — budget vs sent POs (${items.length} bought-out categor${items.length === 1 ? "y" : "ies"})`);
    if (items.length === 0) {
      lines.push(`- No categories have a Sent PO yet — buyouts not started.`);
    }
    for (const i of over) {
      const pct = isFinite(i.pctUsed) ? `${(i.pctUsed * 100).toFixed(0)}%` : "n/a";
      lines.push(`- ⚠️ **${escapeMarkdownInline(i.categoryName)}**: revised ${fmtUsd(i.revisedBudget)}, sent POs ${fmtUsd(i.sentPoTotal)} — **over by ${fmtUsd(i.variance)} (${pct})**`);
    }
    for (const i of under) {
      const pct = isFinite(i.pctUsed) ? `${(i.pctUsed * 100).toFixed(0)}%` : "n/a";
      lines.push(`- _under_ ${escapeMarkdownInline(i.categoryName)}: revised ${fmtUsd(i.revisedBudget)}, sent POs ${fmtUsd(i.sentPoTotal)} (${pct})`);
    }
    if (match.length > 0) {
      lines.push(`- _${match.length} categor${match.length === 1 ? "y" : "ies"} on budget_`);
    }
  }

  // ====================================================================
  // Legacy sections (off by default; emitted only when explicitly
  // requested via `include`).
  // ====================================================================
  if (d.rfis) {
    lines.push("");
    lines.push(`- **Open RFIs**: ${d.rfis.count}${d.rfis.count > 0 ? "" : " ✓"}`);
    if (d.rfis.lines.length > 0) lines.push(...d.rfis.lines);
  }
  if (d.tasks) {
    lines.push(`- **Open tasks**: ${d.tasks.count}${d.tasks.count > 0 ? "" : " ✓"}`);
    if (d.tasks.lines.length > 0) lines.push(...d.tasks.lines);
  }
  if (d.pos) {
    lines.push(`- **Open POs**: ${d.pos.count}${d.pos.totalApprox > 0 ? ` (~${fmtUsd(d.pos.totalApprox, 0)} total)` : ""}`);
    if (d.pos.lines.length > 0) lines.push(...d.pos.lines);
  }
  if (d.cos) {
    const breakdown = d.cos.byStatus ?? {};
    const statusKeys = Object.keys(breakdown).sort();
    if (statusKeys.length > 0) {
      const totalAll = statusKeys.reduce((s, k) => s + breakdown[k].count, 0);
      lines.push(`- **Change orders**: ${totalAll} total`);
      for (const key of statusKeys) {
        const entry = breakdown[key];
        const totalLabel = entry.total !== 0 ? ` (${fmtUsd(entry.total, 0)})` : "";
        lines.push(`  - _${escapeMarkdownInline(key)}_: ${entry.count}${totalLabel}`);
      }
    } else {
      lines.push(`- **Change orders**: 0`);
    }
    if (d.cos.lines.length > 0) {
      lines.push(`  Recent approved:`);
      lines.push(...d.cos.lines);
    }
  }
  if (d.draws) {
    const billPct = d.contractValue && d.contractValue > 0 && d.draws.totalBilled > 0
      ? ` — **${((d.draws.totalBilled / d.contractValue) * 100).toFixed(1)}%** of contract`
      : "";
    lines.push(
      `- **Draws**: ${d.draws.count} statement(s) — billed ${fmtUsd(d.draws.totalBilled)}` +
        ` · paid ${fmtUsd(d.draws.totalPaid)} · balance ${fmtUsd(d.draws.totalBalance)}` +
        billPct,
    );
    for (const s of d.draws.all) {
      const amount = fmtUsd(s.amount);
      const paid = s.paid > 0 ? ` · paid ${fmtUsd(s.paid)}` : "";
      const bal = s.balance !== 0 ? ` · bal ${fmtUsd(s.balance)}` : "";
      const date = s.date ? ` on ${escapeMarkdownInline(s.date)}` : "";
      lines.push(
        `  - ${escapeMarkdownInline(s.name)} — ${amount}${paid}${bal} — _${escapeMarkdownInline(s.status)}_${date}`,
      );
    }
  }
  if (d.errors.length > 0) {
    lines.push("");
    lines.push(`_Caveats: ${d.errors.join("; ")}_`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const projectStatusBriefTool: ToolDefinition = {
  name: "project_status_brief",
  description:
    "Read-only one-call project summary aligned to the Moss workflow. Returns four analysis sections per project plus the header (contract value, address, PMs, team):\n\n" +
    "1. **Schedule / billing progress** — financial statements broken down as Sent/Paid (already billed) vs Draft (scheduled milestones not yet reached or not yet sent). Highlights last billed milestone and lists pending Draft FS for the PM to verify against the physical schedule.\n" +
    "2. **Unbilled change orders** — approved COs that haven't been added to a financial statement yet (count + $ total) plus pending COs awaiting client approval.\n" +
    "3. **Selections vs allowance budgets** — for each allowance category, whether the team's selections roll up to within the revised budget. Flags over/under and categories awaiting selections.\n" +
    "4. **Budget vs Sent POs** — for each category that has at least one Sent PO (no PO = no buyout = budget undetermined per Moss workflow), revised budget vs PO total, flagging over-budget categories.\n\n" +
    "Pass EITHER `project_ids` (1-30 explicit IDs) OR `team` (filter active-team projects). Up to 30 projects per call. " +
    "Default `include` covers the four sections above; legacy sections (rfis, tasks, purchase_orders, change_orders, draws) are still accepted for backward compat but are NOT in the default set. No mutations.",
  inputSchema: zodToJsonSchema(ProjectStatusBriefSchema),
  permission: "read:projects",
  handler: async (rawArgs: unknown, api: BuildToolsAPI) => {
    const parsed = ProjectStatusBriefSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const messages = parsed.error.errors.map(
        (e) => `- \`${e.path.join(".") || "(root)"}\`: ${e.message}`,
      );
      return errorMarkdown(`**Invalid input for \`project_status_brief\`:**\n${messages.join("\n")}`);
    }
    const data = parsed.data;
    const include = new Set(
      data.include ?? ["schedule", "unbilled_cos", "selections_vs_allowances", "budget_vs_pos"],
    );

    // === Resolve project IDs ===
    let targetIds: number[];
    if (data.project_ids) {
      targetIds = data.project_ids;
    } else {
      const teamFilter = data.team!;
      const wantedCodes =
        teamFilter === "all_active" ? ACTIVE_TEAM_CODES : [TEAM_STATUS_MAP[teamFilter]];
      // Pull all active projects up to 200, filter client-side by
      // status code, then trim to `limit`.
      let allProjects: ProjectRow[] = [];
      try {
        const result = await api.getProjects<{ data: ProjectRow[] }>({
          length: 200,
        });
        allProjects = result?.data ?? [];
      } catch (err) {
        return errorMarkdown(
          `**Could not list projects**: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const matched = allProjects.filter((p) => {
        const code = Number(p.status_id ?? p.status);
        return Number.isFinite(code) && wantedCodes.includes(code);
      });
      const cap = data.limit ?? 10;
      targetIds = matched.slice(0, cap).map((p) => Number(p.id ?? (p.DT_RowId ?? "").replace(/^row_/, "")));
      targetIds = targetIds.filter((id) => Number.isFinite(id) && id > 0);
      if (targetIds.length === 0) {
        return markdown(
          `# Project status brief\n\nNo active projects matched filter \`team=${teamFilter}\`.`,
        );
      }
    }

    // === Fan out per project with bounded concurrency ===
    // PR #66 review HIGH 4: schema caps input at 30 projects, but
    // without an outer-loop limit each project then spawns 5 parallel
    // section fetches → up to 150 concurrent HTTPS connections to BT.
    // Laravel session-state servers race on session+cookie writes
    // under high fanout; rate limits / bot-detection also possible.
    // Cap outer concurrency at 5 (inner per-project 5-way fanout
    // unchanged → peak ~25 in-flight).
    const PROJECT_CONCURRENCY = 5;
    const digests: ProjectDigest[] = [];
    for (let i = 0; i < targetIds.length; i += PROJECT_CONCURRENCY) {
      const batch = targetIds.slice(i, i + PROJECT_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map((id) => buildProjectDigest(api, id, include)),
      );
      digests.push(...batchResults);
    }

    // === Compose ===
    const today = new Date().toISOString().slice(0, 10);
    const scopeLabel = data.project_ids
      ? `${digests.length} project(s) by id`
      : `team \`${data.team}\``;
    const header = `# Project status brief — ${scopeLabel} — ${today}\n`;
    const body = digests.map(renderDigest).join("\n\n");
    return markdown(`${header}\n${body}`);
  },
};

export const briefTools: ToolDefinition[] = [projectStatusBriefTool];
