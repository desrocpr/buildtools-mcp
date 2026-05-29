/**
 * MOS-213 — Fixture-based unit tests for BuildToolsAPI.
 *
 * Per-method coverage driven from JSON fixtures under `./fixtures/`. The
 * fixture data is scrubbed of real customer info (see the JSON files), so
 * these snapshots and assertions can live in version control safely.
 *
 * Why a separate file from `BuildToolsAPI.test.ts`? The Phase 2.1/2.2 tests
 * already cover the wiring (CSRF harvesting, redirect follow, XSRF header,
 * 401 retry, etc.) at a low level with inline fixtures. This file layers on
 * representative response payloads + per-method coverage + edge cases for
 * each public read method, mirroring how real BuildTools responses look so
 * that a future schema regression surfaces here first.
 *
 * The test harness intentionally mirrors `BuildToolsAPI.test.ts`'s queued
 * fetch stub so the two suites can be read together — each handler is shifted
 * off in the order the SUT makes its calls.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { BuildToolsAPI } from "../BuildToolsAPI.js";
import {
  AttachmentSchema,
  ChangeOrderSchema,
  CustomerDetailSchema,
  CustomerSchema,
  DatatableResponseSchema,
  FinancialStatementSchema,
  ProjectSchema,
} from "../types.js";

// Fixtures live on disk and are loaded synchronously at module-init time.
//
// Why not bare ESM `import x from "./foo.json"`? The repo's tsconfig uses
// `module: "NodeNext"`, which requires the `with { type: "json" }` attribute
// for JSON imports — and that attribute, while valid in TS 5.x, is not
// universally honored by all toolchains in this project (vitest's vite
// transform is fine, but `tsc` invoked from `npm run build` rejects bare
// imports). Reading via `node:fs` sidesteps both concerns and matches how
// we load `login-page.html`.
const __dirname = dirname(fileURLToPath(import.meta.url));
function loadJsonFixture<T = unknown>(filename: string): T {
  const raw = readFileSync(join(__dirname, "fixtures", filename), "utf-8");
  return JSON.parse(raw) as T;
}

type DatatableEnvelope<Row> = {
  draw?: number;
  recordsTotal?: number;
  recordsFiltered?: number;
  data: Row[];
};

const attachmentsFixture =
  loadJsonFixture<{ items: Array<Record<string, unknown>> }>(
    "attachments.json",
  );
const certificatesFixture =
  loadJsonFixture<DatatableEnvelope<Record<string, unknown>>>(
    "certificates.json",
  );
const changeOrdersFixture = loadJsonFixture<
  DatatableEnvelope<{
    DT_RowId: string;
    status: number;
    approved_number: number | null;
    name: string;
    total: string;
    created_at: string;
    [k: string]: unknown;
  }>
>("change-orders.json");
const customersFixture = loadJsonFixture<
  DatatableEnvelope<{ name: string; email?: string; [k: string]: unknown }>
>("customers.json");
const customerDetailFixture = loadJsonFixture<{
  id: number;
  name: string;
  [k: string]: unknown;
}>("customer-detail.json");
const dailyLogsFixture =
  loadJsonFixture<DatatableEnvelope<Record<string, unknown>>>(
    "daily-logs.json",
  );
const financialStatementFixture = loadJsonFixture<{
  id: number;
  name: string;
  current_amount: string;
  current_amount_value: number;
  created_at: string;
  due_date: string;
  payment_last: string;
  [k: string]: unknown;
}>("financial-statement.json");
const financialStatementsListFixture = loadJsonFixture<{
  content: string;
  statusCount: Record<string, number>;
  [k: string]: unknown;
}>("financial-statements-list.json");
const loginSuccessResponseFixture = loadJsonFixture<{
  redirect: string;
  status: string;
  [k: string]: unknown;
}>("login-success-response.json");
const projectDetailFixture = loadJsonFixture<{
  id: number;
  name: string;
  [k: string]: unknown;
}>("project-detail.json");
const projectsListFixture = loadJsonFixture<
  DatatableEnvelope<{
    id: number;
    name: string;
    budget_revised: string;
    financial_statements_payment_last: string;
    [k: string]: unknown;
  }>
>("projects-list.json");
const purchaseOrdersFixture = loadJsonFixture<
  DatatableEnvelope<{
    total: string;
    invoiced_amount: string;
    difference: string;
    [k: string]: unknown;
  }>
>("purchase-orders.json");
const rfisFixture =
  loadJsonFixture<DatatableEnvelope<Record<string, unknown>>>("rfis.json");
const servicesFixture =
  loadJsonFixture<DatatableEnvelope<Record<string, unknown>>>(
    "services.json",
  );
const tasksFixture = loadJsonFixture<
  DatatableEnvelope<{ due_date: string; [k: string]: unknown }>
>("tasks.json");
const usersFixture =
  loadJsonFixture<DatatableEnvelope<Record<string, unknown>>>("users.json");
const weeklyReportsFixture =
  loadJsonFixture<DatatableEnvelope<Record<string, unknown>>>(
    "weekly-reports.json",
  );
const workDaysFixture =
  loadJsonFixture<DatatableEnvelope<Record<string, unknown>>>(
    "work-days.json",
  );

const loginPageHtml = readFileSync(
  join(__dirname, "fixtures", "login-page.html"),
  "utf-8",
);

// ---------------------------------------------------------------------------
// Fetch stub (same shape as the queue-based one in BuildToolsAPI.test.ts).
// ---------------------------------------------------------------------------

interface StubResponse {
  status?: number;
  body?: string;
  setCookie?: string[];
  location?: string;
  headers?: Record<string, string>;
}

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function makeFetchStub(queue: StubResponse[]) {
  const recorded: RecordedCall[] = [];
  const stub: typeof fetch = (async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = input instanceof URL ? input.toString() : String(input);
    recorded.push({ url, init });
    const next = queue.shift();
    if (!next) {
      throw new Error(`Unexpected fetch call (queue empty): ${url}`);
    }
    const headers = new Headers(next.headers);
    if (next.setCookie) {
      for (const c of next.setCookie) headers.append("set-cookie", c);
    }
    if (next.location) headers.set("location", next.location);
    return new Response(next.body ?? "", {
      status: next.status ?? 200,
      headers,
    });
  }) as typeof fetch;
  return { stub, recorded };
}

/** Shortcut: build an authenticated stubbed-fetch API for a given queue. */
function authedApi(queue: StubResponse[]) {
  const { stub, recorded } = makeFetchStub(queue);
  const api = new BuildToolsAPI({ fetch: stub });
  api.authenticated = true;
  return { api, recorded };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixture sanity — schema parse + scrub guarantee
// ---------------------------------------------------------------------------

describe("fixtures themselves", () => {
  /**
   * Hard-coded list of strings copied from `/tmp/buildtools-src/api-data-sample.json`
   * — if any of them appears in a fixture file the scrub regressed and a
   * reviewer would (rightly) reject the PR.
   *
   * Kept inline rather than in a helper file so the failure mode is obvious:
   * the test name names the string, the assertion shows the file.
   */
  const realStrings = [
    "Kuruvilla",
    "Graystar",
    "Tommy Bui",
    "info@graystarbuilds.com",
    "703-340-7185",
    "Clifton",
    "Reksono",
    "Cabero",
    "LeBlanc",
    "Mentzer",
    "Kim Kendrick",
    "Best Tile",
    "Bob Keene",
    "Aaron",
    "Mullen",
    "aamullen75@gmail.com",
    "301-524-3452",
    "Jaime Gonzalez",
    "Joseph DeSaulniers",
    "Adan Peralta",
    "Keith Jenkins",
    "13951 South Springs Dr",
  ];

  const fixtures: Record<string, unknown> = {
    "attachments.json": attachmentsFixture,
    "certificates.json": certificatesFixture,
    "change-orders.json": changeOrdersFixture,
    "customers.json": customersFixture,
    "customer-detail.json": customerDetailFixture,
    "daily-logs.json": dailyLogsFixture,
    "financial-statement.json": financialStatementFixture,
    "financial-statements-list.json": financialStatementsListFixture,
    "login-success-response.json": loginSuccessResponseFixture,
    "project-detail.json": projectDetailFixture,
    "projects-list.json": projectsListFixture,
    "purchase-orders.json": purchaseOrdersFixture,
    "rfis.json": rfisFixture,
    "services.json": servicesFixture,
    "tasks.json": tasksFixture,
    "users.json": usersFixture,
    "weekly-reports.json": weeklyReportsFixture,
    "work-days.json": workDaysFixture,
  };

  for (const [name, payload] of Object.entries(fixtures)) {
    it(`${name} contains no real customer data`, () => {
      const blob = JSON.stringify(payload);
      for (const needle of realStrings) {
        expect(blob, `${name} must not contain "${needle}"`).not.toContain(
          needle,
        );
      }
    });
  }

  it("login-page.html contains no real customer data and exposes a CSRF _token", () => {
    for (const needle of realStrings) {
      expect(loginPageHtml).not.toContain(needle);
    }
    expect(loginPageHtml).toMatch(/name="_token"[^>]*value="([^"]+)"/);
  });
});

// ---------------------------------------------------------------------------
// authenticate() — drives the canonical login-page.html fixture
// ---------------------------------------------------------------------------

describe("authenticate() — fixture-driven login", () => {
  it("harvests CSRF from login-page.html and completes the cross-domain login", async () => {
    const { stub, recorded } = makeFetchStub([
      // 1. GET login page — serves the on-disk fixture HTML.
      {
        status: 200,
        body: loginPageHtml,
        setCookie: ["XSRF-TOKEN=fixture-xsrf; path=/; domain=.buildtools.app"],
      },
      // 2. POST login — server 302 → /dashboard.
      { status: 302, location: "https://core.buildtools.app/dashboard" },
      // 2b. Manual redirect-follow lands on /dashboard.
      { status: 200, body: "<html>dashboard ready</html>" },
      // 3. Cross-domain GET to baseUrl — needs the dashboard/logout marker.
      { status: 200, body: "<html>logout link</html>" },
    ]);

    const api = new BuildToolsAPI({ fetch: stub });
    const ok = await api.authenticate("user@example.com", "secret");
    expect(ok).toBe(true);
    expect(api.authenticated).toBe(true);

    // POST body should carry the CSRF token harvested from the fixture HTML.
    const loginPost = recorded[1];
    expect(loginPost.url).toBe("https://core.buildtools.app/login");
    expect(String(loginPost.init.body)).toContain(
      "_token=FIXTURE_CSRF_TOKEN_AAAA1111",
    );
  });

  it("login-success-response.json is structurally valid JSON (not consumed by success path)", () => {
    // Documented in the fixture itself: BuildTools does not return JSON on
    // successful auth. The fixture is a placeholder envelope for symmetry
    // with the spec list and downstream negative parsing tests.
    const parsed = loginSuccessResponseFixture as Record<string, unknown>;
    expect(parsed.redirect).toBe("/dashboard");
    expect(parsed.status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// datatable() / getProjects / searchProjects — driven by projects-list.json
// ---------------------------------------------------------------------------

describe("getProjects() / datatable() — projects-list.json", () => {
  it("returns the full DataTables envelope unchanged", async () => {
    const { api, recorded } = authedApi([
      { status: 200, body: JSON.stringify(projectsListFixture) },
    ]);
    const out = await api.getProjects();
    expect(out).toEqual(projectsListFixture);

    const url = new URL(recorded[0].url);
    expect(url.pathname).toBe("/projects/datatable");
    // Default pagination params.
    expect(url.searchParams.get("draw")).toBe("1");
    expect(url.searchParams.get("start")).toBe("0");
    expect(url.searchParams.get("length")).toBe("50");
  });

  it("surfaces the currency-formatted budget_revised field verbatim", async () => {
    const { api } = authedApi([
      { status: 200, body: JSON.stringify(projectsListFixture) },
    ]);
    const out = (await api.getProjects()) as typeof projectsListFixture;
    // BuildTools ships currency as a pre-formatted string with the dollar
    // sign, NBSP-like space, and thousands separators. We deliberately do
    // NOT coerce — callers (and Phase 3 tools) decide whether to parse.
    expect(out.data[0].budget_revised).toBe("$ 65,000.00");
    expect(out.data[1].budget_revised).toBe("$ 245,500.50");
  });

  it("surfaces date strings (MM/DD/YYYY) without parsing", async () => {
    const { api } = authedApi([
      { status: 200, body: JSON.stringify(projectsListFixture) },
    ]);
    const out = (await api.getProjects()) as typeof projectsListFixture;
    expect(out.data[0].financial_statements_payment_last).toBe("02/04/2026");
    expect(out.data[1].financial_statements_payment_last).toBe("04/30/2026");
  });

  it("DatatableResponseSchema(ProjectSchema).parse() accepts the fixture", () => {
    const schema = DatatableResponseSchema(ProjectSchema);
    const parsed = schema.parse(projectsListFixture);
    expect(parsed.data).toHaveLength(3);
    expect(parsed.recordsTotal).toBe(3);
  });

  it("propagates pagination params (length, start) through to the datatable URL", async () => {
    const { api, recorded } = authedApi([
      { status: 200, body: JSON.stringify({ data: [] }) },
    ]);
    await api.getProjects({ length: 10, start: 20 });
    const url = new URL(recorded[0].url);
    expect(url.searchParams.get("length")).toBe("10");
    expect(url.searchParams.get("start")).toBe("20");
  });

  it("handles an empty data array", async () => {
    const empty = { draw: 1, recordsTotal: 0, recordsFiltered: 0, data: [] };
    const { api } = authedApi([
      { status: 200, body: JSON.stringify(empty) },
    ]);
    const out = (await api.getProjects()) as typeof empty;
    expect(out.data).toEqual([]);
    expect(out.recordsTotal).toBe(0);
  });

  it("handles a single-item data array", async () => {
    const single = {
      draw: 1,
      recordsTotal: 1,
      recordsFiltered: 1,
      data: [projectsListFixture.data[0]],
    };
    const { api } = authedApi([
      { status: 200, body: JSON.stringify(single) },
    ]);
    const out = (await api.getProjects()) as typeof single;
    expect(out.data).toHaveLength(1);
    expect(out.data[0].id).toBe(100001);
  });
});

describe("searchProjects() — fixture-driven", () => {
  it("filters via search[value] and respects the limit param", async () => {
    const { api, recorded } = authedApi([
      { status: 200, body: JSON.stringify(projectsListFixture) },
    ]);
    await api.searchProjects("Jones", 25);
    const url = new URL(recorded[0].url);
    expect(url.searchParams.get("search[value]")).toBe("Jones");
    expect(url.searchParams.get("length")).toBe("25");
  });

  it("defaults limit to 50 when omitted", async () => {
    const { api, recorded } = authedApi([
      { status: 200, body: JSON.stringify({ data: [] }) },
    ]);
    await api.searchProjects("oak");
    const url = new URL(recorded[0].url);
    expect(url.searchParams.get("length")).toBe("50");
  });
});

// ---------------------------------------------------------------------------
// getProject() — project-detail.json
// ---------------------------------------------------------------------------

describe("getProject() — project-detail.json", () => {
  it("finds the project by ID from a datatable envelope", async () => {
    const dtEnvelope = {
      data: [{ ...projectDetailFixture, DT_RowId: `row_${projectDetailFixture.id}` }],
      recordsTotal: 1,
      recordsFiltered: 1,
    };
    const { api, recorded } = authedApi([
      { status: 200, body: JSON.stringify(dtEnvelope) },
    ]);
    const out = await api.getProject(100002);
    expect(out).toMatchObject({ id: 100002, name: "Jones Addition" });
    expect(recorded[0].url).toContain("projects/datatable");
  });

  it("ProjectSchema.parse() validates the project-detail fixture", () => {
    const parsed = ProjectSchema.parse(projectDetailFixture);
    expect(parsed.id).toBe(100002);
    expect(parsed.name).toBe("Jones Addition");
  });
});

// ---------------------------------------------------------------------------
// getCompanies() — customers.json (BuildTools companies == MOS-213 customers)
// ---------------------------------------------------------------------------

describe("getCompanies() — customers.json", () => {
  it("returns the customers DataTable envelope", async () => {
    const { api, recorded } = authedApi([
      { status: 200, body: JSON.stringify(customersFixture) },
    ]);
    const out = await api.getCompanies();
    expect(out).toEqual(customersFixture);
    expect(new URL(recorded[0].url).pathname).toBe("/companies/datatable");
  });

  it("CustomerSchema parses every row in the fixture", () => {
    for (const row of customersFixture.data) {
      const parsed = CustomerSchema.parse(row);
      expect(parsed.name.length).toBeGreaterThan(0);
    }
  });

  it("handles empty customer list", async () => {
    const { api } = authedApi([
      { status: 200, body: JSON.stringify({ data: [] }) },
    ]);
    const out = (await api.getCompanies()) as { data: unknown[] };
    expect(out.data).toEqual([]);
  });

  it("handles single-customer response", async () => {
    const single = { data: [customersFixture.data[0]] };
    const { api } = authedApi([{ status: 200, body: JSON.stringify(single) }]);
    const out = (await api.getCompanies()) as typeof single;
    expect(out.data).toHaveLength(1);
    expect((out.data[0] as { name: string }).name).toBe(
      "Acme Subcontractors LLC",
    );
  });
});

// ---------------------------------------------------------------------------
// getCustomer() — customer-detail.json (MOS-216)
// ---------------------------------------------------------------------------

describe("getCustomer() — customer-detail.json", () => {
  it("finds the customer by DT_RowId from a datatable envelope", async () => {
    const dtEnvelope = {
      data: [{ ...customerDetailFixture, DT_RowId: `row_${customerDetailFixture.id}` }],
      recordsTotal: 1,
      recordsFiltered: 1,
    };
    const { api, recorded } = authedApi([
      { status: 200, body: JSON.stringify(dtEnvelope) },
    ]);
    const out = await api.getCustomer(300001);
    expect(out).toMatchObject({ id: 300001, name: "Acme Subcontractors LLC" });
    expect(recorded[0].url).toContain("companies/datatable");
  });

  it("CustomerDetailSchema.parse() validates the customer-detail fixture", () => {
    const parsed = CustomerDetailSchema.parse(customerDetailFixture);
    expect(parsed.id).toBe(300001);
    expect(parsed.name).toBe("Acme Subcontractors LLC");
    expect(parsed.main_contact).toBe("Pat Sample");
    expect(Array.isArray(parsed.projects)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getProjectAttachments() — attachments.json (MOS-216)
// ---------------------------------------------------------------------------

describe("getProjectAttachments() — attachments.json", () => {
  it("parses items wrapped in a mapInit([...]) JS call in the /documents HTML", async () => {
    const html = `<html><body><script>mapInit(${JSON.stringify(attachmentsFixture.items)}, rootId);</script></body></html>`;
    const { api, recorded } = authedApi([{ status: 200, body: html }]);
    const out = await api.getProjectAttachments(100002);
    expect(out).toHaveLength(attachmentsFixture.items.length);
    expect(out[0]).toMatchObject({
      id: 800001,
      name: "scope-revision-1.pdf",
      extension: "pdf",
    });
    expect(recorded[0].url).toBe(
      "https://moss.buildtools.app/documents?PR[]=100002",
    );
    expect(recorded[0].url).not.toContain("list=");
  });

  it("AttachmentSchema parses each wire-shape item from the fixture", () => {
    for (const item of attachmentsFixture.items) {
      const parsed = AttachmentSchema.parse(item);
      expect(parsed.id).toBeDefined();
      expect(parsed.name.length).toBeGreaterThan(0);
    }
  });

  it("returns [] when mapInit([]) is rendered with no items", async () => {
    const { api } = authedApi([
      { status: 200, body: "<script>mapInit([], rootId);</script>" },
    ]);
    expect(await api.getProjectAttachments(100002)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Change orders — change-orders.json
// ---------------------------------------------------------------------------

describe("getChangeOrders() — change-orders.json", () => {
  it("returns the change-orders DataTable envelope", async () => {
    const { api, recorded } = authedApi([
      { status: 200, body: JSON.stringify(changeOrdersFixture) },
    ]);
    const out = await api.getChangeOrders();
    expect(out).toEqual(changeOrdersFixture);
    expect(new URL(recorded[0].url).pathname).toBe("/change-orders/datatable");
  });

  it("ChangeOrderSchema parses each fixture row + preserves currency string", () => {
    for (const row of changeOrdersFixture.data) {
      const parsed = ChangeOrderSchema.parse(row);
      expect(parsed.name.length).toBeGreaterThan(0);
      if (parsed.total !== undefined) {
        expect(parsed.total).toMatch(/^\$ [\d,]+\.\d{2}$/);
      }
    }
  });

  it("preserves the approved_number field's null-vs-number distinction", () => {
    const [draft, approved] = changeOrdersFixture.data;
    expect(draft.approved_number).toBeNull();
    expect(approved.approved_number).toBe(4);
  });
});

describe("searchChangeOrders() — fixture-driven", () => {
  it("encodes search[value] + uses default length", async () => {
    const { api, recorded } = authedApi([
      { status: 200, body: JSON.stringify(changeOrdersFixture) },
    ]);
    await api.searchChangeOrders("Basement");
    const url = new URL(recorded[0].url);
    expect(url.searchParams.get("search[value]")).toBe("Basement");
    expect(url.searchParams.get("length")).toBe("50");
  });
});

// ---------------------------------------------------------------------------
// getChangeOrderAttachments() — attachments.json
// ---------------------------------------------------------------------------

describe("getChangeOrderAttachments() — attachments.json", () => {
  it("maps the snake_case wire shape to camelCase for every item", async () => {
    const { api, recorded } = authedApi([
      { status: 200, body: JSON.stringify(attachmentsFixture) },
    ]);
    const out = await api.getChangeOrderAttachments(100002);
    expect(out).toHaveLength(attachmentsFixture.items.length);
    expect(out[0]).toMatchObject({
      id: 800001,
      name: "scope-revision-1.pdf",
      changeOrderId: 500001,
      extension: "pdf",
      publicUrl:
        "https://example.com/attachments/scope-revision-1.pdf",
      userId: 9001,
      userName: "Project Manager A",
    });
    expect(recorded[0].url).toBe(
      "https://moss.buildtools.app/documents?PR[]=100002&list=m-100002-600-0",
    );
  });

  it("AttachmentSchema parses each wire-shape item", () => {
    for (const item of attachmentsFixture.items) {
      const parsed = AttachmentSchema.parse(item);
      expect(parsed.id).toBeDefined();
      expect(parsed.name.length).toBeGreaterThan(0);
    }
  });

  it("filters to a single change-order id when provided", async () => {
    const { api } = authedApi([
      { status: 200, body: JSON.stringify(attachmentsFixture) },
    ]);
    const out = await api.getChangeOrderAttachments(100002, 500001);
    // Only items with module_id === 500001 in the fixture (the two PDFs).
    expect(out).toHaveLength(2);
    expect(out.every((a) => a.changeOrderId === 500001)).toBe(true);
  });

  it("returns [] on empty items array", async () => {
    const { api } = authedApi([
      { status: 200, body: JSON.stringify({ items: [] }) },
    ]);
    expect(await api.getChangeOrderAttachments(100002)).toEqual([]);
  });

  it("returns a single-item array when only one attachment matches", async () => {
    const { api } = authedApi([
      { status: 200, body: JSON.stringify(attachmentsFixture) },
    ]);
    const out = await api.getChangeOrderAttachments(100002, 500002);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(800003);
  });
});

// ---------------------------------------------------------------------------
// Purchase orders, tasks, RFIs, users, services, work-tracking, certificates
// — these all flow through datatable() so the assertions focus on routing
// + envelope-pass-through.
// ---------------------------------------------------------------------------

describe("getPurchaseOrders() — purchase-orders.json", () => {
  it("returns the envelope and hits /purchase-orders/datatable", async () => {
    const { api, recorded } = authedApi([
      { status: 200, body: JSON.stringify(purchaseOrdersFixture) },
    ]);
    const out = await api.getPurchaseOrders();
    expect(out).toEqual(purchaseOrdersFixture);
    expect(new URL(recorded[0].url).pathname).toBe(
      "/purchase-orders/datatable",
    );
  });

  it("preserves currency-formatted total / invoiced_amount / difference", async () => {
    const { api } = authedApi([
      { status: 200, body: JSON.stringify(purchaseOrdersFixture) },
    ]);
    const out = (await api.getPurchaseOrders()) as typeof purchaseOrdersFixture;
    expect(out.data[0].total).toBe("$ 3,855.46");
    expect(out.data[0].invoiced_amount).toBe("$ 0.00");
    expect(out.data[1].difference).toBe("$ 0.00");
  });
});

describe("searchPurchaseOrders() — fixture-driven", () => {
  it("passes the query through search[value]", async () => {
    const { api, recorded } = authedApi([
      { status: 200, body: JSON.stringify({ data: [] }) },
    ]);
    await api.searchPurchaseOrders("Lumber", 10);
    const url = new URL(recorded[0].url);
    expect(url.searchParams.get("search[value]")).toBe("Lumber");
    expect(url.searchParams.get("length")).toBe("10");
  });
});

describe("getTasks() / searchTasks() — tasks.json", () => {
  it("returns the tasks envelope", async () => {
    const { api, recorded } = authedApi([
      { status: 200, body: JSON.stringify(tasksFixture) },
    ]);
    const out = await api.getTasks();
    expect(out).toEqual(tasksFixture);
    expect(new URL(recorded[0].url).pathname).toBe("/tasks/datatable");
  });

  it("preserves the MM/DD/YYYY due_date field on the row", async () => {
    const { api } = authedApi([
      { status: 200, body: JSON.stringify(tasksFixture) },
    ]);
    const out = (await api.getTasks()) as typeof tasksFixture;
    expect(out.data[0].due_date).toBe("09/24/2025");
  });

  it("searchTasks forwards the query verbatim", async () => {
    const { api, recorded } = authedApi([
      { status: 200, body: JSON.stringify({ data: [] }) },
    ]);
    await api.searchTasks("Permits");
    expect(new URL(recorded[0].url).searchParams.get("search[value]")).toBe(
      "Permits",
    );
  });
});

describe("getRFIs() — rfis.json", () => {
  it("returns the RFI envelope from the rfis fixture", async () => {
    const { api, recorded } = authedApi([
      { status: 200, body: JSON.stringify(rfisFixture) },
    ]);
    const out = await api.getRFIs();
    expect(out).toEqual(rfisFixture);
    expect(new URL(recorded[0].url).pathname).toBe("/rfis/datatable");
  });
});

describe("getUsers() / searchUsers() / getEmployees() — users.json", () => {
  it("getUsers returns the users envelope", async () => {
    const { api, recorded } = authedApi([
      { status: 200, body: JSON.stringify(usersFixture) },
    ]);
    const out = await api.getUsers();
    expect(out).toEqual(usersFixture);
    expect(new URL(recorded[0].url).pathname).toBe("/users/datatable");
  });

  it("searchUsers passes query through", async () => {
    const { api, recorded } = authedApi([
      { status: 200, body: JSON.stringify({ data: [] }) },
    ]);
    await api.searchUsers("alex");
    expect(new URL(recorded[0].url).searchParams.get("search[value]")).toBe(
      "alex",
    );
  });

  it("getEmployees adds the columns[4][search][value]=Employee filter", async () => {
    const { api, recorded } = authedApi([
      { status: 200, body: JSON.stringify({ data: [] }) },
    ]);
    await api.getEmployees();
    expect(
      new URL(recorded[0].url).searchParams.get(
        "columns[4][search][value]",
      ),
    ).toBe("Employee");
  });
});

describe("getServices() — services.json", () => {
  it("returns the services envelope and hits /services/datatable", async () => {
    const { api, recorded } = authedApi([
      { status: 200, body: JSON.stringify(servicesFixture) },
    ]);
    const out = await api.getServices();
    expect(out).toEqual(servicesFixture);
    expect(new URL(recorded[0].url).pathname).toBe("/services/datatable");
  });
});

describe("work-tracking read methods", () => {
  it("getDailyLogs hits /daily-logs/datatable and returns its fixture", async () => {
    const { api, recorded } = authedApi([
      { status: 200, body: JSON.stringify(dailyLogsFixture) },
    ]);
    const out = await api.getDailyLogs();
    expect(out).toEqual(dailyLogsFixture);
    expect(new URL(recorded[0].url).pathname).toBe("/daily-logs/datatable");
  });

  it("getWeeklyReports hits /weekly-reports/datatable and returns its fixture", async () => {
    const { api, recorded } = authedApi([
      { status: 200, body: JSON.stringify(weeklyReportsFixture) },
    ]);
    const out = await api.getWeeklyReports();
    expect(out).toEqual(weeklyReportsFixture);
    expect(new URL(recorded[0].url).pathname).toBe(
      "/weekly-reports/datatable",
    );
  });

  it("getWorkDays hits /work-days/datatable and returns its fixture", async () => {
    const { api, recorded } = authedApi([
      { status: 200, body: JSON.stringify(workDaysFixture) },
    ]);
    const out = await api.getWorkDays();
    expect(out).toEqual(workDaysFixture);
    expect(new URL(recorded[0].url).pathname).toBe("/work-days/datatable");
  });
});

describe("getCertificates() / searchCertificates() — certificates.json", () => {
  it("getCertificates returns the certificates envelope", async () => {
    const { api, recorded } = authedApi([
      { status: 200, body: JSON.stringify(certificatesFixture) },
    ]);
    const out = await api.getCertificates();
    expect(out).toEqual(certificatesFixture);
    expect(new URL(recorded[0].url).pathname).toBe(
      "/certificates/datatable",
    );
  });

  it("searchCertificates forwards the query + limit", async () => {
    const { api, recorded } = authedApi([
      { status: 200, body: JSON.stringify({ data: [] }) },
    ]);
    await api.searchCertificates("OSHA", 5);
    const url = new URL(recorded[0].url);
    expect(url.searchParams.get("search[value]")).toBe("OSHA");
    expect(url.searchParams.get("length")).toBe("5");
  });
});

// ---------------------------------------------------------------------------
// FinancialStatement schema — financial-statement.json
// ---------------------------------------------------------------------------

describe("FinancialStatementSchema — financial-statement.json", () => {
  it("parses the canonical fixture", () => {
    const parsed = FinancialStatementSchema.parse(financialStatementFixture);
    expect(parsed.id).toBe(700001);
    expect(parsed.name).toBe("Q1 2026 Statement");
  });

  it("surfaces both formatted and numeric current_amount", () => {
    const parsed = FinancialStatementSchema.parse(financialStatementFixture);
    expect(parsed.current_amount).toBe("$ 45,000.00");
    expect(parsed.current_amount_value).toBe(45000);
  });

  it("preserves the MM/DD/YYYY date fields", () => {
    const parsed = FinancialStatementSchema.parse(financialStatementFixture);
    expect(parsed.created_at).toBe("04/01/2026");
    expect(parsed.due_date).toBe("04/30/2026");
    expect(parsed.payment_last).toBe("04/30/2026");
  });
});

// ---------------------------------------------------------------------------
// getFinancialStatements() — financial-statements-list.json (MOS-303)
//
// Regression coverage for the row-parser bug where `status` came back as
// "Unknown" and `name` carried the status label (e.g. "Paid", "To Pay"). The
// real cell layout is [icon, status_label, name, amount, paid, fees, balance,
// date]; the fixture's HTML mirrors that and exercises all four labels that
// the prior parser collapsed: Draft, Pending, Paid, Partly Paid, To Pay.
// ---------------------------------------------------------------------------

describe("getFinancialStatements() — financial-statements-list.json (MOS-303)", () => {
  const ALLOWED_STATUSES = new Set([
    "Draft",
    "Pending",
    "Partial",
    "Sent",
    "Paid",
    "Partly Paid",
    "To Pay",
  ]);

  it("hits /financial/statements?PR[]=<id> and returns statusCount + statements", async () => {
    const { api, recorded } = authedApi([
      { status: 200, body: JSON.stringify(financialStatementsListFixture) },
    ]);
    const out = await api.getFinancialStatements(100002);
    expect(recorded[0].url).toBe(
      "https://moss.buildtools.app/financial/statements?PR[]=100002",
    );
    expect(out.statusCount).toEqual(
      financialStatementsListFixture.statusCount,
    );
    expect(out.statements).toHaveLength(5);
  });

  it("parses the real statement name into `name` (NOT the status label)", async () => {
    const { api } = authedApi([
      { status: 200, body: JSON.stringify(financialStatementsListFixture) },
    ]);
    const { statements } = await api.getFinancialStatements(100002);

    // Every name must be the human-readable statement name. The bug regressed
    // these to the status label, so the assertion is twofold: positive match
    // on the expected name AND a negative guard that no row's name equals a
    // status label.
    const expected: Record<string, string> = {
      "700001": "Draw #1",
      "700002": "Draw #2",
      "700003": "Initial Deposit",
      "700004": "Q1 2026 Statement",
      "700005": "Smith Renovation Final",
    };
    for (const row of statements) {
      expect(row.name).toBe(expected[row.id]);
      expect(ALLOWED_STATUSES.has(row.name)).toBe(false);
    }
  });

  it("maps every row's `status` to one of the seven canonical labels", async () => {
    const { api } = authedApi([
      { status: 200, body: JSON.stringify(financialStatementsListFixture) },
    ]);
    const { statements } = await api.getFinancialStatements(100002);

    const expectedStatuses: Record<string, string> = {
      "700001": "Paid",
      "700002": "Partly Paid",
      "700003": "To Pay",
      "700004": "Draft",
      "700005": "Pending",
    };
    for (const row of statements) {
      expect(ALLOWED_STATUSES.has(row.status)).toBe(true);
      expect(row.status).toBe(expectedStatuses[row.id]);
      expect(row.status).not.toBe("Unknown");
    }
  });

  it("reads amount / paid / balance numerically from data-* attrs", async () => {
    const { api } = authedApi([
      { status: 200, body: JSON.stringify(financialStatementsListFixture) },
    ]);
    const { statements } = await api.getFinancialStatements(100002);

    const byId = Object.fromEntries(statements.map((r) => [r.id, r]));
    expect(byId["700001"]).toMatchObject({
      amount: 45000,
      paid: 45000,
      balance: 0,
    });
    expect(byId["700002"]).toMatchObject({
      amount: 30000,
      paid: 15000,
      balance: 15000,
    });
    expect(byId["700003"]).toMatchObject({
      amount: 20000,
      paid: 0,
      balance: 20000,
    });

    for (const row of statements) {
      expect(typeof row.amount).toBe("number");
      expect(typeof row.paid).toBe("number");
      expect(typeof row.balance).toBe("number");
    }
  });

  it("captures the MM/DD/YYYY date for every row", async () => {
    const { api } = authedApi([
      { status: 200, body: JSON.stringify(financialStatementsListFixture) },
    ]);
    const { statements } = await api.getFinancialStatements(100002);
    for (const row of statements) {
      expect(row.date).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Snapshot tests for type safety (MOS-213 spec section 5)
// ---------------------------------------------------------------------------

describe("schema-parse snapshots", () => {
  it("ProjectSchema.parse() of projects-list.data[0] matches snapshot", () => {
    const parsed = ProjectSchema.parse(projectsListFixture.data[0]);
    expect(parsed).toMatchSnapshot();
  });

  it("DatatableResponseSchema(ProjectSchema) round-trip of projects-list matches snapshot", () => {
    const schema = DatatableResponseSchema(ProjectSchema);
    expect(schema.parse(projectsListFixture)).toMatchSnapshot();
  });

  it("CustomerSchema.parse() of customers.data[0] matches snapshot", () => {
    expect(CustomerSchema.parse(customersFixture.data[0])).toMatchSnapshot();
  });

  it("ChangeOrderSchema.parse() of change-orders.data[0] matches snapshot", () => {
    expect(
      ChangeOrderSchema.parse(changeOrdersFixture.data[0]),
    ).toMatchSnapshot();
  });

  it("FinancialStatementSchema.parse() of financial-statement matches snapshot", () => {
    expect(
      FinancialStatementSchema.parse(financialStatementFixture),
    ).toMatchSnapshot();
  });
});
