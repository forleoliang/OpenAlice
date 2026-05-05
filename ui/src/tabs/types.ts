/**
 * Tabs / Workspace data model.
 *
 * Conceptually mirrors VS Code's editor area:
 *   ViewSpec       = "what is being shown" (kind + params, like a key)
 *   Tab            = a ViewSpec instance with a stable id
 *   TabGroup       = an ordered set of tabs with one active
 *   WorkspaceTree  = recursive — leaf is a TabGroup, branch is a split
 *   WorkspaceState = the whole workspace (tabs + tree + focus)
 *
 * Phase 1 collapses the tree to always be `{ kind: 'leaf', group }` —
 * the recursive shape exists so phase 3 can introduce splits without
 * a data-model change.
 */

export type ViewSpec =
  | { kind: 'chat';           params: { channelId: string } }
  | { kind: 'diary';          params: Record<string, never> }
  | { kind: 'portfolio';      params: Record<string, never> }
  | { kind: 'automation';     params: Record<string, never> }
  | { kind: 'news';           params: Record<string, never> }
  | { kind: 'market-list';    params: Record<string, never> }
  | { kind: 'market-detail';  params: { assetClass: 'equity' | 'crypto' | 'currency' | 'commodity'; symbol: string } }
  | { kind: 'trading-as-git'; params: Record<string, never> }
  | { kind: 'settings';       params: { category: 'general' | 'ai-provider' | 'trading' | 'connectors' | 'market-data' | 'news-collector' } }
  | { kind: 'uta-detail';     params: { id: string } }
  | { kind: 'dev';            params: { tab: 'connectors' | 'tools' | 'sessions' | 'snapshots' | 'logs' } }

export type ViewKind = ViewSpec['kind']

export interface Tab {
  id: string
  spec: ViewSpec
}

export interface TabGroup {
  id: string
  tabIds: string[]
  activeTabId: string | null
}

export type WorkspaceTree =
  | { kind: 'leaf'; group: TabGroup }
  | { kind: 'split'; orientation: 'horizontal' | 'vertical'; sizes: number[]; children: WorkspaceTree[] }

export interface WorkspaceState {
  tabs: Record<string, Tab>
  tree: WorkspaceTree
  focusedGroupId: string
}

/**
 * Two ViewSpecs are equal when kind matches and all params are shallow-equal.
 * Used by openOrFocus to find an existing tab for a given spec.
 *
 * All params today are flat (string / boolean) — shallow equal is sufficient.
 * If a future kind needs deeper equality (e.g. a filter object), override per
 * kind in the view registry.
 */
export function specEquals(a: ViewSpec, b: ViewSpec): boolean {
  if (a.kind !== b.kind) return false
  const aParams = a.params as Record<string, unknown>
  const bParams = b.params as Record<string, unknown>
  const aKeys = Object.keys(aParams)
  const bKeys = Object.keys(bParams)
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) {
    if (aParams[k] !== bParams[k]) return false
  }
  return true
}

/** Phase 1 helper: workspace tree is always a leaf, so this just unwraps it. */
export function getFocusedGroup(state: WorkspaceState): TabGroup | null {
  return state.tree.kind === 'leaf' ? state.tree.group : null
}

/** Phase 1 helper: derive the focused tab from state, or null if there is none. */
export function getFocusedTab(state: WorkspaceState): Tab | null {
  const group = getFocusedGroup(state)
  if (!group?.activeTabId) return null
  return state.tabs[group.activeTabId] ?? null
}
