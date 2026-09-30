import { describe, expect, it } from 'vitest'

import { MAX_NIGHTLY_BUDGET_USD, parseNightlyBudget } from '../budget.js'

describe('parseNightlyBudget', () => {
  it('accepts a positive amount and rounds it to cents', () => {
    expect(parseNightlyBudget(30)).toBe(30)
    expect(parseNightlyBudget('42.5')).toBe(42.5)
    expect(parseNightlyBudget(12.345)).toBe(12.35)
  })

  it('accepts the maximum and refuses more', () => {
    expect(parseNightlyBudget(MAX_NIGHTLY_BUDGET_USD)).toBe(MAX_NIGHTLY_BUDGET_USD)
    expect(() => parseNightlyBudget(MAX_NIGHTLY_BUDGET_USD + 0.01)).toThrow(`at most $${MAX_NIGHTLY_BUDGET_USD}`)
  })

  it('refuses zero, negatives, and anything that is not a number', () => {
    expect(() => parseNightlyBudget(0)).toThrow('more than $0')
    expect(() => parseNightlyBudget(-5)).toThrow('more than $0')
    expect(() => parseNightlyBudget(0.004)).toThrow('more than $0')
    expect(() => parseNightlyBudget('abc')).toThrow('must be a number')
    expect(() => parseNightlyBudget('')).toThrow('must be a number')
    expect(() => parseNightlyBudget(Number.NaN)).toThrow('must be a number')
    expect(() => parseNightlyBudget(Number.POSITIVE_INFINITY)).toThrow('must be a number')
    expect(() => parseNightlyBudget(null)).toThrow('must be a number')
  })
})
