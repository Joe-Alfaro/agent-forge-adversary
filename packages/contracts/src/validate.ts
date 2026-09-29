import { Ajv2020 as Ajv, type ValidateFunction } from 'ajv/dist/2020.js'
import addFormatsModule from 'ajv-formats'
import { createRequire } from 'node:module'

import type {
  Verdict,
  RerunRequest,
  AttackTranscript,
  DetectorResult,
  CampaignPlan,
  NightlyRunSummary,
} from './types.js'
import { isTaxonomyCell, type TaxonomyCell } from './taxonomy.js'

const require = createRequire(import.meta.url)

const verdictSchema = require('../../../contracts/verdict/v1.json')
const rerunRequestSchema = require('../../../contracts/rerun_request/v1.json')
const attackTranscriptSchema = require('../../../contracts/attack_transcript/v1.json')
const detectorResultSchema = require('../../../contracts/detector_result/v1.json')
const campaignPlanSchema = require('../../../contracts/campaign_plan/v1.json')
const nightlyRunSummarySchema = require('../../../contracts/nightly_run_summary/v1.json')

// ajv-formats ships its callable as a CommonJS default; resolve it for NodeNext.
type AddFormats = (ajv: Ajv) => Ajv
const mod = addFormatsModule as unknown as AddFormats & { default?: AddFormats }
const addFormats: AddFormats = mod.default ?? mod

const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)

export interface ValidationResult<T> {
  valid: boolean
  value?: T
  errors: string[]
}

function runValidator<T>(validator: ValidateFunction, value: unknown): ValidationResult<T> {
  const valid = validator(value)
  if (valid) {
    return { valid: true, value: value as T, errors: [] }
  }
  const errors = (validator.errors ?? []).map(
    (error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
  )
  return { valid: false, errors }
}

const validateVerdictFn = ajv.compile(verdictSchema)
const validateRerunRequestFn = ajv.compile(rerunRequestSchema)
const validateAttackTranscriptFn = ajv.compile(attackTranscriptSchema)
const validateDetectorResultFn = ajv.compile(detectorResultSchema)
const validateCampaignPlanFn = ajv.compile(campaignPlanSchema)
const validateNightlyRunSummaryFn = ajv.compile(nightlyRunSummarySchema)

export function validateVerdict(value: unknown): ValidationResult<Verdict> {
  return runValidator<Verdict>(validateVerdictFn, value)
}

export function validateRerunRequest(value: unknown): ValidationResult<RerunRequest> {
  return runValidator<RerunRequest>(validateRerunRequestFn, value)
}

export function validateAttackTranscript(value: unknown): ValidationResult<AttackTranscript> {
  return runValidator<AttackTranscript>(validateAttackTranscriptFn, value)
}

export function validateDetectorResult(value: unknown): ValidationResult<DetectorResult> {
  return runValidator<DetectorResult>(validateDetectorResultFn, value)
}

export function validateCampaignPlan(value: unknown): ValidationResult<CampaignPlan> {
  return runValidator<CampaignPlan>(validateCampaignPlanFn, value)
}

export function validateNightlyRunSummary(value: unknown): ValidationResult<NightlyRunSummary> {
  return runValidator<NightlyRunSummary>(validateNightlyRunSummaryFn, value)
}

/**
 * Validates that a `{ category, subcategory }` pair is a real cell in the shared
 * AttackTaxonomy v1. Not Ajv-compiled because the subcategory's validity depends
 * on the category, which a flat schema cannot express cleanly.
 */
export function validateTaxonomyCell(value: unknown): ValidationResult<TaxonomyCell> {
  if (typeof value !== 'object' || value === null) {
    return { valid: false, errors: ['/ must be an object with category and subcategory'] }
  }
  const record = value as Record<string, unknown>
  const category = record['category']
  const subcategory = record['subcategory']
  if (typeof category !== 'string' || typeof subcategory !== 'string') {
    return { valid: false, errors: ['category and subcategory must be strings'] }
  }
  if (!isTaxonomyCell(category, subcategory)) {
    return { valid: false, errors: [`${category}/${subcategory} is not a cell in AttackTaxonomy v1`] }
  }
  return { valid: true, value: { category, subcategory } as TaxonomyCell, errors: [] }
}
