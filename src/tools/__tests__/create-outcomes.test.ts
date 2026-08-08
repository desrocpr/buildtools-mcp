/**
 * The two highest-consequence creates, end to end (MOS-747 Phase 5, slice 1).
 *
 * `create_project` and `create_change_order` had NO execute-path test before
 * this. The smoke test asserted they were registered and that the first call
 * returns a confirmation prompt; nothing exercised what happens after the user
 * confirms. That is why retargeting both onto the neutral write surface broke
 * no test — there was nothing to break.
 *
 * These drive the whole chain the way production does: tool handler →
 * confirmation handshake → operations adapter → classifier → rendered Markdown.
 * The upstream is faked at the ONE seam that matters, `create*Raw`, so the
 * classifier is real and its verdicts are what the assertions see.
 *
 * The ambiguous cases are the reason this file exists. A refusal and a timeout
 * used to render identically ("Failed to create..."), and the obvious next move
 * — retry — creates a duplicate in the second case but not the first.
 */

import { describe, expect, it } from "vitest";

import { BuildToolsAPI } from "../../client/BuildToolsAPI.js";
import type { RawWriteAttempt } from "../../client/types.js";
import { BuildToolsNetworkError } from "../../client/errors.js";
import { ConfirmationStore } from "../../confirm/index.js";
import { createMutationTools } from "../mutations.js";
import type { ToolDefinition, ToolResult } from "../projects.js";

function textOf(result: ToolResult): string {
  return result.content.map((c) => ("text" in c ? c.text : "")).join("");
}

interface Upstream {
  createProjectRaw?: () => Promise<RawWriteAttempt>;
  createChangeOrderRaw?: () => Promise<RawWriteAttempt>;
  createInvoiceRaw?: () => Promise<RawWriteAttempt>;
  createFinancialStatementWithAmountRaw?: () => Promise<RawWriteAttempt>;
}

function toolFor(name: string, upstream: Upstream): ToolDefinition {
  const api = upstream as unknown as BuildToolsAPI;
  const tool = createMutationTools(() => api, new ConfirmationStore()).find(
    (t) => t.name === name,
  );
  if (!tool) throw new Error(`${name} not registered`);
  return tool;
}

/** Run the two-step handshake and return the executed result. */
async function execute(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const api = {} as unknown as BuildToolsAPI;
  const prompt = await tool.handler(args, api);
  const id = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)?.[1];
  if (!id) throw new Error(`no confirmation_id in prompt: ${textOf(prompt)}`);
  return tool.handler({ ...args, confirmation_id: id }, api);
}

const PROJECT_ARGS = { name: "Katchmark Kitchen", project_manager_id: 42 };
const CO_ARGS = { name: "Extra tile", project_id: 100, total: 1500 };

const dispatched = (
  status: number,
  body: string,
  json?: unknown,
): RawWriteAttempt =>
  json === undefined
    ? { dispatched: true, status, body }
    : { dispatched: true, status, body, json };

/**
 * Wrap an upstream stub with a call counter.
 *
 * Not ceremony. An upstream that is never reached at all throws a TypeError
 * inside the adapter, which classifies as — correctly — ambiguous. So every
 * "this is ambiguous" assertion below would pass just as happily against a
 * stub that was never called, i.e. against nothing. Counting the call is what
 * separates "the classifier decided this" from "the harness misfired".
 */
function counted(fn: () => RawWriteAttempt): {
  impl: () => Promise<RawWriteAttempt>;
  calls: () => number;
} {
  let n = 0;
  return {
    impl: async () => {
      n += 1;
      return fn();
    },
    calls: () => n,
  };
}

describe("create_project — outcome rendering", () => {
  it("reports the new id on a structured success", async () => {
    const tool = toolFor("create_project", {
      createProjectRaw: async () =>
        dispatched(200, "{}", { r: 1, projectId: 3312 }),
    });

    const text = textOf(await execute(tool, PROJECT_ARGS));

    expect(text).toContain("#3312");
    expect(text).toContain("created successfully");
  });

  it("still reports success when the response omits the id", async () => {
    // A landed write whose response does not name the record. Downgrading this
    // to a failure would send the caller back to create a second project.
    const tool = toolFor("create_project", {
      createProjectRaw: async () => dispatched(200, "{}", { r: 1 }),
    });

    const result = await execute(tool, PROJECT_ARGS);

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("created successfully");
  });

  it("reports a validation refusal as a plain failure", async () => {
    const tool = toolFor("create_project", {
      createProjectRaw: async () =>
        dispatched(422, "{}", { e: { name: ["Name is required"] } }),
    });

    const result = await execute(tool, PROJECT_ARGS);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Name is required");
    // A clean refusal must NOT tell the caller to go reconcile — that is the
    // ambiguous advice, and giving it here would train callers to ignore it.
    expect(textOf(result)).not.toContain("do NOT retry");
  });

  it.each([
    ["a 500", () => dispatched(500, '{"error":"boom"}', { error: "boom" })],
    ["a drifted body", () => dispatched(200, "<html>maintenance</html>")],
    ["a redirect", () => dispatched(302, "")],
    [
      "a network failure",
      () => {
        throw new BuildToolsNetworkError("socket hang up");
      },
    ],
  ])("refuses to call %s a failure, and says how to check", async (_l, make) => {
    const upstream = counted(() => make() as RawWriteAttempt);
    const tool = toolFor("create_project", { createProjectRaw: upstream.impl });

    const text = textOf(await execute(tool, PROJECT_ARGS));

    expect(upstream.calls()).toBe(1);
    expect(text).toContain("Outcome unknown");
    expect(text).toContain("do NOT retry");
    // The probe is what makes this actionable rather than merely alarming.
    expect(text).toContain("Katchmark Kitchen");
  });
});

describe("create_change_order — outcome rendering", () => {
  it("reads the change-order success discriminator, which is not r:1", async () => {
    // Change orders answer `result: "success"`. Reading `r === 1` here would
    // report every landed change order as a failure.
    const tool = toolFor("create_change_order", {
      createChangeOrderRaw: async () =>
        dispatched(200, "{}", { result: "success", id: 88, message: "Saved" }),
    });

    const text = textOf(await execute(tool, CO_ARGS));

    expect(text).toContain("#88");
    expect(text).toContain("Saved");
  });

  it("does not read a success-time message as a rejection", async () => {
    // Six BuildTools write endpoints return `message` alongside SUCCESS. If it
    // were treated as an error envelope, a landed change order would render as
    // failed — the exact bug the classifier is built to avoid.
    const tool = toolFor("create_change_order", {
      createChangeOrderRaw: async () =>
        dispatched(200, "{}", { result: "success", id: 5, message: "Created" }),
    });

    expect((await execute(tool, CO_ARGS)).isError).toBeUndefined();
  });

  it("treats an unrecognised envelope as ambiguous, not failed", async () => {
    // No success marker and no error envelope: upstream said nothing we can
    // read. Guessing "failed" is the expensive direction to be wrong in.
    const upstream = counted(() => dispatched(200, "{}", { r: 0 }));
    const tool = toolFor("create_change_order", {
      createChangeOrderRaw: upstream.impl,
    });

    const text = textOf(await execute(tool, CO_ARGS));

    expect(upstream.calls()).toBe(1);
    expect(text).toContain("Outcome unknown");
    expect(text).toContain("Extra tile");
  });

  it("reports a pre-dispatch guard failure as a definite failure", async () => {
    // Nothing went to the wire, so there is nothing to reconcile and the
    // caller can safely fix the input and try again.
    const tool = toolFor("create_change_order", {
      createChangeOrderRaw: async () => ({
        dispatched: false,
        reason: "projectId is required",
      }),
    });

    const text = textOf(await execute(tool, CO_ARGS));

    expect(text).toContain("projectId is required");
    expect(text).not.toContain("do NOT retry");
  });
});

describe("an unestablished session is a definite failure, not an unknown", () => {
  it("drives a real client auth failure through to a clean failure", async () => {
    // Deliberately NOT a stub returning {dispatched:false}: that shape is easy
    // to assert and proves only that the renderer handles it. This drives the
    // REAL client with no credentials, so the pre-dispatch seam has to produce
    // the shape itself. Before that seam existed, this rendered "may or may
    // not have been created — go and check" for a write that was never sent.
    const recorded: unknown[] = [];
    const api = new BuildToolsAPI({
      fetch: (async (url: string) => {
        recorded.push(url);
        throw new Error("fetch should not be reached");
      }) as unknown as typeof fetch,
    });
    const tool = createMutationTools(
      () => api,
      new ConfirmationStore(),
    ).find((t) => t.name === "create_project")!;

    const prompt = await tool.handler(PROJECT_ARGS, api);
    const id = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    const text = textOf(
      await tool.handler({ ...PROJECT_ARGS, confirmation_id: id }, api),
    );

    expect(text).toContain("Failed to create project");
    expect(text).not.toContain("Outcome unknown");
    expect(recorded).toHaveLength(0);
  });
});

describe("the harness itself", () => {
  it("renders ambiguous when upstream is absent — which is why the counters exist", async () => {
    // Pinning the trap rather than describing it. An upstream stub that is
    // never wired throws inside the adapter and classifies as ambiguous, so
    // every ambiguity assertion in this file would pass against a harness that
    // called nothing at all. If this behaviour ever changes, the counters
    // become redundant and this test says so.
    const tool = toolFor("create_project", {});

    expect(textOf(await execute(tool, PROJECT_ARGS))).toContain(
      "Outcome unknown",
    );
  });
});

describe("upstream diagnostics never reach the user", () => {
  it("keeps a Laravel debug page out of the rendered result", async () => {
    // The legacy financial-statement path renders 300 characters of raw body
    // into its error text. Nothing on the neutral path does.
    const LEAKY =
      "<html>Fatal error in /var/www/buildtools/app/Http/Controllers/" +
      "ProjectController.php:214 token=SECRETVALUE</html>";
    const upstream = counted(() => dispatched(500, LEAKY));
    const tool = toolFor("create_project", { createProjectRaw: upstream.impl });

    const text = textOf(await execute(tool, PROJECT_ARGS));

    expect(upstream.calls()).toBe(1);
    expect(text).not.toContain("SECRETVALUE");
    expect(text).not.toContain("ProjectController.php");
    expect(text).toContain("Outcome unknown");
  });
});

describe("create_invoice — outcome rendering", () => {
  const INVOICE_ARGS = {
    company_id: 977,
    number: "INV-2026-014",
    date: "01/02/2026",
    due_date: "02/01/2026",
  };

  it("reports the new id on success", async () => {
    const tool = toolFor("create_invoice", {
      createInvoiceRaw: async () =>
        dispatched(200, "{}", { result: "success", id: 4120 }),
    });

    expect(textOf(await execute(tool, INVOICE_ARGS))).toContain("#4120");
  });

  it("names the vendor's invoice number in the reconcile probe", async () => {
    // Not our name for the record — the number is the natural key a human
    // searches on, and what a duplicate would collide on.
    const tool = toolFor("create_invoice", {
      createInvoiceRaw: async () => dispatched(500, ""),
    });

    const text = textOf(await execute(tool, INVOICE_ARGS));

    expect(text).toContain("Outcome unknown");
    expect(text).toContain("INV-2026-014");
  });
});

describe("create_financial_statement — outcome rendering", () => {
  const FS_ARGS = { project_id: 100002, name: "Q1 Draw", amount: 40000 };

  it("reports success with the amount that was asked for", async () => {
    const tool = toolFor("create_financial_statement", {
      createFinancialStatementWithAmountRaw: async () =>
        dispatched(200, "{}", { result: "success", id: 700500 }),
    });

    const text = textOf(await execute(tool, FS_ARGS));

    expect(text).toContain("#700500");
    expect(text).toContain("$40000.00");
  });

  it("calls a pre-dispatch form failure a definite failure, not an unknown", async () => {
    // The form GET failed, so the save POST was never built. Nothing to
    // reconcile — and this is the single most common failure on this endpoint,
    // because it depends on scraping a token out of an HTML page.
    const tool = toolFor("create_financial_statement", {
      createFinancialStatementWithAmountRaw: async () => ({
        dispatched: false,
        reason: "Form load failed: HTTP 500",
      }),
    });

    const text = textOf(await execute(tool, FS_ARGS));

    expect(text).toContain("Form load failed");
    expect(text).not.toContain("Outcome unknown");
  });

  it("calls a failed SAVE an unknown, even though the same endpoint produced it", async () => {
    // The distinction the whole slice rests on. Same tool, same endpoint: a
    // form that would not load cannot have created anything; a save that
    // returned 500 may well have.
    const tool = toolFor("create_financial_statement", {
      createFinancialStatementWithAmountRaw: async () => dispatched(500, ""),
    });

    const text = textOf(await execute(tool, FS_ARGS));

    expect(text).toContain("Outcome unknown");
    expect(text).toContain("Q1 Draw");
  });
});

describe("an ambiguous draw request is cached, so a retry does not re-fire it", () => {
  // The property PR #114 built the outcome-aware cache gate for, finally with
  // a caller. `create_draw_request` is money, carries an idempotency_key, and
  // is driven by a model that retries errors — so this is the exact path where
  // "failures stay uncached" produced the duplicate it was meant to prevent.
  const PROJECT_ROW = { id: 100002, name: "Jones Addition" };
  const PRIOR_FS = { statusCount: {}, statements: [] };

  async function drawTool(raw: () => Promise<RawWriteAttempt>) {
    const calls = { n: 0 };
    const api = {
      getProject: async () => PROJECT_ROW,
      getFinancialStatements: async () => PRIOR_FS,
      createFinancialStatementWithAmountRaw: async () => {
        calls.n += 1;
        return raw();
      },
    } as unknown as BuildToolsAPI;
    const { IdempotencyStore } = await import("../../idempotency/index.js");
    const tool = createMutationTools(
      () => api,
      new ConfirmationStore(),
      undefined,
      new IdempotencyStore(),
    ).find((t) => t.name === "create_draw_request")!;
    return { tool, api, calls };
  }

  async function runOnce(
    tool: ToolDefinition,
    api: BuildToolsAPI,
    args: Record<string, unknown>,
  ) {
    const prompt = await tool.handler(args, api);
    const cid = textOf(prompt).match(/confirmation_id:\s*"([^"]+)"/)![1];
    return tool.handler({ ...args, confirmation_id: cid }, api);
  }

  const ARGS = {
    project_id: 100002,
    amount: 40000,
    idempotency_key: "draw-ambiguous-retry",
  };

  it("replays the ambiguous result instead of creating a second draw", async () => {
    const { tool, api, calls } = await drawTool(async () =>
      dispatched(500, "<html>gateway timeout</html>"),
    );

    const first = await runOnce(tool, api, ARGS);
    expect(textOf(first)).toContain("Outcome unknown");
    expect(calls.n).toBe(1);

    // The retry a model makes after being told the write failed.
    const retry = await tool.handler(ARGS, api);

    expect(textOf(retry)).toContain("Idempotency replay");
    expect(calls.n).toBe(1); // NOT 2 — this is the duplicate that used to happen
  });

  it("still lets a definite failure through to a fresh attempt", async () => {
    // The other half. A write that provably did not land must not be cached,
    // or a fixed input could never be resubmitted under the same key.
    const { tool, api, calls } = await drawTool(async () =>
      dispatched(422, "{}", { e: "Amount exceeds contract" }),
    );

    await runOnce(tool, api, ARGS);
    expect(calls.n).toBe(1);

    await runOnce(tool, api, ARGS);
    expect(calls.n).toBe(2);
  });
});
