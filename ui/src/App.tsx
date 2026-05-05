import { useEffect, useMemo, useState } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { ActivityBar } from './components/ActivityBar'
import { Sidebar } from './components/Sidebar'
import { ChannelConfigModal } from './components/ChannelConfigModal'
import { ChannelsProvider, useChannels } from './contexts/ChannelsContext'
import { SECTIONS, STANDALONE_ROUTES, REDIRECT_ROUTES, findActiveSection } from './sections'

/**
 * Activity-bar pages — only items that appear as icons in the ActivityBar.
 * Settings sub-pages (AI Provider, Trading Accounts, etc.) live under
 * /settings/* and are addressed via SettingsCategoryList, not via this enum.
 */
export type Page =
  | 'chat' | 'diary' | 'portfolio' | 'news' | 'automation' | 'market'
  | 'trading-as-git'
  | 'settings' | 'dev'

/** Page type → URL path mapping. Used by the activity bar to know where each icon links. */
export const ROUTES: Record<Page, string> = {
  'chat': '/chat',
  'diary': '/diary',
  'portfolio': '/portfolio',
  'automation': '/automation',
  'market': '/market',
  'news': '/news',
  'trading-as-git': '/trading-as-git',
  'settings': '/settings',
  'dev': '/dev',
}

/** Track whether we're at a desktop viewport (md+ in Tailwind = ≥768px). */
function useIsDesktop(): boolean {
  const query = '(min-width: 768px)'
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : true,
  )
  useEffect(() => {
    const mq = window.matchMedia(query)
    const handler = () => setMatches(mq.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  return matches
}

export function App() {
  return (
    <ChannelsProvider>
      <AppShell />
    </ChannelsProvider>
  )
}

function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const location = useLocation()
  const section = findActiveSection(location.pathname)
  const isDesktop = useIsDesktop()
  const showSidebarPanel = isDesktop && section != null

  // Persist the user's resized layout to localStorage. `panelIds` scopes the
  // saved layout to the current panel set — sidebar+main and main-only get
  // independent entries, so the sidebar width survives mobile/desktop toggles
  // and route changes that drop the sidebar.
  const panelIds = useMemo(
    () => (showSidebarPanel ? ['sidebar', 'main'] : ['main']),
    [showSidebarPanel],
  )
  const { defaultLayout: savedLayout, onLayoutChanged } = useDefaultLayout({
    id: 'main-layout',
    panelIds,
  })
  const fallbackLayout: Record<string, number> = showSidebarPanel
    ? { sidebar: 14, main: 86 }
    : { main: 100 }

  // Main content (mobile header + routes). Same JSX whether or not a sidebar
  // is visible — keeps Routes mounted in one place so navigation state survives.
  const mainContent = (
    <main className="flex flex-col min-w-0 min-h-0 bg-bg h-full">
      {/* Mobile header — visible only below md */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-bg-secondary shrink-0 md:hidden">
        <button
          onClick={() => setSidebarOpen(true)}
          className="text-text-muted hover:text-text p-1 -ml-1"
          aria-label="Open menu"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M3 5h14M3 10h14M3 15h14" />
          </svg>
        </button>
        <span className="text-sm font-semibold text-text">OpenAlice</span>
      </div>

      <div key={location.pathname} className="page-fade-in flex-1 flex flex-col min-h-0">
        <Routes>
          {SECTIONS.flatMap((s) => s.routes).map((r) => (
            <Route key={r.path} path={r.path} element={r.element} />
          ))}
          {STANDALONE_ROUTES.map((r) => (
            <Route key={r.path} path={r.path} element={r.element} />
          ))}
          {REDIRECT_ROUTES.map((r) => (
            <Route key={r.path} path={r.path} element={r.element} />
          ))}
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Routes>
      </div>
    </main>
  )

  return (
    <div className="flex h-full">
      <ActivityBar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <Group
        orientation="horizontal"
        id="main-layout"
        className="flex-1 min-h-0"
        defaultLayout={savedLayout ?? fallbackLayout}
        onLayoutChanged={onLayoutChanged}
      >
        {showSidebarPanel && section && (
          <>
            <Panel id="sidebar" defaultSize={240} minSize={150} maxSize={500}>
              <Sidebar
                title={section.title}
                actions={section.Actions ? <section.Actions /> : undefined}
              >
                <section.Secondary />
              </Sidebar>
            </Panel>
            <Separator className="w-px bg-border hover:bg-accent/40 active:bg-accent/60 transition-colors" />
          </>
        )}
        <Panel id="main">
          {mainContent}
        </Panel>
      </Group>

      <ChannelDialogMount />
    </div>
  )
}

/** Reads dialog state from ChannelsContext and mounts the modal accordingly. */
function ChannelDialogMount() {
  const { channelDialog, closeDialog, onChannelSaved } = useChannels()
  if (!channelDialog) return null
  return (
    <ChannelConfigModal
      channel={channelDialog.mode === 'edit' ? channelDialog.channel : undefined}
      onClose={closeDialog}
      onSaved={onChannelSaved}
    />
  )
}
