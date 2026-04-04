/**
 * SDK Derivatives Client
 *
 * Maps to openTypeBB derivatives-router endpoints.
 */

import { SDKBaseClient } from './base-client.js'

export class SDKDerivativesClient extends SDKBaseClient {
  // ==================== Futures ====================

  async getFuturesHistorical(params: Record<string, unknown>) {
    return this.request('/futures/historical', params)
  }

  async getFuturesCurve(params: Record<string, unknown>) {
    return this.request('/futures/curve', params)
  }

  async getFuturesInfo(params: Record<string, unknown>) {
    return this.request('/futures/info', params)
  }

  async getFuturesInstruments(params: Record<string, unknown> = {}) {
    return this.request('/futures/instruments', params)
  }

  // ==================== Options ====================

  async getOptionsChains(params: Record<string, unknown>) {
    return this.request('/options/chains', params)
  }

  async getOptionsSnapshots(params: Record<string, unknown> = {}) {
    return this.request('/options/snapshots', params)
  }

  async getOptionsUnusual(params: Record<string, unknown> = {}) {
    return this.request('/options/unusual', params)
  }
}
