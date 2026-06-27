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
  getCompany?: BuildToolsAPI["getCompany"];
  getPurchaseOrder?: BuildToolsAPI["getPurchaseOrder"];
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
