/** A verb in the forms a tool call's description needs: "read", "reading", "read". */
export interface Verb {
  base: string
  ing: string
  past: string
}

/**
 * What a tool call does, in the user's words: the verb, then what it acts on. `name` is the name of
 * the thing, shown set apart, when the call knows it: "Searched for *roadmap draft*" is
 * `{ verb: SEARCH, what: 'for', name: 'roadmap draft' }`, and "Moved 2 pages to the trash" is
 * `{ verb: MOVE, what: '2 pages to the trash' }`.
 */
export interface Action {
  verb: Verb
  what?: string
  name?: string
  /** Words after the name: "Moved *Notes* to the trash". */
  after?: string
}
