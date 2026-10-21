import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveDesktopApplicationIdentity } from '../src/enterprise-application-identity.ts'

const appData = '/Users/employee/Library/Application Support'
const enterpriseId = 'com.deepseek.harness.enterprise.local'
const enterpriseManifest = { dshDesktopEdition: 'enterprise', dshDesktopAppId: enterpriseId, dshDesktopProductName: 'Ruqinba Harness' }
const bundle = { name: '@dsh-enterprise/harness-bundle' }
const identity = { name: '@dsh-enterprise/harness-identity' }
const enterpriseRuntime = { sharedPackages: [bundle, identity], allowedHostPlugins: [bundle, identity],
  enterpriseServiceOrigin: 'https://enterprise.example.test' }

describe('desktop packaged edition identity', () => {
  it('keeps development and official storage unchanged', () => {
    expect(resolveDesktopApplicationIdentity(false, undefined, undefined, appData)).toEqual({
      edition: 'development', externalScheme: 'dsh', productName: 'DeepSeek Harness',
    })
    expect(resolveDesktopApplicationIdentity(true, { dshDesktopEdition: 'official', dshDesktopAppId: 'com.deepseek.harness' },
      { sharedPackages: [] }, appData)).toEqual({ edition: 'official', externalScheme: 'dsh', productName: 'DeepSeek Harness' })
  })

  it('binds an enterprise package to its own Electron storage and bootstrap home', () => {
    const selected = resolveDesktopApplicationIdentity(true, enterpriseManifest, enterpriseRuntime, appData)
    const userData = join(appData, enterpriseId)
    expect(selected).toEqual({ edition: 'enterprise', externalScheme: 'dsh-enterprise', appId: enterpriseId,
      productName: 'Ruqinba Harness',
      userData, sessionData: join(userData, 'session'),
      bootstrapHome: join(userData, 'enterprise-spaces', 'bootstrap', 'home') })
    expect(Object.isFrozen(selected)).toBe(true)
  })

  it('falls back to the official product name and rejects malformed names', () => {
    const withoutName = { dshDesktopEdition: enterpriseManifest.dshDesktopEdition, dshDesktopAppId: enterpriseManifest.dshDesktopAppId }
    expect(resolveDesktopApplicationIdentity(true, withoutName, enterpriseRuntime, appData))
      .toMatchObject({ productName: 'DeepSeek Harness' })
    expect(() => resolveDesktopApplicationIdentity(true,
      { ...enterpriseManifest, dshDesktopProductName: '' }, enterpriseRuntime, appData)).toThrow(/product name/u)
    expect(() => resolveDesktopApplicationIdentity(true,
      { ...enterpriseManifest, dshDesktopProductName: 'bad\u0000name' }, enterpriseRuntime, appData)).toThrow(/product name/u)
  })

  it.each([
    [undefined, enterpriseRuntime],
    [{ dshDesktopEdition: 'official' }, enterpriseRuntime],
    [enterpriseManifest, { sharedPackages: [bundle, identity], enterpriseServiceOrigin: 'https://enterprise.example.test' }],
    [enterpriseManifest, { sharedPackages: [bundle, identity], allowedHostPlugins: [bundle, identity] }],
    [enterpriseManifest, { sharedPackages: [bundle], allowedHostPlugins: [bundle], enterpriseServiceOrigin: 'https://enterprise.example.test' }],
    [{ ...enterpriseManifest, dshDesktopAppId: 'com.deepseek.harness' }, enterpriseRuntime],
    [{ ...enterpriseManifest, dshDesktopAppId: '../escape' }, enterpriseRuntime],
  ])('rejects mismatched or incomplete packaged identity', (manifest, runtime) => {
    expect(() => resolveDesktopApplicationIdentity(true, manifest, runtime, appData)).toThrow(/desktop edition/u)
  })

  it('rejects enterprise runtime hidden under an official marker', () => {
    expect(() => resolveDesktopApplicationIdentity(true,
      { dshDesktopEdition: 'official', dshDesktopAppId: 'com.deepseek.harness' }, enterpriseRuntime, appData))
      .toThrow(/desktop edition/u)
  })
})
