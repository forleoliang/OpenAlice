import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api } from '../api'
import type { ChannelListItem } from '../api/channels'

/** Channel-config dialog mode (create new vs edit existing). */
export type ChannelDialog =
  | { mode: 'create' }
  | { mode: 'edit'; channel: ChannelListItem }
  | null

interface ChannelsContextValue {
  channels: ChannelListItem[]
  activeChannel: string
  channelDialog: ChannelDialog
  selectChannel: (id: string) => void
  openCreateDialog: () => void
  openEditDialog: (channel: ChannelListItem) => void
  closeDialog: () => void
  deleteChannel: (id: string) => Promise<void>
  /** Called by ChannelConfigModal when its save (create or edit) succeeds. */
  onChannelSaved: (channel: ChannelListItem) => void
}

const ChannelsContext = createContext<ChannelsContextValue | null>(null)

/**
 * App-level provider for chat-channel state.
 *
 * Lives above the route layer so channels list / active channel / dialog state
 * survive navigation across sections (you don't refetch channels every time you
 * pop in and out of /chat).
 */
export function ChannelsProvider({ children }: { children: ReactNode }) {
  const [channels, setChannels] = useState<ChannelListItem[]>([])
  const [activeChannel, setActiveChannel] = useState('default')
  const [channelDialog, setChannelDialog] = useState<ChannelDialog>(null)

  useEffect(() => {
    api.channels.list().then(({ channels: ch }) => setChannels(ch)).catch(() => {})
  }, [])

  const selectChannel = useCallback((id: string) => setActiveChannel(id), [])
  const openCreateDialog = useCallback(() => setChannelDialog({ mode: 'create' }), [])
  const openEditDialog = useCallback((channel: ChannelListItem) => setChannelDialog({ mode: 'edit', channel }), [])
  const closeDialog = useCallback(() => setChannelDialog(null), [])

  const deleteChannel = useCallback(async (id: string) => {
    try {
      await api.channels.remove(id)
      setChannels((prev) => prev.filter((ch) => ch.id !== id))
      setActiveChannel((curr) => (curr === id ? 'default' : curr))
    } catch (err) {
      console.error('Failed to delete channel:', err)
    }
  }, [])

  const onChannelSaved = useCallback((saved: ChannelListItem) => {
    setChannels((prev) => {
      const exists = prev.some((ch) => ch.id === saved.id)
      return exists ? prev.map((ch) => ch.id === saved.id ? saved : ch) : [...prev, saved]
    })
    // Newly created channels become active immediately.
    setChannelDialog((dialog) => {
      if (dialog?.mode === 'create') setActiveChannel(saved.id)
      return null
    })
  }, [])

  const value: ChannelsContextValue = {
    channels,
    activeChannel,
    channelDialog,
    selectChannel,
    openCreateDialog,
    openEditDialog,
    closeDialog,
    deleteChannel,
    onChannelSaved,
  }

  return <ChannelsContext.Provider value={value}>{children}</ChannelsContext.Provider>
}

export function useChannels(): ChannelsContextValue {
  const ctx = useContext(ChannelsContext)
  if (!ctx) throw new Error('useChannels must be used within ChannelsProvider')
  return ctx
}
