/**
 * FMP Commodity Spot Price Model.
 *
 * Uses the same /stable/historical-price-eod/full endpoint as equities —
 * FMP treats commodity futures symbols (GCUSD, CLUSD, etc.) identically.
 */

import { z } from 'zod'
import { Fetcher } from '../../../core/provider/abstract/fetcher.js'
import { CommoditySpotPriceQueryParamsSchema, CommoditySpotPriceDataSchema } from '../../../standard-models/commodity-spot-price.js'
import { getHistoricalOhlc } from '../utils/helpers.js'
import { EmptyDataError } from '../../../core/provider/utils/errors.js'

export const FMPCommoditySpotPriceQueryParamsSchema = CommoditySpotPriceQueryParamsSchema
export type FMPCommoditySpotPriceQueryParams = z.infer<typeof FMPCommoditySpotPriceQueryParamsSchema>

export const FMPCommoditySpotPriceDataSchema = CommoditySpotPriceDataSchema.extend({
  vwap: z.number().nullable().default(null).describe('Volume-weighted average price.'),
  change: z.number().nullable().default(null).describe('Change from previous close.'),
  change_percent: z.number().nullable().default(null).describe('Change percent from previous close.'),
}).passthrough()
export type FMPCommoditySpotPriceData = z.infer<typeof FMPCommoditySpotPriceDataSchema>

export class FMPCommoditySpotPriceFetcher extends Fetcher {
  static override transformQuery(params: Record<string, unknown>): FMPCommoditySpotPriceQueryParams {
    const now = new Date()
    if (!params.start_date) {
      const oneYearAgo = new Date(now)
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)
      params.start_date = oneYearAgo.toISOString().split('T')[0]
    }
    if (!params.end_date) {
      params.end_date = now.toISOString().split('T')[0]
    }
    return FMPCommoditySpotPriceQueryParamsSchema.parse(params)
  }

  static override async extractData(
    query: FMPCommoditySpotPriceQueryParams,
    credentials: Record<string, string> | null,
  ): Promise<Record<string, unknown>[]> {
    return getHistoricalOhlc(
      {
        symbol: query.symbol,
        interval: '1d',
        start_date: query.start_date,
        end_date: query.end_date,
      },
      credentials,
    )
  }

  static override transformData(
    query: FMPCommoditySpotPriceQueryParams,
    data: Record<string, unknown>[],
  ): FMPCommoditySpotPriceData[] {
    if (!data || data.length === 0) {
      throw new EmptyDataError()
    }

    for (const d of data) {
      if (typeof d.changePercentage === 'number') {
        d.change_percent = d.changePercentage / 100
        delete d.changePercentage
      }
    }

    const sorted = data.sort((a, b) => {
      const da = String(a.date ?? '')
      const db = String(b.date ?? '')
      return da.localeCompare(db)
    })

    return sorted.map(d => FMPCommoditySpotPriceDataSchema.parse(d))
  }
}
