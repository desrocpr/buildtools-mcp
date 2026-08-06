/**
 * Unit tests for `src/tools/projects.ts` (MOS-214).
 *
 * These tests exercise the tool handlers with a hand-rolled stub for
 * `BuildToolsAPI`. We do NOT instantiate the real class — these handlers must
 * not depend on `loadConfigFromEnv()` reading process env, must not hit the
 * network, and must not require live credentials.
 *
 * Coverage per the planner contract (criterion 14):
 *   (a) happy-path Markdown shape
 *   (b) empty result
 *   (c) API-error path returns Markdown error content with isError: true
 *   (d) Zod-invalid input returns Markdown error content with isError: true
 */

import { describe, expect, it, vi } from "vitest";

import type { OperationsManagementApi } from "../../operations/types.js";
import {
  BuildToolsAuthError,
  BuildToolsServerError,
} from "../../client/errors.js";

import {
  getProjectTool,
  listProjectsTool,
  projectTools,
  type ToolContext,
  type ToolResult,
} from "../projects.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake tool context.
 *
 * These handlers now read through the neutral operations interface (MOS-747),
 * so the stubs hang off `ops` rather than off the vendor client. The cast is
 * intentional — we stub exactly the surface this module uses, not the whole
 * interface.
 */
function fakeApi(overrides: {
  getProjects?: OperationsManagementApi["getProjects"];
  getProject?: OperationsManagementApi["getProject"];
}): ToolContext {
  return { ops: overrides } as unknown as ToolContext;
}

function textOf(result: ToolResult): string {
  return result.content.map((c) => "text" in c ? c.text : "").join("");
}

const sampleListRow = {
  DT_RowId: "row_100002",
  id: 100002,
  status: 6,
  name: "Jones Addition",
  managers:
    '<div title="Project Manager A">Project Manager A</div>',
  address: "456 Elm Ave",
  city: "Springfield",
  state: "VA",
  budget_revised: "$ 245,500.50",
};

const sampleDetail = {
  id: 100002,
  name: "Jones Addition",
  status: "6",
  address: "456 Elm Ave",
  city: "Springfield",
  state: "VA",
  zip: "22030",
  country_code: "US",
  description: "Two-story addition over existing garage with new master suite.",
  budget_revised: "$ 245,500.50",
  created_at: "01/15/2026",
  updated_at: "04/30/2026",
  managers: ["Project Manager A"],
  client_ids: [200001],
};

// ---------------------------------------------------------------------------
// Registry sanity
// ---------------------------------------------------------------------------

describe("projectTools registry", () => {
  it("exports exactly three tools with the contract-mandated names", () => {
    const names = projectTools.map((t) => t.name).sort();
    expect(names).toEqual(["get_project", "list_projects"]);
  });

  it("each tool exposes a JSON Schema for its input", () => {
    for (const tool of projectTools) {
      expect(tool.inputSchema).toBeDefined();
      // zod-to-json-schema produces an object with a `type` field at the top.
      const schema = tool.inputSchema as { type?: string };
      expect(schema.type).toBe("object");
    }
  });
});

// ---------------------------------------------------------------------------
// list_projects
// ---------------------------------------------------------------------------

describe("list_projects", () => {
  it("returns Markdown list rows on the happy path", async () => {
    const getProjects = vi.fn().mockResolvedValue({
      data: [sampleListRow],
      recordsTotal: 1,
      recordsFiltered: 1,
    });
    const api = fakeApi({ getProjects: getProjects as OperationsManagementApi["getProjects"] });

    const result = await listProjectsTool.handler({ status: "Active" }, api);

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("**1 project**");
    expect(text).toContain("#100002");
    expect(text).toContain("[Omega]");
    expect(text).toContain("Jones Addition");
    expect(text).toContain("Springfield, VA");
    expect(text).toContain("$ 245,500.50");
    // "Active" maps to codes [5,6,7,8]. The tool now names the FACET; encoding
    // those into a pipe-joined DataTables column filter is the adapter's job
    // (operations/adapters/buildtools/query.ts), not this handler's.
    expect(getProjects).toHaveBeenCalledTimes(1);
    const callArgs = getProjects.mock.calls[0][0];
    expect(callArgs).toMatchObject({
      limit: 50,
      status: [5, 6, 7, 8],
    });
  });

  it("passes a neutral search facet and respects custom limit", async () => {
    const getProjects = vi.fn().mockResolvedValue({ data: [sampleListRow] });
    const api = fakeApi({ getProjects: getProjects as OperationsManagementApi["getProjects"] });

    await listProjectsTool.handler(
      { status: "All", query: "Jones", limit: 10 },
      api,
    );

    const callArgs = getProjects.mock.calls[0][0];
    expect(callArgs).toMatchObject({
      limit: 10,
      search: "Jones",
    });
    // "All" status means no status filter at all.
    expect(callArgs.status).toBeUndefined();
  });

  it("returns a Markdown 'no matches' message when the result is empty", async () => {
    const getProjects = vi.fn().mockResolvedValue({ data: [] });
    const api = fakeApi({ getProjects: getProjects as OperationsManagementApi["getProjects"] });

    const result = await listProjectsTool.handler({}, api);

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/No projects matched/);
  });

  it("returns Markdown error content (isError: true) on BuildToolsError", async () => {
    const getProjects = vi
      .fn()
      .mockRejectedValue(new BuildToolsAuthError("Not authenticated"));
    const api = fakeApi({ getProjects: getProjects as OperationsManagementApi["getProjects"] });

    const result = await listProjectsTool.handler({}, api);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Not authenticated");
    expect(textOf(result)).toContain("BuildToolsAuthError");
  });

  it("returns Markdown error content (isError: true) on Zod-invalid input", async () => {
    // status must be one of the enum literals; "Pending" is not allowed.
    const result = await listProjectsTool.handler(
      { status: "Pending" },
      fakeApi({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid input for `list_projects`");
    expect(textOf(result)).toContain("status");
  });

  it("rejects limit outside the 1–200 range via Zod", async () => {
    const result = await listProjectsTool.handler({ limit: 500 }, fakeApi({}));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("limit");
  });

  it("handles a null datatable envelope gracefully (treats as empty)", async () => {
    const getProjects = vi.fn().mockResolvedValue(null);
    const api = fakeApi({ getProjects: getProjects as OperationsManagementApi["getProjects"] });
    const result = await listProjectsTool.handler({}, api);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/No projects matched/);
  });
});

// ---------------------------------------------------------------------------
// get_project
// ---------------------------------------------------------------------------

describe("get_project", () => {
  it("renders a structured Markdown detail view on the happy path", async () => {
    const getProject = vi.fn().mockResolvedValue(sampleDetail);
    const api = fakeApi({ getProject: getProject as OperationsManagementApi["getProject"] });

    const result = await getProjectTool.handler({ project_id: 100002 }, api);

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("## Project #100002 — Jones Addition");
    expect(text).toContain("- **Status**: Omega");
    expect(text).toContain("- **Contract value**: $ 245,500.50");
    expect(text).toContain("456 Elm Ave");
    expect(text).toContain("Springfield, VA");
    expect(text).toContain("Project Manager A");
    expect(text).toContain("#200001");
    expect(text).toContain("### Description");
    expect(getProject).toHaveBeenCalledWith(100002);
  });

  it("returns a Markdown 'not found' message when the client returns null", async () => {
    const getProject = vi.fn().mockResolvedValue(null);
    const api = fakeApi({ getProject: getProject as OperationsManagementApi["getProject"] });

    const result = await getProjectTool.handler({ project_id: 999 }, api);

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("No project found with ID #999");
  });

  it("renders missing fields as em-dashes rather than throwing", async () => {
    const getProject = vi
      .fn()
      .mockResolvedValue({ id: 1, name: "Tiny project" });
    const api = fakeApi({ getProject: getProject as OperationsManagementApi["getProject"] });

    const result = await getProjectTool.handler({ project_id: 1 }, api);

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("Tiny project");
    expect(text).toContain("**Contract value**: —");
    expect(text).toContain("**Address**: —");
  });

  it("returns Markdown error content on BuildToolsError", async () => {
    const getProject = vi
      .fn()
      .mockRejectedValue(new BuildToolsServerError("Internal server error", { status: 500 }));
    const api = fakeApi({ getProject: getProject as OperationsManagementApi["getProject"] });

    const result = await getProjectTool.handler({ project_id: 7 }, api);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Internal server error");
  });

  it("returns Markdown error content (isError: true) on Zod-invalid input", async () => {
    // project_id must be a number.
    const result = await getProjectTool.handler(
      { project_id: "not-a-number" },
      fakeApi({}),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid input for `get_project`");
    expect(textOf(result)).toContain("project_id");
  });

  it("returns Markdown error content (isError: true) when project_id is missing", async () => {
    const result = await getProjectTool.handler({}, fakeApi({}));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("project_id");
  });
});

// ---------------------------------------------------------------------------
// search_projects
// ---------------------------------------------------------------------------

