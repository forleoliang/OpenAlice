/**
 * Duck-typed interfaces for OpenBB clients.
 *
 * Both the HTTP clients (OpenBBEquityClient etc.) and SDK clients (SDKEquityClient etc.)
 * satisfy these interfaces, allowing adapters to accept either implementation.
 */

export interface EquityClientLike {
  search(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getHistorical(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getProfile(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getKeyMetrics(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getIncomeStatement(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getBalanceSheet(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getCashFlow(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getFinancialRatios(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getEstimateConsensus(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getCalendarEarnings(params?: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getInsiderTrading(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getGainers(params?: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getLosers(params?: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getActive(params?: Record<string, unknown>): Promise<Record<string, unknown>[]>
}

export interface CryptoClientLike {
  search(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getHistorical(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
}

export interface CurrencyClientLike {
  search(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getHistorical(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
}

export interface EtfClientLike {
  search(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getInfo(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getHoldings(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getSectors(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getCountries(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getEquityExposure(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getHistorical(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
}

export interface IndexClientLike {
  getAvailable(params?: Record<string, unknown>): Promise<Record<string, unknown>[]>
  search(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getConstituents(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getHistorical(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getSnapshots(params?: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getSectors(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getSP500Multiples(params?: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getRiskPremium(params?: Record<string, unknown>): Promise<Record<string, unknown>[]>
}

export interface DerivativesClientLike {
  getFuturesHistorical(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getFuturesCurve(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getFuturesInfo(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getFuturesInstruments(params?: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getOptionsChains(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getOptionsSnapshots(params?: Record<string, unknown>): Promise<Record<string, unknown>[]>
  getOptionsUnusual(params?: Record<string, unknown>): Promise<Record<string, unknown>[]>
}

