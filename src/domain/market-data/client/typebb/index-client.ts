/**
 * SDK Index Client
 *
 * Maps to openTypeBB index-router endpoints.
 */

import { SDKBaseClient } from './base-client.js'

export class SDKIndexClient extends SDKBaseClient {
  async getAvailable(params: Record<string, unknown> = {}) {
    return this.request('/available', params)
  }

  async search(params: Record<string, unknown>) {
    return this.request('/search', params)
  }

  async getConstituents(params: Record<string, unknown>) {
    return this.request('/constituents', params)
  }

  async getHistorical(params: Record<string, unknown>) {
    return this.request('/price/historical', params)
  }

  async getSnapshots(params: Record<string, unknown> = {}) {
    return this.request('/snapshots', params)
  }

  async getSectors(params: Record<string, unknown>) {
    return this.request('/sectors', params)
  }

  async getSP500Multiples(params: Record<string, unknown> = {}) {
    return this.request('/sp500_multiples', params)
  }

  async getRiskPremium(params: Record<string, unknown> = {}) {
    return this.request('/risk_premium', params)
  }
}
