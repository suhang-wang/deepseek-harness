import { expect, it } from 'vitest'
import { readDesktopHostLaunchArguments } from '../src/launch-arguments.ts'

const bundle = { name: '@dsh-enterprise/harness-bundle', version: '1.0.0', path: '/runtime/node_modules/@dsh-enterprise/harness-bundle' }
const allowlist = `--dsh-host-plugin-allowlist=${JSON.stringify({
  plugins: [bundle], packages: [bundle], enterpriseServiceOrigin: 'https://enterprise.example.test',
})}`

it('keeps a Host plugin allowlist separate from absent package-manager paths', () => {
  expect(readDesktopHostLaunchArguments(['/runtime', '/profile', '/primary', allowlist])).toEqual({
    runtimeDir: '/runtime', projectDir: '/profile', primaryRuntime: '/primary',
    hostPluginAllowlist: { plugins: [bundle], packages: [bundle], enterpriseServiceOrigin: 'https://enterprise.example.test' },
  })
})

it('reads package-manager paths before a Host plugin allowlist', () => {
  expect(readDesktopHostLaunchArguments(['/runtime', '/profile', '/primary', '/pnpm.mjs', '/node-bin', allowlist])).toEqual({
    runtimeDir: '/runtime', projectDir: '/profile', primaryRuntime: '/primary',
    packageManager: { pnpm: '/pnpm.mjs', nodeBin: '/node-bin' },
    hostPluginAllowlist: { plugins: [bundle], packages: [bundle], enterpriseServiceOrigin: 'https://enterprise.example.test' },
  })
})

it('retains ordinary Host arguments and rejects a half-configured package manager', () => {
  expect(readDesktopHostLaunchArguments(['/runtime', '/profile', '/primary'])).toEqual({
    runtimeDir: '/runtime', projectDir: '/profile', primaryRuntime: '/primary',
  })
  expect(() => readDesktopHostLaunchArguments(['/runtime', '/profile', '/primary', '/pnpm.mjs', allowlist]))
    .toThrow('invalid launch arguments')
})
