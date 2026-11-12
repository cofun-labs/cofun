import type { ComponentProps } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Only these links are made clickable; anything else in a reply is shown as text. */
function webUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

function Link({ href, children, id }: ComponentProps<'a'>) {
  // A footnote and its way back are links within the reply.
  if (href?.startsWith('#'))
    return (
      <a href={href} id={id}>
        {children}
      </a>
    )
  const url = webUrl(href)
  if (!url) return <span>{children}</span>
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}

/**
 * An image is never loaded: it would send a request to whatever host the reply names, and the
 * extension contacts only the hosts in PRIVACY.md. Its alt text stands in, linked to the image.
 */
function Image({ src, alt }: ComponentProps<'img'>) {
  const text = alt || 'Image'
  const url = webUrl(typeof src === 'string' ? src : undefined)
  return url ? <Link href={url}>{text}</Link> : <span>{text}</span>
}

/** Tables scroll sideways inside the reply instead of widening it. */
function Table(props: ComponentProps<'table'>) {
  return (
    <div className="table-scroll">
      <table {...props} />
    </div>
  )
}

const COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <Link {...props} />,
  img: ({ node: _node, ...props }) => <Image {...props} />,
  table: ({ node: _node, ...props }) => <Table {...props} />,
}

/**
 * The text of a reply, formatted from the Markdown the model wrote. The model's text is untrusted:
 * raw HTML in it is shown as text, never rendered (there is no HTML plugin), and the output is
 * React elements, never `innerHTML`.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
      {text}
    </ReactMarkdown>
  )
}
