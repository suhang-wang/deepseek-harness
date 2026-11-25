import { readInstallerLocales } from '../scripts/installer-locales.mjs'
import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { Arch, Platform } from 'electron-builder'
import { AppInfo, Packager } from 'app-builder-lib'
import { expandMacro } from 'app-builder-lib/out/util/macroExpander.js'
import { describe, expect, it, vi } from 'vitest'

const { execute, write, writeInclude } = vi.hoisted(() => ({
  execute: vi.fn(async () => undefined), write: vi.fn(async () => undefined), writeInclude: vi.fn(),
}))
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(), mkdirSync: vi.fn(), writeFileSync: writeInclude,
}))
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  return { ...original, execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) }
})

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(), writeFile: write,
}))

describe('installer preparation preserves application dependencies', () => {
  it('uses the isolated enterprise target for builder output and runtime inputs', async () => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const base = { DSH_DESKTOP_APP_ID: 'com.example.installer', DSH_DESKTOP_TARGET_PLATFORM: 'darwin',
      DSH_DESKTOP_TARGET_ARCH: 'arm64', DSH_DESKTOP_UNSIGNED: '1' }
    const official = createElectronBuilderConfig(base, 'darwin', 'arm64')
    const enterprise = createElectronBuilderConfig({ ...base, DSH_DESKTOP_APP_ID: 'com.deepseek.harness.enterprise.local', DSH_DESKTOP_ENTERPRISE_MODE: '1' }, 'darwin', 'arm64')
    expect(enterprise.directories.output).toContain('/enterprise/targets/mac-arm64/unsigned-artifacts')
    expect(enterprise).toMatchObject({ appId: 'com.deepseek.harness.enterprise.local', productName: 'DeepSeek Harness Enterprise',
      artifactName: 'deepseek-harness-enterprise-${version}-${os}-${arch}-unsigned.${ext}',
      protocols: [{ name: 'DeepSeek Harness Enterprise', schemes: ['dsh-enterprise'] }],
      extraMetadata: { dshDesktopEdition: 'enterprise', dshDesktopAppId: 'com.deepseek.harness.enterprise.local' } })
    expect(official.extraMetadata.dshDesktopEdition).toBe('official')
    expect(() => createElectronBuilderConfig({ ...base, DSH_DESKTOP_ENTERPRISE_MODE: '1' }, 'darwin', 'arm64')).toThrow(/enterprise app ID/u)
    expect(() => createElectronBuilderConfig({ ...base, DSH_DESKTOP_APP_ID: 'com.deepseek.harness.enterprise.local' }, 'darwin', 'arm64')).toThrow(/provisional enterprise app ID/u)
    expect(enterprise.files.some(entry => typeof entry !== 'string'
      && entry.to === 'dsh' && entry.from.includes('/enterprise/targets/mac-arm64/dsh'))).toBe(true)
    expect(official.directories.output).toContain('/targets/mac-arm64/unsigned-artifacts')
    expect(official.directories.output).not.toContain('/enterprise/')
  })
  it('writes multilingual installer strings alongside the company-specific NSIS wrapper', async () => {
    execute.mockClear()
    write.mockClear()
    writeInclude.mockClear()
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig({
      DSH_DESKTOP_ENTERPRISE_MODE: '1', DSH_DESKTOP_UNSIGNED: '1', DSH_DESKTOP_APP_ID: 'com.example.company',
      DSH_DESKTOP_ENTERPRISE_PRODUCT_NAME: 'Company Harness', DSH_DESKTOP_ENTERPRISE_PROTOCOL_SCHEME: 'company-harness',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
    }, 'win32', 'x64')
    expect(config.productName).toBe('Company Harness')
    expect(config.extraMetadata.name).toBe('dsh-enterprise-com.example.company')
    expect(config.artifactName).toBe('deepseek-harness-enterprise-com.example.company-${version}-${os}-${arch}-unsigned.${ext}')
    expect(config.nsis.include).toMatch(
      /enterprise[\\/]companies[\\/]com\.example\.company[\\/]targets[\\/]win-x64[\\/]installer-include\.nsh$/u,
    )
    expect(writeInclude).toHaveBeenCalledWith(config.nsis.include,
      expect.stringContaining('!define DSH_INSTALLER_NSH_DIR'), 'utf8')
    expect(writeInclude.mock.calls[0]![1]).toContain('!define INSTALLER_BUILD_DIR')
    expect(writeInclude.mock.calls[0]![1]).toContain('!include "')
    await expect(config.beforeBuild()).resolves.toBe(true)
    expect(write).toHaveBeenCalledWith(
      expect.stringMatching(/com\.example\.company[\\/]targets[\\/]win-x64[\\/]installer-ui[\\/]strings\.nsh$/u),
      expect.stringContaining('LangString INSTALLER_INSTALL ${LANG_JAPANESE}'), 'utf8',
    )
    expect(config.nsis.installerLanguages).toEqual(readInstallerLocales().map(locale => locale.id))
    write.mockRejectedValueOnce(new Error('installer locale write failed'))
    await expect(config.beforeBuild()).rejects.toThrow('installer locale write failed')
  })
  it.each(['win32', 'darwin'] as const)('rejects a missing production policy before signing on %s', async (platform) => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    expect(() => createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'com.example.installer',
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://test.example.com',
    }, platform, 'x64')).toThrow('DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN')
  })
  it.each(['win32', 'darwin'] as const)('preserves installer metadata and dependency ownership on %s', async (platform) => {
    execute.mockClear()
    write.mockClear()
    const env = {
      DSH_DESKTOP_APP_ID: 'com.example.installer',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
      DSH_DESKTOP_TARGET_PLATFORM: platform,
      DSH_DESKTOP_TARGET_ARCH: 'x64',
      DSH_DESKTOP_UNSIGNED: platform === 'win32' ? '1' : '0',
      DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
      DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
      APPLE_KEYCHAIN_PROFILE: 'installer-test',
      DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com', DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef',
    }
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    try {
      const { createElectronBuilderConfig } = await import('../electron-builder.config.mjs')
      const config = createElectronBuilderConfig(env, platform, 'x64')
      const metadataPackager = new Packager({ projectDir: tmpdir() })
      const metadata: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
      Object.defineProperties(metadataPackager, {
        config: { value: config },
        metadata: { value: metadata },
      })
      const appInfo = new AppInfo(metadataPackager, undefined)
      expect(appInfo.companyName).toBe('Hangzhou DeepSeek Artificial Intelligence Co., Ltd.')
      expect(appInfo.copyright).toBe(`Copyright © ${new Date().getFullYear()} DeepSeek Harness`)
      if (platform === 'win32') {
        expect(expandMacro(config.nsis.uninstallDisplayName, null, appInfo, {}, false)).toBe('DeepSeek Harness')
        expect(config.nsis.installerLanguages).toEqual(readInstallerLocales().map(locale => locale.id))
      }
      const aboutIcon = config.extraResources.find(resource => resource.to === 'icon.png')
      expect(aboutIcon).toBeDefined()
      expect(readFileSync(aboutIcon!.from)).toEqual(readFileSync(new URL('../resources/icon-windows.png', import.meta.url)))
      // Only the Windows package carries the tray bitmaps; macOS keeps the Dock.
      const trayIcon = config.extraResources.find(resource => resource.to === 'tray.ico')
      if (platform === 'win32') {
        expect(readFileSync(trayIcon!.from)).toEqual(readFileSync(new URL('../resources/tray-windows.ico', import.meta.url)))
      } else {
        expect(trayIcon).toBeUndefined()
      }
      const packager = new Packager({ projectDir: tmpdir() })
      // A foreign source-build target avoids rebuilding modules; the real dependency ownership decision still runs.
      Object.defineProperties(packager, {
        config: { value: { beforeBuild: config.beforeBuild, buildDependenciesFromSource: true } },
        framework: { value: { isNpmRebuildRequired: true, version: '42.0.0' } },
        appInfo: { value: { type: 'module' } },
      })
      vi.spyOn(packager, 'getWorkspaceRoot').mockResolvedValue(tmpdir())
      await packager.installAppDependencies(process.platform === 'win32' ? Platform.LINUX : Platform.WINDOWS, Arch.x64)
      expect(packager.areNodeModulesHandledExternally).toBe(false)
      expect(execute).toHaveBeenCalledTimes(platform === 'win32' ? 1 : 0)
      expect(write).toHaveBeenCalledTimes(platform === 'win32' ? 1 : 0)
      if (platform === 'win32') {
        expect(write).toHaveBeenCalledWith(expect.stringMatching(/installer-ui[\\/]strings\.nsh$/u),
          expect.stringContaining('LangString INSTALLER_INSTALL ${LANG_JAPANESE}'), 'utf8')
      }
    } finally {
      vi.unstubAllEnvs()
      vi.restoreAllMocks()
    }
  })

  it('names unsigned Windows artifacts so they cannot pass for release builds', async () => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig({
      DSH_DESKTOP_APP_ID: 'com.example.installer',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
      DSH_DESKTOP_TARGET_PLATFORM: 'win32',
      DSH_DESKTOP_TARGET_ARCH: 'x64',
      DSH_DESKTOP_UNSIGNED: '1',
    }, 'win32', 'x64')
    expect(config.artifactName).toBe('deepseek-harness-${version}-${os}-${arch}-unsigned.${ext}')
  })

  it('packages every preload entry point the shell loads', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const sourceDirectory = new URL('../src/', import.meta.url)
    const referenced = new Set<string>()
    for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      for (const match of readFileSync(new URL(entry.name, sourceDirectory), 'utf8').matchAll(/preload-[a-z-]+\.cjs/gu)) referenced.add(match[0])
    }
    expect(referenced.size).toBeGreaterThan(0)
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig({
      DSH_DESKTOP_APP_ID: 'com.example.installer',
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://harness-test.deepseek.com',
      DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
      DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
      APPLE_KEYCHAIN_PROFILE: 'installer-test',
    }, 'darwin', 'arm64')
    const packaged = new Set(config.files.filter((entry): entry is string => typeof entry === 'string'))
    for (const name of referenced) expect(packaged.has(`lib/${name}`)).toBe(true)
  })
})
