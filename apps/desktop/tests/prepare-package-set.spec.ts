import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertDesktopHostPackageFiles,
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
    expect(selectDesktopPackageClosure(available).map(entry => entry.manifest.name)).toEqual([
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh',
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-desktop-host',
      '@deepseek-ai/platform-package',
    ])
  })

  it('adds the enterprise bundle and its four package closure only for an explicit root', () => {
    const available = new Map<string, PackedDesktopPackage>([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh')],
      ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host')],
      ['@dsh-enterprise/harness-bundle', packed('@dsh-enterprise/harness-bundle', {
        dependencies: { '@dsh-enterprise/harness-identity': '0.1.0', '@dsh-enterprise/harness-provider': '0.1.0', '@dsh-enterprise/harness-ui': '0.1.0' },
      })],
      ['@dsh-enterprise/harness-identity', packed('@dsh-enterprise/harness-identity')],
      ['@dsh-enterprise/harness-provider', packed('@dsh-enterprise/harness-provider')],
      ['@dsh-enterprise/harness-ui', packed('@dsh-enterprise/harness-ui')],
    ])
    expect(selectDesktopPackageClosure(available).map(entry => entry.manifest.name))
      .not.toContain('@dsh-enterprise/harness-bundle')
    expect(selectDesktopPackageClosure(available, ['@dsh-enterprise/harness-bundle']).map(entry => entry.manifest.name))
      .toContain('@dsh-enterprise/harness-ui')
    available.delete('@dsh-enterprise/harness-provider')
    expect(() => selectDesktopPackageClosure(available, ['@dsh-enterprise/harness-bundle']))
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
    const selected = selectDesktopPackageClosure(available, ['@dsh-enterprise/harness-bundle'])
      .map(entry => entry.manifest.name)
    expect(selected.filter(name => name === '@deepseek-ai/cordis')).toEqual(['@deepseek-ai/cordis'])
    expect(selected.filter(name => name === '@deepseek-ai/dsh-typert-protocol')).toEqual(['@deepseek-ai/dsh-typert-protocol'])
    available.delete('@deepseek-ai/dsh-typert-protocol')
    expect(() => selectDesktopPackageClosure(available, ['@dsh-enterprise/harness-bundle']))
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
    expect(() => selectDesktopPackageClosure(available)).toThrow(/unpacked package/u)
    expect(() => selectDesktopPackageClosure(new Map([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh')],
    ]))).toThrow(/omit @deepseek-ai\/dsh-desktop-host/u)
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
    expect(selectDesktopPackageClosure(available).map(entry => entry.manifest.name)).toEqual([
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
