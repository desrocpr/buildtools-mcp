/**
 * Tests for the write-outcome model (MOS-747).
 *
 * The property under test is the one the whole issue turns on: a write whose
 * result we could not read must NEVER be reported as a clean failure, because
 * a caller that believes "failed" will retry, and a retry of a write that
 * actually landed creates a duplicate.
 *
 * So the interesting assertions here are all of the form "this is ambiguous,
 * NOT failed". The cases are drawn from how `BuildToolsAPI.post()` actually
 * behaves: it parses the body and discards the HTTP status, and falls back to
 * a `{status, body}` object when the body does not parse.
 */

import { describe, expect, it } from "vitest";

import { BuildToolsNetworkError } from "../../client/errors.js";
import {
  classifyWriteError,
  classifyWriteResponse,
  needsReconcile,
  type RawWriteResponse,
} from "../outcomes.js";

/** The BuildTools save-endpoint convention: `r === 1` means it landed. */
const btSpec = {
  readSuccess: (p: Record<string, unknown>) =>
    p.r === 1 ? { id: p.projectId } : undefined,
  probe: "search projects for marker cambium:t1:p1",
};

/** Build a raw response the way `post()` would surface one. */
function response(
  status: number,
  body: string,
  opts: { parses?: boolean } = {},
): RawWriteResponse {
  const parses = opts.parses ?? true;
  let json: unknown;
  if (parses) {
    try {
      json = JSON.parse(body);
    } catch {
      json = undefined;
    }
  }
  return { status, body, json };
}

describe("classifyWriteResponse", () => {
  it("reports a structured success as ok and surfaces the created id", () => {
    const outcome = classifyWriteResponse(
      response(200, JSON.stringify({ r: 1, projectId: 4821 })),
      btSpec,
    );

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.data).toEqual({ id: 4821 });
  });

  it("reports a structured rejection as failed, carrying the upstream detail", () => {
    const outcome = classifyWriteResponse(
      response(200, JSON.stringify({ r: 0, e: "Name has already been taken" })),
      btSpec,
    );

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("expected failed");
    expect(outcome.reason).toBe("Name has already been taken");
    expect(outcome.details).toBe("Name has already been taken");
  });

  it("treats a JSON-bodied 500 as ambiguous, not failed", () => {
    // This is the regression that matters most. The old code path parsed this
    // body, saw `r !== 1`, and returned `{success:false}` — a clean failure
    // for a request the server may well have applied before blowing up.
    const outcome = classifyWriteResponse(
      response(500, JSON.stringify({ error: "Internal Server Error" })),
      btSpec,
    );

    expect(outcome.status).toBe("ambiguous");
    expect(needsReconcile(outcome)).toBe(true);
  });

  it("treats a drifted, unparseable 200 as ambiguous", () => {
    // BuildTools is reverse-engineered and its templates drift; when the body
    // stops being JSON we cannot tell a success page from an error page.
    const outcome = classifyWriteResponse(
      response(200, "<html><body>Unexpected template</body></html>"),
      btSpec,
    );

    expect(outcome.status).toBe("ambiguous");
    if (outcome.status !== "ambiguous") throw new Error("expected ambiguous");
    expect(outcome.reason).toMatch(/drift/i);
  });

  it("treats a parseable 200 with no success or rejection signal as ambiguous", () => {
    const outcome = classifyWriteResponse(response(200, JSON.stringify({})), btSpec);

    expect(outcome.status).toBe("ambiguous");
  });

  it("propagates the reconcile probe onto every ambiguous outcome", () => {
    // An ambiguous result is only actionable if it says how to find out.
    for (const res of [
      response(500, "{}"),
      response(200, "not json"),
      response(200, JSON.stringify({})),
    ]) {
      const outcome = classifyWriteResponse(res, btSpec);
      if (outcome.status !== "ambiguous") throw new Error("expected ambiguous");
      expect(outcome.probe).toBe(btSpec.probe);
    }
  });

  it("reads an explicit non-1 result code as a rejection even without error text", () => {
    // `r: 0` is a structured verdict from the save handler — proof it did not
    // land — so this one IS a clean failure and may be retried as-is.
    const outcome = classifyWriteResponse(
      response(200, JSON.stringify({ r: 0 })),
      btSpec,
    );

    expect(outcome.status).toBe("failed");
  });
});

describe("classifyWriteError", () => {
  it("treats a network failure as ambiguous", () => {
    const outcome = classifyWriteError(
      new BuildToolsNetworkError("socket hang up", { url: "/projects/save" }),
      "probe-hint",
    );

    expect(outcome.status).toBe("ambiguous");
    expect(outcome.probe).toBe("probe-hint");
  });

  it("treats an aborted/timed-out write as ambiguous", () => {
    const abort = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
    });

    expect(classifyWriteError(abort).status).toBe("ambiguous");
  });

  it("re-throws a non-transport error instead of laundering it into an outcome", () => {
    // A bug in our own code must surface as a bug. Converting it to
    // "ambiguous" would hide real defects behind a reconcile.
    const bug = new TypeError("cannot read properties of undefined");

    expect(() => classifyWriteError(bug)).toThrow(TypeError);
  });
});
