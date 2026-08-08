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

import type { BuildToolsAPI } from "../../client/BuildToolsAPI.js";
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
