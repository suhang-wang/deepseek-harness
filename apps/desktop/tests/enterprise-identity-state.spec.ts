import { describe, expect, it } from 'vitest'
import { enterpriseIdentityStatesEqual, parseEnterpriseIdentityState, type EnterpriseIdentityState } from '../src/enterprise-identity-state.ts'

const signedOut = Object.freeze({ status: 'signed-out' as const, generation: 0, pendingRevocation: false })
const signedIn = Object.freeze({
  status: 'signed-in' as const,
  companyId: 'company-1',
  employeeId: 'employee-1',
  generation: 1,
  pendingRevocation: true,
})

describe('enterprise identity state parser', () => {
  it('accepts signed-out and signed-in public identity states', () => {
    expect(parseEnterpriseIdentityState(signedOut)).toEqual(signedOut)
    expect(parseEnterpriseIdentityState(signedIn)).toEqual(signedIn)
  })

  it.each([
    null,
    'signed-out',
    ['signed-out'],
    { status: 'signed-out', generation: -1, pendingRevocation: false },
    { status: 'signed-out', generation: Number.MAX_SAFE_INTEGER + 1, pendingRevocation: false },
    { status: 'signed-out', generation: 0.5, pendingRevocation: false },
    { status: 'signed-out', generation: 0, pendingRevocation: 'false' },
    { status: 'signed-out', pendingRevocation: false },
    { status: 'unknown', generation: 0, pendingRevocation: false },
    { status: 'signed-out', generation: 0, pendingRevocation: false, refreshToken: 'A'.repeat(43) },
    { status: 'signed-out', generation: 0, pending: false },
    { status: 'signed-in', companyId: 'company-1', employeeId: 'employee-1', generation: 0, pendingRevocation: false, logoutCapability: 'B'.repeat(43) },
    { status: 'signed-in', companyId: 'company-1', employee: 'employee-1', generation: 0, pendingRevocation: false },
    { status: 'signed-in', companyId: 7, employeeId: 'employee-1', generation: 0, pendingRevocation: false },
    { status: 'signed-in', companyId: 'bad company', employeeId: 'employee-1', generation: 0, pendingRevocation: false },
    { status: 'signed-in', companyId: 'company-1', employeeId: 7, generation: 0, pendingRevocation: false },
    { status: 'signed-in', companyId: 'company-1', employeeId: 'bad employee', generation: 0, pendingRevocation: false },
  ])('rejects malformed or secret-bearing state %#', (state) => {
    expect(parseEnterpriseIdentityState(state)).toBeNull()
  })
})

describe('enterprise identity state equality', () => {
  it('compares signed-out states by public fields', () => {
    expect(enterpriseIdentityStatesEqual(
      { status: 'signed-out', generation: 1, pendingRevocation: true },
      { status: 'signed-out', generation: 1, pendingRevocation: true },
    )).toBe(true)
    expect(enterpriseIdentityStatesEqual(
      { status: 'signed-out', generation: 1, pendingRevocation: true },
      { status: 'signed-out', generation: 2, pendingRevocation: true },
    )).toBe(false)
    expect(enterpriseIdentityStatesEqual(
      { status: 'signed-out', generation: 1, pendingRevocation: true },
      { status: 'signed-out', generation: 1, pendingRevocation: false },
    )).toBe(false)
  })

  it('compares signed-in states by company, employee and public fields', () => {
    expect(enterpriseIdentityStatesEqual(
      { status: 'signed-in', companyId: 'company-1', employeeId: 'employee-1', generation: 1, pendingRevocation: false },
      { status: 'signed-in', companyId: 'company-1', employeeId: 'employee-1', generation: 1, pendingRevocation: false },
    )).toBe(true)
    expect(enterpriseIdentityStatesEqual(
      { status: 'signed-in', companyId: 'company-1', employeeId: 'employee-1', generation: 1, pendingRevocation: false },
      { status: 'signed-in', companyId: 'company-2', employeeId: 'employee-1', generation: 1, pendingRevocation: false },
    )).toBe(false)
    expect(enterpriseIdentityStatesEqual(
      { status: 'signed-in', companyId: 'company-1', employeeId: 'employee-1', generation: 1, pendingRevocation: false },
      { status: 'signed-in', companyId: 'company-1', employeeId: 'employee-2', generation: 1, pendingRevocation: false },
    )).toBe(false)
  })

  it('rejects different state variants before comparing variant-specific fields', () => {
    expect(enterpriseIdentityStatesEqual(
      { status: 'signed-out', generation: 1, pendingRevocation: false },
      { status: 'signed-in', companyId: 'company-1', employeeId: 'employee-1', generation: 1, pendingRevocation: false },
    )).toBe(false)
  })

  it('fails closed if a state shape changes between status checks', () => {
    let reads = 0
    const unstableRight = {
      get status() { reads += 1; return reads === 1 ? 'signed-in' : 'signed-out' },
      companyId: 'company-1',
      employeeId: 'employee-1',
      generation: 1,
      pendingRevocation: false,
    } as EnterpriseIdentityState

    expect(enterpriseIdentityStatesEqual(
      { status: 'signed-in', companyId: 'company-1', employeeId: 'employee-1', generation: 1, pendingRevocation: false },
      unstableRight,
    )).toBe(false)
  })
})
