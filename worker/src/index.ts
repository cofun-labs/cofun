import { DurableObject } from 'cloudflare:workers'
import { createApp } from './app'
import { consume } from './quota'

/** Daily request counter for one user, addressed by Clerk user id. */
export class UserQuota extends DurableObject {
  consume(day: string, limit: number): Promise<boolean> {
    return consume(this.ctx.storage, day, limit)
  }
}

export default createApp()
