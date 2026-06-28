import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BuildToolsAPI } from "../../client/BuildToolsAPI.js";
import { cashFlowForecastTool, forecastTools, __test__ } from "../forecasts.js";

interface FakeApiOverrides {
  getProject?: BuildToolsAPI["getProject"];
  getProjects?: BuildToolsAPI["getProjects"];
  getBudget?: BuildToolsAPI["getBudget"];
  getFinancialStatements?: BuildToolsAPI["getFinancialStatements"];
  getSchedule?: BuildToolsAPI["getSchedule"];
}

function fakeApi(overrides: FakeApiOverrides = {}): BuildToolsAPI {
  return overrides as unknown as BuildToolsAPI;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

describe("cash_flow_forecast — tool registration", () => {
  it("exports cashFlowForecastTool in forecastTools", () => {
    expect(forecastTools).toContain(cashFlowForecastTool);
    expect(cashFlowForecastTool.name).toBe("cash_flow_forecast");
  });

  it("has read:projects permission (no mutations)", () => {
    expect(cashFlowForecastTool.permission).toBe("read:projects");
  });
});

describe("cash_flow_forecast — name match", () => {
  const tasks = [
    { text: "Trades Rough In", endDate: new Date("2026-07-13") },
    { text: "Concealment inspection", endDate: new Date("2026-07-20") },
    { text: "Final Building Inspection", endDate: new Date("2026-10-01") },
    { text: "Punchlist", endDate: new Date("2026-11-01") },
    { text: "Foundation", endDate: new Date("2026-05-29") },
  ];
  const { nameMatch } = __test__;

  it("matches Progress Payment N - <milestone> to schedule task with same milestone words", () => {
    const m = nameMatch("Progress Payment 5 - Concealment inspection", tasks);
    expect(m?.task.text).toBe("Concealment inspection");
    expect(m?.confidence).toBeGreaterThan(0.5);
  });

  it("matches 'Final Building Inspection' draft to matching task", () => {
    const m = nameMatch("Progress Payment 7 - Final Building Inspection", tasks);
    expect(m?.task.text).toBe("Final Building Inspection");
  });

  it("matches 'Punchlist' (subset) with subset-bonus", () => {
    const m = nameMatch("Progress Payment 8 - Completion of Approved Punchlist", tasks);
    expect(m?.task.text).toBe("Punchlist");
  });

  it("returns null when no overlap above threshold", () => {
    const m = nameMatch("PP6 Kitchen countertop template", tasks);
    expect(m).toBeNull();
  });
});

describe("cash_flow_forecast — bucketing", () => {
  const { bucketKey } = __test__;

  // Use explicit local-tz dates (year, monthIdx, day) — ISO strings
  // parse as UTC midnight and then shift to local for the Date getters,
  // which breaks bucketing in non-UTC environments.
  it("weekly bucket = Monday of that week", () => {
    expect(bucketKey(new Date(2026, 6, 1), "weekly")).toBe("2026-06-29");  // Wed → Mon
    expect(bucketKey(new Date(2026, 6, 5), "weekly")).toBe("2026-06-29");  // Sun
    expect(bucketKey(new Date(2026, 6, 6), "weekly")).toBe("2026-07-06");  // Mon
  });

  it("monthly bucket = YYYY-MM", () => {
    expect(bucketKey(new Date(2026, 6, 15), "monthly")).toBe("2026-07");
    expect(bucketKey(new Date(2026, 11, 31), "monthly")).toBe("2026-12");
  });

  it("quarterly bucket = YYYY-Qn", () => {
    expect(bucketKey(new Date(2026, 0, 15), "quarterly")).toBe("2026-Q1");
    expect(bucketKey(new Date(2026, 6, 1), "quarterly")).toBe("2026-Q3");
    expect(bucketKey(new Date(2026, 11, 31), "quarterly")).toBe("2026-Q4");
  });
});

describe("cash_flow_forecast — end-to-end (single project)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-28T12:00:00Z"));
  });
  afterEach(() => { vi.useRealTimers(); });

  it("buckets Draft FS by matched schedule task end-date", async () => {
    const getProject = vi.fn().mockResolvedValue({
      id: 185907, name: "Katchmark 1 Addition", status_id: 6,
      budget_revised: "$ 665,124.94",
    });
    const getBudget = vi.fn().mockResolvedValue({ columns: [], items: [] });
    const getFinancialStatements = vi.fn().mockResolvedValue({
      statusCount: {},
      statements: [
        { id: "1", name: "Construction Start", status: "Paid", amount: 172500, paid: 172500, balance: 0, date: "2025-08-11" },
        { id: "2", name: "Progress Payment 5 - Concealment inspection", status: "Draft", amount: 115000, paid: 0, balance: 115000, date: "2025-08-11" },
        { id: "3", name: "Progress Payment 7 - Final Building Inspection", status: "Draft", amount: 46000, paid: 0, balance: 46000, date: "2025-08-11" },
        { id: "4", name: "Progress Payment 8 - Completion of Approved Punchlist", status: "Draft", amount: 9000, paid: 0, balance: 9000, date: "2025-08-11" },
        { id: "5", name: "PP6 — Kitchen countertop template", status: "Draft", amount: 86250, paid: 0, balance: 86250, date: "2025-08-11" },
      ],
    });
    const getSchedule = vi.fn().mockResolvedValue({
      tasks: [
        { id: 1, project_id: 185907, parent: null, text: "Project root", type: "project", start_date: "2026-05-26 00:00:00", duration: 161, progress: 0, hide_client: 0 },
        { id: 2, project_id: 185907, parent: 1, text: "Trades Rough In", type: "task", start_date: "2026-07-01 00:00:00", duration: 13, progress: 0, hide_client: 0 },
        { id: 3, project_id: 185907, parent: 1, text: "Concealment inspection", type: "task", start_date: "2026-07-20 00:00:00", duration: 1, progress: 0, hide_client: 0 },
        { id: 4, project_id: 185907, parent: 1, text: "Final Building Inspection", type: "task", start_date: "2026-10-01 00:00:00", duration: 1, progress: 0, hide_client: 0 },
        { id: 5, project_id: 185907, parent: 1, text: "Punchlist", type: "task", start_date: "2026-11-01 00:00:00", duration: 7, progress: 0, hide_client: 0 },
      ],
      links: [],
    });
    const api = fakeApi({
      getProject: getProject as any,
      getBudget: getBudget as any,
      getFinancialStatements: getFinancialStatements as any,
      getSchedule: getSchedule as any,
    });
    const result = await cashFlowForecastTool.handler(
      { project_ids: [185907], granularity: "monthly", horizon_periods: 6 },
      api,
    );
    const text = textOf(result);
    expect(text).toContain("# Cash flow forecast");
    expect(text).toContain("monthly");
    expect(text).toContain("Receivables");
    // Concealment ($115k) bucket = July 2026 (end 2026-07-20)
    expect(text).toContain("$115,000");
    // Final Inspection ($46k) → October
    expect(text).toContain("$46,000");
    // Punchlist ($9k) → November
    expect(text).toContain("$9,000");
    // PP6 Kitchen countertop template — no schedule match
    expect(text).toContain("Unscheduled drafts");
    expect(text).toContain("$86,250");
    expect(text).toContain("PP6");
    // Diagnostics for the single-project case
    expect(text).toContain("Draft FS → schedule match diagnostics");
  });

  it("0 active projects in team → graceful empty response", async () => {
    const getProjects = vi.fn().mockResolvedValue({ data: [] });
    const api = fakeApi({ getProjects: getProjects as any });
    const result = await cashFlowForecastTool.handler(
      { team: "Omega", granularity: "monthly" },
      api,
    );
    const text = textOf(result);
    expect(text).toContain("No active projects matched");
  });

  it("requires exactly one of project_ids or team", async () => {
    const api = fakeApi();
    const result = await cashFlowForecastTool.handler({}, api);
    expect(result.isError).toBeTruthy();
    expect(textOf(result)).toContain("Exactly one of");
  });
});

describe("cash_flow_forecast — PR #79 horizon + limit caps", () => {
  it("rejects quarterly horizon > 8", async () => {
    const api = fakeApi();
    const result = await cashFlowForecastTool.handler(
      { project_ids: [1], granularity: "quarterly", horizon_periods: 12 },
      api,
    );
    expect(result.isError).toBeTruthy();
    expect(textOf(result)).toContain("quarterly");
    expect(textOf(result)).toContain("exceeds 8");
  });

  it("rejects monthly horizon > 24", async () => {
    const api = fakeApi();
    const result = await cashFlowForecastTool.handler(
      { project_ids: [1], granularity: "monthly", horizon_periods: 30 },
      api,
    );
    expect(result.isError).toBeTruthy();
    expect(textOf(result)).toContain("monthly");
    expect(textOf(result)).toContain("exceeds 24");
  });

  it("accepts weekly horizon up to 52", async () => {
    const getProject = vi.fn().mockResolvedValue({ id: 1, name: "T", status_id: 6 });
    const api = fakeApi({
      getProject: getProject as any,
      getBudget: vi.fn().mockResolvedValue({ columns: [], items: [] }) as any,
      getFinancialStatements: vi.fn().mockResolvedValue({ statusCount: {}, statements: [] }) as any,
      getSchedule: vi.fn().mockResolvedValue({ tasks: [], links: [] }) as any,
    });
    const result = await cashFlowForecastTool.handler(
      { project_ids: [1], granularity: "weekly", horizon_periods: 52 },
      api,
    );
    expect(result.isError).toBeFalsy();
  });
});
