import { useEffect, useState } from 'react'
import type { QuestionCost } from '../agent/types'
import { Icon } from './icons'

/** Copies `text` to the clipboard, and says for a moment whether it worked. */
export function CopyButton({ text, onCopied }: { text: string; onCopied?: () => void }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), 2000)
    return () => clearTimeout(timer)
  }, [state])

  const label = state === 'copied' ? 'Copied' : state === 'failed' ? "Couldn't copy" : 'Copy reply'
  return (
    <>
      <button
        type="button"
        className="reply-action"
        aria-label={label}
        data-tip={label}
        onClick={() =>
          navigator.clipboard.writeText(text).then(
            () => {
              onCopied?.()
              setState('copied')
            },
            () => setState('failed'),
          )
        }
      >
        <Icon name={state === 'copied' ? 'check' : 'copy'} />
      </button>
      {/* Read out when it changes: the button's own name is not announced again while it has focus. */}
      <span className="sr-only" role="status">
        {state === 'copied' ? 'Copied' : state === 'failed' ? "Couldn't copy the reply" : ''}
      </span>
    </>
  )
}

/**
 * What a reply cost in credits, as the worker charged it: short, to two significant digits below one
 * credit ("0.48 credits") and one decimal above.
 */
export function CostNote({ cost }: { cost: QuestionCost }) {
  const credits = cost.microCredits / 1_000_000
  const digits = credits < 1 ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 1 }
  const shown = credits.toLocaleString('en-US', digits)
  return (
    <span className="note reply-cost" data-tip="What this reply cost">
      {shown} {shown === '1' ? 'credit' : 'credits'}
    </span>
  )
}
