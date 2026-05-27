import { describe, it, expect } from "vitest";

describe("buildtools-mcp", () => {
  it("tool registries export the expected tool names", async () => {
    const { projectTools } = await import("../tools/projects.js");
    const { financialTools } = await import("../tools/financial.js");
    const { customerTools } = await import("../tools/customers.js");
    const { attachmentTools } = await import("../tools/attachments.js");

    const allNames = [
      ...projectTools,
      ...financialTools,
      ...customerTools,
      ...attachmentTools,
    ].map((t) => t.name);

    expect(allNames).toContain("list_projects");
    expect(allNames).toContain("get_project");
    expect(allNames).toContain("search_projects");
    expect(allNames).toContain("list_change_orders");
    expect(allNames).toContain("get_change_order");
    expect(allNames).toContain("find_unbilled_change_orders");
    expect(allNames).toContain("get_financial_statement");
    expect(allNames).toContain("list_customers");
    expect(allNames).toContain("get_customer");
    expect(allNames).toContain("list_project_attachments");
    expect(allNames.length).toBe(10);
  });

  it("every tool has a valid JSON Schema input definition", async () => {
    const { projectTools } = await import("../tools/projects.js");
    const { financialTools } = await import("../tools/financial.js");
    const { customerTools } = await import("../tools/customers.js");
    const { attachmentTools } = await import("../tools/attachments.js");

    const all = [...projectTools, ...financialTools, ...customerTools, ...attachmentTools];
    for (const tool of all) {
      expect(tool.inputSchema).toBeDefined();
      const schema = tool.inputSchema as { type?: string };
      expect(schema.type).toBe("object");
    }
  });

  it("BuildToolsAPI class can be instantiated without crashing", async () => {
    const { BuildToolsAPI } = await import("../client/BuildToolsAPI.js");
    const api = new BuildToolsAPI({ tenant: "test" });
    expect(api).toBeDefined();
  });

  it("ConfirmationStore can be instantiated and issues tokens", async () => {
    const { ConfirmationStore } = await import("../confirm/Confirmation.js");
    const store = new ConfirmationStore();
    const token = store.create("test_tool", { key: "value" }, "test");
    expect(token).toBeDefined();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });
});
