/**
 * BuildTools adapter for the operations-management interface (MOS-747, Phase 1).
 *
 * Owns two things the tool layer should never have known about:
 *
 * 1. **Read-path selection.** 13 tool files currently write
 *    `(api.db ?? api).getX(...)`, spreading the knowledge that a MySQL replica
 *    fast path exists across the whole codebase. That choice lives here now;
 *    callers just call `getX`.
 *
 * 2. **Id normalisation.** Every row leaving this adapter carries `id` and never
 *    carries `DT_RowId`. See `normalize.ts` for why that matters.
 *
 * Everything vendor-shaped stops at this file.
 */

import type { BuildToolsAPI } from "../../../client/BuildToolsAPI.js";
import type { RawWriteAttempt } from "../../../client/types.js";
import { normalizeEnvelope, normalizeMaybeRow } from "../../normalize.js";
import {
  failed,
  ok,
  type BulkWriteData,
  type WriteOutcome,
} from "../../outcomes.js";
import {
  classifyWriteError,
  classifyWriteResponse,
  type ClassifySpec,
} from "./classify.js";
import { toDatatableParams, type GridName } from "./query.js";
import type {
  AllowanceItem,
  BudgetCategoryRef,
  BudgetView,
  CreateChangeOrderInput,
  CreatedRecord,
  CreateFinancialStatementInput,
  CreateInvoiceInput,
  CreateProjectInput,
  CreatePurchaseOrderInput,
  CreateBudgetItemInput,
  CreateRfiInput,
  CreateServiceInput,
  CreateTaskInput,
  DeleteBudgetItemInput,
  UpdateBudgetItemInput,
  TransitionPurchaseOrdersInput,
  ListQuery,
  OperationsManagementApi,
  PurchaseOrderView,
  ScheduleView,
  SelectionDetail,
  SelectionsView,
  StatementsView,
  UnbilledChangeOrderFilters,
  UnbilledChangeOrderRow,
} from "../../types.js";

/**
 * The subset of read methods both back ends implement.
 *
 * `MossDb` mirrors `BuildToolsAPI`'s read signatures exactly — that parity is
 * what makes the swap below safe. Typing the union structurally means a drift
 * on either side becomes a compile error here rather than a runtime surprise in
 * a tool handler.
 */
export type ReadBackend = Pick<
  BuildToolsAPI,
  | "getProjects"
  | "getProject"
  | "getCompanies"
  | "getChangeOrders"
  | "getCompany"
  | "getCustomer"
  | "getChangeOrder"
  | "getPurchaseOrders"
  | "getPurchaseOrder"
  | "getTasks"
  | "getRFIs"
  | "getServices"
  | "getUsers"
  | "getCertificates"
  | "searchCertificates"
  | "getDailyLogs"
  | "getWeeklyReports"
  | "getWorkDays"
  | "getFinancialStatement"
  | "getFinancialStatements"
  | "getBudget"
  | "getAllowances"
  | "getSelections"
  | "getSchedule"
  | "getSelectionBudgetCategories"
  | "getSelectionName"
  | "getSelectionDetail"
  | "findUnbilledChangeOrders"
>;

export class BuildToolsOperationsAdapter implements OperationsManagementApi {
  readonly provider = "buildtools";

  constructor(private readonly api: BuildToolsAPI) {}

  /**
   * The read back end for this call: the DB fast path when configured,
   * otherwise HTTP.
   *
   * Resolved per call rather than cached, because `api.db` is attached by the
   * transport at startup and may legitimately be null in local dev and tests.
   */
  private get reader(): ReadBackend {
    // No `as unknown as` hop: MossDb is checked against ReadBackend by the
    // assertion below, so this narrowing is a real structural check rather than
    // an assertion that erases one. An earlier version cast through `unknown`
    // while its own comment claimed to be enforcing parity — it was not.
    return this.api.db ?? this.api;
  }

  /**
   * Rows to pull before filtering status client-side on the HTTP path.
   *
   * Bounded on purpose: an unbounded fetch to satisfy a filter would be worse
   * than the bug. A status-filtered HTTP read therefore sees at most this many
   * rows before narrowing.
   */
  private static readonly HTTP_STATUS_SCAN = 500;

  /**
   * Run a list read, compensating for BuildTools ignoring column filters.
   *
   * Verified live: sending `columns[1][search][value]=5|6|7|8` with the regex
   * flag returns byte-identical rows to an unfiltered request, while `length`
   * IS honoured — so the params arrive and the column filter specifically is
   * discarded. `list_projects` asking for "Active" was getting every project,
   * 333 Completed among them, under a header reading "(status: Active)".
   *
   * The DB path now filters in SQL (`MossDb.statusClause`). The HTTP path
   * cannot, so the adapter narrows the rows itself — over-fetching first, since
   * filtering a page of 50 mixed rows would return a handful and call it a
   * page. This lives here because the adapter is the only layer that knows
   * which back end served the read.
   */
  private async listRead<T>(
    grid: GridName,
    query: ListQuery,
    call: (params: ReturnType<typeof toDatatableParams>) => Promise<unknown>,
  ): Promise<T | null> {
    const compensate = query.status !== undefined && !this.api.db;
    if (!compensate) {
      return normalizeEnvelope(await call(toDatatableParams(grid, query))) as
        | T
        | null;
    }

    const wanted = new Set(
      (Array.isArray(query.status) ? query.status : [query.status]).map(String),
    );

    // `offset` is deliberately NOT forwarded to the scan. The grid would skip
    // that many RAW rows before filtering, so page 2 would not continue page 1
    // — it would skip a mix of statuses. Offset is applied below, to the
    // matched set, which is what the caller actually paginated.
    const { offset: requestedOffset, ...scanQuery } = query;
    const scan = toDatatableParams(grid, {
      ...scanQuery,
      limit: BuildToolsOperationsAdapter.HTTP_STATUS_SCAN,
    });
    const raw = normalizeEnvelope(await call(scan)) as {
      data?: Array<Record<string, unknown>>;
    } | null;
    if (!raw?.data) return raw as T | null;

    // The scan is bounded, so a grid larger than the cap yields a partial view.
    // Say so rather than reporting a confident total computed from a window —
    // `list_projects` renders that number as "(filtered N total)".
    const scanTruncated =
      raw.data.length >= BuildToolsOperationsAdapter.HTTP_STATUS_SCAN;

    const matched = raw.data.filter((row) => wanted.has(String(row.status)));
    const start = requestedOffset ?? 0;
    const end = query.limit === undefined ? undefined : start + query.limit;

    return {
      ...raw,
      data: matched.slice(start, end),
      recordsTotal: matched.length,
      recordsFiltered: matched.length,
      /** True when the bounded scan hit its cap, so the counts are a floor. */
      countsArePartial: scanTruncated,
    } as T;
  }

  // --- list reads ---------------------------------------------------------

  async getProjects<T = unknown>(query: ListQuery = {}): Promise<T | null> {
    return this.listRead<T>("projects", query, (p) => this.reader.getProjects(p));
  }
  async getCompanies<T = unknown>(query: ListQuery = {}): Promise<T | null> {
    return this.listRead<T>("companies", query, (p) =>
      this.reader.getCompanies(p),
    );
  }
  async getChangeOrders<T = unknown>(query: ListQuery = {}): Promise<T | null> {
    return this.listRead<T>("changeOrders", query, (p) =>
      this.reader.getChangeOrders(p),
    );
  }
  async getPurchaseOrders<T = unknown>(
    query: ListQuery = {},
  ): Promise<T | null> {
    return normalizeEnvelope(await this.reader.getPurchaseOrders<T>(toDatatableParams("purchaseOrders", query)));
  }
  async getTasks<T = unknown>(query: ListQuery = {}): Promise<T | null> {
    return this.listRead<T>("tasks", query, (p) => this.reader.getTasks(p));
  }
  async getRFIs<T = unknown>(query: ListQuery = {}): Promise<T | null> {
    return normalizeEnvelope(await this.reader.getRFIs<T>(toDatatableParams("rfis", query)));
  }
  async getServices<T = unknown>(query: ListQuery = {}): Promise<T | null> {
    return normalizeEnvelope(await this.reader.getServices<T>(toDatatableParams("services", query)));
  }
  async getUsers<T = unknown>(query: ListQuery = {}): Promise<T | null> {
    return normalizeEnvelope(await this.reader.getUsers<T>(toDatatableParams("users", query)));
  }
  async getCertificates<T = unknown>(
    query: ListQuery = {},
  ): Promise<T | null> {
    return normalizeEnvelope(await this.reader.getCertificates<T>(toDatatableParams("certificates", query)));
  }
  async getDailyLogs<T = unknown>(query: ListQuery = {}): Promise<T | null> {
    return normalizeEnvelope(await this.reader.getDailyLogs<T>(toDatatableParams("dailyLogs", query)));
  }
  async getWeeklyReports<T = unknown>(
    query: ListQuery = {},
  ): Promise<T | null> {
    return normalizeEnvelope(await this.reader.getWeeklyReports<T>(toDatatableParams("weeklyReports", query)));
  }
  async getWorkDays<T = unknown>(query: ListQuery = {}): Promise<T | null> {
    return normalizeEnvelope(await this.reader.getWorkDays<T>(toDatatableParams("workDays", query)));
  }
  async searchCertificates<T = unknown>(
    query: string,
    limit = 50,
  ): Promise<T | null> {
    return normalizeEnvelope(
      await this.reader.searchCertificates<T>(query, limit),
    );
  }

  // --- single-record reads -------------------------------------------------

  async getProject<T = unknown>(projectId: string | number): Promise<T | null> {
    return normalizeMaybeRow(await this.reader.getProject<T>(projectId));
  }
  async getCompany<T = unknown>(companyId: string | number): Promise<T | null> {
    return normalizeMaybeRow(await this.reader.getCompany<T>(companyId));
  }
  async getCustomer<T = unknown>(
    customerId: string | number,
  ): Promise<T | null> {
    return normalizeMaybeRow(await this.reader.getCustomer<T>(customerId));
  }
  async getChangeOrder<T = unknown>(
    changeOrderId: string | number,
  ): Promise<T | null> {
    return normalizeMaybeRow(await this.reader.getChangeOrder<T>(changeOrderId));
  }
  async getPurchaseOrder(
    purchaseOrderId: string | number,
  ): Promise<PurchaseOrderView | null> {
    return this.reader.getPurchaseOrder(purchaseOrderId);
  }
  async getFinancialStatement<T = unknown>(
    projectId: string | number,
  ): Promise<T | null> {
    return normalizeMaybeRow(
      await this.reader.getFinancialStatement<T>(projectId),
    );
  }

  // --- project-scoped views ------------------------------------------------
  // These return bespoke shapes rather than datatable envelopes, so there are
  // no DT_RowId artifacts to strip.

  async getBudget(projectId: string | number): Promise<BudgetView> {
    return this.reader.getBudget(projectId);
  }
  async getAllowances(projectId: string | number): Promise<AllowanceItem[]> {
    return this.reader.getAllowances(projectId);
  }
  async getSelections(projectId: string | number): Promise<SelectionsView> {
    return this.reader.getSelections(projectId);
  }
  async getFinancialStatements(
    projectId: string | number,
  ): Promise<StatementsView> {
    return this.reader.getFinancialStatements(projectId);
  }
  /**
   * Read the schedule, priming the HTTP session first when necessary.
   *
   * BuildTools' `/schedule/*\/data` only returns the full task list AFTER
   * `/budget?PR[]=<id>` has been requested for that project — otherwise it
   * answers with a project-root stub. Live probe 2026-06-28.
   *
   * This precondition previously lived in the tool layer (`forecasts.ts`,
   * `briefs.ts`), gated on `api.db`. The neutral interface deliberately has no
   * `api.db`, so the precondition has to live here or it would simply vanish on
   * retarget — silently, since nothing about the call signature would change.
   * It also has to live here for the Phase 4 gateway, whose remote callers
   * cannot be expected to know about it.
   *
   * The DB path is project-scoped in SQL and needs no prime; skipping it there
   * matters, because the prime triggers the expensive per-category budget
   * aggregation (~2s/project on a team-wide forecast).
   */
  async getSchedule(
    projectId: string | number,
    kind: "working" | "published" = "working",
  ): Promise<ScheduleView> {
    if (!this.api.db) {
      try {
        await this.api.getBudget(projectId);
      } catch (err) {
        // A failed prime degrades the schedule to a stub; it must not fail the
        // read outright, which is how the tool layer treated it too.
        process.stderr.write(
          `[operations] schedule budget-prime failed for project ${projectId}: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    }
    return this.reader.getSchedule(projectId, kind);
  }
  async getSelectionBudgetCategories(
    projectId: string | number,
  ): Promise<BudgetCategoryRef[]> {
    return this.reader.getSelectionBudgetCategories(projectId);
  }
  async getSelectionName(
    selectionId: string | number,
    projectId: string | number,
  ): Promise<string | null> {
    return this.reader.getSelectionName(selectionId, projectId);
  }
  async getSelectionDetail(
    selectionId: string | number,
    projectId: string | number,
  ): Promise<SelectionDetail | null> {
    return this.reader.getSelectionDetail(selectionId, projectId);
  }

  // --- portfolio reads -----------------------------------------------------

  async findUnbilledChangeOrders(
    filters: UnbilledChangeOrderFilters = {},
  ): Promise<UnbilledChangeOrderRow[]> {
    return this.reader.findUnbilledChangeOrders(filters);
  }

  // --- writes ---------------------------------------------------------------
  //
  // Writes always go to the vendor client. There is no DB path: the replica is
  // read-only, and `this.reader` may BE the replica.

  async createProject(
    input: CreateProjectInput,
  ): Promise<WriteOutcome<CreatedRecord>> {
    return this.runWrite(
      () =>
        this.api.createProjectRaw({
          name: input.name,
          status: input.status,
          projectManager: input.projectManager,
          address: input.address,
          city: input.city,
          state: input.state,
          zip: input.zip,
          description: input.description,
          clientIds: input.clientIds,
        }),
      {
        // `r === 1` is the project-save discriminator; the id field is
        // `projectId` and may legitimately be absent on a landed write, which
        // is why success is read separately from extraction.
        isSuccess: (p) => p.r === 1,
        extract: (p) => ({ id: asId(p.projectId) }),
        probe: { kind: "search", resource: "projects", query: input.name },
      },
    );
  }

  async createChangeOrder(
    input: CreateChangeOrderInput,
  ): Promise<WriteOutcome<CreatedRecord>> {
    const items = input.items?.map((i) => ({
      name: i.name,
      total: i.total,
      budget_category_id: i.budgetCategoryId ?? 0,
    }));

    return this.runWrite(
      () =>
        this.api.createChangeOrderRaw({
          name: input.name,
          projectId: input.projectId,
          status: input.status,
          description: input.description,
          total: input.total,
          items,
        }),
      {
        // Change orders answer `result: "success"`, NOT `r: 1`. Getting this
        // wrong reports a landed write as failed — see the note on `message`
        // in classify.ts.
        isSuccess: (p) => p.result === "success",
        extract: (p) => ({ id: asId(p.id), message: asMessage(p.message) }),
        probe: {
          kind: "search",
          resource: "changeOrders",
          query: input.name,
        },
      },
    );
  }

  async createInvoice(
    input: CreateInvoiceInput,
  ): Promise<WriteOutcome<CreatedRecord>> {
    return this.runWrite(() => this.api.createInvoiceRaw(input), {
      isSuccess: (p) => p.result === "success",
      extract: (p) => ({ id: asId(p.id), message: asMessage(p.message) }),
      // The vendor's invoice number, not our name for the record. It is the
      // natural key a human would use to check, and the thing a duplicate
      // would collide on.
      probe: {
        kind: "search",
        resource: "invoices",
        query: String(input.number),
      },
    });
  }

  async createFinancialStatement(
    input: CreateFinancialStatementInput,
  ): Promise<WriteOutcome<CreatedRecord>> {
    return this.runWrite(
      () => this.api.createFinancialStatementWithAmountRaw(input),
      {
        isSuccess: (p) => p.result === "success",
        extract: (p) => ({ id: asId(p.id), message: asMessage(p.message) }),
        probe: {
          kind: "search",
          resource: `projects/${input.projectId}/financial-statements`,
          query: input.name,
        },
      },
    );
  }

  async createPurchaseOrder(
    input: CreatePurchaseOrderInput,
  ): Promise<WriteOutcome<CreatedRecord>> {
    return this.runWrite(() => this.api.createPurchaseOrderRaw(input), {
      isSuccess: (p) => p.result === "success",
      extract: (p) => ({ id: asId(p.id), message: asMessage(p.message) }),
      probe: {
        kind: "search",
        resource: "purchaseOrders",
        query: input.name,
      },
    });
  }

  async transitionPurchaseOrders(
    input: TransitionPurchaseOrdersInput,
  ): Promise<WriteOutcome<BulkWriteData>> {
    return this.runWrite(
      () => this.api.bulkTransitionPurchaseOrderStatusesRaw(input),
      {
        // `r === 1` means the CALL was applied. Per-id failures come back as
        // `f > 0` alongside it and are data, not an error — a caller that
        // treated a partial as a failure would retry the ids that already
        // moved.
        isSuccess: (p) => p.r === 1,
        extract: (p) => ({
          succeeded: asCount(p.s),
          failed: asCount(p.f),
          message: asJoinedMessage(p.msg),
        }),
        // A transition is not a create, so there is nothing new to search for.
        // The ids the caller already holds ARE the reconcile handle: re-read
        // them and compare status.
        probe: {
          kind: "search",
          resource: "purchaseOrders",
          query: input.purchaseOrderIds.join(","),
        },
      },
    );
  }

  async createTask(
    input: CreateTaskInput,
  ): Promise<WriteOutcome<CreatedRecord>> {
    return this.runWrite(() => this.api.createTaskRaw(input), {
      isSuccess: (p) => p.result === "success",
      extract: (p) => ({ id: asId(p.id), message: asMessage(p.message) }),
      probe: { kind: "search", resource: "tasks", query: input.name },
    });
  }

  async createRfi(input: CreateRfiInput): Promise<WriteOutcome<CreatedRecord>> {
    return this.runWrite(() => this.api.createRFIRaw(input), {
      isSuccess: (p) => p.result === "success",
      extract: (p) => ({ id: asId(p.id), message: asMessage(p.message) }),
      probe: { kind: "search", resource: "rfis", query: input.subject },
    });
  }

  async createService(
    input: CreateServiceInput,
  ): Promise<WriteOutcome<CreatedRecord>> {
    return this.runWrite(() => this.api.createServiceRaw(input), {
      isSuccess: (p) => p.result === "success",
      extract: (p) => ({ id: asId(p.id), message: asMessage(p.message) }),
      probe: { kind: "search", resource: "services", query: input.name },
    });
  }

  /**
   * Create a budget line for a category, without creating a second one.
   *
   * The dedup lives HERE, not in the vendor client, because it is policy
   * rather than wire format: the endpoint is a plain INSERT with no unique
   * constraint, and a duplicate line breaks any report that keys on
   * category-per-project. Any operations vendor with the same shape needs the
   * same guard, and this layer is the one that can read the budget to check.
   */
  async createBudgetItem(
    input: CreateBudgetItemInput,
  ): Promise<WriteOutcome<CreatedRecord>> {
    const mode = input.ifExists ?? "skip";
    if (mode !== "force") {
      let existingId: string | number | undefined;
      try {
        // `this.api.getBudget`, NOT `this.getBudget`. The latter routes through
        // `this.reader`, which is the MySQL replica whenever MYSQL_* is
        // configured — i.e. in production. A read that GATES A WRITE cannot use
        // a lagging source: a line created moments ago would be invisible, the
        // guard would see "no existing row", and it would insert the duplicate
        // it exists to prevent. Same reasoning as the rule for write dispatch
        // itself, one line up.
        const budget = await this.api.getBudget(input.projectId);
        existingId = budget.items.find(
          (i) => Number(i.categoryId) === Number(input.budgetCategoryId),
        )?.id;
      } catch (err) {
        // A failed dup-check must NOT fall through to the insert — that is
        // precisely how duplicates get made. Nothing was written, so this is a
        // definite failure rather than an unknown.
        return failed(
          `could not check for an existing budget line (${errorText(err)}); refusing to insert blind`,
        );
      }
      if (existingId !== undefined) {
        if (mode === "error") {
          return failed(
            `project ${input.projectId} already has a budget line for category ${input.budgetCategoryId} (id ${existingId})`,
          );
        }
        return ok({ id: existingId, existed: true });
      }
    }

    return this.runWrite(() => this.api.createBudgetItemRaw(input), {
      isSuccess: (p) => p.result === "success",
      extract: (p) => ({ id: asId(p.id), existed: false }),
      probe: {
        kind: "search",
        resource: `projects/${input.projectId}/budget`,
        query: String(input.budgetCategoryId),
      },
    });
  }

  async updateBudgetItem(
    input: UpdateBudgetItemInput,
  ): Promise<WriteOutcome<CreatedRecord>> {
    return this.runWrite(() => this.api.updateBudgetItemRaw(input), {
      isSuccess: (p) => p.result === "success",
      extract: () => ({ id: input.budgetItemId }),
      probe: {
        kind: "search",
        resource: `projects/${input.projectId}/budget`,
        query: String(input.budgetItemId),
      },
    });
  }

  async deleteBudgetItem(
    input: DeleteBudgetItemInput,
  ): Promise<WriteOutcome<BulkWriteData>> {
    return this.runWrite(
      () => this.api.deleteBudgetItemRaw(input.budgetItemId, input.projectId),
      {
        // `r === 1` means the call was applied. It does NOT mean anything was
        // deleted: `{r:1, s:0, f:0}` is a documented silent no-op, and the
        // counts are how the caller finds out.
        isSuccess: (p) => p.r === 1,
        extract: (p) => ({
          succeeded: asCount(p.s),
          failed: asCount(p.f),
          message: asJoinedMessage(p.mg),
        }),
        probe: {
          kind: "search",
          resource: `projects/${input.projectId}/budget`,
          query: String(input.budgetItemId),
        },
      },
    );
  }

  /**
   * Run a vendor write and classify whatever comes back — including a throw.
   *
   * The catch is the point. `runWrite`'s caller has already committed the write
   * to the wire by the time most errors can happen, and an escaping exception
   * would leave the tool layer with an error it cannot distinguish from a
   * refusal. `dispatched` is taken from the attempt itself, so a pre-flight
   * guard failure classifies as `failed` and anything after dispatch as
   * ambiguous.
   */
  private async runWrite<T>(
    attempt: () => Promise<RawWriteAttempt>,
    spec: ClassifySpec<T>,
  ): Promise<WriteOutcome<T>> {
    let result: RawWriteAttempt;
    try {
      result = await attempt();
    } catch (err) {
      // The client throws from inside the request, so by here the write may
      // well have been applied. `dispatched: true` is the conservative and
      // correct reading — see classifyWriteError.
      return classifyWriteError(err, { dispatched: true, probe: spec.probe });
    }
    if (!result.dispatched) {
      return failed(result.reason);
    }
    return classifyWriteResponse(result, spec);
  }
}

/**
 * A count from an upstream envelope.
 *
 * Absent means zero here, not "unknown": BuildTools omits `s`/`f` when there is
 * nothing to report. Defaulting to zero is only safe because `isSuccess` has
 * already established the call was applied.
 */
function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Message text from a thrown error, for a reason string. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Upstream's `msg`, which is sometimes a string and sometimes a list of them.
 * Non-strings are dropped rather than stringified — an object here would put
 * unrelated records into a user-facing message.
 */
function asJoinedMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (Array.isArray(value)) {
    const parts = value.filter((v): v is string => typeof v === "string");
    return parts.length > 0 ? parts.join("; ") : undefined;
  }
  return undefined;
}

/** Coerce an upstream id field to the neutral shape, dropping junk. */
function asId(value: unknown): string | number | undefined {
  if (typeof value === "number" || typeof value === "string") return value;
  return undefined;
}

/**
 * Upstream's confirmation text, when it is actually text.
 *
 * BuildTools types `message` as `unknown` because it is sometimes an object.
 * Only a string is forwarded — an arbitrary object could carry unrelated
 * records across the interface and eventually the gateway.
 */
function asMessage(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Build the adapter over an authenticated client. */
export function buildBuildToolsOperationsAdapter(
  api: BuildToolsAPI,
): OperationsManagementApi {
  return new BuildToolsOperationsAdapter(api);
}

/**
 * Compile-time parity check: `MossDb` must satisfy every read method the
 * adapter may route to it.
 *
 * CLAUDE.md calls this parity "non-negotiable" but nothing enforced it — the
 * DB and HTTP back ends could drift apart and the failure would surface as a
 * runtime `TypeError` inside a tool handler, only on machines where `MYSQL_*`
 * is configured (i.e. production, not CI). This turns that into a build error.
 */
const _mossDbSatisfiesReadBackend: ReadBackend =
  null as unknown as import("../../../db/MossDb.js").MossDb;
void _mossDbSatisfiesReadBackend;
