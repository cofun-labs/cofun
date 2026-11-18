import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type Ref } from 'react'
import type { QuestionPage, QuestionSelection } from '@cofun/agent'
import type { Mode } from '@cofun/agent/mode'
import { track } from '../analytics'
import type { AttachmentUpload } from '../confluence/attachments'
import type { Instance } from '../confluence/instance'
import {
  attachmentSizeLimit,
  captureConfluenceTab,
  isEditorSelectionCurrent,
  readEditorSelection,
} from '../confluence/tab'
import { selectionsCarried } from '@cofun/tools'
import { clipSelection } from '@cofun/tools/tab'
import { linkTo, watchSelections, type Selection } from '@cofun/tools/selection'
import { carryPages } from '../tools'
import type { ChatSession } from './chat-session'
import { Icon } from './icons'
import { ModelMenu } from './Model'
import { AddMenu, pageKey, usePagePicker } from './PagePicker'
import { ComposerPages, type Chip } from './Pages'
import type { Panel, PanelSnapshot } from './panel'

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
  busy,
}: {
  panel: Panel
  chat: ChatSession
  /** The open chat's question has not ended yet. */
  busy: boolean
}) {
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // Text the user selected on pages and sent with the context menu, for the next question, in the
  // order sent: each adds to the ones before. They stay as the user switches tabs or chats, until a
  // question carries them or the user takes them off.
  const [selections, setSelections] = useState<Selection[]>([])
  const [editor, setEditor] = useState<Awaited<ReturnType<typeof readEditorSelection>>>()
  const [file, setFile] = useState<File>()
  const [confluenceStatus, setConfluenceStatus] = useState('')
  const captureEpoch = useRef(0)
  const submitting = useRef(false)

  // The Confluence site the current tab shows, once Confluco may use it: checked again as the user
  // switches or loads tabs, and after each question, which may have allowed the site.
  const site = useConfluenceSite(busy)
  const siteKey = site && site.origin + site.path
  // What was staged belongs to its site: cleared when another Confluence site comes up, kept while
  // the user looks at a tab that is not Confluence. Send checks the editor selection again.
  const stagedFor = useRef<string>(undefined)
  useEffect(() => {
    if (!siteKey) return
    if (stagedFor.current !== undefined && stagedFor.current !== siteKey) {
      captureEpoch.current++
      setEditor(undefined)
      setFile(undefined)
    }
    stagedFor.current = siteKey
  }, [siteKey])

  async function attachEditorSelection() {
    const capture = ++captureEpoch.current
    setEditor(undefined)
    setConfluenceStatus('Reading editor selection…')
    try {
      const captured = await readEditorSelection(await captureConfluenceTab())
      if (captureEpoch.current !== capture) return
      setEditor(captured)
      setConfluenceStatus('')
      inputRef.current?.focus()
    } catch (error) {
      if (captureEpoch.current === capture)
        setConfluenceStatus(error instanceof Error ? error.message : 'Could not read the editor selection.')
    }
  }

  function chooseFile(next: File | undefined) {
    if (next && next.size > attachmentSizeLimit) {
      setFile(undefined)
      setConfluenceStatus('Choose an attachment of at most 10 MiB.')
      return
    }
    setFile(next)
    setConfluenceStatus('')
  }

  useEffect(() => {
    let stop: (() => void) | undefined
    let closed = false
    chrome.windows
      .getCurrent()
      .then((window) => {
        if (closed || window.id === undefined) return
        stop = watchSelections(window.id, (sent) => {
          setSelections((list) => [...list, ...sent])
          inputRef.current?.focus()
        })
      })
      .catch((err: unknown) => console.error('Could not tell which window the side panel is in', err))
    return () => {
      closed = true
      stop?.()
    }
  }, [])

  // The pages the user added to the next question by hand, in the order they added them.
  const [chosen, setChosen] = useState<QuestionPage[]>([])
  // The page picker, while it is open: from an `@` typed at `start` in the message, or from "+",
  // with its own search field.
  const [picker, setPicker] = useState<{ from: '@'; start: number; query: string } | { from: 'menu'; query: string }>()
  // Where the `@` the user closed the picker for is: it stays text, and opens nothing until it is gone.
  const dismissed = useRef<number>(undefined)
  // Where the caret goes once the message box shows the text a pick changed.
  const caret = useRef<number>(undefined)

  // Another chat opened, or a new one started: the open page goes with it again, and the next
  // question starts with no page added by hand. Reset as the chat is shown, not in an effect after it.
  const [composingFor, setComposingFor] = useState(chat)
  if (composingFor !== chat) {
    setComposingFor(chat)
    captureEpoch.current++
    setEditor(undefined)
    setFile(undefined)
    setConfluenceStatus('')
    resetPicker()
  }

  const chips: Chip[] = chosen.map((page) => ({ page, auto: false }))

  useLayoutEffect(() => {
    if (caret.current === undefined) return
    inputRef.current?.setSelectionRange(caret.current, caret.current)
    caret.current = undefined
  })

  const pages = usePagePicker({
    open: !!picker,
    query: picker?.query ?? '',
    onQuery: picker?.from === 'menu' ? (query) => setPicker({ from: 'menu', query }) : undefined,
    added: new Set(chips.map((c) => pageKey(c.page))),
    onPick: addPage,
    onClose: closePicker,
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
  // open tabs) are the message going on, not a page: the picker closes, leaving them as text, so
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

  async function send(attachment?: AttachmentUpload) {
    const text = attachment
      ? `I selected a local file and clicked ${attachment.mode === 'create' ? 'Upload' : 'Replace'} attachment. Use upload_page_attachment to preview it.`
      : input.trim()
    if (!text || busy || submitting.current) return
    submitting.current = true
    const attached = attachment ? [] : [...selections]
    const capture = captureEpoch.current
    let status = ''
    try {
      if (editor && !attachment) {
        const tab = await captureConfluenceTab().catch(() => undefined)
        const same =
          tab?.tabId === editor.tab.tabId &&
          tab.url === editor.tab.url &&
          tab.instance.origin === editor.tab.instance.origin &&
          tab.instance.path === editor.tab.instance.path
        if (same && (await isEditorSelectionCurrent(tab, editor.documentId)) && capture === captureEpoch.current) {
          attached.push({
            text: editor.text,
            chars: editor.chars,
            title: 'Confluence editor selection',
            url: tab.instance.origin + tab.instance.path,
          })
        } else status = 'The editor changed, so the selected text was omitted.'
      }
      if (panel.getSnapshot().chat !== chat || chat.getSnapshot().status !== 'ready') return
      if (!attachment && capture === captureEpoch.current) {
        captureEpoch.current++
        setEditor(undefined)
      }
      setConfluenceStatus(status)
      const sentPages = chips.map((c) => c.page)
      const sentSelections = selectionsCarried(attached).map(({ selection }) => shownSelection(selection))
      const earlier = chat.getSnapshot().messages.flatMap((m) => (m.role === 'user' ? (m.pages ?? []) : []))
      const context = carryPages(chat.memory, chosen, attached, earlier)
      if (attachment) setFile(undefined)
      else {
        setSelections((current) => current.filter((selection) => !selections.includes(selection)))
        setInput((current) => (current === input ? '' : current))
        setChosen((current) => current.filter((page) => !chosen.includes(page)))
        dismissed.current = undefined
        setPicker(undefined)
      }
      panel.ask({
        text,
        pages: sentPages,
        selections: sentSelections,
        context,
        mode: panel.getSnapshot().mode,
        attachment,
      })
    } finally {
      submitting.current = false
    }
  }

  /** Clears the tabs attached to the last question and closes the picker. */
  function resetPicker() {
    setChosen([])
    setPicker(undefined)
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (busy) {
      track({ event: 'reply_stopped' })
      chat.stop()
    } else void send()
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
      void send()
    }
  }

  return {
    input,
    inputRef,
    busy,
    picker: pages,
    pickerFrom: picker?.from,
    chips,
    selections,
    onConfluence: site !== undefined,
    editorSelectionAvailable: site !== undefined && !site.cloud,
    editor,
    file,
    confluenceStatus,
    attachEditorSelection,
    removeEditorSelection: () => {
      captureEpoch.current++
      setEditor(undefined)
      setConfluenceStatus('')
    },
    chooseFile,
    sendAttachment: (mode: AttachmentUpload['mode']) => {
      if (file) void send({ file, mode })
    },
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
  snapshot: { mode, model },
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
      {picker.element}
      {composer.editor && (
        <section className="confluence-selection" aria-label="Confluence editor selection">
          <pre>{composer.editor.text}</pre>
          {composer.editor.chars > composer.editor.text.length && <small>Selection limited to 4,000 characters.</small>}
          <button type="button" onClick={composer.removeEditorSelection}>
            Remove editor selection
          </button>
        </section>
      )}
      {composer.confluenceStatus && (
        <p className="confluence-composer-status" role="status">
          {composer.confluenceStatus}
        </p>
      )}
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
        {composer.onConfluence && (composer.editorSelectionAvailable || mode !== 'read_only') && (
          <details className="confluence-actions">
            <summary>Confluence</summary>
            <div className="confluence-actions-list">
              {composer.editorSelectionAvailable && (
                <button type="button" disabled={busy} onClick={() => void composer.attachEditorSelection()}>
                  Attach editor selection
                </button>
              )}
              {mode !== 'read_only' && (
                <>
                  <label>
                    Attachment file
                    <input
                      type="file"
                      disabled={busy}
                      onChange={(event) => {
                        composer.chooseFile(event.currentTarget.files?.[0])
                        event.currentTarget.value = ''
                      }}
                    />
                  </label>
                  {composer.file && (
                    <>
                      <p>{composer.file.name}</p>
                      <button type="button" disabled={busy} onClick={() => composer.sendAttachment('create')}>
                        Upload attachment
                      </button>
                      <button type="button" disabled={busy} onClick={() => composer.sendAttachment('replace')}>
                        Replace attachment
                      </button>
                      <button type="button" onClick={() => composer.chooseFile(undefined)}>
                        Remove file
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          </details>
        )}
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

/** Follows which Confluence site the current tab shows, once Confluco may use it; undefined on any other tab. */
function useConfluenceSite(busy: boolean): Instance | undefined {
  const [site, setSite] = useState<Instance>()
  useEffect(() => {
    if (busy) return
    let reads = 0
    const read = () => {
      const n = ++reads
      void captureConfluenceTab()
        .catch(() => undefined)
        .then((tab) => {
          if (n === reads) setSite(tab?.instance)
        })
    }
    const onUpdated = (_id: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      if (tab.active && change.url !== undefined) read()
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
  }, [busy])
  return site
}
