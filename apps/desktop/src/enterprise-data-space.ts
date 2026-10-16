/** Enterprise desktop data-space path derivation. */

import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u
const BOOTSTRAP_KEY = 'bootstrap'

/** Verified enterprise employee identity used for local data-space selection. */
export interface EnterpriseDataSpaceIdentity {
  readonly companyId: string
  readonly employeeId: string
}

/** Derived local storage roots for one enterprise identity or the bootstrap Host. */
export interface EnterpriseDataSpace {
  readonly identity: EnterpriseDataSpaceIdentity | null
  readonly key: string
  readonly home: string
  readonly paths: {
    readonly profile: string
    readonly lock: string
  }
}

/** Validate and freeze an identity copy so callers cannot mutate a resolved data-space key. */
function normalizeIdentity(identity: EnterpriseDataSpaceIdentity): EnterpriseDataSpaceIdentity {
  if (!ID_PATTERN.test(identity.companyId)) throw new TypeError('Enterprise companyId must be 1..128 base64url characters.')
  if (!ID_PATTERN.test(identity.employeeId)) throw new TypeError('Enterprise employeeId must be 1..128 base64url characters.')
  return Object.freeze({ companyId: identity.companyId, employeeId: identity.employeeId })
}

function keyOf(identity: EnterpriseDataSpaceIdentity | null): string {
  if (identity === null) return BOOTSTRAP_KEY
  return createHash('sha256').update(JSON.stringify([identity.companyId, identity.employeeId])).digest('hex')
}

/** Resolve the bootstrap or employee-owned desktop data space below the Electron userData root. */
export function resolveEnterpriseDataSpace(
  userDataAbsolute: string,
  identity: EnterpriseDataSpaceIdentity | null,
): EnterpriseDataSpace {
  if (typeof userDataAbsolute !== 'string' || !isAbsolute(userDataAbsolute)) {
    throw new TypeError('Enterprise userData root must be an absolute path.')
  }
  const normalized = identity === null ? null : normalizeIdentity(identity)
  const key = keyOf(normalized)
  const home = join(userDataAbsolute, 'enterprise-spaces', key, 'home')
  const profile = join(home, 'profiles', 'desktop')
  return Object.freeze({
    identity: normalized,
    key,
    home,
    paths: Object.freeze({ profile, lock: join(profile, 'lock') }),
  })
}

/** Copy an environment snapshot and bind it to one enterprise desktop data space. */
export function environmentForEnterpriseSpace(
  base: Readonly<NodeJS.ProcessEnv>,
  space: EnterpriseDataSpace,
): Readonly<NodeJS.ProcessEnv> {
  return Object.freeze({
    ...base,
    DSH_HOME: space.home,
    DSH_ENTERPRISE_IDENTITY_SPACE: JSON.stringify(space.identity),
  })
}
