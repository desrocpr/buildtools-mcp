/**
 * Tests for BuildTools → WriteOutcome classification (MOS-747).
 *
 * The property under test: a write whose result we could not read must NEVER be
 * reported as a clean failure, because callers retry on `failed` and retrying a
 * write that actually landed creates a duplicate. Equally, a write upstream
 * cleanly REFUSED must not be reported as ambiguous, or every validation error
 * drags a caller through a pointless reconcile.
 */

import { describe, expect, it } from "vitest";

import { BuildToolsNetworkError } from "../../../../client/errors.js";
import {
  classifyWriteError,
  classifyWriteResponse,
  type ClassifySpec,
  type RawWriteResponse,
} from "../classify.js";

/** The BuildTools save-endpoint convention: `r === 1` means it landed. */
const btSpec: ClassifySpec<{ id: unknown }> = {
  isSuccess: (p) => p.r === 1,
  extract: (p) => ({ id: p.projectId }),
  probe: { kind: "marker", marker: "cambium:t1:p1" },
};

function response(status: number, body: string): RawWriteResponse {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    json = undefined;
  }
  return { status, body, json };
}

describe("classifyWriteResponse — the envelope decides", () => {
  it("reports a structured success as ok and surfaces the created id", () => {
    const outcome = classifyWriteResponse(
      response(200, JSON.stringify({ r: 1, projectId: 4821 })),
      btSpec,
    );

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.data).toEqual({ id: 4821 });
  });

  it("still reports ok when the success envelope omits the id", () => {
    // createProject propagates `result.projectId` unchecked and it can be
    // absent. An earlier design used `T | undefined` as the not-a-success
    // sentinel, which misread a landed write as ambiguous.
    const outcome = classifyWriteResponse(
      response(200, JSON.stringify({ r: 1 })),
      btSpec,
    );

    expect(outcome.status).toBe("ok");
  });

  it("reports a 422 validation rejection as failed, NOT ambiguous", () => {
    // The regression that matters most. BuildTools is Laravel; it returns
    // validation rejections as 422 WITH a JSON envelope. A status-first gate
    // would call this ambiguous and send a cleanly-refused create through a
    // reconcile and on to a needs_human escalation in Cambium's actuator.
    const outcome = classifyWriteResponse(
      response(422, JSON.stringify({ r: 0, errors: ["Name is required"] })),
      btSpec,
    );

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("expected failed");
    expect(outcome.reason).toBe("Name is required");
  });

  it("reports a 200 rejection envelope as failed", () => {
    const outcome = classifyWriteResponse(
      response(200, JSON.stringify({ r: 0, e: "Name has already been taken" })),
      btSpec,
    );

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("expected failed");
    expect(outcome.details).toBe("Name has already been taken");
  });
});

describe("classifyWriteResponse — status classes the body cannot explain", () => {
  it("treats a JSON-bodied 500 as ambiguous", () => {
    // A 500 can be raised after the row was written.
    const outcome = classifyWriteResponse(
      response(500, JSON.stringify({ error: "Internal Server Error" })),
      btSpec,
    );

    expect(outcome.status).toBe("ambiguous");
  });

  it("treats a bare redirect as ambiguous", () => {
    // Writes are issued with followRedirects: false, so a POST-redirect-GET
    // success arrives as a bare 302 with no envelope at all.
    expect(classifyWriteResponse(response(302, ""), btSpec).status).toBe(
      "ambiguous",
    );
  });

  it("treats a 401 as ambiguous rather than failed", () => {
    // Whether Laravel's auth middleware rejects before the controller mutates
    // is explicitly unverified; the conservative reading wins.
    expect(classifyWriteResponse(response(401, "{}"), btSpec).status).toBe(
      "ambiguous",
    );
  });

  it("treats a drifted, unparseable 200 as ambiguous", () => {
    const outcome = classifyWriteResponse(
      response(200, "<html><body>Unexpected template</body></html>"),
      btSpec,
    );

    expect(outcome.status).toBe("ambiguous");
    if (outcome.status !== "ambiguous") throw new Error("expected ambiguous");
    expect(outcome.reason).toMatch(/drift/i);
  });

  it("treats a bare non-1 code with no error envelope as ambiguous", () => {
    // We have not verified that a bare {r:0} is always a pre-mutation refusal,
    // and guessing `failed` is the expensive direction to be wrong in.
    expect(
      classifyWriteResponse(response(200, JSON.stringify({ r: 0 })), btSpec)
        .status,
    ).toBe("ambiguous");
  });

  it("propagates the reconcile probe onto every ambiguous outcome", () => {
    for (const res of [
      response(500, "{}"),
      response(302, ""),
      response(200, "not json"),
      response(200, JSON.stringify({})),
    ]) {
      const outcome = classifyWriteResponse(res, btSpec);
      if (outcome.status !== "ambiguous") throw new Error("expected ambiguous");
      expect(outcome.probe).toEqual(btSpec.probe);
    }
  });
});

describe("classifyWriteError — phase decides, not error class", () => {
  it("reports a pre-dispatch guard failure as failed", () => {
    // "projectId is required" fires before anything goes out: proof of
    // non-landing, so a reconcile would be wasted work.
    const outcome = classifyWriteError(new Error("projectId is required"), {
      dispatched: false,
    });

    expect(outcome.status).toBe("failed");
  });

  it("reports a network failure after dispatch as ambiguous", () => {
    const outcome = classifyWriteError(
      new BuildToolsNetworkError("socket hang up"),
      { dispatched: true, probe: { kind: "marker", marker: "m1" } },
    );

    expect(outcome.status).toBe("ambiguous");
    if (outcome.status !== "ambiguous") throw new Error("expected ambiguous");
    expect(outcome.probe).toEqual({ kind: "marker", marker: "m1" });
  });

  it("reports a raw TypeError after dispatch as ambiguous", () => {
    // request() wraps only the fetch() call — `await response.text()` sits
    // outside the try, so a mid-body socket reset escapes as an undici
    // TypeError with headers already received and the write very likely applied.
    const outcome = classifyWriteError(new TypeError("terminated"), {
      dispatched: true,
    });

    expect(outcome.status).toBe("ambiguous");
  });
});

describe("egress safety", () => {
  it("redacts presigned-URL query strings out of the reason", () => {
    const presigned =
      "https://moss-bt.s3.amazonaws.com/doc.pdf?X-Amz-Signature=deadbeefcafe";

    const outcome = classifyWriteError(
      new BuildToolsNetworkError(`Network error downloading ${presigned}: reset`),
      { dispatched: true },
    );

    expect(outcome.status).toBe("ambiguous");
    if (outcome.status !== "ambiguous") throw new Error("expected ambiguous");
    expect(outcome.reason).not.toContain("deadbeefcafe");
  });

  it("never copies the raw response body into the outcome", () => {
    // `body` is the field most likely to hold a full drifted HTML page, which
    // can reflect submitted values or session-bearing markup.
    const secretish = "SESSIONID=abc123-do-not-leak";
    const outcome = classifyWriteResponse(
      { status: 200, body: `<input value="${secretish}">`, json: undefined },
      btSpec,
    );

    expect(JSON.stringify(outcome)).not.toContain(secretish);
  });

  it("drops rejection detail whose shape is not recognised", () => {
    // A payload echoing unrelated records must not ride along in `details`.
    const outcome = classifyWriteResponse(
      response(
        422,
        JSON.stringify({
          r: 0,
          errors: { otherClient: { name: "Jane Roe", balance: 91234 } },
        }),
      ),
      btSpec,
    );

    expect(JSON.stringify(outcome)).not.toContain("Jane Roe");
    expect(JSON.stringify(outcome)).not.toContain("91234");
  });

  it("never reads a success-time `message` as a rejection", () => {
    // `message` is polysemous upstream: createChangeOrder / createTask /
    // createRFI / createInvoice / createFinancialStatement / createService all
    // return it ALONGSIDE success, and signal success with `result === "success"`
    // rather than `r === 1`. A wiring whose isSuccess misses that discriminator
    // must degrade to ambiguous, never to a false `failed` for a landed write.
    const mismatched: ClassifySpec<{ id: unknown }> = {
      isSuccess: (p) => p.r === 1, // wrong discriminator for this endpoint
      extract: (p) => ({ id: p.id }),
    };

    const outcome = classifyWriteResponse(
      response(
        200,
        JSON.stringify({
          result: "success",
          id: 5150,
          message: "Change order created",
        }),
      ),
      mismatched,
    );

    expect(outcome.status).not.toBe("failed");
    expect(outcome.status).toBe("ambiguous");
  });

  it("flattens Laravel's nested field-error envelope into a failure", () => {
    // {"message": "...", "errors": {"field": ["msg"]}} is Laravel's default
    // ValidationException shape. Dropping it would classify a clean 422 refusal
    // as ambiguous and defeat the parse-first ordering.
    const outcome = classifyWriteResponse(
      response(
        422,
        JSON.stringify({
          message: "The given data was invalid.",
          errors: { name: ["Name is required"], zip: ["Zip is invalid"] },
        }),
      ),
      btSpec,
    );

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("expected failed");
    expect(outcome.details).toEqual([
      "name: Name is required",
      "zip: Zip is invalid",
    ]);
  });

  it("keeps recognised rejection detail shapes", () => {
    const asArray = classifyWriteResponse(
      response(422, JSON.stringify({ errors: ["Name required", "Zip invalid"] })),
      btSpec,
    );
    if (asArray.status !== "failed") throw new Error("expected failed");
    expect(asArray.details).toEqual(["Name required", "Zip invalid"]);
    expect(asArray.reason).toBe("Name required; Zip invalid");

    const asMessage = classifyWriteResponse(
      response(422, JSON.stringify({ e: { message: "Duplicate number" } })),
      btSpec,
    );
    if (asMessage.status !== "failed") throw new Error("expected failed");
    expect(asMessage.details).toEqual({ message: "Duplicate number" });
  });
});

describe("the raw body never reaches the outcome", () => {
  // `RawWriteResponse.body` is documented "NEVER copied into an outcome", and
  // until now that was enforced by the comment alone. A BuildTools 500 is a
  // Laravel debug page: it carries absolute filesystem paths, framework
  // internals, and sometimes the request URL with its query string. Outcomes
  // are rendered to users and cross the gateway, so a body that leaks into
  // `reason` or `details` leaks all of that with it.
  const LEAKY_BODY =
    "<html><b>Fatal error</b> in /var/www/buildtools/app/Http/Controllers/" +
    "ProjectController.php:214 — session=abcd1234 — " +
    "https://moss.buildtools.app/projects/save?_token=SECRETVALUE</html>";

  const SPEC = {
    isSuccess: (p: Record<string, unknown>) => p.r === 1,
    extract: (p: Record<string, unknown>) => p.projectId,
  };

  function serialise(outcome: unknown): string {
    return JSON.stringify(outcome);
  }

  it.each([
    ["a drifted body that does not parse", { status: 200, body: LEAKY_BODY }],
    ["a 500 debug page", { status: 500, body: LEAKY_BODY }],
    ["a 302 with a body", { status: 302, body: LEAKY_BODY }],
    ["a 401 with a body", { status: 401, body: LEAKY_BODY }],
  ])("keeps the body out of the outcome for %s", (_label, res) => {
    const text = serialise(classifyWriteResponse(res, SPEC));

    expect(text).not.toContain("ProjectController.php");
    expect(text).not.toContain("SECRETVALUE");
    expect(text).not.toContain("session=abcd1234");
  });

  it("keeps a parsed-but-unrecognised envelope out of the outcome too", () => {
    // The envelope parsed, so `body` is not the only carrier — the PAYLOAD can
    // be just as leaky, and this is the branch that reports "no recognisable
    // success or rejection envelope".
    const text = serialise(
      classifyWriteResponse(
        {
          status: 200,
          body: "{}",
          json: { trace: "/var/www/app/Foo.php", token: "SECRETVALUE" },
        },
        SPEC,
      ),
    );

    expect(text).not.toContain("SECRETVALUE");
    expect(text).not.toContain("/var/www");
  });

  it("still forwards a genuine rejection message, which is the point of the distinction", () => {
    // The guard above must not be satisfied by suppressing everything —
    // upstream's own validation text is what makes `failed` actionable.
    const outcome = classifyWriteResponse(
      { status: 422, body: "{}", json: { e: { name: ["Name is required"] } } },
      SPEC,
    );

    expect(outcome.status).toBe("failed");
    expect(serialise(outcome)).toContain("Name is required");
  });
});
