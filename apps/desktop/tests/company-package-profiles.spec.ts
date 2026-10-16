import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseDesktopPackageInvocation } from '../scripts/package-target.ts'
import { resolveDesktopPackageIdentity } from '../scripts/desktop-release-environment.mjs'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import { resolveDesktopAutoUpdateConfig } from '../scripts/desktop-auto-update-environment.mjs'
import { resolveDesktopApplicationIdentity } from '../src/enterprise-application-identity.ts'
import { KeychainSessionStore } from '../src/keychain-session-store.ts'
import { AppInfo, Packager } from 'app-builder-lib'
import { NsisTarget } from 'app-builder-lib/out/targets/nsis/NsisTarget.js'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const plugins = [{ name: '@dsh-enterprise/harness-bundle' }, { name: '@dsh-enterprise/harness-identity' }]

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'company-package-profiles-'))
  roots.push(root)
  const profiles = ['one', 'two'].map(company => ({ appId: `com.example.company-${company}`,
    productName: `Example Company ${company}`, protocolScheme: `example-company-${company}`,
    serviceOrigin: `https://${company}.example.test` }))
  const files = profiles.map((profile, index) => {
    const path = join(root, `company-${index}.json`)
    writeFileSync(path, JSON.stringify(profile))
    return path
  })
  return { root, profiles, files }
}

function environment(profile: ReturnType<typeof fixture>['profiles'][number]) {
  return { DSH_DESKTOP_ENTERPRISE_MODE: '1', DSH_DESKTOP_UNSIGNED: '1', DSH_DESKTOP_APP_ID: profile.appId,
    DSH_DESKTOP_ENTERPRISE_PRODUCT_NAME: profile.productName, DSH_DESKTOP_ENTERPRISE_PROTOCOL_SCHEME: profile.protocolScheme }
}

describe('company package configuration files', () => {
  it('keeps company updater caches and generated NSIS stores independent', () => {
    const { profiles, root } = fixture()
    const stores = profiles.map(profile => {
      const config = createElectronBuilderConfig(environment(profile), 'darwin', 'arm64')
      const packager = new Packager({ projectDir: root })
      vi.spyOn(packager, 'metadata', 'get').mockReturnValue({ name: '@deepseek-ai/dsh-desktop',
        version: '0.2.1-alpha.2', ...config.extraMetadata })
      vi.spyOn(packager, 'config', 'get').mockReturnValue({ appId: config.appId, productName: config.productName })
      const info = new AppInfo(packager, undefined)
      const defines: Record<string, unknown> = {}
      // Exercise the installed builder's real NSIS define generator without invoking its compiler.
      Reflect.apply(Reflect.get(NsisTarget.prototype, 'configureDefinesForAllTypeOfInstaller'),
        { packager: { appInfo: info }, isWebInstaller: false, options: {} }, [defines])
      expect(info.updaterCacheDirName).toBe(`dsh-enterprise-${profile.appId}-updater`)
      expect(defines.APP_INSTALLER_STORE_FILE).toBe(`${info.updaterCacheDirName}\\installer.exe`)
      return defines.APP_INSTALLER_STORE_FILE
    })
    expect(stores[0]).not.toBe(stores[1])
    expect(createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'com.deepseek.harness', DSH_DESKTOP_UNSIGNED: '1' },
      'darwin', 'arm64').extraMetadata).not.toHaveProperty('name')
    expect(createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'com.deepseek.harness.enterprise.local',
      DSH_DESKTOP_ENTERPRISE_MODE: '1', DSH_DESKTOP_UNSIGNED: '1' }, 'darwin', 'arm64').extraMetadata).not.toHaveProperty('name')
  })

  it('retains distinct app IDs in artifact filenames without dot-to-hyphen collisions', () => {
    const { profiles } = fixture()
    const names = ['com.alpha-beta.harness', 'com.alpha.beta-harness'].map(appId =>
      resolveDesktopPackageIdentity(environment({ ...profiles[0]!, appId })).artifactPrefix)
    expect(names[0]).not.toBe(names[1])
  })

  it('parses two files for both supported enterprise targets and keeps their origins and identities distinct', () => {
    const { profiles, files } = fixture()
    for (const [target, platform, arch] of [['mac-arm64', 'darwin', 'arm64'], ['win-x64', 'win32', 'x64']] as const) {
      const selected = files.map(file => parseDesktopPackageInvocation([target, '--unsigned', '--enterprise-packages',
        'apps/desktop/tests/fixtures/enterprise-package-input', '--enterprise-profile', file], platform, arch))
      selected.forEach((invocation, index) => expect(invocation.enterprise).toMatchObject(profiles[index]!))
    }
  })

  it('registers matching runtime schemes and isolates output, updates, profiles and encrypted sessions', async () => {
    const { profiles, root } = fixture()
    const configs = profiles.map(profile => createElectronBuilderConfig(environment(profile), 'darwin', 'arm64'))
    const identities = configs.map((config, index) => resolveDesktopApplicationIdentity(true, config.extraMetadata,
      { sharedPackages: plugins, allowedHostPlugins: plugins, enterpriseServiceOrigin: profiles[index]!.serviceOrigin }, root))
    configs.forEach((config, index) => {
      expect(config.appId).toBe(profiles[index]!.appId)
      expect(config.productName).toBe(profiles[index]!.productName)
      expect(config.protocols[0]?.schemes).toEqual([identities[index]!.externalScheme])
    })
    expect(configs[0]!.directories.output).not.toBe(configs[1]!.directories.output)
    expect(configs[0]!.artifactName).not.toBe(configs[1]!.artifactName)
    const feeds = profiles.map(profile => resolveDesktopAutoUpdateConfig({ ...environment(profile),
      DSH_DESKTOP_ENTERPRISE_UPDATE_ORIGIN: 'https://updates.example.test',
      DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef' }, 'darwin', 'arm64'))
    expect(feeds[0]!.publicUrl).not.toBe(feeds[1]!.publicUrl)
    expect(feeds[0]!.binaryKeyPrefix).not.toBe(feeds[1]!.binaryKeyPrefix)
    const encryption = { isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (value: string) => Buffer.from(`encrypted:${value}`),
      decryptStringAsync: async (value: Buffer) => ({ result: value.toString().slice(10), shouldReEncrypt: false }) }
    const stores = identities.map(identity => {
      if (identity.edition !== 'enterprise') throw new Error('expected enterprise identity')
      return new KeychainSessionStore(identity.userData, encryption, 'win32')
    })
    await stores[0]!.set('employee-id', 'employee-one')
    expect(await stores[1]!.get('employee-id')).toBeNull()
    await stores[1]!.set('employee-id', 'employee-two')
    expect(await stores[0]!.get('employee-id')).toBe('employee-one')
  })

  it('rejects secret-bearing or invalid profiles and conflicting CLI configuration', () => {
    const { profiles, files } = fixture()
    const args = ['mac-arm64', '--unsigned', '--enterprise-packages', 'apps/desktop/tests/fixtures/enterprise-package-input']
    expect(() => parseDesktopPackageInvocation([...args, '--enterprise-profile', files[0]!,
      '--enterprise-service-origin', profiles[0]!.serviceOrigin], 'darwin', 'arm64')).toThrow(/cannot be combined/u)
    for (const invalid of [{ ...profiles[0], apiKey: 'fake-key' }, { ...profiles[0], serviceOrigin: 'http://localhost' },
      { ...profiles[0], appId: '../escape' }, { ...profiles[0], protocolScheme: 'dsh-enterprise' }]) {
      writeFileSync(files[0]!, JSON.stringify(invalid))
      expect(() => parseDesktopPackageInvocation([...args, '--enterprise-profile', files[0]!], 'darwin', 'arm64')).toThrow()
    }
  })

  it('requires distinct names and schemes for signed and unsigned custom clients', () => {
    const { profiles } = fixture()
    for (const unsigned of ['0', '1']) {
      const env = { ...environment(profiles[0]!), DSH_DESKTOP_UNSIGNED: unsigned }
      expect(() => resolveDesktopPackageIdentity(env)).not.toThrow()
      expect(() => resolveDesktopPackageIdentity({ ...env, DSH_DESKTOP_ENTERPRISE_PRODUCT_NAME: undefined,
        DSH_DESKTOP_ENTERPRISE_PROTOCOL_SCHEME: undefined })).toThrow(/distinct protocol/u)
      expect(() => resolveDesktopPackageIdentity({ ...env,
        DSH_DESKTOP_ENTERPRISE_PRODUCT_NAME: 'DeepSeek Harness Enterprise' })).toThrow(/distinct product name/u)
      expect(() => resolveDesktopPackageIdentity({ ...env,
        DSH_DESKTOP_ENTERPRISE_PRODUCT_NAME: 'deepseek harness enterprise' })).toThrow(/distinct product name/u)
      expect(() => resolveDesktopPackageIdentity({ ...env,
        DSH_DESKTOP_ENTERPRISE_PRODUCT_NAME: 'CON' })).toThrow(/safe display name/u)
    }
    const manifest = { dshDesktopEdition: 'enterprise', dshDesktopAppId: profiles[0]!.appId }
    expect(() => resolveDesktopApplicationIdentity(true, manifest,
      { sharedPackages: plugins, allowedHostPlugins: plugins, enterpriseServiceOrigin: profiles[0]!.serviceOrigin }, '/tmp'))
      .toThrow(/external URL scheme/u)
  })
})
