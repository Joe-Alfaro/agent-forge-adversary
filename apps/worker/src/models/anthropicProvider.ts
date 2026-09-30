import type { GenerationRequest, GenerationResult, ModelProvider } from './provider.js'

/** The slice of the Anthropic SDK client this provider uses (so tests can fake it). */
export interface MessagesClient {
  messages: {
    create(body: {
      model: string
      max_tokens: number
      system: string
      messages: { role: 'user'; content: string }[]
    }): Promise<{
      content: { type: string; text?: string }[]
      stop_reason: string | null
      usage?: { input_tokens?: number; output_tokens?: number }
    }>
  }
}

/**
 * The Anthropic-backed attack-generation provider for the model router: Haiku
 * for the variant tier, Sonnet for the strategy tier (ARCHITECTURE 4.2, 12). A
 * `refusal` stop reason is reported as `refused`, so the variant generator
 * degrades to deterministic mutation instead of paying for a declined call.
 */
export class AnthropicProvider implements ModelProvider {
  readonly id: string
  readonly vendor = 'anthropic' as const
  private readonly client: MessagesClient

  constructor(options: { client: MessagesClient; model: string }) {
    this.client = options.client
    this.id = options.model
  }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const response = await this.client.messages.create({
      model: this.id,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: [{ role: 'user', content: request.prompt }],
    })
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
    return {
      text,
      refused: response.stop_reason === 'refusal',
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      model: this.id,
    }
  }
}
