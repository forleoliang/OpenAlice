import type { ReactNode } from 'react'

interface SecondarySidebarProps {
  /** Header title — uppercase tracking like VS Code's "EXPLORER", "SEARCH", etc. */
  title: string
  /** Optional action buttons rendered right-aligned in the header (e.g. "+ new"). */
  actions?: ReactNode
  /** Pixel width. Controllable so a future drag-resize layer can drive it. Defaults to 240. */
  width?: number
  /** Scrollable body content. */
  children: ReactNode
}

const DEFAULT_WIDTH = 240

/**
 * VS Code-style secondary sidebar — sits between the activity bar and the
 * main panel. Page-specific content (channel list, workspace tree, search
 * results, etc.) lives here. Desktop only — hidden on mobile.
 *
 * Width is a controlled prop so a future drag handle / persistence layer
 * can drive it without restructuring this component.
 */
export function SecondarySidebar({ title, actions, width = DEFAULT_WIDTH, children }: SecondarySidebarProps) {
  return (
    <aside
      className="hidden md:flex h-full flex-col bg-bg-secondary shrink-0"
      style={{ width }}
    >
      <div className="flex items-center justify-between px-3 h-10 shrink-0">
        <h2 className="text-[13px] font-medium text-text">{title}</h2>
        {actions && <div className="flex items-center gap-0.5">{actions}</div>}
      </div>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </aside>
  )
}
