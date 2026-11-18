// Product analytics: which features of an extension are used and how they end, sent to PostHog from
// its side panel. The only module that imports the PostHog SDK. An extension calls `createAnalytics`
// once, in its own src/analytics.ts, with the events it may send, and the rest of it calls the `track`
// that returns: nothing else can be sent. Every property is an enum, a number, or a boolean (the type
// of `Property` says so), so a message, a reply, a page's title, a URL, or a key has no field to
// travel in.
//
// The user can turn it off on the settings page. While it is off, or when the build has no PostHog
// project key, the SDK is never started and nothing is sent.
//
// What the SDK would send by itself is turned off, and checked against posthog-js 1.448: with
// only `autocapture: false` it still sends a `$pageview` with the page's title and URL, asks
// us-assets.i.posthog.com for its remote configuration, and asks /flags for feature flags. With the
// options below it sends only the events captured here, each to `/e/` on the one host, once
// (package.json pins the SDK's exact version: a newer one is checked again before it is taken). Those still
// carry what the SDK adds to every event (the page's URL, the user agent, the time zone, the screen
// size, …), so `onlyKept` drops every property that is not an event's own or listed below.
import { PostHog, type CaptureResult } from 'posthog-js/dist/module.no-external'
import { z } from './zod'

/**
 * A value the event may carry as it is, or `other`: what is not on the list is never sent. Branded,
 * so only a schema made here is a `Property`: another string transform could pass any text through.
 */
export const oneOf = (known: readonly string[]) =>
  z
    .string()
    .transform((value) => (known.includes(value) ? value : 'other'))
    .brand<'OneOf'>()

type Value = z.ZodEnum | z.ZodLiteral | z.ZodNumber | z.ZodBoolean | ReturnType<typeof oneOf>
/**
 * What a property of an event may be: one of a fixed list (an enum, a literal, or `oneOf`), a number,
 * or a boolean, optional or not. A plain string is not one: it could carry any text.
 */
export type Property = Value | z.ZodOptional<Value>

/**
 * Every event an extension may send, by its name, with all it may carry: the properties of each. An
 * event that does not fit is not sent. Each says only that something happened, never its text:
 * `reply_copied` not the reply, `chat_opened` not its title. `version` and `product` are added to
 * every event, and `signed_in` is this module's own (see `settle`), so an extension names none of them.
 */
export type Events = Record<string, Record<string, Property>>

/** What an event's properties take: an optional one may be left out. */
type Input<P extends Record<string, Property>> = {
  [Name in keyof P as undefined extends z.input<P[Name]> ? never : Name]: z.input<P[Name]>
} & { [Name in keyof P as undefined extends z.input<P[Name]> ? Name : never]?: z.input<P[Name]> }

/** An event as an extension tracks it: its name, and its properties. */
export type AnalyticsEvent<E extends Events> = {
  [Name in keyof E & string]: { event: Name } & Input<E[Name]>
}[keyof E & string]

/**
 * What stays of the properties the SDK adds to an event: the project, who (random ids, and the Clerk
 * user id once signed in), when, the SDK itself, and the browser and operating system by name.
 * `$geoip_disable` tells PostHog not to work out a location from the request's address.
 */
const SDK_PROPERTIES = [
  'token',
  'distinct_id',
  '$device_id',
  '$user_id',
  '$anon_distinct_id',
  '$session_id',
  '$is_identified',
  '$process_person_profile',
  '$insert_id',
  '$time',
  '$lib',
  '$lib_version',
  '$browser',
  '$browser_version',
  '$os',
  '$geoip_disable',
]

/** The properties every event of ours carries, besides its own. */
const EVERY_EVENT = ['version', 'product']

const STORAGE_KEY = 'analytics'

/**
 * Whether usage data is sent, as the settings page's switch says. On unless the user turned it off;
 * kept in chrome.storage.local for the device, not per account, since it also covers the panel
 * before anyone is signed in.
 */
async function loadAnalyticsEnabled(): Promise<boolean> {
  const stored: unknown = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]
  return stored !== false
}

export interface AnalyticsOptions<E extends Events> {
  /** The extension's name, which every event carries: `notico`. */
  product: string
  /** The PostHog project events go to. Public by design; without it nothing is sent. */
  key: string | undefined
  /** PostHog's ingestion host, which the extension's content security policy names. */
  host: string | undefined
  /** The events the extension may send. */
  events: E
}

export interface Analytics<E extends Events> {
  /** Records that something happened. Sends nothing while usage data is off. */
  track(event: AnalyticsEvent<E>): void
  /** Tells analytics who is signed in (`null`: nobody), once the panel knows. */
  identify(userId: string | null): void
  loadAnalyticsEnabled(): Promise<boolean>
  /** Turns usage data on or off, for this panel at once and for every other one through storage. */
  saveAnalyticsEnabled(enabled: boolean): Promise<void>
}

/** The extension's usage data, sending only `events`. Call it once, in the extension's src/analytics.ts. */
export function createAnalytics<const E extends Events>({
  product,
  key,
  host,
  events,
}: AnalyticsOptions<E>): Analytics<E> {
  /**
   * Every event, as it is checked before it is sent. The device's usage was joined to an account
   * (`signed_in`): usually a sign-in, but also the first panel this version opens for someone already
   * signed in, and usage data turned on again by someone who signed in while it was off. The panel
   * reloads when a sign-in happens, so it never sees one as it happens.
   */
  const schemas = new Map<string, z.ZodObject>(
    Object.entries({ ...events, signed_in: {} }).map(([name, shape]) => [name, z.strictObject(shape)]),
  )
  const kept = new Set([...Object.values(events).flatMap(Object.keys), ...EVERY_EVENT, ...SDK_PROPERTIES])

  /**
   * The event as it is sent: only the kept properties, and nothing set on the person. Signing in
   * makes the SDK send an `$identify` event, which joins the device's random id to the Clerk user id;
   * it would also record the first page's URL and referrer on the person. Every event, that one
   * included, tells PostHog not to work out a location from the request's address.
   */
  function onlyKept(event: CaptureResult | null): CaptureResult | null {
    if (!event) return null
    const properties = Object.fromEntries(Object.entries(event.properties).filter(([name]) => kept.has(name)))
    return { ...event, properties: { ...properties, $geoip_disable: true }, $set: undefined, $set_once: undefined }
  }

  /** Whether usage data is sent; not known until storage was read. */
  let on: boolean | undefined
  let watching = false
  /** The SDK, once an event was sent with usage data on. */
  let client: PostHog | undefined
  /** Who is signed in, once the panel knows: `null` for nobody. */
  let user: string | null | undefined
  /** One thing at a time, in the order asked for. */
  let last: Promise<void> = Promise.resolve()

  /** The SDK when usage data is on, started on first use. Never started while it is off. */
  async function started(): Promise<PostHog | undefined> {
    if (!key || !host) return undefined
    if (!watching) {
      watching = true
      // Another window's panel turned it on or off.
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && STORAGE_KEY in changes) on = changes[STORAGE_KEY].newValue !== false
      })
    }
    on ??= await loadAnalyticsEnabled()
    if (!on) return undefined
    if (!client) {
      client = new PostHog()
      client.init(key, {
        api_host: host,
        // No remote code: the extension's pages run scripts only from the extension itself.
        disable_external_dependency_loading: true,
        // The device's random id, and whether it was joined to an account, in the extension's own localStorage.
        persistence: 'localStorage',
        // Only what `track` captures is sent.
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        capture_exceptions: false,
        capture_performance: false,
        capture_heatmaps: false,
        capture_dead_clicks: false,
        rageclick: false,
        disable_session_recording: true,
        disable_surveys: true,
        // No request for feature flags or the project's remote configuration, which could turn any of the above on.
        advanced_disable_flags: true,
        save_referrer: false,
        save_campaign_params: false,
        // Each event is its own request, sent as it happens and readable in the network panel: turning
        // usage data off leaves nothing waiting to be sent.
        request_batching: false,
        disable_compression: true,
        // A person is kept only for a signed-in account.
        person_profiles: 'identified_only',
        before_send: onlyKept,
      })
      // An event whose request fails is lost, not sent again: the SDK would retry it for up to half an
      // hour, also after usage data was turned off.
      client._retryQueue?.unload()
      client._retryQueue = undefined
    }
    return client
  }

  /** Does `task` with the SDK, after what was asked before it; nothing when usage data is off. */
  function withClient(task: (posthog: PostHog) => void): void {
    last = last
      .then(async () => {
        const posthog = await started()
        if (!posthog) return
        settle(posthog)
        task(posthog)
      })
      // Analytics never breaks the panel.
      .catch((err: unknown) => console.error('Could not send usage data', err))
  }

  function capture(posthog: PostHog, { event: name, ...properties }: { event: string }): void {
    const parsed = schemas.get(name)?.safeParse(properties)
    if (!parsed?.success) {
      console.error('Not sent: not a usage event', parsed?.error)
      return
    }
    posthog.capture(name, { ...parsed.data, version: chrome.runtime.getManifest().version, product })
  }

  /**
   * Makes the SDK's identity the panel's: the Clerk user id once signed in, joined to the random id
   * the device had before, and a new random id after signing out.
   */
  function settle(posthog: PostHog): void {
    if (user === undefined) return
    const identified = posthog._isIdentified()
    if (user === null) {
      if (identified) posthog.reset()
      return
    }
    if (identified && posthog.get_distinct_id() === user) return
    // Another account signed in on this device: its events are not joined to the one before.
    if (identified) posthog.reset()
    posthog.identify(user)
    capture(posthog, { event: 'signed_in' })
  }

  return {
    track: (event) => withClient((posthog) => capture(posthog, event)),
    identify(userId) {
      user = userId
      withClient(() => {})
    },
    loadAnalyticsEnabled,
    async saveAnalyticsEnabled(enabled) {
      on = enabled
      await chrome.storage.local.set({ [STORAGE_KEY]: enabled })
    },
  }
}
