/**
 * BuildToolsAPI unit tests with a stubbed fetch implementation.
 *
 * The stub is a queue: each call to fetch() shifts the next handler off the
 * queue and asserts on the request URL + init. This is more strict than
 * matching by URL but makes ordering bugs (e.g. forgetting the form-token
 * GET before invoice save) loud failures.
 *
 * Phase 2.1 ships the MINIMUM tests required to hit 80% line coverage on
 * `src/client/`. Per-method exhaustive fixtures are MOS-213's scope.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { BuildToolsAPI } from "../BuildToolsAPI.js";
import {
  BuildToolsAuthError,
  BuildToolsNetworkError,
  BuildToolsServerError,
  BuildToolsValidationError,
} from "../errors.js";
import {
  createChangeOrderSuccessPayload,
  createProjectFailurePayload,
  createProjectSuccessPayload,
  projectAlpha,
  projectsDatatablePayload,
} from "./fixtures/projects.js";

// ---------------------------------------------------------------------------
// Stubbed-fetch test harness
// ---------------------------------------------------------------------------

interface StubResponse {
  status?: number;
  body?: string;
  /** Multiple Set-Cookie headers (one per array entry). */
  setCookie?: string[];
  /** For redirects. */
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
  return { stub, recorded, queue };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Constructor / options
// ---------------------------------------------------------------------------

describe("BuildToolsAPI constructor", () => {
  it("uses production defaults", () => {
    const api = new BuildToolsAPI();
    expect(api.baseUrl).toBe("https://moss.buildtools.app");
    expect(api.authUrl).toBe("https://core.buildtools.app");
  });

  it("derives baseUrl from tenant (authUrl stays shared)", () => {
    const api = new BuildToolsAPI({ tenant: "acme" });
    expect(api.baseUrl).toBe("https://acme.buildtools.app");
    expect(api.authUrl).toBe("https://core.buildtools.app");
  });

  it("honors explicit baseUrl/authUrl over derivations", () => {
    const api = new BuildToolsAPI({
      tenant: "acme",
      baseUrl: "https://override.example.com",
      authUrl: "https://auth.example.com",
    });
    expect(api.baseUrl).toBe("https://override.example.com");
    expect(api.authUrl).toBe("https://auth.example.com");
  });

  it("throws BuildToolsNetworkError when no fetch is available", () => {
    const originalFetch = globalThis.fetch;
    // @ts-expect-error — deliberately removing for the test
    delete globalThis.fetch;
    try {
      expect(() => new BuildToolsAPI()).toThrow(BuildToolsNetworkError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Error class identity
// ---------------------------------------------------------------------------

describe("error classes", () => {
  it("each error has the right name + carries context", () => {
    const auth = new BuildToolsAuthError("oops", { foo: 1 });
    const net = new BuildToolsNetworkError("oops", { foo: 1 });
    const val = new BuildToolsValidationError("oops", { foo: 1 });
    const srv = new BuildToolsServerError("oops", { foo: 1, status: 502 });
    expect(auth.name).toBe("BuildToolsAuthError");
    expect(net.name).toBe("BuildToolsNetworkError");
    expect(val.name).toBe("BuildToolsValidationError");
    expect(srv.name).toBe("BuildToolsServerError");
    expect(srv.status).toBe(502);
    expect(auth.context).toEqual({ foo: 1 });
    expect(auth).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// authenticate() — two-phase login + XSRF decode + cross-domain follow-up
// ---------------------------------------------------------------------------

describe("authenticate()", () => {
  it("runs the two-phase login, harvests CSRF, decodes XSRF, completes cross-domain session", async () => {
    const loginPageHtml = `
      <html>
        <form>
          <input type="hidden" name="_token" value="HARVESTED_CSRF_123" />
          <input type="email" name="email" />
        </form>
      </html>`;

    // The XSRF cookie value is URL-encoded; we expect decode to produce
    // the canonical, un-encoded value.
    const encodedXsrf = encodeURIComponent("xsrf-raw-value");

    const { stub, recorded } = makeFetchStub([
      // 1. GET /login?m=1&o=0ye79w — harvest CSRF, set initial cookie
      {
        status: 200,
        body: loginPageHtml,
        setCookie: [
          "XSRF-TOKEN=" + encodedXsrf + "; path=/; domain=.buildtools.app",
        ],
      },
      // 2. POST /login — server responds 302 → core.buildtools.app/dashboard
      {
        status: 302,
        location: "https://core.buildtools.app/dashboard",
      },
      // 2b. Redirect-follow GET to /dashboard on core (manual follow)
      {
        status: 200,
        body: "<html>dashboard ok</html>",
      },
      // 3. GET baseUrl — completes cross-domain session
      {
        status: 200,
        body: "<html>welcome — logout link here</html>",
      },
    ]);

    const api = new BuildToolsAPI({ fetch: stub });
    const ok = await api.authenticate("u@example.com", "pw");
    expect(ok).toBe(true);
    expect(api.authenticated).toBe(true);

    // Hit 1: GET login page; redirect manual; no body
    expect(recorded[0].url).toBe(
      "https://core.buildtools.app/login?m=1&o=0ye79w",
    );
    expect((recorded[0].init as RequestInit).method ?? "GET").toBe("GET");

    // Hit 2: POST login with form-encoded body containing the harvested CSRF.
    expect(recorded[1].url).toBe("https://core.buildtools.app/login");
    expect(recorded[1].init.method).toBe("POST");
    const body = String(recorded[1].init.body);
    expect(body).toContain("_token=HARVESTED_CSRF_123");
    expect(body).toContain("email=u%40example.com");
    expect(body).toContain("password=pw");
    expect(body).toContain("remember=on");
    const headers = recorded[1].init.headers as Record<string, string>;
    expect(headers["Origin"]).toBe("https://core.buildtools.app");
    expect(headers["Referer"]).toBe(
      "https://core.buildtools.app/login?m=1&o=0ye79w",
    );

    // Hit 2b: redirect-follow to /dashboard
    expect(recorded[2].url).toBe("https://core.buildtools.app/dashboard");

    // Hit 3: cross-domain GET to baseUrl, should now carry the XSRF header
    // (decoded from the .buildtools.app cookie).
    expect(recorded[3].url).toBe("https://moss.buildtools.app");
    const followHeaders = recorded[3].init.headers as Record<string, string>;
    expect(followHeaders["X-XSRF-TOKEN"]).toBe("xsrf-raw-value");
    // Cookie header should include the parent-domain XSRF cookie because
    // moss.buildtools.app shares parent buildtools.app.
    expect(followHeaders["Cookie"]).toContain("XSRF-TOKEN=");
  });

  // MOS-284 regression: the CSRF harvest regex must tolerate any/no
  // intermediate attributes between `name="_token"` and `value="..."`.
  // Production HTML serves `name="_token" type="hidden" value="..."` —
  // the previous `\s+` pattern silently missed that ordering. This
  // parameterised case asserts all three observed orderings are
  // extracted and reach the POST body as `_token=<harvested>`.
  it.each([
    {
      label: "name then type then value (production)",
      input: '<input name="_token" type="hidden" value="ORDERING_A_TOKEN" />',
      token: "ORDERING_A_TOKEN",
    },
    {
      label: "type then name then value (alternate)",
      input: '<input type="hidden" name="_token" value="ORDERING_B_TOKEN" />',
      token: "ORDERING_B_TOKEN",
    },
    {
      label: "name then value (no type; original fixture shape)",
      input: '<input name="_token" value="ORDERING_C_TOKEN" />',
      token: "ORDERING_C_TOKEN",
    },
  ])(
    "harvests CSRF _token regardless of attribute ordering: $label",
    async ({ input, token }) => {
      const { stub, recorded } = makeFetchStub([
        // 1. GET login page — serves the variant HTML.
        {
          status: 200,
          body: `<html><form>${input}</form></html>`,
          setCookie: [
            "XSRF-TOKEN=xsrf-raw; path=/; domain=.buildtools.app",
          ],
        },
        // 2. POST login — server 302 → /dashboard.
        { status: 302, location: "https://core.buildtools.app/dashboard" },
        // 2b. Manual redirect-follow lands on /dashboard.
        { status: 200, body: "<html>dashboard ready</html>" },
        // 3. Cross-domain GET to baseUrl — needs the logout marker.
        { status: 200, body: "<html>logout link</html>" },
      ]);

      const api = new BuildToolsAPI({ fetch: stub });
      const ok = await api.authenticate("user@example.com", "secret");
      expect(ok).toBe(true);

      // POST body should carry the harvested CSRF token verbatim.
      const loginPost = recorded[1];
      expect(loginPost.url).toBe("https://core.buildtools.app/login");
      expect(String(loginPost.init.body)).toContain(`_token=${token}`);
    },
  );

  it("throws BuildToolsAuthError if the login HTML has no _token", async () => {
    const { stub } = makeFetchStub([
      { status: 200, body: "<html>no token here</html>" },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    await expect(api.authenticate("a", "b")).rejects.toBeInstanceOf(
      BuildToolsAuthError,
    );
  });

  it("throws BuildToolsAuthError when dashboard markers are missing", async () => {
    const { stub } = makeFetchStub([
      {
        status: 200,
        body: '<input name="_token" value="X"/>',
        setCookie: ["XSRF-TOKEN=v; path=/"],
      },
      { status: 200, body: "" }, // login POST
      { status: 200, body: "<html>generic landing page</html>" }, // baseUrl GET
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    await expect(api.authenticate("a", "b")).rejects.toBeInstanceOf(
      BuildToolsAuthError,
    );
  });
});

// ---------------------------------------------------------------------------
// datatable() — query-string construction + JSON parse + auth guard
// ---------------------------------------------------------------------------

describe("datatable()", () => {
  it("requires authentication", async () => {
    const { stub } = makeFetchStub([]);
    const api = new BuildToolsAPI({ fetch: stub });
    await expect(api.datatable("projects")).rejects.toBeInstanceOf(
      BuildToolsAuthError,
    );
  });

  it("uses GET with the merged-default query string and returns parsed JSON", async () => {
    const { stub, recorded } = makeFetchStub([
      {
        status: 200,
        body: JSON.stringify(projectsDatatablePayload),
      },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;

    const out = await api.getProjects({ length: 5, "search[value]": "Smith" });
    expect(out).toEqual(projectsDatatablePayload);

    const { url, init } = recorded[0];
    expect(url.startsWith("https://moss.buildtools.app/projects/datatable?")).toBe(true);
    expect(url).toContain("draw=1");
    expect(url).toContain("start=0");
    expect(url).toContain("length=5"); // overrides default 50
    expect(url).toContain("search%5Bvalue%5D=Smith");
    expect(init.method ?? "GET").toBe("GET");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Requested-With"]).toBe("XMLHttpRequest");
    expect(headers["Accept"]).toBe("application/json");
  });

  it("returns null on non-200", async () => {
    const { stub } = makeFetchStub([{ status: 500, body: "boom" }]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    expect(await api.getCompanies()).toBeNull();
  });

  it("returns null when response body is not JSON", async () => {
    const { stub } = makeFetchStub([{ status: 200, body: "not-json" }]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    expect(await api.getTasks()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// post() — form-urlencoded body with key[] array serialization
// ---------------------------------------------------------------------------

describe("post()", () => {
  it("requires authentication", async () => {
    const { stub } = makeFetchStub([]);
    const api = new BuildToolsAPI({ fetch: stub });
    await expect(api.post("/x", {})).rejects.toBeInstanceOf(BuildToolsAuthError);
  });

  it("serializes arrays as key[]=v1&key[]=v2 and emits X-XSRF-TOKEN", async () => {
    const { stub, recorded } = makeFetchStub([
      { status: 200, body: '{"ok":1}' },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    // Inject a known XSRF so we can assert it goes out on the header.
    (api as unknown as { xsrfToken: string }).xsrfToken = "xsrf-abc";

    const out = await api.post("/projects/save", {
      name: "P",
      tags: ["a", "b", "c"],
      nothing: undefined,
      nullish: null,
      flag: true,
    });
    expect(out).toEqual({ ok: 1 });

    const { url, init } = recorded[0];
    expect(url).toBe("https://moss.buildtools.app/projects/save");
    expect(init.method).toBe("POST");
    const body = String(init.body);
    expect(body).toContain("name=P");
    expect(body).toContain("tags%5B%5D=a");
    expect(body).toContain("tags%5B%5D=b");
    expect(body).toContain("tags%5B%5D=c");
    expect(body).not.toContain("nothing=");
    expect(body).not.toContain("nullish=");
    expect(body).toContain("flag=true");

    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(headers["X-Requested-With"]).toBe("XMLHttpRequest");
    expect(headers["X-XSRF-TOKEN"]).toBe("xsrf-abc");
  });

  it("falls back to {status, body} when response isn't JSON", async () => {
    const { stub } = makeFetchStub([{ status: 200, body: "raw" }]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    expect(await api.post("/x", { y: 1 })).toEqual({ status: 200, body: "raw" });
  });
});

// ---------------------------------------------------------------------------
// Cookie jar — hostname-keyed + parent-domain propagation
// ---------------------------------------------------------------------------

describe("cookie jar", () => {
  it("propagates domain=.buildtools.app cookies to subdomain requests", async () => {
    const { stub, recorded } = makeFetchStub([
      // Hit 1: GET on core sets a parent-domain cookie
      {
        status: 200,
        body: "<html/>",
        setCookie: ["SHARED=parent-val; path=/; domain=.buildtools.app"],
      },
      // Hit 2: GET on moss should carry it via parent-domain lookup
      { status: 200, body: '{"ok":true}' },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });

    await api.request("https://core.buildtools.app/login", {}, false);
    api.authenticated = true;
    await api.getProjects();

    const followCookie = (recorded[1].init.headers as Record<string, string>)["Cookie"];
    expect(followCookie).toContain("SHARED=parent-val");
  });
});

// ---------------------------------------------------------------------------
// createProject / getProject / createChangeOrder happy paths
// ---------------------------------------------------------------------------

describe("createProject()", () => {
  it("posts to /projects/save and maps r:1 to {success:true, projectId}", async () => {
    const { stub, recorded } = makeFetchStub([
      { status: 200, body: JSON.stringify(createProjectSuccessPayload) },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;

    const out = await api.createProject({
      name: "New House",
      projectManager: "6",
      address: "9 Oak Ln",
    });
    expect(out).toEqual({ success: true, projectId: 999 });
    expect(recorded[0].url).toBe("https://moss.buildtools.app/projects/save");
    const body = String(recorded[0].init.body);
    expect(body).toContain("Project%5Bname%5D=New+House");
    expect(body).toContain("Project%5Bstatus%5D=6"); // default Omega
    expect(body).toContain("employees=6");
    expect(body).toContain("Project%5Baddress%5D=9+Oak+Ln");
  });

  it("maps r:0 to {success:false, errors}", async () => {
    const { stub } = makeFetchStub([
      { status: 200, body: JSON.stringify(createProjectFailurePayload) },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.createProject({ name: "", projectManager: "6" });
    expect(out.success).toBe(false);
    expect(out.errors).toEqual({ name: ["Name is required"] });
  });
});

describe("getProject()", () => {
  it("finds a project by ID from the datatable", async () => {
    const dtPayload = {
      data: [
        { ...projectAlpha, id: 101, DT_RowId: "row_101" },
        { id: 102, DT_RowId: "row_102", name: "Other" },
      ],
    };
    const { stub, recorded } = makeFetchStub([
      { status: 200, body: JSON.stringify(dtPayload) },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;

    const out = await api.getProject(101);
    expect(out).toMatchObject({ id: 101, name: projectAlpha.name });
    expect(recorded[0].url).toContain("projects/datatable");
  });

  it("returns null when the ID is not in the datatable", async () => {
    const dtPayload = { data: [{ id: 999, DT_RowId: "row_999", name: "X" }] };
    const { stub } = makeFetchStub([
      { status: 200, body: JSON.stringify(dtPayload) },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    expect(await api.getProject(404)).toBeNull();
  });

  it("requires authentication", async () => {
    const { stub } = makeFetchStub([]);
    const api = new BuildToolsAPI({ fetch: stub });
    await expect(api.getProject(1)).rejects.toBeInstanceOf(BuildToolsAuthError);
  });
});

describe("createChangeOrder()", () => {
  it("posts to /change-orders/save with JSON-encoded items", async () => {
    const { stub, recorded } = makeFetchStub([
      { status: 200, body: JSON.stringify(createChangeOrderSuccessPayload) },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;

    const out = await api.createChangeOrder({
      name: "Extra trim",
      projectId: 101,
      total: 750.5,
      description: "scope add",
    });
    expect(out).toEqual({
      success: true,
      changeOrderId: 444,
      message: "Change order created",
    });
    expect(recorded[0].url).toBe(
      "https://moss.buildtools.app/change-orders/save",
    );
    const body = String(recorded[0].init.body);
    expect(body).toContain("ChangeOrder%5Bname%5D=Extra+trim");
    expect(body).toContain("ChangeOrder%5Bproject_id%5D=101");
    expect(body).toContain("ChangeOrder%5Bstatus%5D=1"); // default Draft
    // items JSON shape
    const expectedItemsJson = JSON.stringify({
      items: [{ name: "Item", total: 750.5, budget_category_id: 0 }],
    });
    expect(body).toContain(
      "ChangeOrderItems%5Bitems%5D=" + encodeURIComponent(expectedItemsJson),
    );
    expect(body).toContain("ChangeOrder%5Bdescription%5D=scope+add");
  });

  it("returns success:false with errors when server says non-success", async () => {
    const { stub } = makeFetchStub([
      { status: 200, body: JSON.stringify({ result: "error", message: "bad" }) },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.createChangeOrder({ name: "X", projectId: 1 });
    expect(out).toEqual({ success: false, errors: "bad" });
  });

  it("returns success:false 'Server error' on non-JSON body", async () => {
    const { stub } = makeFetchStub([{ status: 500, body: "html error page" }]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.createChangeOrder({ name: "X", projectId: 1 });
    expect(out).toEqual({ success: false, errors: "Server error" });
  });
});

// ---------------------------------------------------------------------------
// MOS-215 — new read-only methods: getChangeOrder, getFinancialStatement,
// findUnbilledChangeOrders.
// ---------------------------------------------------------------------------

describe("getChangeOrder() — MOS-215", () => {
  it("finds a CO by ID (info field) from the datatable", async () => {
    const dtPayload = {
      data: [
        { info: 500001, DT_RowId: "row_500001", name: "X", status: 3 },
        { info: 500002, DT_RowId: "row_500002", name: "Y", status: 1 },
      ],
    };
    const { stub, recorded } = makeFetchStub([
      { status: 200, body: JSON.stringify(dtPayload) },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.getChangeOrder(500001);
    expect(out).toMatchObject({ info: 500001, name: "X" });
    expect(recorded[0].url).toContain("change-orders/datatable");
  });

  it("returns null when the CO ID is not in the datatable", async () => {
    const dtPayload = { data: [{ info: 999, DT_RowId: "row_999", name: "Z" }] };
    const { stub } = makeFetchStub([
      { status: 200, body: JSON.stringify(dtPayload) },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    expect(await api.getChangeOrder(404)).toBeNull();
  });

  it("requires authentication", async () => {
    const { stub } = makeFetchStub([]);
    const api = new BuildToolsAPI({ fetch: stub });
    await expect(api.getChangeOrder(1)).rejects.toBeInstanceOf(
      BuildToolsAuthError,
    );
  });
});

describe("getFinancialStatement() — MOS-215", () => {
  const fsFormHtml = [
    '<input name="budgetOverviewTotals" type="hidden" value="',
    '{ &quot;budget_total&quot;: 200000, &quot;approved_co_total&quot;: 50000, ',
    '&quot;budget_revised&quot;: 250000, &quot;financial_current_amount&quot;: 45000 }',
    '">',
    '<input name="FinancialStatement[name]" type="text" value="Q1 2026">',
    '<input name="FinancialStatement[status]" type="hidden" value="1">',
  ].join("");

  it("parses budgetOverviewTotals from form HTML", async () => {
    const { stub, recorded } = makeFetchStub([
      { status: 200, body: fsFormHtml },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.getFinancialStatement<Record<string, unknown>>(100002);
    expect(out).not.toBeNull();
    expect(out!.budget_total).toBe(200000);
    expect(out!.approved_co_total).toBe(50000);
    expect(out!.financial_current_amount).toBe(45000);
    expect(out!.name).toBe("Q1 2026");
    expect(out!.status).toBe("1");
    expect(recorded[0].url).toBe(
      "https://moss.buildtools.app/financial/statements/form?PR[]=100002",
    );
  });

  it("returns null on non-200", async () => {
    const { stub } = makeFetchStub([{ status: 500, body: "" }]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    expect(await api.getFinancialStatement(1)).toBeNull();
  });

  it("returns null when form has no budgetOverviewTotals", async () => {
    const { stub } = makeFetchStub([{ status: 200, body: "<html>no totals here</html>" }]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    expect(await api.getFinancialStatement(1)).toBeNull();
  });

  it("requires authentication", async () => {
    const { stub } = makeFetchStub([]);
    const api = new BuildToolsAPI({ fetch: stub });
    await expect(api.getFinancialStatement(1)).rejects.toBeInstanceOf(
      BuildToolsAuthError,
    );
  });
});

describe("findUnbilledChangeOrders() — MOS-215", () => {
  const makeFsFormHtml = (totalBilled: number): string =>
    `<input name="budgetOverviewTotals" type="hidden" value="{ &quot;financial_amount&quot;: ${totalBilled}, &quot;financial_current_amount&quot;: 0 }">`;

  it("returns projects where budget_revised > requested_amount", async () => {
    const projectsPayload = {
      data: [
        { id: 500, status: 6, name: "Has Gap", budget_revised: "$ 100,000.00", change_orders_approved: "$ 10,000.00" },
        { id: 501, status: 7, name: "Fully Billed", budget_revised: "$ 50,000.00", change_orders_approved: "$ 5,000.00" },
        { id: 502, status: 4, name: "Completed", budget_revised: "$ 80,000.00", change_orders_approved: "$ 8,000.00" },
      ],
    };
    const { stub, recorded } = makeFetchStub([
      { status: 200, body: JSON.stringify(projectsPayload) },
      { status: 200, body: makeFsFormHtml(90000) },
      { status: 200, body: makeFsFormHtml(50000) },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.findUnbilledChangeOrders();
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(500);
    expect(out[0].unbilled_gap).toBe(10000);
    expect(recorded[0].url).toContain("projects/datatable");
  });

  it("applies min_amount filter", async () => {
    const projectsPayload = {
      data: [
        { id: 600, status: 6, name: "Small Gap", budget_revised: "$ 100,000.00", change_orders_approved: "$ 5,000.00" },
        { id: 601, status: 7, name: "Big Gap", budget_revised: "$ 200,000.00", change_orders_approved: "$ 50,000.00" },
      ],
    };
    const { stub } = makeFetchStub([
      { status: 200, body: JSON.stringify(projectsPayload) },
      { status: 200, body: makeFsFormHtml(99500) },
      { status: 200, body: makeFsFormHtml(150000) },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.findUnbilledChangeOrders({ min_amount: 10000 });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(601);
  });

  it("returns [] when no active projects have approved COs", async () => {
    const projectsPayload = {
      data: [
        { id: 700, status: 6, name: "No COs", budget_revised: "$ 100,000.00", change_orders_approved: "-" },
      ],
    };
    const { stub } = makeFetchStub([
      { status: 200, body: JSON.stringify(projectsPayload) },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    expect(await api.findUnbilledChangeOrders()).toEqual([]);
  });

  it("requires authentication", async () => {
    const { stub } = makeFetchStub([]);
    const api = new BuildToolsAPI({ fetch: stub });
    await expect(api.findUnbilledChangeOrders()).rejects.toBeInstanceOf(
      BuildToolsAuthError,
    );
  });
});

// ---------------------------------------------------------------------------
// MOS-216 — new read-only methods: getCustomer, getProjectAttachments.
// ---------------------------------------------------------------------------

describe("getCustomer() — MOS-216", () => {
  it("finds a customer by DT_RowId from the companies datatable", async () => {
    const dtPayload = {
      data: [
        { DT_RowId: "row_300001", name: "Acme", status: "Active" },
        { DT_RowId: "row_300002", name: "Other", status: "Active" },
      ],
    };
    const { stub, recorded } = makeFetchStub([
      { status: 200, body: JSON.stringify(dtPayload) },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.getCustomer(300001);
    expect(out).toMatchObject({ DT_RowId: "row_300001", name: "Acme" });
    expect(recorded[0].url).toContain("companies/datatable");
  });

  it("returns null when the customer ID is not in the datatable", async () => {
    const dtPayload = { data: [{ DT_RowId: "row_999", name: "X" }] };
    const { stub } = makeFetchStub([
      { status: 200, body: JSON.stringify(dtPayload) },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    expect(await api.getCustomer(404)).toBeNull();
  });

  it("requires authentication", async () => {
    const { stub } = makeFetchStub([]);
    const api = new BuildToolsAPI({ fetch: stub });
    await expect(api.getCustomer(1)).rejects.toBeInstanceOf(BuildToolsAuthError);
  });
});

describe("getProjectAttachments() — MOS-216", () => {
  it("hits /documents?PR[]=:id with no list= filter", async () => {
    const payload = {
      items: [
        {
          id: 1,
          name: "scope.pdf",
          extension: "pdf",
          public_url: "https://example.com/s.pdf",
          size: 100,
          created_at: "01/01/2026",
        },
      ],
    };
    const { stub, recorded } = makeFetchStub([
      { status: 200, body: JSON.stringify(payload) },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.getProjectAttachments(100002);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 1, name: "scope.pdf", extension: "pdf" });
    expect(recorded[0].url).toBe(
      "https://moss.buildtools.app/documents?PR[]=100002",
    );
    // No `list=` filter — module-agnostic listing.
    expect(recorded[0].url).not.toContain("list=");
  });

  it("returns [] on non-200", async () => {
    const { stub } = makeFetchStub([{ status: 500, body: "" }]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    expect(await api.getProjectAttachments(100002)).toEqual([]);
  });

  it("returns [] on non-JSON body", async () => {
    const { stub } = makeFetchStub([{ status: 200, body: "<html/>" }]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    expect(await api.getProjectAttachments(100002)).toEqual([]);
  });

  it("returns [] when items is missing from the JSON envelope", async () => {
    const { stub } = makeFetchStub([{ status: 200, body: "{}" }]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    expect(await api.getProjectAttachments(100002)).toEqual([]);
  });

  it("throws BuildToolsServerError when projectId is falsy", async () => {
    const { stub } = makeFetchStub([]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    await expect(api.getProjectAttachments(0)).rejects.toBeInstanceOf(
      BuildToolsServerError,
    );
  });

  it("requires authentication", async () => {
    const { stub } = makeFetchStub([]);
    const api = new BuildToolsAPI({ fetch: stub });
    await expect(api.getProjectAttachments(1)).rejects.toBeInstanceOf(
      BuildToolsAuthError,
    );
  });
});

// ---------------------------------------------------------------------------
// AbortController timeout
// ---------------------------------------------------------------------------

describe("request() timeout", () => {
  it("aborts the fetch when timeoutMs elapses, wrapping in BuildToolsNetworkError", async () => {
    const slowFetch: typeof fetch = (async (
      _input: RequestInfo | URL,
      init: RequestInit = {},
    ): Promise<Response> => {
      // Never resolve; the abort signal should reject the fetch.
      return new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal | undefined;
        if (signal) {
          signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }
      });
    }) as typeof fetch;

    const api = new BuildToolsAPI({ fetch: slowFetch, defaultTimeoutMs: 20 });
    await expect(
      api.request("https://moss.buildtools.app/x", {}, false),
    ).rejects.toBeInstanceOf(BuildToolsNetworkError);
  });
});

// ---------------------------------------------------------------------------
// Read methods that route through datatable()
// ---------------------------------------------------------------------------

describe("datatable-backed read methods", () => {
  const empty = JSON.stringify({ data: [] });

  it("each read method hits its source-faithful resource path", async () => {
    const { stub, recorded } = makeFetchStub(
      Array.from({ length: 17 }, () => ({ status: 200, body: empty })),
    );
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;

    await api.getCompanies();
    await api.getChangeOrders();
    await api.searchChangeOrders("oak");
    await api.getPurchaseOrders();
    await api.searchPurchaseOrders("po-2025");
    await api.getTasks();
    await api.searchTasks("punch");
    await api.getRFIs();
    await api.getUsers();
    await api.searchUsers("paul");
    await api.getEmployees();
    await api.getServices();
    await api.getDailyLogs();
    await api.getWeeklyReports();
    await api.getWorkDays();
    await api.getCertificates();
    await api.searchCertificates("OSHA");

    const paths = recorded.map((r) => new URL(r.url).pathname);
    expect(paths).toEqual([
      "/companies/datatable",
      "/change-orders/datatable",
      "/change-orders/datatable",
      "/purchase-orders/datatable",
      "/purchase-orders/datatable",
      "/tasks/datatable",
      "/tasks/datatable",
      "/rfis/datatable",
      "/users/datatable",
      "/users/datatable",
      "/users/datatable", // getEmployees → users with column[4] filter
      "/services/datatable",
      "/daily-logs/datatable",
      "/weekly-reports/datatable",
      "/work-days/datatable",
      "/certificates/datatable",
      "/certificates/datatable",
    ]);

    // searchChangeOrders: query passes through as search[value]
    expect(recorded[2].url).toContain("search%5Bvalue%5D=oak");
    // searchProjects/etc encode the limit override
    expect(recorded[4].url).toContain("length=50"); // default kept
    // getEmployees applies the column[4] Employee filter
    expect(recorded[10].url).toContain("columns%5B4%5D%5Bsearch%5D%5Bvalue%5D=Employee");
  });
});

// ---------------------------------------------------------------------------
// get() helper
// ---------------------------------------------------------------------------

describe("get() helper", () => {
  it("requires authentication", async () => {
    const { stub } = makeFetchStub([]);
    const api = new BuildToolsAPI({ fetch: stub });
    await expect(api.get("/x")).rejects.toBeInstanceOf(BuildToolsAuthError);
  });

  it("returns parsed JSON on success", async () => {
    const { stub, recorded } = makeFetchStub([
      { status: 200, body: JSON.stringify({ ok: true }) },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.get("/projects/1/budget");
    expect(out).toEqual({ ok: true });
    expect(recorded[0].url).toBe("https://moss.buildtools.app/projects/1/budget");
  });

  it("returns raw body when response is not JSON", async () => {
    const { stub } = makeFetchStub([{ status: 200, body: "<html>raw</html>" }]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    expect(await api.get("/static.html")).toBe("<html>raw</html>");
  });

  it("returns null on non-200", async () => {
    const { stub } = makeFetchStub([{ status: 404, body: "" }]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    expect(await api.get("/missing")).toBeNull();
  });

  it("accepts full URLs (no baseUrl prepending)", async () => {
    const { stub, recorded } = makeFetchStub([{ status: 200, body: "{}" }]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    await api.get("https://example.com/x");
    expect(recorded[0].url).toBe("https://example.com/x");
  });
});

// ---------------------------------------------------------------------------
// post() — full-URL path passthrough
// ---------------------------------------------------------------------------

describe("post() URL handling", () => {
  it("does not prepend baseUrl when given an absolute URL", async () => {
    const { stub, recorded } = makeFetchStub([{ status: 200, body: "{}" }]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    await api.post("https://other.example.com/save", { a: 1 });
    expect(recorded[0].url).toBe("https://other.example.com/save");
  });
});

// ---------------------------------------------------------------------------
// updateProject
// ---------------------------------------------------------------------------

describe("updateProject()", () => {
  it("requires projectManager", async () => {
    const { stub } = makeFetchStub([]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    await expect(
      // @ts-expect-error — intentional bad shape
      api.updateProject(1, {}),
    ).rejects.toBeInstanceOf(BuildToolsServerError);
  });

  it("maps r:1 to success and uses provided projectId", async () => {
    const { stub, recorded } = makeFetchStub([
      { status: 200, body: JSON.stringify({ r: 1 }) },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.updateProject(42, {
      projectManager: "6",
      name: "Updated",
      status: "5",
      address: "1 Way",
      city: "C",
      state: "S",
      zip: "12345",
      country: "US",
      description: "d",
    });
    expect(out).toEqual({ success: true, projectId: 42 });
    const body = String(recorded[0].init.body);
    expect(body).toContain("id=42");
    expect(body).toContain("Project%5Bid%5D=42");
    expect(body).toContain("Project%5Bname%5D=Updated");
    expect(body).toContain("Project%5Bstatus%5D=5");
  });

  it("maps r:0 to failure with errors", async () => {
    const { stub } = makeFetchStub([
      { status: 200, body: JSON.stringify({ r: 0, errors: { x: ["bad"] } }) },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.updateProject(1, { projectManager: "1" });
    expect(out.success).toBe(false);
    expect(out.errors).toEqual({ x: ["bad"] });
  });
});

// ---------------------------------------------------------------------------
// searchProjects
// ---------------------------------------------------------------------------

describe("searchProjects()", () => {
  it("passes search[value] and length through to datatable", async () => {
    const { stub, recorded } = makeFetchStub([
      { status: 200, body: JSON.stringify({ data: [] }) },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    await api.searchProjects("oak", 25);
    expect(recorded[0].url).toContain("search%5Bvalue%5D=oak");
    expect(recorded[0].url).toContain("length=25");
  });
});

// ---------------------------------------------------------------------------
// getChangeOrderAttachments
// ---------------------------------------------------------------------------

describe("getChangeOrderAttachments()", () => {
  it("requires projectId", async () => {
    const { stub } = makeFetchStub([]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    await expect(api.getChangeOrderAttachments("")).rejects.toBeInstanceOf(
      BuildToolsServerError,
    );
  });

  it("hits /documents with module 600 listKey and maps items to the camelCase shape", async () => {
    const { stub, recorded } = makeFetchStub([
      {
        status: 200,
        body: JSON.stringify({
          items: [
            {
              id: 1,
              name: "drawing.pdf",
              module_id: 10,
              extension: "pdf",
              public_url: "https://cdn/x.pdf",
              key: "k",
              size: 1234,
              created_at: "2024-01-01",
              user_id: 9,
              user_name: "Paul",
            },
            {
              id: 2,
              name: "spec.pdf",
              module_id: 11,
              extension: "pdf",
              public_url: "https://cdn/y.pdf",
              key: "k2",
              size: 5678,
              created_at: "2024-01-02",
              user_id: 9,
              user_name: "Paul",
            },
          ],
        }),
      },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;

    const out = await api.getChangeOrderAttachments(101);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: 1,
      changeOrderId: 10,
      publicUrl: "https://cdn/x.pdf",
      userName: "Paul",
    });
    expect(recorded[0].url).toBe(
      "https://moss.buildtools.app/documents?PR[]=101&list=m-101-600-0",
    );
  });

  it("filters to a specific change-order id when provided", async () => {
    const { stub } = makeFetchStub([
      {
        status: 200,
        body: JSON.stringify({
          items: [
            { id: 1, module_id: 10 },
            { id: 2, module_id: 11 },
          ],
        }),
      },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.getChangeOrderAttachments(101, 10);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(1);
  });

  it("returns [] on non-200", async () => {
    const { stub } = makeFetchStub([{ status: 500, body: "" }]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    expect(await api.getChangeOrderAttachments(1)).toEqual([]);
  });

  it("returns [] on non-JSON body", async () => {
    const { stub } = makeFetchStub([{ status: 200, body: "not json" }]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    expect(await api.getChangeOrderAttachments(1)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createPurchaseOrder / createTask / createRFI / createService / createInvoice
// ---------------------------------------------------------------------------

describe("createPurchaseOrder()", () => {
  it("posts to /purchase-orders/save with JSON-encoded items", async () => {
    const { stub, recorded } = makeFetchStub([
      {
        status: 200,
        body: JSON.stringify({ result: "success", id: 70, message: "ok" }),
      },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.createPurchaseOrder({
      name: "Lumber",
      projectId: 1,
      companyId: 2,
      notes: "rush",
    });
    expect(out).toEqual({ success: true, purchaseOrderId: 70, message: "ok" });
    expect(recorded[0].url).toBe(
      "https://moss.buildtools.app/purchase-orders/save",
    );
    const body = String(recorded[0].init.body);
    expect(body).toContain("PurchaseOrder%5Bcompany_id%5D=2");
    expect(body).toContain("PurchaseOrder%5Bprefix%5D=PO");
    expect(body).toContain("PurchaseOrder%5Bnotes%5D=rush");
  });

  it("returns failure on non-success result", async () => {
    const { stub } = makeFetchStub([
      { status: 200, body: JSON.stringify({ result: "error", message: "x" }) },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.createPurchaseOrder({
      name: "n",
      projectId: 1,
      companyId: 2,
    });
    expect(out).toEqual({ success: false, errors: "x" });
  });

  it("returns 'Server error' on non-JSON", async () => {
    const { stub } = makeFetchStub([{ status: 500, body: "" }]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.createPurchaseOrder({
      name: "n",
      projectId: 1,
      companyId: 2,
    });
    expect(out.success).toBe(false);
  });
});

describe("createTask()", () => {
  it("posts to /tasks/save with defaults filled in", async () => {
    const { stub, recorded } = makeFetchStub([
      {
        status: 200,
        body: JSON.stringify({ result: "success", id: 33, message: "" }),
      },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.createTask({
      name: "Inspect",
      projectId: 1,
      dueDate: "2025-01-01",
      assignedTo: "9",
      description: "d",
    });
    expect(out.success).toBe(true);
    expect(out.taskId).toBe(33);
    const body = String(recorded[0].init.body);
    expect(body).toContain("Task%5Blocations_room_id%5D=2");
    expect(body).toContain("Task%5Bstatus%5D=1");
    expect(body).toContain("Task%5Bpriority%5D=1");
  });

  it("returns failure on non-success", async () => {
    const { stub } = makeFetchStub([
      { status: 200, body: JSON.stringify({ result: "error", message: "no" }) },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.createTask({ name: "x", projectId: 1 });
    expect(out).toEqual({ success: false, errors: "no" });
  });
});

describe("createRFI()", () => {
  it("posts to /rfis/save with Rfi[...] fields", async () => {
    const { stub, recorded } = makeFetchStub([
      {
        status: 200,
        body: JSON.stringify({ result: "success", id: 7, message: "ok" }),
      },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.createRFI({
      subject: "Q",
      projectId: 1,
      question: "huh?",
      assignedTo: "9",
    });
    expect(out).toEqual({ success: true, rfiId: 7, message: "ok" });
    const body = String(recorded[0].init.body);
    expect(body).toContain("Rfi%5Bsubject%5D=Q");
    expect(body).toContain("Rfi%5Bquestion%5D=huh%3F");
  });

  it("returns failure on non-success", async () => {
    const { stub } = makeFetchStub([
      { status: 200, body: JSON.stringify({ result: "error", message: "x" }) },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.createRFI({ subject: "x", projectId: 1 });
    expect(out).toEqual({ success: false, errors: "x" });
  });

  it("returns 'Server error' on non-JSON", async () => {
    const { stub } = makeFetchStub([{ status: 500, body: "" }]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.createRFI({ subject: "x", projectId: 1 });
    expect(out.success).toBe(false);
  });
});

describe("createService()", () => {
  it("posts to /services/save", async () => {
    const { stub, recorded } = makeFetchStub([
      {
        status: 200,
        body: JSON.stringify({ result: "success", id: 50, message: "ok" }),
      },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.createService({
      name: "Cleanup",
      projectId: 1,
      description: "post-work",
      dueDate: "2025-02-01",
      assignedTo: "9",
    });
    expect(out).toEqual({ success: true, serviceId: 50, message: "ok" });
    const body = String(recorded[0].init.body);
    expect(body).toContain("Service%5Bname%5D=Cleanup");
  });

  it("returns failure on non-success", async () => {
    const { stub } = makeFetchStub([
      { status: 200, body: JSON.stringify({ result: "error", message: "x" }) },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.createService({ name: "x", projectId: 1 });
    expect(out).toEqual({ success: false, errors: "x" });
  });
});

describe("createInvoice()", () => {
  it("harvests fresh _token from /invoices/form before posting save", async () => {
    const formHtml = '<input name="_token" value="FRESH_TOKEN_X"/>';
    const { stub, recorded } = makeFetchStub([
      { status: 200, body: formHtml },
      {
        status: 200,
        body: JSON.stringify({ result: "success", id: 9, message: "ok" }),
      },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.createInvoice({
      companyId: 1,
      number: "INV-1",
      date: "01/01/2025",
      dueDate: "01/31/2025",
      notes: "thanks",
    });
    expect(out).toEqual({ success: true, invoiceId: 9, message: "ok" });
    expect(recorded[0].url).toBe("https://moss.buildtools.app/invoices/form");
    expect(recorded[1].url).toBe("https://moss.buildtools.app/invoices/save");
    const body = String(recorded[1].init.body);
    expect(body).toContain("_token=FRESH_TOKEN_X");
    expect(body).toContain("from=buildtools");
    expect(body).toContain("Invoice%5Bnumber%5D=INV-1");
    expect(body).toContain("items=%5B%5D");
  });

  it("returns failure on non-success", async () => {
    const { stub } = makeFetchStub([
      { status: 200, body: '<input name="_token" value="t"/>' },
      { status: 200, body: JSON.stringify({ result: "error", message: "no" }) },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.createInvoice({
      companyId: 1,
      number: "1",
      date: "01/01/2025",
      dueDate: "01/31/2025",
    });
    expect(out).toEqual({ success: false, errors: "no" });
  });

  it("returns 'Server error' on non-JSON save response", async () => {
    const { stub } = makeFetchStub([
      { status: 200, body: '<input name="_token" value="t"/>' },
      { status: 500, body: "" },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.createInvoice({
      companyId: 1,
      number: "1",
      date: "01/01/2025",
      dueDate: "01/31/2025",
    });
    expect(out.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Financial statements
// ---------------------------------------------------------------------------

describe("createFinancialStatement()", () => {
  it("requires projectId", async () => {
    const { stub } = makeFetchStub([]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    await expect(
      // @ts-expect-error — intentional
      api.createFinancialStatement({}),
    ).rejects.toBeInstanceOf(BuildToolsServerError);
  });

  it("posts to /financial/statements/save with PR[] in URL", async () => {
    const { stub, recorded } = makeFetchStub([
      {
        status: 200,
        body: JSON.stringify({ result: "success", id: 11, message: "ok" }),
      },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.createFinancialStatement({ projectId: 101 });
    expect(out).toEqual({ success: true, statementId: 11, message: "ok" });
    expect(recorded[0].url).toBe(
      "https://moss.buildtools.app/financial/statements/save?PR[]=101",
    );
  });

  it("maps non-success", async () => {
    const { stub } = makeFetchStub([
      { status: 200, body: JSON.stringify({ result: "error", message: "x" }) },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.createFinancialStatement({ projectId: 1 });
    expect(out).toEqual({ success: false, errors: "x" });
  });

  it("returns 'Server error' on non-JSON", async () => {
    const { stub } = makeFetchStub([{ status: 500, body: "" }]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.createFinancialStatement({ projectId: 1 });
    expect(out.success).toBe(false);
  });
});

describe("createFinancialStatementWithAmount()", () => {
  it("requires projectId / amount / name", async () => {
    const { stub } = makeFetchStub([]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    // @ts-expect-error
    await expect(api.createFinancialStatementWithAmount({})).rejects.toBeInstanceOf(
      BuildToolsServerError,
    );
    await expect(
      // @ts-expect-error
      api.createFinancialStatementWithAmount({ projectId: 1 }),
    ).rejects.toBeInstanceOf(BuildToolsServerError);
    await expect(
      // @ts-expect-error
      api.createFinancialStatementWithAmount({ projectId: 1, amount: 1 }),
    ).rejects.toBeInstanceOf(BuildToolsServerError);
  });

  it("loads form, harvests CSRF + budgetOverviewTotals, patches amount, posts save", async () => {
    // Use HTML entities to exercise decodeHtml().
    const botEncoded =
      "{&quot;financial_current_amount&quot;:0,&quot;other&quot;:1}";
    const formHtml = `
      <input name="_token" value="CSRF_TOK"/>
      <input name="temp_token" value="TMP"/>
      <input name="financial_method" value="3"/>
      <input name="budgetOverviewTotals" value="${botEncoded}"/>
      <select name="assigned_to[]">
        <option value="1">a</option>
        <option selected value="9">b</option>
      </select>
    `;
    const { stub, recorded } = makeFetchStub([
      { status: 200, body: formHtml },
      {
        status: 200,
        body: JSON.stringify({ result: "success", id: 22, message: "ok" }),
      },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;

    const out = await api.createFinancialStatementWithAmount({
      projectId: 5,
      name: "Q1 Statement",
      amount: 1500,
      notes: "<b>note</b>",
    });
    expect(out).toEqual({
      success: true,
      statementId: 22,
      amount: "1500",
      message: "ok",
    });

    const body = String(recorded[1].init.body);
    expect(body).toContain("_token=CSRF_TOK");
    expect(body).toContain("temp_token=TMP");
    expect(body).toContain("financial_method=3");
    // budgetOverviewTotals should be patched to 1500
    const patched = JSON.stringify({ financial_current_amount: 1500, other: 1 });
    expect(body).toContain(
      "budgetOverviewTotals=" + encodeURIComponent(patched),
    );
    expect(body).toContain("assigned_to%5B%5D=9");
    expect(body).toContain("apradio=amount");
  });

  it("returns errors when form load fails", async () => {
    const { stub } = makeFetchStub([{ status: 500, body: "" }]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.createFinancialStatementWithAmount({
      projectId: 1,
      name: "n",
      amount: 1,
    });
    expect(out.success).toBe(false);
  });

  it("returns errors when CSRF/budgetOverviewTotals missing", async () => {
    const { stub } = makeFetchStub([{ status: 200, body: "<html/>" }]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.createFinancialStatementWithAmount({
      projectId: 1,
      name: "n",
      amount: 1,
    });
    expect(out.success).toBe(false);
  });
});

describe("deleteFinancialStatement()", () => {
  it("requires projectId and at least one id", async () => {
    const { stub } = makeFetchStub([]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    await expect(
      api.deleteFinancialStatement(1, ""),
    ).rejects.toBeInstanceOf(BuildToolsServerError);
    await expect(
      api.deleteFinancialStatement([], 1),
    ).rejects.toBeInstanceOf(BuildToolsServerError);
  });

  it("harvests CSRF, posts ids[], maps result {r,s,f}", async () => {
    const { stub, recorded } = makeFetchStub([
      { status: 200, body: '<input name="_token" value="D_CSRF"/>' },
      { status: 200, body: JSON.stringify({ r: 1, s: 2, f: 0 }) },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.deleteFinancialStatement([10, 11], 5);
    expect(out.success).toBe(true);
    expect(out.succeeded).toBe(2);
    expect(out.failed).toBe(0);
    expect(recorded[1].url).toBe(
      "https://moss.buildtools.app/financial/statements/delete?PR[]=5",
    );
    const body = String(recorded[1].init.body);
    expect(body).toContain("ids%5B%5D=10");
    expect(body).toContain("ids%5B%5D=11");
  });

  it("returns error if CSRF cannot be harvested", async () => {
    const { stub } = makeFetchStub([{ status: 200, body: "<html/>" }]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.deleteFinancialStatement(1, 5);
    expect(out.success).toBe(false);
  });

  it("returns failure on non-JSON delete response", async () => {
    const { stub } = makeFetchStub([
      { status: 200, body: '<input name="_token" value="X"/>' },
      { status: 500, body: "html" },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true;
    const out = await api.deleteFinancialStatement(1, 5);
    expect(out.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Network errors
// ---------------------------------------------------------------------------

describe("barrel exports", () => {
  it("re-exports the public surface", async () => {
    const barrel = await import("../index.js");
    expect(barrel.BuildToolsAPI).toBeDefined();
    expect(barrel.BuildToolsAuthError).toBeDefined();
    expect(barrel.BuildToolsNetworkError).toBeDefined();
    expect(barrel.BuildToolsValidationError).toBeDefined();
    expect(barrel.BuildToolsServerError).toBeDefined();
    expect(barrel.BuildToolsError).toBeDefined();
    expect(barrel.BuildToolsClientOptionsSchema).toBeDefined();
    expect(barrel.DatatableResponseSchema).toBeDefined();
    expect(barrel.ProjectSchema).toBeDefined();
    expect(barrel.ProjectSaveResultSchema).toBeDefined();
    expect(barrel.SuccessSaveResultSchema).toBeDefined();
    expect(barrel.ChangeOrderAttachmentSchema).toBeDefined();
    // MOS-216: customer + attachment schemas surfaced through the barrel.
    expect(barrel.CustomerSchema).toBeDefined();
    expect(barrel.CustomerDetailSchema).toBeDefined();
    expect(barrel.AttachmentSchema).toBeDefined();
  });

  it("DatatableResponseSchema validates a real fixture", async () => {
    const { DatatableResponseSchema, ProjectSchema } = await import(
      "../index.js"
    );
    const schema = DatatableResponseSchema(ProjectSchema);
    const ok = schema.parse({
      draw: 1,
      recordsTotal: 1,
      recordsFiltered: 1,
      data: [{ id: 1, name: "X" }],
    });
    expect(ok.data[0].name).toBe("X");
  });
});

describe("request() network errors", () => {
  it("wraps a fetch rejection in BuildToolsNetworkError", async () => {
    const throwy: typeof fetch = (async () => {
      throw new Error("ENOTFOUND");
    }) as typeof fetch;
    const api = new BuildToolsAPI({ fetch: throwy });
    await expect(
      api.request("https://moss.buildtools.app/x", {}, false),
    ).rejects.toBeInstanceOf(BuildToolsNetworkError);
  });
});

// ---------------------------------------------------------------------------
// MOS-212 — isAuthenticated() + session expiry + 401 re-auth retry
// ---------------------------------------------------------------------------

describe("isAuthenticated()", () => {
  it("returns false on a fresh instance", () => {
    const api = new BuildToolsAPI({ fetch: makeFetchStub([]).stub });
    expect(api.isAuthenticated()).toBe(false);
  });

  it("returns true after api.authenticated is set directly (Phase 2.1 back-compat)", () => {
    const api = new BuildToolsAPI({ fetch: makeFetchStub([]).stub });
    api.authenticated = true;
    expect(api.isAuthenticated()).toBe(true);
  });

  it("returns false when the session timestamp is older than sessionTimeoutMinutes", () => {
    const api = new BuildToolsAPI({
      fetch: makeFetchStub([]).stub,
      sessionTimeoutMinutes: 30,
    });
    api.authenticated = true;
    // 31 minutes ago → expired.
    (api as unknown as { sessionTimestamp: number }).sessionTimestamp =
      Date.now() - 31 * 60_000;
    expect(api.isAuthenticated()).toBe(false);
  });

  it("returns true when the session timestamp is within the timeout window", () => {
    const api = new BuildToolsAPI({
      fetch: makeFetchStub([]).stub,
      sessionTimeoutMinutes: 30,
    });
    api.authenticated = true;
    (api as unknown as { sessionTimestamp: number }).sessionTimestamp =
      Date.now() - 10 * 60_000;
    expect(api.isAuthenticated()).toBe(true);
  });
});

describe("auto re-authentication on session expiry", () => {
  it("triggers authenticate() on the next data call when the session has expired", async () => {
    const { stub } = makeFetchStub([
      // The data call after re-auth.
      { status: 200, body: JSON.stringify({ data: [] }) },
    ]);
    const api = new BuildToolsAPI({
      fetch: stub,
      username: "cached-user@example.com",
      password: "cached-pw",
      sessionTimeoutMinutes: 30,
    });
    api.authenticated = true;
    (api as unknown as { sessionTimestamp: number }).sessionTimestamp =
      Date.now() - 31 * 60_000;

    const authSpy = vi
      .spyOn(api, "authenticate")
      .mockImplementation(async (email, password) => {
        // Simulate a successful re-auth: flip the flag and stamp the session.
        api.authenticated = true;
        (api as unknown as { sessionTimestamp: number }).sessionTimestamp =
          Date.now();
        expect(email).toBe("cached-user@example.com");
        expect(password).toBe("cached-pw");
        return true;
      });

    const out = await api.getProjects();
    expect(out).toEqual({ data: [] });
    expect(authSpy).toHaveBeenCalledTimes(1);
  });

  it("throws BuildToolsAuthError on a data call when no credentials are cached", async () => {
    const { stub } = makeFetchStub([]);
    const api = new BuildToolsAPI({ fetch: stub });
    // No username/password seeded; authenticated is false.
    await expect(api.getProjects()).rejects.toBeInstanceOf(
      BuildToolsAuthError,
    );
  });
});

describe("401 re-auth retry", () => {
  it("re-authenticates once and replays the request on 401, returning the second response", async () => {
    const { stub, recorded } = makeFetchStub([
      // First call: 401.
      { status: 401, body: "" },
      // Replay after re-auth: 200 with data.
      { status: 200, body: JSON.stringify({ data: [{ id: 1 }] }) },
    ]);
    const api = new BuildToolsAPI({
      fetch: stub,
      username: "u@example.com",
      password: "pw",
    });
    api.authenticated = true;

    const authSpy = vi
      .spyOn(api, "authenticate")
      .mockImplementation(async () => {
        api.authenticated = true;
        (api as unknown as { sessionTimestamp: number }).sessionTimestamp =
          Date.now();
        return true;
      });

    const out = await api.getProjects();
    expect(out).toEqual({ data: [{ id: 1 }] });
    expect(authSpy).toHaveBeenCalledTimes(1);
    // Two fetches total: the 401, then the replay.
    expect(recorded).toHaveLength(2);
  });

  it("surfaces the original 401 response when the replay is still 401 (no infinite loop)", async () => {
    const { stub, recorded } = makeFetchStub([
      // First call: 401.
      { status: 401, body: "" },
      // Replay after re-auth: still 401.
      { status: 401, body: "" },
    ]);
    const api = new BuildToolsAPI({
      fetch: stub,
      username: "u",
      password: "p",
    });
    api.authenticated = true;

    const authSpy = vi
      .spyOn(api, "authenticate")
      .mockImplementation(async () => {
        api.authenticated = true;
        (api as unknown as { sessionTimestamp: number }).sessionTimestamp =
          Date.now();
        return true;
      });

    // datatable returns null on non-200 — the still-401 surfaces as null.
    const out = await api.getProjects();
    expect(out).toBeNull();
    expect(authSpy).toHaveBeenCalledTimes(1);
    // Exactly two fetches: first 401 + one replay. No further retries.
    expect(recorded).toHaveLength(2);
  });

  it("does NOT retry when no cached credentials are available", async () => {
    const { stub, recorded } = makeFetchStub([{ status: 401, body: "" }]);
    const api = new BuildToolsAPI({ fetch: stub });
    api.authenticated = true; // Phase-2.1-style direct set, no creds cached.

    const authSpy = vi.spyOn(api, "authenticate");

    const out = await api.getProjects();
    expect(out).toBeNull();
    expect(authSpy).toHaveBeenCalledTimes(0);
    expect(recorded).toHaveLength(1);
  });

  it("bubbles the original 401 when re-auth itself throws", async () => {
    const { stub, recorded } = makeFetchStub([{ status: 401, body: "" }]);
    const api = new BuildToolsAPI({
      fetch: stub,
      username: "u",
      password: "p",
    });
    api.authenticated = true;

    vi.spyOn(api, "authenticate").mockRejectedValue(
      new BuildToolsAuthError("bad creds"),
    );

    const out = await api.getProjects();
    expect(out).toBeNull();
    expect(recorded).toHaveLength(1);
  });
});

describe("authenticate() updates sessionTimestamp and credential cache", () => {
  it("stamps sessionTimestamp on success and caches the credentials", async () => {
    const loginPageHtml = '<input name="_token" value="TOK"/>';
    const { stub } = makeFetchStub([
      { status: 200, body: loginPageHtml },
      { status: 200, body: "" },
      { status: 200, body: "<html>logout</html>" },
    ]);
    const api = new BuildToolsAPI({ fetch: stub });
    const before = Date.now();
    await api.authenticate("seeded@example.com", "seeded-pw");
    const after = Date.now();

    const internal = api as unknown as {
      sessionTimestamp: number | null;
      username: string | null;
      password: string | null;
    };
    expect(internal.sessionTimestamp).toBeGreaterThanOrEqual(before);
    expect(internal.sessionTimestamp).toBeLessThanOrEqual(after);
    expect(internal.username).toBe("seeded@example.com");
    expect(internal.password).toBe("seeded-pw");
    expect(api.isAuthenticated()).toBe(true);
  });
});

describe("barrel exports — config surface (MOS-212)", () => {
  it("re-exports loadConfigFromEnv as a function", async () => {
    const barrel = await import("../index.js");
    expect(typeof barrel.loadConfigFromEnv).toBe("function");
  });
});
