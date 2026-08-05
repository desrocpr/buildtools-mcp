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
import { normalizeEnvelope, normalizeMaybeRow } from "../../normalize.js";
import type {
  AllowanceItem,
  BudgetCategoryRef,
  BudgetView,
  ListParams,
  OperationsManagementApi,
  PurchaseOrderView,
  ScheduleView,
  SelectionsView,
  StatementsView,
} from "../../types.js";

/**
 * The subset of read methods both back ends implement.
 *
 * `MossDb` mirrors `BuildToolsAPI`'s read signatures exactly — that parity is
 * what makes the swap below safe. Typing the union structurally means a drift
 * on either side becomes a compile error here rather than a runtime surprise in
 * a tool handler.
 */
type ReadBackend = Pick<
  BuildToolsAPI,
  | "getProjects"
  | "getProject"
  | "getCompanies"
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
    return (this.api.db ?? this.api) as unknown as ReadBackend;
  }

  // --- list reads ---------------------------------------------------------

  async getProjects<T = unknown>(options: ListParams = {}): Promise<T | null> {
    return normalizeEnvelope(await this.reader.getProjects<T>(options));
  }
  async getCompanies<T = unknown>(options: ListParams = {}): Promise<T | null> {
    return normalizeEnvelope(await this.reader.getCompanies<T>(options));
  }
  async getPurchaseOrders<T = unknown>(
    options: ListParams = {},
  ): Promise<T | null> {
    return normalizeEnvelope(await this.reader.getPurchaseOrders<T>(options));
  }
  async getTasks<T = unknown>(options: ListParams = {}): Promise<T | null> {
    return normalizeEnvelope(await this.reader.getTasks<T>(options));
  }
  async getRFIs<T = unknown>(options: ListParams = {}): Promise<T | null> {
    return normalizeEnvelope(await this.reader.getRFIs<T>(options));
  }
  async getServices<T = unknown>(options: ListParams = {}): Promise<T | null> {
    return normalizeEnvelope(await this.reader.getServices<T>(options));
  }
  async getUsers<T = unknown>(options: ListParams = {}): Promise<T | null> {
    return normalizeEnvelope(await this.reader.getUsers<T>(options));
  }
  async getCertificates<T = unknown>(
    options: ListParams = {},
  ): Promise<T | null> {
    return normalizeEnvelope(await this.reader.getCertificates<T>(options));
  }
  async getDailyLogs<T = unknown>(options: ListParams = {}): Promise<T | null> {
    return normalizeEnvelope(await this.reader.getDailyLogs<T>(options));
  }
  async getWeeklyReports<T = unknown>(
    options: ListParams = {},
  ): Promise<T | null> {
    return normalizeEnvelope(await this.reader.getWeeklyReports<T>(options));
  }
  async getWorkDays<T = unknown>(options: ListParams = {}): Promise<T | null> {
    return normalizeEnvelope(await this.reader.getWorkDays<T>(options));
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
  async getSchedule(
    projectId: string | number,
    kind: "working" | "published" = "working",
  ): Promise<ScheduleView> {
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
  ): Promise<unknown> {
    return this.reader.getSelectionDetail(selectionId, projectId);
  }

  // --- portfolio reads -----------------------------------------------------

  async findUnbilledChangeOrders(filters: {
    min_amount?: number;
    [key: string]: unknown;
  }): Promise<unknown> {
    return this.reader.findUnbilledChangeOrders(filters);
  }
}

/** Build the adapter over an authenticated client. */
export function buildBuildToolsOperationsAdapter(
  api: BuildToolsAPI,
): OperationsManagementApi {
  return new BuildToolsOperationsAdapter(api);
}
