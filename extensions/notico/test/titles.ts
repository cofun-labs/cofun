// The panel's title requests (`CopilotAgent.title`) in the UI tests' model fakes: each fake answers
// them from a model of their own, so they never take a reply scripted for a question.
import { FakeAiBinding } from '../../../worker/test/fakes'

/** A title model that fails until a test scripts it, so a session keeps its first question as its title. */
export function failingTitles(): FakeAiBinding {
  const titles = new FakeAiBinding()
  titles.failWith = new Error('No title scripted')
  return titles
}

/** Which model answers a request: the title request is the panel's only one without tools. */
export function titleRequests(
  service: { ai: FakeAiBinding; titles: FakeAiBinding },
  body: Record<string, unknown>,
): FakeAiBinding {
  return Array.isArray(body.tools) && body.tools.length > 0 ? service.ai : service.titles
}

/** A title request to a user's own model, answered as an OpenAI-compatible service streams it, or refused. */
export async function answerTitle(titles: FakeAiBinding, body: Record<string, unknown>): Promise<Response> {
  try {
    const out = await titles.run(String(body.model), body)
    return new Response(out as ReadableStream, { headers: { 'content-type': 'text/event-stream' } })
  } catch (err) {
    return Response.json({ error: { message: (err as Error).message } }, { status: 500 })
  }
}
