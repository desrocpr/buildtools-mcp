/**
 * Unit tests for `src/tools/work-tracking.ts` (MOS-295).
 *
 * These tests exercise the tool handlers with a hand-rolled stub for
 * `BuildToolsAPI`. We do NOT instantiate the real class — handlers must not
 * depend on `loadConfigFromEnv()`, must not hit the network, and must not
 * require live credentials.
 *
 * Coverage per the planner contract (criterion 10):
 *   (a) happy-path Markdown shape
 *   (b) empty-data path → no `isError`
 *   (c) BuildToolsError path → `isError: true`
 *   (d) Zod-invalid input → `isError: true`
 *
 * `list_certificates` additionally verifies the search routing (criterion 11):
 *   supplying `query` calls `searchCertificates` (not `getCertificates`) with
 *   the forwarded query + limit.
 */

import { describe, expect, it, vi } from "vitest";

import type { OperationsManagementApi } from "../../operations/types.js";
import type { ToolContext } from "../projects.js";
import {
  BuildToolsAuthError,
  BuildToolsServerError,
} from "../../client/errors.js";

import {
  listCertificatesTool,
  listDailyLogsTool,
  listWeeklyReportsTool,
  listWorkDaysTool,
  workTrackingTools,
} from "../work-tracking.js";
import { type ToolResult } from "../projects.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeApi(overrides: {
  getCertificates?: OperationsManagementApi["getCertificates"];
  searchCertificates?: OperationsManagementApi["searchCertificates"];
  getDailyLogs?: OperationsManagementApi["getDailyLogs"];
  getWeeklyReports?: OperationsManagementApi["getWeeklyReports"];
  getWorkDays?: OperationsManagementApi["getWorkDays"];
}): ToolContext {
  return { ops: overrides } as unknown as ToolContext;
}

function textOf(result: ToolResult): string {
  return result.content.map((c) => "text" in c ? c.text : "").join("");
}

// ---------------------------------------------------------------------------
// Sample rows (mirror the captured fixtures' shape)
// ---------------------------------------------------------------------------

const sampleCertificateRow = {
  DT_RowId: "row_1001",
  id: 1001,
  status: 1,
  name: "General Liability Insurance",
  type: "Insurance",
  company: "Acme Subcontractors LLC",
  issuer: "Sample Insurance Co",
  issue_date: "01/01/2026",
  expiry_date: "12/31/2026",
};

const sampleSecondCertificateRow = {
  DT_RowId: "row_1002",
  id: 1002,
  status: 2,
  name: "Workers Compensation",
  type: "Insurance",
  company: "Beta Trades Inc",
  issuer: "Coverage Partners",
  issue_date: "03/01/2026",
  expiry_date: "02/28/2027",
};

const sampleDailyLogRow = {
  DT_RowId: "row_2001",
  id: 2001,
  status: 1,
  project: "Jones Addition",
  date: "04/15/2026",
  weather: "Sunny, 72°F",
  hours_worked: 8.5,
  notes: "Framing inspection passed.",
};

const sampleWeeklyReportRow = {
  DT_RowId: "row_3001",
  id: 3001,
  status: 1,
  project: "Jones Addition",
  week_start: "04/13/2026",
  week_end: "04/19/2026",
  total_hours: 42.5,
  summary: "Framing completed; drywall starts Monday.",
};

const sampleWorkDayRow = {
  DT_RowId: "row_4001",
  id: 4001,
  status: 1,
  project: "Jones Addition",
  date: "04/15/2026",
  user: "Alex Doe",
  hours: 8.0,
};

// ---------------------------------------------------------------------------
// Registry sanity
// ---------------------------------------------------------------------------

describe("workTrackingTools registry", () => {
  it("exports exactly four tools with the contract-mandated names in order", () => {
    const names = workTrackingTools.map((t) => t.name);
    expect(names).toEqual([
      "list_certificates",
      "list_daily_logs",
      "list_weekly_reports",
      "list_work_days",
    ]);
  });

  it("each tool exposes a JSON Schema for its input", () => {
    for (const tool of workTrackingTools) {
      expect(tool.inputSchema).toBeDefined();
      const schema = tool.inputSchema as { type?: string };
      expect(schema.type).toBe("object");
    }
  });
});

// ---------------------------------------------------------------------------
// list_certificates
// ---------------------------------------------------------------------------

describe("list_certificates", () => {
  it("returns Markdown list rows on the happy path (no query)", async () => {
    const getCertificates = vi.fn().mockResolvedValue({
      data: [sampleCertificateRow, sampleSecondCertificateRow],
      recordsTotal: 2,
      recordsFiltered: 2,
    });
    const api = fakeApi({
      getCertificates:
        getCertificates as OperationsManagementApi["getCertificates"],
    });

    const result = await listCertificatesTool.handler({}, api);

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("**2 certificates**");
    expect(text).toContain("General Liability Insurance");
    expect(text).toContain("Workers Compensation");
    expect(text).toContain("[1]");
    expect(text).toContain("Acme Subcontractors LLC");
    expect(text).toContain("issued 01/01/2026, expires 12/31/2026");
    expect(text).toContain("issuer: Sample Insurance Co");
    // Default limit is 50.
    expect(getCertificates).toHaveBeenCalledWith({ limit: 50 });
  });

  it("routes through searchCertificates when query is supplied", async () => {
    const searchCertificates = vi.fn().mockResolvedValue({
      data: [sampleCertificateRow],
      recordsTotal: 1,
      recordsFiltered: 1,
    });
    const getCertificates = vi.fn().mockResolvedValue({
      data: [sampleCertificateRow, sampleSecondCertificateRow],
    });
    const api = fakeApi({
      searchCertificates:
        searchCertificates as OperationsManagementApi["searchCertificates"],
      getCertificates:
        getCertificates as OperationsManagementApi["getCertificates"],
    });

    const result = await listCertificatesTool.handler(
      { query: "Liability", limit: 25 },
      api,
    );

    expect(result.isError).toBeFalsy();
    expect(searchCertificates).toHaveBeenCalledWith("Liability", 25);
    expect(getCertificates).not.toHaveBeenCalled();
    const text = textOf(result);
    expect(text).toContain('**1 certificate** matching "Liability"');
    expect(text).toContain("General Liability Insurance");
  });

  it("forwards a custom limit on the list path", async () => {
    const getCertificates = vi
      .fn()
      .mockResolvedValue({ data: [sampleCertificateRow] });
    const api = fakeApi({
      getCertificates:
        getCertificates as OperationsManagementApi["getCertificates"],
    });
    await listCertificatesTool.handler({ limit: 10 }, api);
    expect(getCertificates).toHaveBeenCalledWith({ limit: 10 });
  });

  it("returns a Markdown 'no certificates' message when result is empty (no isError)", async () => {
    const getCertificates = vi.fn().mockResolvedValue({ data: [] });
    const api = fakeApi({
      getCertificates:
        getCertificates as OperationsManagementApi["getCertificates"],
    });
    const result = await listCertificatesTool.handler({}, api);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe("No certificates found.");
  });

  it("treats a null envelope as empty (no isError)", async () => {
    const getCertificates = vi.fn().mockResolvedValue(null);
    const api = fakeApi({
      getCertificates:
        getCertificates as OperationsManagementApi["getCertificates"],
    });
    const result = await listCertificatesTool.handler({}, api);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe("No certificates found.");
  });

  it("renders missing fields as em-dashes rather than throwing", async () => {
    const getCertificates = vi
      .fn()
      .mockResolvedValue({ data: [{ id: 99, name: "Bare cert" }] });
    const api = fakeApi({
      getCertificates:
        getCertificates as OperationsManagementApi["getCertificates"],
    });
    const result = await listCertificatesTool.handler({}, api);
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("#99");
    expect(text).toContain("[—]");
    expect(text).toContain("Bare cert");
    expect(text).toContain("issued —, expires —");
  });

  it("returns Markdown error content (isError: true) on BuildToolsError", async () => {
    const getCertificates = vi
      .fn()
      .mockRejectedValue(new BuildToolsAuthError("Not authenticated"));
    const api = fakeApi({
      getCertificates:
        getCertificates as OperationsManagementApi["getCertificates"],
    });
    const result = await listCertificatesTool.handler({}, api);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Not authenticated");
    expect(textOf(result)).toContain("BuildToolsAuthError");
  });

  it("returns Markdown error content (isError: true) on Zod-invalid input", async () => {
    const result = await listCertificatesTool.handler(
      { limit: "ten" },
      fakeApi({}),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid input for `list_certificates`");
    expect(textOf(result)).toContain("limit");
  });

  it("returns Markdown error content (isError: true) when limit is out of range", async () => {
    const result = await listCertificatesTool.handler(
      { limit: 9999 },
      fakeApi({}),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid input for `list_certificates`");
  });
});

// ---------------------------------------------------------------------------
// list_daily_logs
// ---------------------------------------------------------------------------

describe("list_daily_logs", () => {
  it("returns Markdown list rows on the happy path", async () => {
    const getDailyLogs = vi.fn().mockResolvedValue({
      data: [sampleDailyLogRow],
      recordsTotal: 1,
      recordsFiltered: 1,
    });
    const api = fakeApi({
      getDailyLogs: getDailyLogs as OperationsManagementApi["getDailyLogs"],
    });

    const result = await listDailyLogsTool.handler({}, api);

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("**1 daily log**");
    expect(text).toContain("Jones Addition");
    expect(text).toContain("04/15/2026");
    expect(text).toContain("8.5h");
    expect(text).toContain("Sunny, 72°F");
    expect(text).toContain("Framing inspection passed");
    expect(getDailyLogs).toHaveBeenCalledWith({ limit: 50 });
  });

  it("returns 'no daily logs' message when the envelope's data is empty (no isError)", async () => {
    const getDailyLogs = vi.fn().mockResolvedValue({ data: [] });
    const api = fakeApi({
      getDailyLogs: getDailyLogs as OperationsManagementApi["getDailyLogs"],
    });
    const result = await listDailyLogsTool.handler({}, api);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe("No daily logs found.");
  });

  it("returns 'no daily logs' when the API returns a literal null envelope (zero-record case)", async () => {
    // Daily logs may legitimately return null (zero records) in production.
    const getDailyLogs = vi.fn().mockResolvedValue(null);
    const api = fakeApi({
      getDailyLogs: getDailyLogs as OperationsManagementApi["getDailyLogs"],
    });
    const result = await listDailyLogsTool.handler({}, api);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe("No daily logs found.");
  });

  it("returns Markdown error content (isError: true) on BuildToolsError", async () => {
    const getDailyLogs = vi
      .fn()
      .mockRejectedValue(
        new BuildToolsServerError("Internal server error", { status: 500 }),
      );
    const api = fakeApi({
      getDailyLogs: getDailyLogs as OperationsManagementApi["getDailyLogs"],
    });
    const result = await listDailyLogsTool.handler({}, api);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("BuildToolsServerError");
    expect(textOf(result)).toContain("Internal server error");
  });

  it("returns Markdown error content (isError: true) on Zod-invalid input", async () => {
    const result = await listDailyLogsTool.handler(
      { limit: -5 },
      fakeApi({}),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid input for `list_daily_logs`");
    expect(textOf(result)).toContain("limit");
  });
});

// ---------------------------------------------------------------------------
// list_weekly_reports
// ---------------------------------------------------------------------------

describe("list_weekly_reports", () => {
  it("returns Markdown list rows on the happy path", async () => {
    const getWeeklyReports = vi.fn().mockResolvedValue({
      data: [sampleWeeklyReportRow],
    });
    const api = fakeApi({
      getWeeklyReports:
        getWeeklyReports as OperationsManagementApi["getWeeklyReports"],
    });

    const result = await listWeeklyReportsTool.handler(
      { limit: 25 },
      api,
    );

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("**1 weekly report**");
    expect(text).toContain("04/13/2026 → 04/19/2026");
    expect(text).toContain("Jones Addition");
    expect(text).toContain("42.5h");
    expect(text).toContain("Framing completed");
    expect(getWeeklyReports).toHaveBeenCalledWith({ limit: 25 });
  });

  it("returns 'no weekly reports' message when the envelope's data is empty (no isError)", async () => {
    const getWeeklyReports = vi.fn().mockResolvedValue({ data: [] });
    const api = fakeApi({
      getWeeklyReports:
        getWeeklyReports as OperationsManagementApi["getWeeklyReports"],
    });
    const result = await listWeeklyReportsTool.handler({}, api);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe("No weekly reports found.");
  });

  it("returns 'no weekly reports' when the API returns a literal null envelope (zero-record case)", async () => {
    const getWeeklyReports = vi.fn().mockResolvedValue(null);
    const api = fakeApi({
      getWeeklyReports:
        getWeeklyReports as OperationsManagementApi["getWeeklyReports"],
    });
    const result = await listWeeklyReportsTool.handler({}, api);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe("No weekly reports found.");
  });

  it("returns Markdown error content (isError: true) on BuildToolsError", async () => {
    const getWeeklyReports = vi
      .fn()
      .mockRejectedValue(new BuildToolsAuthError("Not authenticated"));
    const api = fakeApi({
      getWeeklyReports:
        getWeeklyReports as OperationsManagementApi["getWeeklyReports"],
    });
    const result = await listWeeklyReportsTool.handler({}, api);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("BuildToolsAuthError");
  });

  it("returns Markdown error content (isError: true) on Zod-invalid input", async () => {
    const result = await listWeeklyReportsTool.handler(
      { limit: 999 },
      fakeApi({}),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      "Invalid input for `list_weekly_reports`",
    );
  });
});

// ---------------------------------------------------------------------------
// list_work_days
// ---------------------------------------------------------------------------

describe("list_work_days", () => {
  it("returns Markdown list rows on the happy path", async () => {
    const getWorkDays = vi.fn().mockResolvedValue({
      data: [sampleWorkDayRow],
    });
    const api = fakeApi({
      getWorkDays: getWorkDays as OperationsManagementApi["getWorkDays"],
    });

    const result = await listWorkDaysTool.handler({}, api);

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("**1 work day**");
    expect(text).toContain("04/15/2026");
    expect(text).toContain("Alex Doe");
    expect(text).toContain("Jones Addition");
    expect(text).toContain("8h");
    expect(getWorkDays).toHaveBeenCalledWith({ limit: 50 });
  });

  it("returns 'no work days' message when the envelope's data is empty (no isError)", async () => {
    const getWorkDays = vi.fn().mockResolvedValue({ data: [] });
    const api = fakeApi({
      getWorkDays: getWorkDays as OperationsManagementApi["getWorkDays"],
    });
    const result = await listWorkDaysTool.handler({}, api);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe("No work days found.");
  });

  it("returns 'no work days' when the API returns a literal null envelope", async () => {
    const getWorkDays = vi.fn().mockResolvedValue(null);
    const api = fakeApi({
      getWorkDays: getWorkDays as OperationsManagementApi["getWorkDays"],
    });
    const result = await listWorkDaysTool.handler({}, api);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe("No work days found.");
  });

  it("returns Markdown error content (isError: true) on BuildToolsError", async () => {
    const getWorkDays = vi
      .fn()
      .mockRejectedValue(
        new BuildToolsServerError("Internal server error", { status: 500 }),
      );
    const api = fakeApi({
      getWorkDays: getWorkDays as OperationsManagementApi["getWorkDays"],
    });
    const result = await listWorkDaysTool.handler({}, api);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("BuildToolsServerError");
  });

  it("returns Markdown error content (isError: true) on Zod-invalid input", async () => {
    const result = await listWorkDaysTool.handler(
      { limit: "fifty" },
      fakeApi({}),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid input for `list_work_days`");
    expect(textOf(result)).toContain("limit");
  });
});
