import type { StartContext } from '../product'
import { Icon } from './icons'
import { useProduct } from './product'

/**
 * The start of a chat: the product's icon, what it can do here, and the suggestions it gives (see
 * Product.start). Picking one gives `onPick` the text for the message box and where the caret goes:
 * where a "…" was, for the user to finish it, or else at the end.
 */
export function ChatStart({
  context,
  onPick,
}: {
  context: StartContext
  onPick: (text: string, caret: number) => void
}) {
  const { icon, start } = useProduct()
  const { heading, line, suggestions, note } = start(context)
  return (
    <div className="empty">
      <div className="empty-head">
        <img className="product-icon" src={icon} alt="" />
        <p className="empty-title">{heading}</p>
      </div>
      <p>{line}</p>
      <ul className="suggestions" aria-label="Suggestions">
        {suggestions.map(({ icon, text }) => (
          <li key={text}>
            <button
              type="button"
              onClick={() => {
                const at = text.indexOf('…')
                if (at < 0) onPick(text, text.length)
                else onPick(text.slice(0, at) + text.slice(at + 1), at)
              }}
            >
              <Icon name={icon} />
              {text}
            </button>
          </li>
        ))}
      </ul>
      {note && (
        <p className="empty-note">
          <Icon name="info" />
          {note}
        </p>
      )}
    </div>
  )
}
