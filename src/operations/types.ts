/**
 * The operations-management capability — the NEUTRAL interface the codebase
 * depends on (MOS-747, Phase 1).
 *
 * Describes WHAT the integration does, never WHICH vendor. Zero vendor imports:
 * no `BuildToolsAPI`, no `MossDb`, no DataTables artifacts. Vendors exist only
 * as adapters under `adapters/<vendor>/`, and `factory.ts` is the single point
 * where one is selected.
 *
 * Named `OperationsManagementApi` rather than reusing Cambium's
 * `ConstructionPmAdapter`: that is a narrow two-method actuation port
 * (create + findByMarker); this is the full operations surface spanning
 * projects, financials, budgets, selections, schedules, purchasing, and work
 * tracking.
 *
 * TWO RETURN CONVENTIONS, DELIBERATELY
 *
 *   reads  → `T | null`        — null means "not found". A read that cannot be
 *                                interpreted is simply absent data, never
 *                                ambiguous.
 *   writes → `WriteOutcome<T>`  — see `outcomes.ts`. A write that cannot be
 *                                interpreted is ambiguous and must be
 *                                reconciled before retry.
 *
 * That asymmetry is intentional and matches Cambium's adapter, which documents
 * the same split for the same reason. It is stated here so it does not later
 * read as drift.
 *
 * ID NORMALISATION
 *
 * Every row crossing this interface carries `id` when upstream had one, and
 * never carries `DT_RowId`. Adapters are responsible for that (see
 * `normalize.ts`) — it is the difference between an interface that is neutral
 * and one that merely looks neutral.
 */

import type { WriteOutcome } from "./outcomes.js";

// ---------------------------------------------------------------------------
// Neutral parameter + row types
// ---------------------------------------------------------------------------

/**
 * A list read, described by FACET rather than by a vendor's wire format.
 *
 * The first cut of this type was BuildTools' `DatatableParams` renamed, so
 * callers passed jQuery-DataTables keys (`search[value]`,
 * `columns[1][search][value]`) straight through a "neutral" interface. Naming
 * the facet instead is what lets a second vendor's adapter implement this
 * without reverse-engineering a positional column index — see
 * `adapters/buildtools/query.ts` for the translation.
 */
export interface ListQuery {
  /** Free-text search across the resource. */
  search?: string;
  /** Maximum rows to return. */
  limit?: number;
  /** Rows to skip, for paging. */
  offset?: number;
  /**
   * Filter on the resource's primary status/type facet. An array is an OR.
   * Values are the provider's status codes, which callers already hold.
   */
  status?: string | number | Array<string | number>;
  /**
   * Scope the read to one project.
   *
   * A first-class facet rather than stuffing the id into `search`. That hack
   * was in `list_change_orders` and it did not work: verified live, the
   * change-orders grid returns ZERO rows for `search[value]=<project id>` and
   * zero for the project NAME, while `PR[]=<id>` returns the project's 18 rows
   * correctly. MossDb reads `PR[]` too, so one facet is right on both paths.
   */
  projectId?: string | number;
  /**
   * Filter companies by type (Vendor / Subcontractor / Customer).
   *
   * Separate from `status`: BuildTools keeps company type in its own grid
   * column, and conflating the two would filter the wrong one.
   */
  companyType?: string | string[];
}

/** A budget line as the operations layer models it. */
export interface BudgetItem {
  id: string;
  categoryId: string;
  name: string;
  isAllowance: boolean;
  publishedBudget: number;
  workingBudget: number;
  approvedCOs: number;
  publishedRevised: number;
  workingRevised: number;
  cells: string[];
}

/** A budget line with the allowance discriminator already applied. */
export type AllowanceItem = Omit<BudgetItem, "isAllowance">;

export interface BudgetView {
  items: BudgetItem[];
  columns: string[];
}

export interface ScheduleTask extends Record<string, unknown> {
  id: number;
  project_id: number;
  parent: number | null;
  text: string;
  type: string;
  start_date: string;
  duration: number;
  progress: number;
  hide_client: number;
}

export interface ScheduleView {
  tasks: ScheduleTask[];
  links: Array<Record<string, unknown>>;
  hide_client?: number;
}

export interface SelectionSummary {
  id: string;
  statusCode: number;
  status: string;
  category: string;
  location: string;
  item: string;
  price: string;
  dueDate: string;
  selection: string;
  notes: string;
  createdAt: string | null;
  updatedAt: string | null;
  approvedDate: string | null;
  rejectedDate: string | null;
}

export interface SelectionsView {
  statusCount: Record<string, number>;
  selections: SelectionSummary[];
}

export interface StatementSummary {
  id: string;
  name: string;
  status: string;
  amount: number;
  paid: number;
  balance: number;
  date: string;
  sent_date: string;
}

export interface StatementsView {
  statusCount: Record<string, number>;
  statements: StatementSummary[];
}

export interface BudgetCategoryRef {
  id: string;
  name: string;
}

/** A file attached to a selection option. */
export interface SelectionOptionFile {
  id: number;
  name: string;
  size: number;
  type: string;
  url: string;
  isImage: boolean;
}

/** One option a client can choose within a selection. */
export interface SelectionOption {
  id: number;
  selectionId: number;
  title: string;
  description: string;
  model: string;
  url: string;
  price: number | null;
  companyId: number | null;
  companyName: string;
  selected: boolean;
  files: SelectionOptionFile[];
  subitems: Array<Record<string, unknown>>;
}

export interface SelectionDetail {
  items: SelectionOption[];
}

/**
 * A change order with approved value not yet reflected in billing.
 *
 * The extra columns are grid-derived and vary, hence the index signature; the
 * named fields are the ones consumers actually render.
 */
export interface UnbilledChangeOrderRow extends Record<string, unknown> {
  total_value: number;
}

/** Filters for the unbilled-change-order sweep. */
export interface UnbilledChangeOrderFilters {
  min_amount?: number;
  older_than_days?: number;
}

/**
 * A purchase order as the operations layer models it.
 *
 * Declared structurally rather than re-exporting the vendor's `PurchaseOrderDetail`
 * — that type lives in the client and importing it here would put a vendor type
 * back in shared types.
 *
 * It must carry every field a consumer renders, NOT merely enough for the
 * adapter to compile. Assignability is one-directional: a richer vendor shape
 * satisfies a narrower neutral one, so omissions are invisible at the adapter
 * and only surface as compile errors at the call site — where the tempting fix
 * is to delete the line and silently drop output. `get_purchase_order` renders
 * `totalNumeric` (the Total line), `invoiceRelated` (Invoiced/unpaid),
 * `amounts[0]` (Qty and Unit columns), and `internalNotes` (Notes column).
 */
export interface PurchaseOrderAmount extends Record<string, unknown> {
  /** Positional grid blob from BuildTools; keys vary by line type. */
  q?: unknown;
  u?: unknown;
}

export interface PurchaseOrderItem {
  id: number | null;
  budgetCategoryId: number | null;
  budgetCategoryCode: string;
  budgetCategoryName: string;
  total: string;
  notes: string;
  internalNotes: string;
  invoiceRelated: string;
  amounts: PurchaseOrderAmount[];
  companyId: number | null;
  companyName: string;
}

export interface PurchaseOrderView {
  id: number;
  projectId: number | null;
  name: string;
  number: string;
  prefix: string;
  /** Vendor status code; `null` when the upstream form could not be parsed. */
  status: number | null;
  description: string;
  companyId: number | null;
  companyName: string;
  items: PurchaseOrderItem[];
  totalNumeric: number;
}

// ---------------------------------------------------------------------------
// Write inputs + results
// ---------------------------------------------------------------------------

/**
 * What a create returns.
 *
 * `id` is OPTIONAL on purpose. A create can land without the response naming
 * the new record — BuildTools' project save is one such case — and a required
 * id would force the adapter to either invent one or downgrade a landed write
 * to a failure. "Created, id unknown" is a real outcome and the type says so.
 */
export interface CreatedRecord {
  id?: string | number;
  /** Upstream's own confirmation text, when it sent one. */
  message?: string;
}

export interface CreateProjectInput {
  name: string;
  /** Provider status code. Defaults to the provider's "active" equivalent. */
  status?: string | number;
  projectManager?: string | number | Array<string | number>;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  description?: string;
  clientIds?: string | number | Array<string | number>;
}

export interface ChangeOrderLineInput {
  name: string;
  total: number;
  budgetCategoryId?: number;
}

export interface CreateChangeOrderInput {
  name: string;
  projectId: string | number;
  status?: string | number;
  description?: string;
  /** Convenience for a single-line change order. Ignored when `items` is set. */
  total?: number;
  items?: ChangeOrderLineInput[];
}

/** A vendor invoice — money owed by the business, not billed to a client. */
export interface CreateInvoiceInput {
  companyId: string | number;
  /** The vendor's own invoice number. A natural key: it is what a reconcile
   * probe searches on, and what makes a duplicate obvious to a human. */
  number: string | number;
  date: string;
  dueDate: string;
  status?: string | number;
  paymentDays?: string | number;
  notes?: string;
}

export interface CreateFinancialStatementInput {
  projectId: string | number;
  name: string;
  amount: string | number;
  notes?: string;
  status?: string | number;
  assignedTo?: string | number;
}

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

/**
 * Read surface consumed by the tool layer.
 *
 * Scoped to what is actually consumed rather than to every method the vendor
 * client happens to expose — an interface nobody calls is a liability, not an
 * abstraction. Writes join this interface in a later phase, returning
 * `WriteOutcome<T>`.
 */
export interface OperationsManagementApi {
  /** Which adapter is behind this instance. Diagnostics only. */
  readonly provider: string;

  // --- list reads (datatable-shaped) ------------------------------------
  getProjects<T = unknown>(query?: ListQuery): Promise<T | null>;
  getCompanies<T = unknown>(query?: ListQuery): Promise<T | null>;
  getChangeOrders<T = unknown>(query?: ListQuery): Promise<T | null>;
  getPurchaseOrders<T = unknown>(query?: ListQuery): Promise<T | null>;
  getTasks<T = unknown>(query?: ListQuery): Promise<T | null>;
  getRFIs<T = unknown>(query?: ListQuery): Promise<T | null>;
  getServices<T = unknown>(query?: ListQuery): Promise<T | null>;
  getUsers<T = unknown>(query?: ListQuery): Promise<T | null>;
  getCertificates<T = unknown>(query?: ListQuery): Promise<T | null>;
  getDailyLogs<T = unknown>(query?: ListQuery): Promise<T | null>;
  getWeeklyReports<T = unknown>(query?: ListQuery): Promise<T | null>;
  getWorkDays<T = unknown>(query?: ListQuery): Promise<T | null>;
  searchCertificates<T = unknown>(query: string, limit?: number): Promise<T | null>;

  // --- single-record reads ----------------------------------------------
  getProject<T = unknown>(projectId: string | number): Promise<T | null>;
  getCompany<T = unknown>(companyId: string | number): Promise<T | null>;
  getCustomer<T = unknown>(customerId: string | number): Promise<T | null>;
  getChangeOrder<T = unknown>(changeOrderId: string | number): Promise<T | null>;
  getPurchaseOrder(
    purchaseOrderId: string | number,
  ): Promise<PurchaseOrderView | null>;
  getFinancialStatement<T = unknown>(
    projectId: string | number,
  ): Promise<T | null>;

  // --- project-scoped views ---------------------------------------------
  getBudget(projectId: string | number): Promise<BudgetView>;
  getAllowances(projectId: string | number): Promise<AllowanceItem[]>;
  getSelections(projectId: string | number): Promise<SelectionsView>;
  getFinancialStatements(projectId: string | number): Promise<StatementsView>;
  getSchedule(
    projectId: string | number,
    kind?: "working" | "published",
  ): Promise<ScheduleView>;
  getSelectionBudgetCategories(
    projectId: string | number,
  ): Promise<BudgetCategoryRef[]>;
  getSelectionName(
    selectionId: string | number,
    projectId: string | number,
  ): Promise<string | null>;
  getSelectionDetail(
    selectionId: string | number,
    projectId: string | number,
  ): Promise<SelectionDetail | null>;

  // --- portfolio reads ---------------------------------------------------
  findUnbilledChangeOrders(
    filters?: UnbilledChangeOrderFilters,
  ): Promise<UnbilledChangeOrderRow[]>;

  // --- writes -------------------------------------------------------------
  //
  // Every write returns `WriteOutcome<T>` and NEVER throws for an upstream
  // condition. A thrown error would put the caller back where the boolean
  // contract left them: unable to tell "refused" from "unknown", which is the
  // state that turns a retry into a duplicate record. Adapters catch at the
  // boundary and classify (`adapters/buildtools/classify.ts`).
  //
  // Ambiguous outcomes carry a `probe` — the search a caller runs to find out
  // whether the write landed. Without one, "ambiguous" is just alarming; with
  // one it is actionable.
  createProject(
    input: CreateProjectInput,
  ): Promise<WriteOutcome<CreatedRecord>>;
  createChangeOrder(
    input: CreateChangeOrderInput,
  ): Promise<WriteOutcome<CreatedRecord>>;
  createInvoice(
    input: CreateInvoiceInput,
  ): Promise<WriteOutcome<CreatedRecord>>;
  createFinancialStatement(
    input: CreateFinancialStatementInput,
  ): Promise<WriteOutcome<CreatedRecord>>;
}

/** Per-tenant selection config. Values are config names, never secrets. */
export interface OperationsTenantConfig {
  provider: string;
  settings?: Record<string, string>;
}
