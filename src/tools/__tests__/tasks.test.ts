/**
 * Unit tests for `src/tools/tasks.ts` (MOS-293).
 *
 * These tests exercise the tool handlers with a hand-rolled stub for
 * `BuildToolsAPI`. We do NOT instantiate the real class — handlers must not
 * depend on `loadConfigFromEnv()`, must not hit the network, and must not
 * require live credentials.
 *
 * Coverage per the planner contract (criterion 16):
 *   (a) registry exports both tools in order
 *   (b) list_tasks happy path Markdown shape (incl. stripHtml on assigned_to)
 *   (c) list_tasks passes `columns[1][search][value]: "2"` when status is "In Progress"
 *   (d) list_tasks passes `search[value]` when project_name is given
 *   (e) list_tasks returns plain Markdown on empty data (no isError)
 *   (f) list_tasks returns isError: true on BuildToolsError
 *   (g) list_tasks returns isError: true on Zod-invalid status
 *   (h) search_tasks happy path calls searchTasks(query, 20)
 *   (i) search_tasks rejects query of length < 2
 */

import { describe, expect, it, vi } from "vitest";

import type { BuildToolsAPI } from "../../client/BuildToolsAPI.js";
import {
  BuildToolsAuthError,
  BuildToolsServerError,
} from "../../client/errors.js";

import {
  listTasksTool,
  searchTasksTool,
  taskTools,
} from "../tasks.js";
import { type ToolResult } from "../projects.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeApi(overrides: {
  getTasks?: BuildToolsAPI["getTasks"];
  searchTasks?: BuildToolsAPI["searchTasks"];
}): BuildToolsAPI {
  return overrides as unknown as BuildToolsAPI;
}

function textOf(result: ToolResult): string {
  return result.content.map((c) => c.text).join("");
}

// Sample row matches the 16-column shape from
// src/client/__tests__/fixtures/tasks.json — the `assigned_to` field is
// wrapped in a <div class="text-truncate" title="..."> tooltip on the wire.
const sampleTaskRow = {
  DT_RowId: "row_600001",
  status: 1,
  comments_status: 1,
  items_status: 1,
  recurrence_status: 1,
  email_status: 1601,
  email_status_label: "Untracked",
  project: "Doe Bathroom",
  name: "Permits",
  category_id: 0,
  due_date: "09/24/2025",
  assigned_to:
    '<div class="text-truncate" title="Sam Worker">Sam Worker</div>',
  location: "Master Bathroom",
  priority: 1,
  id: 600001,
  linked_schedule: {
    linkedSchedule: false,
    scheduleType: "",
    scheduleTask: "",
  },
};

const sampleInProgressTaskRow = {
  DT_RowId: "row_600002",
  id: 600002,
  status: 2,
  project: "Smith Pool House",
  name: "Frame walls",
  due_date: "10/15/2025",
  assigned_to:
    '<div class="text-truncate" title="Jordan Carpenter">Jordan Carpenter</div>',
  location: "Cabana",
  priority: 2,
};

// ---------------------------------------------------------------------------
// Registry sanity
// ---------------------------------------------------------------------------

describe("taskTools registry", () => {
  it("exports exactly two tools with the contract-mandated names in order", () => {
    const names = taskTools.map((t) => t.name);
    expect(names).toEqual(["list_tasks", "search_tasks"]);
  });

  it("each tool exposes a JSON Schema for its input", () => {
    for (const tool of taskTools) {
      expect(tool.inputSchema).toBeDefined();
      const schema = tool.inputSchema as { type?: string };
      expect(schema.type).toBe("object");
    }
  });
});

// ---------------------------------------------------------------------------
// list_tasks
// ---------------------------------------------------------------------------

describe("list_tasks", () => {
  it("returns Markdown list rows on the happy path with HTML stripped from assigned_to", async () => {
    const getTasks = vi.fn().mockResolvedValue({
      data: [sampleTaskRow],
      recordsTotal: 1,
      recordsFiltered: 1,
    });
    const api = fakeApi({
      getTasks: getTasks as BuildToolsAPI["getTasks"],
    });

    const result = await listTasksTool.handler({}, api);

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("**1 task**");
    expect(text).toContain("#600001");
    expect(text).toContain("[Open]");
    expect(text).toContain("Permits");
    expect(text).toContain("Doe Bathroom");
    // assigned_to must be HTML-stripped — no <div> markup in output.
    expect(text).toContain("Sam Worker");
    expect(text).not.toContain("<div");
    expect(text).not.toContain("text-truncate");
    expect(text).toContain("09/24/2025");
    expect(text).toContain("Normal");
    expect(text).toContain("Master Bathroom");
    // linked_schedule must NOT be rendered.
    expect(text).not.toContain("linked_schedule");
    expect(text).not.toContain("linkedSchedule");
    expect(getTasks).toHaveBeenCalledTimes(1);
  });

  it('passes columns[1][search][value]="2" when status is "In Progress"', async () => {
    const getTasks = vi.fn().mockResolvedValue({
      data: [sampleInProgressTaskRow],
    });
    const api = fakeApi({
      getTasks: getTasks as BuildToolsAPI["getTasks"],
    });

    await listTasksTool.handler({ status: "In Progress" }, api);

    const callArgs = getTasks.mock.calls[0][0];
    expect(callArgs).toMatchObject({
      length: 50,
      "columns[1][search][value]": "2",
    });
  });

  it('passes columns[1][search][value]="1" when status is "Open"', async () => {
    const getTasks = vi.fn().mockResolvedValue({ data: [sampleTaskRow] });
    const api = fakeApi({
      getTasks: getTasks as BuildToolsAPI["getTasks"],
    });

    await listTasksTool.handler({ status: "Open" }, api);

    const callArgs = getTasks.mock.calls[0][0];
    expect(callArgs["columns[1][search][value]"]).toBe("1");
  });

  it('passes columns[1][search][value]="3" when status is "Complete"', async () => {
    const getTasks = vi.fn().mockResolvedValue({ data: [] });
    const api = fakeApi({
      getTasks: getTasks as BuildToolsAPI["getTasks"],
    });

    await listTasksTool.handler({ status: "Complete" }, api);

    const callArgs = getTasks.mock.calls[0][0];
    expect(callArgs["columns[1][search][value]"]).toBe("3");
  });

  it('emits NO status filter when status is "All" (the default)', async () => {
    const getTasks = vi.fn().mockResolvedValue({ data: [sampleTaskRow] });
    const api = fakeApi({
      getTasks: getTasks as BuildToolsAPI["getTasks"],
    });

    await listTasksTool.handler({}, api);

    const callArgs = getTasks.mock.calls[0][0];
    expect(callArgs["columns[1][search][value]"]).toBeUndefined();
  });

  it("forwards project_name via the datatable's search[value]", async () => {
    const getTasks = vi.fn().mockResolvedValue({ data: [sampleTaskRow] });
    const api = fakeApi({
      getTasks: getTasks as BuildToolsAPI["getTasks"],
    });

    await listTasksTool.handler({ project_name: "Doe" }, api);

    const callArgs = getTasks.mock.calls[0][0];
    expect(callArgs).toMatchObject({
      length: 50,
      "search[value]": "Doe",
    });
  });

  it("honours an explicit limit value", async () => {
    const getTasks = vi.fn().mockResolvedValue({ data: [sampleTaskRow] });
    const api = fakeApi({
      getTasks: getTasks as BuildToolsAPI["getTasks"],
    });

    await listTasksTool.handler({ limit: 25 }, api);

    const callArgs = getTasks.mock.calls[0][0];
    expect(callArgs.length).toBe(25);
  });

  it("returns a Markdown 'no tasks matched' message when result is empty (no isError)", async () => {
    const getTasks = vi.fn().mockResolvedValue({ data: [] });
    const api = fakeApi({
      getTasks: getTasks as BuildToolsAPI["getTasks"],
    });

    const result = await listTasksTool.handler(
      { project_name: "zzz" },
      api,
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/No tasks matched/);
    expect(textOf(result)).toContain('project_name: "zzz"');
  });

  it("handles a null datatable envelope gracefully (treats as empty)", async () => {
    const getTasks = vi.fn().mockResolvedValue(null);
    const api = fakeApi({
      getTasks: getTasks as BuildToolsAPI["getTasks"],
    });

    const result = await listTasksTool.handler({}, api);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/No tasks matched/);
  });

  it("returns Markdown error content (isError: true) on BuildToolsError", async () => {
    const getTasks = vi
      .fn()
      .mockRejectedValue(new BuildToolsAuthError("Not authenticated"));
    const api = fakeApi({
      getTasks: getTasks as BuildToolsAPI["getTasks"],
    });

    const result = await listTasksTool.handler({}, api);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Not authenticated");
    expect(textOf(result)).toContain("BuildToolsAuthError");
  });

  it("returns Markdown error content (isError: true) on Zod-invalid status", async () => {
    const result = await listTasksTool.handler(
      // "Cancelled" is not a valid task status enum value
      { status: "Cancelled" },
      fakeApi({}),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid input for `list_tasks`");
    expect(textOf(result)).toContain("status");
  });

  it("returns Markdown error content (isError: true) on Zod-invalid limit", async () => {
    const result = await listTasksTool.handler(
      { limit: 9999 },
      fakeApi({}),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid input for `list_tasks`");
    expect(textOf(result)).toContain("limit");
  });

  it("renders missing optional fields as em-dashes rather than throwing", async () => {
    const getTasks = vi.fn().mockResolvedValue({
      data: [{ id: 7, name: "Sparse" }],
    });
    const api = fakeApi({
      getTasks: getTasks as BuildToolsAPI["getTasks"],
    });

    const result = await listTasksTool.handler({}, api);
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("#7");
    expect(text).toContain("Sparse");
    expect(text).toContain("—");
  });
});

// ---------------------------------------------------------------------------
// search_tasks
// ---------------------------------------------------------------------------

describe("search_tasks", () => {
  it("calls searchTasks(query, 20) on the happy path", async () => {
    const searchTasks = vi
      .fn()
      .mockResolvedValue({ data: [sampleTaskRow] });
    const api = fakeApi({
      searchTasks: searchTasks as BuildToolsAPI["searchTasks"],
    });

    const result = await searchTasksTool.handler({ query: "Permits" }, api);

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain('**1 match** for "Permits"');
    expect(text).toContain("Permits");
    expect(searchTasks).toHaveBeenCalledWith("Permits", 20);
  });

  it("returns a Markdown 'no matches' message when result is empty (no isError)", async () => {
    const searchTasks = vi.fn().mockResolvedValue({ data: [] });
    const api = fakeApi({
      searchTasks: searchTasks as BuildToolsAPI["searchTasks"],
    });

    const result = await searchTasksTool.handler({ query: "zzz" }, api);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('No tasks matched query "zzz"');
  });

  it("returns Markdown error content (isError: true) on BuildToolsError", async () => {
    const searchTasks = vi
      .fn()
      .mockRejectedValue(
        new BuildToolsServerError("Internal server error", { status: 500 }),
      );
    const api = fakeApi({
      searchTasks: searchTasks as BuildToolsAPI["searchTasks"],
    });

    const result = await searchTasksTool.handler({ query: "anything" }, api);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Internal server error");
    expect(textOf(result)).toContain("BuildToolsServerError");
  });

  it("rejects a query shorter than 2 characters (Zod min length)", async () => {
    const result = await searchTasksTool.handler({ query: "a" }, fakeApi({}));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid input for `search_tasks`");
    expect(textOf(result)).toContain("query");
  });

  it("rejects a missing query (Zod required)", async () => {
    const result = await searchTasksTool.handler({}, fakeApi({}));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("query");
  });
});
