import { DurableObject } from 'cloudflare:workers'
import { createApp } from './app'
import {
  charge,
  grant,
  read,
  reserve,
  type Account,
  type Balance,
  type CreditsNamespace,
  type ManualGrant,
  type Reservation,
} from './credits'
import type { UsageDataset } from './usage'

/** Credit ledger for one user, addressed by Clerk user id. */
export class UserCredits extends DurableObject {
  reserve(now: number, most: number): Promise<Reservation> {
    return reserve(this.ctx.storage, now, most)
  }

  charge(now: number, cost: number, hold: number): Promise<Balance> {
    return charge(this.ctx.storage, now, cost, hold)
  }

  read(now: number): Promise<Account> {
    return read(this.ctx.storage, now)
  }

  grant(now: number, manual: ManualGrant): Promise<Account> {
    return grant(this.ctx.storage, now, manual)
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
