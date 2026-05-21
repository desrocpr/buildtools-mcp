/**
 * Unit tests for BuildToolsAPI.
 *
 * All tests use vi.stubGlobal('fetch', ...) — no real network I/O.
 * Base URL in assertions: https://moss.buildtools.app
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuildToolsAPI } from "../BuildToolsAPI.js";
import {
  BuildToolsAuthError,
  BuildToolsClientError,
  BuildToolsNetworkError,
  BuildToolsServerError,
} from "../errors.js";
import {
  fixtureAttachments,
  fixtureChangeOrder1,
  fixtureChangeOrders,
  fixtureCustomer1,
  fixtureCustomers,
  fixtureFinancialStatement,
  fixtureProject1,
  fixtureProjects,
} from "./fixtures/projects.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = "https://moss.buildtools.app";

/** Default test options */
const defaultOpts = {
  tenant: "moss",
  username: "testuser",
  password: "testpass",
};

/** Create a minimal mock Response object */
function mockResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string): string | null {
        const lname = name.toLowerCase();
        return headers[lname] ?? headers[name] ?? null;
      },
      getSetCookie(): string[] {
        return headers["set-cookie"] ? [headers["set-cookie"]] : [];
      },
    },
    text: async () => bodyStr,
    json: async () => JSON.parse(bodyStr),
    redirected: false,
    url: "",
    type: "default",
    clone: () => mockResponse(body, status, headers),
  } as unknown as Response;
}

/** Helper: mock fetch returning a JSON response */
function mockFetch(body: unknown, status = 200, headers: Record<string, string> = {}) {
  const stub = vi.fn().mockResolvedValue(mockResponse(body, status, headers));
  vi.stubGlobal("fetch", stub);
  return stub;
}

/** Create an authenticated API instance (cookies already set) */
async function makeAuthenticatedAPI() {
  const stub = vi.fn().mockResolvedValueOnce(
    mockResponse("", 302, { "set-cookie": "session=abc123; Path=/; HttpOnly" })
  );
  vi.stubGlobal("fetch", stub);
  const api = new BuildToolsAPI(defaultOpts);
  await api.authenticate();
  return { api, stub };
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("BuildToolsAPI — constructor", () => {
  it("derives base URL from tenant slug", () => {
    const api = new BuildToolsAPI(defaultOpts);
    // isAuthenticated() is false initially — just check it constructs
    expect(api.isAuthenticated()).toBe(false);
  });

  it("accepts an explicit baseUrl override", () => {
    const api = new BuildToolsAPI({
      ...defaultOpts,
      baseUrl: "https://staging.buildtools.app",
    });
    expect(api.isAuthenticated()).toBe(false);
  });

  it("throws ZodError for missing required fields", () => {
    expect(() => new BuildToolsAPI({} as never)).toThrow();
  });
});

describe("BuildToolsAPI — authenticate()", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs credentials as form-encoded to /login", async () => {
    const stub = mockFetch(
      "",
      302,
      { "set-cookie": "session=xyz; Path=/; HttpOnly" }
    );
    const api = new BuildToolsAPI(defaultOpts);
    await api.authenticate();

    expect(stub).toHaveBeenCalledOnce();
    const [url, init] = stub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/login`);
    expect(init.method).toBe("POST");
    // headers is a Headers instance; use .get() to read header values
    const headers = init.headers as Headers;
    expect(headers.get("Content-Type")).toBe(
      "application/x-www-form-urlencoded"
    );
    const body = init.body as string;
    expect(body).toContain("username=testuser");
    expect(body).toContain("password=testpass");
  });

  it("sets isAuthenticated() to true after success", async () => {
    mockFetch("", 302, { "set-cookie": "session=abc; Path=/" });
    const api = new BuildToolsAPI(defaultOpts);
    await api.authenticate();
    expect(api.isAuthenticated()).toBe(true);
  });

  it("throws BuildToolsAuthError when no cookies returned", async () => {
    mockFetch("OK", 200, {});
    const api = new BuildToolsAPI(defaultOpts);
    await expect(api.authenticate()).rejects.toThrow(BuildToolsAuthError);
  });

  it("throws BuildToolsAuthError on 4xx non-redirect failure", async () => {
    mockFetch("Unauthorized", 401, {});
    const api = new BuildToolsAPI(defaultOpts);
    await expect(api.authenticate()).rejects.toThrow(BuildToolsAuthError);
  });

  it("stores cookies and attaches them to subsequent requests", async () => {
    const loginStub = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse("", 302, {
          "set-cookie": "session=secret; Path=/; HttpOnly",
        })
      )
      .mockResolvedValueOnce(mockResponse(fixtureProjects, 200));
    vi.stubGlobal("fetch", loginStub);

    const api = new BuildToolsAPI(defaultOpts);
    await api.authenticate();
    await api.listProjects();

    const [, secondInit] = loginStub.mock.calls[1] as [string, RequestInit];
    const headers = secondInit.headers as Headers;
    // The Cookie header should contain our session value
    expect(headers.get("Cookie")).toContain("session=secret");
  });
});

describe("BuildToolsAPI — listProjects()", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GETs /api/projects and returns parsed array", async () => {
    const { api, stub } = await makeAuthenticatedAPI();
    stub.mockResolvedValueOnce(mockResponse(fixtureProjects));

    const result = await api.listProjects();
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(101);

    const [url] = stub.mock.calls[1] as [string];
    expect(url).toBe(`${BASE_URL}/api/projects`);
  });

  it("passes filter params as query string", async () => {
    const { api, stub } = await makeAuthenticatedAPI();
    stub.mockResolvedValueOnce(mockResponse([]));

    await api.listProjects({ status: "active", page: 2 });
    const [url] = stub.mock.calls[1] as [string];
    expect(url).toContain("status=active");
    expect(url).toContain("page=2");
  });

  it("handles wrapped { data: [...] } response shape", async () => {
    const { api, stub } = await makeAuthenticatedAPI();
    stub.mockResolvedValueOnce(mockResponse({ data: fixtureProjects }));

    const result = await api.listProjects();
    expect(result).toHaveLength(2);
  });

  it("throws BuildToolsClientError for non-array response", async () => {
    const { api, stub } = await makeAuthenticatedAPI();
    stub.mockResolvedValueOnce(mockResponse({ error: "bad" }));

    await expect(api.listProjects()).rejects.toThrow(BuildToolsClientError);
  });

  it("throws BuildToolsServerError on 500", async () => {
    const { api, stub } = await makeAuthenticatedAPI();
    stub.mockResolvedValueOnce(mockResponse("Internal Error", 500));

    await expect(api.listProjects()).rejects.toThrow(BuildToolsServerError);
  });
});

describe("BuildToolsAPI — getProject()", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GETs /api/projects/:id", async () => {
    const { api, stub } = await makeAuthenticatedAPI();
    stub.mockResolvedValueOnce(mockResponse(fixtureProject1));

    const result = await api.getProject(101);
    expect(result?.id).toBe(101);

    const [url] = stub.mock.calls[1] as [string];
    expect(url).toBe(`${BASE_URL}/api/projects/101`);
  });

  it("returns null on 404", async () => {
    const { api, stub } = await makeAuthenticatedAPI();
    stub.mockResolvedValueOnce(mockResponse("Not Found", 404));

    const result = await api.getProject(9999);
    expect(result).toBeNull();
  });
});

describe("BuildToolsAPI — searchProjects()", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GETs /api/projects/search with q param", async () => {
    const { api, stub } = await makeAuthenticatedAPI();
    stub.mockResolvedValueOnce(mockResponse([fixtureProject1]));

    const result = await api.searchProjects("Moss");
    expect(result).toHaveLength(1);
    const [url] = stub.mock.calls[1] as [string];
    expect(url).toContain("/api/projects/search");
    expect(url).toContain("q=Moss");
  });
});

describe("BuildToolsAPI — listChangeOrders()", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GETs /api/projects/:id/change-orders", async () => {
    const { api, stub } = await makeAuthenticatedAPI();
    stub.mockResolvedValueOnce(mockResponse(fixtureChangeOrders));

    const result = await api.listChangeOrders(101);
    expect(result).toHaveLength(2);
    const [url] = stub.mock.calls[1] as [string];
    expect(url).toBe(`${BASE_URL}/api/projects/101/change-orders`);
  });
});

describe("BuildToolsAPI — getChangeOrder()", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GETs /api/change-orders/:id", async () => {
    const { api, stub } = await makeAuthenticatedAPI();
    stub.mockResolvedValueOnce(mockResponse(fixtureChangeOrder1));

    const result = await api.getChangeOrder(301);
    expect(result?.id).toBe(301);
    const [url] = stub.mock.calls[1] as [string];
    expect(url).toBe(`${BASE_URL}/api/change-orders/301`);
  });

  it("returns null on 404", async () => {
    const { api, stub } = await makeAuthenticatedAPI();
    stub.mockResolvedValueOnce(mockResponse("Not Found", 404));

    const result = await api.getChangeOrder(9999);
    expect(result).toBeNull();
  });
});

describe("BuildToolsAPI — findUnbilledChangeOrders()", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GETs /api/change-orders/unbilled", async () => {
    const { api, stub } = await makeAuthenticatedAPI();
    stub.mockResolvedValueOnce(mockResponse(fixtureChangeOrders));

    const result = await api.findUnbilledChangeOrders();
    expect(result).toHaveLength(2);
    const [url] = stub.mock.calls[1] as [string];
    expect(url).toBe(`${BASE_URL}/api/change-orders/unbilled`);
  });
});

describe("BuildToolsAPI — getFinancialStatement()", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GETs /api/projects/:id/financial-statement", async () => {
    const { api, stub } = await makeAuthenticatedAPI();
    stub.mockResolvedValueOnce(mockResponse(fixtureFinancialStatement));

    const result = await api.getFinancialStatement(101);
    expect(result.project_id).toBe(101);
    const [url] = stub.mock.calls[1] as [string];
    expect(url).toBe(`${BASE_URL}/api/projects/101/financial-statement`);
  });

  it("throws BuildToolsClientError on 404 (does NOT return null)", async () => {
    const { api, stub } = await makeAuthenticatedAPI();
    stub.mockResolvedValueOnce(mockResponse("Not Found", 404));

    // 404 should throw, NOT return null
    await expect(api.getFinancialStatement(9999)).rejects.toThrow(
      BuildToolsClientError
    );
  });
});

describe("BuildToolsAPI — listCustomers()", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GETs /api/customers", async () => {
    const { api, stub } = await makeAuthenticatedAPI();
    stub.mockResolvedValueOnce(mockResponse(fixtureCustomers));

    const result = await api.listCustomers();
    expect(result).toHaveLength(2);
    const [url] = stub.mock.calls[1] as [string];
    expect(url).toBe(`${BASE_URL}/api/customers`);
  });
});

describe("BuildToolsAPI — getCustomer()", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GETs /api/customers/:id", async () => {
    const { api, stub } = await makeAuthenticatedAPI();
    stub.mockResolvedValueOnce(mockResponse(fixtureCustomer1));

    const result = await api.getCustomer(201);
    expect(result?.id).toBe(201);
    const [url] = stub.mock.calls[1] as [string];
    expect(url).toBe(`${BASE_URL}/api/customers/201`);
  });

  it("returns null on 404", async () => {
    const { api, stub } = await makeAuthenticatedAPI();
    stub.mockResolvedValueOnce(mockResponse("Not Found", 404));

    const result = await api.getCustomer(9999);
    expect(result).toBeNull();
  });
});

describe("BuildToolsAPI — listAttachments()", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GETs /api/projects/:id/attachments without filters", async () => {
    const { api, stub } = await makeAuthenticatedAPI();
    stub.mockResolvedValueOnce(mockResponse(fixtureAttachments));

    const result = await api.listAttachments(101);
    expect(result).toHaveLength(2);
    const [url] = stub.mock.calls[1] as [string];
    expect(url).toBe(`${BASE_URL}/api/projects/101/attachments`);
  });

  it("appends entity_type query param when provided", async () => {
    const { api, stub } = await makeAuthenticatedAPI();
    stub.mockResolvedValueOnce(mockResponse([fixtureAttachments[1]]));

    await api.listAttachments(101, "change_order");
    const [url] = stub.mock.calls[1] as [string];
    expect(url).toContain("entity_type=change_order");
    expect(url).not.toContain("entity_id");
  });

  it("appends both entity_type and entity_id when both provided", async () => {
    const { api, stub } = await makeAuthenticatedAPI();
    stub.mockResolvedValueOnce(mockResponse([fixtureAttachments[1]]));

    await api.listAttachments(101, "change_order", 301);
    const [url] = stub.mock.calls[1] as [string];
    expect(url).toContain("entity_type=change_order");
    expect(url).toContain("entity_id=301");
  });
});

describe("BuildToolsAPI — error handling", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("wraps network errors in BuildToolsNetworkError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const api = new BuildToolsAPI(defaultOpts);
    await expect(api.authenticate()).rejects.toThrow(BuildToolsNetworkError);
  });

  it("throws BuildToolsNetworkError on AbortError (timeout)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(
        Object.assign(new Error("The operation was aborted"), {
          name: "AbortError",
        })
      )
    );
    const api = new BuildToolsAPI(defaultOpts);
    await expect(api.authenticate()).rejects.toThrow(BuildToolsNetworkError);
  });

  it("throws BuildToolsClientError for invalid JSON response", async () => {
    const { api, stub } = await makeAuthenticatedAPI();
    stub.mockResolvedValueOnce(
      mockResponse("this is not json", 200)
    );
    await expect(api.listProjects()).rejects.toThrow(BuildToolsClientError);
  });

  it("throws BuildToolsClientError on Zod parse failure for single item", async () => {
    const { api, stub } = await makeAuthenticatedAPI();
    // Project without required 'name' field
    stub.mockResolvedValueOnce(mockResponse({ id: 999 }));
    await expect(api.getProject(999)).rejects.toThrow(BuildToolsClientError);
  });

  it("throws BuildToolsClientError (status field) on 4xx", async () => {
    const { api, stub } = await makeAuthenticatedAPI();
    stub.mockResolvedValueOnce(mockResponse("Bad Request", 400));
    const err = await api.listProjects().catch((e) => e);
    expect(err).toBeInstanceOf(BuildToolsClientError);
    expect((err as BuildToolsClientError).status).toBe(400);
  });

  it("throws BuildToolsServerError (status field) on 5xx", async () => {
    const { api, stub } = await makeAuthenticatedAPI();
    stub.mockResolvedValueOnce(mockResponse("Service Unavailable", 503));
    const err = await api.listProjects().catch((e) => e);
    expect(err).toBeInstanceOf(BuildToolsServerError);
    expect((err as BuildToolsServerError).status).toBe(503);
  });

  it("throws BuildToolsAuthError on 401", async () => {
    const { api, stub } = await makeAuthenticatedAPI();
    stub.mockResolvedValueOnce(mockResponse("Unauthorized", 401));
    await expect(api.listProjects()).rejects.toThrow(BuildToolsAuthError);
  });

  it("throws BuildToolsAuthError on 403", async () => {
    const { api, stub } = await makeAuthenticatedAPI();
    stub.mockResolvedValueOnce(mockResponse("Forbidden", 403));
    await expect(api.listProjects()).rejects.toThrow(BuildToolsAuthError);
  });
});

describe("BuildToolsAPI — error class properties", () => {
  it("BuildToolsClientError carries status and body", () => {
    const err = new BuildToolsClientError("bad req", 400, "body text");
    expect(err.status).toBe(400);
    expect(err.body).toBe("body text");
    expect(err.name).toBe("BuildToolsClientError");
    expect(err).toBeInstanceOf(Error);
  });

  it("BuildToolsServerError carries status and body", () => {
    const err = new BuildToolsServerError("server err", 500, "oops");
    expect(err.status).toBe(500);
    expect(err.body).toBe("oops");
    expect(err.name).toBe("BuildToolsServerError");
    expect(err).toBeInstanceOf(Error);
  });

  it("BuildToolsAuthError extends Error", () => {
    const err = new BuildToolsAuthError("no auth");
    expect(err.name).toBe("BuildToolsAuthError");
    expect(err).toBeInstanceOf(Error);
  });

  it("BuildToolsNetworkError extends Error", () => {
    const cause = new TypeError("fetch failed");
    const err = new BuildToolsNetworkError("net err", cause);
    expect(err.name).toBe("BuildToolsNetworkError");
    expect(err).toBeInstanceOf(Error);
    expect(err.cause).toBe(cause);
  });
});
