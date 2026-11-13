import { useEffect, useId, useRef, useState } from 'react'
import { checkModel, openRouterModels, type ModelCheck } from '../agent'
import { HOSTED_ONLY, RECOMMENDED, type ModelSettings, type OpenRouterModel } from '../models'

/** How many models a search shows at once; a longer query narrows them. */
const SEARCH_LIMIT = 20

type List =
  | { status: 'loading' }
  | { status: 'ready'; models: OpenRouterModel[] }
  | { status: 'failed'; message: string }

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
        {inUse ? inUse.name : 'Notico (hosted)'}
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
          Notico (hosted)
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
  // One request per load, kept here: React may run the effect twice for one load.
  const request = useRef<{ load: number; models: Promise<OpenRouterModel[]> }>(undefined)
  useEffect(() => {
    let live = true
    setList({ status: 'loading' })
    if (request.current?.load !== loads) request.current = { load: loads, models: openRouterModels() }
    request.current.models.then(
      (models) => live && setList({ status: 'ready', models }),
      (err: unknown) =>
        live && setList({ status: 'failed', message: err instanceof Error ? err.message : String(err) }),
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

const dollars = (n: number) => `$${n < 0.1 ? n.toFixed(3).replace(/0$/, '') : n.toFixed(2)}`

/** What a model costs, per million tokens in and out. */
function priceText({ price }: OpenRouterModel): string {
  if (price.input === 0 && price.output === 0) return 'Free'
  return `${dollars(price.input)} in · ${dollars(price.output)} out per million tokens`
}

function checkText(check: ModelCheck | 'checking'): string {
  if (check === 'checking') return 'Checking…'
  if (check.status === 'ok') return 'The model answered and can use tools.'
  if (check.status === 'no_tools')
    return "The model answered but didn't use the tool. Notico needs tools to read and edit pages; pick another model."
  return `The check failed: ${check.message}`
}
