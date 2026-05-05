import type { ComponentType } from 'react'
import type { ChannelListItem } from '../api/channels'
import type { Page } from '../App'
import type { ViewKind, ViewSpec } from './types'

import { ChatPage } from '../pages/ChatPage'
import { DiaryPage } from '../pages/DiaryPage'
import { PortfolioPage } from '../pages/PortfolioPage'
import { AutomationPage } from '../pages/AutomationPage'
import { NewsPage } from '../pages/NewsPage'
import { MarketPage } from '../pages/MarketPage'
import { MarketDetailPage } from '../pages/MarketDetailPage'
import { TradingAsGitPage } from '../pages/TradingAsGitPage'
import { SettingsPage } from '../pages/SettingsPage'
import { AIProviderPage } from '../pages/AIProviderPage'
import { TradingPage } from '../pages/TradingPage'
import { ConnectorsPage } from '../pages/ConnectorsPage'
import { MarketDataPage } from '../pages/MarketDataPage'
import { NewsCollectorPage } from '../pages/NewsCollectorPage'
import { UTADetailPage } from '../pages/UTADetailPage'
import { DevPage } from '../pages/DevPage'

/**
 * Central registry mapping each ViewKind to its render component, URL
 * projection, and activity-bar / sidebar metadata. Adding a new view kind
 * means adding one entry here — the rest of the app reads through this
 * table rather than special-casing per page.
 */

export type ActivitySection = 'chat' | 'settings' | 'dev' | 'trading-as-git' | null

export interface TitleCtx {
  channels: ChannelListItem[]
}

interface ViewProps<K extends ViewKind> {
  spec: Extract<ViewSpec, { kind: K }>
  visible: boolean
}

export interface ViewModule<K extends ViewKind> {
  kind: K
  /** Tab title — derived from spec each render so e.g. channel renames propagate. */
  title(spec: Extract<ViewSpec, { kind: K }>, ctx: TitleCtx): string
  /** URL the active tab projects onto window.location (via replaceState). */
  toUrl(spec: Extract<ViewSpec, { kind: K }>): string
  /** The actual page component. Ignores `visible` unless it needs catch-up behaviour. */
  Component: ComponentType<ViewProps<K>>
  /** Which secondary sidebar to show when a tab of this kind is focused. */
  activitySection: ActivitySection
  /** Which ActivityBar item lights up. */
  activityIcon: Page
}

// ==================== Per-kind modules ====================

const chatModule: ViewModule<'chat'> = {
  kind: 'chat',
  title(spec, ctx) {
    const ch = ctx.channels.find((c) => c.id === spec.params.channelId)
    return ch?.label ?? spec.params.channelId
  },
  toUrl(spec) {
    return spec.params.channelId === 'default'
      ? '/chat'
      : `/chat/${encodeURIComponent(spec.params.channelId)}`
  },
  Component: ChatPage,
  activitySection: 'chat',
  activityIcon: 'chat',
}

const diaryModule: ViewModule<'diary'> = {
  kind: 'diary',
  title: () => 'Diary',
  toUrl: () => '/diary',
  Component: () => <DiaryPage />,
  activitySection: null,
  activityIcon: 'diary',
}

const portfolioModule: ViewModule<'portfolio'> = {
  kind: 'portfolio',
  title: () => 'Portfolio',
  toUrl: () => '/portfolio',
  Component: () => <PortfolioPage />,
  activitySection: null,
  activityIcon: 'portfolio',
}

const automationModule: ViewModule<'automation'> = {
  kind: 'automation',
  title: () => 'Automation',
  toUrl: () => '/automation',
  Component: () => <AutomationPage />,
  activitySection: null,
  activityIcon: 'automation',
}

const newsModule: ViewModule<'news'> = {
  kind: 'news',
  title: () => 'News',
  toUrl: () => '/news',
  Component: () => <NewsPage />,
  activitySection: null,
  activityIcon: 'news',
}

const marketListModule: ViewModule<'market-list'> = {
  kind: 'market-list',
  title: () => 'Market',
  toUrl: () => '/market',
  Component: () => <MarketPage />,
  activitySection: null,
  activityIcon: 'market',
}

const marketDetailModule: ViewModule<'market-detail'> = {
  kind: 'market-detail',
  title: (spec) => `${spec.params.symbol}`,
  toUrl: (spec) =>
    `/market/${spec.params.assetClass}/${encodeURIComponent(spec.params.symbol)}`,
  Component: MarketDetailPage,
  activitySection: null,
  activityIcon: 'market',
}

const tradingAsGitModule: ViewModule<'trading-as-git'> = {
  kind: 'trading-as-git',
  title: () => 'Trading as Git',
  toUrl: () => '/trading-as-git',
  Component: () => <TradingAsGitPage />,
  activitySection: 'trading-as-git',
  activityIcon: 'trading-as-git',
}

const settingsCategoryTitle: Record<
  Extract<ViewSpec, { kind: 'settings' }>['params']['category'],
  string
> = {
  general: 'Settings',
  'ai-provider': 'AI Provider',
  trading: 'Trading Accounts',
  connectors: 'Connectors',
  'market-data': 'Market Data',
  'news-collector': 'News Sources',
}

function SettingsRouter({ spec }: ViewProps<'settings'>) {
  switch (spec.params.category) {
    case 'general': return <SettingsPage />
    case 'ai-provider': return <AIProviderPage />
    case 'trading': return <TradingPage />
    case 'connectors': return <ConnectorsPage />
    case 'market-data': return <MarketDataPage />
    case 'news-collector': return <NewsCollectorPage />
  }
}

const settingsModule: ViewModule<'settings'> = {
  kind: 'settings',
  title: (spec) => settingsCategoryTitle[spec.params.category],
  toUrl: (spec) =>
    spec.params.category === 'general'
      ? '/settings'
      : `/settings/${spec.params.category}`,
  Component: SettingsRouter,
  activitySection: 'settings',
  activityIcon: 'settings',
}

const utaDetailModule: ViewModule<'uta-detail'> = {
  kind: 'uta-detail',
  title: (spec) => `Account ${spec.params.id}`,
  toUrl: (spec) => `/settings/uta/${encodeURIComponent(spec.params.id)}`,
  Component: UTADetailPage,
  activitySection: 'settings',
  activityIcon: 'settings',
}

const devTabTitle: Record<Extract<ViewSpec, { kind: 'dev' }>['params']['tab'], string> = {
  connectors: 'Connectors',
  tools: 'Tools',
  sessions: 'Sessions',
  snapshots: 'Snapshots',
  logs: 'Logs',
}

const devModule: ViewModule<'dev'> = {
  kind: 'dev',
  title: (spec) => devTabTitle[spec.params.tab],
  toUrl: (spec) => `/dev/${spec.params.tab}`,
  Component: DevPage,
  activitySection: 'dev',
  activityIcon: 'dev',
}

// ==================== Aggregate ====================

export const VIEWS = {
  chat: chatModule,
  diary: diaryModule,
  portfolio: portfolioModule,
  automation: automationModule,
  news: newsModule,
  'market-list': marketListModule,
  'market-detail': marketDetailModule,
  'trading-as-git': tradingAsGitModule,
  settings: settingsModule,
  'uta-detail': utaDetailModule,
  dev: devModule,
} as const satisfies { [K in ViewKind]: ViewModule<K> }

/** Untyped lookup — narrow at the call site by inspecting `spec.kind`. */
export function getView<K extends ViewKind>(kind: K): ViewModule<K> {
  return VIEWS[kind] as unknown as ViewModule<K>
}

/** Default spec a fresh activity click should open. */
export function defaultSpecForActivity(page: Page): ViewSpec | null {
  switch (page) {
    case 'chat':           return { kind: 'chat',           params: { channelId: 'default' } }
    case 'diary':          return { kind: 'diary',          params: {} }
    case 'portfolio':      return { kind: 'portfolio',      params: {} }
    case 'automation':     return { kind: 'automation',     params: {} }
    case 'news':           return { kind: 'news',           params: {} }
    case 'market':         return { kind: 'market-list',    params: {} }
    case 'trading-as-git': return { kind: 'trading-as-git', params: {} }
    case 'settings':       return { kind: 'settings',       params: { category: 'general' } }
    case 'dev':            return { kind: 'dev',            params: { tab: 'connectors' } }
    default:               return null
  }
}
