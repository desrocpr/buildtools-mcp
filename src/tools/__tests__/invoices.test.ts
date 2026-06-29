import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BuildToolsAPI } from "../../client/BuildToolsAPI.js";
import { invoiceTools, uncollectedInvoicesTool, __test__ } from "../invoices.js";

interface FakeApiOverrides {
  getProject?: BuildToolsAPI["getProject"];
  getProjects?: BuildToolsAPI["getProjects"];
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

describe("uncollected_invoices — tool registration", () => {
  it("is exported in invoiceTools", () => {
    expect(invoiceTools).toContain(uncollectedInvoicesTool);
    expect(uncollectedInvoicesTool.name).toBe("uncollected_invoices");
    expect(uncollectedInvoicesTool.permission).toBe("read:projects");
  });
});

describe("uncollected_invoices — date helpers", () => {
  const { parseSentDate, daysBetween } = __test__;

  it("parses MM/DD/YYYY", () => {
    const d = parseSentDate("03/12/2026");
    expect(d?.getFullYear()).toBe(2026);
    expect(d?.getMonth()).toBe(2);
    expect(d?.getDate()).toBe(12);
  });
  it("returns null for malformed dates", () => {
    expect(parseSentDate("")).toBeNull();
    expect(parseSentDate("2026-03-12")).toBeNull();
    expect(parseSentDate("3/12/26")).toBeNull();
  });
  it("daysBetween", () => {
    expect(daysBetween(new Date(2026, 6, 10), new Date(2026, 6, 3))).toBe(7);
  });
});

describe("uncollected_invoices — end-to-end", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-28T12:00:00Z"));
  });
  afterEach(() => { vi.useRealTimers(); });

  it("filters to Sent/Partial/Partly Paid/To Pay with balance > 0 and ages by sent_date", async () => {
    const getProject = vi.fn().mockResolvedValue({ id: 1, name: "Test Project", status_id: 6 });
    const getFinancialStatements = vi.fn().mockResolvedValue({
      statusCount: {},
      statements: [
        // Sent + balance > 0 → INCLUDED, age 30 days
        { id: "1", name: "PP3 - Engineering", status: "Sent", amount: 50000, paid: 0, balance: 50000, date: "05/29/2026", sent_date: "05/29/2026" },
        // Partly Paid + balance > 0 → INCLUDED, age 7 days
        { id: "2", name: "Construction Start", status: "Partly Paid", amount: 100000, paid: 80000, balance: 20000, date: "06/21/2026", sent_date: "06/21/2026" },
        // Paid → EXCLUDED (collected)
        { id: "3", name: "Deposit", status: "Paid", amount: 5000, paid: 5000, balance: 0, date: "04/01/2026", sent_date: "04/01/2026" },
        // Draft → EXCLUDED (not sent)
        { id: "4", name: "PP4 - Future", status: "Draft", amount: 25000, paid: 0, balance: 25000, date: "08/01/2026", sent_date: "" },
        // Sent + balance == 0 → EXCLUDED (fully paid, no AR)
        { id: "5", name: "Old PP", status: "Sent", amount: 1000, paid: 1000, balance: 0, date: "01/01/2026", sent_date: "01/01/2026" },
      ],
    });
    const api = fakeApi({
      getProject: getProject as any,
      getFinancialStatements: getFinancialStatements as any,
    });
    const result = await uncollectedInvoicesTool.handler({ project_ids: [1] }, api);
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("# Uncollected invoices");
    // Headline total: $50k + $20k = $70k
    expect(text).toContain("**$70,000.00 outstanding** across 2 invoice(s)");
    // PP3 Engineering — included
    expect(text).toContain("PP3 - Engineering");
    expect(text).toContain("**$50,000.00**");
    // Construction Start (Partly Paid) — included
    expect(text).toContain("Construction Start");
    expect(text).toContain("**$20,000.00**");
    // Paid, Draft, zero-balance excluded
    expect(text).not.toContain("Deposit");
    expect(text).not.toContain("PP4 - Future");
    expect(text).not.toContain("Old PP");
  });

  it("window_days caps to recently-sent only", async () => {
    const getProject = vi.fn().mockResolvedValue({ id: 1, name: "Test", status_id: 6 });
    const getFinancialStatements = vi.fn().mockResolvedValue({
      statusCount: {},
      statements: [
        // 100 days old — EXCLUDED at window_days=30
        { id: "1", name: "Old invoice", status: "Sent", amount: 10000, paid: 0, balance: 10000, date: "03/20/2026", sent_date: "03/20/2026" },
        // 7 days old — INCLUDED
        { id: "2", name: "Recent invoice", status: "Sent", amount: 5000, paid: 0, balance: 5000, date: "06/21/2026", sent_date: "06/21/2026" },
      ],
    });
    const api = fakeApi({
      getProject: getProject as any,
      getFinancialStatements: getFinancialStatements as any,
    });
    const result = await uncollectedInvoicesTool.handler({ project_ids: [1], window_days: 30 }, api);
    const text = textOf(result);
    expect(text).toContain("sent within last 30 day(s)");
    expect(text).toContain("Recent invoice");
    expect(text).not.toContain("Old invoice");
  });

  it("requires exactly one of project_ids or team", async () => {
    const api = fakeApi();
    const result = await uncollectedInvoicesTool.handler({}, api);
    expect(result.isError).toBeTruthy();
    expect(textOf(result)).toContain("Exactly one of");
  });

  it("empty result renders the all-clear message", async () => {
    const getProject = vi.fn().mockResolvedValue({ id: 1, name: "Test", status_id: 6 });
    const getFinancialStatements = vi.fn().mockResolvedValue({
      statusCount: {},
      statements: [
        { id: "1", name: "Paid invoice", status: "Paid", amount: 1000, paid: 1000, balance: 0, date: "06/01/2026", sent_date: "06/01/2026" },
      ],
    });
    const api = fakeApi({
      getProject: getProject as any,
      getFinancialStatements: getFinancialStatements as any,
    });
    const result = await uncollectedInvoicesTool.handler({ project_ids: [1] }, api);
    const text = textOf(result);
    expect(text).toContain("No uncollected invoices found");
  });
});
