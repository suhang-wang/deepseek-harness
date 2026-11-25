import { describe, expect, it } from 'vitest'
import {
  desktopBuildRecordFilename,
  desktopWebsiteInstallerUrl,
  desktopUpdateMetadataFilename,
  resolveDesktopAutoUpdateConfig,
  resolveDesktopAutoUpdateEnvironment,
  resolveDesktopAutoUpdateTarget,
  resolveDesktopUploadConfig,
} from '@deepseek-ai/dsh-desktop-publisher/desktop-auto-update-environment.mjs'

const RELEASE_ID = '0123456789abcdef0123456789abcdef'

describe('desktop auto-update environment', () => {
  it('requires an explicit enterprise feed and keeps enterprise paths separate from official updates', () => {
    const enterprise = { DSH_DESKTOP_ENTERPRISE_MODE: '1', DOWNLOAD_TEST_RELEASE_ID: RELEASE_ID,
      DOWNLOAD_TEST_ORIGIN: 'https://official.example.com' }
    expect(() => resolveDesktopAutoUpdateConfig(enterprise, 'darwin', 'arm64'))
      .toThrow(/DSH_DESKTOP_ENTERPRISE_UPDATE_ORIGIN/u)
    expect(resolveDesktopAutoUpdateConfig({ ...enterprise,
      DSH_DESKTOP_ENTERPRISE_UPDATE_ORIGIN: 'https://enterprise.example.com' }, 'darwin', 'arm64')).toMatchObject({
      publicUrl: `https://enterprise.example.com/dsh-enterprise/${RELEASE_ID}/feeds/mac-arm64/`,
      keyPrefix: `dsh-enterprise/${RELEASE_ID}/feeds/mac-arm64`,
      binaryKeyPrefix: `dsh-enterprise/${RELEASE_ID}/bin/mac-arm64`,
    })
    expect(() => resolveDesktopAutoUpdateConfig({ ...enterprise, DSH_DESKTOP_AUTO_UPDATE_ENV: 'production' }, 'darwin', 'arm64'))
      .toThrow(/DSH_DESKTOP_ENTERPRISE_UPDATE_ORIGIN/u)
    expect(() => resolveDesktopAutoUpdateConfig({ ...enterprise,
      DSH_DESKTOP_ENTERPRISE_UPDATE_ORIGIN: 'https://download.deepseek.com' }, 'darwin', 'arm64'))
      .toThrow(/official DeepSeek download host/u)
    expect(() => resolveDesktopAutoUpdateConfig({ ...enterprise,
      DSH_DESKTOP_ENTERPRISE_UPDATE_ORIGIN: 'http://enterprise.example.com' }, 'darwin', 'arm64'))
      .toThrow(/HTTPS origin/u)
    expect(() => resolveDesktopUploadConfig({ ...enterprise,
      DSH_DESKTOP_ENTERPRISE_UPDATE_ORIGIN: 'https://enterprise.example.com',
      DOWNLOAD_TEST_COS_BUCKET: 'official-bucket' }, 'darwin', 'arm64'))
      .toThrow(/enterprise upload requires/u)
  })
  it('keeps custom enterprise app IDs on separate feeds from legacy and official packages', () => {
    const base = { DSH_DESKTOP_ENTERPRISE_MODE: '1',
      DSH_DESKTOP_ENTERPRISE_UPDATE_ORIGIN: 'https://enterprise.example.com', DOWNLOAD_TEST_RELEASE_ID: RELEASE_ID }
    const multi = resolveDesktopAutoUpdateConfig({ ...base, DSH_DESKTOP_APP_ID: 'com.ruqinba.multi' }, 'darwin', 'arm64')
    const single = resolveDesktopAutoUpdateConfig({ ...base, DSH_DESKTOP_APP_ID: 'com.ruqinba.single' }, 'darwin', 'arm64')
    const legacy = resolveDesktopAutoUpdateConfig({ ...base,
      DSH_DESKTOP_APP_ID: 'com.deepseek.harness.enterprise.local' }, 'darwin', 'arm64')
    const official = resolveDesktopAutoUpdateConfig({ DOWNLOAD_TEST_RELEASE_ID: RELEASE_ID,
      DOWNLOAD_TEST_ORIGIN: 'https://updates.example.com' }, 'darwin', 'arm64')
    expect(multi.keyPrefix).toBe(`dsh-enterprise/com.ruqinba.multi/${RELEASE_ID}/feeds/mac-arm64`)
    expect(multi.keyPrefix).not.toBe(single.keyPrefix)
    expect(legacy.keyPrefix).toBe(`dsh-enterprise/${RELEASE_ID}/feeds/mac-arm64`)
    expect(official.keyPrefix).toBe(`dsh-desk/${RELEASE_ID}/feeds/mac-arm64`)
  })

  it.each(['', ' ', '\t\n'])('rejects blank enterprise app ID %j', (appId) => {
    expect(() => resolveDesktopAutoUpdateConfig({
      DSH_DESKTOP_ENTERPRISE_MODE: '1',
      DSH_DESKTOP_ENTERPRISE_UPDATE_ORIGIN: 'https://enterprise.example.com',
      DSH_DESKTOP_APP_ID: appId,
      DOWNLOAD_TEST_RELEASE_ID: RELEASE_ID,
    }, 'darwin', 'arm64')).toThrow(/DSH_DESKTOP_APP_ID must be set to a non-empty value/u)
  })

  it.each([
    'enterprise', '.com.example', 'com.example.', 'com..example', 'com.example_app', 'com.example app',
    '../dsh-desk', 'com.example/../../dsh-desk', 'com.example\\..\\dsh-desk',
    'com.example%2f..%2fdsh-desk', 'com.example?channel=stable', 'com.example#fragment',
    'com.example\napp', 'com.example\0app',
  ])('rejects unsafe or invalid enterprise app ID %j in every deployment', (appId) => {
    for (const deployment of ['test', 'production']) {
      expect(() => resolveDesktopAutoUpdateConfig({
        DSH_DESKTOP_ENTERPRISE_MODE: '1',
        DSH_DESKTOP_ENTERPRISE_UPDATE_ORIGIN: 'https://enterprise.example.com',
        DSH_DESKTOP_AUTO_UPDATE_ENV: deployment,
        DSH_DESKTOP_APP_ID: appId,
        DOWNLOAD_TEST_RELEASE_ID: RELEASE_ID,
      }, 'darwin', 'arm64')).toThrow(/DSH_DESKTOP_APP_ID must be a reverse-DNS identifier/u)
    }
  })

  it.each(['test', 'production'])('trims valid enterprise app IDs for %s feeds and binaries', (deployment) => {
    const prefix = `dsh-enterprise/com.Example.app-1${deployment === 'test' ? `/${RELEASE_ID}` : ''}`
    expect(resolveDesktopAutoUpdateConfig({
      DSH_DESKTOP_ENTERPRISE_MODE: '1',
      DSH_DESKTOP_ENTERPRISE_UPDATE_ORIGIN: 'https://enterprise.example.com',
      DSH_DESKTOP_AUTO_UPDATE_ENV: deployment,
      DSH_DESKTOP_UPDATE_CHANNEL: 'stable',
      DSH_DESKTOP_APP_ID: ' com.Example.app-1 ',
      DOWNLOAD_TEST_RELEASE_ID: RELEASE_ID,
    }, 'win32', 'x64')).toMatchObject({
      publicUrl: `https://enterprise.example.com/${prefix}/feeds/win-x64/`,
      keyPrefix: `${prefix}/feeds/win-x64`,
      binaryKeyPrefix: `${prefix}/bin/win-x64/stable`,
    })
  })

  it('ignores enterprise app IDs outside enterprise mode', () => {
    expect(resolveDesktopAutoUpdateConfig({
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
      DSH_DESKTOP_APP_ID: '../dsh-enterprise',
    }, 'win32', 'x64').publicUrl).toBe('https://download.deepseek.com/dsh-desk/feeds/win-x64/')
  })

  it.each([undefined, 'test'])('requires a release ID for deployment %s', (deployment) => {
    const environment = { DSH_DESKTOP_AUTO_UPDATE_ENV: deployment, DOWNLOAD_TEST_ORIGIN: 'https://updates.example.com',
      DOWNLOAD_TEST_COS_BUCKET: 'test-bucket' }
    expect(() => resolveDesktopAutoUpdateConfig(environment, 'win32', 'x64')).toThrow(/DOWNLOAD_TEST_RELEASE_ID/u)
    expect(() => resolveDesktopUploadConfig(environment, 'win32', 'x64')).toThrow(/DOWNLOAD_TEST_RELEASE_ID/u)
  })

  it.each(['', ' ', 'release-1', 'a'.repeat(31), 'a'.repeat(33), 'A'.repeat(32), 'g'.repeat(32),
    '../feeds', '01234567-89ab-cdef-0123-456789abcdef', `${RELEASE_ID}/bin`])('rejects invalid test release ID %j', (id) => {
    const environment = { DOWNLOAD_TEST_ORIGIN: 'https://updates.example.com', DOWNLOAD_TEST_RELEASE_ID: id }
    expect(() => resolveDesktopAutoUpdateConfig(environment, 'darwin', 'arm64')).toThrow(/DOWNLOAD_TEST_RELEASE_ID/u)
  })

  it.each([['darwin', 'arm64', 'mac-arm64'], ['darwin', 'x64', 'mac-x64'], ['win32', 'x64', 'win-x64']] as const)
  ('uses one test release directory for %s %s feeds and binaries', (platform, arch, target) => {
    expect(resolveDesktopAutoUpdateConfig({ DOWNLOAD_TEST_ORIGIN: 'https://updates.example.com',
      DOWNLOAD_TEST_RELEASE_ID: RELEASE_ID }, platform, arch)).toMatchObject({
      publicUrl: `https://updates.example.com/dsh-desk/${RELEASE_ID}/feeds/${target}/`,
      keyPrefix: `dsh-desk/${RELEASE_ID}/feeds/${target}`,
      binaryKeyPrefix: `dsh-desk/${RELEASE_ID}/bin/${target}`,
    })
  })

  it('defaults packages and uploads to the test deployment', () => {
    expect(resolveDesktopAutoUpdateEnvironment({})).toBe('test')
    expect(resolveDesktopAutoUpdateConfig({
      DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com/',
      DOWNLOAD_TEST_RELEASE_ID: RELEASE_ID,
    }, 'darwin', 'arm64')).toEqual({
      environment: 'test', channel: 'nightly',
      target: 'mac-arm64',
      origin: 'https://desktop-updates.example.com',
      publicUrl: `https://desktop-updates.example.com/dsh-desk/${RELEASE_ID}/feeds/mac-arm64/`,
      keyPrefix: `dsh-desk/${RELEASE_ID}/feeds/mac-arm64`,
      binaryKeyPrefix: `dsh-desk/${RELEASE_ID}/bin/mac-arm64`,
    })
    expect(resolveDesktopUploadConfig({
      DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com/',
      DOWNLOAD_TEST_RELEASE_ID: RELEASE_ID,
      DOWNLOAD_TEST_COS_BUCKET: 'test-download-bucket',
    }, 'darwin', 'arm64')).toMatchObject({
      bucket: 'test-download-bucket',
      secretIdEnvName: 'DOWNLOAD_TEST_COS_SECRET_ID',
      secretKeyEnvName: 'DOWNLOAD_TEST_COS_SECRET_KEY',
    })
  })

  it.each([undefined, RELEASE_ID, 'unused-test-value'])('keeps production paths independent of test release ID %s', (id) => {
    expect(resolveDesktopAutoUpdateConfig({
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
      DOWNLOAD_TEST_RELEASE_ID: id,
    }, 'win32', 'x64')).toMatchObject({
      environment: 'production',
      target: 'win-x64',
      publicUrl: 'https://download.deepseek.com/dsh-desk/feeds/win-x64/',
      binaryKeyPrefix: 'dsh-desk/bin/win-x64',
    })
    expect(resolveDesktopUploadConfig({
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
      DOWNLOAD_PROD_COS_BUCKET: 'production-download-bucket',
    }, 'win32', 'x64')).toMatchObject({
      bucket: 'production-download-bucket',
      secretIdEnvName: 'DOWNLOAD_PROD_COS_SECRET_ID',
      secretKeyEnvName: 'DOWNLOAD_PROD_COS_SECRET_KEY',
    })
  })

  it('requires the selected deployment origin for packages and bucket only for uploads', () => {
    expect(() => resolveDesktopAutoUpdateConfig({}, 'darwin', 'arm64'))
      .toThrow(/DOWNLOAD_TEST_ORIGIN/u)
    expect(resolveDesktopAutoUpdateConfig({
      DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com',
      DOWNLOAD_TEST_RELEASE_ID: RELEASE_ID,
    }, 'darwin', 'arm64').publicUrl).toContain('/mac-arm64/')
    expect(() => resolveDesktopUploadConfig({
      DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com',
      DOWNLOAD_TEST_RELEASE_ID: RELEASE_ID,
    }, 'darwin', 'arm64')).toThrow(/DOWNLOAD_TEST_COS_BUCKET/u)
    expect(() => resolveDesktopUploadConfig({
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
    }, 'win32', 'x64')).toThrow(/DOWNLOAD_PROD_COS_BUCKET/u)
  })

  it('rejects a test download URL that is not an HTTPS origin', () => {
    expect(() => resolveDesktopAutoUpdateConfig({
      DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com/releases',
    }, 'darwin', 'arm64')).toThrow(/HTTPS origin without a path/u)
    expect(() => resolveDesktopAutoUpdateConfig({
      DOWNLOAD_TEST_ORIGIN: 'http://desktop-updates.example.com',
    }, 'darwin', 'arm64')).toThrow(/HTTPS origin/u)
  })

  it('rejects unknown deployments and targets', () => {
    expect(() => resolveDesktopAutoUpdateEnvironment({
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'staging',
    })).toThrow(/test.*production/u)
    expect(() => resolveDesktopAutoUpdateTarget('linux', 'x64')).toThrow(/unsupported target/u)
    expect(() => desktopBuildRecordFilename('linux-x64' as 'mac-arm64')).toThrow(/unsupported target/u)
  })

  it('uses Nightly metadata for stable and prerelease Desktop versions', () => {
    expect(desktopUpdateMetadataFilename('1.2.3', 'darwin')).toBe('nightly-mac.yml')
    expect(desktopUpdateMetadataFilename('1.2.3-alpha.4', 'darwin')).toBe('nightly-mac.yml')
    expect(desktopUpdateMetadataFilename('1.2.3-beta.2', 'win32')).toBe('nightly.yml')
    expect(() => desktopUpdateMetadataFilename('not-semver', 'darwin')).toThrow(/invalid Desktop version/u)
    expect(() => desktopUpdateMetadataFilename('1.2.3', 'linux')).toThrow(/unsupported metadata platform/u)
  })
})

it.each([
  ['mac-arm64', 'dsh-latest-macos-arm64.dmg'],
  ['mac-x64', 'dsh-latest-macos-x64.dmg'],
  ['win-x64', 'dsh-latest-windows-x64.exe'],
] as const)('uses the production origin for website target %s', (target, filename) => {
  expect(desktopWebsiteInstallerUrl(target)).toBe(`https://download.deepseek.com/desktop/${filename}`)
})

it.each([['darwin', 'arm64', 'mac-arm64', 'stable-mac.yml'], ['darwin', 'x64', 'mac-x64', 'stable-mac.yml'], ['win32', 'x64', 'win-x64', 'stable.yml']] as const)
('routes stable metadata and binaries separately for %s %s', (platform, arch, target, filename) => {
  const config = resolveDesktopAutoUpdateConfig({ DSH_DESKTOP_AUTO_UPDATE_ENV: 'production', DSH_DESKTOP_UPDATE_CHANNEL: 'stable' }, platform, arch)
  expect(config.channel).toBe('stable')
  expect(config.keyPrefix).toBe(`dsh-desk/feeds/${target}`)
  expect(config.binaryKeyPrefix).toBe(`dsh-desk/bin/${target}/stable`)
  expect(desktopUpdateMetadataFilename('1.0.0', platform, config.channel)).toBe(filename)
  expect(() => resolveDesktopAutoUpdateConfig({ DSH_DESKTOP_UPDATE_CHANNEL: 'latest' }, platform, arch)).toThrow(/channel/u)
})
