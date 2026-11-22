// How the side panel may show a model's reply, whatever it looks like in each extension. The model's
// text is untrusted, and so is what a page it read made it write: a reply must not make the panel
// load anything or open anything but a web page. Each extension's Markdown view gives its renderer
// these rules (`rehypePlugins`) and keeps the rest of the look its own: its Markdown plugins, its
// element overrides, its styles. Raw HTML stays text as long as the renderer is given no HTML plugin.
import type { Element, ElementContent, Root } from 'hast'

/** Only these links are made clickable; anything else in a reply is shown as text. */
function webUrl(url: unknown): string | undefined {
  if (typeof url !== 'string' || !url) return undefined
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

/** A link to a web page, opened in a new tab that cannot reach back to the panel. */
const WEB_LINK = { target: '_blank', rel: ['noopener', 'noreferrer'] }

/**
 * A link stays a link only for a web page, with nothing else the model wrote on it (its title), or
 * for a place within the reply: a footnote and its way back, whose other attributes (an id, and what
 * a screen reader says, such as "Back to reference 1") come from the Markdown renderer, not the
 * model, since a Markdown link can carry only a title, which is text. Any other link is its text.
 */
function rewriteLink(a: Element): void {
  const { href } = a.properties
  if (typeof href === 'string' && href.startsWith('#')) return rewrite(a, true)
  const url = webUrl(href)
  if (url) {
    a.properties = { href: url, ...WEB_LINK }
    return rewrite(a, true)
  }
  a.tagName = 'span'
  a.properties = {}
  rewrite(a, false)
}

/**
 * An image is never loaded: it would send a request to whatever host the reply names, and the
 * extension contacts only the hosts in its PRIVACY.md. Its alt text stands in, linked to the image,
 * or only the text inside a link, which can't hold another.
 */
function rewriteImage(img: Element, inLink: boolean): void {
  const { alt, src } = img.properties
  const text: ElementContent = { type: 'text', value: typeof alt === 'string' && alt ? alt : 'Image' }
  const url = webUrl(src)
  img.children = [text]
  if (url && !inLink) {
    img.tagName = 'a'
    img.properties = { href: url, ...WEB_LINK }
  } else {
    img.tagName = 'span'
    img.properties = {}
  }
}

function rewrite(parent: Root | Element, inLink: boolean): void {
  for (const child of parent.children) {
    if (child.type !== 'element') continue
    if (child.tagName === 'img') rewriteImage(child, inLink)
    else if (child.tagName === 'a') rewriteLink(child)
    else rewrite(child, inLink)
  }
}

/** The rules as a rehype plugin, for the Markdown renderer's `rehypePlugins`. */
export const replyRules = () => (tree: Root) => rewrite(tree, false)
