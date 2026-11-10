/** Signed enterprise company descriptors carried by an installed desktop release. */

/** One company served by a multi-company enterprise desktop package. */
export interface EnterpriseCompany {
  readonly companyId: string
  readonly displayName: string
  readonly serviceOrigin: string
}

const COMPANY_ID = /^[A-Za-z0-9_-]{1,128}$/u
const DISPLAY_NAME = /^[^\u0000-\u001f\u007f]{1,64}$/u

/** Validate the exact HTTPS origin recorded in enterprise release metadata. */
export function canonicalEnterpriseServiceOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.origin === value && url.hostname.length > 0
      && url.username === '' && url.password === ''
  } catch { return false }
}

/**
 * Validate and freeze the signed company list embedded in the application manifest.
 * @param value - Untrusted manifest value; absent means a legacy single-company package.
 * @returns Frozen company descriptors, or undefined for a legacy package.
 */
export function parseEnterpriseCompanies(value: unknown): readonly EnterpriseCompany[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    throw new Error('desktop companies: require one or two company descriptors')
  }
  const companies = value.map((entry: unknown, index): EnterpriseCompany => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`desktop companies: company ${index} must be an object`)
    }
    const fields = entry as Record<string, unknown>
    if (Object.keys(fields).sort().join(',') !== 'companyId,displayName,serviceOrigin') {
      throw new Error(`desktop companies: company ${index} must contain only companyId, displayName and serviceOrigin`)
    }
    const companyId = fields['companyId']
    const displayName = fields['displayName']
    const serviceOrigin = fields['serviceOrigin']
    if (typeof companyId !== 'string' || !COMPANY_ID.test(companyId)) {
      throw new Error(`desktop companies: company ${index} has an invalid companyId`)
    }
    if (typeof displayName !== 'string' || !DISPLAY_NAME.test(displayName)) {
      throw new Error(`desktop companies: company ${index} has an invalid displayName`)
    }
    if (!canonicalEnterpriseServiceOrigin(serviceOrigin)) {
      throw new Error(`desktop companies: company ${index} has an invalid service origin`)
    }
    return Object.freeze({ companyId, displayName, serviceOrigin })
  })
  if (new Set(companies.map(company => company.companyId)).size !== companies.length) {
    throw new Error('desktop companies: companyId values must be unique')
  }
  if (new Set(companies.map(company => company.serviceOrigin)).size !== companies.length) {
    throw new Error('desktop companies: service origins must be unique')
  }
  return Object.freeze(companies)
}

/**
 * Select one company from a signed registry.
 * @param companies - Signed company descriptors.
 * @param companyId - Persisted active company identifier.
 * @returns The matching company, or undefined when the identifier is unknown.
 */
export function enterpriseCompanyById(
  companies: readonly EnterpriseCompany[], companyId: string | undefined,
): EnterpriseCompany | undefined {
  if (companyId === undefined) return undefined
  return companies.find(company => company.companyId === companyId)
}

/**
 * Build the legacy single-company descriptor for a package with one signed origin.
 * @param origin - Canonical enterprise service origin.
 * @param displayName - Packaged product name shown before the company is known.
 * @returns A synthetic primary company used for migration and origin selection.
 */
export function legacyEnterpriseCompany(origin: string, displayName: string): EnterpriseCompany {
  return Object.freeze({ companyId: 'primary', displayName, serviceOrigin: origin })
}

/**
 * Check that a signed-in identity belongs to the workspace selected in the shell.
 * @param state - Identity state returned by the Host.
 * @param company - Active signed company, when the package carries one.
 * @returns whether the identity may be admitted into this workspace.
 */
export function companyIdentityMatches(
  state: Readonly<{ readonly status: string; readonly companyId?: string }>,
  company: EnterpriseCompany | undefined,
): boolean {
  return state.status !== 'signed-in' || company === undefined || state.companyId === company.companyId
}
