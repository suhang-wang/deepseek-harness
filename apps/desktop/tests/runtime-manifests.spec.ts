import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { prepareRuntimeManifests } from '../scripts/prepare-runtime-manifests.ts'
import { readDesktopRuntime, verifyDesktopRuntime, writeDesktopRuntime } from '../src/runtime-tree.ts'
import { runtimeFixture } from './runtime-fixture.ts'

it('seals dependency metadata that remains unchanged by archive preparation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-manifests-'))
  const fixture = runtimeFixture(root)
  try {
    mkdirSync(join(root, 'node_modules/example'), { recursive: true })
    writeFileSync(join(root, 'node_modules/example/package.json'), JSON.stringify({ name: 'example', version: '1.0.0' }))
    const directory = join(root, 'node_modules/example/node_modules/nested')
    mkdirSync(directory, { recursive: true })
    const manifest = join(directory, 'package.json')
    writeFileSync(manifest, JSON.stringify({ name: 'nested', version: '1.0.0',
      scripts: { test: 'vitest' }, keywords: ['example'], bugs: 'https://example.com',
      main: 'index.js', dependencies: { runtime: '1.0.0' } }))
    await expect(verifyDesktopRuntime(root, fixture.release.version)).rejects.toThrow(/integrity|trusted Host package catalog/u)
    await prepareRuntimeManifests(root)
    expect(JSON.parse(readFileSync(manifest, 'utf8'))).toEqual({ name: 'nested', version: '1.0.0',
      main: 'index.js', dependencies: { runtime: '1.0.0' } })
    writeDesktopRuntime(root, fixture.release, fixture.sharedPackages.map(entry => entry.name))
    await prepareRuntimeManifests(root)
    await verifyDesktopRuntime(root, fixture.release.version)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('seals an enterprise bundle Host allowlist into the immutable runtime descriptor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-enterprise-policy-'))
  const fixture = runtimeFixture(root)
  const names = [...fixture.sharedPackages.map(entry => entry.name), '@dsh-enterprise/harness-bundle', '@dsh-enterprise/harness-identity']
  try {
    for (const name of names.slice(-2)) {
      const directory = join(root, 'node_modules', name)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0',
        ...(name.endsWith('harness-bundle') ? { dsh: { enterprise: { allowedHostPluginNames: names.slice(-2) } } } : {}) }))
    }
    const descriptor = writeDesktopRuntime(root, fixture.release, names, {
      platform: process.platform, arch: process.arch, enterpriseServiceOrigin: 'https://enterprise.example.test',
    })
    expect(descriptor.enterpriseServiceOrigin).toBe('https://enterprise.example.test')
    expect(descriptor.allowedHostPlugins).toEqual(names.slice(-2).map(name => ({ name, version: '1.0.0', path: `node_modules/${name}` })))
    expect(Object.isFrozen(descriptor.allowedHostPlugins)).toBe(true)
    const loaded = readDesktopRuntime(root)
    expect(loaded.enterpriseServiceOrigin).toBe('https://enterprise.example.test')
    expect(loaded.allowedHostPlugins).toEqual(names.slice(-2).map(name => ({ name, version: '1.0.0', path: `node_modules/${name}` })))
    expect(Object.isFrozen(loaded.allowedHostPlugins)).toBe(true)
    await expect(verifyDesktopRuntime(root, fixture.release.version)).resolves.toMatchObject({
      allowedHostPlugins: names.slice(-2).map(name => ({ name, version: '1.0.0', path: `node_modules/${name}` })),
    })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('catalogs root and nested installed packages by path, including duplicate package names', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-enterprise-catalog-'))
  const fixture = runtimeFixture(root)
  const bundle = '@dsh-enterprise/harness-bundle'
  const names = [...fixture.sharedPackages.map(entry => entry.name), bundle]
  try {
    for (const [path, name, version] of [
      [`node_modules/${bundle}`, bundle, '1.0.0'],
      ['node_modules/debug', 'debug', '4.4.3'],
      ['node_modules/compression', 'compression', '1.0.0'],
      ['node_modules/compression/node_modules/debug', 'debug', '2.6.9'],
      ['node_modules/@scope/outer/node_modules/@scope/inner', '@scope/inner', '3.0.0'],
      ['node_modules/@scope/outer', '@scope/outer', '2.0.0'],
    ] as const) {
      const directory = join(root, path)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version,
        ...(name === bundle ? { dsh: { enterprise: { allowedHostPluginNames: [bundle] } } } : {}) }))
    }
    const descriptor = writeDesktopRuntime(root, fixture.release, names, {
      platform: process.platform, arch: process.arch, enterpriseServiceOrigin: 'https://enterprise.example.test',
    })
    expect(descriptor.trustedHostPackages).toEqual(expect.arrayContaining([
      { name: 'debug', version: '4.4.3', path: 'node_modules/debug' },
      { name: 'debug', version: '2.6.9', path: 'node_modules/compression/node_modules/debug' },
      { name: '@scope/inner', version: '3.0.0', path: 'node_modules/@scope/outer/node_modules/@scope/inner' },
    ]))
    expect(readDesktopRuntime(root).trustedHostPackages).toEqual(descriptor.trustedHostPackages)
    await expect(verifyDesktopRuntime(root, fixture.release.version)).resolves.toMatchObject({
      trustedHostPackages: descriptor.trustedHostPackages,
    })
    const tampered = JSON.parse(readFileSync(join(root, 'desktop-runtime.json'), 'utf8')) as {
      trustedHostPackages: { name: string; version: string; path: string }[]
    }
    tampered.trustedHostPackages.find(entry => entry.path === 'node_modules/compression/node_modules/debug')!.version = '9.9.9'
    writeFileSync(join(root, 'desktop-runtime.json'), JSON.stringify(tampered))
    await expect(verifyDesktopRuntime(root, fixture.release.version)).rejects.toThrow(/trusted Host package catalog/u)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it.each(['omitted', 'extra', 'version', 'path'])('rejects a %s trusted package catalog entry', async (kind) => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-catalog-invalid-'))
  const fixture = runtimeFixture(root)
  const path = join(root, 'desktop-runtime.json')
  try {
    const descriptor = JSON.parse(readFileSync(path, 'utf8')) as {
      trustedHostPackages: { name: string; version: string; path: string }[]
    }
    if (kind === 'omitted') descriptor.trustedHostPackages.pop()
    if (kind === 'extra') descriptor.trustedHostPackages.push({ name: 'missing', version: '1.0.0', path: 'node_modules/missing' })
    if (kind === 'version') descriptor.trustedHostPackages[0]!.version = '9.9.9'
    if (kind === 'path') descriptor.trustedHostPackages[0]!.path = 'node_modules/../outside'
    writeFileSync(path, JSON.stringify(descriptor))
    await expect(verifyDesktopRuntime(root, fixture.release.version)).rejects.toThrow(/trusted Host package|catalog/u)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('rejects enterprise packages without one canonical HTTPS service origin', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-enterprise-origin-'))
  const fixture = runtimeFixture(root)
  const bundle = '@dsh-enterprise/harness-bundle'
  try {
    mkdirSync(join(root, 'node_modules', bundle), { recursive: true })
    writeFileSync(join(root, 'node_modules', bundle, 'package.json'), JSON.stringify({ name: bundle, version: '1.0.0',
      dsh: { enterprise: { allowedHostPluginNames: [bundle] } } }))
    const names = [...fixture.sharedPackages.map(entry => entry.name), bundle]
    for (const enterpriseServiceOrigin of [undefined, 'http://enterprise.example.test', 'https://enterprise.example.test/path',
      'https://Enterprise.example.test', 'https://employee:password@enterprise.example.test']) {
      expect(() => writeDesktopRuntime(root, fixture.release, names,
        { platform: process.platform, arch: process.arch,
          ...(enterpriseServiceOrigin === undefined ? {} : { enterpriseServiceOrigin }) }))
        .toThrow('canonical HTTPS service origin')
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('refuses an enterprise package set without its approved Host plugin list', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-enterprise-policy-missing-'))
  const fixture = runtimeFixture(root)
  const name = '@dsh-enterprise/harness-bundle'
  try {
    mkdirSync(join(root, 'node_modules', name), { recursive: true })
    writeFileSync(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
    expect(() => writeDesktopRuntime(root, fixture.release, [...fixture.sharedPackages.map(entry => entry.name), name]))
      .toThrow('must declare a unique Host plugin allowlist including itself')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('refuses enterprise-scoped packages when the signed release omits the enterprise bundle', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-enterprise-policy-no-bundle-'))
  const fixture = runtimeFixture(root)
  const identityPackage = '@dsh-enterprise/harness-identity'
  try {
    mkdirSync(join(root, 'node_modules', identityPackage), { recursive: true })
    writeFileSync(join(root, 'node_modules', identityPackage, 'package.json'), JSON.stringify({ name: identityPackage, version: '1.0.0' }))
    expect(() => writeDesktopRuntime(root, fixture.release, [...fixture.sharedPackages.map(entry => entry.name), identityPackage]))
      .toThrow('enterprise packages require @dsh-enterprise/harness-bundle')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
