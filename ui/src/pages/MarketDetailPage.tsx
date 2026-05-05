import { PageHeader } from '../components/PageHeader'
import { SearchBox } from '../components/market/SearchBox'
import { EquityDetail } from './market/EquityDetail'
import { GenericDetail } from './market/GenericDetail'
import type { ViewSpec } from '../tabs/types'

interface MarketDetailPageProps {
  spec: Extract<ViewSpec, { kind: 'market-detail' }>
}

export function MarketDetailPage({ spec }: MarketDetailPageProps) {
  const { assetClass, symbol } = spec.params

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageHeader title="Market" description="Search assets and view price history." />
      <div className="flex-1 flex flex-col gap-3 px-4 md:px-8 py-4 min-h-0 overflow-y-auto">
        <SearchBox />
        {assetClass === 'equity' ? (
          <EquityDetail symbol={symbol} />
        ) : (
          <GenericDetail symbol={symbol} assetClass={assetClass} />
        )}
      </div>
    </div>
  )
}
