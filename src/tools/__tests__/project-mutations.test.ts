/**
 * Unit tests for `src/tools/project-mutations.ts` (MOS-218, Phase 5.1).
 *
 * Covers the six acceptance behaviors enumerated in the issue:
 *   1. First call (no confirmation_id) → confirmation prompt, no API mutation.
 *   2. Confirmed call (valid id) → API mutation runs, Markdown success.
 *   3. Confirmed call (unknown/expired id) → re-invoke prompt, no API.
 *   4. Confirmed call (id minted for another tool) → re-invoke prompt, no API.
 *   5. API failure during execute → Markdown error with isError, no stack.
 *   6. update_project with no diff fields → "no changes" Markdown WITHOUT
 *      minting a confirmation entry AND WITHOUT calling the API.
 *
 * Stubs `BuildToolsAPI` directly — no real client, no network, no env vars.
 */

import { describe, expect, it, vi } from "vitest";

import type { BuildToolsAPI } from "../../client/BuildToolsAPI.js";
import { BuildToolsServerError } from "../../client/errors.js";
import { ConfirmationStore } from "../../confirm/index.js";

import { buildProjectMutationTools } from "../project-mutations.js";
import type { ToolDefinition, ToolResult } from "../projects.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeApi(overrides: {
  getProject?: BuildToolsAPI["getProject"];
  createProject?: BuildToolsAPI["createProject"];
  updateProject?: BuildToolsAPI["updateProject"];
}): BuildToolsAPI {
  return overrides as unknown as BuildToolsAPI;
}

function textOf(result: ToolResult): string {
  return result.content.map((c) => c.text).join("");
}

function tools(): {
  store: ConfirmationStore;
  create: ToolDefinition;
  update: ToolDefinition;
} {
  const store = new ConfirmationStore();
  const [create, update] = buildProjectMutationTools(store);
  return { store, create, update };
}

const existingProject = {
  id: 100002,
  name: "Jones Addition",
  status: "1", // Active in our best-guess map
  address: "456 Elm Ave",
  city: "Springfield",
  state: "VA",
  zip: "22030",
  country_code: "US",
  description: "Two-story addition",
  managers: ["Project Manager A"],
  employees: ["42"],
};

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// ---------------------------------------------------------------------------
// Registry sanity
// ---------------------------------------------------------------------------

describe("buildProjectMutationTools registry", () => {
  it("exports exactly two tools with the contract-mandated names", () => {
    const { create, update } = tools();
    expect([create.name, update.name].sort()).toEqual([
      "create_project",
      "update_project",
    ]);
  });

  it("each tool exposes a JSON Schema for its input", () => {
    const { create, update } = tools();
    for (const tool of [create, update]) {
      expect(tool.inputSchema).toBeDefined();
      const schema = tool.inputSchema as { type?: string };
      expect(schema.type).toBe("object");
    }
  });
});

// ---------------------------------------------------------------------------
// create_project
// ---------------------------------------------------------------------------

describe("create_project", () => {
  it("first call (no confirmation_id) returns a confirmation prompt and does NOT call BuildToolsAPI", async () => {
    const createProject = vi.fn();
    const { create, store } = tools();
    const api = fakeApi({
      createProject: createProject as BuildToolsAPI["createProject"],
    });

    const result = await create.handler(
      {
        name: "Smith Kitchen",
        customer_id: 300001,
        project_manager: 42,
      },
      api,
    );

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("⚠️");
    expect(text).toContain("create_project");
    expect(text).toContain("Smith Kitchen");
    expect(text).toContain("#300001");
    expect(text).toMatch(UUID_RE);
    expect(text).toContain("confirmation_id");
    expect(createProject).not.toHaveBeenCalled();
    expect(store.size).toBe(1);
  });

  it("second call with a valid confirmation_id invokes BuildToolsAPI.createProject and returns a Markdown success", async () => {
    const createProject = vi.fn().mockResolvedValue({
      success: true,
      projectId: 1248,
    });
    const { create, store } = tools();
    const api = fakeApi({
      createProject: createProject as BuildToolsAPI["createProject"],
    });

    const first = await create.handler(
      {
        name: "Smith Kitchen",
        customer_id: 300001,
        status: "Active",
        project_manager: 42,
        address: "1 Main St",
      },
      api,
    );
    const id = textOf(first).match(UUID_RE)?.[0];
    expect(id).toBeDefined();

    const second = await create.handler(
      {
        name: "Smith Kitchen",
        customer_id: 300001,
        confirmation_id: id,
      },
      api,
    );

    expect(second.isError).toBeFalsy();
    expect(textOf(second)).toContain("Created project #1248");
    expect(textOf(second)).toContain("Smith Kitchen");
    expect(createProject).toHaveBeenCalledTimes(1);
    const callArg = createProject.mock.calls[0][0];
    expect(callArg).toMatchObject({
      name: "Smith Kitchen",
      status: 1, // Active → 1
      projectManager: 42,
      address: "1 Main St",
      clientIds: [300001],
    });
    // Single-use: store is emptied after consume.
    expect(store.size).toBe(0);
  });

  it("returns the re-invoke message when the confirmation_id is unknown / expired (no API call)", async () => {
    const createProject = vi.fn();
    const { create } = tools();
    const api = fakeApi({
      createProject: createProject as BuildToolsAPI["createProject"],
    });

    const result = await create.handler(
      {
        name: "Anything",
        customer_id: 1,
        confirmation_id: "00000000-0000-0000-0000-000000000000",
      },
      api,
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("expired, unknown, or does not match");
    expect(createProject).not.toHaveBeenCalled();
  });

  it("returns the re-invoke message when the confirmation_id was minted by a different tool (no API call)", async () => {
    const createProject = vi.fn();
    const updateProject = vi.fn();
    const { create, update, store } = tools();
    const api = fakeApi({
      createProject: createProject as BuildToolsAPI["createProject"],
      updateProject: updateProject as BuildToolsAPI["updateProject"],
      getProject: vi
        .fn()
        .mockResolvedValue(existingProject) as BuildToolsAPI["getProject"],
    });

    // Mint a confirmation under update_project.
    const first = await update.handler(
      { project_id: 100002, name: "Renamed" },
      api,
    );
    const id = textOf(first).match(UUID_RE)?.[0];
    expect(id).toBeDefined();
    expect(store.size).toBe(1);

    // Try to use that id with create_project — must NOT execute.
    const result = await create.handler(
      {
        name: "Different",
        customer_id: 1,
        confirmation_id: id,
      },
      api,
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("expired, unknown, or does not match");
    expect(createProject).not.toHaveBeenCalled();
    // The cross-tool consume DID delete the entry (single-use semantics).
    expect(store.size).toBe(0);
  });

  it("returns Markdown error (isError: true) when BuildToolsAPI throws — no stack trace text", async () => {
    const err = new BuildToolsServerError("Internal server error", { status: 500 });
    const createProject = vi.fn().mockRejectedValue(err);
    const { create } = tools();
    const api = fakeApi({
      createProject: createProject as BuildToolsAPI["createProject"],
    });

    const first = await create.handler(
      { name: "Foo", customer_id: 1, project_manager: 1 },
      api,
    );
    const id = textOf(first).match(UUID_RE)?.[0];

    const second = await create.handler(
      { name: "Foo", customer_id: 1, confirmation_id: id },
      api,
    );

    expect(second.isError).toBe(true);
    const text = textOf(second);
    expect(text).toContain("Internal server error");
    expect(text).toContain("BuildToolsServerError");
    // No raw stack trace text.
    expect(text).not.toContain("    at ");
    expect(text).not.toContain(".ts:");
  });

  it("returns Markdown error (isError: true) when BuildToolsAPI returns success:false", async () => {
    const createProject = vi.fn().mockResolvedValue({
      success: false,
      errors: { name: ["Name is required"] },
    });
    const { create } = tools();
    const api = fakeApi({
      createProject: createProject as BuildToolsAPI["createProject"],
    });

    const first = await create.handler(
      { name: "Bad", customer_id: 1, project_manager: 1 },
      api,
    );
    const id = textOf(first).match(UUID_RE)?.[0];

    const second = await create.handler(
      { name: "Bad", customer_id: 1, confirmation_id: id },
      api,
    );

    expect(second.isError).toBe(true);
    expect(textOf(second)).toContain("Name is required");
  });

  it("returns Markdown error (isError: true) on Zod-invalid input", async () => {
    const { create } = tools();
    const result = await create.handler(
      // customer_id must be a number; passing string fails.
      { name: "Foo", customer_id: "not-a-number" },
      fakeApi({}),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid input for `create_project`");
    expect(textOf(result)).toContain("customer_id");
  });
});

// ---------------------------------------------------------------------------
// update_project
// ---------------------------------------------------------------------------

describe("update_project", () => {
  it("first call (no confirmation_id) fetches existing project, returns confirmation prompt with an old → new diff, and does NOT call updateProject", async () => {
    const getProject = vi.fn().mockResolvedValue(existingProject);
    const updateProject = vi.fn();
    const { update, store } = tools();
    const api = fakeApi({
      getProject: getProject as BuildToolsAPI["getProject"],
      updateProject: updateProject as BuildToolsAPI["updateProject"],
    });

    const result = await update.handler(
      { project_id: 100002, status: "Complete", name: "Jones Addition v2" },
      api,
    );

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("⚠️");
    expect(text).toContain("update_project");
    expect(text).toContain("→"); // diff arrow per criterion 5
    // Status diff: old=Active (from wire "1"), new=Complete
    expect(text).toContain("Active");
    expect(text).toContain("Complete");
    // Name diff: old=Jones Addition, new=Jones Addition v2
    expect(text).toContain("Jones Addition v2");
    expect(text).toMatch(UUID_RE);
    expect(updateProject).not.toHaveBeenCalled();
    expect(getProject).toHaveBeenCalledWith(100002);
    expect(store.size).toBe(1);
  });

  it("second call with a valid confirmation_id invokes updateProject with the captured projectManager and returns a Markdown success", async () => {
    const getProject = vi.fn().mockResolvedValue(existingProject);
    const updateProject = vi.fn().mockResolvedValue({
      success: true,
      projectId: 100002,
    });
    const { update, store } = tools();
    const api = fakeApi({
      getProject: getProject as BuildToolsAPI["getProject"],
      updateProject: updateProject as BuildToolsAPI["updateProject"],
    });

    const first = await update.handler(
      { project_id: 100002, status: "Complete" },
      api,
    );
    const id = textOf(first).match(UUID_RE)?.[0];
    expect(id).toBeDefined();

    const second = await update.handler(
      { project_id: 100002, confirmation_id: id },
      api,
    );

    expect(second.isError).toBeFalsy();
    expect(textOf(second)).toContain("Updated project #100002");
    expect(textOf(second)).toContain("→"); // success message echoes the diff
    expect(updateProject).toHaveBeenCalledTimes(1);
    const [calledId, calledChanges] = updateProject.mock.calls[0];
    expect(calledId).toBe(100002);
    // projectManager extracted from existing.employees → ["42"].
    expect(calledChanges).toMatchObject({
      projectManager: ["42"],
      status: "6", // Complete → 6 (wire code string)
    });
    expect(store.size).toBe(0);
  });

  it("returns the re-invoke message when the confirmation_id is unknown / expired (no API call)", async () => {
    const updateProject = vi.fn();
    const getProject = vi.fn();
    const { update } = tools();
    const api = fakeApi({
      getProject: getProject as BuildToolsAPI["getProject"],
      updateProject: updateProject as BuildToolsAPI["updateProject"],
    });

    const result = await update.handler(
      {
        project_id: 100002,
        confirmation_id: "00000000-0000-0000-0000-000000000000",
      },
      api,
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("expired, unknown, or does not match");
    expect(updateProject).not.toHaveBeenCalled();
    // Second-invocation fast path skips the getProject pre-fetch.
    expect(getProject).not.toHaveBeenCalled();
  });

  it("returns the re-invoke message when the confirmation_id was minted by a different tool (no API call)", async () => {
    const createProject = vi.fn();
    const updateProject = vi.fn();
    const { create, update, store } = tools();
    const api = fakeApi({
      createProject: createProject as BuildToolsAPI["createProject"],
      updateProject: updateProject as BuildToolsAPI["updateProject"],
    });

    // Mint under create_project.
    const first = await create.handler(
      { name: "X", customer_id: 1, project_manager: 1 },
      api,
    );
    const id = textOf(first).match(UUID_RE)?.[0];
    expect(store.size).toBe(1);

    const result = await update.handler(
      { project_id: 100002, confirmation_id: id },
      api,
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("expired, unknown, or does not match");
    expect(updateProject).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it("returns Markdown error (isError: true) when updateProject throws — no stack trace text", async () => {
    const getProject = vi.fn().mockResolvedValue(existingProject);
    const updateProject = vi
      .fn()
      .mockRejectedValue(
        new BuildToolsServerError("Bad gateway", { status: 502 }),
      );
    const { update } = tools();
    const api = fakeApi({
      getProject: getProject as BuildToolsAPI["getProject"],
      updateProject: updateProject as BuildToolsAPI["updateProject"],
    });

    const first = await update.handler(
      { project_id: 100002, name: "Renamed" },
      api,
    );
    const id = textOf(first).match(UUID_RE)?.[0];

    const second = await update.handler(
      { project_id: 100002, confirmation_id: id },
      api,
    );

    expect(second.isError).toBe(true);
    const text = textOf(second);
    expect(text).toContain("Bad gateway");
    expect(text).not.toContain("    at ");
    expect(text).not.toContain(".ts:");
  });

  it("returns Markdown error (isError: true) when updateProject returns success:false", async () => {
    const getProject = vi.fn().mockResolvedValue(existingProject);
    const updateProject = vi.fn().mockResolvedValue({
      success: false,
      errors: { name: ["Name too long"] },
    });
    const { update } = tools();
    const api = fakeApi({
      getProject: getProject as BuildToolsAPI["getProject"],
      updateProject: updateProject as BuildToolsAPI["updateProject"],
    });

    const first = await update.handler(
      { project_id: 100002, name: "X" },
      api,
    );
    const id = textOf(first).match(UUID_RE)?.[0];

    const second = await update.handler(
      { project_id: 100002, confirmation_id: id },
      api,
    );

    expect(second.isError).toBe(true);
    expect(textOf(second)).toContain("Name too long");
  });

  it("update_project with project_id only (no diff fields) returns 'no changes to apply' WITHOUT calling the API or minting a confirmation entry", async () => {
    const getProject = vi.fn();
    const updateProject = vi.fn();
    const { update, store } = tools();
    const api = fakeApi({
      getProject: getProject as BuildToolsAPI["getProject"],
      updateProject: updateProject as BuildToolsAPI["updateProject"],
    });

    const result = await update.handler({ project_id: 100002 }, api);

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("No changes to apply");
    expect(textOf(result)).toContain("#100002");
    // No confirmation entry minted.
    expect(store.size).toBe(0);
    // No getProject (short-circuit happens BEFORE the diff fetch).
    expect(getProject).not.toHaveBeenCalled();
    expect(updateProject).not.toHaveBeenCalled();
  });

  it("surfaces a clear error when the existing project has no project manager", async () => {
    const getProject = vi.fn().mockResolvedValue({
      ...existingProject,
      employees: undefined,
      managers: undefined,
    });
    const updateProject = vi.fn();
    const { update, store } = tools();
    const api = fakeApi({
      getProject: getProject as BuildToolsAPI["getProject"],
      updateProject: updateProject as BuildToolsAPI["updateProject"],
    });

    const result = await update.handler(
      { project_id: 100002, name: "X" },
      api,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("no project manager");
    expect(store.size).toBe(0);
    expect(updateProject).not.toHaveBeenCalled();
  });

  it("returns a 'not found' error if api.getProject returns null on the first call", async () => {
    const getProject = vi.fn().mockResolvedValue(null);
    const updateProject = vi.fn();
    const { update, store } = tools();
    const api = fakeApi({
      getProject: getProject as BuildToolsAPI["getProject"],
      updateProject: updateProject as BuildToolsAPI["updateProject"],
    });

    const result = await update.handler(
      { project_id: 9999, name: "Renamed" },
      api,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not found");
    expect(store.size).toBe(0);
    expect(updateProject).not.toHaveBeenCalled();
  });

  it("returns Markdown error (isError: true) on Zod-invalid input", async () => {
    const { update } = tools();
    const result = await update.handler(
      { project_id: 100002, status: "Pending" }, // not in enum
      fakeApi({}),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid input for `update_project`");
    expect(textOf(result)).toContain("status");
  });
});
