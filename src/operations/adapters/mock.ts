/**
 * In-memory mock adapter for the operations-management interface (MOS-747).
 *
 * A first-class adapter, not a test helper. Cambium ships the same thing
 * (`integrations/construction-pm/adapters/mock.ts`) for the same reasons:
 *
 *   - The repo's agnostic-integration rule says business-logic tests target the
 *     INTERFACE, not a vendor. Today ~150 test bindings in `src/tools/__tests__/`
 *     stub the concrete `BuildToolsAPI`, which is precisely the coupling this
 *     layer exists to remove — and rewriting them onto a shared mock is far less
 *     work than rewriting them onto another set of bespoke vendor stubs.
 *   - It gives the tool layer a way to run with no vendor at all: rehearsal,
 *     local dev without credentials, and a dry-run target for the Phase 4
 *     gateway.
 *
 * Stateful and seedable rather than call-spy shaped: tests assert on the DATA
 * that comes back, which is what actually distinguishes behaviour.
 *
 * Rows are stored already-normalised (real `id`, no `DT_RowId`), because that is
 * the contract the interface promises. A test that wants to prove the BuildTools
 * adapter's normalisation works should use that adapter — not this one.
 */

import { assertStatusFilterSupported, type GridName } from "./buildtools/query.js";
import {
  ambiguous,
  failed,
  ok,
  type BulkWriteData,
  type ReconcileProbe,
  type WriteOutcome,
} from "../outcomes.js";
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
} from "../types.js";

/** Grids the mock can write to. */
export type WritableGrid =
  | "projects"
  | "changeOrders"
  | "invoices"
  | "financialStatementRows"
  | "purchaseOrders";

/** A row in a mock grid. `id` is required — the interface guarantees it. */
export interface MockRow extends Record<string, unknown> {
  id: string | number;
}

/**
 * Everything the mock can serve. Every field is optional; an unseeded grid
 * answers with an empty result rather than throwing, so a test only seeds what
 * it exercises.
 */
export interface MockSeed {
  projects?: MockRow[];
  companies?: MockRow[];
  customers?: MockRow[];
  changeOrders?: MockRow[];
  purchaseOrders?: MockRow[];
  tasks?: MockRow[];
  rfis?: MockRow[];
  services?: MockRow[];
  users?: MockRow[];
  certificates?: MockRow[];
  dailyLogs?: MockRow[];
  weeklyReports?: MockRow[];
  workDays?: MockRow[];
  financialStatementRows?: MockRow[];
  /** Write-only in the mock today: no read method lists vendor invoices. */
  invoices?: MockRow[];
  purchaseOrderDetail?: Record<string, PurchaseOrderView>;
  budget?: Record<string, BudgetView>;
  selections?: Record<string, SelectionsView>;
  selectionDetail?: Record<string, SelectionDetail>;
  selectionNames?: Record<string, string>;
  selectionCategories?: Record<string, BudgetCategoryRef[]>;
  statements?: Record<string, StatementsView>;
  schedules?: Record<string, ScheduleView>;
  unbilledChangeOrders?: UnbilledChangeOrderRow[];
}

/** Envelope matching what the real grids return. */
interface Envelope {
  data: MockRow[];
  recordsTotal: number;
  recordsFiltered: number;
}

export class MockOperationsApi implements OperationsManagementApi {
  readonly provider = "mock";

  /** Every call recorded, so a test can assert on ordering when it matters. */
  readonly calls: Array<{ method: string; args: unknown[] }> = [];

  constructor(private seed: MockSeed = {}) {}

  /** Replace or extend the seed mid-test (e.g. to simulate a write landing). */
  reseed(patch: MockSeed): void {
    this.seed = { ...this.seed, ...patch };
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  /**
   * Apply the neutral query to a seeded grid.
   *
   * Filtering is real, not a stub: `search` matches any string field and
   * `status` matches the row's status. A mock that ignored its own query
   * parameters would let a tool ship with a filter that never filtered.
   */
  private list(
    grid: GridName,
    rows: MockRow[] = [],
    query: ListQuery = {},
  ): Envelope {
    // Match the real adapter's failure surface exactly. `query.ts` throws when
    // a grid's status column has not been verified; if the mock filtered
    // anyway, a Phase 3 test would pass and the identical production call would
    // explode. A mock that is more permissive than production is worse than no
    // mock — it manufactures confidence.
    if (query.status !== undefined) assertStatusFilterSupported(grid);

    let out = rows;

    if (query.search) {
      const needle = query.search.toLowerCase();
      out = out.filter((r) =>
        Object.values(r).some(
          (v) => typeof v === "string" && v.toLowerCase().includes(needle),
        ),
      );
    }

    if (query.status !== undefined) {
      const wanted = new Set(
        (Array.isArray(query.status) ? query.status : [query.status]).map(
          String,
        ),
      );
      out = out.filter((r) => wanted.has(String(r.status)));
    }

    if (query.projectId !== undefined) {
      const wanted = String(query.projectId);
      out = out.filter(
        (r) => String(r.project_id ?? r.projectId ?? "") === wanted,
      );
    }

    if (query.companyType !== undefined) {
      const wanted = new Set(
        (Array.isArray(query.companyType)
          ? query.companyType
          : [query.companyType]
        ).map(String),
      );
      out = out.filter((r) => wanted.has(String(r.type_name)));
    }

    const total = out.length;
    if (query.offset !== undefined) out = out.slice(query.offset);
    if (query.limit !== undefined) out = out.slice(0, query.limit);

    return { data: out, recordsTotal: total, recordsFiltered: total };
  }

  private find(rows: MockRow[] = [], id: string | number): MockRow | null {
    return rows.find((r) => String(r.id) === String(id)) ?? null;
  }

  // --- list reads ---------------------------------------------------------

  async getProjects<T = unknown>(query: ListQuery = {}): Promise<T | null> {
    this.record("getProjects", query);
    return this.list("projects", this.seed.projects, query) as T;
  }
  async getCompanies<T = unknown>(query: ListQuery = {}): Promise<T | null> {
    this.record("getCompanies", query);
    return this.list("companies", this.seed.companies, query) as T;
  }
  async getChangeOrders<T = unknown>(query: ListQuery = {}): Promise<T | null> {
    this.record("getChangeOrders", query);
    return this.list("changeOrders", this.seed.changeOrders, query) as T;
  }
  async getPurchaseOrders<T = unknown>(query: ListQuery = {}): Promise<T | null> {
    this.record("getPurchaseOrders", query);
    return this.list("purchaseOrders", this.seed.purchaseOrders, query) as T;
  }
  async getTasks<T = unknown>(query: ListQuery = {}): Promise<T | null> {
    this.record("getTasks", query);
    return this.list("tasks", this.seed.tasks, query) as T;
  }
  async getRFIs<T = unknown>(query: ListQuery = {}): Promise<T | null> {
    this.record("getRFIs", query);
    return this.list("rfis", this.seed.rfis, query) as T;
  }
  async getServices<T = unknown>(query: ListQuery = {}): Promise<T | null> {
    this.record("getServices", query);
    return this.list("services", this.seed.services, query) as T;
  }
  async getUsers<T = unknown>(query: ListQuery = {}): Promise<T | null> {
    this.record("getUsers", query);
    return this.list("users", this.seed.users, query) as T;
  }
  async getCertificates<T = unknown>(query: ListQuery = {}): Promise<T | null> {
    this.record("getCertificates", query);
    return this.list("certificates", this.seed.certificates, query) as T;
  }
  async getDailyLogs<T = unknown>(query: ListQuery = {}): Promise<T | null> {
    this.record("getDailyLogs", query);
    return this.list("dailyLogs", this.seed.dailyLogs, query) as T;
  }
  async getWeeklyReports<T = unknown>(query: ListQuery = {}): Promise<T | null> {
    this.record("getWeeklyReports", query);
    return this.list("weeklyReports", this.seed.weeklyReports, query) as T;
  }
  async getWorkDays<T = unknown>(query: ListQuery = {}): Promise<T | null> {
    this.record("getWorkDays", query);
    return this.list("workDays", this.seed.workDays, query) as T;
  }
  async searchCertificates<T = unknown>(
    query: string,
    limit = 50,
  ): Promise<T | null> {
    this.record("searchCertificates", query, limit);
    return this.list("certificates", this.seed.certificates, { search: query, limit }) as T;
  }

  // --- single-record reads -------------------------------------------------

  async getProject<T = unknown>(projectId: string | number): Promise<T | null> {
    this.record("getProject", projectId);
    return this.find(this.seed.projects, projectId) as T | null;
  }
  async getCompany<T = unknown>(companyId: string | number): Promise<T | null> {
    this.record("getCompany", companyId);
    return this.find(this.seed.companies, companyId) as T | null;
  }
  async getCustomer<T = unknown>(customerId: string | number): Promise<T | null> {
    this.record("getCustomer", customerId);
    // BuildTools stores customers in the companies table; the mock mirrors that
    // fallback so a test seeding only `companies` behaves like production.
    return (this.find(this.seed.customers, customerId) ??
      this.find(this.seed.companies, customerId)) as T | null;
  }
  async getChangeOrder<T = unknown>(id: string | number): Promise<T | null> {
    this.record("getChangeOrder", id);
    return this.find(this.seed.changeOrders, id) as T | null;
  }
  async getPurchaseOrder(id: string | number): Promise<PurchaseOrderView | null> {
    this.record("getPurchaseOrder", id);
    return this.seed.purchaseOrderDetail?.[String(id)] ?? null;
  }
  async getFinancialStatement<T = unknown>(
    projectId: string | number,
  ): Promise<T | null> {
    this.record("getFinancialStatement", projectId);
    return this.find(this.seed.financialStatementRows, projectId) as T | null;
  }

  // --- project-scoped views ------------------------------------------------

  async getBudget(projectId: string | number): Promise<BudgetView> {
    this.record("getBudget", projectId);
    return this.seed.budget?.[String(projectId)] ?? { items: [], columns: [] };
  }
  async getAllowances(projectId: string | number): Promise<AllowanceItem[]> {
    this.record("getAllowances", projectId);
    const budget = await this.getBudget(projectId);
    return budget.items
      .filter((i) => i.isAllowance)
      .map(({ isAllowance: _drop, ...rest }) => rest);
  }
  async getSelections(projectId: string | number): Promise<SelectionsView> {
    this.record("getSelections", projectId);
    return (
      this.seed.selections?.[String(projectId)] ?? {
        statusCount: {},
        selections: [],
      }
    );
  }
  async getFinancialStatements(
    projectId: string | number,
  ): Promise<StatementsView> {
    this.record("getFinancialStatements", projectId);
    return (
      this.seed.statements?.[String(projectId)] ?? {
        statusCount: {},
        statements: [],
      }
    );
  }
  async getSchedule(
    projectId: string | number,
    kind: "working" | "published" = "working",
  ): Promise<ScheduleView> {
    this.record("getSchedule", projectId, kind);
    return (
      this.seed.schedules?.[`${projectId}:${kind}`] ??
      this.seed.schedules?.[String(projectId)] ?? { tasks: [], links: [] }
    );
  }
  async getSelectionBudgetCategories(
    projectId: string | number,
  ): Promise<BudgetCategoryRef[]> {
    this.record("getSelectionBudgetCategories", projectId);
    return this.seed.selectionCategories?.[String(projectId)] ?? [];
  }
  async getSelectionName(
    selectionId: string | number,
    projectId: string | number,
  ): Promise<string | null> {
    this.record("getSelectionName", selectionId, projectId);
    return this.seed.selectionNames?.[String(selectionId)] ?? null;
  }
  async getSelectionDetail(
    selectionId: string | number,
    projectId: string | number,
  ): Promise<SelectionDetail | null> {
    this.record("getSelectionDetail", selectionId, projectId);
    return this.seed.selectionDetail?.[String(selectionId)] ?? null;
  }

  // --- portfolio reads -----------------------------------------------------

  async findUnbilledChangeOrders(
    filters: UnbilledChangeOrderFilters = {},
  ): Promise<UnbilledChangeOrderRow[]> {
    this.record("findUnbilledChangeOrders", filters);
    let rows = this.seed.unbilledChangeOrders ?? [];
    if (filters.min_amount !== undefined) {
      const min = filters.min_amount;
      rows = rows.filter((r) => r.total_value >= min);
    }
    return rows;
  }

  // --- writes ---------------------------------------------------------------

  async createProject(
    input: CreateProjectInput,
  ): Promise<WriteOutcome<CreatedRecord>> {
    this.record("createProject", input);
    return this.write("projects", { name: input.name }, {
      kind: "search",
      resource: "projects",
      query: input.name,
    });
  }

  async createChangeOrder(
    input: CreateChangeOrderInput,
  ): Promise<WriteOutcome<CreatedRecord>> {
    this.record("createChangeOrder", input);
    return this.write(
      "changeOrders",
      {
        name: input.name,
        project_id: input.projectId,
        total:
          input.items?.reduce((sum, i) => sum + i.total, 0) ?? input.total ?? 0,
      },
      { kind: "search", resource: "changeOrders", query: input.name },
    );
  }

  async createInvoice(
    input: CreateInvoiceInput,
  ): Promise<WriteOutcome<CreatedRecord>> {
    this.record("createInvoice", input);
    return this.write(
      "invoices",
      { number: input.number, company_id: input.companyId, date: input.date },
      { kind: "search", resource: "invoices", query: String(input.number) },
    );
  }

  async createFinancialStatement(
    input: CreateFinancialStatementInput,
  ): Promise<WriteOutcome<CreatedRecord>> {
    this.record("createFinancialStatement", input);
    return this.write(
      "financialStatementRows",
      {
        name: input.name,
        project_id: input.projectId,
        amount: input.amount,
      },
      {
        kind: "search",
        resource: `projects/${input.projectId}/financial-statements`,
        query: input.name,
      },
    );
  }

  async createPurchaseOrder(
    input: CreatePurchaseOrderInput,
  ): Promise<WriteOutcome<CreatedRecord>> {
    this.record("createPurchaseOrder", input);
    return this.write(
      "purchaseOrders",
      {
        name: input.name,
        project_id: input.projectId,
        company_id: input.companyId,
      },
      { kind: "search", resource: "purchaseOrders", query: input.name },
    );
  }

  async transitionPurchaseOrders(
    input: TransitionPurchaseOrdersInput,
  ): Promise<WriteOutcome<BulkWriteData>> {
    this.record("transitionPurchaseOrders", input);
    const probe: ReconcileProbe = {
      kind: "search",
      resource: "purchaseOrders",
      query: input.purchaseOrderIds.join(","),
    };
    const scripted = this.nextOutcome("purchaseOrders");
    if (scripted === "failed") {
      return failed("mock: transition refused", "mock rejection");
    }
    if (scripted === "ambiguous") {
      return ambiguous("mock: outcome unknown", probe);
    }

    // A transition MUTATES rows rather than adding one, and only rows that
    // exist can move — which is what produces a partial result, the case a
    // boolean cannot express. The mock reproduces that rather than always
    // reporting every id as succeeded.
    const rows = this.seed.purchaseOrders ?? [];
    let succeeded = 0;
    for (const id of input.purchaseOrderIds) {
      const row = rows.find((r) => String(r.id) === String(id));
      if (!row) continue;
      row.status = input.status;
      succeeded += 1;
    }
    return ok({
      succeeded,
      failed: input.purchaseOrderIds.length - succeeded,
    });
  }

  /**
   * Perform a seeded write.
   *
   * The mock's job here is NOT to imitate BuildTools' wire format — that is the
   * BuildTools adapter's problem, and `classify.test.ts` covers it. Its job is
   * to let a caller rehearse each of the three outcomes, because the ambiguous
   * branch is the one that is hard to reach against a real server and therefore
   * the one that ships untested.
   *
   * A successful write MUTATES the seeded grid, so a test can assert that a
   * follow-up read sees the new row — the property a caller actually depends
   * on, and one a call-spy cannot express.
   */
  private write(
    grid: WritableGrid,
    row: Record<string, unknown>,
    probe: ReconcileProbe,
  ): WriteOutcome<CreatedRecord> {
    const scripted = this.nextOutcome(grid);
    if (scripted === "failed") {
      return failed(`mock: ${grid} write refused`, "mock rejection");
    }
    if (scripted === "ambiguous") {
      // Deliberately NOT recorded in the grid. "Ambiguous" means the mock does
      // not know either — a test that wants "landed but unacknowledged" seeds
      // the row itself and then scripts an ambiguous outcome.
      return ambiguous("mock: outcome unknown", probe);
    }

    const id = this.nextId++;
    const rows = (this.seed[grid] ??= []);
    rows.push({ id, ...row } as MockRow);
    return ok({ id });
  }

  /** Pop the next scripted outcome for a grid, defaulting to success. */
  private nextOutcome(grid: string): "ok" | "failed" | "ambiguous" {
    return this.scriptedOutcomes[grid]?.shift() ?? "ok";
  }

  /**
   * Script the outcomes a grid's next writes will produce, in order.
   * Anything past the end of the list succeeds.
   */
  scriptWrites(
    grid: WritableGrid,
    outcomes: Array<"ok" | "failed" | "ambiguous">,
  ): void {
    this.scriptedOutcomes[grid] = [...outcomes];
  }

  private scriptedOutcomes: Record<string, Array<"ok" | "failed" | "ambiguous">> =
    {};
  private nextId = 9000;
}

export function buildMockOperationsApi(seed: MockSeed = {}): MockOperationsApi {
  return new MockOperationsApi(seed);
}
