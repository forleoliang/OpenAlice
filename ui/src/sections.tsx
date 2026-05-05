/**
 * Section config — declarative description of every section that has a
 * secondary sidebar (navigator), plus standalone routes that don't.
 *
 * Adding a new section here adds it to the layout in one place; App.tsx
 * doesn't need to grow if-then chains.
 */

import { Navigate } from 'react-router-dom'
import type { ComponentType, ReactElement } from 'react'

import { ChatPage } from './pages/ChatPage'
import { DiaryPage } from './pages/DiaryPage'
import { PortfolioPage } from './pages/PortfolioPage'
import { AutomationPage } from './pages/AutomationPage'
import { SettingsPage } from './pages/SettingsPage'
import { AIProviderPage } from './pages/AIProviderPage'
import { MarketDataPage } from './pages/MarketDataPage'
import { MarketPage } from './pages/MarketPage'
import { MarketDetailPage } from './pages/MarketDetailPage'
import { NewsPage } from './pages/NewsPage'
import { NewsCollectorPage } from './pages/NewsCollectorPage'
import { TradingPage } from './pages/TradingPage'
import { UTADetailPage } from './pages/UTADetailPage'
import { ConnectorsPage } from './pages/ConnectorsPage'
import { DevPage } from './pages/DevPage'

import { ChatChannelListContainer } from './components/ChatChannelListContainer'
import { NewChannelButton } from './components/NewChannelButton'
import { SettingsCategoryList } from './components/SettingsCategoryList'
import { DevCategoryList } from './components/DevCategoryList'

export interface RouteSpec {
  path: string
  element: ReactElement
}

export interface AppSection {
  /** URL prefixes that activate this section. '/' matches exact-only; others match prefix. */
  paths: string[]
  /** Header text in the secondary sidebar. */
  title: string
  /** Navigator UI rendered inside the secondary sidebar body. */
  Secondary: ComponentType
  /** Optional right-aligned action buttons in the secondary sidebar header. */
  Actions?: ComponentType
  /** Routes contributed by this section — rendered at app level by <Routes>. */
  routes: RouteSpec[]
}

export const SECTIONS: AppSection[] = [
  {
    paths: ['/'],
    title: 'Chats',
    Secondary: ChatChannelListContainer,
    Actions: NewChannelButton,
    routes: [
      { path: '/', element: <ChatPage /> },
    ],
  },
  {
    paths: ['/settings', '/ai-provider', '/trading', '/uta', '/connectors', '/market-data', '/news-collector'],
    title: 'Settings',
    Secondary: SettingsCategoryList,
    routes: [
      { path: '/settings', element: <SettingsPage /> },
      { path: '/ai-provider', element: <AIProviderPage /> },
      { path: '/trading', element: <TradingPage /> },
      { path: '/uta/:id', element: <UTADetailPage /> },
      { path: '/connectors', element: <ConnectorsPage /> },
      { path: '/market-data', element: <MarketDataPage /> },
      { path: '/news-collector', element: <NewsCollectorPage /> },
    ],
  },
  {
    paths: ['/dev'],
    title: 'Dev',
    Secondary: DevCategoryList,
    routes: [
      { path: '/dev', element: <Navigate to="/dev/connectors" replace /> },
      { path: '/dev/:tab', element: <DevPage /> },
    ],
  },
]

/**
 * Top-level routes that don't (yet) have a secondary-sidebar navigator.
 * Will become full sections when their navigator is designed.
 */
export const STANDALONE_ROUTES: RouteSpec[] = [
  { path: '/diary', element: <DiaryPage /> },
  { path: '/portfolio', element: <PortfolioPage /> },
  { path: '/automation', element: <AutomationPage /> },
  { path: '/market', element: <MarketPage /> },
  { path: '/market/:assetClass/:symbol', element: <MarketDetailPage /> },
  { path: '/news', element: <NewsPage /> },
]

/** Old URLs preserved as redirects to their current locations. */
export const REDIRECT_ROUTES: RouteSpec[] = [
  { path: '/logs', element: <Navigate to="/dev/logs" replace /> },
  { path: '/events', element: <Navigate to="/dev/logs" replace /> },
  { path: '/heartbeat', element: <Navigate to="/automation" replace /> },
  { path: '/scheduler', element: <Navigate to="/automation" replace /> },
  { path: '/agent-status', element: <Navigate to="/dev/logs" replace /> },
  { path: '/data-sources', element: <Navigate to="/market-data" replace /> },
  { path: '/tools', element: <Navigate to="/settings" replace /> },
]

/**
 * Find which section (if any) is active for the given pathname.
 * Returns undefined for routes that don't belong to any section
 * (e.g. STANDALONE_ROUTES — no secondary sidebar to render).
 */
export function findActiveSection(pathname: string): AppSection | undefined {
  return SECTIONS.find((s) =>
    s.paths.some((p) => {
      if (p === '/') return pathname === '/'
      return pathname === p || pathname.startsWith(p + '/')
    }),
  )
}
