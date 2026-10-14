import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { environmentForEnterpriseSpace, resolveEnterpriseDataSpace } from '../src/enterprise-data-space.ts'

const userData = resolve('/tmp/dsh-enterprise-user-data')

describe('enterprise data space', () => {
  it('resolves the bootstrap data space under userData', () => {
    const space = resolveEnterpriseDataSpace(userData, null)

    expect(Object.isFrozen(space)).toBe(true)
    expect(Object.isFrozen(space.paths)).toBe(true)
    expect(space.identity).toBeNull()
    expect(space.key).toBe('bootstrap')
    expect(space.home).toBe(join(userData, 'enterprise-spaces', 'bootstrap', 'home'))
    expect(space.paths).toEqual({
      profile: join(userData, 'enterprise-spaces', 'bootstrap', 'home', 'profiles', 'desktop'),
      lock: join(userData, 'enterprise-spaces', 'bootstrap', 'home', 'profiles', 'desktop', 'lock'),
    })
  })

  it('uses a stable sha256 key for each company and employee pair', () => {
    const identity = { companyId: 'company_A-1', employeeId: 'employee_B-2' }
    const expectedKey = createHash('sha256').update(JSON.stringify([identity.companyId, identity.employeeId])).digest('hex')
    const space = resolveEnterpriseDataSpace(userData, identity)

    expect(space.identity).toEqual(identity)
    expect(space.identity).not.toBe(identity)
    expect(Object.isFrozen(space.identity)).toBe(true)
    expect(space.key).toBe(expectedKey)
    expect(space.key).toMatch(/^[0-9a-f]{64}$/u)
    expect(space.home).toBe(join(userData, 'enterprise-spaces', expectedKey, 'home'))
    expect(space.paths.profile).toBe(join(space.home, 'profiles', 'desktop'))
    expect(space.paths.lock).toBe(join(space.paths.profile, 'lock'))
  })

  it('isolates different companies and employees', () => {
    const a = resolveEnterpriseDataSpace(userData, { companyId: 'company', employeeId: 'alice' })
    const sameEmployeeDifferentCompany = resolveEnterpriseDataSpace(userData, { companyId: 'company2', employeeId: 'alice' })
    const sameCompanyDifferentEmployee = resolveEnterpriseDataSpace(userData, { companyId: 'company', employeeId: 'bob' })

    expect(a.key).not.toBe(sameEmployeeDifferentCompany.key)
    expect(a.home).not.toBe(sameEmployeeDifferentCompany.home)
    expect(a.key).not.toBe(sameCompanyDifferentEmployee.key)
    expect(a.home).not.toBe(sameCompanyDifferentEmployee.home)
  })

  it('rejects non-absolute userData and non-base64url identifiers', () => {
    expect(() => resolveEnterpriseDataSpace('relative', null)).toThrow(/absolute/u)
    expect(() => resolveEnterpriseDataSpace(userData, { companyId: '', employeeId: 'employee' })).toThrow(/companyId/u)
    expect(() => resolveEnterpriseDataSpace(userData, { companyId: 'company', employeeId: 'employee=' })).toThrow(/employeeId/u)
    expect(() => resolveEnterpriseDataSpace(userData, { companyId: 'a'.repeat(129), employeeId: 'employee' })).toThrow(/companyId/u)
  })

  it('copies and overrides environment for a space', () => {
    const base = Object.freeze({ PATH: '/bin', DSH_HOME: '/old', DSH_ENTERPRISE_IDENTITY_SPACE: 'old' })
    const identity = { companyId: 'company', employeeId: 'employee' }
    const space = resolveEnterpriseDataSpace(userData, identity)
    const env = environmentForEnterpriseSpace(base, space)

    expect(Object.isFrozen(env)).toBe(true)
    expect(env).toEqual({
      PATH: '/bin',
      DSH_HOME: space.home,
      DSH_ENTERPRISE_IDENTITY_SPACE: JSON.stringify(identity),
    })
    expect(base.DSH_HOME).toBe('/old')

    const bootstrap = environmentForEnterpriseSpace({}, resolveEnterpriseDataSpace(userData, null))
    expect(bootstrap.DSH_ENTERPRISE_IDENTITY_SPACE).toBe('null')
  })
})
