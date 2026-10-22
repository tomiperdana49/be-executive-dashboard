export interface IRetentionRepository {
    churnRevenue(branchId: string, startDate: string, endDate: string): Promise<number>
    churnRate(branchId: string, startDate: string, endDate: string): Promise<{ rate: number, churn: number, active: number }>
    customerLose(branchId: string, startDate: string, endDate: string): Promise<any[]>
    wirelessCustomer(branchId: string): Promise<number>
    wirelessMigration(branchId: string, startDate: string, endDate: string): Promise<number>
    migrationWirelessPercentage(branchId: string, startDate: string, endDate: string): Promise<number>
    contractExpiring(branchId: string): Promise<{ total: number; total_30: number; total_60: number; total_90: number }>
    ticket(branchId: string, startDate: string, endDate: string): Promise<number>
    usage(branchId: string, startDate: string, endDate: string): Promise<number>
    payment(branchId: string): Promise<number | null>

    getForecastChurnBlocked(branchId: string, startDate: string, endDate: string): Promise<{ csid: number, mrc: number }[]>
    getForecastChurnContract(branchId: string, startDate: string, endDate: string): Promise<{ csid: number, mrc: number }[]>
    getForecastChurnTicket(branchId: string, startDate: string, endDate: string): Promise<{ csid: number, mrc: number }[]>
    getForecastChurnUsage(branchId: string, startDate: string, endDate: string): Promise<{ csid: number, mrc: number }[]>
    getForecastMrc(startDate: string, endDate: string): Promise<number>
}
