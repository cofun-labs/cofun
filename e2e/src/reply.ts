// A reply in the side panel as this tool reads it, when to stop waiting for it, and how it prints.
import type { Answer } from './args'

/** One piece of a reply, in the order the panel shows them. */
export type ReplyPart =
  | { type: 'text'; text: string }
  | {
      type: 'tool'
      name: string
      /** running, confirm (waiting for approval), done, failed, declined, stopped, skipped. */
      status: string
      /** The tool card's sections: Changes, Arguments, Result or Error. */
      sections: { label: string; text: string }[]
    }
  | { type: 'error'; text: string }
  | { type: 'note'; text: string }

/** What the side panel shows at one moment. */
export interface PanelSnapshot {
  /** The composer is there: Copilot is signed in and the chat is showing. */
  ready: boolean
  /** The Send button reads Stop: a reply is still coming. */
  busy: boolean
  /** Replies shown, including one still coming. */
  replies: number
  /** The last reply asks to allow or deny a tool call. */
  asking: boolean
  /** The last reply. */
  parts: ReplyPart[]
}

export type Step = 'wait' | 'done' | 'needs_answer' | { click: Answer }

/**
 * What to do next while waiting for reply number `expected`: keep waiting, answer an approval
 * prompt as told, stop because nobody said how to answer it, or stop because the reply is done.
 */
export function nextStep(snap: PanelSnapshot, expected: number, answer?: Answer): Step {
  if (snap.replies < expected) return 'wait'
  if (snap.asking) return answer ? { click: answer } : 'needs_answer'
  return snap.busy ? 'wait' : 'done'
}

/** A reply for reading in a terminal: text as is, then each tool call with its sections indented. */
export function formatReply(parts: ReplyPart[]): string {
  const out: string[] = []
  for (const part of parts) {
    if (part.type === 'text') out.push(part.text)
    else if (part.type === 'tool') {
      const lines = [`[tool] ${part.name}: ${part.status}`]
      for (const s of part.sections) lines.push(`  ${s.label}:`, indent(s.text, '    '))
      out.push(lines.join('\n'))
    } else out.push(`[${part.type}] ${part.text}`)
  }
  return out.join('\n\n')
}

function indent(text: string, by: string): string {
  return text
    .split('\n')
    .map((line) => (line ? by + line : line))
    .join('\n')
}

/**
 * Runs in the side panel: reads the chat from the DOM. It must not use anything from outside its
 * body (it is sent to the page as source). Tool cards are read whole, collapsed or not.
 */
export function readPanel(): PanelSnapshot {
  const submit = document.querySelector('#composer button[type=submit]')
  const replies = [...document.querySelectorAll('#messages .msg.assistant')]
  const last = replies.at(-1)
  const parts: ReplyPart[] = []
  for (const el of last ? [...last.children] : []) {
    const text = (el.textContent ?? '').trim()
    if (el.matches('details.tool')) {
      const sections: { label: string; text: string }[] = []
      let label: string | undefined
      for (const child of el.querySelector('.tool-body')?.children ?? []) {
        if (child.matches('.tool-label')) label = (child.textContent ?? '').trim()
        else if (child.matches('pre') && label) sections.push({ label, text: child.textContent ?? '' })
      }
      parts.push({
        type: 'tool',
        name: (el.querySelector('.tool-name')?.textContent ?? '').trim(),
        status: [...el.classList].find((c) => c !== 'tool') ?? 'unknown',
        sections,
      })
    } else if (el.matches('.text')) parts.push({ type: 'text', text })
    else if (el.matches('.error')) parts.push({ type: 'error', text })
    // "…" only says the model is still working.
    else if (el.matches('.note') && text !== '…') parts.push({ type: 'note', text })
  }
  return {
    ready: !!document.querySelector('#composer textarea'),
    busy: submit?.textContent === 'Stop',
    replies: replies.length,
    asking: !!last?.querySelector('.tool-confirm'),
    parts,
  }
}
