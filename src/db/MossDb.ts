/**
 * MossDb — read-only adapter against BuildTools' MySQL read replica
 * (PR #82). Mirrors the read-shape of BuildToolsAPI exactly so tool
 * handlers can swap to DB transparently when MYSQL_* credentials are
 * configured.
 *
 * Schema source: live probe 2026-06-28 against `moss-online-replica`.
 * Tables: projects, schedule_tasks, schedule_published, change_orders,
 * financial_statements, projects_users, users, budgets, budget_categories,
 * purchase_orders, selections, budgets_items.
 *
 * Status enum reminders:
 *   - projects.status: 1=Templates, 2=On Hold, 3=Warranty, 4=Completed,
 *     5=Nexus, 6=Omega, 7=Invicta, 8=Alpha, 10=Maintenance Plans,
 *     12=Cancelled, 14=Excluded Reporting
 *   - change_orders.status: 1=Draft, 2=Pending, 3=Approved, 4=Rejected
 *   - financial_statements.status: 1=Draft, 2=?, 4=Sent unpaid (paid_amount=0),
 *     5=Partly Paid, 6=Paid (verified live 2026-06-28)
 *   - users.role: 1=Core Admin, 2=Employee, 3=Client, 4=Company Rep
 *   - purchase_orders.status: 1=Draft, 2=Sent, 3=Confirmed, 4=Rejected
 *
 * Authorization note: this adapter reads with full DB privileges — no
 * per-user BT permission filtering. Acceptable for the internal Moss
 * MCP because the tool itself is gated by OAuth and only employees
 * have access. Do NOT use this adapter for tools that need per-user
 * row-level security.
 */

import mysql from "mysql2/promise";
import type { Pool, RowDataPacket } from "mysql2/promise";

export interface MossDbConfig {
  host: string;
  port?: number;
  user: string;
  password: string;
  database: string;
  ssl?: { rejectUnauthorized: boolean };
  connectionLimit?: number;
}

// ---------------------------------------------------------------------------
// Status mapping helpers — translate DB tinyints into the HTTP-wrapper labels
// so existing tool code that string-matches on "Sent" / "Paid" / "Approved"
// keeps working unchanged.
// ---------------------------------------------------------------------------

const FS_STATUS_LABELS: Record<number, string> = {
  1: "Draft",
  2: "Pending",
  4: "Sent",        // status=4 with paid_amount=0 → "Sent" per BT UI
  5: "Partly Paid",
  6: "Paid",
};
const FS_SENT_STATUSES = new Set([4, 5, 6]); // populate sent_date for these

function fsStatusLabel(code: number, paid: number, amount: number): string {
  // Refine status=4 vs "Sent" / "Partly Paid" based on payment progress.
  // BT renders status=4 as "Sent" when paid=0 but "Partly Paid" when 0<paid<amount.
  if (code === 4) {
    if (paid <= 0.005) return "Sent";
    if (paid + 0.005 >= amount) return "Paid";
    return "Partly Paid";
  }
  return FS_STATUS_LABELS[code] ?? `Unknown(${code})`;
}

const CO_STATUS_LABELS: Record<number, string> = {
  1: "Draft",
  2: "Pending",
  3: "Approved",
  4: "Rejected",
};

function mmddyyyy(d: Date | string | null | undefined): string {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${dt.getFullYear()}`;
}

function fmtDuration(days: number): string {
  return `${days} days`;
}

function fmtUsdStr(n: number): string {
  return `$ ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ---------------------------------------------------------------------------
// MossDb
// ---------------------------------------------------------------------------

export class MossDb {
  private pool: Pool;

  constructor(cfg: MossDbConfig) {
    this.pool = mysql.createPool({
      host: cfg.host,
      port: cfg.port ?? 3306,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      ssl: cfg.ssl ?? { rejectUnauthorized: false },
      connectionLimit: cfg.connectionLimit ?? 8,
      waitForConnections: true,
      queueLimit: 0,
    });
  }

  async ping(): Promise<void> {
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT 1 AS ok");
    if (!rows[0]) throw new Error("ping returned no rows");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  /**
   * Mirrors BuildToolsAPI.getProject for read paths used by briefs /
   * forecasts / invoices. Computes `budget_revised` as the working
   * budget total + sum of approved CO totals (matching BT's HTTP shape,
   * verified live for Katchmark: $575,000 + $90,124.94 = $665,124.94).
   */
  async getProject<T = Record<string, unknown>>(id: number | string): Promise<T | null> {
    const projectId = Number(id);
    if (!Number.isFinite(projectId) || projectId <= 0) return null;
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT p.id, p.name, p.status, p.budget_total, p.address, p.city, p.state,
              p.financial_amounts, p.financial_payments, p.financial_balance
         FROM projects p
        WHERE p.id = ?
        LIMIT 1`,
      [projectId],
    );
    const p = rows[0];
    if (!p) return null;
    const [coRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT COALESCE(SUM(total), 0) AS approved_total
         FROM change_orders
        WHERE project_id = ? AND status = 3 AND deleted_at IS NULL`,
      [projectId],
    );
    const approved = Number(coRows[0]?.approved_total ?? 0);
    const budgetRevised = Number(p.budget_total) + approved;

    // PM list: projects_users with role = 2 (Employee)
    // PR #82 fix: DISTINCT — projects_users can have multiple rows per
    // user (different role/config combos), causing the PM list to show
    // duplicates ("Elizabeth Maughan, Elizabeth Maughan").
    const [pmRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT DISTINCT u.first_name, u.last_name
         FROM projects_users pu
         JOIN users u ON u.id = pu.user_id
        WHERE pu.project_id = ? AND pu.role = 2 AND pu.deleted = 0
        ORDER BY u.first_name`,
      [projectId],
    );
    const managers = pmRows
      .map((r) => `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim())
      .filter(Boolean)
      .join(", ");

    // schedule_published_duration: latest is_published_last snapshot's
    // span in days (max(end_date) - min(start_date) on its tasks)
    const [durRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT DATEDIFF(MAX(st.end_date), MIN(st.start_date)) AS duration_days
         FROM schedule_tasks st
         JOIN schedule_published sp ON sp.id = st.published_id
        WHERE st.project_id = ? AND sp.is_published_last = 1`,
      [projectId],
    );
    const durationDays = durRows[0]?.duration_days;

    const result: Record<string, unknown> = {
      id: p.id,
      name: p.name ?? `#${p.id}`,
      status: p.status,
      status_id: p.status,
      budget_revised: fmtUsdStr(budgetRevised),
      address: p.address ?? "",
      city: p.city ?? "",
      state: p.state ?? "",
      managers,
      schedule_published_duration: durationDays != null ? fmtDuration(Number(durationDays)) : "-",
    };
    return result as T;
  }

  /**
   * Mirrors BuildToolsAPI.getProjects for the team-enumeration path used
   * by briefs / forecasts / invoices. Returns project rows including the
   * `schedule_published_duration` field that the team-resolution path
   * filters on.
   */
  async getProjects<T = { data: Array<Record<string, unknown>> }>(opts: {
    length?: number;
  } = {}): Promise<T> {
    const limit = Math.max(1, Math.min(opts.length ?? 100, 500));
    // One query: join projects to the latest published-snapshot duration
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT
         p.id, p.name, p.status,
         dur.duration_days
       FROM projects p
       LEFT JOIN (
         SELECT st.project_id, DATEDIFF(MAX(st.end_date), MIN(st.start_date)) AS duration_days
           FROM schedule_tasks st
           JOIN schedule_published sp ON sp.id = st.published_id
          WHERE sp.is_published_last = 1
          GROUP BY st.project_id
       ) dur ON dur.project_id = p.id
       WHERE p.status BETWEEN 1 AND 20
       ORDER BY p.id DESC
       LIMIT ?`,
      [limit],
    );
    const data = rows.map((r) => ({
      id: r.id,
      DT_RowId: `row_${r.id}`,
      name: r.name ?? `#${r.id}`,
      status: r.status,
      status_id: r.status,
      schedule_published_duration: r.duration_days != null ? fmtDuration(Number(r.duration_days)) : "-",
    }));
    return { data } as T;
  }

  // -------------------------------------------------------------------------
  // Financial statements
  // -------------------------------------------------------------------------

  async getFinancialStatements(projectId: number | string): Promise<{
    statusCount: Record<string, number>;
    statements: Array<{
      id: string;
      name: string;
      status: string;
      amount: number;
      paid: number;
      balance: number;
      date: string;
      sent_date: string;
    }>;
  }> {
    const pid = Number(projectId);
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, name, status, amount, paid_amount, to_pay_at, paid_at
         FROM financial_statements
        WHERE project_id = ?
        ORDER BY to_pay_at ASC, id ASC`,
      [pid],
    );
    const statusCount: Record<string, number> = {};
    const statements = rows.map((r) => {
      const amount = Number(r.amount);
      const paid = Number(r.paid_amount);
      const balance = Math.round((amount - paid) * 100) / 100;
      const status = fsStatusLabel(Number(r.status), paid, amount);
      statusCount[status] = (statusCount[status] ?? 0) + 1;
      const date = mmddyyyy(r.to_pay_at);
      return {
        id: String(r.id),
        name: r.name ?? "",
        status,
        amount,
        paid,
        balance,
        date,
        sent_date: FS_SENT_STATUSES.has(Number(r.status)) ? date : "",
      };
    });
    return { statusCount, statements };
  }

  // -------------------------------------------------------------------------
  // Change orders
  // -------------------------------------------------------------------------

  /**
   * Mirrors BuildToolsAPI.getChangeOrders. The HTTP wrapper accepts a
   * `PR[]` param for project scoping; here we accept the same opt shape
   * and translate to a SQL filter. Numeric status preserved (1/2/3/4)
   * to match what the HTTP datatable row exposes.
   */
  async getChangeOrders<T = { data: Array<Record<string, unknown>>; recordsTotal?: number }>(
    opts: Record<string, unknown> = {},
  ): Promise<T> {
    const projectId = opts["PR[]"];
    const limit = Math.max(1, Math.min(Number(opts["length"] ?? 50), 500));
    // PR #82 fix: qualify deleted_at with co.* — projects table also
    // has a deleted_at column, making the unqualified ref ambiguous.
    const where: string[] = ["co.deleted_at IS NULL"];
    const params: unknown[] = [];
    if (projectId !== undefined && projectId !== null) {
      where.push("co.project_id = ?");
      params.push(Number(projectId));
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT co.id, co.project_id, co.status, co.name, co.number, co.approved_number,
              co.total, co.approved_date, co.created_at,
              p.name AS project_name
         FROM change_orders co
         JOIN projects p ON p.id = co.project_id
         ${whereSql}
         ORDER BY co.id DESC
         LIMIT ?`,
      [...params, limit],
    );
    const data = rows.map((r) => ({
      DT_RowId: `row_${r.id}`,
      status: r.status, // numeric, matches HTTP wrapper
      info: r.id,
      project_name: r.project_name,
      number: r.number,
      approved_number: r.approved_number,
      name: r.name ?? "",
      total: fmtUsdStr(Number(r.total)),
      dates: r.approved_date ? mmddyyyy(r.approved_date) : "-",
      created_at: r.created_at ? mmddyyyy(r.created_at) : "",
    }));
    return { data, recordsTotal: data.length } as T;
  }

  // -------------------------------------------------------------------------
  // Schedule (DHTMLX-shape)
  // -------------------------------------------------------------------------

  async getSchedule(
    projectId: number | string,
    kind: "working" | "published" = "working",
  ): Promise<{
    tasks: Array<Record<string, unknown> & {
      id: number;
      project_id: number;
      parent: number | null;
      text: string;
      type: string;
      start_date: string;
      duration: number;
      progress: number;
      hide_client: number;
    }>;
    links: Array<Record<string, unknown>>;
    hide_client?: number;
  }> {
    const pid = Number(projectId);
    const join = kind === "published"
      ? `INNER JOIN schedule_published sp ON sp.id = st.published_id AND sp.is_published_last = 1`
      : "";
    const where = kind === "working"
      ? "st.project_id = ? AND st.published_id IS NULL"
      : "st.project_id = ?";
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT st.id, st.project_id, st.parent, st.text, st.type,
              st.start_date, st.duration, st.progress, st.hide_client,
              st.budget_category_id, bc.name AS budget_category_name,
              st.locations_room_id, st.published_id, st.published_task_id
         FROM schedule_tasks st
         LEFT JOIN budget_categories bc ON bc.id = st.budget_category_id
         ${join}
        WHERE ${where}
        ORDER BY st.start_date ASC, st.id ASC`,
      [pid],
    );
    const tasks = rows.map((r) => {
      // DB type tinyint: 1=Task, 2=Project (group/root), 3=Milestone
      // DHTMLX strings: "task", "project", "milestone"
      const typeStr = r.type === 2 ? "project" : r.type === 3 ? "milestone" : "task";
      return {
        id: Number(r.id),
        project_id: Number(r.project_id),
        parent: r.parent != null ? Number(r.parent) : null,
        text: r.text ?? "",
        type: typeStr,
        start_date: r.start_date ? new Date(r.start_date).toISOString().slice(0, 19).replace("T", " ") : "",
        duration: Number(r.duration ?? 0),
        progress: Number(r.progress ?? 0),
        hide_client: Number(r.hide_client ?? 0),
        budget_category: r.budget_category_name ?? null,
        budget_category_full_name: r.budget_category_name ?? null,
        locations_room: null,
        published_id: r.published_id ?? null,
        published_task_id: r.published_task_id ?? null,
      };
    });
    return { tasks, links: [], hide_client: 0 };
  }

  // -------------------------------------------------------------------------
  // Budget (project-scoped, cells[9]=Sent POs total per category — matches
  // the HTTP shape that forecasts.ts + briefs.ts depend on)
  // -------------------------------------------------------------------------

  async getBudget(projectId: number | string): Promise<{
    items: Array<{
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
    }>;
    columns: string[];
  }> {
    const pid = Number(projectId);
    // Pull all budget rows for the project + the category name. Also
    // compute the sent-PO total per budget_category_id.
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT b.id, b.budget_category_id,
              bc.code AS category_code, bc.name AS category_name,
              b.amount_published, b.amount_working,
              b.fees_published, b.fees_working,
              b.allowance,
              (
                -- PR #82: PO→budget_category link lives on
                -- purchase_orders_items, not on the PO header. Sum
                -- the per-line items in that category.
                SELECT COALESCE(SUM(poi.total), 0)
                  FROM purchase_orders po
                  INNER JOIN purchase_orders_items poi
                          ON poi.purchase_order_id = po.id
                 WHERE po.project_id = b.project_id
                   AND po.status >= 2  -- Sent / Confirmed
                   AND po.change_order_id IS NULL
                   AND poi.budget_category_id = b.budget_category_id
              ) AS sent_po_total,
              (
                -- PR #82: CO→category mapping lives on
                -- change_orders_items, not the CO header. Sum approved
                -- CO line items in this category. Matches HTTP wrapper's
                -- publishedRevised exactly (verified Katchmark Countertops:
                -- $20,879.82 base + $34,711.18 CO impact = $55,591).
                SELECT COALESCE(SUM(coi.total + COALESCE(coi.fees_total, 0)), 0)
                  FROM change_orders co
                  INNER JOIN change_orders_items coi
                          ON coi.change_order_id = co.id
                 WHERE co.project_id = b.project_id
                   AND co.status = 3
                   AND co.deleted_at IS NULL
                   AND coi.budget_category_id = b.budget_category_id
              ) AS approved_co_total
         FROM budgets b
         LEFT JOIN budget_categories bc ON bc.id = b.budget_category_id
        WHERE b.project_id = ?
          AND b.deleted_working = 0
        ORDER BY bc.code ASC`,
      [pid],
    );
    // Some BT budget rows have category_code "" — derive a display name
    // from code + name like "1010 - Design".
    const items = rows.map((r) => {
      const fullName = [r.category_code, r.category_name].filter(Boolean).join(" - ") || (r.category_name ?? "");
      const publishedBudget = Number(r.amount_published ?? 0);
      const workingBudget = Number(r.amount_working ?? 0);
      const approvedCOs = Number(r.approved_co_total ?? 0);
      const publishedRevised = publishedBudget + approvedCOs;
      const workingRevised = workingBudget + approvedCOs;
      const sentPoTotal = Number(r.sent_po_total ?? 0);
      // cells[] index map per probe-budget.ts:
      // 0:empty, 1:BUDGET CATEGORY, 2:SUBCONTRACTORS, 3:INFO,
      // 4-5:empty, 6:BUDGET, 7:APPROVED CO'S, 8:REVISED BUDGET,
      // 9:SENT PO'S, 10:REMAINING BUDGET, 11:APPROVED INVOICES,
      // 12:BUDGET VS. ACTUAL, 13:PENDING CO'S, 14:PAID INVOICES,
      // 15:TOTAL INVOICES
      const cells: string[] = [
        "", fullName, "", "", "", "",
        fmtUsdStr(publishedBudget),       // BUDGET (we only fill published; the HTTP wrapper combines published+working)
        fmtUsdStr(approvedCOs),           // APPROVED CO'S
        fmtUsdStr(publishedRevised),      // REVISED BUDGET
        fmtUsdStr(sentPoTotal),           // SENT PO'S — the cell forecasts.ts reads
        "", "", "", "", "", "",
      ];
      return {
        id: String(r.id),
        categoryId: String(r.budget_category_id),
        name: fullName,
        isAllowance: Number(r.allowance) === 1,
        publishedBudget,
        workingBudget,
        approvedCOs,
        publishedRevised,
        workingRevised,
        cells,
      };
    });
    const columns = [
      "", "BUDGET CATEGORY", "SUBCONTRACTORS", "INFO", "", "",
      "BUDGET", "APPROVED CO'S", "REVISED BUDGET", "SENT PO'S",
      "REMAINING BUDGET", "APPROVED INVOICES", "BUDGET VS. ACTUAL",
      "PENDING CO'S", "PAID INVOICES", "TOTAL INVOICES",
    ];
    return { items, columns };
  }

  // -------------------------------------------------------------------------
  // Selections (project-scoped — only what briefs.ts consumes)
  // -------------------------------------------------------------------------

  async getSelections(projectId: number | string): Promise<{
    statusCount: Record<string, number>;
    selections: Array<{
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
    }>;
  }> {
    const pid = Number(projectId);
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT s.id, s.status, s.name, s.total, s.due_date, s.approved_date, s.rejected_date,
              s.created_at, s.updated_at,
              s.budget_category_id, bc.code AS bc_code, bc.name AS bc_name
         FROM selections s
         LEFT JOIN budget_categories bc ON bc.id = s.budget_category_id
        WHERE s.project_id = ?
        ORDER BY s.id DESC`,
      [pid],
    );
    const STATUS_LABELS: Record<number, string> = {
      1: "Open", 2: "Selecting", 3: "Selected", 4: "Approved",
      5: "Purchased", 6: "Rejected",
    };
    const statusCount: Record<string, number> = {};
    const selections = rows.map((r) => {
      const statusCode = Number(r.status);
      const label = STATUS_LABELS[statusCode] ?? `Status${statusCode}`;
      statusCount[label] = (statusCount[label] ?? 0) + 1;
      const cat = [r.bc_code, r.bc_name].filter(Boolean).join(" - ") || (r.bc_name ?? "");
      return {
        id: String(r.id),
        statusCode,
        status: label,
        category: cat,
        location: "",
        item: r.name ?? "",
        price: fmtUsdStr(Number(r.total ?? 0)),
        dueDate: r.due_date ? mmddyyyy(r.due_date) : "",
        selection: r.name ?? "",
        notes: "",
        createdAt: r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString().slice(0, 10) : null,
        approvedDate: r.approved_date ? new Date(r.approved_date).toISOString().slice(0, 10) : null,
        rejectedDate: r.rejected_date ? new Date(r.rejected_date).toISOString().slice(0, 10) : null,
      };
    });
    return { statusCount, selections };
  }

  // -------------------------------------------------------------------------
  // PR #83: list-style methods for the broader sweep.
  // Each mirrors the HTTP wrapper's return shape so tool handlers can swap
  // via `(api.db ?? api).getX(...)` with no other changes.
  // -------------------------------------------------------------------------

  /** companies — used by list_customers (type-filtered), search_companies, get_company. */
  async getCompanies<T = { data: Array<Record<string, unknown>>; recordsTotal?: number }>(
    opts: Record<string, unknown> = {},
  ): Promise<T> {
    const length = Math.max(1, Math.min(Number(opts["length"] ?? 100), 500));
    const search = String(opts["search[value]"] ?? "").trim();
    const where: string[] = [];
    const params: unknown[] = [];
    if (search) {
      where.push("(c.name LIKE ? OR c.email LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }
    // type filter (1=Customer, 2=Subcontractor, 3=Vendor per CLAUDE.md)
    if (opts["columns[1][search][value]"] !== undefined) {
      const typeFilter = String(opts["columns[1][search][value]"]);
      where.push("c.type = ?");
      params.push(Number(typeFilter));
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT c.id, c.name, c.type, c.type_name, c.email, c.phone, c.address, c.city, c.state, c.status
         FROM companies c
         ${whereSql}
         ORDER BY c.id DESC
         LIMIT ?`,
      [...params, length],
    );
    const data = rows.map((r) => ({
      DT_RowId: `row_${r.id}`,
      id: r.id,
      name: r.name ?? "",
      type: r.type,
      type_name: r.type_name ?? "",
      email: r.email ?? "",
      phone: r.phone ?? "",
      address: r.address ?? "",
      city: r.city ?? "",
      state: r.state ?? "",
      status: r.status,
    }));
    return { data, recordsTotal: data.length } as T;
  }

  /** searchCompanies — thin alias around getCompanies with the same `search[value]` shape. */
  async searchCompanies<T = unknown>(query: string, opts: Record<string, unknown> = {}): Promise<T> {
    return this.getCompanies<T>({ ...opts, "search[value]": query });
  }

  /** Single company detail row. */
  async getCompany<T = Record<string, unknown>>(id: number | string): Promise<T | null> {
    const cid = Number(id);
    if (!Number.isFinite(cid) || cid <= 0) return null;
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, name, type, type_name, email, phone, fax, address, city, state, zip, country, website, rating, status, created_at, updated_at
         FROM companies WHERE id = ? LIMIT 1`,
      [cid],
    );
    return (rows[0] as T) ?? null;
  }

  /** customers = companies of type 1. */
  async getCustomer<T = Record<string, unknown>>(id: number | string): Promise<T | null> {
    return this.getCompany<T>(id);
  }

  /** tasks datatable. */
  async getTasks<T = { data: Array<Record<string, unknown>>; recordsTotal?: number }>(
    opts: Record<string, unknown> = {},
  ): Promise<T> {
    const length = Math.max(1, Math.min(Number(opts["length"] ?? 100), 500));
    const projectId = opts["PR[]"] ?? opts["project_id"];
    const search = String(opts["search[value]"] ?? "").trim();
    const where: string[] = ["t.deleted_at IS NULL"];
    const params: unknown[] = [];
    if (projectId !== undefined && projectId !== null) {
      where.push("t.project_id = ?");
      params.push(Number(projectId));
    }
    if (search) {
      where.push("(t.name LIKE ? OR t.description LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT t.id, t.project_id, t.priority, t.status, t.name, t.due_date,
              t.created_at, t.updated_at,
              p.name AS project_name
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         ${whereSql}
         ORDER BY t.id DESC
         LIMIT ?`,
      [...params, length],
    );
    const data = rows.map((r) => ({
      DT_RowId: `row_${r.id}`,
      id: r.id,
      project_id: r.project_id,
      project_name: r.project_name,
      priority: r.priority,
      status: r.status,
      name: r.name ?? "",
      due_date: r.due_date ? mmddyyyy(r.due_date) : "",
      created_at: r.created_at ? mmddyyyy(r.created_at) : "",
    }));
    return { data, recordsTotal: data.length } as T;
  }

  async searchTasks<T = unknown>(query: string, limit: number = 50): Promise<T> {
    return this.getTasks<T>({ "search[value]": query, length: limit });
  }

  /** RFIs datatable. */
  async getRFIs<T = { data: Array<Record<string, unknown>>; recordsTotal?: number }>(
    opts: Record<string, unknown> = {},
  ): Promise<T> {
    const length = Math.max(1, Math.min(Number(opts["length"] ?? 100), 500));
    const projectId = opts["PR[]"] ?? opts["project_id"];
    const search = String(opts["search[value]"] ?? "").trim();
    const where: string[] = ["r.deleted_at IS NULL"];
    const params: unknown[] = [];
    if (projectId !== undefined && projectId !== null) {
      where.push("r.project_id = ?");
      params.push(Number(projectId));
    }
    if (search) {
      where.push("(r.subject LIKE ? OR r.description LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT r.id, r.project_id, r.priority, r.status, r.subject, r.due_date,
              r.created_at, r.number,
              p.name AS project_name
         FROM rfis r
         JOIN projects p ON p.id = r.project_id
         ${whereSql}
         ORDER BY r.id DESC
         LIMIT ?`,
      [...params, length],
    );
    const data = rows.map((r) => ({
      DT_RowId: `row_${r.id}`,
      id: r.id,
      project_id: r.project_id,
      project_name: r.project_name,
      priority: r.priority,
      status: r.status,
      number: r.number,
      subject: r.subject ?? "",
      due_date: r.due_date ? mmddyyyy(r.due_date) : "",
      created_at: r.created_at ? mmddyyyy(r.created_at) : "",
    }));
    return { data, recordsTotal: data.length } as T;
  }

  /** services datatable. */
  async getServices<T = { data: Array<Record<string, unknown>>; recordsTotal?: number }>(
    opts: Record<string, unknown> = {},
  ): Promise<T> {
    const length = Math.max(1, Math.min(Number(opts["length"] ?? 100), 500));
    const projectId = opts["PR[]"] ?? opts["project_id"];
    const where: string[] = ["s.deleted_at IS NULL"];
    const params: unknown[] = [];
    if (projectId !== undefined && projectId !== null) {
      where.push("s.project_id = ?");
      params.push(Number(projectId));
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT s.id, s.project_id, s.status, s.name, s.number, s.due_date, s.created_at,
              p.name AS project_name
         FROM services s
         JOIN projects p ON p.id = s.project_id
         ${whereSql}
         ORDER BY s.id DESC
         LIMIT ?`,
      [...params, length],
    );
    const data = rows.map((r) => ({
      DT_RowId: `row_${r.id}`,
      id: r.id,
      project_id: r.project_id,
      project_name: r.project_name,
      status: r.status,
      number: r.number,
      name: r.name ?? "",
      due_date: r.due_date ? mmddyyyy(r.due_date) : "",
      created_at: r.created_at ? mmddyyyy(r.created_at) : "",
    }));
    return { data, recordsTotal: data.length } as T;
  }

  /** users datatable. */
  async getUsers<T = { data: Array<Record<string, unknown>>; recordsTotal?: number }>(
    opts: Record<string, unknown> = {},
  ): Promise<T> {
    const length = Math.max(1, Math.min(Number(opts["length"] ?? 100), 500));
    const search = String(opts["search[value]"] ?? "").trim();
    const where: string[] = ["u.deleted_at IS NULL"];
    const params: unknown[] = [];
    if (search) {
      where.push("(u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.role, u.status, u.phone, u.title_name
         FROM users u
         ${whereSql}
         ORDER BY u.id DESC
         LIMIT ?`,
      [...params, length],
    );
    const data = rows.map((r) => ({
      DT_RowId: `row_${r.id}`,
      id: r.id,
      first_name: r.first_name ?? "",
      last_name: r.last_name ?? "",
      email: r.email ?? "",
      role: r.role,
      status: r.status,
      phone: r.phone ?? "",
      title_name: r.title_name ?? "",
    }));
    return { data, recordsTotal: data.length } as T;
  }

  async searchUsers<T = unknown>(query: string, limit: number = 50): Promise<T> {
    return this.getUsers<T>({ "search[value]": query, length: limit });
  }

  async getEmployees<T = unknown>(opts: Record<string, unknown> = {}): Promise<T> {
    // Employees are users with role=2.
    const length = Math.max(1, Math.min(Number(opts["length"] ?? 100), 500));
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, first_name, last_name, email, role, status, phone, title_name
         FROM users
        WHERE deleted_at IS NULL AND role = 2
        ORDER BY first_name ASC
        LIMIT ?`,
      [length],
    );
    const data = rows.map((r) => ({
      DT_RowId: `row_${r.id}`,
      id: r.id,
      first_name: r.first_name ?? "",
      last_name: r.last_name ?? "",
      email: r.email ?? "",
      role: r.role,
      status: r.status,
      phone: r.phone ?? "",
      title_name: r.title_name ?? "",
    }));
    return { data, recordsTotal: data.length } as T;
  }

  /** purchase_orders datatable. */
  async getPurchaseOrders<T = { data: Array<Record<string, unknown>>; recordsTotal?: number }>(
    opts: Record<string, unknown> = {},
  ): Promise<T> {
    const length = Math.max(1, Math.min(Number(opts["length"] ?? 100), 500));
    const projectId = opts["PR[]"] ?? opts["project_id"];
    const search = String(opts["search[value]"] ?? "").trim();
    const where: string[] = [];
    const params: unknown[] = [];
    if (projectId !== undefined && projectId !== null) {
      where.push("po.project_id = ?");
      params.push(Number(projectId));
    }
    if (search) {
      where.push("(po.name LIKE ? OR p.name LIKE ? OR c.name LIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT po.id, po.project_id, po.status, po.name, po.number, po.prefix, po.total,
              po.confirmed_date, po.created_at, po.change_order_id,
              p.name AS project_name,
              c.name AS company_name
         FROM purchase_orders po
         JOIN projects p ON p.id = po.project_id
         LEFT JOIN companies c ON c.id = po.company_id
         ${whereSql}
         ORDER BY po.id DESC
         LIMIT ?`,
      [...params, length],
    );
    const data = rows.map((r) => ({
      DT_RowId: `row_${r.id}`,
      id: r.id,
      project_id: r.project_id,
      project_name: r.project_name,
      company_name: r.company_name,
      status: r.status,
      number: r.number,
      prefix: r.prefix ?? "",
      name: r.name ?? "",
      total: fmtUsdStr(Number(r.total ?? 0)),
      confirmed_date: r.confirmed_date ? mmddyyyy(r.confirmed_date) : "",
      created_at: r.created_at ? mmddyyyy(r.created_at) : "",
      change_order_id: r.change_order_id,
    }));
    return { data, recordsTotal: data.length } as T;
  }

  async searchPurchaseOrders<T = unknown>(query: string, limit: number = 50): Promise<T> {
    return this.getPurchaseOrders<T>({ "search[value]": query, length: limit });
  }

  /** allowances — budgets where allowance=1, similar shape to getBudget items. */
  async getAllowances(projectId: string | number): Promise<Array<{
    id: string;
    categoryId: string;
    name: string;
    publishedBudget: number;
    workingBudget: number;
    approvedCOs: number;
    publishedRevised: number;
    workingRevised: number;
    cells: string[];
  }>> {
    const full = await this.getBudget(projectId);
    return full.items
      .filter((i) => i.isAllowance)
      .map(({ isAllowance: _i, ...rest }) => rest);
  }

  // -------------------------------------------------------------------------
  // Work-tracking: certificates, daily_logs, weekly_reports, work_days
  // -------------------------------------------------------------------------

  async getCertificates<T = { data: Array<Record<string, unknown>>; recordsTotal?: number }>(
    opts: Record<string, unknown> = {},
  ): Promise<T> {
    const length = Math.max(1, Math.min(Number(opts["length"] ?? 100), 500));
    const search = String(opts["search[value]"] ?? "").trim();
    const where: string[] = ["c.deleted_at IS NULL"];
    const params: unknown[] = [];
    if (search) {
      where.push("(c.policy_number LIKE ? OR co.name LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT c.id, c.status, c.policy_number, c.amount, c.expiration_date,
              co.name AS company_name, ct.name AS certificate_type
         FROM certificates c
         LEFT JOIN companies co ON co.id = c.company_id
         LEFT JOIN certificates_types ct ON ct.id = c.certificates_type_id
         ${whereSql}
         ORDER BY c.id DESC
         LIMIT ?`,
      [...params, length],
    );
    const data = rows.map((r) => ({
      DT_RowId: `row_${r.id}`,
      id: r.id,
      status: r.status,
      policy_number: r.policy_number ?? "",
      amount: fmtUsdStr(Number(r.amount ?? 0)),
      expiration_date: r.expiration_date ? mmddyyyy(r.expiration_date) : "",
      company_name: r.company_name ?? "",
      certificate_type: r.certificate_type ?? "",
    }));
    return { data, recordsTotal: data.length } as T;
  }

  async searchCertificates<T = unknown>(query: string, limit: number = 50): Promise<T> {
    return this.getCertificates<T>({ "search[value]": query, length: limit });
  }

  async getDailyLogs<T = { data: Array<Record<string, unknown>>; recordsTotal?: number }>(
    opts: Record<string, unknown> = {},
  ): Promise<T> {
    const length = Math.max(1, Math.min(Number(opts["length"] ?? 100), 500));
    const projectId = opts["PR[]"] ?? opts["project_id"];
    const where: string[] = ["d.deleted_at IS NULL"];
    const params: unknown[] = [];
    if (projectId !== undefined && projectId !== null) {
      where.push("d.project_id = ?");
      params.push(Number(projectId));
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT d.id, d.project_id, d.date, d.created_at,
              p.name AS project_name
         FROM daily_logs d
         JOIN projects p ON p.id = d.project_id
         ${whereSql}
         ORDER BY d.date DESC, d.id DESC
         LIMIT ?`,
      [...params, length],
    );
    const data = rows.map((r) => ({
      DT_RowId: `row_${r.id}`,
      id: r.id,
      project_id: r.project_id,
      project_name: r.project_name,
      date: r.date ? mmddyyyy(r.date) : "",
      created_at: r.created_at ? mmddyyyy(r.created_at) : "",
    }));
    return { data, recordsTotal: data.length } as T;
  }

  async getWeeklyReports<T = { data: Array<Record<string, unknown>>; recordsTotal?: number }>(
    opts: Record<string, unknown> = {},
  ): Promise<T> {
    const length = Math.max(1, Math.min(Number(opts["length"] ?? 100), 500));
    const projectId = opts["PR[]"] ?? opts["project_id"];
    const where: string[] = ["w.deleted_at IS NULL"];
    const params: unknown[] = [];
    if (projectId !== undefined && projectId !== null) {
      where.push("w.project_id = ?");
      params.push(Number(projectId));
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT w.id, w.project_id, w.name, w.status, w.created_at,
              p.name AS project_name
         FROM weekly_reports w
         JOIN projects p ON p.id = w.project_id
         ${whereSql}
         ORDER BY w.id DESC
         LIMIT ?`,
      [...params, length],
    );
    const data = rows.map((r) => ({
      DT_RowId: `row_${r.id}`,
      id: r.id,
      project_id: r.project_id,
      project_name: r.project_name,
      name: r.name ?? "",
      status: r.status,
      created_at: r.created_at ? mmddyyyy(r.created_at) : "",
    }));
    return { data, recordsTotal: data.length } as T;
  }

  async getWorkDays<T = { data: Array<Record<string, unknown>>; recordsTotal?: number }>(
    opts: Record<string, unknown> = {},
  ): Promise<T> {
    const length = Math.max(1, Math.min(Number(opts["length"] ?? 100), 500));
    const projectId = opts["PR[]"] ?? opts["project_id"];
    const where: string[] = [];
    const params: unknown[] = [];
    if (projectId !== undefined && projectId !== null) {
      where.push("project_id = ?");
      params.push(Number(projectId));
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, project_id, is_working_day, type, start_date, end_date, description, notes
         FROM work_days
         ${whereSql}
         ORDER BY start_date DESC
         LIMIT ?`,
      [...params, length],
    );
    const data = rows.map((r) => ({
      DT_RowId: `row_${r.id}`,
      id: r.id,
      project_id: r.project_id,
      is_working_day: r.is_working_day,
      type: r.type,
      start_date: r.start_date ? mmddyyyy(r.start_date) : "",
      end_date: r.end_date ? mmddyyyy(r.end_date) : "",
      description: r.description ?? "",
      notes: r.notes ?? "",
    }));
    return { data, recordsTotal: data.length } as T;
  }
}

// ---------------------------------------------------------------------------
// Factory: build from env when MYSQL_HOST is present, else null (no fast path)
// ---------------------------------------------------------------------------

export function buildMossDbFromEnv(env: NodeJS.ProcessEnv = process.env): MossDb | null {
  if (!env.MYSQL_HOST || !env.MYSQL_USER || !env.MYSQL_PASSWORD || !env.MYSQL_DATABASE) {
    return null;
  }
  return new MossDb({
    host: env.MYSQL_HOST,
    port: env.MYSQL_PORT ? Number(env.MYSQL_PORT) : 3306,
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE,
    ssl: { rejectUnauthorized: false },
  });
}

export const __test__ = { fsStatusLabel, mmddyyyy };
