import type { ComparisonResult, ModelRun } from './compare.js'

/**
 * Renders a comparison as Markdown for `evals/results/` and the Friday cost
 * analysis: one row per model (agreement, M1 false-positive rate, error counts,
 * cost), per-category agreement with set sizes (KEY_METRICS M2 asks for the size
 * next to the percentage), and the cases the models judged differently.
 */
export function renderComparisonMarkdown(result: ComparisonResult, options: { mode?: string } = {}): string {
  const header = [
    `# Judge model comparison — ${result.set_version}`,
    '',
    `Generated ${result.generated_at}${options.mode === undefined ? '' : ` · mode: **${options.mode}**`} · ${result.case_count} ground-truth cases · stage 1 (detectors) and the frozen rubric held constant; only the stage-2 model varies.`,
    '',
    `Spend: $${result.total_cost_usd.toFixed(4)}${result.spend_cap_usd === null ? '' : ` of a $${result.spend_cap_usd.toFixed(2)} cap`}${result.capped ? ' — **cap reached, some cases skipped**' : ''}.`,
    '',
  ]

  const table = [
    '| Model | Agreement | Clean-control FP rate (M1) | False positives | False negatives | needs_review | Stage-2 calls | Cost / stage-2 verdict | Total cost | Skipped |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...result.models.map(modelRow),
    '',
  ]

  const categories = [...new Set(result.models.flatMap((m) => Object.keys(m.metrics.by_category)))].sort()
  const byCategory = [
    '## Agreement by category (M2)',
    '',
    `| Category | ${result.models.map((m) => m.model).join(' | ')} |`,
    `|---|${result.models.map(() => '---').join('|')}|`,
    ...categories.map((cat) => {
      const cells = result.models.map((m) => {
        const entry = m.metrics.by_category[cat]
        return entry === undefined ? '—' : fraction(entry.agree, entry.total)
      })
      return `| ${cat} | ${cells.join(' | ')} |`
    }),
    '',
  ]

  const disagreements = [
    '## Disagreements between models',
    '',
    ...(result.disagreements.length === 0
      ? ['None — every model returned the same outcome on every judged case.']
      : [
          `| Case | Kind | Category | Ground truth | ${result.models.map((m) => m.model).join(' | ')} |`,
          `|---|---|---|---|${result.models.map(() => '---').join('|')}|`,
          ...result.disagreements.map(
            (d) =>
              `| \`${d.id}\` | ${d.kind} | ${d.category} | ${d.label} | ${result.models.map((m) => d.outcomes[m.model] ?? 'skipped').join(' | ')} |`,
          ),
        ]),
    '',
  ]

  const misses = [
    '## Errors against ground truth',
    '',
    ...result.models.map((m) => {
      const wrong = m.cases.filter((c) => c.correct === false)
      const list = wrong.map((c) => `\`${c.id}\` (${c.label} → ${c.outcome ?? '?'})`).join(', ')
      return `- **${m.model}**: ${wrong.length === 0 ? 'none' : list}`
    }),
    '',
  ]

  const skippedRows = result.models.flatMap((m) =>
    m.cases
      .filter((c) => c.skipped === true)
      .map((c) => `| ${m.model} | \`${c.id}\` | ${(c.error ?? 'unknown').replace(/\|/g, '/').slice(0, 160)} |`),
  )
  const skipped =
    skippedRows.length === 0
      ? []
      : [
          '## Skipped cases',
          '',
          'Excluded from every metric above (not counted as wrong).',
          '',
          '| Model | Case | Reason |',
          '|---|---|---|',
          ...skippedRows,
          '',
        ]

  return [...header, ...table, ...byCategory, ...disagreements, ...misses, ...skipped].join('\n')
}

function modelRow(run: ModelRun): string {
  const m = run.metrics
  const cells = [
    run.model,
    m.agreement === null ? '—' : fraction(m.agree, m.total),
    m.control_fp_rate === null ? '—' : `${pct(m.control_fp_rate)} (${m.control_false_positives}/${m.control_total})`,
    String(m.false_positives),
    String(m.false_negatives),
    String(m.needs_review),
    String(m.llm_calls),
    m.cost_per_llm_verdict_usd === null ? '—' : `$${m.cost_per_llm_verdict_usd.toFixed(5)}`,
    `$${m.total_cost_usd.toFixed(4)}`,
    String(m.skipped),
  ]
  return `| ${cells.join(' | ')} |`
}

function fraction(numerator: number, denominator: number): string {
  return `${pct(denominator === 0 ? 0 : numerator / denominator)} (${numerator}/${denominator})`
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}
