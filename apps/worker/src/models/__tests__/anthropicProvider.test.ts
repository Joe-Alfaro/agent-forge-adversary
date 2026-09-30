import { describe, expect, it } from 'vitest'

import { AnthropicProvider, type MessagesClient } from '../anthropicProvider.js'

function fakeClient(response: unknown) {
  const calls: unknown[] = []
  const client: MessagesClient = {
    messages: {
      async create(body: unknown) {
        calls.push(body)
        return response as never
      },
    },
  }
  return { client, calls }
}

describe('AnthropicProvider', () => {
  it('sends system + prompt and returns the text with token usage', async () => {
    const { client, calls } = fakeClient({
      content: [{ type: 'text', text: '[["a"]]' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 120, output_tokens: 30 },
    })
    const provider = new AnthropicProvider({ client, model: 'claude-haiku-4-5-20251001' })
    const result = await provider.generate({ system: 'sys', prompt: 'hi', maxTokens: 256 })
    expect(calls[0]).toEqual({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(result).toEqual({ text: '[["a"]]', refused: false, inputTokens: 120, outputTokens: 30, model: 'claude-haiku-4-5-20251001' })
    expect(provider.vendor).toBe('anthropic')
    expect(provider.id).toBe('claude-haiku-4-5-20251001')
  })

  it('reports a refusal stop reason as refused', async () => {
    const { client } = fakeClient({ content: [], stop_reason: 'refusal', usage: { input_tokens: 10, output_tokens: 0 } })
    const result = await new AnthropicProvider({ client, model: 'claude-sonnet-5-5' }).generate({ system: 's', prompt: 'p', maxTokens: 10 })
    expect(result.refused).toBe(true)
    expect(result.text).toBe('')
  })
})
