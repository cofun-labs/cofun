import { useEffect, useId, useState } from 'react'
import { checkModel, openRouterModels, type ModelCheck } from '../agent'
import { HOSTED_ONLY, RECOMMENDED, type ModelSettings, type OpenRouterModel } from '../models'
import { Icon } from './icons'
import { useMenu } from './menu'

/** The hosted model, as the panel names it. */
const HOSTED = 'Notico (hosted)'

/** How many models a search shows at once; a longer query narrows them. */
const SEARCH_LIMIT = 20

type List =
  | { status: 'loading' }
  | { status: 'ready'; models: OpenRouterModel[] }
  | { status: 'failed'; message: string }

let listed: Promise<OpenRouterModel[]> | undefined

/**
 * OpenRouter's model list, read once for the panel, by the settings page and the chat's menu alike.
 * A read that failed is made again the next time it is asked for.
 */
function modelList(): Promise<OpenRouterModel[]> {
  listed ??= openRouterModels().catch((err: unknown) => {
    listed = undefined
    throw err
  })
  return listed
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * The model menu by the composer (UC-AGENT-002): it shows which model answers, and switches between
 * the hosted model and the user's own models on OpenRouter without leaving the chat. Other models,
 * and setting up a key, are on the settings page (`onMore`).
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
  const saved = settings?.openRouter

  // The recommended models need OpenRouter's list, for their names and prices: read once the menu
  // opens with a key saved, never before.
  useEffect(() => {
    if (!open || !saved) return
    let live = true
    setList((now) => (now?.status === 'ready' ? now : { status: 'loading' }))
    modelList().then(
      (models) => live && setList({ status: 'ready', models }),
      (err: unknown) => live && setList({ status: 'failed', message: errorText(err) }),
    )
    return () => void (live = false)
  }, [open, !!saved])

  if (!settings) return null
  const inUse = settings.use === 'openrouter' && saved ? saved.model : undefined

  function pick(next: ModelSettings) {
    close()
    onChange(next)
  }

  // The user's own models: the one they chose, then the recommended ones OpenRouter offers.
  const own: { model: OpenRouterModel; note?: string }[] = []
  if (saved) {
    const models = list?.status === 'ready' ? list.models : []
    if (!RECOMMENDED.some((r) => r.id === saved.model.id)) own.push({ model: saved.model })
    for (const { id, note } of RECOMMENDED) {
      const model = id === saved.model.id ? saved.model : models.find((m) => m.id === id)
      if (model) own.push({ model, note })
    }
  }

  return (
    <div className="model-menu" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="model-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Model: ${inUse ? shortName(inUse) : HOSTED}`}
        title="Choose the model"
        onClick={() => setOpen(!open)}
      >
        <span className="model-button-name">{inUse ? shortName(inUse) : HOSTED}</span>
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
            <span>
              <span className="model-name">{HOSTED}</span> <span className="account-detail">Spends credits</span>
            </span>
            {!inUse && <Icon name="check" />}
          </button>
          {saved &&
            own.map(({ model, note }) => (
              <button
                key={model.id}
                type="button"
                role="menuitemradio"
                aria-checked={inUse?.id === model.id}
                tabIndex={-1}
                onClick={() => pick({ use: 'openrouter', openRouter: { key: saved.key, model } })}
              >
                <span>
                  <span className="model-name">{shortName(model)}</span>{' '}
                  <span className="account-detail">
                    {note && `${note} · `}
                    {shortPrice(model)}
                  </span>
                </span>
                {inUse?.id === model.id && <Icon name="check" />}
              </button>
            ))}
          {saved && list?.status === 'loading' && <p className="account-detail">Loading OpenRouter's models…</p>}
          {saved && list?.status === 'failed' && <p className="account-detail">{list.message}</p>}
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
            {saved ? 'More models…' : 'Set up your own model…'}
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * The settings page's Model section (UC-AGENT-002): which model answers, and setting up OpenRouter
 * with the user's own key. A change applies from the next question on.
 */
export function ModelCard({
  settings,
  onChange,
}: {
  /** Undefined while they load. */
  settings?: ModelSettings
  onChange: (settings: ModelSettings) => void
}) {
  const [mode, setMode] = useState<'hosted' | 'openrouter'>()
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

  const { openRouter } = settings
  const inUse = settings.use === 'openrouter' && openRouter ? openRouter.model : undefined

  function pick(next: 'hosted' | 'openrouter') {
    setMode(next)
    // Set up already: switching is one step. Otherwise the setup below finishes it.
    if (next === 'hosted' || openRouter) onChange({ ...settings!, use: next })
  }

  return (
    <section className="card" aria-labelledby="settings-model">
      <h3 id="settings-model">Model</h3>
      <p className="settings-value" aria-label="Model in use">
        {inUse ? inUse.name : HOSTED}
      </p>
      <p className="account-detail">
        {inUse
          ? 'On OpenRouter, with your key. Questions spend no credits.'
          : "Notico's own model. Questions spend credits."}
      </p>

      <fieldset className="model-choice">
        <legend>Answer with</legend>
        <label>
          <input type="radio" name={radios} checked={shown === 'hosted'} onChange={() => pick('hosted')} />
          {HOSTED}
        </label>
        <label>
          <input type="radio" name={radios} checked={shown === 'openrouter'} onChange={() => pick('openrouter')} />
          OpenRouter, with your key
        </label>
      </fieldset>

      {shown === 'openrouter' && (
        <OpenRouterSetup
          saved={openRouter}
          onSave={(next) => onChange({ use: 'openrouter', openRouter: next })}
          onRemove={() => {
            setMode('hosted')
            onChange(HOSTED_ONLY)
          }}
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
  saved?: { key: string; model: OpenRouterModel }
  onSave: (openRouter: { key: string; model: OpenRouterModel }) => void
  onRemove: () => void
}) {
  const [list, setList] = useState<List>({ status: 'loading' })
  const [loads, setLoads] = useState(0)
  const [key, setKey] = useState('')
  const [picked, setPicked] = useState<OpenRouterModel | undefined>(saved?.model)
  const [query, setQuery] = useState('')
  const [check, setCheck] = useState<ModelCheck | 'checking'>()
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

  function choose(model: OpenRouterModel) {
    setPicked(model)
    setCheck(undefined)
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

  const option = (model: OpenRouterModel, note?: string) => (
    <li key={model.id}>
      <label>
        <input type="radio" name={radios} checked={picked?.id === model.id} onChange={() => choose(model)} />
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

  return (
    <div className="openrouter">
      {saved ? (
        <p className="account-detail">
          Your OpenRouter key is saved on this device.{' '}
          <button type="button" className="link" onClick={onRemove}>
            Remove key
          </button>
        </p>
      ) : (
        <>
          <label className="field">
            OpenRouter API key
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <p className="account-detail">
            Kept on this device for this account only, not encrypted, and sent only to OpenRouter.
          </p>
        </>
      )}

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

      <div className="model-actions">
        {!saved && (
          <button
            type="button"
            className="primary"
            disabled={!keyToUse || !picked}
            onClick={() => picked && onSave({ key: keyToUse, model: picked })}
          >
            Use OpenRouter
          </button>
        )}
        <button
          type="button"
          className="link"
          disabled={!keyToUse || !picked || check === 'checking'}
          onClick={async () => {
            if (!picked) return
            setCheck('checking')
            try {
              setCheck(await checkModel({ key: keyToUse, model: picked }))
            } catch (err) {
              setCheck({ status: 'failed', message: err instanceof Error ? err.message : String(err) })
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
    </div>
  )
}

/** A model's name without the vendor OpenRouter puts before it ("Anthropic: Claude Sonnet 5.5"). */
const shortName = ({ name }: OpenRouterModel) => name.replace(/^[^:]+:\s*/, '') || name

/** What a model costs, short: dollars per million tokens in and out. */
function shortPrice({ price }: OpenRouterModel): string {
  if (price.input === 0 && price.output === 0) return 'Free'
  const short = (n: number) => (Number.isInteger(n) ? `$${n}` : dollars(n))
  return `${short(price.input)} / ${short(price.output)}`
}

const dollars = (n: number) => `$${n < 0.1 ? n.toFixed(3).replace(/0$/, '') : n.toFixed(2)}`

/** How much a model takes in at once, in tokens, rounded down: never more than it takes. */
function contextText(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.floor(tokens / 10_000) / 100}M`
  return `${Math.floor(tokens / 1000)}K`
}

/** What a model costs, per million tokens in and out, and how much it takes in at once. */
function priceText({ price, contextLength }: OpenRouterModel): string {
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
