import { describe, expect, it } from 'vitest'
import {
  canonicalEnterpriseServiceOrigin, companyIdentityMatches, enterpriseCompanyById, legacyEnterpriseCompany, parseEnterpriseCompanies,
} from '../src/enterprise-companies.ts'

const ruqinba = { companyId: 'ruqinba', displayName: '如钦巴', serviceOrigin: 'https://ai-b.ruqinba.com:6062' }
const other = { companyId: 'company-b', displayName: 'B 公司', serviceOrigin: 'https://b.example.test' }

describe('enterprise company registry', () => {
  it('accepts one or two complete descriptors and freezes them', () => {
    const single = parseEnterpriseCompanies([ruqinba])
    expect(single).toEqual([ruqinba])
    expect(Object.isFrozen(single)).toBe(true)
    expect(Object.isFrozen(single?.[0])).toBe(true)
    expect(parseEnterpriseCompanies([ruqinba, other])).toHaveLength(2)
    expect(parseEnterpriseCompanies(undefined)).toBeUndefined()
  })

  it('rejects incomplete, duplicate or unsupported descriptors', () => {
    expect(() => parseEnterpriseCompanies([])).toThrow(/one or two/u)
    expect(() => parseEnterpriseCompanies([ruqinba, other, other])).toThrow(/one or two/u)
    expect(() => parseEnterpriseCompanies([{ ...ruqinba, extra: true }])).toThrow(/only companyId/u)
    expect(() => parseEnterpriseCompanies([{ ...ruqinba, companyId: 'bad id' }])).toThrow(/companyId/u)
    expect(() => parseEnterpriseCompanies([{ ...ruqinba, displayName: '' }])).toThrow(/displayName/u)
    expect(() => parseEnterpriseCompanies([{ ...ruqinba, serviceOrigin: 'http://insecure.test' }])).toThrow(/service origin/u)
    expect(() => parseEnterpriseCompanies([ruqinba, { ...other, companyId: 'ruqinba' }])).toThrow(/unique/u)
    expect(() => parseEnterpriseCompanies([ruqinba, { ...other, serviceOrigin: ruqinba.serviceOrigin }])).toThrow(/unique/u)
  })

  it('validates canonical HTTPS origins and resolves persisted company ids', () => {
    expect(canonicalEnterpriseServiceOrigin('https://example.test')).toBe(true)
    expect(canonicalEnterpriseServiceOrigin('https://example.test/path')).toBe(false)
    expect(canonicalEnterpriseServiceOrigin('http://example.test')).toBe(false)
    expect(enterpriseCompanyById([ruqinba, other], 'company-b')).toEqual(other)
    expect(enterpriseCompanyById([ruqinba], 'missing')).toBeUndefined()
    expect(enterpriseCompanyById([ruqinba], undefined)).toBeUndefined()
  })

  it('builds a legacy primary descriptor for single-company packages', () => {
    expect(legacyEnterpriseCompany('https://legacy.test', 'Legacy Harness')).toEqual({
      companyId: 'primary', displayName: 'Legacy Harness', serviceOrigin: 'https://legacy.test',
    })
  })

  it('admits only identities that belong to the selected company', () => {
    expect(companyIdentityMatches({ status: 'signed-in', companyId: 'ruqinba' }, ruqinba)).toBe(true)
    expect(companyIdentityMatches({ status: 'signed-in', companyId: 'company-b' }, ruqinba)).toBe(false)
    expect(companyIdentityMatches({ status: 'signed-out' }, ruqinba)).toBe(true)
    expect(companyIdentityMatches({ status: 'signed-in', companyId: 'anything' }, undefined)).toBe(true)
  })
})
