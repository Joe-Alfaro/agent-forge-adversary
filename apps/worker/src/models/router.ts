import type { GenerationRequest, GenerationResult, ModelProvider } from './provider.js'

export type AttackTier = 'variant' | 'strategy'

export interface RouterConfig {
  /** From Thursday, and only when Wednesday's loop is stable. */
  openrouterEnabled: boolean
  /** Categories where Wednesday's refusal metric showed Claude declining. */
  highRefusalCategories: ReadonlySet<string>
}

export interface RouteContext {
  tier: AttackTier
  category: string
}

/**
 * Chooses which provider handles an attack generation call.
 *
 * - Strategy tier always uses the capable Anthropic model.
 * - Variant tier uses the OpenRouter open-weight model only when the feature is
 *   enabled AND the category is one Claude tends to refuse; otherwise Anthropic.
 */
export class ModelRouter {
  private readonly anthropicVariant: ModelProvider
  private readonly anthropicStrategy: ModelProvider
  private readonly openrouterVariant: ModelProvider | undefined
  private readonly config: RouterConfig

  constructor(params: {
    anthropicVariant: ModelProvider
    anthropicStrategy: ModelProvider
    openrouterVariant?: ModelProvider
    config: RouterConfig
  }) {
    this.anthropicVariant = params.anthropicVariant
    this.anthropicStrategy = params.anthropicStrategy
    this.openrouterVariant = params.openrouterVariant
    this.config = params.config
  }

  select(context: RouteContext): ModelProvider {
    if (context.tier === 'strategy') {
      return this.anthropicStrategy
    }
    const useOpenRouter =
      this.config.openrouterEnabled &&
      this.openrouterVariant !== undefined &&
      this.config.highRefusalCategories.has(context.category)
    return useOpenRouter && this.openrouterVariant
      ? this.openrouterVariant
      : this.anthropicVariant
  }

  async generate(context: RouteContext, request: GenerationRequest): Promise<GenerationResult> {
    const provider = this.select(context)
    return provider.generate(request)
  }
}
