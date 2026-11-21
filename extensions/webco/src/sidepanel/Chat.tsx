import { useAuth } from '@clerk/chrome-extension'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { track } from '../analytics'
import { currentTabKind, type TabKind } from '@cofun/tools'
import { AccountMenu } from './Account'
import type { ChatSession } from './chat-session'
import { Composer, useComposer } from './Composer'
import { CreditsPage } from './Credits'
import { Header } from './Header'
import { Icon } from './icons'
import { chatHeading, MessageList } from './Messages'
import { ModelNote } from './Model'
import { Panel } from './panel'
import { Sessions, type OpenResult } from './Sessions'
import { Settings } from './Settings'
import { ChatStart } from './Suggestions'

/** The chat of one signed-in user; mount a new one for another user. */
export function Chat({ userId }: { userId: string }) {
  const { getToken } = useAuth()
  const tokenRef = useRef(getToken)
  tokenRef.current = getToken
  const [panel] = useState(() => new Panel(userId, () => tokenRef.current()))
  useEffect(() => panel.connect(), [panel])
  const snapshot = useSyncExternalStore(panel.subscribe, panel.getSnapshot)
  const { chat, credits, model } = snapshot
  // Only what the panel around the messages shows of the chat: a streamed reply draws the message list alone.
  const busy = useSyncExternalStore(chat.subscribe, () => chat.getSnapshot().status !== 'ready')
  const empty = useSyncExternalStore(chat.subscribe, () => chat.getSnapshot().messages.length === 0)
  const chatId = useSyncExternalStore(chat.subscribe, () => chat.getSnapshot().id)

  const listRef = useRef<HTMLElement>(null)
  const listButtonRef = useRef<HTMLButtonElement>(null)
  const accountButtonRef = useRef<HTMLButtonElement>(null)
  const modelButtonRef = useRef<HTMLButtonElement>(null)
  const [view, setView] = useState<'chat' | 'sessions' | 'credits' | 'settings'>('chat')
  // Opened from the model menu's "Manage models": the Settings page puts the focus on Providers.
  const [settingsAt, setSettingsAt] = useState<'providers'>()

  const readable = useTabReadable()
  const composer = useComposer({ panel, chat, busy })

  const openCredits = useCallback(() => {
    track({ event: 'credits_opened' })
    setView('credits')
    void panel.readCredits()
  }, [panel])

  function openSettings(at?: 'providers') {
    track({ event: 'settings_opened' })
    setSettingsAt(at)
    setView('settings')
  }

  // Closing a page puts the focus back on what led to it (the model chip, or the avatar), once the
  // header it is in is no longer covered (and inert).
  const focusAfter = useRef<HTMLElement | null>(null)
  function closePage() {
    focusAfter.current = (view === 'settings' && settingsAt === 'providers' ? modelButtonRef : accountButtonRef).current
    setView('chat')
  }
  useEffect(() => {
    if (view !== 'chat' || !focusAfter.current) return
    focusAfter.current.focus()
    focusAfter.current = null
  }, [view])
  // Opening a chat from the session list puts the focus in the message box once the list has closed,
  // instead of leaving it on the row the list took away.
  const [focusInput, setFocusInput] = useState(0)
  useEffect(() => {
    if (focusInput) composer.focus()
  }, [focusInput])

  /** Opens a saved session from the list, unless it no longer exists or can't be read. */
  async function open(id: string): Promise<OpenResult> {
    const result = await panel.open(id)
    if (result === 'gone' || result === 'unreadable') return result
    // The user started a new chat, opened another session, or asked something meanwhile; that wins.
    if (result === 'overtaken') return 'opened'
    setView('chat')
    setFocusInput((n) => n + 1)
    return 'opened'
  }

  /** Closes the session list and puts the focus back on the button that opened it. */
  function closeList() {
    setView('chat')
    listButtonRef.current?.focus()
  }

  const pendingChange = useSyncExternalStore(chat.subscribe, () => {
    const reply = chat.getSnapshot().messages.at(-1)
    if (reply?.role !== 'assistant') return undefined
    for (const part of reply.parts) {
      if (part.type === 'tool' && part.tool.status === 'running' && part.tool.preview) return part.tool.preview
    }
    return undefined
  })

  const listOpen = view === 'sessions'
  // A page (Credits or Settings) covers the whole panel, the header included.
  const pageOpen = view === 'credits' || view === 'settings'
  // The chat stays on screen, or mounted, behind the session list and the pages, out of reach until they close.
  const covered = listOpen || pageOpen

  return (
    <>
      <ChatHeader chat={chat} inert={pageOpen}>
        <button
          ref={listButtonRef}
          className="icon-button tip-below"
          aria-label="Chats"
          data-tip="Chats"
          aria-expanded={listOpen}
          onClick={() => (listOpen ? closeList() : setView('sessions'))}
        >
          <Icon name="history" />
        </button>
        <button
          className="icon-button tip-below"
          aria-label="New chat"
          data-tip="New chat"
          onClick={() => {
            panel.newChat()
            setView('chat')
          }}
        >
          <Icon name="compose" />
        </button>
        <AccountMenu
          credits={credits}
          onOpen={() => void panel.readCredits()}
          onCredits={openCredits}
          onSettings={() => openSettings()}
          buttonRef={accountButtonRef}
        />
      </ChatHeader>

      <div className="stage">
        <main id="messages" ref={listRef} inert={covered}>
          {empty && <ChatStart readable={readable} onPick={composer.fill} />}
          <MessageList chat={chat} onBuyCredits={openCredits} scrollRef={listRef} />
        </main>

        <ModelNote settings={model} />
        <Composer
          composer={composer}
          panel={panel}
          snapshot={snapshot}
          covered={covered}
          onManageModels={() => openSettings('providers')}
          modelButtonRef={modelButtonRef}
        />

        {listOpen && (
          <Sessions
            store={panel.store}
            currentId={chatId}
            pendingChange={pendingChange}
            saved={snapshot.saved}
            onOpen={open}
            onClose={closeList}
            onDelete={(id) => panel.delete(id)}
          />
        )}
      </div>

      {view === 'credits' && (
        <CreditsPage
          credits={credits}
          grants={() => panel.creditGrants()}
          buying={{ packs: () => panel.creditPacks(), buy: (quantity) => panel.buyCredits(quantity) }}
          onClose={closePage}
        />
      )}
      {view === 'settings' && (
        <Settings
          userId={userId}
          model={model}
          onModelChange={(change) => panel.changeModel(change)}
          at={settingsAt}
          onClose={closePage}
        />
      )}
    </>
  )
}

/** The chat title and the panel's actions. */
function ChatHeader({ chat, inert, children }: { chat: ChatSession; inert: boolean; children: ReactNode }) {
  const title = useSyncExternalStore(chat.subscribe, () => chatHeading(chat.getSnapshot()))
  return (
    <Header title={title || <span className="untitled">New chat</span>} inert={inert}>
      {children}
    </Header>
  )
}

/** Follows what the current tab would be read as with a site grant (a video or a page), if it can be read. */
function useTabReadable(): TabKind | undefined {
  const [readable, setReadable] = useState<TabKind>()
  useEffect(() => {
    let reads = 0
    const read = () => {
      const n = ++reads
      void currentTabKind()
        .catch(() => undefined)
        .then((kind) => {
          if (n === reads) setReadable(kind)
        })
    }
    const onUpdated = (_id: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      if (tab.active && (change.url !== undefined || change.title !== undefined)) read()
    }
    read()
    chrome.tabs.onActivated.addListener(read)
    chrome.tabs.onUpdated.addListener(onUpdated)
    chrome.tabs.onReplaced.addListener(read)
    return () => {
      reads++
      chrome.tabs.onActivated.removeListener(read)
      chrome.tabs.onUpdated.removeListener(onUpdated)
      chrome.tabs.onReplaced.removeListener(read)
    }
  }, [])
  return readable
}
