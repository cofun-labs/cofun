import { useEffect, useId, useState } from 'react'
import { checkModel, DEEPSEEK_MODELS, openRouterModels, type ModelCheck } from '../agent'
import { ownSetup, RECOMMENDED, type ModelSettings, type OwnModel, type OwnSetup } from '../models'
import { Icon } from './icons'
import { useMenu } from './menu'

/** The hosted model, as the panel names it. */
export const HOSTED = 'Auto'

/** How many models a search shows at once; a longer query narrows them. */
const SEARCH_LIMIT = 20

type List = { status: 'loading' } | { status: 'ready'; models: OwnModel[] } | { status: 'failed'; message: string }

let listed: Promise<OwnModel[]> | undefined

/**
 * OpenRouter's model list, read once for the panel, by the settings page and the chat's menu alike.
 * A read that failed is made again the next time it is asked for.
 */
function modelList(): Promise<OwnModel[]> {
  listed ??= openRouterModels().catch((err: unknown) => {
    listed = undefined
    throw err
  })
  return listed
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** The services a user's own key works with, as the panel names them. */
const SERVICE = { openrouter: 'OpenRouter', deepseek: 'DeepSeek' } as const
type Service = keyof typeof SERVICE

/** The own model in use, with the service it is on; undefined when the hosted one answers. */
function ownInUse(settings: ModelSettings): { service: Service; model: OwnModel } | undefined {
  const setup = ownSetup(settings)
  if (!setup) return undefined
  if (setup.service === 'openrouter') return { service: 'openrouter', model: setup.model }
  return { service: 'deepseek', model: deepSeekModel(setup.model) }
}

/** A DeepSeek model by its id; one the catalog no longer has is shown by its id. */
function deepSeekModel(id: string): OwnModel {
  return DEEPSEEK_MODELS.find((m) => m.id === id) ?? { id, name: id, contextLength: 1, price: { input: 0, output: 0 } }
}

/** The settings with one service's setup removed: the hosted model answers if it was in use. */
function removed(settings: ModelSettings, service: Service): ModelSettings {
  const { openRouter, deepSeek } = settings
  return {
    use: settings.use === service ? 'hosted' : settings.use,
    ...(service !== 'openrouter' && openRouter && { openRouter }),
    ...(service !== 'deepseek' && deepSeek && { deepSeek }),
  }
}

/**
 * The model menu by the composer (UC-NOTICO-AGENT-002): it shows which model answers, and switches between
 * the hosted model and the user's own models, on each service they set up, without leaving the chat.
 * It lists them by name; their prices, other models on OpenRouter, and setting up a key are on the settings page (`onMore`).
 */
export function ModelMenu({
  settings,
  onChange,
  onMore,
}: {
  /** Undefined while they load: the menu isn't shown yet. */
  settings?: ModelSettings
  onChange: (settings: ModelSettings) => void
  onMore: () => void
}) {
  const { open, setOpen, close, rootRef, menuRef, onKeyDown } = useMenu()
  const [list, setList] = useState<List>()
  const menuId = useId()
  const openRouter = settings?.openRouter
  const deepSeek = settings?.deepSeek

  // The recommended models need OpenRouter's list, for their names and prices: read once the menu
  // opens with an OpenRouter key saved, never before.
  useEffect(() => {
    if (!open || !openRouter) return
    let live = true
    setList((now) => (now?.status === 'ready' ? now : { status: 'loading' }))
    modelList().then(
      (models) => live && setList({ status: 'ready', models }),
      (err: unknown) => live && setList({ status: 'failed', message: errorText(err) }),
    )
    return () => void (live = false)
  }, [open, !!openRouter])

  if (!settings) return null
  const inUse = ownInUse(settings)

  function pick(next: ModelSettings) {
    close()
    onChange(next)
  }

  // On OpenRouter: the model the user chose, then the recommended ones OpenRouter offers.
  const onOpenRouter: OwnModel[] = []
  if (openRouter) {
    const models = list?.status === 'ready' ? list.models : []
    if (!RECOMMENDED.some((r) => r.id === openRouter.model.id)) onOpenRouter.push(openRouter.model)
    for (const { id } of RECOMMENDED) {
      const model = id === openRouter.model.id ? openRouter.model : models.find((m) => m.id === id)
      if (model) onOpenRouter.push(model)
    }
  }

  // The menu names the models only: their notes and prices are on the settings page.
  const item = (service: Service, model: OwnModel, next: ModelSettings) => {
    const checked = inUse?.service === service && inUse.model.id === model.id
    return (
      <button
        key={model.id}
        type="button"
        role="menuitemradio"
        aria-checked={checked}
        tabIndex={-1}
        onClick={() => pick(next)}
      >
        <span className="model-name">{shortName(model)}</span>
        {checked && <Icon name="check" />}
      </button>
    )
  }

  return (
    <div className="model-menu" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="model-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Model: ${inUse ? shortName(inUse.model) : HOSTED}`}
        data-tip="Choose the model"
        aria-description="Choose the model"
        onClick={() => setOpen(!open)}
      >
        <span className="model-button-name">{inUse ? shortName(inUse.model) : HOSTED}</span>
        <Icon name="chevron" />
      </button>
      {open && (
        <div ref={menuRef} className="model-popover" role="menu" aria-label="Model">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!inUse}
            tabIndex={-1}
            onClick={() => pick({ ...settings, use: 'hosted' })}
          >
            <span className="model-name">{HOSTED}</span>
            {!inUse && <Icon name="check" />}
          </button>
          {openRouter && (
            <div role="group" aria-labelledby={`${menuId}-openrouter`}>
              <div id={`${menuId}-openrouter`} className="model-group" aria-hidden="true">
                OpenRouter
              </div>
              {onOpenRouter.map((model) =>
                item('openrouter', model, {
                  ...settings,
                  use: 'openrouter',
                  openRouter: { key: openRouter.key, model },
                }),
              )}
              {/* A menu holds only items: a state to read is one that can't be picked. */}
              {list?.status === 'loading' && (
                <div role="menuitem" aria-disabled="true" tabIndex={-1} className="model-state">
                  Loading OpenRouter's models…
                </div>
              )}
              {list?.status === 'failed' && (
                <div role="menuitem" aria-disabled="true" tabIndex={-1} className="model-state">
                  {list.message}
                </div>
              )}
            </div>
          )}
          {deepSeek && (
            <div role="group" aria-labelledby={`${menuId}-deepseek`}>
              <div id={`${menuId}-deepseek`} className="model-group" aria-hidden="true">
                DeepSeek
              </div>
              {DEEPSEEK_MODELS.map((model) =>
                item('deepseek', model, {
                  ...settings,
                  use: 'deepseek',
                  deepSeek: { key: deepSeek.key, model: model.id },
                }),
              )}
            </div>
          )}
          <button
            type="button"
            role="menuitem"
            className="model-more"
            tabIndex={-1}
            onClick={() => {
              setOpen(false)
              onMore()
            }}
          >
            {openRouter || deepSeek ? 'More models…' : 'Set up your own model…'}
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * The settings page's Model section (UC-NOTICO-AGENT-002): which model answers, and setting up OpenRouter
 * or DeepSeek with the user's own key. A change applies from the next question on.
 */
export function ModelCard({
  settings,
  onChange,
}: {
  /** Undefined while they load. */
  settings?: ModelSettings
  onChange: (settings: ModelSettings) => void
}) {
  const [mode, setMode] = useState<ModelSettings['use']>()
  const shown = mode ?? settings?.use ?? 'hosted'
  const radios = useId()

  if (!settings) {
    return (
      <section className="card" aria-labelledby="settings-model">
        <h3 id="settings-model">Model</h3>
        <p className="account-detail">Loading…</p>
      </section>
    )
  }

  const { openRouter, deepSeek } = settings
  const inUse = ownInUse(settings)

  function pick(next: ModelSettings['use']) {
    setMode(next)
    // Set up already: switching is one step. Otherwise the setup below finishes it.
    const ready = next === 'hosted' || (next === 'openrouter' ? openRouter : deepSeek)
    if (ready) onChange({ ...settings!, use: next })
  }

  function remove(service: Service) {
    // The choice shown follows what is saved now: the hosted model, or the other service if another
    // window switched to it meanwhile.
    setMode(undefined)
    onChange(removed(settings!, service))
  }

  return (
    <section className="card" aria-labelledby="settings-model">
      <h3 id="settings-model">Model</h3>
      <p className="settings-value" aria-label="Model in use">
        {inUse ? inUse.model.name : HOSTED}
      </p>
      <p className="account-detail">
        {inUse
          ? `On ${SERVICE[inUse.service]}, with your key. Questions spend no credits.`
          : "Notico's own model. Questions spend credits."}
      </p>

      <fieldset className="model-choice">
        <legend>Answer with</legend>
        <label>
          <input type="radio" name={radios} checked={shown === 'hosted'} onChange={() => pick('hosted')} />
          {HOSTED}
        </label>
        {(Object.keys(SERVICE) as Service[]).map((service) => (
          <label key={service}>
            <input type="radio" name={radios} checked={shown === service} onChange={() => pick(service)} />
            {SERVICE[service]}, with your key
          </label>
        ))}
      </fieldset>

      {shown === 'openrouter' && (
        <OpenRouterSetup
          saved={openRouter}
          onSave={(next) => onChange({ ...settings, use: 'openrouter', openRouter: next })}
          onRemove={() => remove('openrouter')}
        />
      )}
      {shown === 'deepseek' && (
        <DeepSeekSetup
          saved={deepSeek}
          onSave={(next) => onChange({ ...settings, use: 'deepseek', deepSeek: next })}
          onRemove={() => remove('deepseek')}
        />
      )}
    </section>
  )
}

/** The key and the model on OpenRouter: entered once, then the model can be changed on its own. */
function OpenRouterSetup({
  saved,
  onSave,
  onRemove,
}: {
  saved?: { key: string; model: OwnModel }
  onSave: (openRouter: { key: string; model: OwnModel }) => void
  onRemove: () => void
}) {
  const [list, setList] = useState<List>({ status: 'loading' })
  const [loads, setLoads] = useState(0)
  const [key, setKey] = useState('')
  const [picked, setPicked] = useState<OwnModel | undefined>(saved?.model)
  const [query, setQuery] = useState('')
  const radios = useId()

  // Read when the user picks OpenRouter, not before: until then the extension doesn't contact it.
  useEffect(() => {
    let live = true
    setList({ status: 'loading' })
    modelList().then(
      (models) => live && setList({ status: 'ready', models }),
      (err: unknown) => live && setList({ status: 'failed', message: errorText(err) }),
    )
    return () => void (live = false)
  }, [loads])

  function choose(model: OwnModel) {
    setPicked(model)
    // With a key saved, a new model applies at once.
    if (saved) onSave({ key: saved.key, model })
  }

  const models = list.status === 'ready' ? list.models : []
  const byId = new Map(models.map((m) => [m.id, m]))
  const needle = query.trim().toLowerCase()
  const found = needle
    ? models
        .filter((m) => m.name.toLowerCase().includes(needle) || m.id.toLowerCase().includes(needle))
        .slice(0, SEARCH_LIMIT)
    : []
  const keyToUse = saved?.key ?? key.trim()
  const option = (model: OwnModel, note?: string) => (
    <ModelOption key={model.id} model={model} note={note} name={radios} picked={picked?.id} onPick={choose} />
  )

  return (
    <div className="own-setup">
      <KeyField service="openrouter" saved={!!saved} value={key} onChange={setKey} onRemove={onRemove} />

      <fieldset className="model-list">
        <legend>Model</legend>
        {list.status === 'loading' && <p className="account-detail">Loading OpenRouter's models…</p>}
        {list.status === 'failed' && (
          <>
            <p role="alert">{list.message}</p>
            <button type="button" className="primary" onClick={() => setLoads((n) => n + 1)}>
              Try again
            </button>
          </>
        )}
        {list.status === 'ready' && (
          <>
            <ul aria-label="Recommended models">
              {RECOMMENDED.map(({ id, note }) => {
                const model = byId.get(id)
                return model ? (
                  option(model, note)
                ) : (
                  <li key={id} className="account-detail">
                    {id}: not available on OpenRouter now
                  </li>
                )
              })}
            </ul>
            {picked && !RECOMMENDED.some((r) => r.id === picked.id) && (
              <ul aria-label="Your model">{option(picked)}</ul>
            )}
            <label className="field">
              Search models
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            {needle && (
              <ul aria-label="Search results">
                {found.length ? (
                  found.map((m) => option(m))
                ) : (
                  <li className="account-detail">No model that can use tools matches.</li>
                )}
              </ul>
            )}
          </>
        )}
      </fieldset>

      <SetupActions
        key={picked?.id}
        service="openrouter"
        saved={!!saved}
        setup={keyToUse && picked ? { service: 'openrouter', key: keyToUse, model: picked } : undefined}
        onUse={() => picked && onSave({ key: keyToUse, model: picked })}
      />
    </div>
  )
}

/** The key and the model on DeepSeek, whose models are all listed: entered once, then the model can be changed on its own. */
function DeepSeekSetup({
  saved,
  onSave,
  onRemove,
}: {
  saved?: { key: string; model: string }
  onSave: (deepSeek: { key: string; model: string }) => void
  onRemove: () => void
}) {
  const [key, setKey] = useState('')
  const [picked, setPicked] = useState<string | undefined>(saved?.model)
  const radios = useId()

  function choose(model: OwnModel) {
    setPicked(model.id)
    if (saved) onSave({ key: saved.key, model: model.id })
  }

  const keyToUse = saved?.key ?? key.trim()
  return (
    <div className="own-setup">
      <KeyField service="deepseek" saved={!!saved} value={key} onChange={setKey} onRemove={onRemove} />

      <fieldset className="model-list">
        <legend>Model</legend>
        <ul aria-label="DeepSeek's models">
          {DEEPSEEK_MODELS.map((model) => (
            <ModelOption key={model.id} model={model} name={radios} picked={picked} onPick={choose} />
          ))}
        </ul>
      </fieldset>

      <SetupActions
        key={picked}
        service="deepseek"
        saved={!!saved}
        setup={keyToUse && picked ? { service: 'deepseek', key: keyToUse, model: picked } : undefined}
        onUse={() => picked && onSave({ key: keyToUse, model: picked })}
      />
    </div>
  )
}

/** The key for a service: a field to enter it, or, once saved, a way to remove it. */
function KeyField({
  service,
  saved,
  value,
  onChange,
  onRemove,
}: {
  service: Service
  saved: boolean
  value: string
  onChange: (key: string) => void
  onRemove: () => void
}) {
  const name = SERVICE[service]
  if (saved) {
    return (
      <p className="account-detail">
        Your {name} key is saved on this device.{' '}
        <button type="button" className="link" onClick={onRemove}>
          Remove key
        </button>
      </p>
    )
  }
  return (
    <>
      <label className="field">
        {name} API key
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
      <p className="account-detail">
        Kept on this device for this account only, not encrypted, and sent only to {name}.
      </p>
    </>
  )
}

/** One model to pick, with its price and context. */
function ModelOption({
  model,
  note,
  name,
  picked,
  onPick,
}: {
  model: OwnModel
  note?: string
  /** The radio group's name. */
  name: string
  picked?: string
  onPick: (model: OwnModel) => void
}) {
  return (
    <li>
      <label>
        <input type="radio" name={name} checked={picked === model.id} onChange={() => onPick(model)} />
        <span>
          <span className="model-name">{model.name}</span>{' '}
          <span className="account-detail">
            {note && `${note} · `}
            {priceText(model)}
          </span>
        </span>
      </label>
    </li>
  )
}

/**
 * Using the service (before a key is saved), and checking the key and model. Give it a `key` that
 * changes with the model, so a check of another model is not shown.
 */
function SetupActions({
  service,
  saved,
  setup,
  onUse,
}: {
  service: Service
  saved: boolean
  /** What to use and check; undefined until there is a key and a model. */
  setup?: OwnSetup
  onUse: () => void
}) {
  const [check, setCheck] = useState<ModelCheck | 'checking'>()
  return (
    <>
      <div className="model-actions">
        {!saved && (
          <button type="button" className="primary" disabled={!setup} onClick={onUse}>
            Use {SERVICE[service]}
          </button>
        )}
        <button
          type="button"
          className="link"
          disabled={!setup || check === 'checking'}
          onClick={async () => {
            if (!setup) return
            setCheck('checking')
            try {
              setCheck(await checkModel(setup))
            } catch (err) {
              setCheck({ status: 'failed', message: errorText(err) })
            }
          }}
        >
          Check key and model
        </button>
      </div>
      {check && (
        <p role="status" className={check !== 'checking' && check.status !== 'ok' ? 'check-problem' : 'account-detail'}>
          {checkText(check)}
        </p>
      )}
    </>
  )
}

/** A model's name without the vendor OpenRouter puts before it ("Anthropic: Claude Sonnet 5.5"). */
const shortName = ({ name }: OwnModel) => name.replace(/^[^:]+:\s*/, '') || name

const dollars = (n: number) => `$${n < 0.1 ? n.toFixed(3).replace(/0$/, '') : n.toFixed(2)}`

/** How much a model takes in at once, in tokens, rounded down: never more than it takes. */
function contextText(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.floor(tokens / 10_000) / 100}M`
  return `${Math.floor(tokens / 1000)}K`
}

/** What a model costs, per million tokens in and out, and how much it takes in at once. */
function priceText({ price, contextLength }: OwnModel): string {
  const context = `${contextText(contextLength)} context`
  if (price.input === 0 && price.output === 0) return `Free · ${context}`
  return `${dollars(price.input)} in · ${dollars(price.output)} out per million tokens · ${context}`
}

function checkText(check: ModelCheck | 'checking'): string {
  if (check === 'checking') return 'Checking…'
  if (check.status === 'ok') return 'The model answered and can use tools.'
  if (check.status === 'no_tools')
    return "The model answered but didn't use the tool. Notico needs tools to read and edit pages; pick another model."
  return `The check failed: ${check.message}`
}
