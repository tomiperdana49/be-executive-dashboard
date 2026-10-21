import { type Pool } from 'mysql2/promise'
import { ISalesPerformanceRepository } from '../interfaces/sales-performance.repository.interface'

export class SalesPerformanceRepository implements ISalesPerformanceRepository {
    constructor(
        private readonly nisDb: Pool,
        private readonly dashboardDb: Pool,
        private readonly nusaprospectDb: Pool
    ) {}

    /**
     * Get list of staff-level sales employees from the sales table.
     * If managerId is provided, filters by manager_id as well.
     * If branchId is provided, filters by branch_id as well.
     * If type is provided, filters by type (access_home / access_business) as well.
     *
     * @param {number} [managerId] - Optional manager ID to filter by.
     * @param {string} [branchId] - Optional branch ID to filter by.
     * @param {string} [type] - Optional sales type to filter by.
     * @returns {Promise<Array<{ employeeId: string; name: string; photoProfile: string }>>} Staff list.
     */
    async getStaffList(managerId?: number, branchId?: string, type?: string): Promise<Array<{ id: number; employeeId: string; email: string; name: string; photoProfile: string; organizationName: string; type: string }>> {
        let query = `SELECT id, employee_id, email, name, photo_profile, organization_name, type FROM sales WHERE job_level = 'staff'`
        const params: any[] = []

        if (managerId) {
            query += ` AND manager_id = ?`
            params.push(managerId)
        }

        if (branchId) {
            query += ` AND branch_id = ?`
            params.push(branchId)
        }

        if (type) {
            query += ` AND type = ?`
            params.push(type)
        }

        query += ` ORDER BY name ASC`

        const [rows] = await this.dashboardDb.query<any[]>(query, params)

        return rows.map((row: any) => ({
            id: Number(row.id),
            employeeId: row.employee_id,
            email: row.email || '',
            name: row.name,
            photoProfile: row.photo_profile || '',
            organizationName: row.organization_name || '',
            type: row.type || ''
        }))
    }

    /**
     * Daily paid new-registration (weighted) per sales employee (NIS).
     * Each paid access_home invoice contributes a ServiceId weight (0.3 for
     * NFSM030/NFST030/NFSP030/NFSP300/NFSF030/NFSF001/NFSP100; 0.5 for NFSP200;
     * else 1), summed per sales per day and bucketed by the paid date
     * (MAX paying-batch TransDate). Keyed by SalesId (= sales employee_id).
     *
     * @param {string[]} employeeIds - List of sales employee IDs.
     * @param {number} month - Month number (1-12).
     * @param {number} year - Full year (e.g. 2026).
     * @returns {Promise<Array<{ salesId: string; day: number; count: number }>>} Daily counts keyed by employee ID.
     */
    async getHomeDailyRegistration(employeeIds: string[], month: number, year: number): Promise<Array<{ salesId: string; day: number; count: number }>> {
        if (!employeeIds.length) return []

        const startDate = `${year}-${String(month).padStart(2, '0')}-01`
        const endDate = `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`

        // Paid new-registration (weighted) per sales per day. Each paid invoice (one
        // row per nci.AI) contributes a weight by ServiceId; bucketed by paid date
        // (MAX NewCustomerInvoice.TransDate of the paying batch).
        const [rows] = await this.nisDb.query<any[]>(
            `SELECT sales_id, DAY(paid_date) AS day_num, ROUND(SUM(weight), 2) AS total
            FROM (
                SELECT
                    nci.AI AS ai,
                    cs.SalesId AS sales_id,
                    MAX(nci2.TransDate) AS paid_date,
                    CASE
                        WHEN s.ServiceId IN ('NFSM030','NFST030','NFSP030','NFSP300','NFSF030','NFSF001','NFSP100') THEN 1/3
                        WHEN s.ServiceId = 'NFSP200' THEN 0.5
                        ELSE 1
                    END AS weight
                FROM CustomerInvoiceTemp cit
                    LEFT JOIN InvoiceTypeMonth itm ON itm.InvoiceType = cit.InvoiceType
                    LEFT JOIN NewCustomerInvoice nci ON cit.InvoiceNum = nci.Id AND nci.No = cit.Urut AND nci.Type = 'internet'
                    LEFT JOIN NewCustomerInvoiceBatch ncib ON nci.AI = ncib.AI
                    LEFT JOIN NewCustomerInvoiceBatch ncib2 ON ncib.batchNo = ncib2.batchNo AND ncib2.AI != ncib.AI AND ncib2.total > 0
                    LEFT JOIN NewCustomerInvoice nci2 ON ncib2.AI = nci2.AI
                    LEFT JOIN CustomerServices cs ON cit.CustServId = cs.CustServId
                    LEFT JOIN Services s ON s.ServiceId = cs.ServiceId
                    LEFT JOIN Customer c ON c.CustId = cs.CustId
                    LEFT JOIN NewCustomerInvoiceInternetCounter nciic ON nciic.AI = nci.AI
                WHERE cit.RInvoiceNum = 0
                    AND (ncib.batchNo IS NULL OR nci2.Type = 'RA02')
                    AND ncib.batchNo IS NOT NULL
                    AND (
                        IFNULL(c.DisplayBranchId, c.BranchId) IN ('020','062','025','027','029')
                        OR (
                            IFNULL(c.DisplayBranchId, c.BranchId) IN ('028')
                            AND nciic.new_subscription > 110000
                            AND cs.SalesId NOT IN ('0208801')
                        )
                    )
                    AND s.ServiceCategory = 'access_home'
                    AND nciic.is_upgrade = 0
                    AND nciic.is_prorata = 0
                    AND nciic.new_subscription > 0
                    AND (
                        (DATE(nci.InsertDate) BETWEEN ? AND ?)
                        OR (nci2.TransDate IS NOT NULL AND nci2.TransDate BETWEEN ? AND ?)
                    )
                    AND cs.CustServId IS NOT NULL
                    AND cs.SalesId IN (?)
                GROUP BY nci.AI
            ) x
            WHERE x.paid_date IS NOT NULL
                AND DATE(x.paid_date) BETWEEN ? AND ?
            GROUP BY x.sales_id, DAY(x.paid_date)`,
            [startDate, endDate, startDate, endDate, employeeIds, startDate, endDate]
        )

        return rows.map((row: any) => ({
            salesId: String(row.sales_id),
            day: Number(row.day_num),
            count: Number(row.total)
        }))
    }

    /**
     * Count daily access_business activity for a list of sales emails in a given month/year.
     * Queries the NusaProspect database: activity = customer_log_calls + prospect_tasks +
     * prospect_check_ins, counted per created_at day. Sales are matched to NusaProspect users
     * via tenant_users.email (= sales.email) -> tenant_users.user_uuid -> activity user id.
     * Keyed by sales email.
     *
     * @param {string[]} emails - List of sales emails.
     * @param {number} month - Month number (1-12).
     * @param {number} year - Full year (e.g. 2026).
     * @returns {Promise<Array<{ email: string; day: number; count: number }>>} Daily counts keyed by email.
     */
    async getBusinessDailyActivity(emails: string[], month: number, year: number): Promise<Array<{ email: string; day: number; count: number }>> {
        if (!emails.length) return []

        const startDate = `${year}-${String(month).padStart(2, '0')}-01`
        const endDate = `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`

        const [rows] = await this.nusaprospectDb.query<any[]>(
            `SELECT
                tu.email AS email,
                a.day_num AS day_num,
                COUNT(*) AS total
            FROM tenant_users tu
            JOIN (
                SELECT IFNULL(clc.assigned_to_id, clc.created_by) AS user_id, DAY(clc.created_at) AS day_num
                FROM customer_log_calls clc
                WHERE DATE(clc.created_at) BETWEEN ? AND ?
                UNION ALL
                SELECT IFNULL(pt.assigned_to_id, pt.created_by) AS user_id, DAY(pt.created_at) AS day_num
                FROM prospect_tasks pt
                WHERE DATE(pt.created_at) BETWEEN ? AND ?
                UNION ALL
                SELECT pci.user_uuid AS user_id, DAY(pci.created_at) AS day_num
                FROM prospect_check_ins pci
                WHERE DATE(pci.created_at) BETWEEN ? AND ?
            ) a ON a.user_id = tu.user_uuid
            WHERE tu.email IN (?)
            GROUP BY tu.email, a.day_num`,
            [startDate, endDate, startDate, endDate, startDate, endDate, emails]
        )

        return rows.map((row: any) => ({
            email: String(row.email),
            day: Number(row.day_num),
            count: Number(row.total)
        }))
    }

    /**
     * Look up a single sales row (dashboard) by its id.
     *
     * @param {number} id - Sales table primary key.
     * @returns {Promise<{ employeeId: string; email: string; type: string } | null>} Sales identity or null.
     */
    async getSalesById(id: number): Promise<{ employeeId: string; email: string; type: string } | null> {
        const [rows] = await this.dashboardDb.query<any[]>(
            `SELECT employee_id, email, type FROM sales WHERE id = ? LIMIT 1`,
            [id]
        )
        if (!rows.length) return null
        return { employeeId: rows[0].employee_id, email: rows[0].email || '', type: rows[0].type || '' }
    }

    /**
     * Detail of access_home registrations for a sales employee on a specific date (NIS).
     *
     * @param {string} employeeId - Sales employee ID (= SalesId).
     * @param {string} date - Date string 'YYYY-MM-DD'.
     * @returns {Promise<Array<{ custServId: string; accountNumber: string; customerName: string; serviceId: string; date: string }>>}
     */
    async getHomeRegistrationDetail(employeeId: string, date: string): Promise<Array<{ customerId: string; customerName: string; accountName: string; serviceId: string; serviceName: string; weight: number; date: string }>> {
        // Same source as the Home achievement metric: paid invoices whose paid date
        // (MAX paying-batch TransDate) falls on `date`, one row per invoice (nci.AI),
        // so the rows and their summed weights match the cell value.
        const [yy, mm] = date.split('-')
        const startDate = `${yy}-${mm}-01`
        const endDate = `${yy}-${mm}-${new Date(Number(yy), Number(mm), 0).getDate()}`

        const [rows] = await this.nisDb.query<any[]>(
            `SELECT customerId, customerName, accountName, serviceId, serviceName, weight, paid_date
            FROM (
                SELECT
                    nci.AI AS ai,
                    c.CustId AS customerId,
                    c.CustName AS customerName,
                    cs.CustAccName AS accountName,
                    s.ServiceId AS serviceId,
                    s.ServiceType AS serviceName,
                    MAX(nci2.TransDate) AS paid_date,
                    CASE
                        WHEN s.ServiceId IN ('NFSM030','NFST030','NFSP030','NFSP300','NFSF030','NFSF001','NFSP100') THEN 1/3
                        WHEN s.ServiceId = 'NFSP200' THEN 0.5
                        ELSE 1
                    END AS weight
                FROM CustomerInvoiceTemp cit
                    LEFT JOIN InvoiceTypeMonth itm ON itm.InvoiceType = cit.InvoiceType
                    LEFT JOIN NewCustomerInvoice nci ON cit.InvoiceNum = nci.Id AND nci.No = cit.Urut AND nci.Type = 'internet'
                    LEFT JOIN NewCustomerInvoiceBatch ncib ON nci.AI = ncib.AI
                    LEFT JOIN NewCustomerInvoiceBatch ncib2 ON ncib.batchNo = ncib2.batchNo AND ncib2.AI != ncib.AI AND ncib2.total > 0
                    LEFT JOIN NewCustomerInvoice nci2 ON ncib2.AI = nci2.AI
                    LEFT JOIN CustomerServices cs ON cit.CustServId = cs.CustServId
                    LEFT JOIN Services s ON s.ServiceId = cs.ServiceId
                    LEFT JOIN Customer c ON c.CustId = cs.CustId
                    LEFT JOIN NewCustomerInvoiceInternetCounter nciic ON nciic.AI = nci.AI
                WHERE cit.RInvoiceNum = 0
                    AND (ncib.batchNo IS NULL OR nci2.Type = 'RA02')
                    AND ncib.batchNo IS NOT NULL
                    AND (
                        IFNULL(c.DisplayBranchId, c.BranchId) IN ('020','062','025','027','029')
                        OR (
                            IFNULL(c.DisplayBranchId, c.BranchId) IN ('028')
                            AND nciic.new_subscription > 110000
                            AND cs.SalesId NOT IN ('0208801')
                        )
                    )
                    AND s.ServiceCategory = 'access_home'
                    AND nciic.is_upgrade = 0
                    AND nciic.is_prorata = 0
                    AND nciic.new_subscription > 0
                    AND (
                        (DATE(nci.InsertDate) BETWEEN ? AND ?)
                        OR (nci2.TransDate IS NOT NULL AND nci2.TransDate BETWEEN ? AND ?)
                    )
                    AND cs.CustServId IS NOT NULL
                    AND cs.SalesId = ?
                GROUP BY nci.AI
            ) x
            WHERE x.paid_date IS NOT NULL
                AND DATE(x.paid_date) = ?
            ORDER BY x.paid_date ASC`,
            [startDate, endDate, startDate, endDate, employeeId, date]
        )
        return rows.map((row: any) => ({
            customerId: row.customerId != null ? String(row.customerId) : '',
            customerName: row.customerName || '',
            accountName: row.accountName || '',
            serviceId: row.serviceId || '',
            serviceName: row.serviceName || '',
            weight: Number(row.weight) || 0,
            date: row.paid_date
        }))
    }

    /**
     * Detail of access_business activity for a sales email on a specific date (NusaProspect).
     * Activity = customer_log_calls + prospect_tasks + prospect_check_ins.
     *
     * @param {string} email - Sales email (matched to tenant_users.email).
     * @param {string} date - Date string 'YYYY-MM-DD'.
     * @returns {Promise<Array<{ type: string; at: string }>>}
     */
    async getBusinessActivityDetail(email: string, date: string): Promise<Array<{ type: string; at: string }>> {
        if (!email) return []
        const [rows] = await this.nusaprospectDb.query<any[]>(
            `SELECT a.type AS type, a.at AS at
            FROM tenant_users tu
            JOIN (
                SELECT IFNULL(clc.assigned_to_id, clc.created_by) AS user_id, 'Call' AS type, clc.created_at AS at
                    FROM customer_log_calls clc WHERE DATE(clc.created_at) = ?
                UNION ALL
                SELECT IFNULL(pt.assigned_to_id, pt.created_by) AS user_id, 'Task' AS type, pt.created_at AS at
                    FROM prospect_tasks pt WHERE DATE(pt.created_at) = ?
                UNION ALL
                SELECT pci.user_uuid AS user_id, 'Check-in' AS type, pci.created_at AS at
                    FROM prospect_check_ins pci WHERE DATE(pci.created_at) = ?
            ) a ON a.user_id = tu.user_uuid
            WHERE tu.email = ?
            ORDER BY a.at ASC`,
            [date, date, date, email]
        )
        return rows.map((row: any) => ({ type: row.type, at: row.at }))
    }

    /**
     * Get list of manager-level employees from the sales table.
     * Filters by job_level IN ('Manager', 'General Manager').
     * If type is provided, filters by type (access_home / access_business) as well.
     *
     * @param {string} [type] - Optional sales type to filter by.
     * @param {string} [branchId] - Optional branch ID to filter by.
     * @returns {Promise<Array<{ id: number; name: string; employeeId: string; photoProfile: string }>>} Manager list.
     */
    async getManagers(type?: string, branchId?: string): Promise<Array<{ id: number; name: string; employeeId: string; photoProfile: string }>> {
        let query = `SELECT id, name, employee_id, photo_profile
             FROM sales
             WHERE job_level IN ('Manager', 'General Manager')`
        const params: any[] = []

        if (type) {
            query += ` AND type = ?`
            params.push(type)
        }

        if (branchId) {
            query += ` AND branch_id = ?`
            params.push(branchId)
        }

        query += ` ORDER BY name ASC`

        const [rows] = await this.dashboardDb.query<any[]>(query, params)

        return rows.map((row: any) => ({
            id: Number(row.id),
            name: row.name,
            employeeId: row.employee_id,
            photoProfile: row.photo_profile || ''
        }))
    }

    /**
     * New MRC (paid, this month) per access_business sales. Mirrors the growth
     * module's New MRC logic (paid batch date, discount, period-amortised amount)
     * but attributes each invoice to a sales via CustomerServices.SalesId
     * (= sales.employee_id). Keyed by SalesId.
     *
     * @param {string} monthStart - Month start 'YYYY-MM-DD'.
     * @param {string} monthEnd - Month end 'YYYY-MM-DD'.
     * @returns {Promise<Array<{ salesId: string; mrcMonth: number }>>}
     */
    async getBusinessWeeklyMrc(
        monthStart: string, monthEnd: string
    ): Promise<Array<{ salesId: string; mrcMonth: number }>> {
        const [rows] = await this.nisDb.query<any[]>(
            `WITH invoice_data AS (
                SELECT
                    nci.AI AS ai,
                    cs.SalesId AS sales_id,
                    cit.CustServId AS cust_serv_id,
                    cit.ServiceId AS service_id,
                    cit.Date AS inv_order_date,
                    cit.InvoiceNum AS inv_num,
                    cit.Urut AS inv_urut,
                    nci.Credit AS credit,
                    IF(cit.InvoiceType != 8, itm.Month, 1) AS inv_period,
                    IFNULL(nci2.JournalDate, nci2.TransDate) AS paid_date
                FROM CustomerInvoiceTemp cit
                LEFT JOIN InvoiceTypeMonth itm ON itm.InvoiceType = cit.InvoiceType
                LEFT JOIN NewCustomerInvoice nci ON nci.Id = cit.InvoiceNum AND nci.No = cit.Urut
                LEFT JOIN NewCustomerInvoiceBatch ncib ON ncib.AI = nci.AI
                LEFT JOIN (
                    SELECT ncib.batchNo, nci.JournalDate, nci.TransDate,
                        ROW_NUMBER() OVER (PARTITION BY ncib.batchNo ORDER BY nci.Date DESC) AS RowNum
                    FROM NewCustomerInvoice nci
                    LEFT JOIN NewCustomerInvoiceBatch ncib ON ncib.AI = nci.AI
                    WHERE nci.Type LIKE 'RA%'
                        AND nci.Date >= DATE_SUB(?, INTERVAL 3 MONTH)
                ) nci2 ON nci2.batchNo = ncib.batchNo AND nci2.RowNum = 1
                LEFT JOIN Services s ON s.ServiceId = cit.ServiceId
                LEFT JOIN Customer c ON c.CustId = cit.CustId
                LEFT JOIN CustomerServices cs ON cs.CustServId = cit.CustServId
                WHERE cit.RInvoiceNum = 0
                    AND cit.InvProrata = 0
                    AND c.BranchId = '020'
                    AND s.ServiceCategory = 'access_business'
                    -- Cicilan Perangkat is recurring (counted as New MRC) but booked to 401.xxx
                    AND (nci.AccCode LIKE '400%' OR s.ServiceId = 'CICILALAT')
                    -- BOD is OTC, not New MRC
                    AND LOWER(s.ServiceType) NOT LIKE '%bandwidth on demand%'
            ),
            discount_data AS (
                SELECT nci.AI AS ai, ncid.Debet AS discount
                FROM CustomerInvoiceDiscount cid
                LEFT JOIN NewCustomerInvoice ncid
                    ON ncid.Id = cid.Id AND ncid.Type = 'discount'
                LEFT JOIN CustomerInvoiceTemp cit
                    ON cit.InvoiceNum = cid.InvoiceNum AND cit.Urut = cid.Urut
                LEFT JOIN NewCustomerInvoice nci
                    ON nci.Id = cid.InvoiceNum AND nci.No = cid.Urut
                WHERE cit.RInvoiceNum = 0
            ),
            priced_data AS (
                SELECT t.*,
                    ((t.credit - IFNULL(d.discount, 0)) / 1.11) / NULLIF(t.inv_period, 0) AS monthly_amount
                FROM invoice_data t
                LEFT JOIN discount_data d ON d.ai = t.ai
            ),
            sequenced_data AS (
                SELECT p.*,
                    ROW_NUMBER() OVER (PARTITION BY p.cust_serv_id ORDER BY p.inv_order_date, p.inv_num, p.inv_urut) AS rn,
                    LAG(p.service_id) OVER (PARTITION BY p.cust_serv_id ORDER BY p.inv_order_date, p.inv_num, p.inv_urut) AS prev_service_id,
                    LAG(p.monthly_amount) OVER (PARTITION BY p.cust_serv_id ORDER BY p.inv_order_date, p.inv_num, p.inv_urut) AS prev_monthly_amount
                FROM priced_data p
            ),
            mrc_data AS (
                -- New service: full amount. Upgrade (ServiceId changed to a pricier one): the difference only.
                SELECT t.sales_id, DATE(t.paid_date) AS paid_day,
                    IF(t.rn = 1, t.monthly_amount, t.monthly_amount - t.prev_monthly_amount) AS amount
                FROM sequenced_data t
                WHERE (
                        t.rn = 1
                        OR (t.service_id != t.prev_service_id AND t.monthly_amount > t.prev_monthly_amount)
                    )
                    AND t.paid_date IS NOT NULL
                    AND DATE(t.paid_date) BETWEEN ? AND ?
            )
            SELECT
                sales_id,
                ROUND(SUM(amount)) AS mrc_month
            FROM mrc_data
            WHERE sales_id IS NOT NULL
            GROUP BY sales_id`,
            [monthStart, monthStart, monthEnd]
        )

        return rows.map((row: any) => ({
            salesId: String(row.sales_id),
            mrcMonth: Number(row.mrc_month || 0)
        }))
    }

    /**
     * Access_business activity count (this week) per sales email. Activity =
     * customer_log_calls + prospect_tasks + prospect_check_ins, matched via
     * tenant_users.email -> user_uuid. Keyed by email.
     *
     * @param {string[]} emails - List of sales emails.
     * @param {string} weekStart - Week start 'YYYY-MM-DD'.
     * @param {string} weekEnd - Week end 'YYYY-MM-DD'.
     * @returns {Promise<Array<{ email: string; actThisWeek: number }>>}
     */
    async getBusinessWeeklyActivity(
        emails: string[], weekStart: string, weekEnd: string
    ): Promise<Array<{ email: string; actThisWeek: number }>> {
        if (!emails.length) return []

        const [rows] = await this.nusaprospectDb.query<any[]>(
            `SELECT tu.email AS email, COUNT(*) AS act_this_week
            FROM tenant_users tu
            JOIN (
                SELECT IFNULL(clc.assigned_to_id, clc.created_by) AS user_id
                    FROM customer_log_calls clc WHERE DATE(clc.created_at) BETWEEN ? AND ?
                UNION ALL
                SELECT IFNULL(pt.assigned_to_id, pt.created_by) AS user_id
                    FROM prospect_tasks pt WHERE DATE(pt.created_at) BETWEEN ? AND ?
                UNION ALL
                SELECT pci.user_uuid AS user_id
                    FROM prospect_check_ins pci WHERE DATE(pci.created_at) BETWEEN ? AND ?
            ) a ON a.user_id = tu.user_uuid
            WHERE tu.email IN (?)
            GROUP BY tu.email`,
            [weekStart, weekEnd, weekStart, weekEnd, weekStart, weekEnd, emails]
        )

        return rows.map((row: any) => ({
            email: String(row.email),
            actThisWeek: Number(row.act_this_week || 0)
        }))
    }
}
