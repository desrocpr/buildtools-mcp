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

  it("forwards the resolved status CODE (not the label) to the API layer", async () => {
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      success: true, purchaseOrderId: 39752, message: "saved",
    });
    const api = fakeApi({ updatePurchaseOrder: updatePurchaseOrder as any });
    const store = mkStore();
    const tool = findUpdatePoTool(api, store);

    const args = { purchase_order_id: 39752, status: "Confirmed" as const };
    const prompt = await tool.handler(args, api);
    const confirmationId = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    await tool.handler({ ...args, confirmation_id: confirmationId, verify: false }, api);

    expect(updatePurchaseOrder).toHaveBeenCalledTimes(1);
    expect(updatePurchaseOrder.mock.calls[0][0].status).toBe(3);
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
