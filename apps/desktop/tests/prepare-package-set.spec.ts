import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DESKTOP_HOST_RUNTIME_FILES, DESKTOP_PACKAGES_DIR } from '../src/core-package-set.ts'
import {
  assertDesktopHostPackageFiles,
  prepareDesktopPackageSet,
  selectDesktopPackageClosure,
  type PackedDesktopPackage,
} from '../scripts/prepare-package-set.ts'

function packed(name: string, manifest: Record<string, unknown> = {}): PackedDesktopPackage {
  return { tarball: `${name}.tgz`, manifest: { name, version: '1.0.0', ...manifest } }
}

describe('desktop package-set selection', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('does not select a packaging target when imported as a library', async () => {
    vi.stubEnv('DSH_DESKTOP_TARGET_PLATFORM', 'linux')
    vi.stubEnv('DSH_DESKTOP_TARGET_ARCH', 'x64')
    vi.resetModules()
    await expect(import('../scripts/prepare-package-set.ts')).resolves.toHaveProperty('prepareDesktopPackageSet')
  })

  it('includes only the available internal production closure', () => {
    const available = new Map<string, PackedDesktopPackage>([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh', {
        dependencies: { '@deepseek-ai/dsh-base': '^1.0.0', external: '^2.0.0' },
        optionalDependencies: { '@deepseek-ai/platform-package': '1.0.0', '@deepseek-ai/missing-platform': '1.0.0' },
      })],
      ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host', {
        dependencies: { '@deepseek-ai/dsh': '^1.0.0' },
      })],
      ['@deepseek-ai/dsh-base', packed('@deepseek-ai/dsh-base', {
        peerDependencies: { '@deepseek-ai/cordis': '^1.0.0' },
      })],
      ['@deepseek-ai/cordis', packed('@deepseek-ai/cordis')],
      ['@deepseek-ai/platform-package', packed('@deepseek-ai/platform-package')],
      ['@deepseek-ai/unused', packed('@deepseek-ai/unused')],
    ])
    expect(selectDesktopPackageClosure(available, { platform: 'win32', arch: 'x64' }).map(entry => entry.manifest.name)).toEqual([
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh',
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-desktop-host',
      '@deepseek-ai/platform-package',
    ])
  })

  it.each([{ platform: 'win32', arch: 'x64' }, { platform: 'darwin', arch: 'arm64' }] as const)
  ('adds the enterprise closure with target-filtered optional packages for %j', (target) => {
    const available = new Map<string, PackedDesktopPackage>([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh')],
      ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host')],
      ['@dsh-enterprise/harness-bundle', packed('@dsh-enterprise/harness-bundle', {
        dependencies: { '@dsh-enterprise/harness-identity': '0.1.0', '@dsh-enterprise/harness-provider': '0.1.0', '@dsh-enterprise/harness-ui': '0.1.0' },
        optionalDependencies: { '@deepseek-ai/dsh-cua-macos': '1.0.0' },
      })],
      ['@dsh-enterprise/harness-identity', packed('@dsh-enterprise/harness-identity')],
      ['@dsh-enterprise/harness-provider', packed('@dsh-enterprise/harness-provider')],
      ['@dsh-enterprise/harness-ui', packed('@dsh-enterprise/harness-ui')],
      ['@deepseek-ai/dsh-cua-macos', packed('@deepseek-ai/dsh-cua-macos', { os: ['darwin'] })],
    ])
    expect(selectDesktopPackageClosure(available, target).map(entry => entry.manifest.name))
      .not.toContain('@dsh-enterprise/harness-bundle')
    const selected = selectDesktopPackageClosure(available, target, ['@dsh-enterprise/harness-bundle']).map(entry => entry.manifest.name)
    expect(selected).toContain('@dsh-enterprise/harness-ui')
    expect(selected.includes('@deepseek-ai/dsh-cua-macos')).toBe(target.platform === 'darwin')
    available.delete('@dsh-enterprise/harness-provider')
    expect(() => selectDesktopPackageClosure(available, target, ['@dsh-enterprise/harness-bundle']))
      .toThrow(/requires unpacked package @dsh-enterprise\/harness-provider/u)
  })

  it('selects the same local Cordis and typert packages required by enterprise peers', () => {
    const available = new Map<string, PackedDesktopPackage>([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh')],
      ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host')],
      ['@deepseek-ai/cordis', packed('@deepseek-ai/cordis')],
      ['@deepseek-ai/dsh-typert-protocol', packed('@deepseek-ai/dsh-typert-protocol')],
      ['@dsh-enterprise/harness-bundle', packed('@dsh-enterprise/harness-bundle', {
        dependencies: { '@dsh-enterprise/harness-identity': '0.1.0' },
      })],
      ['@dsh-enterprise/harness-identity', packed('@dsh-enterprise/harness-identity', {
        peerDependencies: { '@deepseek-ai/cordis': '4.0.5-alpha.1', '@deepseek-ai/dsh-typert-protocol': '0.2.1-alpha.2' },
      })],
    ])
    const selected = selectDesktopPackageClosure(available, { platform: 'win32', arch: 'x64' }, ['@dsh-enterprise/harness-bundle'])
      .map(entry => entry.manifest.name)
    expect(selected.filter(name => name === '@deepseek-ai/cordis')).toEqual(['@deepseek-ai/cordis'])
    expect(selected.filter(name => name === '@deepseek-ai/dsh-typert-protocol')).toEqual(['@deepseek-ai/dsh-typert-protocol'])
    available.delete('@deepseek-ai/dsh-typert-protocol')
    expect(() => selectDesktopPackageClosure(available, { platform: 'win32', arch: 'x64' }, ['@dsh-enterprise/harness-bundle']))
      .toThrow(/requires unpacked package @deepseek-ai\/dsh-typert-protocol/u)
  })

  it.each([
    '@deepseek-ai/dsh-base', '@deepseek-ai/cordis', '@deepseek-ai/node-addon-system',
  ])('rejects required prepared package %s absent from the packed release inputs', (dependency) => {
    const available = new Map<string, PackedDesktopPackage>([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh', {
        dependencies: { [dependency]: '^1.0.0' },
      })],
      ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host', {
        dependencies: { '@deepseek-ai/dsh': '^1.0.0' },
      })],
    ])
    expect(() => selectDesktopPackageClosure(available, { platform: 'win32', arch: 'x64' })).toThrow(/unpacked package/u)
    expect(() => selectDesktopPackageClosure(new Map([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh')],
    ]), { platform: 'win32', arch: 'x64' })).toThrow(/omit @deepseek-ai\/dsh-desktop-host/u)
  })

  it('leaves independently published Office packages to npm resolution', () => {
    const available = new Map<string, PackedDesktopPackage>([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh', {
        dependencies: {
          '@deepseek-ai/libreoffice-kit': '0.0.1',
          '@deepseek-ai/libreoffice-kit-wasm': '0.0.1',
        },
      })],
      ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host')],
    ])
    expect(selectDesktopPackageClosure(available, { platform: 'win32', arch: 'x64' }).map(entry => entry.manifest.name)).toEqual([
      '@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host',
    ])
  })

  it('requires both Desktop Host and public CLI entries', () => {
    const files = [
      'package/lib/index.js',
      'package/lib/cli.js',
    ]
    expect(() => {
      assertDesktopHostPackageFiles(files)
    }).not.toThrow()
    expect(() => {
      assertDesktopHostPackageFiles(files.slice(1))
    }).toThrow(/lib\/index\.js/u)
    expect(() => { assertDesktopHostPackageFiles(files.slice(0, 1)) }).toThrow(/lib\/cli\.js/u)
  })
})

const macProvider = '@deepseek-ai/dsh-cua-macos'
const cuaBundle = '@deepseek-ai/dsh-cua-bundle'
const targetManifests = () => new Map<string, PackedDesktopPackage>([
  ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh', { dependencies: { [cuaBundle]: '1.0.0' } })],
  ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host')],
  [cuaBundle, packed(cuaBundle, {
    optionalDependencies: { [macProvider]: '1.0.0' }, dependencies: { '@deepseek-ai/dsh-cua': '1.0.0' },
  })],
  ['@deepseek-ai/dsh-cua', packed('@deepseek-ai/dsh-cua')],
  [macProvider, packed(macProvider, { os: ['darwin'] })],
])

it.each([
  ['darwin', 'arm64', true], ['darwin', 'x64', true], ['win32', 'x64', false],
] as const)('selects the CUA native tarball for target %s/%s independently of the host', (platform, arch, included) => {
  const selected = selectDesktopPackageClosure(targetManifests(), { platform, arch }).map(entry => entry.manifest.name)
  expect(selected.includes(macProvider)).toBe(included)
  expect(selected).toContain('@deepseek-ai/dsh-cua')
  expect(selected).toContain(cuaBundle)
})

it.each([
  [{ cpu: ['arm64'] }, false], [{ os: ['!win32'] }, false], [{ os: ['!linux'] }, true],
  [{ os: [] }, true], [{ os: ['any'] }, true], [{ os: ['any', '!win32'] }, false],
  [{ cpu: ['x64'] }, true],
])('honors optional package platform constraints %j', (constraints, included) => {
  const packages = targetManifests()
  packages.set(macProvider, packed(macProvider, constraints))
  expect(selectDesktopPackageClosure(packages, { platform: 'win32', arch: 'x64' })
    .some(entry => entry.manifest.name === macProvider)).toBe(included)
})

it.each([{ os: 'darwin' }, { cpu: [42] }])('rejects malformed platform constraints %j', (constraints) => {
  const packages = targetManifests()
  packages.set(macProvider, packed(macProvider, constraints))
  expect(() => selectDesktopPackageClosure(packages, { platform: 'win32', arch: 'x64' })).toThrow(/has invalid/u)
})

it('copies no macOS tarball into the Windows package set', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-platform-packages-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const inputs = join(root, 'inputs')
  mkdirSync(inputs)
  for (const [name, entry] of targetManifests()) {
    const stem = name.replace('@deepseek-ai/', '')
    const folder = join(root, stem, 'package')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'package.json'), JSON.stringify(entry.manifest))
    if (name === '@deepseek-ai/dsh-desktop-host') {
      for (const file of DESKTOP_HOST_RUNTIME_FILES) {
        mkdirSync(join(folder, file, '..'), { recursive: true })
        writeFileSync(join(folder, file), '')
      }
    }
    execFileSync('tar', ['-czf', join(inputs, `${stem}.tgz`), '-C', join(folder, '..'), 'package'])
  }
  const output = join(root, 'output')
  prepareDesktopPackageSet([inputs], output, { platform: 'win32', arch: 'x64' })
  expect(readdirSync(join(output, DESKTOP_PACKAGES_DIR))).not.toContain('dsh-cua-macos.tgz')
  prepareDesktopPackageSet([inputs], output, { platform: 'darwin', arch: 'arm64' })
  expect(readFileSync(join(output, DESKTOP_PACKAGES_DIR, 'dsh-cua-macos.tgz')))
    .toEqual(readFileSync(join(inputs, 'dsh-cua-macos.tgz')))
})
