import { useWorkspace } from '../tabs/store'
import { getFocusedTab, type ViewSpec } from '../tabs/types'

type DevTab = Extract<ViewSpec, { kind: 'dev' }>['params']['tab']

interface CategoryItem {
  label: string
  tab: DevTab
}

const CATEGORIES: CategoryItem[] = [
  { label: 'Connectors', tab: 'connectors' },
  { label: 'Tools', tab: 'tools' },
  { label: 'Sessions', tab: 'sessions' },
  { label: 'Snapshots', tab: 'snapshots' },
  { label: 'Logs', tab: 'logs' },
]

/**
 * Dev sidebar — five sub-pages, click opens (or focuses) the
 * corresponding dev tab. Active highlight is driven by the focused tab's
 * spec.
 */
export function DevCategoryList() {
  const focused = useWorkspace((state) => getFocusedTab(state)?.spec)
  const openOrFocus = useWorkspace((state) => state.openOrFocus)

  return (
    <div className="py-0.5">
      {CATEGORIES.map((item) => {
        const active = focused?.kind === 'dev' && focused.params.tab === item.tab
        return (
          <button
            key={item.tab}
            type="button"
            onClick={() => openOrFocus({ kind: 'dev', params: { tab: item.tab } })}
            className={`w-full text-left flex items-center gap-1 px-3 py-1 text-[13px] transition-colors ${
              active
                ? 'bg-bg-tertiary text-text'
                : 'text-text-muted hover:text-text hover:bg-bg-tertiary/50'
            }`}
          >
            <span className="truncate">{item.label}</span>
          </button>
        )
      })}
    </div>
  )
}
