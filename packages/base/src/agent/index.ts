// The agent, as an extension uses it: the agent itself, its types, and what the settings page asks
// of the user's own providers.
export { CopilotAgent, MAY_HAVE_CHANGED } from './agent'
export { openRouterModels, type ListedModel } from './openrouter'
export { checkKey, type KeyCheck } from './own'
export { KEY_REJECTED } from './provider'
export type * from './types'
export { HistoryMessage, KeptResult, ToolDetails, WebError } from './types'
// The worker's web routes, for the test that runs the agent against the worker (worker/test/extension.test.ts).
export { readWebPage, searchWebFor } from './worker'
