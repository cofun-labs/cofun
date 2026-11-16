// Product analytics: which features are used and how they end, sent to PostHog from the side panel.
// The only module that imports the PostHog SDK. The rest of the extension calls `track` with one of
// the events below, and nothing else can be sent: every property is an enum, a number, or a
// boolean, so a message, a reply, a page's title, a URL, or a key has no field to travel in.
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
// size, …), so `onlyKept` drops every property that is not listed.
import { PostHog, type CaptureResult } from 'posthog-js/dist/module.no-external'
import { NOTION_ERROR_CODES } from './notion/api'
import { TOOLS } from './tools'
import { analyticsEvents, type AnalyticsEvent } from '@cofun/app/analytics'

/** The PostHog project events go to. Public by design; without it nothing is sent. */
const KEY: string | undefined = import.meta.env.VITE_POSTHOG_KEY
/** PostHog's ingestion host, which the content security policy names (manifest.ts). */
const HOST: string | undefined = import.meta.env.VITE_POSTHOG_HOST

const AnalyticsEvent = analyticsEvents(
  TOOLS.map((tool) => tool.name),
  NOTION_ERROR_CODES,
).transform((event) => {
  if (event.event !== 'question_asked') return event
  // Keep Notico's existing event property when mapping the shared application's site context.
  const { site_tab, ...question } = event
  return { ...question, notion_tab: site_tab }
})

/** Every property an event of ours may carry, besides the two all of them do. */
const OWN_PROPERTIES = [
  'provider',
  'notion_tab',
  'outcome',
  'error_code',
  'rounds',
  'tool_calls',
  'tool',
  'ok',
  'status',
  'pack',
  'how',
  'version',
  'product',
]

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

const KEPT = new Set([...OWN_PROPERTIES, ...SDK_PROPERTIES])

/**
 * The event as it is sent: only the listed properties, and nothing set on the person. Signing in
 * makes the SDK send an `$identify` event, which joins the device's random id to the Clerk user id;
 * it would also record the first page's URL and referrer on the person. Every event, that one
 * included, tells PostHog not to work out a location from the request's address.
 */
function onlyKept(event: CaptureResult | null): CaptureResult | null {
  if (!event) return null
  const properties = Object.fromEntries(Object.entries(event.properties).filter(([name]) => KEPT.has(name)))
  return { ...event, properties: { ...properties, $geoip_disable: true }, $set: undefined, $set_once: undefined }
}

const STORAGE_KEY = 'analytics'

/**
 * Whether usage data is sent, as the settings page's switch says. On unless the user turned it off;
 * kept in chrome.storage.local for the device, not per account, since it also covers the panel
 * before anyone is signed in.
 */
export async function loadAnalyticsEnabled(): Promise<boolean> {
  const stored: unknown = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]
  return stored !== false
}

/** Turns usage data on or off, for this panel at once and for every other one through storage. */
export async function saveAnalyticsEnabled(enabled: boolean): Promise<void> {
  on = enabled
  await chrome.storage.local.set({ [STORAGE_KEY]: enabled })
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
  if (!KEY || !HOST) return undefined
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
    client.init(KEY, {
      api_host: HOST,
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

function capture(posthog: PostHog, event: AnalyticsEvent): void {
  const parsed = AnalyticsEvent.safeParse(event)
  if (!parsed.success) {
    console.error('Not sent: not a usage event', parsed.error)
    return
  }
  const { event: name, ...properties } = parsed.data
  posthog.capture(name, {
    ...properties,
    version: chrome.runtime.getManifest().version,
    product: 'notico',
  })
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

/** Records that something happened. Sends nothing while usage data is off. */
export function track(event: AnalyticsEvent): void {
  withClient((posthog) => capture(posthog, event))
}

/** Tells analytics who is signed in (`null`: nobody), once the panel knows. */
export function identify(userId: string | null): void {
  user = userId
  withClient(() => {})
}
