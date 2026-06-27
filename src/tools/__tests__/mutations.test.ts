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
import { IdempotencyStore } from "../../idempotency/index.js";
import type { ToolResult } from "../projects.js";

function textOf(result: ToolResult): string {
  return result.content.map((c) => ("text" in c ? c.text : "")).join("");
}

interface FakeApiOverrides {
  searchCompanies?: BuildToolsAPI["searchCompanies"];
  createPurchaseOrder?: BuildToolsAPI["createPurchaseOrder"];
  updatePurchaseOrder?: BuildToolsAPI["updatePurchaseOrder"];
  transitionPurchaseOrderStatus?: BuildToolsAPI["transitionPurchaseOrderStatus"];
  bulkTransitionPurchaseOrderStatuses?: BuildToolsAPI["bulkTransitionPurchaseOrderStatuses"];
  getCompany?: BuildToolsAPI["getCompany"];
  getPurchaseOrder?: BuildToolsAPI["getPurchaseOrder"];
  getPurchaseOrders?: BuildToolsAPI["getPurchaseOrders"];
  uploadAttachment?: BuildToolsAPI["uploadAttachment"];
  getProject?: BuildToolsAPI["getProject"];
  getFinancialStatements?: BuildToolsAPI["getFinancialStatements"];
  createFinancialStatementWithAmount?: BuildToolsAPI["createFinancialStatementWithAmount"];
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
    const api = fakeApi();
    const tool = findUpdatePoTool(api, mkStore());
    const result = await tool.handler(
      { purchase_order_id: 39752, name: "just rename" },
      api,
    );
    const text = textOf(result);
    expect(text).toContain('rename to **"just rename"**');
    expect(text).not.toContain("items");
    expect(text).not.toContain("vendor");
  });

  it("changing company_id resolves the vendor name for the confirmation prompt", async () => {
    const getCompany = vi.fn().mockResolvedValue({
      DT_RowId: "row_977",
      name: "Kai Muten, LLC",
    });
    const updatePurchaseOrder = vi.fn();
    const api = fakeApi({
      getCompany: getCompany as any,
      updatePurchaseOrder: updatePurchaseOrder as any,
    });
    const tool = findUpdatePoTool(api, mkStore());

    const result = await tool.handler(
      { purchase_order_id: 39752, company_id: 977 },
      api,
    );
    const text = textOf(result);
    // The prompt shows both the numeric id AND the resolved name so the
    // user can verify the right vendor before confirming.
    expect(text).toContain("change vendor → #977 (Kai Muten, LLC)");
    // Lookup hit exactly once (only on the FIRST call — second call
    // replays the stored args with the name already cached).
    expect(getCompany).toHaveBeenCalledTimes(1);
    expect(getCompany).toHaveBeenCalledWith(977);
  });

  it("vendor name lookup failure degrades gracefully to id-only", async () => {
    const getCompany = vi.fn().mockRejectedValue(new Error("BT down"));
    const api = fakeApi({ getCompany: getCompany as any });
    const tool = findUpdatePoTool(api, mkStore());

    const result = await tool.handler(
      { purchase_order_id: 39752, company_id: 4271 },
      api,
    );
    const text = textOf(result);
    expect(text).toContain("change vendor → #4271");
    expect(text).not.toContain("(");  // no "(Vendor Name)" suffix when lookup failed
  });

  it("vendor lookup is skipped on the confirmation (second) call", async () => {
    const getCompany = vi.fn().mockResolvedValue({ name: "Vendor X" });
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: true, purchaseOrderId: 39752, message: "saved",
    });
    const api = fakeApi({
      getCompany: getCompany as any,
      updatePurchaseOrder: updatePurchaseOrder as any,
    });
    const tool = findUpdatePoTool(api, mkStore());

    const args = { purchase_order_id: 39752, company_id: 1234 };
    const prompt = await tool.handler(args, api);
    const confirmationId = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];

    // Second call MUST NOT do another vendor lookup — the resolved name
    // is already in the stored args from the first call.
    await tool.handler({ ...args, confirmation_id: confirmationId }, api);
    expect(getCompany).toHaveBeenCalledTimes(1);
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

describe("update_purchase_order — status by label, real errors, verify-after-write", () => {
  it("MCP-layer Zod schema rejects unknown status labels with a clear error", async () => {
    // First line of defense: the MCP tool schema's z.enum(["Draft",
    // "Sent","Confirmed","Rejected"]) blocks anything else from reaching
    // the executor. A typo or new-label-not-yet-supported surfaces as a
    // structured Zod error rather than a silent dropped field.
    const updatePurchaseOrder = vi.fn();
    const api = fakeApi({ updatePurchaseOrder: updatePurchaseOrder as any });
    const tool = findUpdatePoTool(api, mkStore());

    const result = await tool.handler(
      {
        purchase_order_id: 39752,
        // Intentional cast — simulating a malformed MCP client call.
        status: "Garbage" as unknown as "Draft",
      },
      api,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid input for `update_purchase_order`");
    expect(textOf(result)).toContain("status");
    expect(updatePurchaseOrder).not.toHaveBeenCalled();
  });

  it("accepts status as a label ('Draft', 'Sent', 'Confirmed', 'Rejected') and shows the resolved label in the prompt", async () => {
    const updatePurchaseOrder = vi.fn();
    const api = fakeApi({ updatePurchaseOrder: updatePurchaseOrder as any });
    const tool = findUpdatePoTool(api, mkStore());

    const result = await tool.handler(
      { purchase_order_id: 39752, status: "Sent" },
      api,
    );
    const text = textOf(result);
    // Prompt should show the label AND the numeric code in parentheses so
    // the user sees exactly what BT will receive.
    expect(text).toMatch(/status → Sent \(2\)/);
  });

  it("forwards the resolved status CODE through transitionPurchaseOrderStatus (PR #61: status changes route through /status/update, not /save)", async () => {
    // After PR #61 status-only changes no longer touch /save —
    // updatePurchaseOrder is skipped entirely and the status goes
    // through the dedicated workflow endpoint. This test pins that
    // routing change so a future refactor can't silently restore the
    // brittle /save status field.
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: true, purchaseOrderId: 39752, message: "saved",
    });
    const transitionPurchaseOrderStatus = vi.fn().mockResolvedValue({
      success: true, message: "Status updated.",
    });
    const api = fakeApi({
      updatePurchaseOrder: updatePurchaseOrder as any,
      transitionPurchaseOrderStatus: transitionPurchaseOrderStatus as any,
    });
    const store = mkStore();
    const tool = findUpdatePoTool(api, store);

    const args = { purchase_order_id: 39752, status: "Confirmed" as const };
    const prompt = await tool.handler(args, api);
    const confirmationId = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    await tool.handler({ ...args, confirmation_id: confirmationId, verify: false }, api);

    // Status-only call: /save is NOT touched (no content changes).
    expect(updatePurchaseOrder).not.toHaveBeenCalled();
    // The dedicated transition endpoint gets the resolved code.
    expect(transitionPurchaseOrderStatus).toHaveBeenCalledTimes(1);
    expect(transitionPurchaseOrderStatus.mock.calls[0][0]).toEqual({
      purchaseOrderId: 39752,
      status: 3,
    });
  });

  it("surfaces the API's error string verbatim (no JSON.stringify wrapping) — fixes the 'Failed: \"\"' bug", async () => {
    // Simulate the locked-PO scenario: BT returns 403 with empty body,
    // the API layer composes a useful error string from HTTP status +
    // the lock-detection message.
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: false,
      currentStatus: 3,
      errors:
        "PO #39201 is in **Confirmed** state (code 3) — BuildTools locks ALL writes...",
    });
    const api = fakeApi({ updatePurchaseOrder: updatePurchaseOrder as any });
    const store = mkStore();
    const tool = findUpdatePoTool(api, store);

    const args = { purchase_order_id: 39201, items: [] };
    const prompt = await tool.handler(args, api);
    const confirmationId = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    const exec = await tool.handler({ ...args, confirmation_id: confirmationId }, api);

    expect(exec.isError).toBe(true);
    const text = textOf(exec);
    // Regression check: the buggy code did `JSON.stringify(result.errors)`
    // which on the locked-PO case wrapped a useful string in quotes and
    // sometimes returned literally `"Failed: \"\""`. Make sure that
    // never happens again — the error must contain the human message
    // verbatim and NOT be wrapped in `"`.
    expect(text).toContain("BuildTools locks ALL writes");
    expect(text).toContain("PO #39201");
    expect(text).not.toMatch(/Failed:\s*""\s*$/);
    expect(text).not.toContain('"PO #39201'); // no leading-quote wrap
  });

  it("re-fetches the PO after a successful save and confirms intent matched (verify: true default)", async () => {
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: true, purchaseOrderId: 39752, message: "saved",
    });
    const getPurchaseOrder = vi.fn().mockResolvedValue({
      id: 39752,
      projectId: 185936,
      name: "renamed",
      number: "PO-1",
      prefix: "PO",
      status: 1,
      description: "",
      companyId: 977,
      companyName: "Kai Muten, LLC",
      items: [{ id: 1, budgetCategoryId: 1621, budgetCategoryCode: "6030", budgetCategoryName: "Plumbing Sub", total: "400.00", notes: "", internalNotes: "", invoiceRelated: "0.00", amounts: [], companyId: 977, companyName: "Kai Muten, LLC" }],
      totalNumeric: 400,
    });
    const api = fakeApi({
      updatePurchaseOrder: updatePurchaseOrder as any,
      getPurchaseOrder: getPurchaseOrder as any,
    });
    const store = mkStore();
    const tool = findUpdatePoTool(api, store);

    // Pass company_id explicitly so vendor IS in the caller-passed set
    // and shows up in the "Verified:" line. (After PR #57 round 3 the
    // verify summary only mentions fields the caller actually passed.)
    const args = {
      purchase_order_id: 39752,
      name: "renamed",
      company_id: 977,
      items: [{ budget_category_id: 1621, description: "x", total: 400 }],
    };
    const prompt = await tool.handler(args, api);
    const confirmationId = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    const exec = await tool.handler({ ...args, confirmation_id: confirmationId }, api);

    expect(exec.isError).toBeFalsy();
    expect(getPurchaseOrder).toHaveBeenCalledWith(39752);
    expect(textOf(exec)).toContain("Verified:");
    expect(textOf(exec)).toContain("Kai Muten, LLC");
    expect(textOf(exec)).toContain("total $400.00");
  });

  it("verify-after-write flags mismatches even when the API returned success", async () => {
    // Simulates BT returning 200 OK but silently dropping the items[]
    // change — the save says success but the PO actually has 0 items.
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: true, purchaseOrderId: 39752, message: "saved",
    });
    const getPurchaseOrder = vi.fn().mockResolvedValue({
      id: 39752, projectId: 185936, name: "renamed",
      number: "", prefix: "PO", status: 1, description: "",
      companyId: 977, companyName: "Kai Muten, LLC",
      items: [], totalNumeric: 0,
    });
    const api = fakeApi({
      updatePurchaseOrder: updatePurchaseOrder as any,
      getPurchaseOrder: getPurchaseOrder as any,
    });
    const store = mkStore();
    const tool = findUpdatePoTool(api, store);

    const args = {
      purchase_order_id: 39752,
      items: [{ budget_category_id: 1621, description: "x", total: 400 }],
    };
    const prompt = await tool.handler(args, api);
    const confirmationId = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    const exec = await tool.handler({ ...args, confirmation_id: confirmationId }, api);

    expect(exec.isError).toBe(true);
    const text = textOf(exec);
    expect(text).toContain("verify-after-write found mismatches");
    expect(text).toContain("items total: expected $400.00, got $0.00");
    expect(text).toContain("item count: expected 1, got 0");
  });

  it("verify: false skips the re-fetch", async () => {
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: true, purchaseOrderId: 39752, message: "saved",
    });
    const getPurchaseOrder = vi.fn();
    const api = fakeApi({
      updatePurchaseOrder: updatePurchaseOrder as any,
      getPurchaseOrder: getPurchaseOrder as any,
    });
    const store = mkStore();
    const tool = findUpdatePoTool(api, store);

    const args = { purchase_order_id: 39752, name: "x", verify: false };
    const prompt = await tool.handler(args, api);
    const confirmationId = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    await tool.handler({ ...args, confirmation_id: confirmationId }, api);

    expect(getPurchaseOrder).not.toHaveBeenCalled();
  });

  it("verify failure (re-fetch throws) degrades gracefully — does NOT fail the update", async () => {
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: true, purchaseOrderId: 39752, message: "saved",
    });
    const getPurchaseOrder = vi.fn().mockRejectedValue(new Error("network blip"));
    const api = fakeApi({
      updatePurchaseOrder: updatePurchaseOrder as any,
      getPurchaseOrder: getPurchaseOrder as any,
    });
    const store = mkStore();
    const tool = findUpdatePoTool(api, store);

    const args = { purchase_order_id: 39752, name: "x" };
    const prompt = await tool.handler(args, api);
    const confirmationId = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    const exec = await tool.handler({ ...args, confirmation_id: confirmationId }, api);

    // Update itself succeeded; verify failure surfaces as a note, not an error.
    expect(exec.isError).toBeFalsy();
    expect(textOf(exec)).toContain("updated");
    expect(textOf(exec)).toContain("Verify skipped");
    expect(textOf(exec)).toContain("network blip");
  });
});

describe("update_purchase_order — append mode + budget ID resolution", () => {
  it("rejects passing both `items` and `items_append` at the Zod schema layer", async () => {
    const updatePurchaseOrder = vi.fn();
    const api = fakeApi({ updatePurchaseOrder: updatePurchaseOrder as any });
    const tool = findUpdatePoTool(api, mkStore());
    const result = await tool.handler(
      {
        purchase_order_id: 39752,
        items: [{ budget_category_id: 1, description: "x", total: 1 }],
        items_append: [{ budget_category_id: 1, description: "y", total: 2 }],
      },
      api,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Pass either `items` (full replacement) OR `items_append`");
    expect(updatePurchaseOrder).not.toHaveBeenCalled();
  });

  it("forwards `items_append` to the API + strict-asserts pre+Δ=post via pre-save snapshot", async () => {
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: true, purchaseOrderId: 39752, message: "saved",
    });
    // Pre-fetch returns 1 item / $17380.47; post-fetch returns 2 items
    // (the original + the appended) / $19533.81. This simulates BT
    // actually performing the append.
    const preState = {
      id: 39752, projectId: 185936, name: "x", number: "", prefix: "PO",
      status: 1, description: "", companyId: 977, companyName: "v",
      items: [
        { id: 1, budgetCategoryId: 1680, budgetCategoryCode: "7051", budgetCategoryName: "Countertops", total: "17380.47", notes: "", internalNotes: "", invoiceRelated: "0.00", amounts: [], companyId: 977, companyName: "v" },
      ],
      totalNumeric: 17380.47,
    };
    const postState = {
      ...preState,
      items: [
        ...preState.items,
        { id: 2, budgetCategoryId: 1680, budgetCategoryCode: "7051", budgetCategoryName: "Countertops", total: "2153.34", notes: "", internalNotes: "", invoiceRelated: "0.00", amounts: [], companyId: 977, companyName: "v" },
      ],
      totalNumeric: 19533.81,
    };
    const getPurchaseOrder = vi
      .fn()
      .mockResolvedValueOnce(preState)   // pre-save snapshot
      .mockResolvedValueOnce(postState); // post-save verify
    const api = fakeApi({
      updatePurchaseOrder: updatePurchaseOrder as any,
      getPurchaseOrder: getPurchaseOrder as any,
    });
    const tool = findUpdatePoTool(api, mkStore());

    const args = {
      purchase_order_id: 39752,
      items_append: [
        { budget_code: "7051", description: "delta correction", total: 2153.34 },
      ],
    };
    const prompt = await tool.handler(args, api);
    const promptText = textOf(prompt);
    // Prompt should distinguish append from replace.
    expect(promptText).toMatch(/append items \(1 new line, \+\$2153.34\)/);

    const confirmationId = promptText.match(/confirmation_id:\s*"([^"]+)"/)![1];
    const exec = await tool.handler({ ...args, confirmation_id: confirmationId }, api);

    expect(updatePurchaseOrder).toHaveBeenCalledTimes(1);
    const passed = updatePurchaseOrder.mock.calls[0][0];
    // Critical: itemsAppend forwarded, items NOT set (we're appending, not replacing).
    expect(passed.items).toBeUndefined();
    expect(passed.itemsAppend).toEqual([
      expect.objectContaining({
        budgetCode: "7051",
        description: "delta correction",
        total: 2153.34,
      }),
    ]);

    // getPurchaseOrder hit twice: once for pre-snapshot, once for verify.
    expect(getPurchaseOrder).toHaveBeenCalledTimes(2);
    // Verify-line reports the appended delta + post-save state.
    expect(textOf(exec)).toContain("appended 1 line(s) (+$2153.34)");
    expect(textOf(exec)).toContain("PO now has 2 item(s)");
    expect(textOf(exec)).toContain("$19533.81");
  });

  it("append-verify FAILS LOUDLY when BT silently drops the appended line (count/total unchanged post-save)", async () => {
    // The pre-fetch snapshot reports 1 item / $17380.47. The save
    // returns success. The post-fetch ALSO reports 1 item / $17380.47 —
    // BT silently dropped the append. The strict pre + Δ = post
    // assertion must catch this; the old loose verify-line would have
    // claimed success.
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: true, purchaseOrderId: 39752, message: "saved",
    });
    const sameState = {
      id: 39752, projectId: 185936, name: "x", number: "", prefix: "PO",
      status: 1, description: "", companyId: 977, companyName: "v",
      items: [
        { id: 1, budgetCategoryId: 1680, budgetCategoryCode: "7051", budgetCategoryName: "Countertops", total: "17380.47", notes: "", internalNotes: "", invoiceRelated: "0.00", amounts: [], companyId: 977, companyName: "v" },
      ],
      totalNumeric: 17380.47,
    };
    const getPurchaseOrder = vi.fn().mockResolvedValue(sameState);
    const api = fakeApi({
      updatePurchaseOrder: updatePurchaseOrder as any,
      getPurchaseOrder: getPurchaseOrder as any,
    });
    const tool = findUpdatePoTool(api, mkStore());

    const args = {
      purchase_order_id: 39752,
      items_append: [
        { budget_code: "7051", description: "delta", total: 2153.34 },
      ],
    };
    const prompt = await tool.handler(args, api);
    const confirmationId = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    const exec = await tool.handler({ ...args, confirmation_id: confirmationId }, api);

    expect(exec.isError).toBe(true);
    const text = textOf(exec);
    expect(text).toContain("verify-after-write found mismatches");
    expect(text).toContain("appended item count: expected 2");
    expect(text).toContain("appended total: expected $19533.81");
  });

  it("append-verify degrades gracefully when the pre-save snapshot fails", async () => {
    // First getPurchaseOrder call (pre-snapshot) rejects; second
    // (post-verify) succeeds. The strict assertion is unavailable, so
    // we degrade to a post-state-only note rather than failing the
    // whole update.
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: true, purchaseOrderId: 39752, message: "saved",
    });
    const postOnly = {
      id: 39752, projectId: 185936, name: "x", number: "", prefix: "PO",
      status: 1, description: "", companyId: 977, companyName: "v",
      items: [], totalNumeric: 0,
    };
    const getPurchaseOrder = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient blip"))
      .mockResolvedValueOnce(postOnly);
    const api = fakeApi({
      updatePurchaseOrder: updatePurchaseOrder as any,
      getPurchaseOrder: getPurchaseOrder as any,
    });
    const tool = findUpdatePoTool(api, mkStore());

    const args = {
      purchase_order_id: 39752,
      items_append: [{ budget_code: "7051", description: "x", total: 100 }],
    };
    const prompt = await tool.handler(args, api);
    const confirmationId = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    const exec = await tool.handler({ ...args, confirmation_id: confirmationId }, api);

    expect(exec.isError).toBeFalsy();
    expect(textOf(exec)).toContain("Append verify: pre-save snapshot failed");
  });

  it("forwards budget_code and budget_item_id to the API verbatim — resolution happens server-side", async () => {
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: true, purchaseOrderId: 39752, message: "saved",
    });
    const getPurchaseOrder = vi.fn().mockResolvedValue({
      id: 39752, projectId: 185936, name: "x", number: "", prefix: "PO",
      status: 1, description: "", companyId: 977, companyName: "v",
      items: [{ id: 1, budgetCategoryId: 1680, budgetCategoryCode: "", budgetCategoryName: "", total: "100", notes: "", internalNotes: "", invoiceRelated: "0.00", amounts: [], companyId: 977, companyName: "v" }],
      totalNumeric: 100,
    });
    const api = fakeApi({
      updatePurchaseOrder: updatePurchaseOrder as any,
      getPurchaseOrder: getPurchaseOrder as any,
    });
    const tool = findUpdatePoTool(api, mkStore());

    const args = {
      purchase_order_id: 39752,
      items: [{ budget_code: "7051", description: "x", total: 100 }],
    };
    const prompt = await tool.handler(args, api);
    const confirmationId = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    await tool.handler({ ...args, confirmation_id: confirmationId }, api);

    const passed = updatePurchaseOrder.mock.calls[0][0];
    expect(passed.items[0]).toMatchObject({
      budgetCode: "7051",
      budgetCategoryId: undefined,
      budgetItemId: undefined,
      description: "x",
      total: 100,
    });
    // Replace path: itemsAppend must be undefined (mirror assertion to
    // the append test which checks the opposite direction).
    expect(passed.itemsAppend).toBeUndefined();
  });
});

describe("update_purchase_order — idempotency guard (PR #60)", () => {
  // Helper: build a tools registry with the idempotency store wired in.
  function findToolWithIdem(
    api: BuildToolsAPI,
    store: ConfirmationStore,
    idem: IdempotencyStore,
  ) {
    const tools = createMutationTools(() => api, store, undefined, idem);
    const tool = tools.find((t) => t.name === "update_purchase_order");
    if (!tool) throw new Error("update_purchase_order not registered");
    return tool;
  }

  const baseDetail = {
    id: 39752, projectId: 185936, name: "renamed", number: "", prefix: "PO",
    status: 1, description: "",
    companyId: 977, companyName: "Kai Muten, LLC",
    items: [{ id: 1, budgetCategoryId: 1621, budgetCategoryCode: "6030", budgetCategoryName: "Plumbing Sub", total: "100", notes: "", internalNotes: "", invoiceRelated: "0.00", amounts: [], companyId: 977, companyName: "Kai Muten, LLC" }],
    totalNumeric: 100,
  };

  it("caches the SUCCESS result on first call; replays it on the retry — no second BT call", async () => {
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: true, purchaseOrderId: 39752, message: "saved",
    });
    const getPurchaseOrder = vi.fn().mockResolvedValue(baseDetail);
    const api = fakeApi({
      updatePurchaseOrder: updatePurchaseOrder as any,
      getPurchaseOrder: getPurchaseOrder as any,
    });
    const store = mkStore();
    const idem = new IdempotencyStore();
    const tool = findToolWithIdem(api, store, idem);

    // verify: false because the focus of these tests is cache behavior,
    // not the verify-after-write check (which would otherwise flag a
    // mismatch when the mock's returned name differs from args.name).
    const args = {
      purchase_order_id: 39752,
      name: "renamed",
      idempotency_key: "test-key-2026-06-27-01",
      verify: false,
    };

    // First call: prompt
    const prompt1 = await tool.handler(args, api);
    const confirmId = textOf(prompt1).match(/confirmation_id:\s*"([^"]+)"/)![1];
    // First call: execute
    const exec1 = await tool.handler({ ...args, confirmation_id: confirmId }, api);
    expect(exec1.isError).toBeFalsy();
    expect(textOf(exec1)).toContain("updated");
    expect(updatePurchaseOrder).toHaveBeenCalledTimes(1);

    // Retry: same idempotency_key + same semantic args → cached replay,
    // no prompt phase, no second BT call.
    const retry = await tool.handler(args, api);
    expect(retry.isError).toBeFalsy();
    expect(textOf(retry)).toContain("Idempotency replay");
    expect(textOf(retry)).toContain("test-key-2026-06-27-01");
    expect(textOf(retry)).toContain("updated"); // original result still there
    expect(updatePurchaseOrder).toHaveBeenCalledTimes(1); // STILL 1 — no re-execution
  });

  it("rejects retry with same idempotency_key but DIFFERENT args (key-reuse guard)", async () => {
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: true, purchaseOrderId: 39752, message: "saved",
    });
    const getPurchaseOrder = vi.fn().mockResolvedValue(baseDetail);
    const api = fakeApi({
      updatePurchaseOrder: updatePurchaseOrder as any,
      getPurchaseOrder: getPurchaseOrder as any,
    });
    const store = mkStore();
    const idem = new IdempotencyStore();
    const tool = findToolWithIdem(api, store, idem);

    // First call: rename to "X"
    const args1 = {
      purchase_order_id: 39752,
      name: "X",
      idempotency_key: "shared-key",
      verify: false,
    };
    const prompt = await tool.handler(args1, api);
    const confirmId = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    await tool.handler({ ...args1, confirmation_id: confirmId }, api);
    expect(updatePurchaseOrder).toHaveBeenCalledTimes(1);

    // Reuse key with DIFFERENT args (name: "Y")
    const result = await tool.handler(
      { purchase_order_id: 39752, name: "Y", idempotency_key: "shared-key", verify: false },
      api,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Idempotency key reused with different args");
    expect(textOf(result)).toContain("shared-key");
    expect(updatePurchaseOrder).toHaveBeenCalledTimes(1); // first call only
  });

  it("does NOT cache failures — retries get a fresh BT attempt", async () => {
    // First call fails (e.g. 403 lock). Retry should still hit BT, not
    // return the cached failure.
    const updatePurchaseOrder = vi.fn()
      .mockResolvedValueOnce({ success: false, errors: "HTTP 403 — locked" })
      .mockResolvedValueOnce({ success: true, purchaseOrderId: 39752, message: "saved" });
    const getPurchaseOrder = vi.fn().mockResolvedValue(baseDetail);
    const api = fakeApi({
      updatePurchaseOrder: updatePurchaseOrder as any,
      getPurchaseOrder: getPurchaseOrder as any,
    });
    const store = mkStore();
    const idem = new IdempotencyStore();
    const tool = findToolWithIdem(api, store, idem);

    const args = {
      purchase_order_id: 39752,
      name: "x",
      idempotency_key: "retry-on-failure-key",
      verify: false,
    };
    const prompt1 = await tool.handler(args, api);
    const cid1 = textOf(prompt1).match(/confirmation_id:\s*"([^"]+)"/)![1];
    const exec1 = await tool.handler({ ...args, confirmation_id: cid1 }, api);
    expect(exec1.isError).toBe(true);
    expect(textOf(exec1)).toContain("Failed");

    // Retry: should NOT be a cached-replay (failure isn't cached). It
    // goes through the confirmation flow again and the second BT call
    // succeeds.
    const prompt2 = await tool.handler(args, api);
    expect(textOf(prompt2)).not.toContain("Idempotency replay");
    expect(textOf(prompt2)).toContain("confirmation_id");
    const cid2 = textOf(prompt2).match(/confirmation_id:\s*"([^"]+)"/)![1];
    const exec2 = await tool.handler({ ...args, confirmation_id: cid2 }, api);
    expect(exec2.isError).toBeFalsy();
    expect(updatePurchaseOrder).toHaveBeenCalledTimes(2);
  });

  it("works when no idempotency_key is passed — historical behavior unchanged", async () => {
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: true, purchaseOrderId: 39752, message: "saved",
    });
    const getPurchaseOrder = vi.fn().mockResolvedValue(baseDetail);
    const api = fakeApi({
      updatePurchaseOrder: updatePurchaseOrder as any,
      getPurchaseOrder: getPurchaseOrder as any,
    });
    const store = mkStore();
    const idem = new IdempotencyStore();
    const tool = findToolWithIdem(api, store, idem);

    const args = { purchase_order_id: 39752, name: "x" };
    const prompt1 = await tool.handler(args, api);
    const cid1 = textOf(prompt1).match(/confirmation_id:\s*"([^"]+)"/)![1];
    await tool.handler({ ...args, confirmation_id: cid1 }, api);
    expect(updatePurchaseOrder).toHaveBeenCalledTimes(1);

    // Second call (no idempotency_key) is treated as a fresh write.
    const prompt2 = await tool.handler(args, api);
    expect(textOf(prompt2)).not.toContain("Idempotency");
    const cid2 = textOf(prompt2).match(/confirmation_id:\s*"([^"]+)"/)![1];
    await tool.handler({ ...args, confirmation_id: cid2 }, api);
    expect(updatePurchaseOrder).toHaveBeenCalledTimes(2);
    // Cache is empty — never touched.
    expect(idem.size).toBe(0);
  });

  it("`verify` flag is EXCLUDED from the fingerprint (retrying with verify:false after a verify:true timeout still hits the cache)", async () => {
    // This was the lead HIGH finding from the PR #60 review: if `verify`
    // were included in the fingerprint, a caller who passed `verify:
    // true` on the first (ambiguous-timeout) call and dropped to
    // `verify: false` on the safe retry would get a key-reuse error
    // instead of the cached replay. That defeats the whole point.
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: true, purchaseOrderId: 39752, message: "saved",
    });
    const getPurchaseOrder = vi.fn().mockResolvedValue(baseDetail);
    const api = fakeApi({
      updatePurchaseOrder: updatePurchaseOrder as any,
      getPurchaseOrder: getPurchaseOrder as any,
    });
    const store = mkStore();
    const idem = new IdempotencyStore();
    const tool = findToolWithIdem(api, store, idem);

    // First call: verify: false (cache populates)
    const args1 = {
      purchase_order_id: 39752,
      name: "renamed",
      idempotency_key: "verify-flag-exclusion-test",
      verify: false,
    };
    const prompt1 = await tool.handler(args1, api);
    const cid1 = textOf(prompt1).match(/confirmation_id:\s*"([^"]+)"/)![1];
    await tool.handler({ ...args1, confirmation_id: cid1 }, api);
    expect(updatePurchaseOrder).toHaveBeenCalledTimes(1);

    // Retry with verify:true → SAME write semantically, should hit cache.
    const retry = await tool.handler(
      { ...args1, verify: true },
      api,
    );
    expect(retry.isError).toBeFalsy();
    expect(textOf(retry)).toContain("Idempotency replay");
    expect(updatePurchaseOrder).toHaveBeenCalledTimes(1); // no re-execution
  });

  it("does NOT populate the cache during the confirmation-prompt phase", async () => {
    // The store check requires `data.confirmation_id && !result.isError`.
    // The prompt phase has no confirmation_id, so the cache must remain
    // empty until the execute phase. This test guards against accidental
    // re-ordering or removal of that condition — if it regressed, every
    // subsequent retry would replay a cached confirmation prompt instead
    // of executing the actual write.
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: true, purchaseOrderId: 39752, message: "saved",
    });
    const getPurchaseOrder = vi.fn().mockResolvedValue(baseDetail);
    const api = fakeApi({
      updatePurchaseOrder: updatePurchaseOrder as any,
      getPurchaseOrder: getPurchaseOrder as any,
    });
    const store = mkStore();
    const idem = new IdempotencyStore();
    const tool = findToolWithIdem(api, store, idem);

    const args = {
      purchase_order_id: 39752,
      name: "x",
      idempotency_key: "prompt-no-cache",
      verify: false,
    };
    // Prompt only — no confirmation_id, no execute.
    await tool.handler(args, api);
    expect(idem.size).toBe(0);
  });

  it("Zod enforces idempotency_key min length 8 (prevents trivial collisions)", async () => {
    const api = fakeApi({});
    const store = mkStore();
    const idem = new IdempotencyStore();
    const tool = findToolWithIdem(api, store, idem);
    const result = await tool.handler(
      { purchase_order_id: 39752, name: "x", idempotency_key: "short" },
      api,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("idempotency_key");
  });
});

describe("update_purchase_order — auto-transition unlock_if_locked (PR #61)", () => {
  // Helper that wires the locked-PO snapshot into the pre-fetch
  const confirmedSnapshot = {
    id: 39201, projectId: 185936, name: "X", number: "", prefix: "PO",
    status: 3, // Confirmed = write-locked
    description: "",
    companyId: 15, companyName: "Euro Stone Craft",
    items: [{ id: 1, budgetCategoryId: 1680, budgetCategoryCode: "7051", budgetCategoryName: "Countertops Allowance", total: "17380.47", notes: "", internalNotes: "", invoiceRelated: "0.00", amounts: [], companyId: 15, companyName: "Euro Stone Craft" }],
    totalNumeric: 17380.47,
  };

  it("rejects a content update on a locked PO when unlock_if_locked is NOT set (lock error surfaces via the API layer)", async () => {
    // When unlock_if_locked is off, the tool layer doesn't pre-fetch
    // (saves an HTTP call on the common non-locked path) and relies on
    // updatePurchaseOrder's own proactive lock check. The API layer
    // returns the lock error; the tool layer surfaces it verbatim. We
    // mock updatePurchaseOrder to return exactly what the API layer
    // would.
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: false,
      currentStatus: 3,
      errors:
        "PO #39201 is in **Confirmed** state (code 3) — BuildTools' /purchase-orders/save endpoint refuses ALL writes on it. To apply changes anyway, re-invoke with `unlock_if_locked: true`.",
    });
    const transitionPurchaseOrderStatus = vi.fn();
    const api = fakeApi({
      updatePurchaseOrder: updatePurchaseOrder as any,
      transitionPurchaseOrderStatus: transitionPurchaseOrderStatus as any,
    });
    const tool = findUpdatePoTool(api, mkStore());
    const args = {
      purchase_order_id: 39201,
      name: "renamed",
      verify: false,
      // unlock_if_locked NOT set
    };
    const prompt = await tool.handler(args, api);
    const confirmationId = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    const result = await tool.handler({ ...args, confirmation_id: confirmationId }, api);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Confirmed");
    expect(textOf(result)).toContain("unlock_if_locked");
    // No status transitions attempted — we never entered the
    // auto-transition path.
    expect(transitionPurchaseOrderStatus).not.toHaveBeenCalled();
  });

  it("orchestrates demote → /save → restore-to-Sent when unlock_if_locked is set against a Confirmed PO", async () => {
    const getPurchaseOrder = vi
      .fn()
      // Outer-handler snapshot — locked Confirmed
      .mockResolvedValueOnce(confirmedSnapshot)
      // Executor live re-fetch (HIGH-1 race fix) — still Confirmed
      .mockResolvedValueOnce(confirmedSnapshot)
      // Post-save verify fetch — items now $19533.81, status now Sent
      .mockResolvedValueOnce({
        ...confirmedSnapshot,
        status: 2,
        items: [{ ...confirmedSnapshot.items[0], total: "19533.81" }],
        totalNumeric: 19533.81,
      });
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: true, purchaseOrderId: 39201, message: "saved",
    });
    const transitionPurchaseOrderStatus = vi.fn().mockResolvedValue({
      success: true, message: "Status updated.",
    });
    const api = fakeApi({
      getPurchaseOrder: getPurchaseOrder as any,
      updatePurchaseOrder: updatePurchaseOrder as any,
      transitionPurchaseOrderStatus: transitionPurchaseOrderStatus as any,
    });
    const tool = findUpdatePoTool(api, mkStore());
    const args = {
      purchase_order_id: 39201,
      items: [{ budget_code: "7051", description: "ADMO55739-F", total: 19533.81 }],
      unlock_if_locked: true,
      // No `status` passed → restore defaults to Sent (2)
    };
    const prompt = await tool.handler(args, api);
    const promptText = textOf(prompt);
    // Confirmation prompt surfaces the full plan + side-effect warning.
    expect(promptText).toContain("Auto-transition");
    expect(promptText).toContain("Confirmed → Draft → apply edits → Sent");
    expect(promptText).toContain("vendor will see");

    const confirmationId = promptText.match(/confirmation_id:\s*"([^"]+)"/)![1];
    const exec = await tool.handler({ ...args, confirmation_id: confirmationId }, api);
    expect(exec.isError).toBeFalsy();

    // Sequence: demote(1) → /save → restore(2).
    expect(transitionPurchaseOrderStatus).toHaveBeenCalledTimes(2);
    expect(transitionPurchaseOrderStatus.mock.calls[0][0]).toEqual({ purchaseOrderId: 39201, status: 1 });
    expect(transitionPurchaseOrderStatus.mock.calls[1][0]).toEqual({ purchaseOrderId: 39201, status: 2 });
    expect(updatePurchaseOrder).toHaveBeenCalledTimes(1);
    // /save MUST NOT carry a status field — that's the whole decoupling point.
    expect(updatePurchaseOrder.mock.calls[0][0].status).toBeUndefined();

    const execText = textOf(exec);
    expect(execText).toContain("demoted Confirmed → Draft");
    expect(execText).toContain("applied content changes");
    expect(execText).toContain("set status → Sent");
  });

  it("auto-transition: restores to CALLER's target status if provided (not the default Sent)", async () => {
    const getPurchaseOrder = vi
      .fn()
      .mockResolvedValueOnce(confirmedSnapshot) // outer snapshot
      .mockResolvedValueOnce(confirmedSnapshot) // executor live re-fetch
      .mockResolvedValueOnce({ ...confirmedSnapshot, status: 4 }); // Rejected (post-save, if verify ran)
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: true, purchaseOrderId: 39201, message: "saved",
    });
    const transitionPurchaseOrderStatus = vi.fn().mockResolvedValue({
      success: true, message: "ok",
    });
    const api = fakeApi({
      getPurchaseOrder: getPurchaseOrder as any,
      updatePurchaseOrder: updatePurchaseOrder as any,
      transitionPurchaseOrderStatus: transitionPurchaseOrderStatus as any,
    });
    const tool = findUpdatePoTool(api, mkStore());
    const args = {
      purchase_order_id: 39201,
      name: "renamed",
      status: "Rejected" as const,
      unlock_if_locked: true,
      verify: false,
    };
    const prompt = await tool.handler(args, api);
    expect(textOf(prompt)).toContain("Confirmed → Draft → apply edits → Rejected");
    const confirmationId = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    await tool.handler({ ...args, confirmation_id: confirmationId }, api);

    // Restore target = 4 (Rejected), not the default Sent.
    expect(transitionPurchaseOrderStatus.mock.calls[1][0]).toEqual({ purchaseOrderId: 39201, status: 4 });
  });

  it("auto-transition: rolls back to original status when the /save step fails between demote and restore", async () => {
    const getPurchaseOrder = vi.fn().mockResolvedValue(confirmedSnapshot);
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: false, errors: "HTTP 500 — fake server failure",
    });
    const transitionPurchaseOrderStatus = vi.fn().mockResolvedValue({
      success: true, message: "ok",
    });
    const api = fakeApi({
      getPurchaseOrder: getPurchaseOrder as any,
      updatePurchaseOrder: updatePurchaseOrder as any,
      transitionPurchaseOrderStatus: transitionPurchaseOrderStatus as any,
    });
    const tool = findUpdatePoTool(api, mkStore());
    const args = {
      purchase_order_id: 39201,
      items: [{ budget_code: "7051", description: "x", total: 100 }],
      unlock_if_locked: true,
      verify: false,
    };
    const prompt = await tool.handler(args, api);
    const confirmationId = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    const result = await tool.handler({ ...args, confirmation_id: confirmationId }, api);

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Failed to update PO #39201");
    expect(text).toContain("HTTP 500");
    expect(text).toContain("Restored to original");

    // Sequence: demote(1) → /save (fails) → restore(3 — original Confirmed)
    expect(transitionPurchaseOrderStatus).toHaveBeenCalledTimes(2);
    expect(transitionPurchaseOrderStatus.mock.calls[0][0].status).toBe(1);
    expect(transitionPurchaseOrderStatus.mock.calls[1][0].status).toBe(3);
  });

  it("auto-transition: when the rollback ALSO fails, surfaces a loud 'PO stranded in Draft' message", async () => {
    const getPurchaseOrder = vi.fn().mockResolvedValue(confirmedSnapshot);
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: false, errors: "save failed",
    });
    const transitionPurchaseOrderStatus = vi
      .fn()
      .mockResolvedValueOnce({ success: true, message: "demoted" })
      .mockResolvedValueOnce({ success: false, errors: "restore failed too" });
    const api = fakeApi({
      getPurchaseOrder: getPurchaseOrder as any,
      updatePurchaseOrder: updatePurchaseOrder as any,
      transitionPurchaseOrderStatus: transitionPurchaseOrderStatus as any,
    });
    const tool = findUpdatePoTool(api, mkStore());
    const args = {
      purchase_order_id: 39201,
      items: [{ budget_code: "7051", description: "x", total: 100 }],
      unlock_if_locked: true,
      verify: false,
    };
    const prompt = await tool.handler(args, api);
    const confirmationId = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    const result = await tool.handler({ ...args, confirmation_id: confirmationId }, api);

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Could not restore to Confirmed");
    expect(text).toContain("PO is now in Draft");
    expect(text).toContain("fix manually in the BT UI");
  });

  it("auto-transition: ignores stale snapshot — executor re-fetches live status and skips demote when PO is no longer locked (PR #61 review HIGH-1)", async () => {
    // Outer-handler snapshot said Confirmed; reality (executor's live
    // re-fetch) is Sent because a concurrent user already demoted →
    // edited → re-sent the PO. We must NOT issue our own demote — that
    // would silently regress the vendor-facing state.
    const getPurchaseOrder = vi
      .fn()
      // Outer snapshot — stale Confirmed
      .mockResolvedValueOnce(confirmedSnapshot)
      // Executor live re-fetch — now Sent
      .mockResolvedValueOnce({ ...confirmedSnapshot, status: 2 });
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: true, purchaseOrderId: 39201, message: "saved",
    });
    const transitionPurchaseOrderStatus = vi.fn();
    const api = fakeApi({
      getPurchaseOrder: getPurchaseOrder as any,
      updatePurchaseOrder: updatePurchaseOrder as any,
      transitionPurchaseOrderStatus: transitionPurchaseOrderStatus as any,
    });
    const tool = findUpdatePoTool(api, mkStore());
    const args = {
      purchase_order_id: 39201,
      items: [{ budget_code: "7051", description: "x", total: 100 }],
      unlock_if_locked: true,
      verify: false,
    };
    const prompt = await tool.handler(args, api);
    const confirmationId = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    const result = await tool.handler({ ...args, confirmation_id: confirmationId }, api);

    expect(result.isError).toBeFalsy();
    // No transitions issued: live state was already unlocked, /save
    // applied content directly.
    expect(transitionPurchaseOrderStatus).not.toHaveBeenCalled();
    expect(updatePurchaseOrder).toHaveBeenCalledTimes(1);
  });

  it("auto-transition: rolls back to ORIGINAL status when the final restore fails (PR #61 review HIGH-2)", async () => {
    // Demote(3→1) OK → /save OK → restore-to-Confirmed FAILS (signature
    // required at BT). Executor must roll back to original Confirmed
    // and report concretely, not leave the PO stranded in Draft with
    // content applied.
    const getPurchaseOrder = vi
      .fn()
      .mockResolvedValueOnce(confirmedSnapshot)
      .mockResolvedValueOnce(confirmedSnapshot);
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: true, purchaseOrderId: 39201, message: "saved",
    });
    const transitionPurchaseOrderStatus = vi
      .fn()
      .mockResolvedValueOnce({ success: true, message: "demoted" })
      .mockResolvedValueOnce({ success: false, errors: "The Signature field is required." })
      .mockResolvedValueOnce({ success: true, message: "rolled back" });
    const api = fakeApi({
      getPurchaseOrder: getPurchaseOrder as any,
      updatePurchaseOrder: updatePurchaseOrder as any,
      transitionPurchaseOrderStatus: transitionPurchaseOrderStatus as any,
    });
    const tool = findUpdatePoTool(api, mkStore());
    const args = {
      purchase_order_id: 39201,
      items: [{ budget_code: "7051", description: "ADMO55739-F", total: 19533.81 }],
      status: "Confirmed" as const,
      unlock_if_locked: true,
      verify: false,
    };
    const prompt = await tool.handler(args, api);
    // Prompt warns about the restore-step requirement (MEDIUM-1 fix).
    expect(textOf(prompt)).toContain("restore step is likely to fail");
    expect(textOf(prompt)).toContain("signature");
    const confirmationId = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    const result = await tool.handler({ ...args, confirmation_id: confirmationId }, api);

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("status transition to Confirmed failed");
    expect(text).toContain("Signature field is required");
    expect(text).toContain("Rolled back to original");
    expect(text).toContain("content edits remain applied");
    // Sequence: demote(1) → /save → restore-target(3 fails) → rollback(3 succeeds)
    expect(transitionPurchaseOrderStatus).toHaveBeenCalledTimes(3);
    expect(transitionPurchaseOrderStatus.mock.calls[0][0].status).toBe(1);
    expect(transitionPurchaseOrderStatus.mock.calls[1][0].status).toBe(3);
    expect(transitionPurchaseOrderStatus.mock.calls[2][0].status).toBe(3);
  });

  it("auto-transition: when both the final transition AND the rollback fail, surfaces a loud 'PO stranded in Draft' message", async () => {
    const getPurchaseOrder = vi
      .fn()
      .mockResolvedValueOnce(confirmedSnapshot)
      .mockResolvedValueOnce(confirmedSnapshot);
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: true, purchaseOrderId: 39201, message: "saved",
    });
    const transitionPurchaseOrderStatus = vi
      .fn()
      .mockResolvedValueOnce({ success: true, message: "demoted" })
      .mockResolvedValueOnce({ success: false, errors: "Signature required" })
      .mockResolvedValueOnce({ success: false, errors: "Rollback also failed (signature)" });
    const api = fakeApi({
      getPurchaseOrder: getPurchaseOrder as any,
      updatePurchaseOrder: updatePurchaseOrder as any,
      transitionPurchaseOrderStatus: transitionPurchaseOrderStatus as any,
    });
    const tool = findUpdatePoTool(api, mkStore());
    const args = {
      purchase_order_id: 39201,
      items: [{ budget_code: "7051", description: "x", total: 100 }],
      status: "Confirmed" as const,
      unlock_if_locked: true,
      verify: false,
    };
    const prompt = await tool.handler(args, api);
    const confirmationId = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    const result = await tool.handler({ ...args, confirmation_id: confirmationId }, api);

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Rollback to Confirmed ALSO failed");
    expect(text).toContain("PO is now in Draft with your content edits applied");
    expect(text).toContain("fix manually in the BT UI");
  });

  it("auto-transition: aborts cleanly when the demote step itself fails (PO unchanged)", async () => {
    const getPurchaseOrder = vi.fn().mockResolvedValue(confirmedSnapshot);
    const updatePurchaseOrder = vi.fn();
    const transitionPurchaseOrderStatus = vi.fn().mockResolvedValue({
      success: false, errors: "BT refused demote",
    });
    const api = fakeApi({
      getPurchaseOrder: getPurchaseOrder as any,
      updatePurchaseOrder: updatePurchaseOrder as any,
      transitionPurchaseOrderStatus: transitionPurchaseOrderStatus as any,
    });
    const tool = findUpdatePoTool(api, mkStore());
    const args = {
      purchase_order_id: 39201,
      items: [{ budget_code: "7051", description: "x", total: 100 }],
      unlock_if_locked: true,
      verify: false,
    };
    const prompt = await tool.handler(args, api);
    const confirmationId = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    const result = await tool.handler({ ...args, confirmation_id: confirmationId }, api);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Auto-transition: demote failed");
    expect(textOf(result)).toContain("PO unchanged");
    // /save was never attempted.
    expect(updatePurchaseOrder).not.toHaveBeenCalled();
    // Only the one demote attempt — no follow-up.
    expect(transitionPurchaseOrderStatus).toHaveBeenCalledTimes(1);
  });
});

describe("transition_purchase_order_status — standalone tool (PR #62)", () => {
  function findTransitionTool(api: BuildToolsAPI, store: ConfirmationStore) {
    const tools = createMutationTools(() => api, store);
    const tool = tools.find((t) => t.name === "transition_purchase_order_status");
    if (!tool) throw new Error("transition_purchase_order_status not registered");
    return tool;
  }

  it("registered with the expected schema (purchase_order_id + status by label or code)", () => {
    const api = fakeApi({});
    const tool = findTransitionTool(api, mkStore());
    const schema = tool.inputSchema as any;
    expect(schema.properties.purchase_order_id).toBeDefined();
    expect(schema.properties.status).toBeDefined();
    expect(schema.properties.confirmation_id).toBeDefined();
  });

  it("resolves label → code and calls api.transitionPurchaseOrderStatus", async () => {
    const transitionPurchaseOrderStatus = vi.fn().mockResolvedValue({
      success: true, message: "Status updated.",
    });
    const api = fakeApi({
      transitionPurchaseOrderStatus: transitionPurchaseOrderStatus as any,
    });
    const tool = findTransitionTool(api, mkStore());

    const args = { purchase_order_id: 39752, status: "Sent" as const };
    const prompt = await tool.handler(args, api);
    const promptText = textOf(prompt);
    // PR #64: prompt now renders "from ... → ..." with the # bolded.
    expect(promptText).toMatch(/Transition purchase order \*\*#39752\*\*/);
    expect(promptText).toContain("Sent");
    expect(promptText.toLowerCase()).toContain("from");

    const confirmationId = promptText.match(/confirmation_id:\s*"([^"]+)"/)![1];
    const result = await tool.handler({ ...args, confirmation_id: confirmationId }, api);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Sent");

    expect(transitionPurchaseOrderStatus).toHaveBeenCalledTimes(1);
    expect(transitionPurchaseOrderStatus.mock.calls[0][0]).toEqual({
      purchaseOrderId: 39752,
      status: 2,
    });
  });

  it("accepts numeric status codes", async () => {
    const transitionPurchaseOrderStatus = vi.fn().mockResolvedValue({
      success: true, message: "ok",
    });
    const api = fakeApi({
      transitionPurchaseOrderStatus: transitionPurchaseOrderStatus as any,
    });
    const tool = findTransitionTool(api, mkStore());

    const args = { purchase_order_id: 39752, status: 1 };
    const prompt = await tool.handler(args, api);
    const cid = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    await tool.handler({ ...args, confirmation_id: cid }, api);
    expect(transitionPurchaseOrderStatus.mock.calls[0][0].status).toBe(1);
  });

  it("surfaces transition errors from the API verbatim (e.g. signature requirement)", async () => {
    const transitionPurchaseOrderStatus = vi.fn().mockResolvedValue({
      success: false, errors: "The Signature field is required.",
    });
    const api = fakeApi({
      transitionPurchaseOrderStatus: transitionPurchaseOrderStatus as any,
    });
    const tool = findTransitionTool(api, mkStore());

    const args = { purchase_order_id: 39752, status: "Confirmed" as const };
    const prompt = await tool.handler(args, api);
    const cid = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    const result = await tool.handler({ ...args, confirmation_id: cid }, api);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Signature field is required");
  });

  it("Zod rejects unknown status labels at the schema layer", async () => {
    const api = fakeApi({});
    const tool = findTransitionTool(api, mkStore());
    const result = await tool.handler(
      { purchase_order_id: 39752, status: "Bogus" },
      api,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result).toLowerCase()).toContain("status");
  });

  // ---------- PR #64 retro-review fixes for PR #62 ----------

  it("review MEDIUM (M3): rejects arbitrary numeric status codes (status: 999)", async () => {
    const transitionPurchaseOrderStatus = vi.fn();
    const api = fakeApi({
      transitionPurchaseOrderStatus: transitionPurchaseOrderStatus as any,
    });
    const tool = findTransitionTool(api, mkStore());
    // status: 999 passes Zod (z.number() accepts any number) but
    // resolvePoStatusCode now whitelists against the known enum.
    const result = await tool.handler(
      { purchase_order_id: 39752, status: 999 },
      api,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Unknown PO status code 999");
    // CRITICAL: BT was never called with a bogus code.
    expect(transitionPurchaseOrderStatus).not.toHaveBeenCalled();
  });

  it("review MEDIUM (M2): confirmation prompt shows current status (live fetch anchor)", async () => {
    const getPurchaseOrder = vi.fn().mockResolvedValue({
      id: 39752,
      projectId: 185966,
      name: "Test PO for prompt rendering",
      number: "", prefix: "PO",
      status: 2, // Sent
      description: "",
      companyId: 977, companyName: "Kai Muten, LLC",
      items: [{ id: 1, budgetCategoryId: 1621, budgetCategoryCode: "6030", budgetCategoryName: "Plumbing Sub", total: "100", notes: "", internalNotes: "", invoiceRelated: "0.00", amounts: [], companyId: 977, companyName: "Kai Muten, LLC" }],
      totalNumeric: 100,
    });
    const api = fakeApi({
      getPurchaseOrder: getPurchaseOrder as any,
    });
    const tool = findTransitionTool(api, mkStore());
    const prompt = await tool.handler(
      { purchase_order_id: 39752, status: "Draft" as const },
      api,
    );
    const text = textOf(prompt);
    // Current status surfaced — from Sent (2) → Draft (1)
    expect(text).toMatch(/from \*\*Sent \(2\)\*\*/);
    expect(text).toMatch(/Draft \(1\)/);
    // PO name surfaced for additional grounding
    expect(text).toContain("Test PO for prompt rendering");
  });

  it("review MEDIUM (M2): prompt degrades gracefully when current-status fetch fails", async () => {
    const getPurchaseOrder = vi.fn().mockRejectedValue(new Error("transient BT 503"));
    const api = fakeApi({
      getPurchaseOrder: getPurchaseOrder as any,
    });
    const tool = findTransitionTool(api, mkStore());
    const prompt = await tool.handler(
      { purchase_order_id: 39752, status: "Draft" as const },
      api,
    );
    const text = textOf(prompt);
    // Falls through to a marker — the confirmation still works.
    expect(text).toContain("could not fetch current state");
    expect(text).toContain("Draft (1)");
  });

  it("review MEDIUM (M5): idempotency_key replays cached result on retry — cross-tool consistency restored", async () => {
    const transitionPurchaseOrderStatus = vi.fn().mockResolvedValue({
      success: true, message: "ok",
    });
    const getPurchaseOrder = vi.fn().mockResolvedValue({
      id: 39752, projectId: 185966, name: "x", number: "", prefix: "PO",
      status: 1, description: "",
      companyId: 977, companyName: "X",
      items: [], totalNumeric: 0,
    });
    const api = fakeApi({
      transitionPurchaseOrderStatus: transitionPurchaseOrderStatus as any,
      getPurchaseOrder: getPurchaseOrder as any,
    });
    const { IdempotencyStore } = await import("../../idempotency/index.js");
    const idem = new IdempotencyStore();
    const tools = createMutationTools(() => api, mkStore(), undefined, idem);
    const tool = tools.find((t) => t.name === "transition_purchase_order_status")!;

    const args = {
      purchase_order_id: 39752,
      status: "Sent" as const,
      idempotency_key: "pr64-transition-test",
    };
    const prompt = await tool.handler(args, api);
    const cid = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    await tool.handler({ ...args, confirmation_id: cid }, api);
    expect(transitionPurchaseOrderStatus).toHaveBeenCalledTimes(1);

    // Retry: same key + same args → cached replay
    const retry = await tool.handler(args, api);
    expect(textOf(retry)).toContain("Idempotency replay");
    expect(transitionPurchaseOrderStatus).toHaveBeenCalledTimes(1);
  });
});

describe("apply_vendor_quote — workflow consolidator (PR #63)", () => {
  function findTool(api: BuildToolsAPI, store: ConfirmationStore) {
    const tools = createMutationTools(() => api, store);
    const tool = tools.find((t) => t.name === "apply_vendor_quote");
    if (!tool) throw new Error("apply_vendor_quote not registered");
    return tool;
  }

  const poSnapshot = {
    id: 39201, projectId: 185936, name: "DesRoches Countertops", number: "", prefix: "PO",
    status: 3, // Confirmed
    description: "",
    companyId: 15, companyName: "Euro Stone Craft",
    items: [{ id: 1, budgetCategoryId: 1680, budgetCategoryCode: "7051", budgetCategoryName: "Countertops Allowance", total: "17380.47", notes: "", internalNotes: "", invoiceRelated: "0.00", amounts: [], companyId: 15, companyName: "Euro Stone Craft" }],
    totalNumeric: 17380.47,
  };

  const tinyPdfBase64 = Buffer.from("%PDF-1.4\n%test\n").toString("base64");

  const baseArgs = {
    company_id: 15,
    purchase_order_id: 39201,
    quote_total: 19533.81,
    quote_reference: "ADMO55739-F",
    filename: "ADMO55739-F.pdf",
    file_base64: tinyPdfBase64,
  };

  it("end-to-end happy path on Confirmed PO: demote → update → upload → transition to Sent", async () => {
    const getPurchaseOrder = vi.fn().mockResolvedValue(poSnapshot);
    const getCompany = vi.fn().mockResolvedValue({ name: "Euro Stone Craft" });
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: true, purchaseOrderId: 39201, message: "saved",
    });
    const transitionPurchaseOrderStatus = vi.fn().mockResolvedValue({
      success: true, message: "Status updated.",
    });
    const uploadAttachment = vi.fn().mockResolvedValue({
      fileId: 146061,
      name: "ADMO55739-F.pdf",
      downloadUrl: "https://file.buildtools.app/o/0ye79w/file/hash/abc?download=1",
      size: 32,
      module: 1500,
      moduleId: 39201,
    });
    const api = fakeApi({
      getPurchaseOrder: getPurchaseOrder as any,
      getCompany: getCompany as any,
      updatePurchaseOrder: updatePurchaseOrder as any,
      transitionPurchaseOrderStatus: transitionPurchaseOrderStatus as any,
      uploadAttachment: uploadAttachment as any,
    });
    const tool = findTool(api, mkStore());

    const prompt = await tool.handler(baseArgs, api);
    const promptText = textOf(prompt);
    expect(promptText).toContain("Euro Stone Craft");
    expect(promptText).toContain("$17380.47 → **$19533.81**");
    expect(promptText).toContain("ADMO55739-F.pdf");
    expect(promptText).toContain("Auto-transition");
    expect(promptText).toContain("Confirmed");

    const confirmationId = promptText.match(/confirmation_id:\s*"([^"]+)"/)![1];
    const exec = await tool.handler({ ...baseArgs, confirmation_id: confirmationId }, api);
    expect(exec.isError).toBeFalsy();
    const execText = textOf(exec);
    expect(execText).toContain("demoted Confirmed → Draft");
    expect(execText).toContain("applied content (new total $19533.81)");
    expect(execText).toContain("status → Sent");
    expect(execText).toContain("file_id 146061");

    expect(transitionPurchaseOrderStatus.mock.calls[0][0]).toEqual({ purchaseOrderId: 39201, status: 1 });
    expect(updatePurchaseOrder).toHaveBeenCalledTimes(1);
    const updateCall = updatePurchaseOrder.mock.calls[0][0];
    expect(updateCall.items[0].total).toBe(19533.81);
    expect(updateCall.items[0].description).toBe("Confirmed order ADMO55739-F");
    expect(updateCall.items[0].budgetCode).toBe("7051");
    expect(transitionPurchaseOrderStatus.mock.calls[1][0]).toEqual({ purchaseOrderId: 39201, status: 2 });
    expect(uploadAttachment).toHaveBeenCalledTimes(1);
    expect(uploadAttachment.mock.calls[0][0].module).toBe(1500);
    expect(uploadAttachment.mock.calls[0][0].moduleId).toBe(39201);
    expect(uploadAttachment.mock.calls[0][0].projectId).toBe(185936);
  });

  it("vendor disambiguation: multiple companies match vendor_name → returns disambiguation prompt, no writes", async () => {
    const searchCompanies = vi.fn().mockResolvedValue({
      data: [
        { DT_RowId: "row_15", name: "Euro Stone Craft", type_name: "Vendor" },
        { DT_RowId: "row_99", name: "Euro Stone & Tile LLC", type_name: "Vendor" },
      ],
    });
    const updatePurchaseOrder = vi.fn();
    const api = fakeApi({
      searchCompanies: searchCompanies as any,
      updatePurchaseOrder: updatePurchaseOrder as any,
    });
    const tool = findTool(api, mkStore());

    const result = await tool.handler(
      { ...baseArgs, vendor_name: "Euro Stone", company_id: undefined } as any,
      api,
    );
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Multiple vendors match");
    expect(text).toContain("#15");
    expect(text).toContain("#99");
    expect(updatePurchaseOrder).not.toHaveBeenCalled();
  });

  it("vendor disambiguation: zero matches → clean error", async () => {
    const searchCompanies = vi.fn().mockResolvedValue({ data: [] });
    const api = fakeApi({ searchCompanies: searchCompanies as any });
    const tool = findTool(api, mkStore());

    const result = await tool.handler(
      { ...baseArgs, vendor_name: "Nonexistent Vendor", company_id: undefined } as any,
      api,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("No vendor matches");
  });

  it("vendor/PO mismatch: resolved PO is for a different company → clean error, no writes", async () => {
    const getPurchaseOrder = vi.fn().mockResolvedValue({
      ...poSnapshot, companyId: 999, companyName: "Wrong Vendor LLC",
    });
    const getCompany = vi.fn().mockResolvedValue({ name: "Euro Stone Craft" });
    const updatePurchaseOrder = vi.fn();
    const api = fakeApi({
      getPurchaseOrder: getPurchaseOrder as any,
      getCompany: getCompany as any,
      updatePurchaseOrder: updatePurchaseOrder as any,
    });
    const tool = findTool(api, mkStore());

    const result = await tool.handler(baseArgs, api);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Vendor mismatch");
    expect(textOf(result)).toContain("Wrong Vendor LLC");
    expect(updatePurchaseOrder).not.toHaveBeenCalled();
  });

  it("Rejected PO (status=4) → clean error, suggests create_purchase_order", async () => {
    const getPurchaseOrder = vi.fn().mockResolvedValue({ ...poSnapshot, status: 4 });
    const getCompany = vi.fn().mockResolvedValue({ name: "Euro Stone Craft" });
    const api = fakeApi({
      getPurchaseOrder: getPurchaseOrder as any,
      getCompany: getCompany as any,
    });
    const tool = findTool(api, mkStore());

    const result = await tool.handler(baseArgs, api);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Rejected");
    expect(textOf(result)).toContain("create_purchase_order");
  });

  it("rejects `data:` URL prefix on file_base64 (case-insensitive)", async () => {
    const api = fakeApi({});
    const tool = findTool(api, mkStore());
    for (const prefix of ["data:", "Data:", "DATA:"]) {
      const result = await tool.handler(
        { ...baseArgs, file_base64: `${prefix}application/pdf;base64,SGVsbG8=` },
        api,
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("data:");
    }
  });

  it("rejects files larger than 25 MB hard cap", async () => {
    const api = fakeApi({});
    const tool = findTool(api, mkStore());
    const huge = Buffer.alloc(30 * 1024 * 1024).toString("base64");
    const result = await tool.handler({ ...baseArgs, file_base64: huge }, api);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("25 MB");
  });

  it("Zod refines: both vendor_name AND company_id set → error", async () => {
    const api = fakeApi({});
    const tool = findTool(api, mkStore());
    const result = await tool.handler(
      { ...baseArgs, vendor_name: "X", company_id: 15 },
      api,
    );
    expect(result.isError).toBe(true);
  });

  it("Zod refines: both purchase_order_id AND project_id set → error", async () => {
    const api = fakeApi({});
    const tool = findTool(api, mkStore());
    const result = await tool.handler(
      { ...baseArgs, purchase_order_id: 39201, project_id: 185936 },
      api,
    );
    expect(result.isError).toBe(true);
  });

  it("attachment failure after successful PO update: surfaces partial success, no rollback", async () => {
    const getPurchaseOrder = vi.fn().mockResolvedValue({ ...poSnapshot, status: 1 });
    const getCompany = vi.fn().mockResolvedValue({ name: "Euro Stone Craft" });
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: true, purchaseOrderId: 39201, message: "saved",
    });
    const transitionPurchaseOrderStatus = vi.fn().mockResolvedValue({
      success: true, message: "ok",
    });
    const uploadAttachment = vi.fn().mockRejectedValue(new Error("Upload failed (HTTP 500): server error"));
    const api = fakeApi({
      getPurchaseOrder: getPurchaseOrder as any,
      getCompany: getCompany as any,
      updatePurchaseOrder: updatePurchaseOrder as any,
      transitionPurchaseOrderStatus: transitionPurchaseOrderStatus as any,
      uploadAttachment: uploadAttachment as any,
    });
    const tool = findTool(api, mkStore());

    const prompt = await tool.handler(baseArgs, api);
    const confirmationId = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    const exec = await tool.handler({ ...baseArgs, confirmation_id: confirmationId }, api);

    expect(exec.isError).toBeFalsy();
    const execText = textOf(exec);
    expect(execText).toContain("status → Sent");
    expect(execText).toContain("Attachment upload failed");
    expect(execText).toContain("upload_attachment");
    expect(updatePurchaseOrder).toHaveBeenCalledTimes(1);
  });

  it("project_id + vendor_name disambiguation: 0 POs on project for vendor → suggests create_purchase_order", async () => {
    const searchCompanies = vi.fn().mockResolvedValue({
      data: [{ DT_RowId: "row_15", name: "Euro Stone Craft", type_name: "Vendor" }],
    });
    const getPurchaseOrders = vi.fn().mockResolvedValue({ data: [] });
    const api = fakeApi({
      searchCompanies: searchCompanies as any,
      getPurchaseOrders: getPurchaseOrders as any,
    });
    const tool = findTool(api, mkStore());

    const result = await tool.handler(
      {
        ...baseArgs,
        vendor_name: "Euro Stone Craft",
        company_id: undefined,
        project_id: 185936,
        purchase_order_id: undefined,
      } as any,
      api,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("No existing PO");
    expect(textOf(result)).toContain("create_purchase_order");
  });

  it("auto_send: false → final status is Draft, no vendor email", async () => {
    const getPurchaseOrder = vi.fn().mockResolvedValue({ ...poSnapshot, status: 1 });
    const getCompany = vi.fn().mockResolvedValue({ name: "Euro Stone Craft" });
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: true, purchaseOrderId: 39201,
    });
    const transitionPurchaseOrderStatus = vi.fn().mockResolvedValue({ success: true });
    const uploadAttachment = vi.fn().mockResolvedValue({
      fileId: 1, name: "x.pdf", downloadUrl: "x", size: 1, module: 1500, moduleId: 39201,
    });
    const api = fakeApi({
      getPurchaseOrder: getPurchaseOrder as any,
      getCompany: getCompany as any,
      updatePurchaseOrder: updatePurchaseOrder as any,
      transitionPurchaseOrderStatus: transitionPurchaseOrderStatus as any,
      uploadAttachment: uploadAttachment as any,
    });
    const tool = findTool(api, mkStore());

    const args = { ...baseArgs, auto_send: false };
    const prompt = await tool.handler(args, api);
    expect(textOf(prompt)).toMatch(/Final status\*\*:\s*Draft/);
    const cid = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    const exec = await tool.handler({ ...args, confirmation_id: cid }, api);
    expect(exec.isError).toBeFalsy();
    // PR #63 review fix MEDIUM: PO already in Draft + auto_send:false →
    // target = Draft = current. Tool now SKIPS the redundant transition
    // (instead of issuing Draft→Draft which BT may treat as a duplicate).
    expect(transitionPurchaseOrderStatus).not.toHaveBeenCalled();
  });

  // ---------- PR #63 round-2 review fixes ----------

  it("review HIGH (race): re-fetches live status in executor — concurrent demote/edit/send by another user prevents an unintended demote", async () => {
    const getPurchaseOrder = vi
      .fn()
      // Outer-handler pre-snapshot — Confirmed (stale)
      .mockResolvedValueOnce(poSnapshot)
      // Executor live re-fetch — actually Sent now
      .mockResolvedValueOnce({ ...poSnapshot, status: 2 });
    const getCompany = vi.fn().mockResolvedValue({ name: "Euro Stone Craft" });
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: true, purchaseOrderId: 39201, message: "saved",
    });
    const transitionPurchaseOrderStatus = vi.fn().mockResolvedValue({
      success: true, message: "ok",
    });
    const uploadAttachment = vi.fn().mockResolvedValue({
      fileId: 1, name: "x.pdf", downloadUrl: "https://file.buildtools.app/o/0ye79w/file/hash/x?download=1", size: 1, module: 1500, moduleId: 39201,
    });
    const api = fakeApi({
      getPurchaseOrder: getPurchaseOrder as any,
      getCompany: getCompany as any,
      updatePurchaseOrder: updatePurchaseOrder as any,
      transitionPurchaseOrderStatus: transitionPurchaseOrderStatus as any,
      uploadAttachment: uploadAttachment as any,
    });
    const tool = findTool(api, mkStore());
    const prompt = await tool.handler(baseArgs, api);
    const cid = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    const exec = await tool.handler({ ...baseArgs, confirmation_id: cid }, api);
    expect(exec.isError).toBeFalsy();
    // NO demote issued (live PO is Sent, not locked).
    // Only the Sent→Sent skip OR a single transition.
    const demoteCalls = transitionPurchaseOrderStatus.mock.calls.filter(
      (c: any[]) => c[0].status === 1,
    );
    expect(demoteCalls).toHaveLength(0);
  });

  it("review HIGH (rollback): final-transition failure on auto-transition path rolls back to original Confirmed", async () => {
    const getPurchaseOrder = vi
      .fn()
      .mockResolvedValueOnce(poSnapshot) // outer
      .mockResolvedValueOnce(poSnapshot); // executor live re-fetch — still Confirmed
    const getCompany = vi.fn().mockResolvedValue({ name: "Euro Stone Craft" });
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: true, purchaseOrderId: 39201, message: "saved",
    });
    const transitionPurchaseOrderStatus = vi
      .fn()
      // Demote 3→1: OK
      .mockResolvedValueOnce({ success: true, message: "demoted" })
      // Restore-target 1→2 (Sent): FAILS
      .mockResolvedValueOnce({ success: false, errors: "BT refused the transition" })
      // Rollback 1→3 (original Confirmed): OK
      .mockResolvedValueOnce({ success: true, message: "rolled back" });
    const uploadAttachment = vi.fn();
    const api = fakeApi({
      getPurchaseOrder: getPurchaseOrder as any,
      getCompany: getCompany as any,
      updatePurchaseOrder: updatePurchaseOrder as any,
      transitionPurchaseOrderStatus: transitionPurchaseOrderStatus as any,
      uploadAttachment: uploadAttachment as any,
    });
    const tool = findTool(api, mkStore());
    const prompt = await tool.handler(baseArgs, api);
    const cid = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    const exec = await tool.handler({ ...baseArgs, confirmation_id: cid }, api);
    expect(exec.isError).toBe(true);
    expect(textOf(exec)).toContain("Rolled back to original");
    expect(transitionPurchaseOrderStatus).toHaveBeenCalledTimes(3);
    expect(transitionPurchaseOrderStatus.mock.calls[2][0]).toEqual({ purchaseOrderId: 39201, status: 3 });
  });

  it("review HIGH (idempotency): retry with same idempotency_key + same args returns cached result, no second BT call", async () => {
    const getPurchaseOrder = vi.fn().mockResolvedValue({ ...poSnapshot, status: 1 });
    const getCompany = vi.fn().mockResolvedValue({ name: "Euro Stone Craft" });
    const updatePurchaseOrder = vi.fn().mockResolvedValue({ success: true });
    const transitionPurchaseOrderStatus = vi.fn().mockResolvedValue({ success: true });
    const uploadAttachment = vi.fn().mockResolvedValue({
      fileId: 1, name: "x.pdf", downloadUrl: "https://file.buildtools.app/o/0ye79w/file/hash/x?download=1", size: 1, module: 1500, moduleId: 39201,
    });
    const api = fakeApi({
      getPurchaseOrder: getPurchaseOrder as any,
      getCompany: getCompany as any,
      updatePurchaseOrder: updatePurchaseOrder as any,
      transitionPurchaseOrderStatus: transitionPurchaseOrderStatus as any,
      uploadAttachment: uploadAttachment as any,
    });
    const { IdempotencyStore } = await import("../../idempotency/index.js");
    const idem = new IdempotencyStore();
    const tools = createMutationTools(() => api, mkStore(), undefined, idem);
    const tool = tools.find((t) => t.name === "apply_vendor_quote")!;

    const args = { ...baseArgs, idempotency_key: "round-2-replay-test" };
    const prompt = await tool.handler(args, api);
    const cid = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    const exec = await tool.handler({ ...args, confirmation_id: cid }, api);
    expect(exec.isError).toBeFalsy();
    expect(updatePurchaseOrder).toHaveBeenCalledTimes(1);

    // Retry with same key + same args → cached replay
    const retry = await tool.handler(args, api);
    expect(textOf(retry)).toContain("Idempotency replay");
    expect(updatePurchaseOrder).toHaveBeenCalledTimes(1); // STILL 1
    expect(uploadAttachment).toHaveBeenCalledTimes(1); // STILL 1
  });

  it("review HIGH (vendor null bypass): PO with companyId=null treated as mismatch — refuses to overwrite", async () => {
    const getPurchaseOrder = vi.fn().mockResolvedValue({
      ...poSnapshot, companyId: null, companyName: null,
    });
    const getCompany = vi.fn().mockResolvedValue({ name: "Euro Stone Craft" });
    const updatePurchaseOrder = vi.fn();
    const api = fakeApi({
      getPurchaseOrder: getPurchaseOrder as any,
      getCompany: getCompany as any,
      updatePurchaseOrder: updatePurchaseOrder as any,
    });
    const tool = findTool(api, mkStore());
    const result = await tool.handler(baseArgs, api);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Vendor mismatch");
    expect(textOf(result)).toContain("no vendor assigned");
    expect(updatePurchaseOrder).not.toHaveBeenCalled();
  });

  it("review HIGH (HTML entities): vendor name with `&amp;` matches caller query `M&D`", async () => {
    const searchCompanies = vi.fn().mockResolvedValue({
      data: [{ DT_RowId: "row_42", name: "M&amp;D Construction LLC", type_name: "Vendor" }],
    });
    const getPurchaseOrder = vi.fn().mockResolvedValue({
      ...poSnapshot, companyId: 42, companyName: "M&D Construction LLC",
    });
    const updatePurchaseOrder = vi.fn().mockResolvedValue({ success: true });
    const transitionPurchaseOrderStatus = vi.fn().mockResolvedValue({ success: true });
    const uploadAttachment = vi.fn().mockResolvedValue({
      fileId: 1, name: "x.pdf", downloadUrl: "https://file.buildtools.app/o/x/file/hash/x?download=1", size: 1, module: 1500, moduleId: 39201,
    });
    const api = fakeApi({
      searchCompanies: searchCompanies as any,
      getPurchaseOrder: getPurchaseOrder as any,
      updatePurchaseOrder: updatePurchaseOrder as any,
      transitionPurchaseOrderStatus: transitionPurchaseOrderStatus as any,
      uploadAttachment: uploadAttachment as any,
    });
    const tool = findTool(api, mkStore());
    const args = {
      vendor_name: "M&D Construction LLC", // user types &, not &amp;
      purchase_order_id: 39201,
      quote_total: 100,
      filename: "x.pdf",
      file_base64: tinyPdfBase64,
    };
    const prompt = await tool.handler(args, api);
    // Should NOT return a disambiguation; the exact match should fire.
    expect(textOf(prompt)).not.toContain("Multiple vendors match");
    expect(textOf(prompt)).toContain("confirmation_id");
  });

  it("review HIGH (notes field): `notes` is internal-only, NEVER becomes the public line description", async () => {
    const getPurchaseOrder = vi.fn().mockResolvedValue({ ...poSnapshot, status: 1 });
    const getCompany = vi.fn().mockResolvedValue({ name: "Euro Stone Craft" });
    const updatePurchaseOrder = vi.fn().mockResolvedValue({ success: true });
    const transitionPurchaseOrderStatus = vi.fn().mockResolvedValue({ success: true });
    const uploadAttachment = vi.fn().mockResolvedValue({
      fileId: 1, name: "x.pdf", downloadUrl: "https://file.buildtools.app/o/x/file/hash/x?download=1", size: 1, module: 1500, moduleId: 39201,
    });
    const api = fakeApi({
      getPurchaseOrder: getPurchaseOrder as any,
      getCompany: getCompany as any,
      updatePurchaseOrder: updatePurchaseOrder as any,
      transitionPurchaseOrderStatus: transitionPurchaseOrderStatus as any,
      uploadAttachment: uploadAttachment as any,
    });
    const tool = findTool(api, mkStore());
    const sensitiveNote = "INTERNAL: do not show to vendor — PM still negotiating";
    const args = {
      ...baseArgs,
      notes: sensitiveNote,
    };
    const prompt = await tool.handler(args, api);
    const cid = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    await tool.handler({ ...args, confirmation_id: cid }, api);
    const item = updatePurchaseOrder.mock.calls[0][0].items[0];
    // CRITICAL: description is the public field. It must NOT contain the sensitive note.
    expect(item.description).not.toContain("INTERNAL");
    expect(item.description).toBe("Confirmed order ADMO55739-F");
    // The note IS in internalNotes (where it belongs).
    expect(item.internalNotes).toBe(sensitiveNote);
  });

  it("review LOW (size estimate): file >> 25MB rejected via base64 length estimate without Buffer allocation", async () => {
    const api = fakeApi({});
    const tool = findTool(api, mkStore());
    // A base64 string representing ~100 MB. Mock it directly — large
    // enough that the approx estimate alone rejects it.
    const huge = "A".repeat(150 * 1024 * 1024);
    const result = await tool.handler({ ...baseArgs, file_base64: huge }, api);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("25 MB");
  });

  it("review MEDIUM (collapse warning): prompt warns when multi-line PO will be replaced with one line", async () => {
    const multiLineSnapshot = {
      ...poSnapshot,
      itemCount: 3,
      items: [
        { ...poSnapshot.items[0], id: 1 },
        { ...poSnapshot.items[0], id: 2 },
        { ...poSnapshot.items[0], id: 3 },
      ],
    };
    const getPurchaseOrder = vi.fn().mockResolvedValue({ ...multiLineSnapshot, status: 1 });
    const getCompany = vi.fn().mockResolvedValue({ name: "Euro Stone Craft" });
    const api = fakeApi({
      getPurchaseOrder: getPurchaseOrder as any,
      getCompany: getCompany as any,
    });
    const tool = findTool(api, mkStore());
    const prompt = await tool.handler(baseArgs, api);
    expect(textOf(prompt)).toContain("replaces **3 existing lines**");
    expect(textOf(prompt)).toContain("update_purchase_order");
  });

  it("review MEDIUM (vendor email warning): unconditional warning when finalStatus is Sent, not just on auto-transition path", async () => {
    const getPurchaseOrder = vi.fn().mockResolvedValue({ ...poSnapshot, status: 1 }); // Draft, not locked
    const getCompany = vi.fn().mockResolvedValue({ name: "Euro Stone Craft" });
    const api = fakeApi({
      getPurchaseOrder: getPurchaseOrder as any,
      getCompany: getCompany as any,
    });
    const tool = findTool(api, mkStore());
    const prompt = await tool.handler(baseArgs, api);
    expect(textOf(prompt)).toContain("Vendor will receive an email");
  });

  it("review MEDIUM (quote_total): Zod rejects negative, zero, and Infinity", async () => {
    const api = fakeApi({});
    const tool = findTool(api, mkStore());
    for (const bad of [-100, 0, Infinity, NaN]) {
      const result = await tool.handler({ ...baseArgs, quote_total: bad }, api);
      expect(result.isError).toBe(true);
    }
  });

  it("review MEDIUM (content_type validation): Zod rejects non-MIME strings like `text/html<script>`", async () => {
    const api = fakeApi({});
    const tool = findTool(api, mkStore());
    const result = await tool.handler(
      { ...baseArgs, content_type: "text/html<script>alert(1)</script>" },
      api,
    );
    expect(result.isError).toBe(true);
  });

  it("review MEDIUM (downloadUrl validation): malicious URL from BT response is dropped from markdown link", async () => {
    const getPurchaseOrder = vi.fn().mockResolvedValue({ ...poSnapshot, status: 1 });
    const getCompany = vi.fn().mockResolvedValue({ name: "Euro Stone Craft" });
    const updatePurchaseOrder = vi.fn().mockResolvedValue({ success: true });
    const transitionPurchaseOrderStatus = vi.fn().mockResolvedValue({ success: true });
    const uploadAttachment = vi.fn().mockResolvedValue({
      fileId: 1,
      name: "x.pdf",
      // Attacker-controlled URL: javascript: scheme + closing paren
      downloadUrl: "javascript:alert(1))more text",
      size: 1,
      module: 1500,
      moduleId: 39201,
    });
    const api = fakeApi({
      getPurchaseOrder: getPurchaseOrder as any,
      getCompany: getCompany as any,
      updatePurchaseOrder: updatePurchaseOrder as any,
      transitionPurchaseOrderStatus: transitionPurchaseOrderStatus as any,
      uploadAttachment: uploadAttachment as any,
    });
    const tool = findTool(api, mkStore());
    const prompt = await tool.handler(baseArgs, api);
    const cid = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    const exec = await tool.handler({ ...baseArgs, confirmation_id: cid }, api);
    expect(exec.isError).toBeFalsy();
    // The hostile URL must NOT appear in the response.
    expect(textOf(exec)).not.toContain("javascript:");
    // No markdown link rendered when URL is rejected.
    expect(textOf(exec)).not.toContain("[Download]");
  });
});

describe("create_draw_request — workflow consolidator (PR #65)", () => {
  function findTool(api: BuildToolsAPI, store: ConfirmationStore) {
    const tools = createMutationTools(() => api, store);
    const tool = tools.find((t) => t.name === "create_draw_request");
    if (!tool) throw new Error("create_draw_request not registered");
    return tool;
  }

  const projectRow = { id: 100002, name: "Jones Addition" };
  const priorFs = {
    statusCount: {},
    statements: [
      { id: "1", name: "Draw #1 - 2026-01-15", status: "Paid", amount: 25000, paid: 25000, balance: 0, date: "2026-01-15" },
      { id: "2", name: "Draw #2 - 2026-02-15", status: "Sent", amount: 30000, paid: 0, balance: 30000, date: "2026-02-15" },
    ],
  };

  it("happy path with direct `amount`: prompt shows project + prior draws + new amount; executor creates the FS", async () => {
    const getProject = vi.fn().mockResolvedValue(projectRow);
    const getFinancialStatements = vi.fn().mockResolvedValue(priorFs);
    const createFinancialStatementWithAmount = vi.fn().mockResolvedValue({
      success: true, statementId: 700001, amount: "$ 40,000.00",
    });
    const api = fakeApi({
      getProject: getProject as any,
      getFinancialStatements: getFinancialStatements as any,
      createFinancialStatementWithAmount: createFinancialStatementWithAmount as any,
    });
    const tool = findTool(api, mkStore());
    const args = { project_id: 100002, amount: 40000 };
    const prompt = await tool.handler(args, api);
    const promptText = textOf(prompt);
    expect(promptText).toContain("Jones Addition");
    expect(promptText).toContain("Prior draws**: 2 statement(s) totalling $55000.00");
    expect(promptText).toContain("This draw amount**: **$40000.00**");
    expect(promptText).toContain("Cumulative after**: $95000.00");
    expect(promptText).toContain("Draw name**: Draw #3");

    const cid = promptText.match(/confirmation_id:\s*"([^"]+)"/)![1];
    const exec = await tool.handler({ ...args, confirmation_id: cid }, api);
    expect(exec.isError).toBeFalsy();
    expect(textOf(exec)).toContain("Draw request **#700001**");
    expect(createFinancialStatementWithAmount).toHaveBeenCalledTimes(1);
    const call = createFinancialStatementWithAmount.mock.calls[0][0];
    expect(call.amount).toBe(40000);
    expect(call.projectId).toBe(100002);
    expect(call.name).toMatch(/^Draw #3/);
    expect(call.status).toBe(1); // Draft default
  });

  it("work_completed_to_date path: tool computes `(work × (1-retainage)) - prior_draws`", async () => {
    const getProject = vi.fn().mockResolvedValue(projectRow);
    const getFinancialStatements = vi.fn().mockResolvedValue(priorFs);
    const createFinancialStatementWithAmount = vi.fn().mockResolvedValue({
      success: true, statementId: 700002,
    });
    const api = fakeApi({
      getProject: getProject as any,
      getFinancialStatements: getFinancialStatements as any,
      createFinancialStatementWithAmount: createFinancialStatementWithAmount as any,
    });
    const tool = findTool(api, mkStore());
    // work_completed = 100k, retainage = 10%, prior = 55k
    // expected = 100k × 0.9 − 55k = 35k
    const args = {
      project_id: 100002,
      work_completed_to_date: 100000,
      retainage_percent: 10,
    };
    const prompt = await tool.handler(args, api);
    const promptText = textOf(prompt);
    expect(promptText).toContain("Work completed to date**: $100000.00");
    expect(promptText).toContain("Retainage**: 10% ($10000.00 held back)");
    expect(promptText).toContain("Billable to date (after retainage)**: $90000.00");
    expect(promptText).toContain("− Prior draws**: $55000.00");
    expect(promptText).toContain("This draw amount**: **$35000.00**");

    const cid = promptText.match(/confirmation_id:\s*"([^"]+)"/)![1];
    await tool.handler({ ...args, confirmation_id: cid }, api);
    expect(createFinancialStatementWithAmount.mock.calls[0][0].amount).toBe(35000);
  });

  it("Zod refines: both amount AND work_completed_to_date → error", async () => {
    const api = fakeApi({});
    const tool = findTool(api, mkStore());
    const result = await tool.handler(
      { project_id: 100002, amount: 1000, work_completed_to_date: 5000 },
      api,
    );
    expect(result.isError).toBe(true);
  });

  it("Zod refines: neither amount NOR work_completed_to_date → error", async () => {
    const api = fakeApi({});
    const tool = findTool(api, mkStore());
    const result = await tool.handler({ project_id: 100002 }, api);
    expect(result.isError).toBe(true);
  });

  it("non-positive computed amount: surfaces clean error BEFORE the confirmation prompt (PR #65 review MEDIUM 4)", async () => {
    const getProject = vi.fn().mockResolvedValue(projectRow);
    const getFinancialStatements = vi.fn().mockResolvedValue(priorFs); // prior = 55000
    const createFinancialStatementWithAmount = vi.fn();
    const api = fakeApi({
      getProject: getProject as any,
      getFinancialStatements: getFinancialStatements as any,
      createFinancialStatementWithAmount: createFinancialStatementWithAmount as any,
    });
    const tool = findTool(api, mkStore());
    // work_completed = 50k, retainage = 0, prior = 55k → -5k
    const args = { project_id: 100002, work_completed_to_date: 50000 };
    // FIRST call returns the error directly — no confirmation prompt
    // for an impossible amount.
    const result = await tool.handler(args, api);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("non-positive");
    expect(textOf(result)).toContain("$55000.00"); // prior shown
    expect(textOf(result)).toContain("$50000.00"); // work shown
    // No confirmation prompt was returned (no confirmation_id to consume).
    expect(textOf(result)).not.toContain("confirmation_id");
    expect(createFinancialStatementWithAmount).not.toHaveBeenCalled();
  });

  it("draw number auto-increments from existing 'Draw #N' names, not just count", async () => {
    // Statements with gaps: "Draw #5" exists but only 2 records.
    const getProject = vi.fn().mockResolvedValue(projectRow);
    const getFinancialStatements = vi.fn().mockResolvedValue({
      statusCount: {},
      statements: [
        { id: "1", name: "Initial Deposit", status: "Paid", amount: 10000, paid: 10000, balance: 0, date: "2026-01-01" },
        { id: "2", name: "Draw #5 - 2026-03-15", status: "Sent", amount: 20000, paid: 0, balance: 20000, date: "2026-03-15" },
      ],
    });
    const createFinancialStatementWithAmount = vi.fn().mockResolvedValue({ success: true, statementId: 1 });
    const api = fakeApi({
      getProject: getProject as any,
      getFinancialStatements: getFinancialStatements as any,
      createFinancialStatementWithAmount: createFinancialStatementWithAmount as any,
    });
    const tool = findTool(api, mkStore());
    const args = { project_id: 100002, amount: 5000 };
    const prompt = await tool.handler(args, api);
    expect(textOf(prompt)).toContain("Draw #6"); // max(5)+1, NOT count(2)+1=3
  });

  it("caller override: `draw_number`, `name`, and `status` all bypass auto-resolution", async () => {
    const getProject = vi.fn().mockResolvedValue(projectRow);
    const getFinancialStatements = vi.fn().mockResolvedValue(priorFs);
    const createFinancialStatementWithAmount = vi.fn().mockResolvedValue({ success: true, statementId: 1 });
    const api = fakeApi({
      getProject: getProject as any,
      getFinancialStatements: getFinancialStatements as any,
      createFinancialStatementWithAmount: createFinancialStatementWithAmount as any,
    });
    const tool = findTool(api, mkStore());
    const args = {
      project_id: 100002,
      amount: 10000,
      draw_number: 99,
      name: "Custom Draw Name",
      status: 5, // Sent
    };
    const prompt = await tool.handler(args, api);
    const promptText = textOf(prompt);
    expect(promptText).toContain("Custom Draw Name");
    // PR #65 review MEDIUM 5: when `name` is overridden, the
    // "Draw #N" line is suppressed (BT FS has no separate draw#
    // column). Caller's draw_number is now used internally only —
    // not shown in the prompt because BT won't store it.
    expect(promptText).not.toContain("Draw #**: 99");
    expect(promptText).toContain("status code 5");

    const cid = promptText.match(/confirmation_id:\s*"([^"]+)"/)![1];
    await tool.handler({ ...args, confirmation_id: cid }, api);
    const call = createFinancialStatementWithAmount.mock.calls[0][0];
    expect(call.name).toBe("Custom Draw Name");
    expect(call.status).toBe(5);
  });

  it("prior FS fetch failure: clean error before BT mutation, suggests workaround", async () => {
    const getProject = vi.fn().mockResolvedValue(projectRow);
    const getFinancialStatements = vi.fn().mockRejectedValue(new Error("BT 503"));
    const createFinancialStatementWithAmount = vi.fn();
    const api = fakeApi({
      getProject: getProject as any,
      getFinancialStatements: getFinancialStatements as any,
      createFinancialStatementWithAmount: createFinancialStatementWithAmount as any,
    });
    const tool = findTool(api, mkStore());
    const result = await tool.handler(
      { project_id: 100002, amount: 5000 },
      api,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Could not list prior draws");
    expect(textOf(result)).toContain("BT 503");
    expect(createFinancialStatementWithAmount).not.toHaveBeenCalled();
  });

  it("idempotency replay: retry with same key + same args returns cached result, no second BT call", async () => {
    const getProject = vi.fn().mockResolvedValue(projectRow);
    const getFinancialStatements = vi.fn().mockResolvedValue(priorFs);
    const createFinancialStatementWithAmount = vi.fn().mockResolvedValue({
      success: true, statementId: 700100,
    });
    const api = fakeApi({
      getProject: getProject as any,
      getFinancialStatements: getFinancialStatements as any,
      createFinancialStatementWithAmount: createFinancialStatementWithAmount as any,
    });
    const { IdempotencyStore } = await import("../../idempotency/index.js");
    const idem = new IdempotencyStore();
    const tools = createMutationTools(() => api, mkStore(), undefined, idem);
    const tool = tools.find((t) => t.name === "create_draw_request")!;

    const args = {
      project_id: 100002,
      amount: 40000,
      idempotency_key: "pr65-replay-test",
    };
    const prompt = await tool.handler(args, api);
    const cid = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    await tool.handler({ ...args, confirmation_id: cid }, api);
    expect(createFinancialStatementWithAmount).toHaveBeenCalledTimes(1);

    const retry = await tool.handler(args, api);
    expect(textOf(retry)).toContain("Idempotency replay");
    expect(createFinancialStatementWithAmount).toHaveBeenCalledTimes(1);
  });

  // ---------- PR #65 review round-2 fixes ----------

  it("review HIGH 1: `due_date` is no longer in the schema — silently stripped, NOT shown in prompt (was: shown but silently dropped on commit)", async () => {
    const getProject = vi.fn().mockResolvedValue(projectRow);
    const getFinancialStatements = vi.fn().mockResolvedValue(priorFs);
    const api = fakeApi({
      getProject: getProject as any,
      getFinancialStatements: getFinancialStatements as any,
    });
    const tool = findTool(api, mkStore());
    const prompt = await tool.handler(
      { project_id: 100002, amount: 5000, due_date: "2026-07-15" } as any,
      api,
    );
    expect(prompt.isError).toBeFalsy();
    // CRITICAL: due_date does NOT appear in the prompt because the
    // schema strips it. Pre-fix, it WAS shown in the prompt and then
    // silently dropped at the BT call layer — a data-loss bug.
    expect(textOf(prompt)).not.toContain("Due date");
    expect(textOf(prompt)).not.toContain("2026-07-15");
    expect(textOf(prompt)).not.toContain("due_date");
    // The schema definition itself doesn't list due_date as an input.
    const properties = (tool.inputSchema as any).properties;
    expect(properties.due_date).toBeUndefined();
  });

  it("review HIGH 2: prompt description mentions the formula assumption (not AIA G702)", async () => {
    // Verify the schema description names the methodology explicitly.
    const tool = findTool(fakeApi({}), mkStore());
    const desc = (tool.inputSchema as any).properties.work_completed_to_date.description;
    expect(desc).toContain("cumulative");
    expect(desc).toContain("NOT AIA G702");
  });

  it("review MEDIUM (status): Zod rejects unknown status codes like 3, 99, 1.5", async () => {
    const api = fakeApi({});
    const tool = findTool(api, mkStore());
    for (const bad of [3, 99, 1.5, 0, -1]) {
      const result = await tool.handler(
        { project_id: 100002, amount: 1000, status: bad },
        api,
      );
      expect(result.isError).toBe(true);
    }
  });

  it("review LOW: retainage_percent + amount → refine error (silent ignore would mis-bill)", async () => {
    const api = fakeApi({});
    const tool = findTool(api, mkStore());
    const result = await tool.handler(
      { project_id: 100002, amount: 1000, retainage_percent: 10 },
      api,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("retainage_percent");
  });

  it("review LOW: name field rejects non-ASCII (BT HTML-encoding without decoding)", async () => {
    const api = fakeApi({});
    const tool = findTool(api, mkStore());
    const result = await tool.handler(
      { project_id: 100002, amount: 1000, name: "Café Draw" },
      api,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result).toLowerCase()).toContain("ascii");
  });

  it("review LOW (rounding): priorDrawsSum rounded before display so prompt matches executor", async () => {
    // 3 statements at $33333.33 → raw sum $99999.99 (float drift would
    // make it 99999.99000000001). Test that rounding produces clean display.
    const getProject = vi.fn().mockResolvedValue(projectRow);
    const getFinancialStatements = vi.fn().mockResolvedValue({
      statusCount: {},
      statements: [
        { id: "1", name: "Draw #1", status: "Paid", amount: 33333.33, paid: 0, balance: 0, date: "" },
        { id: "2", name: "Draw #2", status: "Paid", amount: 33333.33, paid: 0, balance: 0, date: "" },
        { id: "3", name: "Draw #3", status: "Paid", amount: 33333.33, paid: 0, balance: 0, date: "" },
      ],
    });
    const api = fakeApi({
      getProject: getProject as any,
      getFinancialStatements: getFinancialStatements as any,
    });
    const tool = findTool(api, mkStore());
    const prompt = await tool.handler(
      { project_id: 100002, work_completed_to_date: 200000, retainage_percent: 10 },
      api,
    );
    const text = textOf(prompt);
    // $99999.99 (rounded), not $99999.99000000001
    expect(text).toContain("Prior draws**: 3 statement(s) totalling $99999.99");
    // billable = 200000 × 0.9 = 180000; minus 99999.99 = 80000.01
    expect(text).toContain("This draw amount**: **$80000.01**");
  });

  it("BT create failure: surfaces the API error verbatim", async () => {
    const getProject = vi.fn().mockResolvedValue(projectRow);
    const getFinancialStatements = vi.fn().mockResolvedValue(priorFs);
    const createFinancialStatementWithAmount = vi.fn().mockResolvedValue({
      success: false,
      errors: "Amount validation failed at BT",
    });
    const api = fakeApi({
      getProject: getProject as any,
      getFinancialStatements: getFinancialStatements as any,
      createFinancialStatementWithAmount: createFinancialStatementWithAmount as any,
    });
    const tool = findTool(api, mkStore());
    const args = { project_id: 100002, amount: 5000 };
    const prompt = await tool.handler(args, api);
    const cid = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    const exec = await tool.handler({ ...args, confirmation_id: cid }, api);
    expect(exec.isError).toBe(true);
    expect(textOf(exec)).toContain("Failed to create draw request");
    expect(textOf(exec)).toContain("Amount validation failed at BT");
  });
});

describe("bulk_transition_purchase_orders — PR #69", () => {
  function findTool(api: BuildToolsAPI, store: ConfirmationStore) {
    const tools = createMutationTools(() => api, store);
    const tool = tools.find((t) => t.name === "bulk_transition_purchase_orders");
    if (!tool) throw new Error("bulk_transition_purchase_orders not registered");
    return tool;
  }

  it("happy path: all 3 POs transition successfully", async () => {
    const bulkTransitionPurchaseOrderStatuses = vi.fn().mockResolvedValue({
      success: true,
      message: "Status updated.",
      successCount: 3,
      failureCount: 0,
    });
    const api = fakeApi({
      bulkTransitionPurchaseOrderStatuses: bulkTransitionPurchaseOrderStatuses as any,
    });
    const tool = findTool(api, mkStore());
    const args = { purchase_order_ids: [39201, 39202, 39203], status: "Sent" as const };
    const prompt = await tool.handler(args, api);
    expect(textOf(prompt)).toContain("Bulk-transition **3** purchase order(s) to **Sent (2)**");
    expect(textOf(prompt)).toContain("39201, 39202, 39203");
    const cid = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    const exec = await tool.handler({ ...args, confirmation_id: cid }, api);
    expect(exec.isError).toBeFalsy();
    expect(textOf(exec)).toContain("All **3** purchase order(s) transitioned");
    expect(bulkTransitionPurchaseOrderStatuses).toHaveBeenCalledWith({
      purchaseOrderIds: [39201, 39202, 39203],
      status: 2,
    });
  });

  it("partial failure: 7 succeed, 3 fail — NOT an error, surfaces breakdown", async () => {
    const bulkTransitionPurchaseOrderStatuses = vi.fn().mockResolvedValue({
      success: true, // wire-level OK
      message: "Partial: 7 succeeded, 3 failed.",
      successCount: 7,
      failureCount: 3,
    });
    const api = fakeApi({
      bulkTransitionPurchaseOrderStatuses: bulkTransitionPurchaseOrderStatuses as any,
    });
    const tool = findTool(api, mkStore());
    const args = {
      purchase_order_ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      status: "Confirmed" as const,
    };
    const prompt = await tool.handler(args, api);
    const cid = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    const exec = await tool.handler({ ...args, confirmation_id: cid }, api);
    expect(exec.isError).toBeFalsy(); // partial success is NOT an error
    expect(textOf(exec)).toContain("Partial bulk transition");
    expect(textOf(exec)).toContain("7 of 10");
    expect(textOf(exec)).toContain("3 failed");
    expect(textOf(exec)).toContain("get_purchase_order");
  });

  it("wire-level failure: surfaces BT's error verbatim", async () => {
    const bulkTransitionPurchaseOrderStatuses = vi.fn().mockResolvedValue({
      success: false,
      errors: "HTTP 500 — BT internal error",
    });
    const api = fakeApi({
      bulkTransitionPurchaseOrderStatuses: bulkTransitionPurchaseOrderStatuses as any,
    });
    const tool = findTool(api, mkStore());
    const args = { purchase_order_ids: [1, 2], status: "Sent" as const };
    const prompt = await tool.handler(args, api);
    const cid = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    const exec = await tool.handler({ ...args, confirmation_id: cid }, api);
    expect(exec.isError).toBe(true);
    expect(textOf(exec)).toContain("Bulk transition failed at the wire");
    expect(textOf(exec)).toContain("HTTP 500");
  });

  it("Zod: max 50 ids per call", async () => {
    const api = fakeApi({});
    const tool = findTool(api, mkStore());
    const result = await tool.handler(
      { purchase_order_ids: Array.from({ length: 60 }, (_, i) => i + 1), status: 1 },
      api,
    );
    expect(result.isError).toBe(true);
  });

  it("Zod: requires non-empty ids array", async () => {
    const api = fakeApi({});
    const tool = findTool(api, mkStore());
    const result = await tool.handler({ purchase_order_ids: [], status: 1 }, api);
    expect(result.isError).toBe(true);
  });

  it("Zod: rejects unknown numeric status codes (999)", async () => {
    const api = fakeApi({});
    const tool = findTool(api, mkStore());
    const result = await tool.handler(
      { purchase_order_ids: [1], status: 999 },
      api,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Unknown PO status code 999");
  });

  it("prompt truncates large id list to first 5 + count", async () => {
    const bulkTransitionPurchaseOrderStatuses = vi.fn().mockResolvedValue({
      success: true, successCount: 8, failureCount: 0,
    });
    const api = fakeApi({
      bulkTransitionPurchaseOrderStatuses: bulkTransitionPurchaseOrderStatuses as any,
    });
    const tool = findTool(api, mkStore());
    const args = {
      purchase_order_ids: [1, 2, 3, 4, 5, 6, 7, 8],
      status: "Sent" as const,
    };
    const prompt = await tool.handler(args, api);
    const text = textOf(prompt);
    expect(text).toContain("1, 2, 3, 4, 5, … (+3 more)");
  });

  it("idempotency: order-insensitive — {3,1,2} and {1,2,3} hit the same cache entry", async () => {
    const bulkTransitionPurchaseOrderStatuses = vi.fn().mockResolvedValue({
      success: true, successCount: 3, failureCount: 0,
    });
    const api = fakeApi({
      bulkTransitionPurchaseOrderStatuses: bulkTransitionPurchaseOrderStatuses as any,
    });
    const { IdempotencyStore } = await import("../../idempotency/index.js");
    const idem = new IdempotencyStore();
    const tools = createMutationTools(() => api, mkStore(), undefined, idem);
    const tool = tools.find((t) => t.name === "bulk_transition_purchase_orders")!;

    const args1 = {
      purchase_order_ids: [1, 2, 3],
      status: "Sent" as const,
      idempotency_key: "bulk-replay-test",
    };
    const prompt = await tool.handler(args1, api);
    const cid = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    await tool.handler({ ...args1, confirmation_id: cid }, api);
    expect(bulkTransitionPurchaseOrderStatuses).toHaveBeenCalledTimes(1);

    // Retry with REORDERED ids — should hit cache (sorted before fingerprint).
    const args2 = { ...args1, purchase_order_ids: [3, 1, 2] };
    const retry = await tool.handler(args2, api);
    expect(textOf(retry)).toContain("Idempotency replay");
    expect(bulkTransitionPurchaseOrderStatuses).toHaveBeenCalledTimes(1); // STILL 1
  });

  it("partial-failure result is CACHED (so retries replay the report, not re-execute)", async () => {
    const bulkTransitionPurchaseOrderStatuses = vi.fn().mockResolvedValue({
      success: true,
      successCount: 5,
      failureCount: 5,
      message: "Partial",
    });
    const api = fakeApi({
      bulkTransitionPurchaseOrderStatuses: bulkTransitionPurchaseOrderStatuses as any,
    });
    const { IdempotencyStore } = await import("../../idempotency/index.js");
    const idem = new IdempotencyStore();
    const tools = createMutationTools(() => api, mkStore(), undefined, idem);
    const tool = tools.find((t) => t.name === "bulk_transition_purchase_orders")!;

    const args = {
      purchase_order_ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      status: "Confirmed" as const,
      idempotency_key: "partial-success-cache",
    };
    const prompt = await tool.handler(args, api);
    const cid = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    const exec = await tool.handler({ ...args, confirmation_id: cid }, api);
    expect(textOf(exec)).toContain("Partial bulk transition");
    expect(bulkTransitionPurchaseOrderStatuses).toHaveBeenCalledTimes(1);

    // Retry — partial success should still cache and replay (NOT
    // re-execute, even though some failed). Caller can retry by
    // passing only the failing ids with a fresh key.
    const retry = await tool.handler(args, api);
    expect(textOf(retry)).toContain("Idempotency replay");
    expect(bulkTransitionPurchaseOrderStatuses).toHaveBeenCalledTimes(1);
  });
});
