import { useChannels } from '../contexts/ChannelsContext'
import { useWorkspace } from '../tabs/store'
import { getFocusedTab } from '../tabs/types'
import { ChatChannelList } from './ChatChannelList'

/**
 * Connects ChatChannelList to ChannelsContext + the workspace store.
 *
 * "Active channel" used to live in ChannelsContext as a singleton. With
 * tabs, the active channel is whatever the currently-focused chat tab
 * points at — there's no separate concept. We derive it from the store
 * here. When the focused tab isn't a chat tab, no row is highlighted.
 */
export function ChatChannelListContainer() {
  const { channels, openEditDialog, deleteChannel } = useChannels()
  const focusedChannelId = useWorkspace((state) => {
    const tab = getFocusedTab(state)
    return tab?.spec.kind === 'chat' ? tab.spec.params.channelId : ''
  })
  const openOrFocus = useWorkspace((state) => state.openOrFocus)

  return (
    <ChatChannelList
      channels={channels}
      activeChannel={focusedChannelId}
      onSelect={(id) => openOrFocus({ kind: 'chat', params: { channelId: id } })}
      onEdit={openEditDialog}
      onDelete={deleteChannel}
    />
  )
}
