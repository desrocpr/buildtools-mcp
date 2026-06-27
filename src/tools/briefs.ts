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
    .array(z.enum(["rfis", "tasks", "purchase_orders", "change_orders", "draws"]))
    .optional()
    .describe(
      "Which sections to include per project. Default: all five. Set explicitly to trim the digest.",
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
  // Populated on the same getProject call that fetches the name/status.
  contractValue?: number;        // numeric for math; rendered as currency
  contractValueRaw?: string;     // BT's pre-formatted string (e.g. "$ 665,124.94")
  address?: string;
  city?: string;
  state?: string;
  managers?: string;             // comma-separated PM names (from the row)
  rfis?: { count: number; lines: string[] };
  tasks?: { count: number; lines: string[] };
  pos?: { count: number; totalApprox: number; lines: string[] };
  cos?: { count: number; totalApprox: number; lines: string[]; byStatus?: Record<string, { count: number; total: number }> };
  // PR #72: full draws history (was just lastTwo) so callers see the
  // billing trajectory. Includes running totals + paid/balance roll-up.
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

  // Parallel per-section fetches. Name-based sections (rfis/tasks/
  // pos/cos) are SKIPPED when the project lookup failed — they'd
  // produce misleading zeros otherwise. `draws` uses the project id
  // directly so it can still run.
  const [rfis, tasks, pos, cos, draws] = await Promise.all([
    include.has("rfis") && projectLookupOk ? fetchRfis(api, digest.name) : Promise.resolve(undefined),
    include.has("tasks") && projectLookupOk ? fetchTasks(api, digest.name) : Promise.resolve(undefined),
    include.has("purchase_orders") && projectLookupOk ? fetchPOs(api, digest.name) : Promise.resolve(undefined),
    include.has("change_orders") && projectLookupOk ? fetchCOs(api, digest.name) : Promise.resolve(undefined),
    include.has("draws") ? fetchDraws(api, projectId) : Promise.resolve(undefined),
  ]);
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

  // === Open RFIs ===
  if (d.rfis) {
    lines.push(`- **Open RFIs**: ${d.rfis.count}${d.rfis.count > 0 ? "" : " ✓"}`);
    if (d.rfis.lines.length > 0) lines.push(...d.rfis.lines);
  }
  // === Open tasks ===
  if (d.tasks) {
    lines.push(`- **Open tasks**: ${d.tasks.count}${d.tasks.count > 0 ? "" : " ✓"}`);
    if (d.tasks.lines.length > 0) lines.push(...d.tasks.lines);
  }
  // === POs ===
  if (d.pos) {
    lines.push(
      `- **Open POs**: ${d.pos.count}${d.pos.totalApprox > 0 ? ` (~${fmtUsd(d.pos.totalApprox, 0)} total)` : ""}`,
    );
    if (d.pos.lines.length > 0) lines.push(...d.pos.lines);
  }
  // === Change orders by status (PR #72) ===
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
  // === Draws (full history + roll-up; PR #72) ===
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
    "Read-only one-call project summary. For each project, returns: " +
    "project header (contract value, address, project managers, team), " +
    "open RFIs (priority-sorted, top 3), open tasks (past-due first, top 3), " +
    "open POs (count + $ total), change orders bucketed by status (Pending / Approved / Rejected / etc. with $ impact per bucket), " +
    "and the FULL draws history with billed/paid/balance roll-up + percent of contract billed. " +
    "Pass EITHER `project_ids` (1-30 explicit IDs) OR `team` (filter active-team projects). Up to 30 projects per call. " +
    "Sections can be trimmed via `include` to skip per-section fetches. No mutations.",
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
      data.include ?? ["rfis", "tasks", "purchase_orders", "change_orders", "draws"],
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
