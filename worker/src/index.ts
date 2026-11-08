import { DurableObject } from 'cloudflare:workers'
import { createApp } from './app'
import { consume, type QuotaNamespace } from './quota'

/** Daily request counter for one user, addressed by Clerk user id. */
export class UserQuota extends DurableObject {
  consume(day: string, limit: number): Promise<boolean> {
    return consume(this.ctx.storage, day, limit)
  }
}

export default createApp()

// Compile-time check: the real binding satisfies the interface the app is written against.
type BindingFitsApp = DurableObjectNamespace<UserQuota> extends QuotaNamespace ? true : never
const bindingFitsApp: BindingFitsApp = true
void bindingFitsApp
