/**
 * SDK ETF Client
 *
 * Maps to openTypeBB etf-router endpoints.
 */

import { SDKBaseClient } from './base-client.js'

export class SDKEtfClient extends SDKBaseClient {
  async search(params: Record<string, unknown>) {
    return this.request('/search', params)
  }

  async getInfo(params: Record<string, unknown>) {
    return this.request('/info', params)
  }

  async getHoldings(params: Record<string, unknown>) {
    return this.request('/holdings', params)
  }

  async getSectors(params: Record<string, unknown>) {
    return this.request('/sectors', params)
  }

  async getCountries(params: Record<string, unknown>) {
    return this.request('/countries', params)
  }

  async getEquityExposure(params: Record<string, unknown>) {
    return this.request('/equity_exposure', params)
  }

  async getHistorical(params: Record<string, unknown>) {
    return this.request('/historical', params)
  }
}
