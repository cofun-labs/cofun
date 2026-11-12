import { createApp } from './app'
import type { Database } from './credits'
import type { UsageDataset } from './usage'

export default createApp()

// Compile-time check: the real bindings satisfy the interfaces the app is written against.
type BindingFitsApp = D1Database extends Database ? (AnalyticsEngineDataset extends UsageDataset ? true : never) : never
const bindingFitsApp: BindingFitsApp = true
void bindingFitsApp
