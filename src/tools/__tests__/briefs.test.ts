/**
 * Tests for the project_status_brief read-only digest tool (PR #66).
 */

import { describe, expect, it, vi } from "vitest";

import type { BuildToolsAPI } from "../../client/BuildToolsAPI.js";
import { briefTools, projectStatusBriefTool } from "../briefs.js";

interface FakeApiOverrides {
  getProject?: BuildToolsAPI["getProject"];
  getProjects?: BuildToolsAPI["getProjects"];
  getRFIs?: BuildToolsAPI["getRFIs"];
  getTasks?: BuildToolsAPI["getTasks"];
  getPurchaseOrders?: BuildToolsAPI["getPurchaseOrders"];
  getChangeOrders?: BuildToolsAPI["getChangeOrders"];
  getFinancialStatements?: BuildToolsAPI["getFinancialStatements"];
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

describe("project_status_brief — tool registration", () => {
  it("is exported in briefTools", () => {
    expect(briefTools).toContain(projectStatusBriefTool);
  });

  it("schema declares project_ids OR team mutually exclusive", () => {
    const schema = projectStatusBriefTool.inputSchema as any;
    expect(schema.properties.project_ids).toBeDefined();
    expect(schema.properties.team).toBeDefined();
    expect(schema.properties.include).toBeDefined();
  });

  it("permission is read:projects (read-only)", () => {
    expect(projectStatusBriefTool.permission).toBe("read:projects");
  });
});

describe("project_status_brief — schema validation", () => {
  it("Zod refine: neither project_ids nor team → error", async () => {
    const result = await projectStatusBriefTool.handler({}, fakeApi({}));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Exactly one of");
  });

  it("Zod refine: both project_ids AND team → error", async () => {
    const result = await projectStatusBriefTool.handler(
      { project_ids: [100002], team: "Omega" },
      fakeApi({}),
    );
    expect(result.isError).toBe(true);
  });

  it("Zod: project_ids max 30 enforced", async () => {
    const result = await projectStatusBriefTool.handler(
      { project_ids: Array.from({ length: 35 }, (_, i) => i + 1) },
      fakeApi({}),
    );
    expect(result.isError).toBe(true);
  });

  it("Zod: project_ids must be positive ints", async () => {
    const result = await projectStatusBriefTool.handler(
      { project_ids: [-5, 0, 1.5] },
      fakeApi({}),
    );
    expect(result.isError).toBe(true);
  });

  it("Zod: unknown team value rejected", async () => {
    const result = await projectStatusBriefTool.handler(
      { team: "Bogus" },
      fakeApi({}),
    );
    expect(result.isError).toBe(true);
  });
});

describe("project_status_brief — single project digest", () => {
  const projectRow = { id: 100002, name: "Jones Addition", status_id: 6 };

  it("renders full digest with all five sections present", async () => {
    const getProject = vi.fn().mockResolvedValue(projectRow);
    const getRFIs = vi.fn().mockResolvedValue({
      data: [
        { info: 501, number: "RFI-1", subject: "Sub-floor type?", status: "Open", priority: "High" },
        { info: 502, number: "RFI-2", subject: "Roof pitch", status: "Open", priority: "Normal" },
      ],
    });
    const getTasks = vi.fn().mockResolvedValue({
      data: [
        { info: 1, name: "Order roof tiles", status: "Open", priority: "High", due_date: "2026-01-01" },
      ],
    });
    const getPurchaseOrders = vi.fn().mockResolvedValue({
      data: [
        { info: 9001, name: "Plumbing rough-in", total: "$ 4,500.00", status: "Sent", company: "Kai Muten, LLC" },
      ],
    });
    const getChangeOrders = vi.fn().mockResolvedValue({
      data: [
        { info: 1, name: "Skylight upgrade", total: "$ 2,000.00", status: "Approved" },
      ],
    });
    const getFinancialStatements = vi.fn().mockResolvedValue({
      statusCount: {},
      statements: [
        { id: "1", name: "Draw #1", status: "Paid", amount: 25000, paid: 25000, balance: 0, date: "2026-01-15" },
        { id: "2", name: "Draw #2", status: "Sent", amount: 30000, paid: 0, balance: 30000, date: "2026-02-15" },
      ],
    });
    const api = fakeApi({
      getProject: getProject as any,
      getRFIs: getRFIs as any,
      getTasks: getTasks as any,
      getPurchaseOrders: getPurchaseOrders as any,
      getChangeOrders: getChangeOrders as any,
      getFinancialStatements: getFinancialStatements as any,
    });

    const result = await projectStatusBriefTool.handler({ project_ids: [100002] }, api);
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("Jones Addition");
    expect(text).toContain("Omega (6)");
    expect(text).toContain("Open RFIs**: 2");
    expect(text).toContain("Sub-floor type?");
    expect(text).toContain("Open tasks**: 1");
    expect(text).toContain("Order roof tiles");
    expect(text).toContain("Open POs**: 1");
    expect(text).toContain("Plumbing rough-in");
    expect(text).toContain("Approved change orders**: 1");
    expect(text).toContain("Skylight upgrade");
    expect(text).toContain("Draws**: 2 statement(s)");
    expect(text).toContain("Draw #2");
    expect(text).toContain("Draw #1");
  });

  it("`include` filter trims sections (only `rfis` requested)", async () => {
    const getProject = vi.fn().mockResolvedValue(projectRow);
    const getRFIs = vi.fn().mockResolvedValue({ data: [] });
    const getTasks = vi.fn();
    const getPurchaseOrders = vi.fn();
    const api = fakeApi({
      getProject: getProject as any,
      getRFIs: getRFIs as any,
      getTasks: getTasks as any,
      getPurchaseOrders: getPurchaseOrders as any,
    });
    const result = await projectStatusBriefTool.handler(
      { project_ids: [100002], include: ["rfis"] },
      api,
    );
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("Open RFIs");
    expect(text).not.toContain("Open tasks");
    expect(text).not.toContain("Open POs");
    expect(text).not.toContain("Draws");
    // Skipped sections didn't call BT
    expect(getTasks).not.toHaveBeenCalled();
    expect(getPurchaseOrders).not.toHaveBeenCalled();
  });

  it("partial section failure: degrades gracefully — other sections still render", async () => {
    const getProject = vi.fn().mockResolvedValue(projectRow);
    const getRFIs = vi.fn().mockRejectedValue(new Error("BT 503"));
    const getTasks = vi.fn().mockResolvedValue({ data: [] });
    const getPurchaseOrders = vi.fn().mockResolvedValue({ data: [] });
    const getChangeOrders = vi.fn().mockResolvedValue({ data: [] });
    const getFinancialStatements = vi.fn().mockResolvedValue({ statusCount: {}, statements: [] });
    const api = fakeApi({
      getProject: getProject as any,
      getRFIs: getRFIs as any,
      getTasks: getTasks as any,
      getPurchaseOrders: getPurchaseOrders as any,
      getChangeOrders: getChangeOrders as any,
      getFinancialStatements: getFinancialStatements as any,
    });

    const result = await projectStatusBriefTool.handler({ project_ids: [100002] }, api);
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    // Successful sections still present
    expect(text).toContain("Open tasks**: 0");
    expect(text).toContain("Open POs**: 0");
    // Failed section noted in caveats
    expect(text).toContain("RFIs unavailable");
  });

  it("RFIs sorted by priority — Urgent before High before Normal", async () => {
    const getProject = vi.fn().mockResolvedValue(projectRow);
    const getRFIs = vi.fn().mockResolvedValue({
      data: [
        { info: 1, number: "R-1", subject: "Low pri", status: "Open", priority: "Normal" },
        { info: 2, number: "R-2", subject: "Urgent issue", status: "Open", priority: "Urgent" },
        { info: 3, number: "R-3", subject: "High pri", status: "Open", priority: "High" },
      ],
    });
    const api = fakeApi({
      getProject: getProject as any,
      getRFIs: getRFIs as any,
    });
    const result = await projectStatusBriefTool.handler(
      { project_ids: [100002], include: ["rfis"] },
      api,
    );
    const text = textOf(result);
    const urgentIdx = text.indexOf("Urgent issue");
    const highIdx = text.indexOf("High pri");
    const normalIdx = text.indexOf("Low pri");
    expect(urgentIdx).toBeGreaterThan(-1);
    expect(highIdx).toBeGreaterThan(urgentIdx);
    expect(normalIdx).toBeGreaterThan(highIdx);
  });

  it("Tasks sorted: past-due first, then high priority", async () => {
    const getProject = vi.fn().mockResolvedValue(projectRow);
    const getTasks = vi.fn().mockResolvedValue({
      data: [
        { info: 1, name: "Future high priority", status: "Open", priority: "High", due_date: "2099-01-01" },
        { info: 2, name: "Past due normal", status: "Open", priority: "Normal", due_date: "2020-01-01" },
        { info: 3, name: "Future normal", status: "Open", priority: "Normal", due_date: "2099-01-01" },
      ],
    });
    const api = fakeApi({
      getProject: getProject as any,
      getTasks: getTasks as any,
    });
    const result = await projectStatusBriefTool.handler(
      { project_ids: [100002], include: ["tasks"] },
      api,
    );
    const text = textOf(result);
    const pastIdx = text.indexOf("Past due normal");
    const futureHighIdx = text.indexOf("Future high priority");
    expect(pastIdx).toBeGreaterThan(-1);
    expect(pastIdx).toBeLessThan(futureHighIdx);
  });

  it("PO totals approximated correctly across multiple rows", async () => {
    const getProject = vi.fn().mockResolvedValue(projectRow);
    const getPurchaseOrders = vi.fn().mockResolvedValue({
      data: [
        { info: 1, name: "PO 1", total: "$ 1,000.00", status: "Sent", company: "A" },
        { info: 2, name: "PO 2", total: "$ 2,500.50", status: "Draft", company: "B" },
        { info: 3, name: "PO 3", total: "$ 500.00", status: "Sent", company: "C" },
      ],
    });
    const api = fakeApi({
      getProject: getProject as any,
      getPurchaseOrders: getPurchaseOrders as any,
    });
    const result = await projectStatusBriefTool.handler(
      { project_ids: [100002], include: ["purchase_orders"] },
      api,
    );
    const text = textOf(result);
    expect(text).toContain("Open POs**: 3");
    // 1000 + 2500.50 + 500 = 4000.50 → rounded to ~$4,001
    expect(text).toMatch(/\$4,00[01]/);
  });
});

describe("project_status_brief — team filter", () => {
  it("team='Omega' filters projects by status_id=6", async () => {
    const getProjects = vi.fn().mockResolvedValue({
      data: [
        { id: 1, name: "Nexus Project", status_id: 5 },
        { id: 2, name: "Omega Project A", status_id: 6 },
        { id: 3, name: "Omega Project B", status_id: 6 },
        { id: 4, name: "Completed Project", status_id: 4 },
      ],
    });
    const getProject = vi.fn().mockImplementation((id) => {
      const row = { id, name: id === 2 ? "Omega Project A" : "Omega Project B", status_id: 6 };
      return Promise.resolve(row);
    });
    const getRFIs = vi.fn().mockResolvedValue({ data: [] });
    const getTasks = vi.fn().mockResolvedValue({ data: [] });
    const getPurchaseOrders = vi.fn().mockResolvedValue({ data: [] });
    const getChangeOrders = vi.fn().mockResolvedValue({ data: [] });
    const getFinancialStatements = vi.fn().mockResolvedValue({ statusCount: {}, statements: [] });
    const api = fakeApi({
      getProjects: getProjects as any,
      getProject: getProject as any,
      getRFIs: getRFIs as any,
      getTasks: getTasks as any,
      getPurchaseOrders: getPurchaseOrders as any,
      getChangeOrders: getChangeOrders as any,
      getFinancialStatements: getFinancialStatements as any,
    });
    const result = await projectStatusBriefTool.handler({ team: "Omega" }, api);
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("Omega Project A");
    expect(text).toContain("Omega Project B");
    expect(text).not.toContain("Nexus Project");
    expect(text).not.toContain("Completed Project");
  });

  it("team='all_active' includes 5, 6, 7, 8", async () => {
    const getProjects = vi.fn().mockResolvedValue({
      data: [
        { id: 1, name: "Nexus", status_id: 5 },
        { id: 2, name: "Omega", status_id: 6 },
        { id: 3, name: "Invicta", status_id: 7 },
        { id: 4, name: "Alpha", status_id: 8 },
        { id: 5, name: "OnHold", status_id: 2 },
      ],
    });
    const getProject = vi.fn().mockImplementation((id) => Promise.resolve({ id, name: `Proj ${id}`, status_id: 5 }));
    const stubEmpty = vi.fn().mockResolvedValue({ data: [] });
    const api = fakeApi({
      getProjects: getProjects as any,
      getProject: getProject as any,
      getRFIs: stubEmpty as any,
      getTasks: stubEmpty as any,
      getPurchaseOrders: stubEmpty as any,
      getChangeOrders: stubEmpty as any,
      getFinancialStatements: vi.fn().mockResolvedValue({ statusCount: {}, statements: [] }) as any,
    });
    const result = await projectStatusBriefTool.handler({ team: "all_active" }, api);
    const text = textOf(result);
    // Should brief 4 projects (5/6/7/8), not OnHold (2)
    const projectHeaders = text.match(/^## #\d+/gm) ?? [];
    expect(projectHeaders.length).toBe(4);
  });

  it("team filter with no matches returns 'No active projects matched' message", async () => {
    const getProjects = vi.fn().mockResolvedValue({
      data: [{ id: 1, name: "OnHold", status_id: 2 }],
    });
    const api = fakeApi({ getProjects: getProjects as any });
    const result = await projectStatusBriefTool.handler({ team: "Omega" }, api);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("No active projects matched");
  });

  it("getProjects failure surfaces as clean error before fanout", async () => {
    const getProjects = vi.fn().mockRejectedValue(new Error("BT 500"));
    const api = fakeApi({ getProjects: getProjects as any });
    const result = await projectStatusBriefTool.handler({ team: "Omega" }, api);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Could not list projects");
    expect(textOf(result)).toContain("BT 500");
  });
});
