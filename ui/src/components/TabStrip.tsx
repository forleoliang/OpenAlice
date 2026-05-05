import { useChannels } from '../contexts/ChannelsContext'
import { useWorkspace } from '../tabs/store'
import { getView } from '../tabs/registry'
import { type Tab } from '../tabs/types'

/**
 * The strip of tab buttons above the main content area. Phase 1 surface:
 * click to focus, × to close. No drag, no context menu, no overflow scroll
 * controls — just `overflow-x: auto` if the strip overflows.
 *
 * Hidden on mobile (`< md`) — phase 1 mobile is single-tab mode where the
 * tab strip would just be noise.
 */
export function TabStrip() {
  const { channels } = useChannels()
  const tabIds = useWorkspace((state) =>
    state.tree.kind === 'leaf' ? state.tree.group.tabIds : [],
  )
  const activeTabId = useWorkspace((state) =>
    state.tree.kind === 'leaf' ? state.tree.group.activeTabId : null,
  )
  const tabsMap = useWorkspace((state) => state.tabs)
  const focusTab = useWorkspace((state) => state.focusTab)
  const closeTab = useWorkspace((state) => state.closeTab)

  if (tabIds.length === 0) return null

  return (
    <div className="hidden md:flex shrink-0 h-9 bg-bg-secondary border-b border-border overflow-x-auto">
      {tabIds.map((id) => {
        const tab = tabsMap[id]
        if (!tab) return null
        const view = getView(tab.spec.kind)
        const title = view.title(tab.spec as never, { channels })
        const isActive = id === activeTabId
        return (
          <TabButton
            key={id}
            title={title}
            active={isActive}
            onSelect={() => focusTab(id)}
            onClose={() => closeTab(id)}
          />
        )
      })}
    </div>
  )
}

interface TabButtonProps {
  title: string
  active: boolean
  onSelect: () => void
  onClose: () => void
}

function TabButton({ title, active, onSelect, onClose }: TabButtonProps) {
  return (
    <div
      onClick={onSelect}
      onAuxClick={(e) => {
        // Middle click closes the tab (matches VS Code / browser convention).
        if (e.button === 1) {
          e.preventDefault()
          onClose()
        }
      }}
      className={`group flex items-center gap-2 pl-3 pr-2 h-full text-[13px] cursor-pointer border-r border-border transition-colors ${
        active
          ? 'bg-bg text-text'
          : 'text-text-muted hover:text-text hover:bg-bg-tertiary/40'
      }`}
    >
      <span className="truncate max-w-[200px]">{title}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        className="w-4 h-4 rounded flex items-center justify-center text-text-muted/60 hover:text-text hover:bg-bg-tertiary"
        aria-label={`Close ${title}`}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}
