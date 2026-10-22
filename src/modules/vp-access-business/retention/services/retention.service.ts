import { IRetentionRepository } from '../interfaces/retention.repository.interface'
import { IGrowthRepository } from '../../growth/interfaces/growth.repository.interface'
import { IRetentionService } from '../interfaces/retention.service.interface'
import { DateHelper } from '../../../../core/helpers/date'
import { TrendHelper } from '../../../../core/helpers/trend'

/**
 * Service class for handling retention business logic
 * Responsible for orchestrating data retrieval from repositories and calculating trends/percentages
 */
export class RetentionService implements IRetentionService {
    constructor(
        private readonly retentionRepository: IRetentionRepository,
        // New MRC comes from the growth module so Net MRC matches the Growth dashboard
        private readonly growthRepository: IGrowthRepository
    ) {}

    /**
     * Calculate churn revenue metrics
     * Compares the absolute revenue lost from churns between current and previous periods
     * 
     * @param {string} branchId - The branch identifier (e.g., '020')
     * @param {string} periodType - The period to query ('month', 'quarter', 'year', 'last')
     * @returns {Promise<{trend: 'up' | 'down', percentage: number, revenue: number, period: string}>}
     */
    async getChurnRevenue(branchId: string, periodType: string): Promise<{
        trend: 'up' | 'down'
        percentage: number
        revenue: number
        period: string
    }> {
        const { startDate, endDate, prevStartDate, prevEndDate, period } = DateHelper.getDatesForPeriod(periodType)

        const [revenue, prevRevenue] = await Promise.all([
            this.retentionRepository.churnRevenue(branchId, startDate, endDate),
            this.retentionRepository.churnRevenue(branchId, prevStartDate, prevEndDate)
        ])

        const { trend, percentage } = TrendHelper.calculate(revenue, prevRevenue, true)

        return {
            trend,
            percentage,
            revenue,
            period
        }
    }

    /**
     * Calculate lost customers and their breakdown by service group
     * Groups churned customers by their service type and compares against previous period
     * 
     * @param {string} branchId - The branch identifier
     * @param {string} periodType - The period to query
     * @returns {Promise<{total: any, detail: any[]}>} Object containing total loss and detailed breakdown sorted by highest loss
     */
    async getCustomerLose(branchId: string, periodType: string): Promise<{
        total: { value: number; trend: 'up' | 'down'; percentage: number; period: string }
        detail: { service_group: string; value: number; trend: 'up' | 'down'; percentage: number }[]
    }> {
        const { startDate, endDate, prevStartDate, prevEndDate, period } = DateHelper.getDatesForPeriod(periodType)

        const [currentList, prevList] = await Promise.all([
            this.retentionRepository.customerLose(branchId, startDate, endDate),
            this.retentionRepository.customerLose(branchId, prevStartDate, prevEndDate)
        ])

        const map = new Map<string, { current: number, prev: number }>()
        
        for (const item of currentList) {
            const group = item.service_group || 'Unknown'
            if (!map.has(group)) map.set(group, { current: 0, prev: 0 })
            map.get(group)!.current += Number(item.total_churn)
        }
        
        for (const item of prevList) {
            const group = item.service_group || 'Unknown'
            if (!map.has(group)) map.set(group, { current: 0, prev: 0 })
            map.get(group)!.prev += Number(item.total_churn)
        }

        let totalCurrent = 0
        let totalPrev = 0
        const detail: { service_group: string; value: number; trend: 'up' | 'down'; percentage: number }[] = []

        map.forEach((data, group) => {
            totalCurrent += data.current
            totalPrev += data.prev

            const { trend, percentage } = TrendHelper.calculate(data.current, data.prev)
            
            detail.push({
                service_group: group,
                value: data.current,
                trend,
                percentage
            })
        })

        const { trend: totalTrend, percentage: totalPercentage } = TrendHelper.calculate(totalCurrent, totalPrev)

        return {
            total: {
                value: totalCurrent,
                trend: totalTrend,
                percentage: totalPercentage,
                period
            },
            detail: detail.sort((a, b) => b.value - a.value)
        }
    }

    /**
     * Calculate wireless to fiber migration progress
     * Retrieves total wireless customers, count of migrated customers, and the migration percentage rate
     * 
     * @param {string} branchId - The branch identifier
     * @param {string} periodType - The period to query
     * @returns {Promise<{totalCustomer: any, migrated: any, migrationRate: any}>}
     */
    async getWirelessMigration(branchId: string, periodType: string): Promise<{
        totalCustomer: { value: number; trend: 'up' | 'down'; percentage: number; period: string }
        migrated: { value: number; trend: 'up' | 'down'; percentage: number; period: string }
        migrationRate: { value: number; trend: 'up' | 'down'; percentage: number; migratedValue: number; totalValue: number; period: string }
    }> {
        const { startDate, endDate, prevStartDate, prevEndDate, period } = DateHelper.getDatesForPeriod(periodType)

        const [
            totalCustomer,
            currentMigrated,
            prevMigrated,
            currentRate,
            prevRate
        ] = await Promise.all([
            this.retentionRepository.wirelessCustomer(branchId),
            this.retentionRepository.wirelessMigration(branchId, startDate, endDate),
            this.retentionRepository.wirelessMigration(branchId, prevStartDate, prevEndDate),
            this.retentionRepository.migrationWirelessPercentage(branchId, startDate, endDate),
            this.retentionRepository.migrationWirelessPercentage(branchId, prevStartDate, prevEndDate)
        ])

        // Total Customer (current only, no historical tracking available yet)
        const totalCustomerTrend: 'up' | 'down' = 'up'
        const totalCustomerPercentage = 0

        // Migrated
        const { trend: migratedTrend, percentage: migratedPercentage } = TrendHelper.calculate(currentMigrated, prevMigrated)

        // Migration Rate
        const { trend: rateTrend, percentage: ratePercentage } = TrendHelper.calculate(currentRate, prevRate)

        return {
            totalCustomer: {
                value: totalCustomer,
                trend: totalCustomerTrend,
                percentage: totalCustomerPercentage,
                period
            },
            migrated: {
                value: currentMigrated,
                trend: migratedTrend,
                percentage: migratedPercentage,
                period
            },
            migrationRate: {
                value: currentRate,
                trend: rateTrend,
                percentage: ratePercentage,
                migratedValue: currentMigrated,
                totalValue: totalCustomer,
                period
            }
        }
    }

    /**
     * Build month-by-month churn rate comparison for the current year vs previous year
     * Iterates from January up to the current month to construct the historical data array
     * 
     * @param {string} branchId - The branch identifier
     * @returns {Promise<any[]>} Array of monthly churn rate data points
     */
    async getChurnRate(branchId: string): Promise<any[]> {
        const currentPeriod = DateHelper.getCurrentPeriod()
        const currentYear = Number(currentPeriod.substring(0, 4))
        const currentMonth = Number(currentPeriod.substring(4, 6))

        const promises: Promise<{ rate: number; churn: number; active: number }>[] = []
        
        for (let month = 1; month <= currentMonth; month++) {
            // Current Year
            const startDate = `${currentYear}-${String(month).padStart(2, '0')}-01`
            const endDate = `${currentYear}-${String(month).padStart(2, '0')}-${new Date(currentYear, month, 0).getDate()}`
            promises.push(this.retentionRepository.churnRate(branchId, startDate, endDate))

            // Previous Year
            const prevYear = currentYear - 1
            const prevStartDate = `${prevYear}-${String(month).padStart(2, '0')}-01`
            const prevEndDate = `${prevYear}-${String(month).padStart(2, '0')}-${new Date(prevYear, month, 0).getDate()}`
            promises.push(this.retentionRepository.churnRate(branchId, prevStartDate, prevEndDate))
        }

        const results = await Promise.all(promises)

        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
        const data = []

        for (let i = 0; i < currentMonth; i++) {
            const currentYearData = results[i * 2]
            const prevYearData = results[i * 2 + 1]

            data.push({
                period: monthNames[i],
                month: {
                    [currentYear]: {
                        churn: currentYearData.churn,
                        active: currentYearData.active,
                        ret: currentYearData.rate
                    },
                    [currentYear - 1]: {
                        churn: prevYearData.churn,
                        active: prevYearData.active,
                        ret: prevYearData.rate
                    }
                }
            })
        }

        return data
    }

    /**
     * Retrieve count of contracts expiring in upcoming intervals
     * Separates counts into 30, 60, and 90 days buckets
     * 
     * @param {string} branchId - The branch identifier
     * @returns {Promise<{total: number, total_30: number, total_60: number, total_90: number}>}
     */
    async getContractExpiring(branchId: string): Promise<{ total: number; total_30: number; total_60: number; total_90: number }> {
        return await this.retentionRepository.contractExpiring(branchId)
    }

    /**
     * Calculate retention-related ticket volume and trends
     * 
     * @param {string} branchId - The branch identifier
     * @param {string} periodType - The period to query
     * @returns {Promise<{value: number, trend: 'up' | 'down', percentage: number, period: string}>}
     */
    async getTicket(branchId: string, periodType: string): Promise<{ value: number; trend: 'up' | 'down'; percentage: number; period: string }> {
        const { startDate, endDate, prevStartDate, prevEndDate, period } = DateHelper.getDatesForPeriod(periodType)

        const [value, prevValue] = await Promise.all([
            this.retentionRepository.ticket(branchId, startDate, endDate),
            this.retentionRepository.ticket(branchId, prevStartDate, prevEndDate)
        ])

        const { trend, percentage } = TrendHelper.calculate(value, prevValue)

        return {
            value,
            trend,
            percentage,
            period
        }
    }

    /**
     * Calculate customer service usage/bandwidth utilization metrics
     * 
     * @param {string} branchId - The branch identifier
     * @param {string} periodType - The period to query
     * @returns {Promise<{value: number, trend: 'up' | 'down', percentage: number, period: string}>}
     */
    async getUsage(branchId: string, periodType: string): Promise<{ value: number; trend: 'up' | 'down'; percentage: number; period: string }> {
        const { startDate, endDate, prevStartDate, prevEndDate, period } = DateHelper.getDatesForPeriod(periodType)

        const [value, prevValue] = await Promise.all([
            this.retentionRepository.usage(branchId, startDate, endDate),
            this.retentionRepository.usage(branchId, prevStartDate, prevEndDate)
        ])

        const { trend, percentage } = TrendHelper.calculate(value, prevValue)

        return {
            value,
            trend,
            percentage,
            period
        }
    }

    /**
     * Calculate the distribution of monthly vs annual payment preferences
     * 
     * @param {string} branchId - The branch identifier
     * @returns {Promise<{monthly: number, annual: number}>} Percentage split between monthly and annual payments
     */
    async getPayment(branchId: string): Promise<{ monthly: number; annual: number }> {
        const monthlyPercent = await this.retentionRepository.payment(branchId)
        
        if (monthlyPercent === null) {
            return {
                monthly: 0,
                annual: 0
            }
        }

        return {
            monthly: monthlyPercent,
            annual: 100 - monthlyPercent
        }
    }

    /**
     * Get Net MRC Growth
     * Calculates the net MRC based on New MRC minus Churn MRC
     * 
     * @param {string} branchId - The branch identifier
     * @param {string} periodType - The period to query
     * @returns {Promise<any>} Object containing net MRC value, trend, and detail values
     */
    async getNetMrc(branchId: string, periodType: string): Promise<{
        value: number
        trend: 'up' | 'down'
        percentage: number
        period: string
        newMrc: {
            value: number
            trend: 'up' | 'down'
            percentage: number
        }
        churnMrc: {
            value: number
            trend: 'up' | 'down'
            percentage: number
        }
    }> {
        const { startDate, endDate, prevStartDate, prevEndDate, period } = DateHelper.getDatesForPeriod(periodType)

        const [
            currentNewMrcFull, prevNewMrcFull,
            currentChurnMrc, prevChurnMrc
        ] = await Promise.all([
            this.growthRepository.getNewMrc(branchId, startDate, endDate),
            this.growthRepository.getNewMrc(branchId, prevStartDate, prevEndDate),
            this.retentionRepository.churnRevenue(branchId, startDate, endDate),
            this.retentionRepository.churnRevenue(branchId, prevStartDate, prevEndDate)
        ])

        const currentNewMrc = currentNewMrcFull.mrc
        const prevNewMrc = prevNewMrcFull.mrc

        const newMrcTrend = TrendHelper.calculate(currentNewMrc, prevNewMrc)
        const churnMrcTrend = TrendHelper.calculate(currentChurnMrc, prevChurnMrc)

        const currentNetMrc = currentNewMrc - currentChurnMrc
        const prevNetMrc = prevNewMrc - prevChurnMrc

        const netMrcTrend = TrendHelper.calculate(currentNetMrc, prevNetMrc)

        return {
            value: currentNetMrc,
            trend: netMrcTrend.trend,
            percentage: netMrcTrend.percentage,
            period,
            newMrc: {
                value: currentNewMrc,
                trend: newMrcTrend.trend,
                percentage: newMrcTrend.percentage
            },
            churnMrc: {
                value: currentChurnMrc,
                trend: churnMrcTrend.trend,
                percentage: churnMrcTrend.percentage
            }
        }
    }

    /**
     * Calculate forecast churn based on at-risk metrics
     * Aggregates MRC from customers who are blocked, contracts ending, have high tickets, or low usage
     * 
     * @param {string} branchId - The branch identifier
     * @param {string} periodType - The period to query
     * @returns {Promise<any>} Object containing forecast churn total, details, and customer lose
     */
    async getForecastChurn(branchId: string, periodType: string): Promise<{
        forecastMrc: { value: number; trend: 'up' | 'down'; percentage: number; period: string }
        details: { blocked: number; contractEnd: number; ticketIssues: number; lowUsage: number }
        customerLose: { service_group: string; total_churn: number }[]
    }> {
        const { startDate, endDate, prevStartDate, prevEndDate, period } = DateHelper.getDatesForPeriod(periodType)

        const [
            currentBlocked, currentContract, currentTicket, currentUsage, currentCustomerLose,
            prevBlocked, prevContract, prevTicket, prevUsage
        ] = await Promise.all([
            this.retentionRepository.getForecastChurnBlocked(branchId, startDate, endDate),
            this.retentionRepository.getForecastChurnContract(branchId, startDate, endDate),
            this.retentionRepository.getForecastChurnTicket(branchId, startDate, endDate),
            this.retentionRepository.getForecastChurnUsage(branchId, startDate, endDate),
            this.retentionRepository.customerLose(branchId, startDate, endDate),

            this.retentionRepository.getForecastChurnBlocked(branchId, prevStartDate, prevEndDate),
            this.retentionRepository.getForecastChurnContract(branchId, prevStartDate, prevEndDate),
            this.retentionRepository.getForecastChurnTicket(branchId, prevStartDate, prevEndDate),
            this.retentionRepository.getForecastChurnUsage(branchId, prevStartDate, prevEndDate)
        ])

        const calculateUniqueTotal = (lists: {csid: number, mrc: number}[][]) => {
            const uniqueMap = new Map<number, number>()
            for (const list of lists) {
                for (const item of list) {
                    uniqueMap.set(item.csid, item.mrc)
                }
            }
            let total = 0
            uniqueMap.forEach((mrc) => {
                total += mrc
            })
            return total
        }

        const sumList = (list: {csid: number, mrc: number}[]) => list.reduce((sum, item) => sum + item.mrc, 0)

        const totalCurrent = calculateUniqueTotal([currentBlocked, currentContract, currentTicket, currentUsage])
        const totalPrev = calculateUniqueTotal([prevBlocked, prevContract, prevTicket, prevUsage])

        const { trend, percentage } = TrendHelper.calculate(totalCurrent, totalPrev)

        return {
            forecastMrc: {
                value: totalCurrent,
                trend,
                percentage,
                period
            },
            details: {
                blocked: sumList(currentBlocked),
                contractEnd: sumList(currentContract),
                ticketIssues: sumList(currentTicket),
                lowUsage: sumList(currentUsage)
            },
            customerLose: currentCustomerLose.map(item => ({
                service_group: item.service_group || 'Unknown',
                total_churn: Number(item.total_churn)
            }))
        }
    }

    /**
     * Calculate forecast net MRC
     * Formula: Forecast New MRC - Forecast Churn MRC
     * 
     * @param {string} branchId - The branch identifier
     * @param {string} periodType - The period to query
     * @returns {Promise<any>} Object containing forecast net MRC, trend, and percentage
     */
    async getForecastNetMrc(branchId: string, periodType: string): Promise<{
        value: number
        trend: 'up' | 'down'
        percentage: number
        period: string
    }> {
        const { startDate, endDate, prevStartDate, prevEndDate, period } = DateHelper.getDatesForPeriod(periodType)

        const [
            currentNewMrc, prevNewMrc,
            currentBlocked, currentContract, currentTicket, currentUsage,
            prevBlocked, prevContract, prevTicket, prevUsage
        ] = await Promise.all([
            // Forecast New MRC
            this.retentionRepository.getForecastMrc(startDate, endDate),
            this.retentionRepository.getForecastMrc(prevStartDate, prevEndDate),

            // Forecast Churn MRC current
            this.retentionRepository.getForecastChurnBlocked(branchId, startDate, endDate),
            this.retentionRepository.getForecastChurnContract(branchId, startDate, endDate),
            this.retentionRepository.getForecastChurnTicket(branchId, startDate, endDate),
            this.retentionRepository.getForecastChurnUsage(branchId, startDate, endDate),

            // Forecast Churn MRC prev
            this.retentionRepository.getForecastChurnBlocked(branchId, prevStartDate, prevEndDate),
            this.retentionRepository.getForecastChurnContract(branchId, prevStartDate, prevEndDate),
            this.retentionRepository.getForecastChurnTicket(branchId, prevStartDate, prevEndDate),
            this.retentionRepository.getForecastChurnUsage(branchId, prevStartDate, prevEndDate)
        ])

        const calculateUniqueTotal = (lists: {csid: number, mrc: number}[][]) => {
            const uniqueMap = new Map<number, number>()
            for (const list of lists) {
                for (const item of list) {
                    uniqueMap.set(item.csid, item.mrc)
                }
            }
            let total = 0
            uniqueMap.forEach((mrc) => {
                total += mrc
            })
            return total
        }

        const currentChurnMrc = calculateUniqueTotal([currentBlocked, currentContract, currentTicket, currentUsage])
        const prevChurnMrc = calculateUniqueTotal([prevBlocked, prevContract, prevTicket, prevUsage])

        const currentNetMrc = currentNewMrc - currentChurnMrc
        const prevNetMrc = prevNewMrc - prevChurnMrc

        const { trend, percentage } = TrendHelper.calculate(currentNetMrc, prevNetMrc)

        return {
            value: currentNetMrc,
            trend,
            percentage,
            period
        }
    }
}
