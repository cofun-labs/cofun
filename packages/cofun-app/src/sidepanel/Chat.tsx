import { useAuth } from '@clerk/chrome-extension'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { SiteIntegration } from '../product'
import type { OpenPage } from '../tools/current'
import { AccountMenu } from './Account'
import type { ChatSession } from './chat-session'
import { Composer, useComposer } from './Composer'
import { CreditsPage } from './Credits'
import { Header } from './Header'
import { Icon } from './icons'
import { askedIn, chatHeading, chatSaveKey, MessageList, saveToSite } from './Messages'
import { ModelNote } from './Model'
import { Panel } from './panel'
import { SaveButton } from './Save'
import { Sessions, type OpenResult } from './Sessions'
import { Settings } from './Settings'
import { useProduct } from './product'

/** The chat of one signed-in user; mount a new one for another user. */
export function Chat({ userId }: { userId: string }) {
  const product = useProduct()
  const { site, Start } = product
  const { getToken } = useAuth()
  const tokenRef = useRef(getToken)
  tokenRef.current = getToken
  const [panel] = useState(() => new Panel(product, userId, () => tokenRef.current()))
  useEffect(() => panel.connect(), [panel])
  const snapshot = useSyncExternalStore(panel.subscribe, panel.getSnapshot)
  const { chat, credits, model, mode } = snapshot
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

  const tabPage = useTabPage(site)
  const composer = useComposer({ panel, chat, tabPage, busy })

  const openCredits = useCallback(() => {
    product.analytics?.track({ event: 'credits_opened' })
    setView('credits')
    void panel.readCredits()
  }, [panel, product])

  function openSettings(at?: 'providers') {
    product.analytics?.track({ event: 'settings_opened' })
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

  const listOpen = view === 'sessions'
  // A page (Credits or Settings) covers the whole panel, the header included.
  const pageOpen = view === 'credits' || view === 'settings'
  // The chat stays on screen, or mounted, behind the session list and the pages, out of reach until they close.
  const covered = listOpen || pageOpen
  // Saving goes under the page open in the current tab as the user saves (see savePage).
  const saveBlocked = tabPage && site?.pageId(tabPage.url) ? undefined : site?.saveBlocked

  return (
    <>
      <ChatHeader chat={chat} inert={pageOpen} canSave={!covered} saveBlocked={saveBlocked}>
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
          {empty && <Start context={{ ...composer.start, mode }} onPick={composer.fill} />}
          <MessageList chat={chat} saveBlocked={saveBlocked} onBuyCredits={openCredits} scrollRef={listRef} />
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
          model={model}
          onModelChange={(change) => panel.changeModel(change)}
          at={settingsAt}
          onClose={closePage}
        />
      )}
    </>
  )
}

/** The top of the chat: its title, saving the whole chat to Notion, and the panel's actions (`children`). */
function ChatHeader({
  chat,
  inert,
  canSave,
  saveBlocked,
  children,
}: {
  chat: ChatSession
  inert: boolean
  /** Not while the list or a page covers the chat: what it saves, and its toast, are behind them. */
  canSave: boolean
  saveBlocked?: string
  children: ReactNode
}) {
  const { site } = useProduct()
  // The header cuts the title to fit.
  const title = useSyncExternalStore(chat.subscribe, () => chatHeading(chat.getSnapshot()))
  const asked = useSyncExternalStore(chat.subscribe, () => askedIn(chat.getSnapshot()))
  const saveState = useSyncExternalStore(chat.subscribe, () => {
    const now = chat.getSnapshot()
    return now.saves[chatSaveKey(now)]
  })
  return (
    <Header title={title || <span className="untitled">New chat</span>} inert={inert}>
      {site && asked > 0 && canSave && (
        <SaveButton
          what="chat"
          destination={site.name}
          className="icon-button"
          tipBelow
          state={saveState}
          blocked={saveBlocked}
          onSave={() => saveToSite(chat, site, 'chat')}
        />
      )}
      {children}
    </Header>
  )
}

/**
 * The Notion page open in the current tab, if one is, as the tab says: no Notion request. Follows the
 * tab: switching tabs, the tab going to another page or renaming it, or Chrome swapping in a
 * prerendered tab for it (onReplaced, which fires neither of the others).
 */
function useTabPage(site?: SiteIntegration): OpenPage | undefined {
  const [tabPage, setTabPage] = useState<OpenPage>()
  useEffect(() => {
    const currentPage = site?.currentPage
    if (!currentPage) return
    let reads = 0
    const read = () => {
      const n = ++reads
      void currentPage()
        .catch(() => undefined)
        .then((page) => {
          if (n !== reads) return
          setTabPage((was) => (was?.url === page?.url && was?.title === page?.title ? was : page))
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
  }, [site])
  return tabPage
}
