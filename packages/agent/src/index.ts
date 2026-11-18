// The agent runtime and tool framework the extensions share: the agent, its types, the model
// providers (the hosted one, from the worker's client, and the user's own), what the settings page
// asks of the user's own providers, and defineTool. The only module of the extensions' code that
// imports pi (the agent runtime) is this package. The model settings and the mode, as each account
// keeps them on the device, are '@cofun/agent/models' and '@cofun/agent/mode', apart from the rest:
// they use chrome.storage, which the worker's tests of the agent don't have.
export { CopilotAgent, MAY_HAVE_CHANGED } from './agent'
export { hostedProvider, workerWeb, type HostedService, type WebService } from './hosted'
export { openRouterModels, type ListedModel } from './openrouter'
export { checkKey, OwnModel, OwnService, type KeyCheck, type OwnSetup } from './own'
export { KEY_REJECTED, type ModelProvider } from './provider'
export { defineTool, type Action, type Tool, type ToolDefinition, type Verb } from './tool'
export type * from './types'
export { HistoryMessage, KeptResult, QuestionPage, ToolDetails, ToolError } from './types'
