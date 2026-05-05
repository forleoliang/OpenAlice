import { useChannels } from '../contexts/ChannelsContext'
import { ChatChannelList } from './ChatChannelList'

/**
 * Connects ChatChannelList to ChannelsContext. Used as the chat section's
 * Secondary slot — sections.tsx renders this; it pulls state from context
 * and renders the dumb list component.
 */
export function ChatChannelListContainer() {
  const { channels, activeChannel, selectChannel, openEditDialog, deleteChannel } = useChannels()

  return (
    <ChatChannelList
      channels={channels}
      activeChannel={activeChannel}
      onSelect={selectChannel}
      onEdit={openEditDialog}
      onDelete={deleteChannel}
    />
  )
}
