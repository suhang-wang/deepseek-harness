import { join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  desktopTargetBuildPaths,
  desktopTargetPlatform,
  developmentRuntimeDirectory,
  resolveDesktopBuildTarget,
  resolveDesktopTargetBuildPaths,
} from '../scripts/desktop-build-paths.mjs'

describe('desktop build paths', () => {
  it('isolates every mutable build directory by complete target', () => {
    const arm64 = desktopTargetBuildPaths('mac-arm64')
    const x64 = desktopTargetBuildPaths('mac-x64')
    const windows = desktopTargetBuildPaths('win-x64')
    const mutableKeys = [
      'root',
      'artifacts',
      'unsignedArtifacts',
      'unnotarizedArtifacts',
      'runtime',
      'packageSet',
      'dsh',
      'dshPnpm',
      'electron',
      'packedDsh',
      'packedVendor',
      'packedLandlock',
    ] as const

    for (const key of mutableKeys) {
      expect(new Set([arm64[key], x64[key], windows[key]]).size).toBe(3)
    }
    expect(arm64.artifacts).toContain(join('targets', 'mac-arm64', 'artifacts'))
    expect(x64.dsh).toContain(join('targets', 'mac-x64', 'dsh'))
    expect(windows.runtime).toContain(join('targets', 'win-x64', 'runtime'))
  })

  it('keeps enterprise preparation and artifacts separate from official targets', () => {
    const official = desktopTargetBuildPaths('mac-arm64')
    const enterprise = desktopTargetBuildPaths('mac-arm64', { DSH_DESKTOP_ENTERPRISE_MODE: '1' })
    expect(enterprise.root).not.toBe(official.root)
    expect(enterprise.packedEnterprise).toContain(join('enterprise', 'targets', 'mac-arm64', 'packed', 'enterprise'))
    expect(enterprise.downloads).toBe(official.downloads)
  })

  it('shares download and package caches outside target output directories', () => {
    const arm64 = desktopTargetBuildPaths('mac-arm64')
    const x64 = desktopTargetBuildPaths('mac-x64')
    expect(arm64.downloads).toBe(x64.downloads)
    expect(arm64.downloads).not.toContain(`${sep}targets${sep}`)
    expect(arm64.pnpmStore).toBe(x64.pnpmStore)
    expect(arm64.pnpmStore).not.toContain(`${sep}targets${sep}`)
  })

  it('retains target outputs while relocating caches through the supplied environment', () => {
    const cache = resolve('external-package-cache')
    const environment = { DSH_DESKTOP_PACKAGE_CACHE_DIR: cache }
    const defaults = desktopTargetBuildPaths('win-x64', {})
    const paths = resolveDesktopTargetBuildPaths(environment, 'win32', 'x64')
    expect(paths).toEqual({ ...defaults, downloads: join(cache, 'downloads'), pnpmStore: join(cache, 'pnpm-store') })
    expect(desktopTargetBuildPaths('mac-arm64', environment).pnpmStore).toBe(paths.pnpmStore)
    for (const target of ['mac-arm64', 'mac-x64', 'win-x64'] as const) {
      const configured = desktopTargetBuildPaths(target, environment)
      expect(configured.downloads).toBe(join(cache, 'downloads'))
      expect(configured.pnpmStore).toBe(join(cache, 'pnpm-store'))
      expect(configured.root).not.toContain(cache)
    }
    expect(defaults.pnpmStore).toBe(resolve(defaults.root, '../..', 'pnpm-store'))
  })

  it.each(['', ' ', 'relative/cache', './cache', 'cache\0invalid'])('rejects invalid cache directory %j', (directory) => {
    expect(() => desktopTargetBuildPaths('win-x64', { DSH_DESKTOP_PACKAGE_CACHE_DIR: directory }))
      .toThrow('DSH_DESKTOP_PACKAGE_CACHE_DIR')
  })

  it('isolates company preparation and artifacts by application ID while retaining legacy paths', () => {
    const first = resolveDesktopTargetBuildPaths({ DSH_DESKTOP_ENTERPRISE_MODE: '1',
      DSH_DESKTOP_APP_ID: 'com.example.company-one' }, 'darwin', 'arm64')
    const second = resolveDesktopTargetBuildPaths({ DSH_DESKTOP_ENTERPRISE_MODE: '1',
      DSH_DESKTOP_APP_ID: 'com.example.company-two' }, 'darwin', 'arm64')
    for (const key of Object.keys(first) as (keyof typeof first)[]) {
      if (key === 'downloads' || key === 'pnpmStore') expect(first[key]).toBe(second[key])
      else expect(first[key]).not.toBe(second[key])
    }
    expect(first.root).toContain(join('enterprise', 'companies', 'com.example.company-one', 'targets', 'mac-arm64'))
    expect(resolveDesktopTargetBuildPaths({ DSH_DESKTOP_ENTERPRISE_MODE: '1',
      DSH_DESKTOP_APP_ID: 'com.deepseek.harness.enterprise.local' }, 'darwin', 'arm64'))
      .toEqual(desktopTargetBuildPaths('mac-arm64', { DSH_DESKTOP_ENTERPRISE_MODE: '1' }))
    expect(() => desktopTargetBuildPaths('mac-arm64', {
      DSH_DESKTOP_ENTERPRISE_MODE: '1', DSH_DESKTOP_APP_ID: '../escape',
    })).toThrow(/company app ID/u)
    expect(() => desktopTargetBuildPaths('mac-arm64', { DSH_DESKTOP_ENTERPRISE_MODE: 'invalid' }))
      .toThrow(/DSH_DESKTOP_ENTERPRISE_MODE/u)
    const cache = resolve('enterprise-package-cache')
    const relocated = desktopTargetBuildPaths('mac-arm64', { DSH_DESKTOP_ENTERPRISE_MODE: '1',
      DSH_DESKTOP_APP_ID: 'com.example.company-one', DSH_DESKTOP_PACKAGE_CACHE_DIR: cache })
    expect(relocated).toEqual({ ...first, downloads: join(cache, 'downloads'), pnpmStore: join(cache, 'pnpm-store') })
  })

  it('resolves the development primary runtime from the build target rather than the host architecture', () => {
    expect(developmentRuntimeDirectory({}, 'darwin', 'arm64'))
      .toContain(join('targets', 'mac-arm64', 'runtime', 'primary-runtime'))
    expect(developmentRuntimeDirectory({}, 'darwin', 'x64'))
      .toContain(join('targets', 'mac-x64', 'runtime', 'primary-runtime'))
    expect(developmentRuntimeDirectory({}, 'win32', 'arm64'))
      .toContain(join('targets', 'win-x64', 'runtime', 'primary-runtime'))
  })

  it('maps every target to the platform and architecture of the payload it prepares', () => {
    expect(desktopTargetPlatform('mac-arm64')).toEqual({ platform: 'darwin', arch: 'arm64' })
    expect(desktopTargetPlatform('mac-x64')).toEqual({ platform: 'darwin', arch: 'x64' })
    expect(desktopTargetPlatform('win-x64')).toEqual({ platform: 'win32', arch: 'x64' })
    expect(() => desktopTargetPlatform('linux-x64' as 'mac-x64')).toThrow(/unsupported target/u)
  })

  it('resolves environment overrides and rejects unsupported targets', () => {
    expect(resolveDesktopBuildTarget({
      DSH_DESKTOP_TARGET_PLATFORM: 'darwin',
      DSH_DESKTOP_TARGET_ARCH: 'x64',
    }, 'darwin', 'arm64')).toBe('mac-x64')
    expect(resolveDesktopBuildTarget({}, 'win32', 'x64')).toBe('win-x64')
    expect(() => resolveDesktopBuildTarget({}, 'linux', 'x64')).toThrow(/unsupported target/u)
    expect(() => desktopTargetBuildPaths('linux-x64' as 'mac-x64')).toThrow(/unsupported target/u)
  })
})
