/** Public enterprise identity state reported by an approved enterprise Host plugin. */

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u

export interface EnterpriseIdentitySignedOut {
  readonly status: 'signed-out'
  readonly generation: number
  readonly pendingRevocation: boolean
}

export interface EnterpriseIdentitySignedIn {
  readonly status: 'signed-in'
  readonly companyId: string
  readonly employeeId: string
  readonly generation: number
  readonly pendingRevocation: boolean
}

export type EnterpriseIdentityState = EnterpriseIdentitySignedOut | EnterpriseIdentitySignedIn

export function parseEnterpriseIdentityState(value: unknown): EnterpriseIdentityState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (!isGeneration(candidate.generation) || typeof candidate.pendingRevocation !== 'boolean') return null
  if (candidate.status === 'signed-out') {
    if (!hasExactKeys(candidate, ['generation', 'pendingRevocation', 'status'])) return null
    return { status: 'signed-out', generation: candidate.generation, pendingRevocation: candidate.pendingRevocation }
  }
  if (candidate.status === 'signed-in') {
    if (!hasExactKeys(candidate, ['companyId', 'employeeId', 'generation', 'pendingRevocation', 'status'])) return null
    if (typeof candidate.companyId !== 'string' || !ID_PATTERN.test(candidate.companyId)) return null
    if (typeof candidate.employeeId !== 'string' || !ID_PATTERN.test(candidate.employeeId)) return null
    return {
      status: 'signed-in',
      companyId: candidate.companyId,
      employeeId: candidate.employeeId,
      generation: candidate.generation,
      pendingRevocation: candidate.pendingRevocation,
    }
  }
  return null
}

export function enterpriseIdentityStatesEqual(left: EnterpriseIdentityState, right: EnterpriseIdentityState): boolean {
  if (left.status !== right.status || left.generation !== right.generation
    || left.pendingRevocation !== right.pendingRevocation) return false
  if (left.status === 'signed-out') return true
  return right.status === 'signed-in' && left.companyId === right.companyId && left.employeeId === right.employeeId
}

function isGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => actual.includes(key))
}
