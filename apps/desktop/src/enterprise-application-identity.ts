/** Fail-closed packaged edition selection before Electron opens persistent storage. */

import { join } from 'node:path'
import { isAbsolute } from 'node:path'
import { resolveEnterpriseDataSpace } from './enterprise-data-space.ts'
import { canonicalEnterpriseServiceOrigin } from './runtime-tree.ts'

const BUNDLE = '@dsh-enterprise/harness-bundle'
const IDENTITY = '@dsh-enterprise/harness-identity'
const APP_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){2,}$/u
const EXTERNAL_SCHEME = /^[a-z][a-z0-9-]{2,63}$/u
const PRODUCT_NAME = /^[^\u0000-\u001f\u007f]{1,64}$/u
const PERSONAL_IDS = new Set(['com.deepseek.harness', 'com.deepseek.dsh'])

interface RuntimeIdentity {
  readonly sharedPackages?: readonly { readonly name: string }[]
  readonly allowedHostPlugins?: readonly { readonly name: string }[]
  readonly enterpriseServiceOrigin?: string
}

interface DevelopmentIdentity {
  readonly edition: 'development'
  readonly externalScheme: 'dsh'
  readonly productName: 'DeepSeek Harness'
}

interface OfficialIdentity {
  readonly edition: 'official'
  readonly externalScheme: 'dsh'
  readonly productName: 'DeepSeek Harness'
}

interface EnterpriseIdentity {
  readonly edition: 'enterprise'
  readonly externalScheme: string
  readonly appId: string
  readonly productName: string
  readonly userData: string
  readonly sessionData: string
  readonly bootstrapHome: string
}

/** Immutable release identity used by the shell before creating logs, locks or sessions. */
export type DesktopApplicationIdentity = DevelopmentIdentity | OfficialIdentity | EnterpriseIdentity

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Match all enterprise runtime signals so a partial release cannot open the personal profile. */
function enterpriseSignals(runtime: RuntimeIdentity): boolean {
  return (runtime.sharedPackages ?? []).some(packageRecord => packageRecord.name.startsWith('@dsh-enterprise/'))
    || runtime.allowedHostPlugins !== undefined || runtime.enterpriseServiceOrigin !== undefined
}

/**
 * Resolve signed packaged metadata and runtime policy to an isolated Desktop identity.
 * The caller must read the packaged ASAR manifest and runtime descriptor synchronously.
 */
export function resolveDesktopApplicationIdentity(
  packaged: boolean, manifest: unknown, runtime: RuntimeIdentity | undefined, appData: string,
): DesktopApplicationIdentity {
  if (!packaged) return Object.freeze({ edition: 'development', externalScheme: 'dsh', productName: 'DeepSeek Harness' })
  if (!record(manifest) || (manifest.dshDesktopEdition !== 'official' && manifest.dshDesktopEdition !== 'enterprise')
    || runtime === undefined) throw new Error('desktop edition: missing packaged edition or runtime metadata')

  if (manifest.dshDesktopEdition === 'official') {
    if (enterpriseSignals(runtime)) throw new Error('desktop edition: official marker conflicts with enterprise runtime')
    return Object.freeze({ edition: 'official', externalScheme: 'dsh', productName: 'DeepSeek Harness' })
  }

  const appId = manifest.dshDesktopAppId
  if (typeof appId !== 'string' || !APP_ID.test(appId) || PERSONAL_IDS.has(appId)) {
    throw new Error('desktop edition: enterprise package requires an independent reverse-DNS app ID')
  }
  const externalScheme = manifest.dshDesktopExternalScheme
    ?? (appId === 'com.deepseek.harness.enterprise.local' ? 'dsh-enterprise' : undefined)
  if (typeof externalScheme !== 'string' || !EXTERNAL_SCHEME.test(externalScheme)
    || ['dsh', 'dsh-app', 'http', 'https', 'file', 'mailto'].includes(externalScheme)
    || (appId !== 'com.deepseek.harness.enterprise.local' && externalScheme === 'dsh-enterprise')) {
    throw new Error('desktop edition: enterprise package requires a distinct external URL scheme')
  }
  const shared = new Set(runtime.sharedPackages?.map(packageRecord => packageRecord.name))
  const allowed = new Set(runtime.allowedHostPlugins?.map(packageRecord => packageRecord.name))
  if (!shared.has(BUNDLE) || !shared.has(IDENTITY) || !allowed.has(BUNDLE) || !allowed.has(IDENTITY)
    || !canonicalEnterpriseServiceOrigin(runtime.enterpriseServiceOrigin)) {
    throw new Error('desktop edition: incomplete enterprise bundle, identity or service origin')
  }
  if (!isAbsolute(appData)) throw new Error('desktop edition: Electron appData path must be absolute')
  const rawProductName: unknown = manifest.dshDesktopProductName
  const productName = rawProductName === undefined ? 'DeepSeek Harness' : rawProductName
  if (typeof productName !== 'string' || !PRODUCT_NAME.test(productName)) {
    throw new Error('desktop edition: enterprise package requires a valid product name')
  }
  const userData = join(appData, appId)
  return Object.freeze({
    edition: 'enterprise', externalScheme, appId, productName, userData,
    sessionData: join(userData, 'session'),
    bootstrapHome: resolveEnterpriseDataSpace(userData, null).home,
  })
}
