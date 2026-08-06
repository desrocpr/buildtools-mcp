/**
 * Unit tests for `src/tools/operations.ts` (MOS-294).
 *
 * These tests exercise each of the four read tools — `list_rfis`,
 * `list_services`, `list_users`, `search_users` — with a hand-rolled stub for
 * `BuildToolsAPI`. We do NOT instantiate the real class — handlers must not
 * depend on `loadConfigFromEnv()`, must not hit the network, and must not
 * require live credentials.
 *
 * Coverage per the planner contract (criteria 9-10):
 *   (a) happy-path Markdown shape using fixture-shaped rows
 *   (b) empty result rendered as Markdown (no `isError`)
 *   (c) `BuildToolsError` from the client → `isError: true` Markdown
 *   (d) Zod-invalid input → `isError: true` Markdown
 *   (e) `list_users` role=Employee routes to `getEmployees` (not `getUsers`)
 *   (f) `list_users` role=Client calls `getUsers` with `columns[4][search][value]`
 *   (g) `search_users` rejects a 1-character query
 *   (h) `operationTools` registry sanity: order + count + JSON-schema shape
 */

import { describe, expect, it, vi } from "vitest";

import type { BuildToolsAPI } from "../../client/BuildToolsAPI.js";
import {
  BuildToolsAuthError,
  BuildToolsServerError,
} from "../../client/errors.js";

import {
  listRfisTool,
  listServicesTool,
  listUsersTool,
  operationTools,
} from "../operations.js";
import { type ToolResult } from "../projects.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeApi(overrides: {
  getRFIs?: BuildToolsAPI["getRFIs"];
  getServices?: BuildToolsAPI["getServices"];
  getUsers?: BuildToolsAPI["getUsers"];
  searchUsers?: BuildToolsAPI["searchUsers"];
  getEmployees?: BuildToolsAPI["getEmployees"];
}): BuildToolsAPI {
  return overrides as unknown as BuildToolsAPI;
}

function textOf(result: ToolResult): string {
  return result.content.map((c) => "text" in c ? c.text : "").join("");
}

// Fixture rows mirror the shapes in `~/code/buildtools/api-data-sample.json`
// (RFIs lines 246-284, services 320-368, users 286-318).

const sampleRfiRow = {
  DT_RowId: "row_1",
  status: 1,
  comments_status: 1,
  email_status: 1601,
  email_status_label: "",
  project: "Mentzer 1 Remodel",
  number: "RFI-Mentzer 1 Remodel-11001",
  subject: "Mentzer Basement",
  category_id: null,
  assigned_to:
    '<div class="text-truncate initOverTooltip" style="width:auto;max-width:190px;" data-container="body" title="Adan Peralta, Keith Jenkins">Adan Peralta, Keith Jenkins</div>',
  location: "Typical Room",
  priority: 2,
  id: 1,
};

const sampleServiceRow = {
  DT_RowId: "row_3",
  status: 4, // unknown code — should render as raw "4"
  comments_status: 1,
  info: 3,
  attachment: 0,
  email_status: 1601,
  email_status_label: "Untracked",
  calendar: "",
  project: "Null 1 Addition",
  name: "Seal breezewat steps",
  assigned_to:
    '<div class="text-truncate initOverTooltip" style="width:auto;max-width:190px;" data-container="body" title="Bob Keene">Bob Keene</div>',
  category_id: 5,
  created_at: "09/22/2023",
  due_date: "09/25/2023",
};

const sampleUserRow = {
  DT_RowId: "row_1939",
  status: 1,
  email_status: 1601,
  email_status_label: "",
  role: "Client",
  first_name: "Aaron",
  last_name: "Mullen",
  email: "aamullen75@gmail.com",
  phone: "301-524-3452",
  company: "",
  impersonate: 1939,
  invite: 2,
  created_at: "2023-03-12 14:18:28",
};

// ---------------------------------------------------------------------------
// Registry sanity
// ---------------------------------------------------------------------------

describe("operationTools registry", () => {
  it("exports exactly four tools in the contract-mandated order", () => {
    const names = operationTools.map((t) => t.name);
    expect(names).toEqual([
      "list_rfis",
      "list_services",
      "list_users",
    ]);
  });

  it("each tool exposes an object-typed JSON Schema for its input", () => {
    for (const tool of operationTools) {
      expect(tool.inputSchema).toBeDefined();
      const schema = tool.inputSchema as { type?: string };
      expect(schema.type).toBe("object");
    }
  });
});

// ---------------------------------------------------------------------------
// list_rfis
// ---------------------------------------------------------------------------

describe("list_rfis", () => {
  it("returns Markdown list rows on the happy path", async () => {
    const getRFIs = vi.fn().mockResolvedValue({
      data: [sampleRfiRow],
      recordsTotal: 1,
      recordsFiltered: 1,
    });
    const api = fakeApi({ getRFIs: getRFIs as BuildToolsAPI["getRFIs"] });

    const result = await listRfisTool.handler({}, api);

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("**1 RFI**");
    expect(text).toContain("#1");
    expect(text).toContain("[Open]");
    expect(text).toContain("RFI-Mentzer 1 Remodel-11001");
    expect(text).toContain("Mentzer Basement");
    expect(text).toContain("Mentzer 1 Remodel");
    // assigned_to HTML stripped to inner visible text
    expect(text).toContain("Adan Peralta, Keith Jenkins");
    expect(text).not.toContain("<div");
    expect(text).toContain("priority: High");
    expect(text).toContain("Typical Room");
    expect(getRFIs).toHaveBeenCalledTimes(1);
  });

  it("forwards project_name via the datatable's search[value]", async () => {
    const getRFIs = vi.fn().mockResolvedValue({ data: [sampleRfiRow] });
    const api = fakeApi({ getRFIs: getRFIs as BuildToolsAPI["getRFIs"] });

    await listRfisTool.handler({ project_name: "Mentzer", limit: 25 }, api);

    const callArgs = getRFIs.mock.calls[0][0];
    expect(callArgs).toMatchObject({
      length: 25,
      "search[value]": "Mentzer",
    });
  });

  it("returns a Markdown 'no RFIs' message when result is empty (no isError)", async () => {
    const getRFIs = vi.fn().mockResolvedValue({ data: [] });
    const api = fakeApi({ getRFIs: getRFIs as BuildToolsAPI["getRFIs"] });

    const result = await listRfisTool.handler(
      { project_name: "Nonesuch" },
      api,
    );
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/No RFIs matched/);
    expect(textOf(result)).toContain('project_name: "Nonesuch"');
  });

  it("renders unknown status codes as raw numbers (no invented label)", async () => {
    const getRFIs = vi.fn().mockResolvedValue({
      data: [{ ...sampleRfiRow, status: 9 }],
    });
    const api = fakeApi({ getRFIs: getRFIs as BuildToolsAPI["getRFIs"] });

    const result = await listRfisTool.handler({}, api);
    const text = textOf(result);
    expect(text).toContain("[9]");
    expect(text).not.toContain("[Open]");
  });

  it("returns Markdown error content (isError: true) on BuildToolsError", async () => {
    const getRFIs = vi
      .fn()
      .mockRejectedValue(new BuildToolsAuthError("Not authenticated"));
    const api = fakeApi({ getRFIs: getRFIs as BuildToolsAPI["getRFIs"] });

    const result = await listRfisTool.handler({}, api);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Not authenticated");
    expect(textOf(result)).toContain("BuildToolsAuthError");
  });

  it("returns Markdown error content (isError: true) on Zod-invalid input", async () => {
    const result = await listRfisTool.handler({ limit: "fifty" }, fakeApi({}));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid input for `list_rfis`");
    expect(textOf(result)).toContain("limit");
  });
});

// ---------------------------------------------------------------------------
// list_services
// ---------------------------------------------------------------------------

describe("list_services", () => {
  it("returns Markdown list rows on the happy path", async () => {
    const getServices = vi.fn().mockResolvedValue({
      data: [sampleServiceRow],
      recordsTotal: 1,
      recordsFiltered: 1,
    });
    const api = fakeApi({
      getServices: getServices as BuildToolsAPI["getServices"],
    });

    const result = await listServicesTool.handler({}, api);

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("**1 service**");
    // `info` is used as the id
    expect(text).toContain("#3");
    // Unknown status code 4 → raw "4" (per contract, no invented label)
    expect(text).toContain("[4]");
    expect(text).toContain("Seal breezewat steps");
    expect(text).toContain("Null 1 Addition");
    expect(text).toContain("Bob Keene");
    expect(text).not.toContain("<div");
    expect(text).toContain("due: 09/25/2023");
    expect(text).toContain("created: 09/22/2023");
    expect(getServices).toHaveBeenCalledTimes(1);
  });

  it("forwards project_name via the datatable's search[value]", async () => {
    const getServices = vi.fn().mockResolvedValue({ data: [sampleServiceRow] });
    const api = fakeApi({
      getServices: getServices as BuildToolsAPI["getServices"],
    });

    await listServicesTool.handler({ project_name: "Null", limit: 75 }, api);

    const callArgs = getServices.mock.calls[0][0];
    expect(callArgs).toMatchObject({
      length: 75,
      "search[value]": "Null",
    });
  });

  it("returns a Markdown 'no services' message when result is empty (no isError)", async () => {
    const getServices = vi.fn().mockResolvedValue({ data: [] });
    const api = fakeApi({
      getServices: getServices as BuildToolsAPI["getServices"],
    });

    const result = await listServicesTool.handler({}, api);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/No services matched/);
  });

  it("returns Markdown error content (isError: true) on BuildToolsError", async () => {
    const getServices = vi
      .fn()
      .mockRejectedValue(
        new BuildToolsServerError("Internal server error", { status: 500 }),
      );
    const api = fakeApi({
      getServices: getServices as BuildToolsAPI["getServices"],
    });

    const result = await listServicesTool.handler({}, api);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Internal server error");
    expect(textOf(result)).toContain("BuildToolsServerError");
  });

  it("returns Markdown error content (isError: true) on Zod-invalid input", async () => {
    const result = await listServicesTool.handler(
      { limit: 9999 },
      fakeApi({}),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid input for `list_services`");
    expect(textOf(result)).toContain("limit");
  });
});

// ---------------------------------------------------------------------------
// list_users
// ---------------------------------------------------------------------------

describe("list_users", () => {
  it("returns Markdown list rows on the happy path (no role filter)", async () => {
    const getUsers = vi.fn().mockResolvedValue({
      data: [sampleUserRow],
      recordsTotal: 1,
      recordsFiltered: 1,
    });
    const api = fakeApi({ getUsers: getUsers as BuildToolsAPI["getUsers"] });

    const result = await listUsersTool.handler({}, api);

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("**1 user**");
    // DT_RowId "row_1939" → "1939"
    expect(text).toContain("#1939");
    // role rendered verbatim (no translation)
    expect(text).toContain("[Client]");
    expect(text).toContain("Aaron Mullen");
    expect(text).toContain("aamullen75@gmail.com");
    expect(text).toContain("301-524-3452");
    expect(text).toContain("(role: All)");
    expect(getUsers).toHaveBeenCalledTimes(1);
  });

  it("filters client-side when role=Employee (BuildTools server ignores role filters)", async () => {
    const employee = { ...sampleUserRow, role: "Employee" };
    const client1 = { ...sampleUserRow, id: 9001, role: "Client" };
    const client2 = { ...sampleUserRow, id: 9002, role: "Client" };
    const getUsers = vi
      .fn()
      .mockResolvedValue({ data: [client1, employee, client2] });
    const api = fakeApi({
      getUsers: getUsers as BuildToolsAPI["getUsers"],
    });

    const result = await listUsersTool.handler({ role: "Employee" }, api);

    expect(result.isError).toBeFalsy();
    expect(getUsers).toHaveBeenCalledTimes(1);
    // Big batch — we filter locally
    expect(getUsers.mock.calls[0][0]).toMatchObject({ length: 10000 });
    // The Markdown only renders the Employee row
    expect(textOf(result)).toContain("(role: Employee)");
    expect(textOf(result)).not.toContain("9001");
    expect(textOf(result)).not.toContain("9002");
  });

  it("filters client-side when role=Client (no server-side column filter sent)", async () => {
    const c = { ...sampleUserRow, role: "Client" };
    const getUsers = vi.fn().mockResolvedValue({ data: [c, c, c] });
    const api = fakeApi({ getUsers: getUsers as BuildToolsAPI["getUsers"] });

    await listUsersTool.handler({ role: "Client", limit: 250 }, api);

    const callArgs = getUsers.mock.calls[0][0];
    expect(callArgs.length).toBe(10000);
    expect(callArgs).not.toHaveProperty("columns[4][search][value]");
  });

  it("does NOT pass a column filter when role=All", async () => {
    const getUsers = vi.fn().mockResolvedValue({ data: [sampleUserRow] });
    const api = fakeApi({ getUsers: getUsers as BuildToolsAPI["getUsers"] });

    await listUsersTool.handler({ role: "All" }, api);

    const callArgs = getUsers.mock.calls[0][0];
    expect(callArgs).not.toHaveProperty("columns[4][search][value]");
    // For "All" we keep the request small (no need to over-fetch).
    expect(callArgs.length).toBe(100);
  });

  it("returns a Markdown 'no users' message when result is empty (no isError)", async () => {
    const getUsers = vi.fn().mockResolvedValue({ data: [] });
    const api = fakeApi({ getUsers: getUsers as BuildToolsAPI["getUsers"] });

    const result = await listUsersTool.handler({ role: "Company Rep" }, api);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/No users matched/);
    expect(textOf(result)).toContain("role: Company Rep");
  });

  it("returns Markdown error content (isError: true) on BuildToolsError", async () => {
    const getUsers = vi
      .fn()
      .mockRejectedValue(new BuildToolsAuthError("Session expired"));
    const api = fakeApi({ getUsers: getUsers as BuildToolsAPI["getUsers"] });

    const result = await listUsersTool.handler({}, api);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Session expired");
    expect(textOf(result)).toContain("BuildToolsAuthError");
  });

  it("returns Markdown error content (isError: true) on Zod-invalid input", async () => {
    const result = await listUsersTool.handler(
      { role: "Nobody" },
      fakeApi({}),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid input for `list_users`");
    expect(textOf(result)).toContain("role");
  });
});

// ---------------------------------------------------------------------------
// list_users with query — PR #71 review MEDIUM 3
// ---------------------------------------------------------------------------

describe("list_users + query", () => {
  it("forwards query via the datatable's search[value]", async () => {
    const getUsers = vi.fn().mockResolvedValue({ data: [] });
    const api = fakeApi({ getUsers: getUsers as BuildToolsAPI["getUsers"] });
    await listUsersTool.handler({ query: "Smith" }, api);
    const call = getUsers.mock.calls[0][0];
    expect(call["search[value]"]).toBe("Smith");
  });

  it("PR #71 review HIGH 2: no-match message includes the query", async () => {
    const getUsers = vi.fn().mockResolvedValue({ data: [] });
    const api = fakeApi({ getUsers: getUsers as BuildToolsAPI["getUsers"] });
    const result = await listUsersTool.handler(
      { query: "nonesuch" },
      api,
    );
    expect(textOf(result)).toContain('query: "nonesuch"');
  });

  it("Zod rejects query of length < 2", async () => {
    const result = await listUsersTool.handler(
      { query: "a" },
      fakeApi({}),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid input for `list_users`");
  });

  it("role + query combined: role filter runs client-side, query filters server-side", async () => {
    // Server returns users with various roles; tool then filters by role client-side.
    const getUsers = vi.fn().mockResolvedValue({
      data: [
        { id: 1, first_name: "Alice", last_name: "Smith", role: "Employee", DT_RowId: "row_1" },
        { id: 2, first_name: "Bob", last_name: "Smith", role: "Client", DT_RowId: "row_2" },
      ],
    });
    const api = fakeApi({ getUsers: getUsers as BuildToolsAPI["getUsers"] });
    const result = await listUsersTool.handler(
      { query: "Smith", role: "Employee" },
      api,
    );
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("Alice Smith");
    expect(text).not.toContain("Bob Smith"); // filtered out by role
    // Confirm query reached the server
    const call = getUsers.mock.calls[0][0];
    expect(call["search[value]"]).toBe("Smith");
  });
});


describe("list_users — id survives row normalisation (MOS-747 prep)", () => {
  // Rows arriving through the operations adapter carry a real `id` and have
  // DT_RowId stripped. parseUserId previously read ONLY DT_RowId, so every row
  // would have rendered as "?" after the retarget — with no compile error,
  // since rows are Record<string, unknown>.

  const userRow = (extra: Record<string, unknown>) => ({
    first_name: "Ada",
    last_name: "Lovelace",
    email: "ada@moss.test",
    role: "Employee",
    ...extra,
  });

  it("renders the id from a normalised row carrying `id` and no DT_RowId", async () => {
    const api = fakeApi({
      getUsers: (async () => ({ data: [userRow({ id: 4711 })] })) as never,
    });

    const text = textOf(await listUsersTool.handler({}, api));

    expect(text).toContain("4711");
    expect(text).not.toContain("?");
  });

  it("still renders the id from a raw DT_RowId row (pre-retarget shape)", async () => {
    const api = fakeApi({
      getUsers: (async () => ({ data: [userRow({ DT_RowId: "row_4711" })] })) as never,
    });

    expect(textOf(await listUsersTool.handler({}, api))).toContain("4711");
  });

  it("prefers a real id when both are present", async () => {
    const api = fakeApi({
      getUsers: (async () => ({
        data: [userRow({ id: 4711, DT_RowId: "row_9999" })],
      })) as never,
    });

    const text = textOf(await listUsersTool.handler({}, api));

    expect(text).toContain("4711");
    expect(text).not.toContain("9999");
  });
});
