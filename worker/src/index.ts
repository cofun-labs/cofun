import { DurableObject } from 'cloudflare:workers'
import { createApp } from './app'
import { balance, charge, type Balance, type CreditsNamespace } from './credits'
import type { UsageDataset } from './usage'

/** Credit ledger for one user, addressed by Clerk user id. */
export class UserCredits extends DurableObject {
  balance(now: number): Promise<Balance> {
    return balance(this.ctx.storage, now)
  }

  charge(now: number, cost: number): Promise<Balance> {
    return charge(this.ctx.storage, now, cost)
  }
}

export default createApp()

// Compile-time check: the real bindings satisfy the interfaces the app is written against.
type BindingFitsApp =
  DurableObjectNamespace<UserCredits> extends CreditsNamespace
    ? AnalyticsEngineDataset extends UsageDataset
      ? true
      : never
    : never
const bindingFitsApp: BindingFitsApp = true
void bindingFitsApp
