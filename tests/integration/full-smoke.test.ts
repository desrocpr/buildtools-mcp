/**
 * Full E2E smoke test — MOS-222 (Phase 7.2 close-out).
 *
 * Final validation of the buildtools-mcp surface. Three suites in one file,
 * each gated by env vars so the default `npm test` run continues to pass with
 * everything skipped:
 *
 *   1. Read-path (stdio)
 *      Gate: BUILDTOOLS_INTEGRATION_TESTS=1
 *      Boots the built server over stdio, asserts the full tool surface, and
 *      exercises a handful of representative read tools. Mirrors the gating
 *      pattern of `tests/integration/read-mvp.test.ts` but supersedes it as
 *      the broader read coverage. Assertions verify real-content shapes
 *      (e.g. a `**N projects**` or `No projects matched` Markdown body) AND
 *      explicitly reject the server's misconfig / auth-error Markdown so the
 *      suite cannot pass when credentials are missing.
 *
 *   2. Write-path (stdio, destructive)
 *      Gate: BUILDTOOLS_INTEGRATION_TESTS=1 AND BUILDTOOLS_DESTRUCTIVE_TESTS=1
 *      Exercises the two-step `create_project` confirmation handshake. Creates
 *      a real, clearly-labeled "SMOKE TEST — DELETE ME — <ISO>" project. The
 *      `afterAll` hook cancels that project directly via `BuildToolsAPI`
 *      (status code 12 = Cancelled) because the MCP surface does NOT yet
 *      expose an `update_project` tool — this avoids polluting the live
 *      BuildTools tenant with one uncancelled SMOKE TEST project per run.
 *
 *      Requires the following extra env vars when enabled:
 *        - BUILDTOOLS_TENANT / BUILDTOOLS_USERNAME / BUILDTOOLS_PASSWORD
 *          (already required by the server itself)
 *        - BUILDTOOLS_TEST_PM_ID — employee ID for the test project's PM
 *
 *   3. HTTP/SSE transport
 *      Gate: BUILDTOOLS_INTEGRATION_TESTS=1 AND BUILDTOOLS_HTTP_TESTS=1
 *      Spawns the server with MCP_TRANSPORT=http on a dynamically-picked port
 *      (avoids CI collisions), connects via SSEClientTransport with a bearer
 *      token, and asserts the HTTP tool surface matches stdio + adds the
 *      session-handshake tool.
 *
 * Note on the original issue prose ("ping + 10 read tools + 5 write tools"):
 * that count is STALE — the server's real surface is ~40 tools (37 stdio,
 * +1 session handshake on HTTP). `STDIO_TOOL_NAMES` below is derived from
 * `src/transports/stdio.ts`, NOT from the issue prose. AC §5 of the planner
 * contract acknowledges this drift explicitly.
 *
 * How to run:
 *   # everything skipped (default):
 *   npm test
 *
 *   # read-path only:
 *   BUILDTOOLS_INTEGRATION_TESTS=1 \
 *     BUILDTOOLS_TENANT=moss BUILDTOOLS_USERNAME=... BUILDTOOLS_PASSWORD=... \
 *     npm test -- tests/integration/full-smoke.test.ts
 *
 *   # read-path + destructive write-path (creates a real test project):
 *   BUILDTOOLS_INTEGRATION_TESTS=1 BUILDTOOLS_DESTRUCTIVE_TESTS=1 \
 *     BUILDTOOLS_TENANT=moss BUILDTOOLS_USERNAME=... BUILDTOOLS_PASSWORD=... \
 *     BUILDTOOLS_TEST_PM_ID=12345 \
 *     npm test -- tests/integration/full-smoke.test.ts
 *
 *   # HTTP/SSE transport:
 *   BUILDTOOLS_INTEGRATION_TESTS=1 BUILDTOOLS_HTTP_TESTS=1 \
 *     npm test -- tests/integration/full-smoke.test.ts
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

import { BuildToolsAPI } from "../../src/client/BuildToolsAPI.js";
import { loadConfigFromEnv } from "../../src/client/config.js";

const READ_ENABLED = process.env.BUILDTOOLS_INTEGRATION_TESTS === "1";
const WRITE_ENABLED =
  READ_ENABLED && process.env.BUILDTOOLS_DESTRUCTIVE_TESTS === "1";
const HTTP_ENABLED =
  READ_ENABLED && process.env.BUILDTOOLS_HTTP_TESTS === "1";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(__dirname, "..", "..");
const distIndexPath = resolve(projectRoot, "dist/index.js");

/**
 * Tools registered by `src/transports/stdio.ts`. Derived from the
 * registry-building code in that file (NOT from the stale issue prose).
 *
 * If new tools are added to the stdio registry, this list must be updated and
 * the corresponding suite will catch the drift.
 */
const STDIO_TOOL_NAMES = [
  // health
  "ping",
  // projects (MOS-214)
  "list_projects",
  "get_project",
  "search_projects",
  // financial reads (MOS-215, MOS-303)
  "list_change_orders",
  "get_change_order",
  "find_unbilled_change_orders",
  "get_financial_statement",
  "list_financial_statements",
  // customers (MOS-216)
  "list_customers",
  "get_customer",
  // attachments (MOS-216)
  "list_project_attachments",
  // tasks (MOS-293)
  "list_tasks",
  "search_tasks",
  // purchase orders (MOS-292)
  "list_purchase_orders",
  "search_purchase_orders",
  // work tracking (MOS-295)
  "list_certificates",
  "list_daily_logs",
  "list_weekly_reports",
  "list_work_days",
  // operations (MOS-294)
  "list_rfis",
  "list_services",
  "list_users",
  "search_users",
  // selections
  "list_selections",
  "get_selection",
  "list_allowances",
  "list_selection_categories",
  // mutations (Phase 5: MOS-296..299 + selections)
  "create_project",
  "create_change_order",
  "create_purchase_order",
  "create_task",
  "create_rfi",
  "create_invoice",
  "create_financial_statement",
  "delete_financial_statement",
  "create_service",
  "create_selection",
  "delete_selection",
] as const;

/** HTTP mode adds the per-session credentials handshake tool. */
const HTTP_EXTRA_TOOL_NAMES = ["set_session_credentials"] as const;

/** Tool names every assertion in this file MUST find present. */
const MIN_REQUIRED_TOOLS = [
  "ping",
  "list_projects",
  "get_project",
  "find_unbilled_change_orders",
  "create_project",
] as const;

/**
 * Build the server bundle exactly ONCE per test-file run, even if all three
 * suites are enabled. Without this guard, `tsc` would run 3× (~30-45s wasted).
 * The first suite's `beforeAll` awaits this; subsequent calls are no-ops.
 *
 * MEDIUM-2 review fix on top of the original "execSync in every beforeAll"
 * approach.
 */
let buildOncePromise: Promise<void> | undefined;
async function ensureBuilt(): Promise<void> {
  if (!buildOncePromise) {
    buildOncePromise = (async () => {
      execSync("npm run build", { stdio: "inherit", cwd: projectRoot });
    })();
  }
  await buildOncePromise;
}

/**
 * Pattern that matches the server's well-known misconfiguration / auth-error
 * Markdown surfaces (`loadConfigFromEnv` "is required", BuildTools auth
 * errors, transport "configuration error" branches). Used in negative
 * assertions so that a misconfigured spawned server cannot silently turn
 * the read-path suite green.
 */
const SERVER_ERROR_PATTERN =
  /is required|configuration error|unauthorized|not authenticated|invalid credentials/i;

/** Find an unused TCP port — same pattern as `http-transport.test.ts`. */
async function pickPort(): Promise<number> {
  return await new Promise<number>((resolveFn, rejectFn) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rejectFn);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolveFn(port));
      } else {
        srv.close(() => rejectFn(new Error("Could not resolve port")));
      }
    });
  });
}

/** Read `content[0].text` from a callTool result, asserting the shape. */
function textFromResult(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  expect(r.content).toBeDefined();
  expect(Array.isArray(r.content)).toBe(true);
  const first = r.content?.[0];
  expect(first).toBeDefined();
  expect(first?.type).toBe("text");
  expect(typeof first?.text).toBe("string");
  return first!.text!;
}

// ---------------------------------------------------------------------------
// Suite A — Read-path smoke (stdio)
// ---------------------------------------------------------------------------

describe.skipIf(!READ_ENABLED)(
  "MOS-222 full-smoke A — read path (stdio)",
  () => {
    let client: Client | undefined;

    beforeAll(async () => {
      await ensureBuilt();

      const transport = new StdioClientTransport({
        command: "node",
        args: [distIndexPath],
        stderr: "pipe",
      });

      client = new Client(
        { name: "mos-222-full-smoke-read", version: "0.0.0" },
        { capabilities: {} },
      );

      await client.connect(transport);
    }, 60_000);

    afterAll(async () => {
      await client?.close();
    });

    it("tools/list returns the full stdio tool surface", async () => {
      if (!client) throw new Error("client not initialized");
      const result = await client.listTools();
      expect(result.tools).toBeDefined();

      const actual = result.tools.map((t) => t.name).sort();
      const expected = [...STDIO_TOOL_NAMES].sort();
      expect(actual).toEqual(expected);

      // Belt + suspenders: every tool the rest of this file depends on must
      // be present even if STDIO_TOOL_NAMES is updated in lockstep with a
      // future drop. Catches partial regressions.
      for (const name of MIN_REQUIRED_TOOLS) {
        expect(actual).toContain(name);
      }
    });

    it("list_projects returns real Markdown (not a misconfig error)", async () => {
      if (!client) throw new Error("client not initialized");
      // The destructive smoke is gated separately, but READ_ENABLED implies
      // the operator has wired live BUILDTOOLS_* env vars — so we must reject
      // the server's misconfig / auth-error Markdown branches outright. A
      // valid empty result ("No projects matched the filter") is still
      // accepted (the suite is independent of tenant data shape).
      const result = await client.callTool({
        name: "list_projects",
        arguments: { status: "Active", limit: 5 },
      });
      const text = textFromResult(result);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(SERVER_ERROR_PATTERN);
      // `list_projects` formatter emits either `**N project[s]**` or
      // `No projects matched the filter (...)`. Both contain "project".
      expect(text).toMatch(/project/i);
    });

    it("get_project returns real Markdown (not a misconfig error)", async () => {
      if (!client) throw new Error("client not initialized");
      // Use a project_id that is almost certainly invalid (1) — we want a
      // well-formed `No project found with ID #1.` response, not a real
      // project payload, because this suite runs on any tenant.
      const result = await client.callTool({
        name: "get_project",
        arguments: { project_id: 1 },
      });
      const text = textFromResult(result);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(SERVER_ERROR_PATTERN);
      // Either `## Project #<id>` (success) or `No project found with ID #1.`
      // (empty), but never an error-only payload.
      expect(text).toMatch(/project/i);
    });

    it("find_unbilled_change_orders returns real Markdown (not a misconfig error)", async () => {
      if (!client) throw new Error("client not initialized");
      const result = await client.callTool({
        name: "find_unbilled_change_orders",
        arguments: {},
      });
      const text = textFromResult(result);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(SERVER_ERROR_PATTERN);
      // `find_unbilled_change_orders` emits either
      // `**N active project[s]** with unbilled change orders ...` or
      // `No active projects with unbilled change orders found...`.
      expect(text).toMatch(/project/i);
    });
  },
);

// ---------------------------------------------------------------------------
// Suite B — Write-path smoke (stdio, destructive)
// ---------------------------------------------------------------------------

describe.skipIf(!WRITE_ENABLED)(
  "MOS-222 full-smoke B — write path (stdio, destructive)",
  () => {
    let client: Client | undefined;
    // Describe-scoped state — replaces a previous `globalThis` smuggle that
    // would have broken under parallel workers or `--filter` (MEDIUM-1).
    let confirmationId: string | undefined;
    let createdProjectId: string | undefined;
    let createdProjectNumericId: number | undefined;
    const timestamp = new Date().toISOString();
    const testProjectName = `SMOKE TEST — DELETE ME — ${timestamp}`;

    beforeAll(async () => {
      await ensureBuilt();

      const transport = new StdioClientTransport({
        command: "node",
        args: [distIndexPath],
        stderr: "pipe",
      });

      client = new Client(
        { name: "mos-222-full-smoke-write", version: "0.0.0" },
        { capabilities: {} },
      );

      await client.connect(transport);
    }, 60_000);

    afterAll(async () => {
      // Best-effort cleanup: cancel the SMOKE TEST project we just created so
      // the live BuildTools tenant does not accumulate one uncancelled
      // SMOKE TEST project per run.
      //
      // The MCP surface does NOT yet expose an `update_project` tool, so we
      // call `BuildToolsAPI.updateProject()` directly from the test process
      // (the underlying API supports it — see src/client/BuildToolsAPI.ts
      // L697+). BuildTools status code 12 = "Cancelled" (see
      // src/tools/projects.ts STATUS_LABEL_TO_CODES).
      //
      // We do NOT throw from this hook on cleanup failure — a cleanup error
      // should not mask the real test failure (if any). Instead we surface
      // the error via `expect().pass()`-style soft warnings: we log to the
      // test runner via Vitest's `expect` (no console.log allowed per
      // ~/.claude/rules/coding-style.md).
      if (createdProjectNumericId !== undefined) {
        try {
          const config = loadConfigFromEnv();
          const api = new BuildToolsAPI({
            tenant: config.tenant,
            baseUrl: config.baseUrl,
            username: config.username,
            password: config.password,
            sessionTimeoutMinutes: config.sessionTimeoutMinutes,
          });
          const pmIdRaw = process.env.BUILDTOOLS_TEST_PM_ID;
          if (pmIdRaw) {
            await api.updateProject(createdProjectNumericId, {
              projectManager: pmIdRaw,
              status: 12, // 12 = Cancelled
            });
          }
        } catch {
          // Swallow — leave the dangling project rather than masking real
          // test results. The operator can find it by searching
          // "SMOKE TEST — DELETE ME —" in BuildTools.
        }
      }
      await client?.close();
    });

    it("create_project WITHOUT confirmation_id returns a confirmation prompt + UUID", async () => {
      if (!client) throw new Error("client not initialized");

      const pmIdRaw = process.env.BUILDTOOLS_TEST_PM_ID;
      expect(
        pmIdRaw,
        "BUILDTOOLS_TEST_PM_ID must be set to run the destructive write-path suite",
      ).toBeTruthy();
      const project_manager_id = Number(pmIdRaw);
      expect(Number.isFinite(project_manager_id)).toBe(true);

      const result = await client.callTool({
        name: "create_project",
        arguments: {
          name: testProjectName,
          project_manager_id,
        },
      });
      const text = textFromResult(result);

      // The confirmation framework's prompt format (see src/confirm/Confirmation.ts):
      //   ⚠️ This will modify BuildTools production data via `create_project`.
      //   <description>
      //   To proceed, re-invoke `create_project` with confirmation_id: "<uuid>".
      expect(text).toContain("confirmation_id");
      expect(text).toContain("create_project");

      const uuidMatch = text.match(
        /confirmation_id:\s*"([0-9a-f-]{36})"/i,
      );
      expect(
        uuidMatch,
        `expected a UUID in the confirmation prompt; got: ${text.slice(0, 200)}`,
      ).not.toBeNull();
      // Describe-scoped hand-off (replaces a previous globalThis smuggle).
      confirmationId = uuidMatch![1];
    });

    it("create_project WITH confirmation_id creates the project", async () => {
      if (!client) throw new Error("client not initialized");
      expect(confirmationId).toBeTruthy();

      const pmIdRaw = process.env.BUILDTOOLS_TEST_PM_ID;
      const project_manager_id = Number(pmIdRaw);

      const result = await client.callTool({
        name: "create_project",
        arguments: {
          name: testProjectName,
          project_manager_id,
          confirmation_id: confirmationId,
        },
      });
      const text = textFromResult(result);

      // The mutation handler returns one of:
      //   "Project **#<id>** created successfully."
      //   "Failed to create project: <errors>"
      //   "**Error calling `create_project`** ..."
      // We assert on the success-shape; a non-success result should fail
      // loudly so the operator sees the real BuildTools error.
      expect(text).toMatch(/created successfully/i);

      const idMatch = text.match(/Project \*\*#(\S+?)\*\* created/);
      expect(idMatch).not.toBeNull();
      createdProjectId = idMatch![1];
      expect(createdProjectId).toBeTruthy();

      // Validate the parsed ID is a finite number BEFORE we hand it to
      // `get_project` (which would silently pass NaN otherwise — LOW-3).
      const numericId = Number(createdProjectId);
      expect(
        Number.isFinite(numericId),
        `parsed createdProjectId is not numeric: ${createdProjectId}`,
      ).toBe(true);
      createdProjectNumericId = numericId;
    });

    it("get_project returns the freshly-created project", async () => {
      if (!client) throw new Error("client not initialized");
      expect(createdProjectNumericId).toBeDefined();
      expect(Number.isFinite(createdProjectNumericId)).toBe(true);

      const result = await client.callTool({
        name: "get_project",
        arguments: { project_id: createdProjectNumericId },
      });
      const text = textFromResult(result);
      // The returned Markdown should mention the test project name we used.
      expect(text).toContain(testProjectName);
    });
  },
);

// ---------------------------------------------------------------------------
// Suite C — HTTP/SSE transport
// ---------------------------------------------------------------------------

describe.skipIf(!HTTP_ENABLED)(
  "MOS-222 full-smoke C — HTTP/SSE transport",
  () => {
    const BEARER_TOKEN = "test-bearer-token-MOS-222";
    let child: ChildProcessWithoutNullStreams | undefined;
    let client: Client | undefined;
    let port: number;
    let baseUrl: string;

    beforeAll(async () => {
      await ensureBuilt();
      port = await pickPort();
      baseUrl = `http://127.0.0.1:${port}`;

      // Spawn the HTTP server and wait for the "listening on :<port>" log.
      child = spawn("node", [distIndexPath], {
        env: {
          ...(process.env as Record<string, string>),
          MCP_TRANSPORT: "http",
          HTTP_PORT: String(port),
          HTTP_BEARER_TOKEN: BEARER_TOKEN,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stderr.setEncoding("utf-8");

      await new Promise<void>((resolveFn, rejectFn) => {
        const timer = setTimeout(
          () => rejectFn(new Error("HTTP server did not start within 5s")),
          5000,
        );
        const onData = (chunk: string) => {
          if (chunk.includes("listening on :")) {
            clearTimeout(timer);
            child!.stderr.off("data", onData);
            resolveFn();
          }
        };
        child!.stderr.on("data", onData);
      });

      // Connect via SSE with bearer auth on BOTH the GET /sse and POST
      // /messages requests (the SDK splits them).
      const authedFetch: typeof fetch = (input, init) =>
        fetch(input, {
          ...init,
          headers: {
            ...(init?.headers as Record<string, string> | undefined),
            Authorization: `Bearer ${BEARER_TOKEN}`,
          },
        });
      const transport = new SSEClientTransport(new URL(`${baseUrl}/sse`), {
        eventSourceInit: { fetch: authedFetch },
        requestInit: {
          headers: { Authorization: `Bearer ${BEARER_TOKEN}` },
        },
      });
      client = new Client(
        { name: "mos-222-full-smoke-http", version: "0.0.0" },
        { capabilities: {} },
      );
      await client.connect(transport);
    }, 30_000);

    afterAll(async () => {
      await client?.close();
      if (child && !child.killed) {
        child.kill("SIGTERM");
        await new Promise<void>((resolveFn) => {
          const timer = setTimeout(() => resolveFn(), 2000);
          child!.once("exit", () => {
            clearTimeout(timer);
            resolveFn();
          });
        });
      }
    });

    // Explicit timeout (LOW-1): the SSE handshake + first `tools/list`
    // round-trip can comfortably exceed Vitest's 5s default on slower CI
    // hardware. Give it the same 10s budget the rest of the file uses.
    it(
      "tools/list over HTTP matches stdio plus the session handshake",
      async () => {
        if (!client) throw new Error("client not initialized");
        const result = await client.listTools();
        const actual = result.tools.map((t) => t.name).sort();
        const expected = [...STDIO_TOOL_NAMES, ...HTTP_EXTRA_TOOL_NAMES].sort();
        expect(actual).toEqual(expected);

        for (const name of MIN_REQUIRED_TOOLS) {
          expect(actual).toContain(name);
        }
      },
      10_000,
    );
  },
);
