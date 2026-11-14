import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { checkKey, DEEPSEEK_MODELS, openRouterModels, type KeyCheck, type ListedModel } from '../agent'
import { answering, RECOMMENDED, SERVICE_NAME, type ModelSettings, type OwnModel, type Service } from '../models'
import { Icon } from './icons'
import { useMenu } from './menu'

/** The hosted model, as the panel names it. */
export const HOSTED = 'Auto'

/** How many models a search shows at once; a longer query narrows them. */
const SEARCH_LIMIT = 20

type List = { status: 'loading' } | { status: 'ready'; models: ListedModel[] } | { status: 'failed'; message: string }

let listed: Promise<ListedModel[]> | undefined

/**
 * OpenRouter's model list, read once for the panel. A read that failed is made again the next time
 * it is asked for.
 */
function modelList(): Promise<ListedModel[]> {
  listed ??= openRouterModels().catch((err: unknown) => {
    listed = undefined
    throw err
  })
  return listed
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * What the last check that passed in this panel found each key has left. Kept for the panel, not
 * saved: a balance changes with every question, so an old one would mislead.
 */
const balances = new Map<string, string>()

/** Where to get a key, as the user knows the provider's site. */
const KEY_SITE: Record<Service, string> = { openrouter: 'openrouter.ai', deepseek: 'platform.deepseek.com' }

/** A model as the menu and the settings page show it: its provider, and how the provider names it. */
interface Offered {
  service: Service
  model: OwnModel
}

/** A DeepSeek model by its id, from DeepSeek's catalog; undefined once the catalog no longer has it. */
const deepSeekModel = (id: string) => DEEPSEEK_MODELS.find((m) => m.id === id)

/** OpenRouter's switched-on models, the recommended ones first, in their order. */
function openRouterOrder(models: OwnModel[]): OwnModel[] {
  const rank = (m: OwnModel) => {
    const at = RECOMMENDED.findIndex((r) => r.id === m.id)
    return at < 0 ? RECOMMENDED.length : at
  }
  return [...models].sort((a, b) => rank(a) - rank(b))
}

/** Each provider that is on, with its switched-on models, as the menu lists them. */
function offered(settings: ModelSettings): { service: Service; models: OwnModel[] }[] {
  const { openRouter, deepSeek } = settings
  const groups: { service: Service; models: OwnModel[] }[] = []
  if (openRouter?.on) groups.push({ service: 'openrouter', models: openRouterOrder(openRouter.models) })
  if (deepSeek?.on)
    groups.push({ service: 'deepseek', models: DEEPSEEK_MODELS.filter((m) => deepSeek.models.includes(m.id)) })
  return groups.filter((g) => g.models.length > 0)
}

/** The own model that answers, with its provider; undefined when Auto does. */
function inUse(settings: ModelSettings): Offered | undefined {
  const setup = answering(settings)
  if (!setup) return undefined
  if (setup.service === 'openrouter') return { service: 'openrouter', model: setup.model }
  const model = deepSeekModel(setup.model)
  return model && { service: 'deepseek', model }
}

/**
 * The model menu by the composer (UC-NOTICO-AGENT-002): it shows which model answers, and picks
 * among Auto and the models switched on in Settings, grouped by provider, by name only. Which
 * providers and models are offered is set in Settings (`onManage`).
 */
export function ModelMenu({
  settings,
  onChange,
  onManage,
}: {
  /** Undefined while they load: the menu isn't shown yet. */
  settings?: ModelSettings
  onChange: (settings: ModelSettings) => void
  onManage: () => void
}) {
  const { open, setOpen, close, rootRef, menuRef, onKeyDown } = useMenu()
  const menuId = useId()

  if (!settings) return null
  const now = inUse(settings)
  const shown = now ? shortName(now.model) : HOSTED

  function pick(chosen: ModelSettings['chosen']) {
    close()
    const { chosen: _, ...rest } = settings!
    onChange(chosen ? { ...rest, chosen } : rest)
  }

  return (
    <div className="model-menu" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="model-button tip-end"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Model: ${shown}`}
        data-tip="Choose the model"
        aria-description="Choose the model"
        onClick={() => setOpen(!open)}
      >
        <span className="model-button-name">{shown}</span>
        <Icon name="chevron" />
      </button>
      {open && (
        <div ref={menuRef} className="model-popover" role="menu" aria-label="Model">
          <button type="button" role="menuitemradio" aria-checked={!now} tabIndex={-1} onClick={() => pick(undefined)}>
            <span className="model-name">{HOSTED}</span>
            {!now && <Icon name="check" />}
          </button>
          {offered(settings).map(({ service, models }) => (
            <div key={service} role="group" aria-labelledby={`${menuId}-${service}`}>
              <div id={`${menuId}-${service}`} className="model-group" aria-hidden="true">
                {SERVICE_NAME[service]}
              </div>
              {models.map((model) => {
                const checked = now?.service === service && now.model.id === model.id
                return (
                  <button
                    key={model.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={checked}
                    tabIndex={-1}
                    onClick={() => pick({ service, model: model.id, name: model.name })}
                  >
                    <span className="model-name">{shortName(model)}</span>
                    {checked && <Icon name="check" />}
                  </button>
                )
              })}
            </div>
          ))}
          <button
            type="button"
            role="menuitem"
            className="model-more"
            tabIndex={-1}
            onClick={() => {
              setOpen(false)
              onManage()
            }}
          >
            <Icon name="settings" />
            <span className="model-name">Manage models</span>
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Above the composer, when the model the composer chose is no longer offered (switched off in
 * Settings, or its provider or key gone): questions go to Auto, and this says so instead of the
 * chip changing silently. It goes once the user picks a model, or the model is offered again.
 */
export function ModelNote({ settings }: { settings?: ModelSettings }) {
  const chosen = settings?.chosen
  if (!settings || !chosen || answering(settings)) return null
  const name = chosen.service === 'deepseek' ? (deepSeekModel(chosen.model)?.name ?? chosen.name) : chosen.name
  return (
    <p className="model-note" role="status">
      <Icon name="info" />
      <span>
        {shortName({ name })} was switched off in Settings, so questions use {HOSTED}.
      </span>
    </p>
  )
}

/**
 * The settings page's Providers section (UC-NOTICO-AGENT-002): which providers are on, their keys,
 * and which of their models the composer's menu offers. A change applies from the next question on.
 * `focus`: the page was opened to manage models, so the section takes the focus.
 */
export function ModelCard({
  settings,
  onChange,
  focus,
}: {
  /** Undefined while they load. */
  settings?: ModelSettings
  onChange: (settings: ModelSettings) => void
  focus?: boolean
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (!focus) return
    headingRef.current?.focus()
    headingRef.current?.scrollIntoView?.({ block: 'start' })
  }, [])

  const heading = (
    <h3 id="settings-providers" ref={headingRef} tabIndex={-1}>
      Providers
    </h3>
  )
  if (!settings) {
    return (
      <section className="card" aria-labelledby="settings-providers">
        {heading}
        <p className="account-detail">Loading…</p>
      </section>
    )
  }

  const { openRouter, deepSeek } = settings
  /** The settings with one provider's part replaced, or removed with `undefined`. */
  function withProvider<S extends 'openRouter' | 'deepSeek'>(name: S, part: ModelSettings[S]): ModelSettings {
    const { [name]: _, ...rest } = settings!
    return part ? { ...rest, [name]: part } : rest
  }

  return (
    <section className="card providers" aria-labelledby="settings-providers">
      {heading}
      <div className="provider">
        <ProviderHead name="Notico" detail="No key needed. Spends your credits." mark="N">
          <Switch label="Notico" checked disabled tip="Always on" />
        </ProviderHead>
        <ul className="provider-models" aria-label="Notico's models">
          <ModelRow name={HOSTED} detail="Notico picks the model" checked disabled />
        </ul>
      </div>
      <ProviderSetup
        service="openrouter"
        saved={openRouter}
        onKey={async (key) => {
          // A new key keeps the models switched on. A first one starts with the first recommended
          // model OpenRouter offers, so the provider is usable at once.
          let models = openRouter?.models
          if (!models) {
            const listed = await modelList().catch((): ListedModel[] => [])
            const first = RECOMMENDED.map((r) => listed.find((m) => m.id === r.id && m.tools)).find((m) => m)
            models = first ? [ownModel(first)] : []
          }
          onChange(withProvider('openRouter', { on: true, key, models }))
        }}
        onSwitch={(on) => openRouter && onChange(withProvider('openRouter', { ...openRouter, on }))}
        onRemove={() => onChange(withProvider('openRouter', undefined))}
      >
        {openRouter && (
          <OpenRouterModels
            on={openRouter.models}
            onChange={(models) => onChange(withProvider('openRouter', { ...openRouter, models }))}
          />
        )}
      </ProviderSetup>
      <ProviderSetup
        service="deepseek"
        saved={deepSeek}
        onKey={async (key) =>
          onChange(
            withProvider('deepSeek', {
              on: true,
              key,
              // The catalog's first model starts switched on, so the provider is usable at once.
              models: deepSeek?.models ?? DEEPSEEK_MODELS.slice(0, 1).map((m) => m.id),
            }),
          )
        }
        onSwitch={(on) => deepSeek && onChange(withProvider('deepSeek', { ...deepSeek, on }))}
        onRemove={() => onChange(withProvider('deepSeek', undefined))}
      >
        {deepSeek && (
          <ModelList label="DeepSeek's models" count={deepSeek.models.length} total={DEEPSEEK_MODELS.length}>
            {DEEPSEEK_MODELS.map((model) => {
              const checked = deepSeek.models.includes(model.id)
              return (
                <ModelRow
                  key={model.id}
                  name={model.name}
                  detail={priceText(model)}
                  checked={checked}
                  last={checked && deepSeek.models.length === 1}
                  onSwitch={(on) =>
                    onChange(
                      withProvider('deepSeek', {
                        ...deepSeek,
                        models: on ? [...deepSeek.models, model.id] : deepSeek.models.filter((id) => id !== model.id),
                      }),
                    )
                  }
                />
              )
            })}
          </ModelList>
        )}
      </ProviderSetup>
    </section>
  )
}

/** A model from OpenRouter's list, as it is saved: without what only the list needs. */
const ownModel = ({ id, name, contextLength, price }: OwnModel): OwnModel => ({ id, name, contextLength, price })

/** A provider's name, what it is, and its switch. */
function ProviderHead({
  name,
  detail,
  mark,
  status,
  children,
}: {
  name: string
  detail?: string
  mark: string
  status?: { ok: boolean; text: string }
  children: React.ReactNode
}) {
  return (
    <div className="provider-head">
      <span className={`provider-mark provider-mark-${mark.toLowerCase()}`} aria-hidden="true">
        {mark}
      </span>
      <div className="provider-name">
        <span className="model-name">{name}</span>
        {status ? (
          <span className={status.ok ? 'provider-status ok' : 'provider-status bad'}>
            <Icon name={status.ok ? 'ok' : 'alert'} />
            {status.text}
          </span>
        ) : (
          <span className="account-detail">{detail}</span>
        )}
      </div>
      {children}
    </div>
  )
}

type Check = { status: 'checking' } | Exclude<KeyCheck, { status: 'ok' }>

/**
 * A provider that needs a key: its switch, its key and the check of it, and, once a key is saved and
 * the provider is on, its models (`children`). `onKey` saves a key that passed the check.
 */
function ProviderSetup({
  service,
  saved,
  onKey,
  onSwitch,
  onRemove,
  children,
}: {
  service: Service
  saved?: { on: boolean; key: string; rejectedAt?: number }
  onKey: (key: string) => Promise<void>
  onSwitch: (on: boolean) => void
  onRemove: () => void
  children: React.ReactNode
}) {
  const name = SERVICE_NAME[service]
  // Switched on with no key saved yet: the key field is open, and nothing is saved until a key passes.
  const [opening, setOpening] = useState(false)
  const [changing, setChanging] = useState(false)
  const [value, setValue] = useState('')
  const [check, setCheck] = useState<Check>()
  const fieldId = useId()
  const on = saved ? saved.on : opening
  const balance = saved && balances.get(saved.key)

  /** Checks `key`, and saves it if it passes. Only a key that passes is saved. */
  async function run(key: string) {
    setCheck({ status: 'checking' })
    let result: KeyCheck
    try {
      result = await checkKey(service, key)
      if (result.status === 'ok') {
        if (result.balance) balances.set(key, result.balance)
        else balances.delete(key)
        await onKey(key)
      }
    } catch (err) {
      result = { status: 'failed', message: errorText(err) }
    }
    if (result.status !== 'ok') return setCheck(result)
    setCheck(undefined)
    setOpening(false)
    setChanging(false)
    setValue('')
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    const key = value.trim()
    if (key && check?.status !== 'checking') void run(key)
  }

  const checking = check?.status === 'checking'
  const problem = check && check.status !== 'checking' ? checkProblem(service, check) : undefined
  const status = !saved
    ? undefined
    : saved.rejectedAt !== undefined
      ? { ok: false, text: 'Key stopped working' }
      : { ok: true, text: balance ? `Key works · ${balance}` : 'Key works' }
  const keyForm = (
    <form className="key-form" onSubmit={submit}>
      <div className="key-row">
        <input
          id={fieldId}
          type="password"
          aria-label={`${name} API key`}
          autoComplete="off"
          spellCheck={false}
          placeholder={`Paste your ${name} key`}
          value={value}
          readOnly={checking}
          aria-invalid={!!problem}
          onChange={(e) => {
            setValue(e.target.value)
            if (check?.status !== 'checking') setCheck(undefined)
          }}
        />
        <button type="submit" className="primary" disabled={!value.trim() || checking}>
          {checking ? 'Checking…' : 'Check key'}
        </button>
      </div>
      {checking && (
        <p className="key-message info" role="status">
          <span className="spinner" aria-hidden="true" />
          Asking {name} whether this key works…
        </p>
      )}
      {problem && (
        <p className="key-message bad" role="alert">
          <Icon name="alert" />
          <span>{problem}</span>
        </p>
      )}
      {!checking && !problem && (
        <p className="account-detail">
          Get a key at {KEY_SITE[service]}. It stays on this device, not encrypted, and goes only to {name}.
        </p>
      )}
      {changing && (
        <button
          type="button"
          className="link"
          disabled={checking}
          onClick={() => {
            setChanging(false)
            setValue('')
            setCheck(undefined)
          }}
        >
          Keep the saved key
        </button>
      )}
    </form>
  )

  return (
    <div className="provider" role="group" aria-label={name}>
      <ProviderHead
        name={name}
        detail="Your own key. No credits spent."
        mark={name[0]}
        status={on ? status : undefined}
      >
        <Switch
          label={name}
          checked={on}
          disabled={checking}
          onChange={(next) => {
            if (saved) return onSwitch(next)
            setOpening(next)
            setValue('')
            setCheck(undefined)
          }}
        />
      </ProviderHead>
      {on && (
        <div className="provider-body">
          {!saved || changing ? (
            keyForm
          ) : (
            <>
              {saved.rejectedAt !== undefined && (
                <p className="key-message bad" role="alert">
                  <Icon name="alert" />
                  <span>
                    {name} turned this key away on {dateText(saved.rejectedAt)}. Questions to its models will fail until
                    you check it again or paste a new one.
                  </span>
                </p>
              )}
              <div className="key-row">
                <span className="key-saved" aria-label={`Saved ${name} key`}>
                  {masked(saved.key)}
                </span>
                {saved.rejectedAt !== undefined ? (
                  <button type="button" className="primary" disabled={checking} onClick={() => void run(saved.key)}>
                    {checking ? 'Checking…' : 'Check again'}
                  </button>
                ) : (
                  <button type="button" className="secondary" onClick={() => setChanging(true)}>
                    Change
                  </button>
                )}
              </div>
              {checking && (
                <p className="key-message info" role="status">
                  <span className="spinner" aria-hidden="true" />
                  Asking {name} whether this key works…
                </p>
              )}
              {problem && (
                <p className="key-message bad" role="alert">
                  <Icon name="alert" />
                  <span>{problem}</span>
                </p>
              )}
              <div className="key-actions">
                {saved.rejectedAt !== undefined && (
                  <button type="button" className="link" disabled={checking} onClick={() => setChanging(true)}>
                    Paste a new key
                  </button>
                )}
                <button type="button" className="link" disabled={checking} onClick={onRemove}>
                  Remove key
                </button>
              </div>
            </>
          )}
          {saved && children}
        </div>
      )}
    </div>
  )
}

/** Why a check failed, and what to do about it. */
function checkProblem(service: Service, check: Exclude<Check, { status: 'checking' }>): string {
  const name = SERVICE_NAME[service]
  const site = KEY_SITE[service]
  switch (check.status) {
    case 'rejected':
      return `${name} doesn't accept this key. Copy it again from ${site} and paste it here.`
    case 'no_money':
      return `The key works, but its ${name} account has no money left. Add credit at ${site}, then check again.`
    case 'timed_out':
      return `${name} didn't answer in time. Check your connection, then try again.`
    case 'unreachable':
      return `${name} couldn't be reached. Check your connection, then try again.`
    case 'failed':
      return `The check failed: ${check.message}`
  }
}

/** A saved key, with only its start and its last four characters showing. */
function masked(key: string): string {
  const start = key.startsWith('sk-or-v1-') ? 'sk-or-v1-' : key.slice(0, 3)
  return `${start}••••••••${key.slice(-4)}`
}

const dateText = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

/** OpenRouter's models: the recommended ones and those switched on, and a search over its whole list. */
function OpenRouterModels({ on, onChange }: { on: OwnModel[]; onChange: (models: OwnModel[]) => void }) {
  const [list, setList] = useState<List>({ status: 'loading' })
  const [loads, setLoads] = useState(0)
  const [query, setQuery] = useState('')

  // Read once a key is saved and OpenRouter is on, not before: until then the extension doesn't contact it.
  useEffect(() => {
    let live = true
    setList({ status: 'loading' })
    modelList().then(
      (models) => live && setList({ status: 'ready', models }),
      (err: unknown) => live && setList({ status: 'failed', message: errorText(err) }),
    )
    return () => void (live = false)
  }, [loads])

  const models = list.status === 'ready' ? list.models : []
  const byId = new Map(models.map((m) => [m.id, m]))
  const isOn = (id: string) => on.some((m) => m.id === id)
  const needle = query.trim().toLowerCase()

  function row(model: OwnModel & { tools?: boolean }, note?: string) {
    const checked = isOn(model.id)
    // A model that can't use tools can't be switched on; one already on can still be switched off.
    const noTools = model.tools === false && !checked
    return (
      <ModelRow
        key={model.id}
        name={model.name}
        detail={noTools ? "Can't use tools, which Notico needs" : [note, priceText(model)].filter(Boolean).join(' · ')}
        checked={checked}
        disabled={noTools}
        last={checked && on.length === 1}
        onSwitch={(next) => onChange(next ? [...on, ownModel(model)] : on.filter((m) => m.id !== model.id))}
      />
    )
  }

  const recommended = RECOMMENDED.map(({ id, note }) => {
    const model = byId.get(id) ?? on.find((m) => m.id === id)
    if (model) return row(model, note)
    return list.status === 'ready' ? (
      <li key={id} className="account-detail">
        {id}: not available on OpenRouter now
      </li>
    ) : null
  })
  const others = on.filter((m) => !RECOMMENDED.some((r) => r.id === m.id)).map((m) => row(byId.get(m.id) ?? m))
  const found = needle
    ? models
        .filter((m) => m.name.toLowerCase().includes(needle) || m.id.toLowerCase().includes(needle))
        .slice(0, SEARCH_LIMIT)
    : []

  return (
    <>
      <ModelList label="OpenRouter's models" count={on.length}>
        {recommended}
        {others}
      </ModelList>
      {list.status === 'loading' && <p className="account-detail">Loading OpenRouter's models…</p>}
      {list.status === 'failed' && (
        <>
          <p role="alert">{list.message}</p>
          <button type="button" className="secondary" onClick={() => setLoads((n) => n + 1)}>
            Try again
          </button>
        </>
      )}
      {/* The results go under the field, so it stays where it is while the user types. */}
      <label className="model-search">
        <Icon name="search" />
        <input
          type="search"
          aria-label="Find another model on OpenRouter"
          placeholder="Find another model on OpenRouter"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {needle && (
        <>
          <ul className="provider-models" aria-label="Search results">
            {found.length ? (
              found.map((m) => row(m))
            ) : list.status === 'ready' ? (
              <li className="account-detail">No model on OpenRouter matches.</li>
            ) : null}
          </ul>
          <p className="account-detail">Switching one on adds it to the list above and to the menu.</p>
        </>
      )}
    </>
  )
}

/** A provider's models, each with its switch, and how many are on. */
function ModelList({
  label,
  count,
  total,
  children,
}: {
  label: string
  count: number
  total?: number
  children: React.ReactNode
}) {
  return (
    <div className="model-list">
      <p className="model-list-head">
        <span>Models · price per 1M tokens</span>
        <span>{total === undefined ? `${count} on` : `${count} of ${total} on`}</span>
      </p>
      <ul className="provider-models" aria-label={label}>
        {children}
      </ul>
    </div>
  )
}

/**
 * One model with its switch. `last`: the provider's only model on, which stays on, so the provider
 * always offers one.
 */
function ModelRow({
  name,
  detail,
  checked,
  disabled,
  last,
  onSwitch,
}: {
  name: string
  detail: string
  checked: boolean
  disabled?: boolean
  last?: boolean
  onSwitch?: (on: boolean) => void
}) {
  const detailId = useId()
  return (
    <li className={disabled && !checked ? 'model-row off' : 'model-row'}>
      <span className="model-row-name">
        <span>{name}</span>
        <span id={detailId} className="account-detail">
          {detail}
        </span>
      </span>
      <Switch
        label={name}
        describedBy={detailId}
        checked={checked}
        disabled={disabled || last}
        tip={last ? 'One model stays on' : undefined}
        onChange={onSwitch}
        small
      />
    </li>
  )
}

/** An on/off switch. */
function Switch({
  label,
  checked,
  disabled,
  tip,
  describedBy,
  small,
  onChange,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  /** Why it can't be switched, shown on hover. */
  tip?: string
  describedBy?: string
  small?: boolean
  onChange?: (on: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      className={`${small ? 'switch small' : 'switch'}${tip ? ' tip-end' : ''}`}
      aria-label={label}
      aria-checked={checked}
      aria-describedby={describedBy}
      aria-description={tip}
      data-tip={tip}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
    />
  )
}

/** A model's name without the vendor OpenRouter puts before it ("Anthropic: Claude Sonnet 5.5"). */
const shortName = ({ name }: { name: string }) => name.replace(/^[^:]+:\s*/, '') || name

const dollars = (n: number) => `$${n < 0.1 ? n.toFixed(3).replace(/0$/, '') : n.toFixed(2)}`

/** How much a model takes in at once, in tokens, rounded down: never more than it takes. */
function contextText(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.floor(tokens / 10_000) / 100}M`
  return `${Math.floor(tokens / 1000)}K`
}

/** What a model costs, per million tokens in and out (the list head says the unit), and how much it takes in at once. */
function priceText({ price, contextLength }: OwnModel): string {
  const context = `${contextText(contextLength)} context`
  if (price.input === 0 && price.output === 0) return `Free · ${context}`
  return `${dollars(price.input)} in · ${dollars(price.output)} out · ${context}`
}
