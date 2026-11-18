import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type Ref } from 'react'
import type { QuestionPage, QuestionSelection } from '@cofun/agent'
import type { Mode } from '@cofun/agent/mode'
import { track } from '../analytics'
import { selectionsCarried } from '@cofun/tools'
import { clipSelection } from '@cofun/tools/tab'
import { linkTo, watchSelections, type Selection } from '@cofun/tools/selection'
import { carryPages, type OpenPage } from '../tools'
import type { ChatSession } from './chat-session'
import { Icon } from './icons'
import { ModelMenu } from './Model'
import { AddMenu, pageKey, usePagePicker, type SearchStop } from './PagePicker'
import { ComposerPages, type Chip } from './Pages'
import type { Panel, PanelSnapshot } from './panel'
import { SaveToast } from './Save'
import type { StartContext } from './Suggestions'

/** Pages links are made on when no Notion tab says which host the user's Notion is on. */
const NOTION_ORIGIN = 'https://www.notion.so'

/** What the composer holds, made by useComposer and shown by Composer. */
export type Composing = ReturnType<typeof useComposer>

/**
 * The next question as the user writes it: its text, the pages and selections it goes with, and the
 * page picker. Component state of the panel, which the open chat does not hold: the text and the
 * selections stay as the user switches chats, and the pages added by hand go with a new chat.
 */
export function useComposer({
  panel,
  chat,
  tabPage,
  busy,
  userId,
}: {
  panel: Panel
  chat: ChatSession
  /** The signed-in account, whose selections the composer takes. */
  userId: string
  /** The Notion page open in the current tab, if one is. */
  tabPage?: OpenPage
  /** The open chat's question has not ended yet. */
  busy: boolean
}) {
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // The page the user took off the question, by `pageKey`. It stays off for this chat until the tab
  // shows another page or a new chat starts.
  const [removed, setRemoved] = useState<string>()
  const openPage = tabPage && pageKey(tabPage) !== removed ? tabPage : undefined

  // Text the user selected on pages and sent with the context menu, for the next question, in the
  // order sent: each adds to the ones before. They stay as the user switches tabs or chats, until a
  // question carries them or the user takes them off.
  const [selections, setSelections] = useState<Selection[]>([])
  useEffect(() => {
    let stop: (() => void) | undefined
    let closed = false
    chrome.windows
      .getCurrent()
      .then((window) => {
        if (closed || window.id === undefined) return
        stop = watchSelections(window.id, userId, (sent) => {
          setSelections((list) => [...list, ...sent])
          inputRef.current?.focus()
        })
      })
      .catch((err: unknown) => console.error('Could not tell which window the side panel is in', err))
    return () => {
      closed = true
      stop?.()
    }
  }, [userId])

  // The pages the user added to the next question by hand, in the order they added them.
  const [chosen, setChosen] = useState<QuestionPage[]>([])
  // The page picker, while it is open: from an `@` typed at `start` in the message, or from "+",
  // with its own search field.
  const [picker, setPicker] = useState<{ from: '@'; start: number; query: string } | { from: 'menu'; query: string }>()
  // Where the `@` the user closed the picker for is: it stays text, and opens nothing until it is gone.
  const dismissed = useRef<number>(undefined)
  // Set once the workspace is not searched again for the next question (see usePagePicker).
  const [searchStop, setSearchStop] = useState<SearchStop>()
  // Which question the composer is for: a search that fails after its question was sent stops none.
  // State, so a reset during render writes no ref; `roundNow` follows it once a render is committed.
  const [round, setRound] = useState(0)
  const roundNow = useRef(round)
  useLayoutEffect(() => {
    roundNow.current = round
    // The next question's `@`s are its own: none was closed yet.
    dismissed.current = undefined
  }, [round])
  // Where the caret goes once the message box shows the text a pick changed.
  const caret = useRef<number>(undefined)

  // Another chat opened, or a new one started: the open page goes with it again, and the next
  // question starts with no page added by hand. Reset as the chat is shown, not in an effect after it.
  const [composingFor, setComposingFor] = useState(chat)
  if (composingFor !== chat) {
    setComposingFor(chat)
    setRemoved(undefined)
    resetPicker()
  }

  const chips: Chip[] = [
    // The open page is the panel's until the user adds it by hand.
    ...(openPage && !chosen.some((p) => pageKey(p) === pageKey(openPage)) ? [{ page: openPage, auto: true }] : []),
    ...chosen.map((page) => ({ page, auto: false })),
  ]

  useLayoutEffect(() => {
    if (caret.current === undefined) return
    inputRef.current?.setSelectionRange(caret.current, caret.current)
    caret.current = undefined
  })

  const pages = usePagePicker({
    open: !!picker,
    query: picker?.query ?? '',
    onQuery: picker?.from === 'menu' ? (query) => setPicker({ from: 'menu', query }) : undefined,
    thisPage: tabPage,
    added: new Set(chips.map((c) => pageKey(c.page))),
    recent: () => panel.recentPages(tabPage ? new URL(tabPage.url).origin : NOTION_ORIGIN),
    stop: searchStop,
    paused: busy,
    onStop: (stop) => {
      if (round !== roundNow.current) return false
      setSearchStop(stop)
      return true
    },
    onPick: addPage,
    onClose: closePicker,
    memory: chat.memory,
  })

  /** Closes the picker: what was typed after an `@` stays as text. */
  function closePicker() {
    if (picker?.from === '@') dismissed.current = picker.start
    setPicker(undefined)
    inputRef.current?.focus()
  }

  /** Adds a page from the picker to the next question; one picked after an `@` replaces the `@…` text. */
  function addPage(page: QuestionPage) {
    const key = pageKey(page)
    // The open page, taken off before, goes with the question again: the user chose it.
    if (tabPage && pageKey(tabPage) === key) setRemoved(undefined)
    setChosen((list) => (list.some((p) => pageKey(p) === key) ? list : [...list, page]))
    track({ event: 'page_added', how: picker?.from === '@' ? 'mention' : 'button' })
    if (picker?.from === '@') {
      const end = picker.start + 1 + picker.query.length
      setInput(input.slice(0, picker.start) + input.slice(end))
      caret.current = picker.start
    }
    setPicker(undefined)
    inputRef.current?.focus()
  }

  /** Takes a page off the next question. */
  function removeChip(chip: Chip) {
    const key = pageKey(chip.page)
    if (!chip.auto) setChosen((list) => list.filter((p) => pageKey(p) !== key))
    // The open page stays off, also when the user had added it by hand.
    if (tabPage && pageKey(tabPage) === key) setRemoved(key)
    inputRef.current?.focus()
  }

  /** Opens the picker for an `@` just before the caret, or closes one the caret left. */
  function followAt(text: string, at: number | null) {
    const before = at === null ? '' : text.slice(0, at)
    // A page's title may have spaces, but it starts right after the `@`: "@ 5pm" is no page.
    const match = /(?:^|\s)@((?:\S[^@\n]{0,39})?)$/.exec(before)
    const start = match ? before.length - match[1].length - 1 : undefined
    if (start === undefined || dismissed.current !== start) dismissed.current = undefined
    if (start !== undefined && dismissed.current === undefined) setPicker({ from: '@', start, query: match![1] })
    else if (picker?.from === '@') setPicker(undefined)
  }

  // Words after an `@` that go past a space and that no page's title holds (in the browser or the
  // workspace) are the message going on, not a page: the picker closes, leaving them as text, so
  // Enter sends them as typed.
  const offTopic = picker?.from === '@' && /\s/.test(picker.query) && !pages.titleMatch
  useEffect(() => {
    if (!offTopic || picker?.from !== '@') return
    dismissed.current = picker.start
    setPicker(undefined)
  }, [offTopic])

  // A press outside the composer closes the picker, as Escape does: what follows an `@` stays text.
  const pickerNow = useRef(picker)
  pickerNow.current = picker
  useEffect(() => {
    if (!picker) return
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || document.getElementById('composer')?.contains(e.target)) return
      const was = pickerNow.current
      if (was?.from === '@') dismissed.current = was.start
      setPicker(undefined)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [!!picker])

  // Another Notion page brings its chip back. A tab on another site, or a read of the tab that
  // failed, shows no page and keeps the one taken off: coming back to it, it is still off.
  useEffect(() => {
    if (removed !== undefined && tabPage && pageKey(tabPage) !== removed) setRemoved(undefined)
  }, [tabPage, removed])

  function send() {
    const text = input.trim()
    if (!text || busy) return
    // What the composer shows is what the question carries.
    const sentPages = chips.map((c) => c.page)
    // Those the question has room for: the others never reach the model, so the question doesn't show them.
    const sentSelections = selectionsCarried(selections).map(({ selection }) => shownSelection(selection))
    // A page is off while the composer shows none for it: also on another site, until another page shows.
    // The tabs the chat's earlier questions carried stay readable for this one.
    const earlier = chat.getSnapshot().messages.flatMap((m) => (m.role === 'user' ? (m.pages ?? []) : []))
    const context = carryPages(chat.memory, tabPage, removed !== undefined && !openPage, chosen, selections, earlier)
    setSelections([])
    setInput('')
    resetPicker()
    panel.ask({
      text,
      pages: sentPages,
      selections: sentSelections,
      context,
      mode: panel.getSnapshot().mode,
      notionTab: !!tabPage,
      // A page search still out goes first (see ChatSession.ask).
      searched: pages.settled(),
    })
  }

  /** The next question starts with no page added by hand, and may search the workspace again. */
  function resetPicker() {
    setChosen([])
    setPicker(undefined)
    setSearchStop(undefined)
    setRound((n) => n + 1)
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (busy) {
      track({ event: 'reply_stopped' })
      chat.stop()
    } else send()
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (picker?.from === '@' && pages.onKeyDown(e)) return
    // Backspace in an empty message takes the last page off; the selections, shown last, first.
    if (e.key === 'Backspace' && !input && (selections.length || chips.length)) {
      e.preventDefault()
      if (selections.length) setSelections((list) => list.slice(0, -1))
      else removeChip(chips.at(-1)!)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  /** Where the chat starts, as the composer shows it (the mode is the panel's). */
  const start: Omit<StartContext, 'mode'> = {
    page: openPage,
    removed: !!tabPage && !openPage,
    added: chosen.length > 0,
  }

  return {
    input,
    inputRef,
    start,
    busy,
    picker: pages,
    pickerFrom: picker?.from,
    chips,
    selections,
    onInput: (text: string, at: number | null) => {
      setInput(text)
      followAt(text, at)
    },
    onSelect: followAt,
    onKeyDown,
    onSubmit,
    openPicker: () => setPicker({ from: 'menu', query: '' }),
    removeChip,
    removeSelection: (i: number) => {
      setSelections((list) => list.filter((_, j) => j !== i))
      inputRef.current?.focus()
    },
    /** Puts the focus in the message box. */
    focus: () => inputRef.current?.focus(),
    /** Fills the message box with a suggestion, the caret at `at`. */
    fill: (text: string, at: number) => {
      setInput(text)
      caret.current = at
      inputRef.current?.focus()
    },
  }
}

/** The box the next question is written in, with what goes with it, which model answers, and Send or Stop. */
export function Composer({
  composer,
  panel,
  snapshot: { mode, model, saveFailure },
  covered,
  onManageModels,
  modelButtonRef,
}: {
  composer: Composing
  panel: Panel
  snapshot: PanelSnapshot
  /** The session list or a page covers the chat: the composer is out of reach. */
  covered: boolean
  onManageModels: () => void
  modelButtonRef: Ref<HTMLButtonElement>
}) {
  const { input, inputRef, busy, picker, chips, selections } = composer
  return (
    // One box: the question on top, and below it, inside the box, which model answers and the send button.
    <form id="composer" onSubmit={composer.onSubmit} inert={covered}>
      {/* Over the chat, just above the box (which is what it is placed against). */}
      {saveFailure && (
        <SaveToast
          key={saveFailure.key}
          message={saveFailure.message}
          onClose={(focused) => {
            panel.dismissSaveFailure()
            // The focus was on the toast, which goes: it moves to the message box, not the page.
            if (focused) composer.focus()
          }}
        />
      )}
      {picker.element}
      <ComposerPages
        chips={chips}
        onRemove={composer.removeChip}
        selections={selections.map(shownSelection)}
        onRemoveSelection={composer.removeSelection}
      />
      <textarea
        ref={inputRef}
        rows={1}
        value={input}
        onChange={(e) => composer.onInput(e.target.value, e.target.selectionStart)}
        onSelect={(e) => composer.onSelect(e.currentTarget.value, e.currentTarget.selectionStart)}
        onKeyDown={composer.onKeyDown}
        aria-activedescendant={composer.pickerFrom === '@' ? picker.activeId : undefined}
        placeholder={
          mode === 'read_only'
            ? 'Ask without changing anything… Type @ to add a page.'
            : 'Ask something… Type @ to add a page.'
        }
        title="Enter to send, Shift+Enter for a new line"
        aria-label="Message"
      />
      <div className="composer-tools">
        <AddMenu onAddPage={composer.openPicker} />
        <ModeButton mode={mode ?? 'edit'} onChange={(next) => panel.changeMode(next)} />
        <span className="grow" />
        {/* The model chip leads the right side, next to send; the left is for what goes with the question. */}
        <ModelMenu
          settings={model}
          onChange={(change) => panel.changeModel(change)}
          onManage={onManageModels}
          buttonRef={modelButtonRef}
        />
        <button
          // Blue only when pressing it does something: there is a question to send, or a reply to stop.
          className={busy || input.trim() ? 'send ready tip-end' : 'send tip-end'}
          type="submit"
          aria-label={busy ? 'Stop' : 'Send'}
          data-tip={busy ? 'Stop' : 'Send'}
        >
          <Icon name={busy ? 'square' : 'send'} />
        </button>
      </div>
    </form>
  )
}

/**
 * Switches between Edit and Read only. Its name says the mode the next question is asked in, and its
 * tooltip what that means.
 */
function ModeButton({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  const readOnly = mode === 'read_only'
  return (
    <button
      type="button"
      className={readOnly ? 'tool-button read-only' : 'tool-button'}
      aria-label={readOnly ? 'Mode: Read only' : 'Mode: Edit'}
      // The tip says what the mode does, which the name does not; screen readers get it as the description.
      data-tip={readOnly ? "Read only: won't change pages" : 'Edit: can change pages'}
      aria-description={readOnly ? "Read only: won't change pages" : 'Edit: can change pages'}
      onClick={() => onChange(readOnly ? 'edit' : 'read_only')}
    >
      <Icon name={readOnly ? 'eye' : 'pencil'} />
    </button>
  )
}

/** How much of a selection its chip shows, and keeps with the question. */
const QUOTE_CHARS = 200

/** A selection as its chip shows it, in the composer and with the question. */
function shownSelection(selection: Selection): QuestionSelection {
  const text = selection.text.replace(/\s+/g, ' ').trim()
  return {
    title: selection.title,
    url: linkTo(selection) ?? selection.url,
    quote: text.length > QUOTE_CHARS ? `${clipSelection(text, QUOTE_CHARS)}…` : text,
  }
}
