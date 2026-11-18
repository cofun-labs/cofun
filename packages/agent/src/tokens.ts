// How many tokens a text is estimated to take, for budgeting a request before it is sent. Reported
// usage replaces the estimate for what a model has already read (see fitsRequest in compaction.ts).

/**
 * CJK ideographs, kana, Hangul, and their punctuation and full-width forms: about a token each, or
 * more. A flat 3.5 characters a token counted 56,000 Chinese characters as 16,000 tokens, where a
 * Qwen3 tokenizer gave 34,000.
 */
function dense(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xffef)
  )
}

/**
 * Tokens estimated by script: ASCII at 3.5 characters a token, as pi estimates; CJK at one token a
 * character; other letters (accented Latin, Greek, Cyrillic, and the like) at two characters a token;
 * emoji and other characters beyond the BMP at two tokens each.
 */
export function estimateTokens(text: string): number {
  let ascii = 0
  let tokens = 0
  for (const character of text) {
    const code = character.codePointAt(0)!
    if (code < 0x80) ascii++
    else if (code > 0xffff) tokens += 2
    else if (dense(code)) tokens += 1
    else tokens += 0.5
  }
  return Math.ceil(ascii / 3.5 + tokens)
}
