/** What the hosted model says, as the worker streams it: OpenAI's chunks, the cost, then `[DONE]`. */
export function completionStream(reply: { text: string } | { call: string; args: unknown }): string {
  const delta =
    'text' in reply
      ? { role: 'assistant', content: reply.text }
      : {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `call_${reply.call}`,
              type: 'function',
              function: { name: reply.call, arguments: JSON.stringify(reply.args) },
            },
          ],
        }
  const chunks = [
    { id: 'chatcmpl-smoke', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] },
    {
      id: 'chatcmpl-smoke',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'text' in reply ? 'stop' : 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
    { cost: { micro_credits: 1000, estimated: false } },
  ]
  return [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'].join('')
}
