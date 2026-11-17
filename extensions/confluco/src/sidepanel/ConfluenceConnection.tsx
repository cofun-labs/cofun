import { useEffect, useState, type FormEvent } from 'react'
import { connectInstance, disconnectInstance, getInstance, parseInstance, type Instance } from '../confluence/instance'

export function ConfluenceConnection({ userId }: { userId: string }) {
  const [instance, setInstance] = useState<Instance>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let mounted = true
    void getInstance(userId)
      .then((saved) => {
        if (mounted) setInstance(saved)
      })
      .catch(() => {
        if (mounted) setError('Could not load the saved Confluence connection.')
      })
      .finally(() => {
        if (mounted) setLoading(false)
      })
    return () => {
      mounted = false
    }
  }, [userId])

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const next = parseInstance(url)
    if (!next) {
      setError('Enter a self-managed Confluence base URL, including its context path if it has one.')
      return
    }
    setBusy(true)
    setError('')
    try {
      if (await connectInstance(userId, next)) {
        setInstance(next)
        setUrl('')
      } else {
        setError('Chrome site access was declined.')
      }
    } catch {
      setError('Could not save the Confluence connection. Try again.')
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    if (!instance) return
    setBusy(true)
    setError('')
    try {
      const current = await disconnectInstance(userId, instance)
      setInstance(current)
      if (current) setError('The connection changed in another window. Review it before disconnecting.')
    } catch {
      setInstance(await getInstance(userId).catch(() => undefined))
      setError('Could not remove all connection settings. Check site access in Chrome.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="page-section" aria-labelledby="confluence-connection">
      <h2 id="confluence-connection">Confluence connection</h2>
      {loading ? (
        <p>Loading connection…</p>
      ) : instance ? (
        <>
          <p>Connected to {instance.origin + instance.path}</p>
          <button type="button" className="secondary" disabled={busy} onClick={() => void disconnect()}>
            Disconnect
          </button>
        </>
      ) : (
        <form className="confluence-connection" onSubmit={(event) => void connect(event)}>
          <label htmlFor="confluence-base-url">Confluence base URL</label>
          <input
            id="confluence-base-url"
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://wiki.example.com/confluence"
            required
          />
          <p>
            Chrome will ask for site access. Page text and search results the assistant reads are shared with the AI
            model.
          </p>
          <button className="primary" type="submit" disabled={busy}>
            Connect
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
