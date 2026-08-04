/**
 * BuildTools wire-format → neutral `WriteOutcome` classification (MOS-747).
 *
 * This is vendor knowledge and deliberately lives under `adapters/buildtools/`,
 * not in the neutral `outcomes.ts`. Everything BuildTools-shaped — the `r === 1`
 * convention, the `e`/`errors` envelope, the HTTP status quirks — is confined
 * here.
 *
 * ORDERING: PARSE FIRST, THEN CLASSIFY
 *
 * The one thing that must not be got wrong. BuildTools is Laravel/Yii, and
 * Laravel returns validation rejections as **422 with a JSON body**. A
 * status-first gate ("any non-2xx is ambiguous") would turn every cleanly
 * refused create into an ambiguous one, sending it through a pointless
 * reconcile and — in Cambium's actuator — on to a `needs_human` escalation.
 * Cambium's own adapter documents this explicitly and parses first
 * (`cambium/src/integrations/construction-pm/adapters/buildtools/session.ts:261-265`).
 *
 * So the status is consulted ONLY for the classes where it is authoritative and
 * a body cannot be trusted to describe what happened:
 *
 *   3xx — `post()` sets `followRedirects: false`, so a POST-redirect-GET
 *         success surfaces as a bare 302 with no envelope. Unknowable.
 *   5xx — the server may have applied the write before failing.
 *   401 — an auth-layer rejection carries no save envelope. Cambium assumes
 *         Laravel's auth middleware rejects before the controller mutates, but
 *         flags that as UNVERIFIED against the live server; we take the
 *         conservative reading and call it ambiguous rather than failed.
 *
 * Everything else — including 4xx — is parsed, and the envelope decides.
 */

import { BuildToolsNetworkError } from "../../../client/errors.js";
import {
  ambiguous,
  failed,
  ok,
  type ReconcileProbe,
  type RejectionDetail,
  type WriteAmbiguous,
  type WriteOutcome,
} from "../../outcomes.js";

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/**
 * A write response with the HTTP status PRESERVED.
 *
 * `BuildToolsAPI.post()` parses the body and throws the status away whenever
 * parsing succeeds (`BuildToolsAPI.ts:866-870`), which is what makes a
 * JSON-bodied 500 indistinguishable from a business rejection. Writes must
 * therefore surface this shape rather than `post()`'s return value — see
 * `postRaw()` in the adapter.
 */
export interface RawWriteResponse {
  status: number;
  /** Raw body, for parse diagnostics. NEVER copied into an outcome. */
  body: string;
  /** Parsed body, or `undefined` when it did not parse as JSON. */
  json?: unknown;
}

/** How a caller reads success and rejection out of a parsed envelope. */
export interface ClassifySpec<T> {
  /**
   * Does this envelope represent a structured success?
   *
   * Split from extraction deliberately. An earlier design returned
   * `T | undefined` and treated `undefined` as "not a success" — which
   * misclassifies a landed write whose id field happens to be absent
   * (`createProject` propagates `result.projectId` unchecked, and it can be
   * missing), and makes `ok` unreachable for `void` writes like deletes.
   */
  isSuccess: (payload: Record<string, unknown>) => boolean;
  /** Pull the success value out. Only called when `isSuccess` returned true. */
  extract: (payload: Record<string, unknown>) => T;
  /**
   * Return structured rejection detail when upstream explicitly refused,
   * otherwise `undefined`.
   *
   * `undefined` means "no verdict either way", which classifies as AMBIGUOUS —
   * not as failure. Only return a value when upstream actually said no.
   */
  readRejection?: (
    payload: Record<string, unknown>,
  ) => RejectionDetail | undefined;
  /** Reconcile handle propagated onto any ambiguous outcome. */
  probe?: ReconcileProbe;
}

// ---------------------------------------------------------------------------
// Rejection reading
// ---------------------------------------------------------------------------

/**
 * Default rejection reader for BuildTools' save endpoints, which signal refusal
 * with an `e` or `errors` envelope.
 *
 * `message` is deliberately NOT accepted as proof of rejection. It is polysemous
 * upstream: at least six write endpoints return it alongside SUCCESS —
 * `createChangeOrder` (`BuildToolsAPI.ts:2665`), `createTask` (`:4104`),
 * `createRFI` (`:4167`), `createInvoice` (`:4253`), `createFinancialStatement`
 * (`:4324`), `createService` (`:4616`) — and those endpoints signal success with
 * `result === "success"`, not `r === 1`. If an adapter wiring supplied an
 * `isSuccess` that missed the right discriminator, reading their success-time
 * `message` as a rejection would report a landed write as `failed`: the exact
 * bug this module exists to prevent, hidden inside its own safety net. Requiring
 * a real error envelope makes that failure mode ambiguous instead.
 *
 * A bare non-1 result code with no error envelope is likewise AMBIGUOUS, not
 * failed — we have not verified that `{r:0}` is always a pre-mutation refusal,
 * and guessing "failed" is the expensive direction to be wrong in.
 */
export function readBuildToolsRejection(
  payload: Record<string, unknown>,
): RejectionDetail | undefined {
  return narrowRejection(payload.e ?? payload.errors);
}

/**
 * Coerce an arbitrary upstream error field into the bounded `RejectionDetail`
 * shape, dropping anything that does not fit.
 *
 * Dropping is the right default: an unrecognised shape is exactly the case
 * where blindly forwarding could carry unrelated records across the gateway.
 * The outcome still reports `failed` — only the verbose detail is elided.
 */
function narrowRejection(value: unknown): RejectionDetail | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (Array.isArray(value)) {
    const strings = value.filter((v): v is string => typeof v === "string");
    return strings.length > 0 ? strings : undefined;
  }
  if (typeof value === "object" && value !== null) {
    const msg = (value as { message?: unknown }).message;
    if (typeof msg === "string") return { message: msg };
    // Laravel's default ValidationException envelope keys field names to arrays
    // of messages: `{"errors": {"name": ["Name is required"], ...}}`. Flatten it
    // rather than dropping — this is plausibly the most common rejection shape,
    // and dropping it would classify a clean 422 refusal as ambiguous, defeating
    // the parse-first ordering above.
    const flattened = flattenFieldErrors(value as Record<string, unknown>);
    if (flattened.length > 0) return flattened;
  }
  return undefined;
}

/** Flatten `{field: ["msg", ...], ...}` into a flat list of messages. */
function flattenFieldErrors(value: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [field, messages] of Object.entries(value)) {
    if (typeof messages === "string") {
      out.push(`${field}: ${messages}`);
    } else if (Array.isArray(messages)) {
      for (const m of messages) {
        if (typeof m === "string") out.push(`${field}: ${m}`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export function classifyWriteResponse<T>(
  res: RawWriteResponse,
  spec: ClassifySpec<T>,
): WriteOutcome<T> {
  // --- status classes where the body cannot be trusted -------------------
  if (res.status >= 300 && res.status < 400) {
    return ambiguous(
      `upstream returned HTTP ${res.status} with no save envelope (redirects are not followed on writes); the write may or may not have been applied`,
      spec.probe,
    );
  }
  if (res.status >= 500) {
    return ambiguous(
      `upstream returned HTTP ${res.status}; the write may or may not have been applied`,
      spec.probe,
    );
  }
  if (res.status === 401) {
    return ambiguous(
      "upstream rejected the request as unauthorized; whether the write was applied before the auth layer intervened is unverified",
      spec.probe,
    );
  }

  // --- otherwise the envelope decides, 4xx included ----------------------
  if (res.json === undefined || res.json === null) {
    return ambiguous(
      `upstream response was not parseable JSON (BuildTools template drift, status ${res.status}); the write may or may not have been applied`,
      spec.probe,
    );
  }
  if (typeof res.json !== "object") {
    return ambiguous(
      `upstream returned a non-object body (${typeof res.json}); the write may or may not have been applied`,
      spec.probe,
    );
  }

  const payload = res.json as Record<string, unknown>;

  if (spec.isSuccess(payload)) return ok(spec.extract(payload));

  const rejection = (spec.readRejection ?? readBuildToolsRejection)(payload);
  if (rejection !== undefined) {
    return failed(describeRejection(rejection), rejection);
  }

  return ambiguous(
    `upstream returned no recognisable success or rejection envelope (status ${res.status}); the write may or may not have been applied`,
    spec.probe,
  );
}

/**
 * Classify a thrown error from a write.
 *
 * `dispatched` is the deciding input, not the error class. The client's throw
 * surface is wider than any whitelist can track: `request()` wraps only the
 * `fetch()` call, so a mid-body socket reset escapes as a raw undici
 * `TypeError` with headers already received; `uploadFile` bypasses `request()`
 * entirely; and post-upload readback failures throw `BuildToolsServerError`
 * *after* the file was accepted. Classifying by phase covers all of those:
 * anything thrown after the request went out is ambiguous.
 *
 * Guard failures raised BEFORE dispatch (e.g. "projectId is required") are
 * proof of non-landing and return `failed`.
 */
export function classifyWriteError(
  err: unknown,
  opts: { dispatched: boolean; probe?: ReconcileProbe },
): WriteOutcome<never> {
  if (!opts.dispatched) {
    return failed(errorMessage(err));
  }
  return ambiguousFromError(err, opts.probe);
}

/** Ambiguity for a definitely-dispatched write. */
export function ambiguousFromError(
  err: unknown,
  probe?: ReconcileProbe,
): WriteAmbiguous {
  const detail =
    err instanceof BuildToolsNetworkError
      ? `network failure during write (${err.message})`
      : `write failed after dispatch (${errorMessage(err)})`;
  return ambiguous(
    `${detail}; the write may or may not have been applied`,
    probe,
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function describeRejection(detail: RejectionDetail): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.join("; ");
  return detail.message;
}
