// What the tools that read outside Notion share: how much one question may read from outside, and
// keeping a page's lines from passing for the tool's own.

/**
 * How much text from outside Notion (the current tab, web pages) one question may read, over all
 * its reads: a question that goes on reading must not fill the conversation, or spend credits on it.
 */
const QUESTION_OUTSIDE_CHARS = 60_000

/** Characters from outside Notion the question being asked has read. */
let outsideRead = 0

/** Starts the count for the next question: carryPages calls it as each question starts. */
export function startOutside(): void {
  outsideRead = 0
}

/** Counts `chars` of text read from outside toward the question's limit. */
export function countOutside(chars: number): void {
  outsideRead += chars
}

/**
 * How many more characters from outside this question may read; throws, saying so for the model,
 * when it has read as much as it may.
 */
export function outsideLeft(): number {
  const left = QUESTION_OUTSIDE_CHARS - outsideRead
  if (left <= 0)
    throw new Error(
      `This question has read as much from outside Notion as one question may (${QUESTION_OUTSIDE_CHARS.toLocaleString('en-US')} ` +
        "characters). Answer from what was read; don't read more pages in this question.",
    )
  return left
}

/**
 * Keeps the page's lines from passing for the tool's own: a line that opens like a note in
 * brackets or a block reference gets a backslash first.
 */
export const asPageText = (text: string) => text.replace(/^([^\S\n]*)(\[|\^)/gm, '$1\\$2')
