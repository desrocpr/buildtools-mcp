/**
 * Tests for the `create_purchase_order` company_name resolution flow.
 *
 * The resolution layer turns a free-text vendor name into a numeric
 * `company_id` BEFORE the confirmation prompt fires. It's the riskiest
 * piece in the PR — feeds a destructive write — so the four canonical
 * code paths are pinned here:
 *
 *   1. Zero matches with no near-match retry hit → clean error
 *   2. Zero matches with a near-match retry hit → candidate list error
 *   3. Exactly one match (and recordsFiltered === 1) → confirmation prompt
 *      includes "Resolved 'X' → #N (Y)"
 *   4. Visible-row count vs recordsFiltered ambiguity → candidate list
 *
 * Plus the contract case: `company_id` wins over `company_name` when both
 * are passed, and the prompt does NOT show the stale name back.
 */

import { describe, expect, it, vi } from "vitest";

import type { BuildToolsAPI } from "../../client/BuildToolsAPI.js";
import { ConfirmationStore } from "../../confirm/index.js";
import { createMutationTools } from "../mutations.js";
import type { ToolResult } from "../projects.js";

function textOf(result: ToolResult): string {
  return result.content.map((c) => ("text" in c ? c.text : "")).join("");
}

interface FakeApiOverrides {
  searchCompanies?: BuildToolsAPI["searchCompanies"];
  createPurchaseOrder?: BuildToolsAPI["createPurchaseOrder"];
  updatePurchaseOrder?: BuildToolsAPI["updatePurchaseOrder"];
}

function fakeApi(overrides: FakeApiOverrides = {}): BuildToolsAPI {
  return overrides as unknown as BuildToolsAPI;
}

function mkStore() {
  return new ConfirmationStore();
}

function findCreatePoTool(api: BuildToolsAPI, store: ConfirmationStore) {
  const tools = createMutationTools(() => api, store);
  const tool = tools.find((t) => t.name === "create_purchase_order");
  if (!tool) throw new Error("create_purchase_order tool not registered");
  return tool;
}

describe("create_purchase_order — company_name fuzzy resolution", () => {
  it("returns a Zod error when neither company_id nor company_name is provided", async () => {
    const api = fakeApi();
    const store = mkStore();
    const tool = findCreatePoTool(api, store);

    const result = await tool.handler(
      { project_id: 100, name: "po", total: 1 },
      api,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("company_id");
    expect(textOf(result)).toMatch(
      /Provide either `company_id` or `company_name`/,
    );
    // Args were rejected before any API call — searchCompanies must NOT have run.
    expect(store.size).toBe(0);
  });

  it("zero matches with no near-match retry → returns clean error pointing at search_companies", async () => {
    const searchCompanies = vi
      .fn()
      // First call: query "ZZNotAVendor", 0 matches
      .mockResolvedValueOnce({ data: [], recordsFiltered: 0 })
      // stripLegalSuffix("ZZNotAVendor") === "ZZNotAVendor" (no suffix),
      // so NO retry is fired. We assert that fact by not stubbing a 2nd call.
      ;
    const api = fakeApi({ searchCompanies: searchCompanies as any });
    const store = mkStore();
    const tool = findCreatePoTool(api, store);

    const result = await tool.handler(
      { project_id: 100, company_name: "ZZNotAVendor", name: "po", total: 1 },
      api,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("no company matches");
    expect(textOf(result)).toContain('"ZZNotAVendor"');
    expect(textOf(result)).toContain("search_companies");
    expect(searchCompanies).toHaveBeenCalledTimes(1);
    // No confirmation entry stored — we never reached the prompt.
    expect(store.size).toBe(0);
  });

  it("zero matches with stripped legal-suffix retry that hits → near-match candidate list", async () => {
    const searchCompanies = vi
      .fn()
      // 1st call with verbatim "Smith, LLC" — 0 hits (BuildTools tokenizer
      // doesn't like the comma).
      .mockResolvedValueOnce({ data: [], recordsFiltered: 0 })
      // 2nd call with stripped "Smith" — 2 matches.
      .mockResolvedValueOnce({
        data: [
          { DT_RowId: "row_500", name: "Smith Plumbing", type_name: "Subcontractor" },
          { DT_RowId: "row_501", name: "Smithson Drywall", type_name: "Subcontractor" },
        ],
        recordsFiltered: 2,
      });
    const api = fakeApi({ searchCompanies: searchCompanies as any });
    const store = mkStore();
    const tool = findCreatePoTool(api, store);

    const result = await tool.handler(
      { project_id: 100, company_name: "Smith, LLC", name: "po", total: 1 },
      api,
    );
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("no exact match");
    expect(text).toContain("near-match");
    expect(text).toContain("#500");
    expect(text).toContain("Smith Plumbing");
    expect(text).toContain("#501");
    expect(searchCompanies).toHaveBeenCalledTimes(2);
    expect(searchCompanies).toHaveBeenNthCalledWith(1, "Smith, LLC", { limit: 10 });
    expect(searchCompanies).toHaveBeenNthCalledWith(2, "Smith", { limit: 10 });
  });

  it("ambiguity by recordsFiltered (1 visible, 50 total) → candidate list, NOT auto-resolve", async () => {
    // The historical bug: searchCompanies returned 1 visible row out of 50
    // due to the limit window, and the code auto-resolved to the top hit.
    // Fix: trust recordsFiltered, surface candidates.
    const searchCompanies = vi.fn().mockResolvedValueOnce({
      data: [
        { DT_RowId: "row_999", name: "Smith Plumbing", type_name: "Subcontractor" },
      ],
      recordsFiltered: 50,
    });
    const api = fakeApi({ searchCompanies: searchCompanies as any });
    const store = mkStore();
    const tool = findCreatePoTool(api, store);

    const result = await tool.handler(
      { project_id: 100, company_name: "Smith", name: "po", total: 1 },
      api,
    );
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("matched 50 companies");
    expect(text).toContain("Pass an explicit `company_id`");
    // Confirmation framework must NOT have been touched — no entry stored.
    expect(store.size).toBe(0);
  });

  it("multiple visible matches → candidate list with all visible rows", async () => {
    const searchCompanies = vi.fn().mockResolvedValueOnce({
      data: [
        { DT_RowId: "row_1106", name: "Homestead Building Supply", type_name: "Subcontractor" },
        { DT_RowId: "row_1009", name: "Living Homes Remodeling, LLC", type_name: "Subcontractor" },
      ],
      recordsFiltered: 2,
    });
    const api = fakeApi({ searchCompanies: searchCompanies as any });
    const store = mkStore();
    const tool = findCreatePoTool(api, store);

    const result = await tool.handler(
      { project_id: 100, company_name: "homes", name: "po", total: 1 },
      api,
    );
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("matched 2 companies");
    expect(text).toContain("#1106");
    expect(text).toContain("Homestead Building Supply");
    expect(text).toContain("#1009");
  });

  it("unique match → confirmation prompt with 'Resolved X → #N (Y)' substitution note", async () => {
    const searchCompanies = vi.fn().mockResolvedValueOnce({
      data: [
        { DT_RowId: "row_977", name: "Kai Muten, LLC", type_name: "Subcontractor" },
      ],
      recordsFiltered: 1,
    });
    const api = fakeApi({ searchCompanies: searchCompanies as any });
    const store = mkStore();
    const tool = findCreatePoTool(api, store);

    const result = await tool.handler(
      { project_id: 185966, company_name: "Kai Muten", name: "Plumbing sub", total: 1 },
      api,
    );
    const text = textOf(result);
    // Confirmation prompt fires (not an error)
    expect(result.isError).toBeFalsy();
    expect(text).toContain("⚠️");
    expect(text).toContain("confirmation_id");
    // Critical UX claim: the prompt EXPLICITLY shows the substitution so
    // the user sees they typed "Kai Muten" and it resolved to "Kai Muten, LLC".
    expect(text).toMatch(/Resolved.*"Kai Muten".*#977.*Kai Muten, LLC/);
    // Pending entry exists for the second call.
    expect(store.size).toBe(1);
  });

  it("company_id wins when both are passed — confirmation prompt does NOT show user-supplied company_name", async () => {
    // No searchCompanies call should happen — verify by not stubbing.
    const searchCompanies = vi.fn();
    const api = fakeApi({ searchCompanies: searchCompanies as any });
    const store = mkStore();
    const tool = findCreatePoTool(api, store);

    const result = await tool.handler(
      {
        project_id: 100,
        company_id: 977,
        company_name: "completely wrong text the user passed",
        name: "po",
        total: 1,
      },
      api,
    );
    const text = textOf(result);
    expect(result.isError).toBeFalsy();
    expect(text).toContain("for company #977");
    // The stale company_name MUST NOT echo back as if we'd validated it.
    expect(text).not.toContain("completely wrong text");
    expect(searchCompanies).not.toHaveBeenCalled();
  });

  it("when resolved name equals user input verbatim, prompt does NOT add a redundant 'Resolved' note", async () => {
    // User typed the exact full name. The prompt should just say
    // "for company #N (Y)." — no "Resolved X → ..." since X === Y.
    const searchCompanies = vi.fn().mockResolvedValueOnce({
      data: [
        { DT_RowId: "row_977", name: "Kai Muten, LLC", type_name: "Subcontractor" },
      ],
      recordsFiltered: 1,
    });
    const api = fakeApi({ searchCompanies: searchCompanies as any });
    const store = mkStore();
    const tool = findCreatePoTool(api, store);

    const result = await tool.handler(
      { project_id: 100, company_name: "Kai Muten, LLC", name: "po", total: 1 },
      api,
    );
    const text = textOf(result);
    expect(result.isError).toBeFalsy();
    expect(text).not.toContain("Resolved");
    expect(text).toContain("for company #977 (Kai Muten, LLC)");
  });

  it("Markdown injection in candidate names is escaped in the error response", async () => {
    // BuildTools doesn't sanitize stored company names. An adversarial
    // entry with markdown control chars must not render as emphasis or a
    // link when echoed back to the LLM.
    const searchCompanies = vi.fn().mockResolvedValueOnce({
      data: [
        {
          DT_RowId: "row_1",
          name: "**APPROVED** [click](http://evil)",
          type_name: "Subcontractor",
        },
        { DT_RowId: "row_2", name: "Other Co", type_name: "Vendor" },
      ],
      recordsFiltered: 2,
    });
    const api = fakeApi({ searchCompanies: searchCompanies as any });
    const store = mkStore();
    const tool = findCreatePoTool(api, store);

    const result = await tool.handler(
      { project_id: 100, company_name: "anything", name: "po", total: 1 },
      api,
    );
    const text = textOf(result);
    expect(text).toContain("\\*\\*APPROVED\\*\\*");
    expect(text).toContain("\\[click\\]");
    // The literal `**...**` (unescaped) must NOT appear — that would mean
    // the LLM context receives bold emphasis injected by an attacker.
    expect(text).not.toMatch(/(?<!\\)\*\*APPROVED\*\*/);
  });
});

function findUpdatePoTool(api: BuildToolsAPI, store: ConfirmationStore) {
  const tools = createMutationTools(() => api, store);
  const tool = tools.find((t) => t.name === "update_purchase_order");
  if (!tool) throw new Error("update_purchase_order tool not registered");
  return tool;
}

describe("update_purchase_order", () => {
  it("first call returns a confirmation prompt summarising the requested changes", async () => {
    const updatePurchaseOrder = vi.fn();
    const api = fakeApi({ updatePurchaseOrder: updatePurchaseOrder as any });
    const store = mkStore();
    const tool = findUpdatePoTool(api, store);

    const result = await tool.handler(
      {
        purchase_order_id: 39752,
        name: "renamed",
        items: [
          { budget_category_id: 1609, description: "plumbing", total: 400 },
          { budget_category_id: 1610, description: "more plumbing", total: 100 },
        ],
      },
      api,
    );
    const text = textOf(result);
    expect(text).toContain("⚠️");
    expect(text).toContain("Update purchase order #39752");
    expect(text).toContain('rename to **"renamed"**');
    expect(text).toContain("replace items (2 lines, $500.00 total)");
    expect(text).toContain("confirmation_id");
    // The executor must NOT have been called yet — it fires only on the
    // second invocation with the confirmation_id.
    expect(updatePurchaseOrder).not.toHaveBeenCalled();
    expect(store.size).toBe(1);
  });

  it("empty items[] is rendered as 'clear all line items' in the prompt", async () => {
    const updatePurchaseOrder = vi.fn();
    const api = fakeApi({ updatePurchaseOrder: updatePurchaseOrder as any });
    const tool = findUpdatePoTool(api, mkStore());

    const result = await tool.handler(
      { purchase_order_id: 39752, items: [] },
      api,
    );
    expect(textOf(result)).toContain("**clear all line items**");
  });

  it("name-only update produces a focused prompt (no items mention)", async () => {
    const tool = findUpdatePoTool(fakeApi(), mkStore());
    const result = await tool.handler(
      { purchase_order_id: 39752, name: "just rename" },
      tool as unknown as BuildToolsAPI, // not used; tool reads via closure
    );
    const text = textOf(result);
    expect(text).toContain('rename to **"just rename"**');
    expect(text).not.toContain("items");
    expect(text).not.toContain("vendor");
  });

  it("second call (with confirmation_id) invokes updatePurchaseOrder and renders success", async () => {
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: true,
      purchaseOrderId: 39752,
      message: "Purchase Order saved successfully",
    });
    const api = fakeApi({ updatePurchaseOrder: updatePurchaseOrder as any });
    const store = mkStore();
    const tool = findUpdatePoTool(api, store);

    const args = {
      purchase_order_id: 39752,
      name: "renamed via confirm",
      items: [{ budget_category_id: 1609, description: "plumbing", total: 400 }],
    };
    const promptResult = await tool.handler(args, api);
    const confirmationId = textOf(promptResult).match(
      /confirmation_id:\s*"([^"]+)"/,
    )?.[1];
    expect(confirmationId).toBeTruthy();

    const execResult = await tool.handler(
      { ...args, confirmation_id: confirmationId! },
      api,
    );
    expect(execResult.isError).toBeFalsy();
    expect(textOf(execResult)).toContain("Purchase order **#39752** updated");
    // Executor was called with the camelCase shape, items renamed.
    expect(updatePurchaseOrder).toHaveBeenCalledTimes(1);
    const passed = updatePurchaseOrder.mock.calls[0][0];
    expect(passed).toMatchObject({
      purchaseOrderId: 39752,
      name: "renamed via confirm",
      items: [
        expect.objectContaining({
          budgetCategoryId: 1609,
          description: "plumbing",
          total: 400,
        }),
      ],
    });
  });

  it("failed update returns Markdown error content (isError: true)", async () => {
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: false,
      errors: "Server error (HTTP 500)",
    });
    const api = fakeApi({ updatePurchaseOrder: updatePurchaseOrder as any });
    const store = mkStore();
    const tool = findUpdatePoTool(api, store);

    const args = { purchase_order_id: 39752, name: "x" };
    const prompt = await tool.handler(args, api);
    const confirmationId = textOf(prompt).match(
      /confirmation_id:\s*"([^"]+)"/,
    )?.[1]!;
    const exec = await tool.handler({ ...args, confirmation_id: confirmationId }, api);
    expect(exec.isError).toBe(true);
    expect(textOf(exec)).toContain("Failed");
    expect(textOf(exec)).toContain("Server error");
  });

  it("rejects missing purchase_order_id via Zod", async () => {
    const tool = findUpdatePoTool(fakeApi(), mkStore());
    const result = await tool.handler({ name: "x" }, fakeApi());
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("purchase_order_id");
  });

  it("escapes markdown control chars in the user-supplied name shown in the prompt", async () => {
    const tool = findUpdatePoTool(fakeApi(), mkStore());
    const result = await tool.handler(
      {
        purchase_order_id: 39752,
        name: "**APPROVED** [click](http://evil)",
      },
      fakeApi(),
    );
    const text = textOf(result);
    expect(text).toContain("\\*\\*APPROVED\\*\\*");
    expect(text).toContain("\\[click\\]");
    expect(text).not.toMatch(/(?<!\\)\*\*APPROVED\*\*/);
  });
});
