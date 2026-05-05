/**
 * Section config — what the secondary sidebar shows for a given focused
 * tab's view kind.
 *
 * Pre-tabs, this file also held the route table; routes have moved to
 * tabs/UrlAdopter.tsx (URL → spec adoption) and tabs/registry.tsx (spec →
 * URL projection). Sidebar sections live here because their content is
 * decided by the focused tab, not by URL.
 */

import type { ComponentType } from 'react'
import { ChatChannelListContainer } from './components/ChatChannelListContainer'
import { NewChannelButton } from './components/NewChannelButton'
import { PushApprovalPanel } from './components/PushApprovalPanel'
import { SettingsCategoryList } from './components/SettingsCategoryList'
import { DevCategoryList } from './components/DevCategoryList'
import { getView, type ActivitySection } from './tabs/registry'
import type { ViewKind } from './tabs/types'

export interface SidebarSection {
  /** Header title — shown at the top of the sidebar. */
  title: string
  /** The actual navigator content. */
  Secondary: ComponentType
  /** Optional right-aligned action buttons in the sidebar header (e.g. "+ new"). */
  Actions?: ComponentType
}

const SECTION_BY_KEY: Record<Exclude<ActivitySection, null>, SidebarSection> = {
  chat: {
    title: 'Chat',
    Secondary: ChatChannelListContainer,
    Actions: NewChannelButton,
  },
  'trading-as-git': {
    title: 'Trading as Git',
    Secondary: PushApprovalPanel,
  },
  settings: {
    title: 'Settings',
    Secondary: SettingsCategoryList,
  },
  dev: {
    title: 'Dev',
    Secondary: DevCategoryList,
  },
}

/**
 * Resolve which secondary sidebar (if any) to show given the focused tab's
 * kind. Returns null for kinds without a sidebar (e.g. market-list, news,
 * portfolio) — App.tsx uses null to collapse the sidebar panel.
 */
export function findSectionForKind(kind: ViewKind | null | undefined): SidebarSection | null {
  if (!kind) return null
  const activitySection = getView(kind).activitySection
  if (!activitySection) return null
  return SECTION_BY_KEY[activitySection]
}
