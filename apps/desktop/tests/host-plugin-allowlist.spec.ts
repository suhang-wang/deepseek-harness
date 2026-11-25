import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readHostPluginAllowlist } from '../../desktop-host/src/host-plugin-allowlist.ts'

describe('desktop Host plugin allowlist argument', () => {
  it('keeps ordinary Harness launches outside enterprise allowlist mode', () => {
    expect(readHostPluginAllowlist(['/runtime', '/profile'])).toBeUndefined()
  })

  it('validates, snapshots, and freezes release-pinned package records', () => {
    const record = (name: string, path: string) => ({ name, version: '1.0.0', path })
    const entries = [record('@dsh-enterprise/harness-bundle', '/runtime/node_modules/@dsh-enterprise/harness-bundle'),
      record('@dsh-enterprise/harness-identity', '/runtime/node_modules/@dsh-enterprise/harness-identity')]
    const allowed = readHostPluginAllowlist(['/runtime', `--dsh-host-plugin-allowlist=${JSON.stringify({
      plugins: [entries[0]], packages: entries, enterpriseServiceOrigin: 'https://enterprise.example.test',
    })}`])
    expect(allowed).toEqual({ plugins: [entries[0]], packages: entries, enterpriseServiceOrigin: 'https://enterprise.example.test' })
    expect(Object.isFrozen(allowed)).toBe(true)
    expect(() => readHostPluginAllowlist(['/runtime', '--dsh-host-plugin-allowlist={"plugins":[{"name":"invalid name","version":"1.0.0","path":"/runtime/pkg"}],"packages":[]}']))
      .toThrow('invalid Host plugin allowlist')
    expect(() => readHostPluginAllowlist(['/runtime', '--dsh-host-plugin-allowlist={"plugins":[{"name":"duplicate","version":"1.0.0","path":"/one"}],"packages":[{"name":"duplicate","version":"1.0.0","path":"/one"},{"name":"duplicate","version":"1.0.0","path":"/one"}]}']))
      .toThrow('invalid Host plugin allowlist')
  })

  it('permits signed nested dependency versions at different paths', () => {
    const bundle = { name: '@dsh-enterprise/harness-bundle', version: '1.0.0', path: '/runtime/node_modules/@dsh-enterprise/harness-bundle' }
    const root = { name: 'debug', version: '4.4.3', path: '/runtime/node_modules/debug' }
    const nested = { name: 'debug', version: '2.6.9', path: '/runtime/node_modules/compression/node_modules/debug' }
    const result = readHostPluginAllowlist([`--dsh-host-plugin-allowlist=${JSON.stringify({
      plugins: [bundle], packages: [bundle, root, nested], enterpriseServiceOrigin: 'https://enterprise.example.test',
    })}`])
    expect(result?.packages).toEqual([bundle, root, nested])
  })

  it('refuses enterprise Host policy without a canonical HTTPS service origin', () => {
    const bundle = { name: '@dsh-enterprise/harness-bundle', version: '1.0.0', path: '/runtime/bundle' }
    for (const enterpriseServiceOrigin of [undefined, 'http://enterprise.example.test', 'https://enterprise.example.test/path']) {
      expect(() => readHostPluginAllowlist([`--dsh-host-plugin-allowlist=${JSON.stringify({
        plugins: [bundle], packages: [bundle], enterpriseServiceOrigin,
      })}`])).toThrow('enterprise service origin')
    }
  })

  it('reads the same policy from a launcher-owned file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-host-allowlist-test-'))
    try {
      const file = join(directory, 'allowlist.json')
      const bundle = { name: '@dsh-enterprise/harness-bundle', version: '1.0.0', path: '/runtime/bundle' }
      const packages = [bundle, { name: 'debug', version: '4.4.3', path: '/runtime/node_modules/debug' }]
      writeFileSync(file, JSON.stringify({
        plugins: [bundle], packages, enterpriseServiceOrigin: 'https://enterprise.example.test',
      }))
      expect(readHostPluginAllowlist([`--dsh-host-plugin-allowlist-file=${file}`])).toEqual({
        plugins: [bundle], packages, enterpriseServiceOrigin: 'https://enterprise.example.test',
      })
      expect(() => readHostPluginAllowlist([`--dsh-host-plugin-allowlist-file=${join(directory, 'missing.json')}`]))
        .toThrow('invalid Host plugin allowlist')
      expect(() => readHostPluginAllowlist(['--dsh-host-plugin-allowlist-file=relative.json']))
        .toThrow('invalid Host plugin allowlist')
      expect(() => readHostPluginAllowlist([
        `--dsh-host-plugin-allowlist=${JSON.stringify({ plugins: [bundle], packages, enterpriseServiceOrigin: 'https://enterprise.example.test' })}`,
        `--dsh-host-plugin-allowlist-file=${file}`,
      ])).toThrow('duplicate Host plugin allowlist arguments')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('accepts Windows absolute package paths', () => {
    const bundle = {
      name: '@dsh-enterprise/harness-bundle', version: '1.0.0',
      path: 'C:\\runtime\\node_modules\\@dsh-enterprise\\harness-bundle',
    }
    const packages = [bundle, { name: 'debug', version: '4.4.3', path: 'C:\\runtime\\node_modules\\debug' }]
    const result = readHostPluginAllowlist([`--dsh-host-plugin-allowlist=${JSON.stringify({
      plugins: [bundle], packages, enterpriseServiceOrigin: 'https://enterprise.example.test',
    })}`])
    expect(result?.plugins).toEqual([bundle])
  })

  it('rejects duplicate launcher arguments', () => {
    expect(() => readHostPluginAllowlist([
      '--dsh-host-plugin-allowlist={"plugins":[{"name":"@dsh-enterprise/harness-bundle","version":"1.0.0","path":"/runtime/pkg"}],"packages":[{"name":"@dsh-enterprise/harness-bundle","version":"1.0.0","path":"/runtime/pkg"}]}',
      '--dsh-host-plugin-allowlist={"plugins":[{"name":"@dsh-enterprise/harness-bundle","version":"1.0.0","path":"/runtime/pkg"}],"packages":[{"name":"@dsh-enterprise/harness-bundle","version":"1.0.0","path":"/runtime/pkg"}]}',
    ])).toThrow('duplicate Host plugin allowlist arguments')
  })
})
