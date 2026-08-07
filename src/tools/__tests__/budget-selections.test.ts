/**
 * Coverage for the budget and selections tools (MOS-747 Phase 3, slice 5).
 *
 * Neither file had ANY test before this. They were migrated onto the neutral
 * interface with no safety net, which is exactly the situation where a
 * mechanical retarget slips: the handlers still compile, still render, and
 * quietly read from nothing.
 *
 * These drive the real `MockOperationsApi` rather than a hand-stubbed object —
 * the mock is a first-class adapter, so a tool that works against it is a tool
 * that works against the interface, not against a bespoke fake shaped to fit.
 */

import { describe, expect, it } from "vitest";

import { MockOperationsApi } from "../../operations/adapters/mock.js";
import { listBudgetTool } from "../budget.js";
import type { ToolContext, ToolResult } from "../projects.js";
import {
  listAllowancesTool,
  listSelectionCategoriesTool,
  listSelectionsTool,
} from "../selections.js";

function ctxOf(mock: MockOperationsApi): ToolContext {
  return { ops: mock } as unknown as ToolContext;
}

function textOf(result: ToolResult): string {
  return result.content.map((c) => ("text" in c ? c.text : "")).join("");
}

const BUDGET = {
  columns: ["Category", "Published"],
  items: [
    {
      id: "b1",
      categoryId: "c1",
      name: "Tile Materials",
      isAllowance: true,
      publishedBudget: 1000,
      workingBudget: 1200,
      approvedCOs: 0,
      publishedRevised: 1000,
      workingRevised: 1200,
      cells: [],
    },
    {
      id: "b2",
      categoryId: "c2",
      name: "Framing Labor",
      isAllowance: false,
      publishedBudget: 5000,
      workingBudget: 5000,
      approvedCOs: 500,
      publishedRevised: 5500,
      workingRevised: 5500,
      cells: [],
    },
  ],
};

describe("list_budget", () => {
  it("reads through the operations interface and renders both items", async () => {
    const mock = new MockOperationsApi({ budget: { "42": BUDGET } });

    const text = textOf(await listBudgetTool.handler({ project_id: 42 }, ctxOf(mock)));

    expect(text).toContain("Tile Materials");
    expect(text).toContain("Framing Labor");
    expect(mock.calls.map((c) => c.method)).toContain("getBudget");
  });

  it("narrows to allowances when asked", async () => {
    const mock = new MockOperationsApi({ budget: { "42": BUDGET } });

    const text = textOf(
      await listBudgetTool.handler(
        { project_id: 42, allowances_only: true },
        ctxOf(mock),
      ),
    );

    expect(text).toContain("Tile Materials");
    expect(text).not.toContain("Framing Labor");
  });

  it("renders an empty-state rather than failing when a project has no budget", async () => {
    const mock = new MockOperationsApi();

    const result = await listBudgetTool.handler({ project_id: 99 }, ctxOf(mock));

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("No budget items");
  });

  it("rejects invalid input as Markdown rather than throwing to the SDK", async () => {
    const result = await listBudgetTool.handler({}, ctxOf(new MockOperationsApi()));

    expect(result.isError).toBe(true);
  });
});

describe("list_allowances", () => {
  it("returns only allowance lines, derived from the budget", async () => {
    // The mock derives allowances from the seeded budget the way both real
    // back ends do, so seeding one gives both.
    const mock = new MockOperationsApi({ budget: { "42": BUDGET } });

    const text = textOf(
      await listAllowancesTool.handler({ project_id: 42 }, ctxOf(mock)),
    );

    expect(text).toContain("Tile Materials");
    expect(text).not.toContain("Framing Labor");
  });
});

describe("list_selections", () => {
  it("reads through the operations interface", async () => {
    const mock = new MockOperationsApi({
      selections: {
        "42": {
          statusCount: { Approved: 1 },
          selections: [
            {
              id: "s1",
              statusCode: 3,
              status: "Approved",
              category: "Tile",
              location: "Bath",
              item: "Floor tile",
              price: "$ 1,200.00",
              dueDate: "01/02/2026",
              selection: "Carrara",
              notes: "",
              createdAt: null,
              updatedAt: null,
              approvedDate: null,
              rejectedDate: null,
            },
          ],
        },
      },
    });

    const text = textOf(
      await listSelectionsTool.handler({ project_id: 42 }, ctxOf(mock)),
    );

    expect(text).toContain("Floor tile");
    expect(mock.calls.map((c) => c.method)).toContain("getSelections");
  });

  it("renders an empty-state for a project with no selections", async () => {
    const result = await listSelectionsTool.handler(
      { project_id: 99 },
      ctxOf(new MockOperationsApi()),
    );

    expect(result.isError).toBeUndefined();
  });
});

describe("list_selection_categories", () => {
  it("reads categories through the interface", async () => {
    const mock = new MockOperationsApi({
      selectionCategories: { "42": [{ id: "1510", name: "Demolition" }] },
    });

    const text = textOf(
      await listSelectionCategoriesTool.handler({ project_id: 42 }, ctxOf(mock)),
    );

    expect(text).toContain("Demolition");
  });
});
