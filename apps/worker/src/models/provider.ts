/**
 * Provider-agnostic seam for LLM calls. Built Monday so that adding the
 * OpenRouter open-weight attacker tier on Thursday is a config change, not a
 * code change (Architecture Sections 12, 17.2, 20).
 */
export interface GenerationRequest {
  system: string
  prompt: string
  maxTokens: number
}

export interface GenerationResult {
  text: string
  refused: boolean
  refusalCategory?: string
  inputTokens: number
  outputTokens: number
  model: string
}

export interface ModelProvider {
  readonly id: string
  readonly vendor: 'anthropic' | 'openrouter'
  generate(request: GenerationRequest): Promise<GenerationResult>
}
