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
        "schedule",         // PR #75: real BT schedule (working/published Gantt)
        "billing",          // PR #75: was `schedule` pre-#75 — FS-derived billing progress
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
   * Billing progress derived from financial statements (PR #75 rename;
   * was `schedule` pre-PR-#75). Per the Moss workflow: Draft FS =
   * milestones scheduled at project creation; status flips to Sent
   * when the milestone is reached and billed. Last Sent/Paid FS is
   * the "current position" anchor; pending Drafts are upcoming
   * milestones the PM must judge against the physical schedule.
   *
   * The NEW `schedule` field (below) carries the actual BT Gantt
   * schedule for that judgment.
   */
  billing?: {
    contractValue?: number;
    totalBilledExclDraft: number;
    totalPaid: number;
    pctBilled?: number;
    lastBilled?: { name: string; amount: number; status: string; date: string };
    pendingDrafts: Array<{ name: string; amount: number; date: string }>;
    fullHistory: Array<{ name: string; amount: number; paid: number; balance: number; status: string; date: string }>;
  };

  /**
   * PR #75: Real BT schedule (DHTMLX-Gantt format). Sourced from
   * `/schedule/working/data?projects=<id>`. Compares what was on the
   * schedule last week vs this week + flags overdue items.
   */
  schedule?: {
    totalTasks: number;
    activeLastWeek: Array<{ id: number; text: string; type: string; startDate: string; endDate: string; progress: number; budgetCategory?: string }>;
    activeThisWeek: Array<{ id: number; text: string; type: string; startDate: string; endDate: string; progress: number; budgetCategory?: string }>;
    upcomingNextWeek: Array<{ id: number; text: string; type: string; startDate: string; endDate: string; progress: number; budgetCategory?: string }>;
    overdue: Array<{ id: number; text: string; type: string; startDate: string; endDate: string; progress: number; budgetCategory?: string }>;
    // Window dates for the "last/this/next" boundaries.
    windowLastWeek: { start: string; end: string };
    windowThisWeek: { start: string; end: string };
    windowNextWeek: { start: string; end: string };
  };

  /**
   * Change orders + unbilled exposure.
   *
   * `unbilledGap` is the authoritative "unbilled" number (PR #76),
   * computed the same way as the standalone `find_unbilled_change_orders`
   * tool: contractValue (budget_revised) MINUS sum of all financial-
   * statement amounts (drafts + sent + paid). What's left = approved CO
   * value that hasn't been allocated to a draw yet.
   *
   * `pendingApprovedCount` / `pendingApprovedTotal` / `pendingCount` /
   * `pendingTotal` / `approvedTotal` are listed for context — they
   * describe the full CO landscape (counts + dollar values per status),
   * not the unbilled gap itself.
   */
  unbilledCos?: {
    unbilledGap: number;            // PR #76: contract value - sum of all FS amounts
    contractValue: number;
    totalAllStatements: number;
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

// PR #75: was fetchSchedule pre-rename — this is the FS-derived billing
// progress section. The new fetchSchedule (below) pulls the real BT
// Gantt schedule.
async function fetchBilling(
  api: BuildToolsAPI,
  projectId: number,
  contractValue?: number,
): Promise<ProjectDigest["billing"] | null> {
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

// PR #74: CO status enum from docs/BUSINESS_LOGIC.md
// 1=Draft, 2=Pending, 3=Approved, 4=Rejected (no string labels on the row).
const CO_STATUS_LABEL: Record<number, string> = {
  1: "Draft",
  2: "Pending",
  3: "Approved",
  4: "Rejected",
};

// PR #75: pull the real BT Gantt schedule and bucket tasks by:
//   - overdue (end before today, progress < 100%)
//   - active last week
//   - active this week
//   - upcoming next week
// Tasks "overlap" a window if [task.start, task.end] intersects
// [window.start, window.end]. DHTMLX rows don't carry end_date — we
// compute it as start_date + duration days.
// `weekStart` = the most recent Monday at 00:00 *as a date string*
// (no actual Date.now() — that's banned in workflows; we accept
// "today" in YYYY-MM-DD via the caller).
async function fetchSchedule(
  api: BuildToolsAPI,
  projectId: number,
  today: Date,
): Promise<ProjectDigest["schedule"] | null> {
  try {
    // PR #77: published schedule (client-visible, committed version) —
    // not working (editable draft). Per Moss workflow the published
    // view is the authoritative "what we've actually committed to"
    // timeline; working is an in-progress draft.
    const result = await api.getSchedule(projectId, "published");
    const tasks = result?.tasks ?? [];
    // Compute Monday of this week (ISO Monday → 1)
    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const today0 = startOfDay(today);
    const dow = today0.getDay(); // 0..6 (Sun..Sat)
    const offsetToMonday = (dow === 0 ? -6 : 1 - dow); // back to Monday
    const thisMonday = new Date(today0);
    thisMonday.setDate(thisMonday.getDate() + offsetToMonday);
    const thisSunday = new Date(thisMonday);
    thisSunday.setDate(thisSunday.getDate() + 6);
    const lastMonday = new Date(thisMonday); lastMonday.setDate(lastMonday.getDate() - 7);
    const lastSunday = new Date(thisMonday); lastSunday.setDate(lastSunday.getDate() - 1);
    const nextMonday = new Date(thisMonday); nextMonday.setDate(nextMonday.getDate() + 7);
    const nextSunday = new Date(nextMonday); nextSunday.setDate(nextSunday.getDate() + 6);
    const ymd = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    const enriched = tasks.map((t) => {
      const start = t.start_date ? new Date(t.start_date) : null;
      const duration = Number(t.duration ?? 0);
      const end = start
        ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + Math.max(duration - 1, 0))
        : null;
      const progress = Number(t.progress ?? 0);
      return {
        id: Number(t.id),
        text: stripHtml(String(t.text ?? "")),
        type: String(t.type ?? "task"),
        startDate: start ? ymd(start) : "",
        endDate: end ? ymd(end) : "",
        progress,
        budgetCategory: t.budget_category_full_name
          ? stripHtml(String(t.budget_category_full_name))
          : t.budget_category
            ? stripHtml(String(t.budget_category))
            : undefined,
        _start: start,
        _end: end,
      };
    });

    const overlaps = (taskStart: Date | null, taskEnd: Date | null, winStart: Date, winEnd: Date) => {
      if (!taskStart || !taskEnd) return false;
      return taskStart <= winEnd && taskEnd >= winStart;
    };

    // PR #75 v2: DHTMLX uses type="project" for both the root row AND any
    // task that has children (phase groupings like "Foundation",
    // "Framing"). Naively filtering `type !== "project"` drops the phase
    // headers we want to surface. Exclude ONLY the top-level row instead
    // (parent is null/0/undefined and duration spans the project life).
    // Also drop the synthetic "duration child" placeholder BT sometimes
    // injects (id starts with "c" and text contains "=> duration child").
    const filtered = enriched.filter((t) => {
      const raw = tasks.find((x) => Number(x.id) === t.id);
      const parent = raw?.parent as unknown;
      if (parent == null || String(parent) === "0") return false;
      if (String(raw?.id ?? "").startsWith("c") && t.text.includes("=> duration child")) return false;
      return true;
    });

    const activeLastWeek = filtered.filter((t) => overlaps(t._start, t._end, lastMonday, lastSunday));
    const activeThisWeek = filtered.filter((t) => overlaps(t._start, t._end, thisMonday, thisSunday));
    const upcomingNextWeek = filtered.filter((t) => overlaps(t._start, t._end, nextMonday, nextSunday));
    const overdue = filtered.filter(
      (t) => t._end && t._end < thisMonday && t.progress < 0.999,
    );

    const strip = ({ _start: _s, _end: _e, ...rest }: typeof filtered[number]) => rest;

    return {
      totalTasks: filtered.length,
      activeLastWeek: activeLastWeek.map(strip),
      activeThisWeek: activeThisWeek.map(strip),
      upcomingNextWeek: upcomingNextWeek.map(strip),
      overdue: overdue.map(strip),
      windowLastWeek: { start: ymd(lastMonday), end: ymd(lastSunday) },
      windowThisWeek: { start: ymd(thisMonday), end: ymd(thisSunday) },
      windowNextWeek: { start: ymd(nextMonday), end: ymd(nextSunday) },
    };
  } catch (err) {
    process.stderr.write(
      `[project_status_brief] schedule fetch failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

async function fetchUnbilledCos(
  api: BuildToolsAPI,
  projectId: number,
  contractValue: number,
): Promise<ProjectDigest["unbilledCos"] | null> {
  try {
    // PR #76: the AUTHORITATIVE unbilled number is the project-level
    // gap, computed the same way `find_unbilled_change_orders` does it:
    //   unbilled = contract value (budget_revised) - sum(all FS amounts)
    // Approved CO value lands on a financial statement when it gets
    // billed; whatever's left in the gap is approved CO value waiting
    // for a draw. Fetch in parallel with the CO list (which provides
    // supporting per-CO context).
    const [coResult, fs] = await Promise.all([
      api.getChangeOrders<{ data: Record<string, unknown>[] }>({
        "PR[]": String(projectId),
        length: 200,
      }),
      api.getFinancialStatements(projectId),
    ]);
    const rows = coResult?.data ?? [];
    const round = (n: number) => Math.round(n * 100) / 100;
    const statusNum = (r: Record<string, unknown>) => Number(r.status);
    const approved = rows.filter((r) => statusNum(r) === 3);
    const pending = rows.filter((r) => statusNum(r) === 2);
    const draft = rows.filter((r) => statusNum(r) === 1);
    const approvedTotal = round(approved.reduce((a, r) => a + parseDollarAmount(r.total), 0));
    const pendingTotal = round(pending.reduce((a, r) => a + parseDollarAmount(r.total), 0));
    const draftTotal = round(draft.reduce((a, r) => a + parseDollarAmount(r.total), 0));
    const fmtRow = (r: Record<string, unknown>) => ({
      name: stripHtml((r.name as string | undefined) ?? "(unnamed CO)"),
      status: CO_STATUS_LABEL[statusNum(r)] ?? `status ${statusNum(r)}`,
      total: parseDollarAmount(r.total),
    });
    const totalAllStatements = round(
      (fs?.statements ?? []).reduce(
        (a, s) => a + (typeof s.amount === "number" ? s.amount : 0),
        0,
      ),
    );
    const unbilledGap = round(contractValue - totalAllStatements);
    return {
      unbilledGap,
      contractValue: round(contractValue),
      totalAllStatements,
      pendingApprovedCount: approved.length,
      pendingApprovedTotal: approvedTotal,
      pendingCount: pending.length + draft.length,
      pendingTotal: pendingTotal + draftTotal,
      approvedTotal,
      rows: [...approved, ...pending, ...draft].map(fmtRow),
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
  prefetchedBudget?: Awaited<ReturnType<BuildToolsAPI["getBudget"]>>,
): Promise<ProjectDigest["selectionsVsAllowances"] | null> {
  try {
    // PR #75: budget is fetched ONCE in buildProjectDigest and passed
    // through; eliminates the double-getBudget called out in PR #73
    // review LOW. Falls back to fetching if not provided.
    const [budget, sel] = await Promise.all([
      prefetchedBudget ? Promise.resolve(prefetchedBudget) : api.getBudget(projectId),
      api.getSelections(projectId),
    ]);
    const allowances = (budget?.items ?? []).filter((i) => i.isAllowance);
    const round = (n: number) => Math.round(n * 100) / 100;
    // PR #73 review MEDIUM fix: only count selections that have actually
    // been priced or marked as selected. Open/Unselected rows with no
    // price would otherwise inflate the count to non-zero with $0 total,
    // flipping the status from "no-selections" to "under" and misleading
    // the PM into thinking selections are in progress when nothing is
    // priced yet. A selection counts if it has a non-zero price OR its
    // statusCode is >= 2 (Selected / Approved / Purchased).
    const selectionsByCategory = new Map<string, { total: number; count: number }>();
    for (const s of sel?.selections ?? []) {
      const cat = s.category ?? "";
      const price = parseDollarAmount(s.price);
      const hasMeaningfulStatus = (s.statusCode ?? 0) >= 2;
      if (price <= 0 && !hasMeaningfulStatus) continue;
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
  prefetchedBudget?: Awaited<ReturnType<BuildToolsAPI["getBudget"]>>,
): Promise<ProjectDigest["budgetVsPos"] | null> {
  try {
    const budget = prefetchedBudget ?? (await api.getBudget(projectId));
    const round = (n: number) => Math.round(n * 100) / 100;
    // PR #73 review MEDIUM fix: look up the SENT PO'S column index from
    // the columns header dynamically rather than hardcoding cells[9].
    // If BT reorders columns the prior hardcode silently mismeasures.
    // Falls back to index 9 (verified live 2026-06-27) when the header
    // is absent or doesn't match.
    const FALLBACK_INDEX = 9;
    const SENT_POS_CELL_INDEX = (() => {
      const idx = (budget?.columns ?? []).findIndex(
        (c) => c.toUpperCase().replace(/[’']/g, "'") === "SENT PO'S",
      );
      return idx >= 0 ? idx : FALLBACK_INDEX;
    })();
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
  today_?: Date,
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
  // PR #75: caller's "today" is captured here so the schedule windowing
  // is reproducible inside tests. Default to NOW at digest time.
  const today = today_ ?? new Date();

  // PR #75: hoist budget fetch out of fetchSelectionsVsAllowances +
  // fetchBudgetVsPos (deduplication; fixes PR #73 review LOW), and use
  // it to PRIME the BT session for the schedule endpoint. Live probe
  // 2026-06-28 confirmed: /schedule/working/data only returns the full
  // task list AFTER /budget has been requested for the project. Without
  // priming the schedule endpoint returns just a project-root stub.
  const wantsBudget =
    include.has("selections_vs_allowances") ||
    include.has("budget_vs_pos") ||
    include.has("schedule");
  let prefetchedBudget: Awaited<ReturnType<BuildToolsAPI["getBudget"]>> | undefined;
  if (wantsBudget) {
    try {
      prefetchedBudget = await api.getBudget(projectId);
    } catch (err) {
      process.stderr.write(
        `[project_status_brief] budget prefetch failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  const [
    schedule, billing, unbilledCos, sva, bvp,
    rfis, tasks, pos, cos, draws,
  ] = await Promise.all([
    include.has("schedule") ? fetchSchedule(api, projectId, today) : Promise.resolve(undefined),
    include.has("billing") ? fetchBilling(api, projectId, digest.contractValue) : Promise.resolve(undefined),
    // PR #74: now project-id scoped (was name-based which BT didn't honor).
    // PR #76: needs contractValue to compute the budget_revised - sum(FS) gap.
    include.has("unbilled_cos") ? fetchUnbilledCos(api, projectId, digest.contractValue ?? 0) : Promise.resolve(undefined),
    include.has("selections_vs_allowances") ? fetchSelectionsVsAllowances(api, projectId, prefetchedBudget) : Promise.resolve(undefined),
    include.has("budget_vs_pos") ? fetchBudgetVsPos(api, projectId, prefetchedBudget) : Promise.resolve(undefined),
    include.has("rfis") && projectLookupOk ? fetchRfis(api, digest.name) : Promise.resolve(undefined),
    include.has("tasks") && projectLookupOk ? fetchTasks(api, digest.name) : Promise.resolve(undefined),
    include.has("purchase_orders") && projectLookupOk ? fetchPOs(api, digest.name) : Promise.resolve(undefined),
    include.has("change_orders") && projectLookupOk ? fetchCOs(api, digest.name) : Promise.resolve(undefined),
    include.has("draws") ? fetchDraws(api, projectId) : Promise.resolve(undefined),
  ]);
  if (schedule === null) digest.errors.push("Schedule unavailable");
  else if (schedule !== undefined) digest.schedule = schedule;
  if (billing === null) digest.errors.push("Billing unavailable");
  else if (billing !== undefined) digest.billing = billing;
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
    // PR #73 review LOW fix: contractValueRaw stripped HTML but didn't
    // escape markdown metacharacters — every other BT-sourced string in
    // this renderer goes through escapeMarkdownInline. Bring this in line.
    const rendered = d.contractValueRaw ? escapeMarkdownInline(d.contractValueRaw) : fmtUsd(d.contractValue ?? 0);
    lines.push(`- **Contract value**: ${rendered}`);
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

  // === Schedule (PR #75): the actual BT Gantt schedule ===
  if (d.schedule) {
    const s = d.schedule;
    lines.push("");
    lines.push(`### Schedule — last week vs this week`);
    lines.push(`- ${s.totalTasks} task(s) on the published schedule.`);
    const renderTask = (t: typeof s.activeThisWeek[number]) => {
      const cat = t.budgetCategory ? ` _(${escapeMarkdownInline(t.budgetCategory)})_` : "";
      const pct = t.progress > 0 ? ` · ${Math.round(t.progress * 100)}%` : "";
      const span = t.startDate === t.endDate ? t.startDate : `${t.startDate} → ${t.endDate}`;
      return `  - ${escapeMarkdownInline(t.text)} — ${span}${pct}${cat}`;
    };
    // Overdue first — anything ending before this Monday with progress < 100%.
    if (s.overdue.length > 0) {
      lines.push(`- ⚠️ **${s.overdue.length} overdue** task(s) (ended before ${s.windowThisWeek.start} with progress < 100%):`);
      for (const t of s.overdue.slice(0, 10)) lines.push(renderTask(t));
      if (s.overdue.length > 10) lines.push(`  - … ${s.overdue.length - 10} more`);
    }
    // Last week
    lines.push(`- Last week (${s.windowLastWeek.start} → ${s.windowLastWeek.end}): ${s.activeLastWeek.length} task(s)`);
    for (const t of s.activeLastWeek.slice(0, 8)) lines.push(renderTask(t));
    if (s.activeLastWeek.length > 8) lines.push(`  - … ${s.activeLastWeek.length - 8} more`);
    // This week
    lines.push(`- This week (${s.windowThisWeek.start} → ${s.windowThisWeek.end}): ${s.activeThisWeek.length} task(s)`);
    for (const t of s.activeThisWeek.slice(0, 8)) lines.push(renderTask(t));
    if (s.activeThisWeek.length > 8) lines.push(`  - … ${s.activeThisWeek.length - 8} more`);
    // Next week peek
    if (s.upcomingNextWeek.length > 0) {
      lines.push(`- Next week (${s.windowNextWeek.start} → ${s.windowNextWeek.end}): ${s.upcomingNextWeek.length} task(s)`);
      for (const t of s.upcomingNextWeek.slice(0, 5)) lines.push(renderTask(t));
      if (s.upcomingNextWeek.length > 5) lines.push(`  - … ${s.upcomingNextWeek.length - 5} more`);
    }
  }

  // === Billing progress (PR #75: renamed from `schedule`) ===
  // Per Moss workflow: Draft FS = scheduled milestones; status flips to
  // Sent when the milestone is reached and billed. Last Sent/Paid anchors
  // current position; pending Drafts are upcoming milestones.
  if (d.billing) {
    const sc = d.billing;
    const pct = sc.pctBilled !== undefined ? ` (**${sc.pctBilled.toFixed(1)}%** of contract)` : "";
    lines.push("");
    lines.push(`### Billing progress (financial statements)`);
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

  // === Change orders ===
  // PR #76: lead with the AUTHORITATIVE unbilled gap (same calc as the
  // standalone find_unbilled_change_orders tool: contract value minus
  // sum of all financial-statement amounts). Per-CO list is supporting
  // context — the gap is what the PM acts on.
  if (d.unbilledCos) {
    const u = d.unbilledCos;
    lines.push("");
    lines.push(`### Change orders & unbilled exposure`);
    if (u.unbilledGap > 0.01) {
      lines.push(
        `- ⚠️ **${fmtUsd(u.unbilledGap)} unbilled** = contract value ${fmtUsd(u.contractValue)} − financial statements (drafts + sent + paid) ${fmtUsd(u.totalAllStatements)}. This much approved CO value is not yet on any draw.`,
      );
    } else if (u.unbilledGap < -0.01) {
      lines.push(
        `- _Overbilled by ${fmtUsd(Math.abs(u.unbilledGap))}_ — financial statements (${fmtUsd(u.totalAllStatements)}) exceed contract value (${fmtUsd(u.contractValue)}). Worth verifying with accounting.`,
      );
    } else {
      lines.push(
        `- Fully allocated ✓ — financial statements (${fmtUsd(u.totalAllStatements)}) match contract value (${fmtUsd(u.contractValue)}).`,
      );
    }
    if (u.pendingApprovedCount === 0 && u.pendingCount === 0) {
      lines.push(`- No approved or pending COs on file.`);
    } else {
      if (u.pendingApprovedCount > 0) {
        lines.push(
          `- ${u.pendingApprovedCount} approved CO(s) on file, total ${fmtUsd(u.approvedTotal)}.`,
        );
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
    "1. **Schedule** — the actual BT published Gantt schedule (the client-visible, committed timeline), bucketed by week: overdue tasks (ended before this Monday with <100% progress), last week's tasks, this week's tasks, and a peek at next week.\n" +
    "2. **Billing progress** — financial statements broken down as Sent/Paid (already billed) vs Draft (scheduled milestones not yet reached or not yet sent). Highlights last billed milestone and lists pending Draft FS for the PM to verify against the physical schedule.\n" +
    "3. **Change orders & unbilled exposure** — the authoritative unbilled $ figure computed as contract value (budget_revised) minus the sum of all financial-statement amounts (drafts + sent + paid), matching `find_unbilled_change_orders`. Plus per-CO list (approved + pending).\n" +
    "4. **Selections vs allowance budgets** — for each allowance category, whether the team's selections roll up to within the revised budget. Flags over/under and categories awaiting selections.\n" +
    "5. **Budget vs Sent POs** — for each category that has at least one Sent PO (no PO = no buyout = budget undetermined per Moss workflow), revised budget vs PO total, flagging over-budget categories.\n\n" +
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
      data.include ?? ["schedule", "billing", "unbilled_cos", "selections_vs_allowances", "budget_vs_pos"],
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
