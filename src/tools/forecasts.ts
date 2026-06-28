/**
 * Cash-flow forecast tool (PR #78).
 *
 * Projects expected revenue (in dollars) over the next N weeks / months /
 * quarters by joining Draft financial statements to the published
 * schedule via name match, then bucketing by the schedule task's end
 * date. Sent-but-unpaid FS bucket immediately as receivables.
 *
 * Inputs scope the projection to either an explicit project list, a
 * single team, or all active teams (= company-wide rollup). Output is a
 * markdown table with per-bucket totals plus per-project and per-team
 * subtotals.
 *
 * Confidence framing (per user 2026-06-28):
 *   - Sent-unpaid: high confidence — already billed
 *   - Matched Draft FS: medium — depends on schedule keeping pace
 *   - Unmatched Draft FS: surfaced separately so the PM can review
 *
 * Payment-lag prediction (Sent → Paid days) is deferred — a future
 * version could shift Sent-unpaid into a later bucket using historical
 * portfolio data.
 */

import { z } from "zod/v3";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { BuildToolsAPI } from "../client/BuildToolsAPI.js";

import type { ToolDefinition, ToolResult } from "./projects.js";

// ---------------------------------------------------------------------------
// Markdown helpers (mirrors briefs.ts; duplicated to keep modules independent)
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

function parseDollarAmount(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && v !== "-") {
    const n = Number(v.replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function fmtUsd(n: number, decimals = 0): string {
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
// Input schema
// ---------------------------------------------------------------------------

// PR #79: per-granularity horizon caps. Single max of 52 was awkward
// (52 weeks = 1 year, 52 months ≈ 4 years, 52 quarters = 13 years —
// the quarterly case in particular was absurd). The per-granularity
// caps below align horizons to "what a PM would actually want to see":
const HORIZON_MAX: Record<"weekly" | "monthly" | "quarterly", number> = {
  weekly: 52,    // 1 year
  monthly: 24,   // 2 years
  quarterly: 8,  // 2 years
};

const CashFlowForecastSchema = z.object({
  project_ids: z
    .array(z.number().int().positive())
    .min(1)
    .max(200)
    .optional()
    .describe("Explicit project IDs to forecast (1-200). Mutually exclusive with `team`."),
  team: z
    .enum(["Nexus", "Omega", "Invicta", "Alpha", "all_active"])
    .optional()
    .describe(
      "Filter active-team projects. `all_active` rolls up all four teams (statuses 5-8) — the company-wide view. Mutually exclusive with `project_ids`.",
    ),
  granularity: z
    .enum(["weekly", "monthly", "quarterly"])
    .default("monthly")
    .describe("Bucket size for the forecast table."),
  horizon_periods: z
    .number()
    .int()
    .min(1)
    .max(52)  // outer ceiling; per-granularity cap enforced via refine below
    .optional()
    .describe(
      "How many periods forward to forecast. Per-granularity max: weekly=52 (1yr), monthly=24 (2yr), quarterly=8 (2yr). Defaults: weekly=12, monthly=6, quarterly=4.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "When `team` is set, cap the number of projects fetched. Default 100, max 200. Concurrency is internally throttled to 5 in-flight, so larger caps mainly affect wall-clock time, not BT burst load.",
    ),
})
  .refine(
    (data) => (data.project_ids === undefined) !== (data.team === undefined),
    {
      message: "Exactly one of `project_ids` or `team` must be provided.",
      path: ["project_ids"],
    },
  )
  .refine(
    (data) => {
      if (data.horizon_periods === undefined) return true;
      const max = HORIZON_MAX[data.granularity];
      return data.horizon_periods <= max;
    },
    (data) => ({
      message: `horizon_periods exceeds ${HORIZON_MAX[data.granularity]} for granularity=${data.granularity} (weekly max 52, monthly max 24, quarterly max 8)`,
      path: ["horizon_periods"],
    }),
  );
type CashFlowForecastArgs = z.infer<typeof CashFlowForecastSchema>;

// ---------------------------------------------------------------------------
// Date helpers (bucket keys)
// ---------------------------------------------------------------------------

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function isoWeekMonday(d: Date): Date {
  const d0 = startOfDay(d);
  const dow = d0.getDay(); // 0..6 (Sun..Sat)
  const offset = dow === 0 ? -6 : 1 - dow;
  const m = new Date(d0);
  m.setDate(m.getDate() + offset);
  return m;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function bucketKey(date: Date, granularity: "weekly" | "monthly" | "quarterly"): string {
  if (granularity === "weekly") return ymd(isoWeekMonday(date));
  if (granularity === "monthly") {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }
  // quarterly
  const q = Math.floor(date.getMonth() / 3) + 1;
  return `${date.getFullYear()}-Q${q}`;
}

function* iterBuckets(
  start: Date,
  granularity: "weekly" | "monthly" | "quarterly",
  count: number,
): Generator<{ key: string; label: string; start: Date }> {
  for (let i = 0; i < count; i++) {
    let bucketStart: Date;
    if (granularity === "weekly") {
      bucketStart = isoWeekMonday(start);
      bucketStart.setDate(bucketStart.getDate() + i * 7);
      yield { key: ymd(bucketStart), label: ymd(bucketStart), start: bucketStart };
    } else if (granularity === "monthly") {
      bucketStart = new Date(start.getFullYear(), start.getMonth() + i, 1);
      const key = `${bucketStart.getFullYear()}-${String(bucketStart.getMonth() + 1).padStart(2, "0")}`;
      const label = bucketStart.toLocaleString("en-US", { month: "short", year: "numeric" });
      yield { key, label, start: bucketStart };
    } else {
      const baseQ = Math.floor(start.getMonth() / 3);
      const qIdx = baseQ + i;
      bucketStart = new Date(start.getFullYear(), qIdx * 3, 1);
      const q = Math.floor(bucketStart.getMonth() / 3) + 1;
      const key = `${bucketStart.getFullYear()}-Q${q}`;
      yield { key, label: key, start: bucketStart };
    }
  }
}

// ---------------------------------------------------------------------------
// Name match: Draft FS name → schedule task
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "progress", "payment", "pp", "draw", "the", "and", "of", "to", "for",
  "a", "an", "phase", "approved",
]);

function tokensFromDraftName(name: string): string[] {
  // PR #78 normalization handles Moss FS naming conventions:
  //   "Progress Payment 5 - 30% Due at construction start (Minus Deposit)"
  //   "Progress Payment #4 - Due at county building permit approval"
  //   "Construction Start"
  //   "PP6 — Kitchen countertop template"
  let s = name;
  // Strip "Progress Payment [#]?N -" / "PP N -" / "Draw N -" prefix
  s = s.replace(/^\s*(progress\s*paymen?t|payment|pp|draw|prgoress\s*payment)\s*#?\s*\d+\s*[-:—]?\s*/i, "");
  // Strip the "X% Due at " or "Due at " prefix that gates milestone language
  s = s.replace(/^\s*\d+(?:\.\d+)?\s*%?\s*due\s+at\s+/i, "");
  s = s.replace(/^\s*due\s+at\s+/i, "");
  // Drop trailing parentheticals — "(Minus Deposit)", "(Minus Initial Deposit)"
  s = s.replace(/\([^)]*\)/g, " ");
  return tokenize(s);
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t) && t.length > 1);
}

interface ScheduleTaskRef {
  text: string;
  endDate: Date;
}

function nameMatch(
  draftName: string,
  tasks: ScheduleTaskRef[],
): { task: ScheduleTaskRef; confidence: number } | null {
  const draftTokens = new Set(tokensFromDraftName(draftName));
  if (draftTokens.size === 0) return null;
  let best: { task: ScheduleTaskRef; confidence: number } | null = null;
  for (const t of tasks) {
    const taskTokens = new Set(tokenize(t.text));
    if (taskTokens.size === 0) continue;
    // Jaccard similarity
    let intersection = 0;
    for (const tok of draftTokens) if (taskTokens.has(tok)) intersection++;
    if (intersection === 0) continue;
    const union = draftTokens.size + taskTokens.size - intersection;
    const jaccard = intersection / union;
    // Bias slightly toward tasks that contain ALL draft tokens (subset match)
    let confidence = jaccard;
    if (intersection === draftTokens.size) confidence += 0.15;
    if (!best || confidence > best.confidence) best = { task: t, confidence };
  }
  if (!best || best.confidence < 0.35) return null;
  return best;
}

// ---------------------------------------------------------------------------
// Per-project forecast
// ---------------------------------------------------------------------------

interface ProjectForecast {
  id: number;
  name: string;
  team: number;
  contractValue: number;
  /** Sent FS amount minus paid — already-billed AR, expected near-term. */
  sentUnpaid: number;
  /** Total of matched Draft FS amounts (sums what's in the buckets). */
  matchedTotal: number;
  /** Total of Draft FS that didn't match a schedule task. */
  unmatchedTotal: number;
  /** Bucket key → total $ inflow projected for that bucket. */
  buckets: Map<string, number>;
  /** Diagnostics: per-Draft match details. */
  matched: Array<{
    draftName: string;
    amount: number;
    matchedTask: string;
    matchDate: string;
    bucket: string;
    confidence: number;
  }>;
  unmatched: Array<{ draftName: string; amount: number }>;
  errors: string[];
}

type ProjectRow = {
  id?: number | string;
  DT_RowId?: string;
  name?: string;
  status_id?: string | number;
  status?: string | number;
  budget_revised?: string;
};

async function buildProjectForecast(
  api: BuildToolsAPI,
  projectId: number,
  granularity: "weekly" | "monthly" | "quarterly",
): Promise<ProjectForecast | null> {
  const forecast: ProjectForecast = {
    id: projectId,
    name: `#${projectId}`,
    team: 0,
    contractValue: 0,
    sentUnpaid: 0,
    matchedTotal: 0,
    unmatchedTotal: 0,
    buckets: new Map(),
    matched: [],
    unmatched: [],
    errors: [],
  };

  // 1. Project header — name, team, contract value
  try {
    const project = await api.getProject<ProjectRow>(projectId);
    if (project) {
      forecast.name = stripHtml(String(project.name ?? `#${projectId}`));
      const statusCode = Number(project.status_id ?? project.status);
      if (Number.isFinite(statusCode)) forecast.team = statusCode;
      forecast.contractValue = parseDollarAmount(project.budget_revised);
    } else {
      forecast.errors.push(`project ${projectId} unavailable`);
      return forecast;
    }
  } catch {
    forecast.errors.push(`project ${projectId} unavailable`);
    return forecast;
  }

  // 2. Prime schedule session-state with /budget (required, per PR #75).
  try {
    await api.getBudget(projectId);
  } catch (err) {
    // Non-fatal — schedule may still work; record the issue if it doesn't.
    process.stderr.write(
      `[cash_flow_forecast] budget prime failed for ${projectId}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  // 3. Parallel: FS + schedule.
  //    PR #78 v2: published schedule is the authoritative committed
  //    timeline, but projects mid-design may not have one published yet.
  //    Fall back to working schedule when published returns empty so
  //    we don't drop those projects' Drafts to "unscheduled" entirely.
  const [fsResult, publishedResult] = await Promise.all([
    api.getFinancialStatements(projectId).catch(() => null),
    api.getSchedule(projectId, "published").catch(() => null),
  ]);
  if (fsResult === null) forecast.errors.push("financial statements unavailable");
  let scheduleResult = publishedResult;
  if (!scheduleResult?.tasks || scheduleResult.tasks.length <= 1) {
    // Empty / stub published — try working as fallback.
    scheduleResult = await api.getSchedule(projectId, "working").catch(() => null);
    if (scheduleResult?.tasks && scheduleResult.tasks.length > 1) {
      forecast.errors.push("using working schedule (no published)");
    }
  }
  if (!scheduleResult) forecast.errors.push("schedule unavailable");
  const statements = fsResult?.statements ?? [];
  const tasks = scheduleResult?.tasks ?? [];

  // 4. Build schedule task index — only leaf tasks (parent != null/0).
  //    Compute end date as start + max(duration-1, 0) days.
  const scheduleTaskRefs: ScheduleTaskRef[] = [];
  for (const t of tasks) {
    const parent = (t as Record<string, unknown>).parent;
    if (parent == null || String(parent) === "0") continue;
    if (!t.start_date) continue;
    const start = new Date(t.start_date);
    if (Number.isNaN(start.getTime())) continue;
    const dur = Number(t.duration ?? 0);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + Math.max(dur - 1, 0));
    const text = stripHtml(String(t.text ?? ""));
    if (!text) continue;
    scheduleTaskRefs.push({ text, endDate: end });
  }

  // 5. Sent-unpaid → near-term AR (bucket: nothing — surfaced separately)
  for (const s of statements) {
    const status = stripHtml(s.status ?? "").toLowerCase();
    if (status === "sent") {
      const amount = typeof s.amount === "number" ? s.amount : 0;
      const paid = typeof s.paid === "number" ? s.paid : 0;
      forecast.sentUnpaid += Math.max(amount - paid, 0);
    }
  }

  // 6. Draft FS → match to schedule → bucket
  for (const s of statements) {
    const status = stripHtml(s.status ?? "").toLowerCase();
    if (status !== "draft") continue;
    const amount = typeof s.amount === "number" ? s.amount : 0;
    if (amount <= 0) continue;
    const name = stripHtml(s.name ?? "(unnamed draft)");
    const match = nameMatch(name, scheduleTaskRefs);
    if (!match) {
      forecast.unmatched.push({ draftName: name, amount });
      forecast.unmatchedTotal += amount;
      continue;
    }
    const key = bucketKey(match.task.endDate, granularity);
    forecast.buckets.set(key, (forecast.buckets.get(key) ?? 0) + amount);
    forecast.matchedTotal += amount;
    forecast.matched.push({
      draftName: name,
      amount,
      matchedTask: match.task.text,
      matchDate: ymd(match.task.endDate),
      bucket: key,
      confidence: Math.round(match.confidence * 100) / 100,
    });
  }
  // Round per-bucket
  for (const [k, v] of forecast.buckets) forecast.buckets.set(k, Math.round(v * 100) / 100);
  forecast.matchedTotal = Math.round(forecast.matchedTotal * 100) / 100;
  forecast.unmatchedTotal = Math.round(forecast.unmatchedTotal * 100) / 100;
  forecast.sentUnpaid = Math.round(forecast.sentUnpaid * 100) / 100;
  return forecast;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

function renderForecast(
  forecasts: ProjectForecast[],
  granularity: "weekly" | "monthly" | "quarterly",
  bucketKeys: Array<{ key: string; label: string }>,
  scopeLabel: string,
): string {
  const lines: string[] = [];
  lines.push(`# Cash flow forecast — ${escapeMarkdownInline(scopeLabel)} — ${granularity}`);
  lines.push("");

  // Aggregate per-bucket totals across all projects + per-team subtotals.
  const totalsByBucket = new Map<string, number>();
  const totalsByTeam = new Map<number, Map<string, number>>();
  let grandSentUnpaid = 0;
  let grandMatched = 0;
  let grandUnmatched = 0;
  for (const f of forecasts) {
    grandSentUnpaid += f.sentUnpaid;
    grandMatched += f.matchedTotal;
    grandUnmatched += f.unmatchedTotal;
    for (const [k, v] of f.buckets) {
      totalsByBucket.set(k, (totalsByBucket.get(k) ?? 0) + v);
      if (!totalsByTeam.has(f.team)) totalsByTeam.set(f.team, new Map());
      const tMap = totalsByTeam.get(f.team)!;
      tMap.set(k, (tMap.get(k) ?? 0) + v);
    }
  }

  // === Receivables headline ===
  lines.push("## Receivables (AR — Sent FS not yet paid)");
  lines.push(`- **${fmtUsd(grandSentUnpaid)}** outstanding across ${forecasts.length} project(s) — already billed, awaiting client payment.`);
  lines.push("");

  // === Schedule coverage — a project without a schedule = $0 bucket
  // contribution, regardless of Draft pipeline. Surface this so the PM
  // can see whether the forecast is data-limited (most Drafts unmatched
  // because schedules aren't populated) or pipeline-limited.
  const withSchedule = forecasts.filter(
    (f) => f.matched.length > 0 || (f.matchedTotal === 0 && f.unmatchedTotal === 0),
  ).length;
  const withoutSchedule = forecasts.length - withSchedule;
  if (withoutSchedule > 0) {
    lines.push(`## Schedule coverage`);
    lines.push(
      `- ${withSchedule} of ${forecasts.length} project(s) have schedule-mapped Drafts; **${withoutSchedule} project(s)** have Drafts in the pipeline but no published/working schedule, so their revenue lands in **Unscheduled** below instead of a date bucket.`,
    );
    lines.push("");
  }

  // === Portfolio total by bucket ===
  lines.push(`## Projected inflows by ${granularity}`);
  lines.push("");
  const headerRow = "| Period | " + bucketKeys.map((b) => escapeMarkdownInline(b.label)).join(" | ") + " | **Total** |";
  const sepRow = "|---|" + bucketKeys.map(() => "---:").join("|") + "|---:|";
  lines.push(headerRow);
  lines.push(sepRow);
  const inHorizonTotal = bucketKeys.reduce(
    (s, b) => s + (totalsByBucket.get(b.key) ?? 0),
    0,
  );
  const portfolioRow = "| **Portfolio total** | " +
    bucketKeys.map((b) => fmtUsd(totalsByBucket.get(b.key) ?? 0)).join(" | ") +
    ` | **${fmtUsd(inHorizonTotal)}** |`;
  lines.push(portfolioRow);
  // Per-team subtotal rows (skip if all forecasts are same team — single-team scope)
  const teamCodes = [...totalsByTeam.keys()].sort();
  if (teamCodes.length > 1) {
    for (const team of teamCodes) {
      const tMap = totalsByTeam.get(team)!;
      const teamTotal = bucketKeys.reduce((s, b) => s + (tMap.get(b.key) ?? 0), 0);
      const row = `| _${teamLabel(team)}_ | ` +
        bucketKeys.map((b) => fmtUsd(tMap.get(b.key) ?? 0)).join(" | ") +
        ` | ${fmtUsd(teamTotal)} |`;
      lines.push(row);
    }
  }
  lines.push("");

  // === Per-project breakdown ===
  if (forecasts.length > 1) {
    lines.push(`## Per-project breakdown`);
    lines.push("");
    lines.push(headerRow);
    lines.push(sepRow);
    const sorted = [...forecasts].sort((a, b) => {
      const aTotal = bucketKeys.reduce((s, bk) => s + (a.buckets.get(bk.key) ?? 0), 0);
      const bTotal = bucketKeys.reduce((s, bk) => s + (b.buckets.get(bk.key) ?? 0), 0);
      return bTotal - aTotal;
    });
    for (const f of sorted) {
      const projTotal = bucketKeys.reduce((s, b) => s + (f.buckets.get(b.key) ?? 0), 0);
      if (projTotal === 0 && f.unmatchedTotal === 0 && f.sentUnpaid === 0) continue;
      const row = `| #${f.id} ${escapeMarkdownInline(f.name)} _(${teamLabel(f.team)})_ | ` +
        bucketKeys.map((b) => fmtUsd(f.buckets.get(b.key) ?? 0)).join(" | ") +
        ` | ${fmtUsd(projTotal)} |`;
      lines.push(row);
    }
    lines.push("");
  }

  // === Unscheduled / unmatched Drafts ===
  if (grandUnmatched > 0) {
    lines.push(`## Unscheduled drafts (no schedule task matched)`);
    lines.push(`- ${fmtUsd(grandUnmatched)} of Draft FS value could not be matched to a published-schedule task and is NOT in the bucket totals above. Either the schedule task name differs from the Draft FS name, or the milestone isn't on the schedule yet.`);
    for (const f of forecasts) {
      if (f.unmatched.length === 0) continue;
      lines.push(`- **#${f.id} ${escapeMarkdownInline(f.name)}**`);
      for (const u of f.unmatched.slice(0, 8)) {
        lines.push(`  - ${escapeMarkdownInline(u.draftName)} — ${fmtUsd(u.amount)}`);
      }
      if (f.unmatched.length > 8) lines.push(`  - … ${f.unmatched.length - 8} more`);
    }
    lines.push("");
  }

  // === Match diagnostics (optional, for transparency) ===
  if (forecasts.length === 1 && forecasts[0].matched.length > 0) {
    const f = forecasts[0];
    lines.push(`## Draft FS → schedule match diagnostics`);
    lines.push("| Draft FS | Amount | Matched task | End date | Bucket | Confidence |");
    lines.push("|---|---:|---|---|---|---:|");
    for (const m of f.matched) {
      lines.push(
        `| ${escapeMarkdownInline(m.draftName)} | ${fmtUsd(m.amount)} | ${escapeMarkdownInline(m.matchedTask)} | ${escapeMarkdownInline(m.matchDate)} | ${escapeMarkdownInline(m.bucket)} | ${m.confidence.toFixed(2)} |`,
      );
    }
    lines.push("");
  }

  // === Caveats ===
  const caveats: string[] = [];
  caveats.push("**Schedule-date assumption**: matched Draft FS bucket by their schedule task's end date. Schedule slip → forecast slip.");
  caveats.push("**Payment lag**: Sent-unpaid surfaced as immediate AR; no payment-cycle lag modelled yet.");
  caveats.push(`**Match heuristic**: Jaccard token overlap (threshold 0.35) between normalized Draft FS name and schedule task text. Misses are listed under Unscheduled.`);
  const errProjects = forecasts.filter((f) => f.errors.length > 0);
  if (errProjects.length > 0) {
    caveats.push(`**${errProjects.length} project(s) had partial fetch errors**: ${errProjects.map((f) => `#${f.id}`).join(", ")}`);
  }
  lines.push(`## Assumptions / caveats`);
  for (const c of caveats) lines.push(`- ${c}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const PROJECT_CONCURRENCY = 5;

export const cashFlowForecastTool: ToolDefinition = {
  name: "cash_flow_forecast",
  description:
    "Projects expected cash inflows over the next N weeks / months / quarters. Joins Draft financial statements to the published schedule via name match, buckets by task end date. Sent-but-unpaid FS surfaced separately as receivables (AR). " +
    "Scope via EITHER `project_ids` (1-200) OR `team` (`all_active` = whole company; `limit` default 100, max 200). Granularity: weekly | monthly | quarterly (horizon caps: weekly 52, monthly 24, quarterly 8). " +
    "Returns a markdown table: portfolio total per bucket, per-team subtotals (when scope crosses teams), per-project breakdown, plus a list of Draft FS that couldn't be matched to a schedule task. " +
    "No payment-lag modeling yet — Sent-unpaid shown as immediate AR.",
  inputSchema: zodToJsonSchema(CashFlowForecastSchema),
  permission: "read:projects",
  handler: async (rawArgs: unknown, api: BuildToolsAPI) => {
    const parsed = CashFlowForecastSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return errorMarkdown(
        `**Invalid input**\n\n${parsed.error.errors.map((e) => `- ${e.path.join(".")}: ${e.message}`).join("\n")}`,
      );
    }
    const data = parsed.data;
    const granularity = data.granularity;
    const horizonDefault = granularity === "weekly" ? 12 : granularity === "monthly" ? 6 : 4;
    const horizon = data.horizon_periods ?? horizonDefault;

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
      let allProjects: ProjectRow[] = [];
      try {
        const result = await api.getProjects<{ data: ProjectRow[] }>({
          length: 300,
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
      // PR #79: default 100 (was 30) so `all_active` actually returns the
      // whole company in typical Moss-size portfolios. Max 200.
      const cap = data.limit ?? 100;
      targetIds = matched.slice(0, cap).map((p) =>
        Number(p.id ?? (p.DT_RowId ?? "").replace(/^row_/, "")),
      );
      targetIds = targetIds.filter((id) => Number.isFinite(id) && id > 0);
      if (targetIds.length === 0) {
        return markdown(
          `# Cash flow forecast\n\nNo active projects matched filter \`team=${teamFilter}\`.`,
        );
      }
    }

    // === Fan out with bounded concurrency ===
    const forecasts: ProjectForecast[] = [];
    for (let i = 0; i < targetIds.length; i += PROJECT_CONCURRENCY) {
      const batch = targetIds.slice(i, i + PROJECT_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map((id) => buildProjectForecast(api, id, granularity).catch(() => null)),
      );
      for (const f of batchResults) if (f) forecasts.push(f);
    }

    // === Compute bucket keys (anchored at TODAY going forward) ===
    const today = new Date();
    const buckets: Array<{ key: string; label: string }> = [];
    for (const b of iterBuckets(today, granularity, horizon)) {
      buckets.push({ key: b.key, label: b.label });
    }

    return markdown(renderForecast(forecasts, granularity, buckets, scopeLabel));
  },
};

export const forecastTools: ToolDefinition[] = [cashFlowForecastTool];

// Exported for tests
export const __test__ = { nameMatch, bucketKey, iterBuckets, tokensFromDraftName, tokenize };
