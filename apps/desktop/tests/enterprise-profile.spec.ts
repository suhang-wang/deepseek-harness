import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DesktopProjectManager } from '../src/project-manager.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { writeDesktopRuntime } from '../src/runtime-tree.ts'
import { runtimeFixture, writePackage } from './runtime-fixture.ts'

const roots: string[] = []
const enterpriseBundle = '@dsh-enterprise/harness-bundle'
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'desktop-enterprise-profile-'))
  roots.push(root)
  const dsh = join(root, 'runtime')
  const fixture = runtimeFixture(dsh)
  const names = [enterpriseBundle, '@dsh-enterprise/harness-identity']
  for (const name of names) {
    const directory = writePackage(join(dsh, 'node_modules'), name, name === enterpriseBundle ? {
      dsh: { bundle: { patch: './bundle.yml' }, enterprise: { allowedHostPluginNames: names } },
    } : {})
    if (name === enterpriseBundle) writeFileSync(join(directory, 'bundle.yml'), '[]\n')
  }
  writeDesktopRuntime(dsh, fixture.release, [...fixture.sharedPackages.map(item => item.name), ...names], {
    platform: process.platform, arch: process.arch, enterpriseServiceOrigin: 'https://enterprise.example.test',
  })
  const manager = new DesktopProjectManager(resolveDesktopPaths(join(root, 'employee-home')), { dsh }, [enterpriseBundle])
  return { root, manager }
}

it('initializes an employee profile with the explicit enterprise bundle', async () => {
  const { manager } = setup()
  await manager.applyRelease()
  const manifest = JSON.parse(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8'))
  expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', enterpriseBundle])
})

it('keeps the required enterprise bundle when recovery disables user bundles', async () => {
  const { manager } = setup()
  await manager.applyRelease()
  const path = join(manager.paths.profile, 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  manifest.dsh.profile.bundles.push('unapproved-plugin')
  writeFileSync(path, JSON.stringify(manifest))
  mkdirSync(join(manager.paths.profile, 'node_modules/unapproved-plugin'), { recursive: true })
  await manager.disableAllPlugins()
  expect(JSON.parse(readFileSync(path, 'utf8')).dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', enterpriseBundle])
})
