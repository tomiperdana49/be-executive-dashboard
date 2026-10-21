import { type Pool } from 'mysql2/promise'
import { IGrowthRepository } from '../interfaces/growth.repository.interface'
import { BranchHelper } from '../../../../core/helpers/branch'

/**
 * Repository for handling growth-related database queries
 * Interfaces with multiple databases: nisDb (billing), prospectDb (CRM), and dashboardDb (targets)
 */
export class GrowthRepository implements IGrowthRepository {
    constructor(
        private readonly nisDb: Pool,
        private readonly prospectDb: Pool,
        private readonly dashboardDb: Pool
    ) {}

    /**
     * Query New MRC (Monthly Recurring Charge)
     * Calculates the recurring revenue generated from new customers
     * 
     * @param {string} branchId - The branch identifier
     * @param {string} startDate - Query start date
     * @param {string} endDate - Query end date
     * @returns {Promise<{mrc: number, mrc_unpaid: number, mrc_paid: number}>} MRC breakdown
     */
    async getNewMrc(branchId: string, startDate: string, endDate: string): Promise<{ mrc: number; mrc_unpaid: number; mrc_paid: number }> {
        const branch = BranchHelper.displayFilter(branchId)
        const [rows] = await this.nisDb.query<any[]>(
            `WITH params AS (
                SELECT
                    CAST(? AS DATE) AS start_date,
                    DATE_ADD(CAST(? AS DATE), INTERVAL 1 DAY) AS end_date
            ),
            invoice_data AS (
                SELECT
                    nci.AI AS ai,
                    cit.CustServId AS cust_serv_id,
                    cit.ServiceId AS service_id,
                    cit.Date AS inv_order_date,
                    cit.InvoiceNum AS inv_num,
                    cit.Urut AS inv_urut,
                    nci.Credit AS credit,
                    IF(
                        cit.InvoiceType != 8,
                        itm.Month,
                        1
                    ) AS inv_period,
                    IFNULL(
                        nci2.JournalDate,
                        nci2.TransDate
                    ) AS paid_date,
                    IFNULL(
                        nci.InsertDate,
                        nci.Date
                    ) AS inv_date,
                    nci2.batchNo AS batch_no
                FROM CustomerInvoiceTemp cit
                CROSS JOIN params p
                LEFT JOIN InvoiceTypeMonth itm
                    ON itm.InvoiceType = cit.InvoiceType
                LEFT JOIN NewCustomerInvoice nci
                    ON nci.Id = cit.InvoiceNum
                    AND nci.No = cit.Urut
                LEFT JOIN NewCustomerInvoiceBatch ncib
                    ON ncib.AI = nci.AI
                LEFT JOIN (
                    SELECT
                        ncib.batchNo,
                        nci.*,
                        ROW_NUMBER() OVER (
                            PARTITION BY ncib.batchNo
                            ORDER BY nci.Date DESC
                        ) AS RowNum
                    FROM NewCustomerInvoice nci
                    LEFT JOIN NewCustomerInvoiceBatch ncib
                        ON ncib.AI = nci.AI
                    WHERE nci.Type LIKE 'RA%'
                ) nci2
                    ON nci2.batchNo = ncib.batchNo
                    AND nci2.RowNum = 1
                LEFT JOIN Services s
                    ON s.ServiceId = cit.ServiceId
                LEFT JOIN Customer c
                    ON c.CustId = cit.CustId
                WHERE cit.RInvoiceNum = 0
                    AND cit.InvProrata = 0
                    AND c.BranchId = '020'
                    AND ${branch.sql}
                    AND s.ServiceCategory = 'access_business'
                    -- Cicilan Perangkat is recurring (counted as New MRC) but booked to 401.xxx
                    AND (nci.AccCode LIKE '400%' OR s.ServiceId = 'CICILALAT')
                    -- BOD is OTC, not New MRC
                    AND LOWER(s.ServiceType) NOT LIKE '%bandwidth on demand%'
            ),
            discount_data AS (
                SELECT
                    nci.AI AS ai,
                    ncid.Debet AS discount
                FROM CustomerInvoiceDiscount cid
                LEFT JOIN NewCustomerInvoice ncid
                    ON ncid.Id = cid.Id
                    AND ncid.Type = 'discount'
                LEFT JOIN CustomerInvoiceTemp cit
                    ON cit.InvoiceNum = cid.InvoiceNum
                    AND cit.Urut = cid.Urut
                LEFT JOIN NewCustomerInvoice nci
                    ON nci.Id = cid.InvoiceNum
                    AND nci.No = cid.Urut
                WHERE cit.RInvoiceNum = 0
            ),
            priced_data AS (
                SELECT
                    t.*,
                    (
                        (t.credit - IFNULL(d.discount, 0)) / 1.11
                    ) / NULLIF(t.inv_period, 0) AS monthly_amount
                FROM invoice_data t
                LEFT JOIN discount_data d
                    ON d.ai = t.ai
            ),
            sequenced_data AS (
                SELECT
                    p.*,
                    ROW_NUMBER() OVER (
                        PARTITION BY p.cust_serv_id
                        ORDER BY p.inv_order_date, p.inv_num, p.inv_urut
                    ) AS rn,
                    LAG(p.service_id) OVER (
                        PARTITION BY p.cust_serv_id
                        ORDER BY p.inv_order_date, p.inv_num, p.inv_urut
                    ) AS prev_service_id,
                    LAG(p.monthly_amount) OVER (
                        PARTITION BY p.cust_serv_id
                        ORDER BY p.inv_order_date, p.inv_num, p.inv_urut
                    ) AS prev_monthly_amount
                FROM priced_data p
            ),
            mrc_data AS (
                /* New service: full amount. Upgrade (ServiceId changed to a pricier one): the difference only. */
                SELECT
                    t.ai,
                    t.paid_date,
                    t.inv_date,
                    t.batch_no,
                    IF(
                        t.rn = 1,
                        t.monthly_amount,
                        t.monthly_amount - t.prev_monthly_amount
                    ) AS amount
                FROM sequenced_data t
                WHERE t.rn = 1
                    OR (
                        t.service_id != t.prev_service_id
                        AND t.monthly_amount > t.prev_monthly_amount
                    )
            )
            SELECT
                /* New MRC yang diambil dari paid saja */
                COALESCE(
                    SUM(
                        CASE
                            WHEN m.paid_date >= p.start_date
                                AND m.paid_date < p.end_date
                            THEN m.amount
                            ELSE 0
                        END
                    ),
                    0
                ) AS mrc,
                /* New MRC yang sudah payment */
                COALESCE(
                    SUM(
                        CASE
                            WHEN m.paid_date >= p.start_date
                                AND m.paid_date < p.end_date
                            THEN m.amount
                            ELSE 0
                        END
                    ),
                    0
                ) AS mrc_paid,
                /* New MRC yang belum payment */
                COALESCE(
                    SUM(
                        CASE
                            WHEN m.paid_date IS NULL
                                AND m.inv_date >= p.start_date
                                AND m.inv_date < p.end_date
                            THEN m.amount
                            ELSE 0
                        END
                    ),
                    0
                ) AS mrc_unpaid
            FROM mrc_data m
            CROSS JOIN params p;`,
            [startDate, endDate, ...branch.params]
        )

        return {
            mrc: Number(rows[0]?.mrc || 0),
            mrc_unpaid: Number(rows[0]?.mrc_unpaid || 0),
            mrc_paid: Number(rows[0]?.mrc_paid || 0)
        }
    }

    /**
     * Query actual revenue generated
     * Aggregates revenue from the general journal (accounting)
     * 
     * @param {string} branchId - The branch identifier
     * @param {string} startDate - Query start date
     * @param {string} endDate - Query end date
     * @returns {Promise<number>} Total revenue
     */
    async getRevenue(branchId: string, startDate: string, endDate: string): Promise<number> {
        const branch = BranchHelper.displayFilter(branchId)
        const [rows] = await this.nisDb.query<any[]>(
            `SELECT
                SUM(gj.Kredit - gj.Debet) total
            FROM GeneralJournal gj
            LEFT JOIN Panjar_Penjualan_Breakdown ppb ON
                ppb.id = gj.SumberId 
                AND gj.Sumber = 'pnjr'
            LEFT JOIN NewCustomerInvoice nci ON
                nci.AI = IFNULL(ppb.invoiceAI, gj.SumberId)
            LEFT JOIN CustomerInvoiceTemp cit ON
                cit.InvoiceNum = nci.Id
                AND cit.Urut = nci.No
            LEFT JOIN Customer c ON
                c.CustId = cit.CustId
            LEFT JOIN Services s ON
                s.ServiceId = cit.ServiceId
            WHERE gj.KodeCabang = '020'
            AND c.BranchId = '020'
            AND ${branch.sql}
            AND s.ServiceCategory = 'access_business'
            AND gj.NoPerkiraan LIKE '400%'
            AND gj.TglTransaksi >= ?
            AND gj.TglTransaksi <= ?`,
            [...branch.params, startDate, endDate]
        )
        return Number(rows[0]?.total || 0)
    }

    /**
     * Query number of new leads
     * Counts leads created in the CRM database (prospectDb)
     * 
     * @param {string} startDate - Query start date
     * @param {string} endDate - Query end date
     * @returns {Promise<number>} Total new leads
     */
    async getLeads(startDate: string, endDate: string): Promise<number> {
        const [rows] = await this.prospectDb.query<any[]>(
            `SELECT
                COUNT(1) total
            FROM prospect_leads pl
            WHERE pl.id IN (
                SELECT object_id
                FROM customer_object_product_services
                WHERE object = 'lead' AND product_service_id IN (12, 36, 34, 28)
            )
            AND pl.conversion_datetime IS NULL
            AND pl.unqualified_reason_id IS NULL
            AND pl.deleted_at IS NULL
            AND DATE(pl.created_at) >= ?
            AND DATE(pl.created_at) <= ?`,
            [startDate, endDate]
        )
        return Number(rows[0]?.total || 0)
    }

    /**
     * Query number of new opportunities
     * Counts opportunities created in the CRM database (prospectDb)
     * 
     * @param {string} startDate - Query start date
     * @param {string} endDate - Query end date
     * @returns {Promise<number>} Total new opportunities
     */
    async getOpportunity(startDate: string, endDate: string): Promise<number> {
        const [rows] = await this.prospectDb.query<any[]>(
            `SELECT
                COUNT(1) total
            FROM prospect_opportunities po
            WHERE po.id IN (
                SELECT object_id
                FROM customer_object_product_services
                WHERE object = 'opportunity' AND product_service_id IN (12, 36, 34, 28)
            )
            AND po.opportunity_stage_id NOT IN (6,7)
            AND po.deleted_at IS NULL
            AND DATE(po.created_at) >= ?
            AND DATE(po.created_at) <= ?`,
            [startDate, endDate]
        )
        return Number(rows[0]?.total || 0)
    }

    /**
     * Query won and lost opportunities
     * Aggregates opportunities by their closing stage (6 = win, 7 = lose)
     * 
     * @param {string} startDate - Query start date
     * @param {string} endDate - Query end date
     * @returns {Promise<{win: number, lose: number}>} Counts of won and lost opportunities
     */
    async getWinLose(startDate: string, endDate: string): Promise<{ win: number, lose: number }> {
        const [rows] = await this.prospectDb.query<any[]>(
            `SELECT
                SUM(CASE WHEN po.opportunity_stage_id = 6 THEN 1 ELSE 0 END) AS win_count,
                SUM(CASE WHEN po.opportunity_stage_id = 7 THEN 1 ELSE 0 END) AS lose_count
            FROM prospect_opportunities po
            WHERE po.id IN (
                SELECT object_id
                FROM customer_object_product_services
                WHERE object = 'opportunity' AND product_service_id IN (12, 36, 34, 28)
            )
            AND po.deleted_at IS NULL
            AND DATE(po.created_at) >= ?
            AND DATE(po.created_at) <= ?`,
            [startDate, endDate]
        )
        return {
            win: Number(rows[0]?.win_count || 0),
            lose: Number(rows[0]?.lose_count || 0)
        }
    }

    /**
     * Query sales activities
     * Counts the total number of calls, tasks, and check-ins logged by account managers
     * 
     * @param {string} startDate - Query start date
     * @param {string} endDate - Query end date
     * @returns {Promise<{activity: number, amCount: number}>} Total activities and number of active AMs
     */
    async getActivity(startDate: string, endDate: string): Promise<{ activity: number, amCount: number }> {
        const [amRows] = await this.prospectDb.query<any[]>(
            `SELECT
                COUNT(DISTINCT gu.user_uuid) total
            FROM group_users gu
            LEFT JOIN groups g ON
                g.id = gu.group_id
            WHERE (gu.group_id IN (57, 21, 43)
            OR g.group_parent_id IN (57, 21, 43))
            AND DATE(gu.created_at) <= ?`,
            [endDate]
        )

        const [activityRows] = await this.prospectDb.query<any[]>(
            `SELECT
                COUNT(DISTINCT clc.id) + COUNT(DISTINCT pt.id) + COUNT(DISTINCT pci.id) total
            FROM (
                SELECT
                    DISTINCT gu.user_uuid user_id
                FROM group_users gu
                LEFT JOIN groups g ON
                    g.id = gu.group_id
                WHERE (gu.group_id IN (57, 21, 43)
                OR g.group_parent_id IN (57, 21, 43))
                AND DATE(gu.created_at) <= ?
            ) u
            LEFT JOIN customer_log_calls clc ON
                IFNULL(clc.assigned_to_id, clc.created_by) = u.user_id
                AND DATE(clc.created_at) >= ?
                AND DATE(clc.created_at) <= ?
            LEFT JOIN prospect_tasks pt ON
                IFNULL(pt.assigned_to_id, pt.created_by) = u.user_id
                AND DATE(pt.created_at) >= ?
                AND DATE(pt.created_at) <= ?
            LEFT JOIN prospect_check_ins pci ON
                pci.user_uuid = u.user_id
                AND DATE(pci.created_at) >= ?
                AND DATE(pci.created_at) <= ?`,
            [endDate, startDate, endDate, startDate, endDate, startDate, endDate]
        )

        return {
            activity: Number(activityRows[0]?.total || 0),
            amCount: Number(amRows[0]?.total || 0)
        }
    }

    /**
     * Query total pipeline value
     * Aggregates the estimated monetary value of all open opportunities
     * 
     * @param {string} startDate - Query start date
     * @param {string} endDate - Query end date
     * @returns {Promise<number>} Total pipeline value
     */
    async getPipelineValue(startDate: string, endDate: string): Promise<number> {
        const [rows] = await this.prospectDb.query<any[]>(
            `SELECT
                SUM(poa.amount) value
            FROM prospect_opportunities po
            LEFT JOIN prospect_opportunity_amounts poa ON
                poa.opportunity_id = po.id
            WHERE po.id IN (
                SELECT object_id
                FROM customer_object_product_services
                WHERE object = 'opportunity' AND product_service_id IN (12, 36, 34, 28)
            )
            AND poa.amount_category_setting_id = 1
            AND po.deleted_at IS NULL
            AND DATE(po.created_at) >= ?
            AND DATE(po.created_at) <= ?`,
            [startDate, endDate]
        )
        return Number(rows[0]?.value || 0)
    }

    /**
     * Query average sales cycle length
     * Calculates the average days between opportunity creation and closure (win)
     * 
     * @param {string} startDate - Query start date
     * @param {string} endDate - Query end date
     * @returns {Promise<number>} Average sales cycle in days
     */
    async getCycle(startDate: string, endDate: string): Promise<number> {
        const [rows] = await this.prospectDb.query<any[]>(
            `SELECT
                AVG(DATEDIFF(posc.closed_date, po.created_at)) avg_days
            FROM prospect_opportunities po
            LEFT JOIN (
                SELECT 
                    opportunity_id,
                    MAX(created_at) closed_date
                FROM prospect_opportunity_stage_changes
                WHERE opportunity_stage_id = 6
                GROUP BY opportunity_id
            ) posc ON
                posc.opportunity_id = po.id
            WHERE po.id IN (
                SELECT object_id
                FROM customer_object_product_services
                WHERE object = 'opportunity' AND product_service_id IN (12, 36, 34, 28)
            )
            AND po.opportunity_stage_id = 6
            AND po.deleted_at IS NULL
            AND DATE(po.created_at) >= ?
            AND DATE(po.created_at) <= ?`,
            [startDate, endDate]
        )
        return Number(rows[0]?.avg_days || 0)
    }
    /**
     * Query pipeline stage distribution
     * Groups open opportunities by their current stage (Qualification, Proposal, Negotiation)
     * 
     * @param {string} startDate - Query start date
     * @param {string} endDate - Query end date
     * @returns {Promise<any>} Breakdown of pipeline value per stage
     */
    async getPipelineStage(startDate: string, endDate: string): Promise<any> {
        const [rows] = await this.prospectDb.query<any[]>(
            `SELECT
                pos.id as stage_id,
                pos.name,
                SUM(poa.amount) AS value
            FROM prospect_opportunities po
            LEFT JOIN prospect_opportunity_amounts poa ON
                poa.opportunity_id = po.id
            LEFT JOIN prospect_opportunity_stages pos ON
                pos.id = po.opportunity_stage_id
            WHERE po.id IN (
                SELECT object_id
                FROM customer_object_product_services
                WHERE object = 'opportunity' AND product_service_id IN (12, 36, 34, 28)
            )
            AND poa.amount_category_setting_id = 1
            AND po.deleted_at IS NULL
            AND DATE(po.created_at) >= ?
            AND DATE(po.created_at) <= ?
            AND po.opportunity_stage_id IN (1, 4, 5)
            GROUP BY po.opportunity_stage_id, pos.name`,
            [startDate, endDate]
        )

        const stages = {
            qualification: { name: 'Qualification', value: 0, percentage: 0 },
            proposal: { name: 'Proposal', value: 0, percentage: 0 },
            negotiation: { name: 'Negotiation', value: 0, percentage: 0 }
        }

        const totalValue = rows.reduce((acc, row) => acc + Number(row.value), 0)

        rows.forEach(row => {
            const val = Number(row.value) || 0
            const percentage = totalValue > 0 ? Number(((val / totalValue) * 100).toFixed(2)) : 0
            
            if (row.stage_id === 1) {
                stages.qualification = { name: row.name || 'Qualification', value: val, percentage }
            } else if (row.stage_id === 4) {
                stages.proposal = { name: row.name || 'Proposal', value: val, percentage }
            } else if (row.stage_id === 5) {
                stages.negotiation = { name: row.name || 'Negotiation', value: val, percentage }
            }
        })

        return stages
    }

    /**
     * Query discount given to customers
     * Aggregates the total discount amount from the billing system
     * 
     * @param {string} branchId - The branch identifier
     * @param {string} startDate - Query start date
     * @param {string} endDate - Query end date
     * @returns {Promise<{serviceGroup: string, discount: number}[]>} Total discount per service group
     */
    async getDiscount(branchId: string, startDate: string, endDate: string): Promise<{ serviceGroup: string, discount: number }[]> {
        const branch = BranchHelper.displayFilter(branchId)
        const [rows] = await this.nisDb.query<any[]>(
            `SELECT
                sg.Description service_group,
                SUM(cid.Amount) discount
            FROM CustomerInvoiceDiscount cid
            LEFT JOIN CustomerServices cs ON cs.CustServId = cid.CustServId
            LEFT JOIN Customer c ON c.CustId = cs.CustId
            LEFT JOIN Services s on s.ServiceId = cs.ServiceId
            LEFT JOIN ServiceGroup sg ON sg.ServiceGroup = s.ServiceGroup
            WHERE s.ServiceCategory = 'access_business'
            AND c.BranchId = '020'
            AND ${branch.sql}
            AND DATE(cid.DateTime) >= ?
            AND DATE(cid.DateTime) <= ?
            GROUP BY s.ServiceGroup`,
            [...branch.params, startDate, endDate]
        )

        return rows.map(row => ({
            serviceGroup: row.service_group,
            discount: Number(row.discount) || 0
        }))
    }

    /**
     * Aggregates revenue lost from churned customers (NA status)
     * 
     * @param {string} branchId - The branch identifier
     * @param {string} startDate - Query start date
     * @param {string} endDate - Query end date
     * @returns {Promise<number>} Total churn MRC
     */
    async getChurnMrc(branchId: string, startDate: string, endDate: string): Promise<number> {
        const branch = BranchHelper.displayFilter(branchId)
        const [rows] = await this.nisDb.query<any[]>(
            `SELECT
                    SUM(gj.Kredit - gj.Debet) total
                FROM GeneralJournal gj
                LEFT JOIN Panjar_Penjualan_Breakdown ppb ON
                    ppb.id = gj.SumberId 
                    AND gj.Sumber = 'pnjr'
                LEFT JOIN NewCustomerInvoice nci ON
                    nci.AI = IFNULL(ppb.invoiceAI, gj.SumberId)
                LEFT JOIN CustomerInvoiceTemp cit ON
                    cit.InvoiceNum = nci.Id
                    AND cit.Urut = nci.No
                LEFT JOIN CustomerServices cs ON
                    cs.CustServId = cit.CustServId
                LEFT JOIN Customer c ON
                    c.CustId = cs.CustId
                LEFT JOIN Services s ON
                    s.ServiceId = cit.ServiceId
                WHERE gj.KodeCabang = '020'
                AND c.BranchId = '020'
                AND ${branch.sql}
                AND s.ServiceCategory = 'access_business'
                AND gj.NoPerkiraan LIKE '400%'
                AND gj.TglTransaksi >= ?
                AND gj.TglTransaksi <= ?
                AND cs.CustStatus = 'NA'`,
            [...branch.params, startDate, endDate]
        )
        return Number(rows[0]?.total || 0)
    }

    /**
     * Query sales target for a specific year
     * Retrieves the yearly and monthly revenue targets from the dashboard database
     * 
     * @param {string} branch - The branch selector ('all', 'null', or a branch code)
     * @param {number} year - The year to query
     * @returns {Promise<any>} Target configuration object
     */
    async getTarget(branch: string, year: number): Promise<any> {
        if (branch === 'all') {
            const branches = ['null', '025', '062', '027', '029']
            const [rows] = await this.dashboardDb.query<any[]>(
                `SELECT 
                    year,
                    'all' as branch,
                    SUM(yearly_target) as yearly_target,
                    SUM(jan) as jan, SUM(feb) as feb, SUM(mar) as mar, SUM(apr) as apr,
                    SUM(may) as may, SUM(jun) as jun, SUM(jul) as jul, SUM(aug) as aug,
                    SUM(sep) as sep, SUM(oct) as oct, SUM(nov) as nov, SUM(\`dec\`) as \`dec\`,
                    MIN(is_locked) as is_locked
                 FROM vp_access_business_target 
                 WHERE year = ? AND branch IN (?, ?, ?, ?, ?)
                 GROUP BY year`,
                [year, ...branches]
            )
            const r = rows[0]
            if (!r) return null
            return {
                year: r.year,
                branch: 'all',
                yearly_target: Number(r.yearly_target || 0),
                jan: Number(r.jan || 0),
                feb: Number(r.feb || 0),
                mar: Number(r.mar || 0),
                apr: Number(r.apr || 0),
                may: Number(r.may || 0),
                jun: Number(r.jun || 0),
                jul: Number(r.jul || 0),
                aug: Number(r.aug || 0),
                sep: Number(r.sep || 0),
                oct: Number(r.oct || 0),
                nov: Number(r.nov || 0),
                dec: Number(r.dec || 0),
                is_locked: Number(r.is_locked || 0)
            }
        }
        const [rows] = await this.dashboardDb.query<any[]>(
            `SELECT * FROM vp_access_business_target WHERE year = ? AND branch = ?`,
            [year, branch]
        )
        return rows[0] || null
    }

    /**
     * Query new customer acquisition value
     * Calculates the total value generated from new customers within the period
     * 
     * @param {string} branchId - The branch identifier
     * @param {string} startDate - Query start date
     * @param {string} endDate - Query end date
     * @returns {Promise<number>} Total revenue from new customers
     */
    async getNewCustomer(branchId: string, startDate: string, endDate: string): Promise<number> {
        const branch = BranchHelper.displayFilter(branchId)
        const [rows] = await this.nisDb.query<any[]>(
            `SELECT
                SUM((t.credit - IFNULL(d.discount, 0)) / 1.11) AS total_dpp
            FROM (
                SELECT
                    nci.AI ai,
                    nci.Credit credit,
                    MAX(IFNULL(nci2.JournalDate, nci2.TransDate)) receipt_date,
                    ROW_NUMBER() OVER (
                        PARTITION BY cit.CustServId
                    ) AS rn
                FROM CustomerInvoiceTemp cit
                LEFT JOIN NewCustomerInvoice nci 
                    ON cit.InvoiceNum = nci.Id 
                    AND cit.Urut = nci.No
                LEFT JOIN NewCustomerInvoiceBatch ncib 
                    ON ncib.AI = nci.AI
                LEFT JOIN (
                    SELECT 
                        ncib.batchNo,
                        nci.*,
                        ROW_NUMBER() OVER (
                            PARTITION BY ncib.batchNo 
                            ORDER BY nci.Date DESC
                        ) AS RowNum
                    FROM NewCustomerInvoice nci
                    LEFT JOIN NewCustomerInvoiceBatch ncib 
                        ON ncib.AI = nci.AI
                    WHERE nci.Type LIKE 'RA%'
                ) nci2 
                    ON nci2.batchNo = ncib.batchNo
                LEFT JOIN Services s 
                    ON s.ServiceId = cit.ServiceId
                LEFT JOIN Customer c 
                    ON c.CustId = cit.CustId
                WHERE cit.RInvoiceNum = 0
                AND cit.InvProrata = 0
                AND c.BranchId = '020'
                AND ${branch.sql}
                AND s.ServiceCategory = 'access_business'
                GROUP BY nci.AI
            ) t
            LEFT JOIN (
                SELECT
                    nci.AI ai,
                    ncid.Debet discount
                FROM CustomerInvoiceDiscount cid
                LEFT JOIN NewCustomerInvoice ncid 
                    ON ncid.Id = cid.Id
                    AND ncid.Type = 'discount'
                LEFT JOIN CustomerInvoiceTemp cit 
                    ON cit.InvoiceNum = cid.InvoiceNum
                    AND cit.Urut = cid.Urut
                LEFT JOIN NewCustomerInvoice nci 
                    ON nci.Id = cid.InvoiceNum
                    AND nci.No = cid.Urut
                WHERE cit.RInvoiceNum = 0
            ) d 
                ON d.ai = t.ai
            WHERE t.rn = 1
            AND DATE(t.receipt_date) >= ?
            AND DATE(t.receipt_date) <= ?`,
            [...branch.params, startDate, endDate]
        )
        return Number(rows[0]?.total_dpp || 0)
    }

    /**
     * Query Average Revenue Per User (ARPU) metrics
     * Calculates total services, total revenue, and their ratio grouped by service type
     * 
     * @param {string} branchId - The branch identifier
     * @param {string} startDate - Query start date
     * @param {string} endDate - Query end date
     * @returns {Promise<{serviceGroup: string, jumlahService: number, totalRevenue: number, avgPerService: number}[]>}
     */
    async getArpu(branchId: string, startDate: string, endDate: string): Promise<{ serviceGroup: string, jumlahService: number, totalRevenue: number, avgPerService: number }[]> {
        const branch = BranchHelper.displayFilter(branchId)
        const [rows] = await this.nisDb.query<any[]>(
            `SELECT
                sg.Description AS service_group,
                COUNT(DISTINCT cit.CustServId) AS jumlah_service,
                SUM(gj.Kredit - gj.Debet) AS total_revenue,
                SUM(gj.Kredit - gj.Debet) / COUNT(DISTINCT cit.CustServId) AS avg_per_service
            FROM GeneralJournal gj
            LEFT JOIN Panjar_Penjualan_Breakdown ppb
                ON ppb.id = gj.SumberId
                AND gj.Sumber = 'pnjr'
            LEFT JOIN NewCustomerInvoice nci
                ON nci.AI = IFNULL(ppb.invoiceAI, gj.SumberId)
            LEFT JOIN CustomerInvoiceTemp cit
                ON cit.InvoiceNum = nci.Id
                AND cit.Urut = nci.No
            LEFT JOIN Customer c
                ON c.CustId = cit.CustId
            LEFT JOIN Services s
                ON s.ServiceId = cit.ServiceId
            LEFT JOIN ServiceGroup sg
                ON sg.ServiceGroup = s.ServiceGroup
            WHERE gj.KodeCabang = '020'
              AND c.BranchId = '020'
              AND ${branch.sql}
              AND s.ServiceCategory = 'access_business'
              AND gj.NoPerkiraan LIKE '400%'
              AND DATE(gj.TglTransaksi) >= ?
              AND DATE(gj.TglTransaksi) <= ?
            GROUP BY s.ServiceGroup, sg.Description`,
            [...branch.params, startDate, endDate]
        )

        return rows.map(row => ({
            serviceGroup: row.service_group,
            jumlahService: Number(row.jumlah_service) || 0,
            totalRevenue: Number(row.total_revenue) || 0,
            avgPerService: Number(row.avg_per_service) || 0
        }))
    }

    /**
     * Query forecast revenue from opportunities
     * Calculates sum of amount * probability / 100 for opportunities in stage 5
     * 
     * @param {string} startDate - Query start date
     * @param {string} endDate - Query end date
     * @returns {Promise<number>} Forecast revenue value
     */
    async getForecastRevenue(startDate: string, endDate: string): Promise<number> {
        const [rows] = await this.prospectDb.query<any[]>(
            `SELECT
                SUM(poa.amount * po.probability / 100) AS value
            FROM customer_object_product_services cops
            LEFT JOIN prospect_opportunities po ON
                po.id = cops.object_id
                AND cops.object = 'opportunity'
            LEFT JOIN prospect_opportunity_amounts poa ON
                poa.opportunity_id = po.id
            WHERE cops.product_service_id IN (12, 36, 34, 28)
            AND po.opportunity_stage_id = 5
            AND poa.amount_category_setting_id = 1
            AND po.id IS NOT NULL
            AND po.deleted_at IS NULL
            AND DATE(po.created_at) >= ?
            AND DATE(po.created_at) <= ?`,
            [startDate, endDate]
        )
        return Number(rows[0]?.value || 0)
    }

    /**
     * Query forecast MRC from opportunities
     * Calculates sum of amount for opportunities in stage 5
     * 
     * @param {string} startDate - Query start date
     * @param {string} endDate - Query end date
     * @returns {Promise<number>} Forecast MRC value
     */
    async getForecastMrc(startDate: string, endDate: string): Promise<number> {
        const [rows] = await this.prospectDb.query<any[]>(
            `SELECT
                SUM(poa.amount) AS value
            FROM customer_object_product_services cops
            LEFT JOIN prospect_opportunities po ON
                po.id = cops.object_id
                AND cops.object = 'opportunity'
            LEFT JOIN prospect_opportunity_amounts poa ON
                poa.opportunity_id = po.id
            LEFT JOIN prospect_opportunity_stages pos ON
                pos.id = po.opportunity_stage_id
            WHERE cops.product_service_id IN (12, 36, 34, 28)
            AND po.opportunity_stage_id = 5
            AND poa.amount_category_setting_id = 1
            AND po.id IS NOT NULL
            AND po.deleted_at IS NULL
            AND DATE(po.close_date) >= ?
            AND DATE(po.close_date) <= ?`,
            [startDate, endDate]
        )
        return Number(rows[0]?.value || 0)
    }
    
    /**
     * Query Account Manager count snapshot at a specific date
     * Counts users in AM groups who were created on or before the given date
     * 
     * @param {string} endDate - The snapshot end date
     * @returns {Promise<number>} Number of AMs at that point in time
     */
    async getAmCountSnapshot(endDate: string): Promise<number> {
        const [rows] = await this.prospectDb.query<any[]>(
            `SELECT
                COUNT(DISTINCT gu.user_uuid) total
            FROM group_users gu
            LEFT JOIN groups g ON
                g.id = gu.group_id
            WHERE (gu.group_id IN (57, 21, 43)
            OR g.group_parent_id IN (57, 21, 43))
            AND DATE(gu.created_at) <= ?`,
            [endDate]
        )
        return Number(rows[0]?.total || 0)
    }

}
