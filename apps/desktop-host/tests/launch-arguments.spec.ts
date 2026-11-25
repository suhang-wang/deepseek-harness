import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
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

it('keeps a file-based Host plugin allowlist separate from paths', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-launch-arguments-test-'))
  try {
    const file = join(directory, 'allowlist.json')
    writeFileSync(file, JSON.stringify({
      plugins: [bundle], packages: [bundle], enterpriseServiceOrigin: 'https://enterprise.example.test',
    }))
    expect(readDesktopHostLaunchArguments(['/runtime', '/profile', '/primary', `--dsh-host-plugin-allowlist-file=${file}`]))
      .toEqual({
        runtimeDir: '/runtime', projectDir: '/profile', primaryRuntime: '/primary',
        hostPluginAllowlist: { plugins: [bundle], packages: [bundle], enterpriseServiceOrigin: 'https://enterprise.example.test' },
      })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('retains ordinary Host arguments and rejects a half-configured package manager', () => {
  expect(readDesktopHostLaunchArguments(['/runtime', '/profile', '/primary'])).toEqual({
    runtimeDir: '/runtime', projectDir: '/profile', primaryRuntime: '/primary',
  })
  expect(() => readDesktopHostLaunchArguments(['/runtime', '/profile', '/primary', '/pnpm.mjs', allowlist]))
    .toThrow('invalid launch arguments')
})

async function launchIndex(argv: readonly string[], shutdown = false): Promise<unknown[]> {
  const entry = new URL('../src/index.ts', import.meta.url)
  // Only profile execution is substituted; authentication and the signed launch parser run from source.
  const stubs = {
    '@deepseek-ai/dsh-app-boot': `
      export function loadProfileDirectory() { return {
        primaryRuntime: process.env.DSH_PRIMARY_RUNTIME, enterpriseOrigin: process.env.DSH_ENTERPRISE_SERVICE_ORIGIN,
      } }
      export function loadLayeredEnv() { return {} }
      export function reportSkippedBundles() {}`,
    '@deepseek-ai/dsh/profile-boot': `
      export async function runProfile(options) {
        process.send({ type: 'launch-contract', options })
        throw new Error('fixture profile execution stopped')
      }`,
    '@deepseek-ai/dsh-host-authentication-desktop': 'export const name = "fixture-authentication"',
    './file-drag.ts': 'export function localDragResource() {}',
    './update-tasks.ts': 'export function installDesktopUpdateTaskControl() {}',
    './quit-inspection.ts': 'export function installDesktopQuitInspection() {}',
    './platform-session.ts': 'export function installPlatformSessionPublisher() {}',
    './operation-diagnostics.ts': 'export function installOperationDiagnostics() {}',
  }
  const hook = `
    import { registerHooks } from 'node:module'
    const stubs = ${JSON.stringify(stubs)}
    registerHooks({ resolve(specifier, context, next) {
      if (context.parentURL === ${JSON.stringify(entry.href)} && Object.hasOwn(stubs, specifier)) {
        return { url: 'data:text/javascript;base64,' + Buffer.from(stubs[specifier]).toString('base64'), shortCircuit: true }
      }
      return next(specifier, context)
    } })`
  const child = spawn(process.execPath, [
    '--import', import.meta.resolve('tsx/esm'),
    '--import', `data:text/javascript;base64,${Buffer.from(hook).toString('base64')}`,
    fileURLToPath(entry), ...argv,
  ], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], timeout: 10_000,
    env: { ...process.env, DSH_ENTERPRISE_SERVICE_ORIGIN: 'https://inherited.example.test', DSH_PRIMARY_RUNTIME: '/inherited' } })
  const closed = once(child, 'close')
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  })
  let stderr = ''
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const messages: unknown[] = []
  const sendErrors: Error[] = []
  child.on('message', (message: unknown) => {
    messages.push(message)
    if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'starting') {
      child.send(shutdown ? { type: 'shutdown' } : { type: 'desktop-auth', secret: randomBytes(32).toString('base64url') },
        (error) => { if (error !== null) sendErrors.push(error) })
    }
  })
  const [code, signal] = await closed as [number | null, NodeJS.Signals | null]
  expect(signal, stderr).toBeNull()
  expect(code, stderr).toBe(shutdown ? 0 : 1)
  expect(sendErrors).toEqual([])
  expect(messages).toContainEqual(expect.objectContaining({ type: 'starting' }))
  return messages
}

it.each([
  { explicit: false, managed: false }, { explicit: false, managed: true },
  { explicit: true, managed: false }, { explicit: true, managed: true },
])('boots the authenticated entry with signed policy (explicit payload: $explicit, package manager: $managed)', async ({ explicit, managed }) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-launch-entry-test-'))
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  const file = join(directory, 'allowlist.json')
  writeFileSync(file, JSON.stringify({ plugins: [bundle], packages: [bundle], enterpriseServiceOrigin: 'https://enterprise.example.test' }))
  const runtime = join(directory, 'dsh')
  const primary = explicit ? join(directory, 'custom-primary') : ''
  const messages = await launchIndex([runtime, directory, primary,
    ...(managed ? ['/pnpm.mjs', '/node-bin'] : []), `--dsh-host-plugin-allowlist-file=${file}`])
  const packageManager: unknown = expect.objectContaining({ command: process.execPath, args: ['--expose-internals', '/pnpm.mjs'] })
  expect(messages).toContainEqual({ type: 'launch-contract', options: {
    environment: {}, profile: 'desktop', patchFiles: [], args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
    allowedHostPlugins: [bundle], trustedHostPackages: [bundle], enterpriseServiceOrigin: 'https://enterprise.example.test',
    resolvedProfile: { installAnchor: join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      profile: { primaryRuntime: primary || join(directory, 'runtime', 'primary-runtime'), enterpriseOrigin: 'https://enterprise.example.test' } },
    ...(managed ? { packageManager } : {}),
  } })
  expect(messages).toContainEqual(expect.objectContaining({ type: 'fatal', message: 'fixture profile execution stopped' }))
})

it('rejects incomplete package-manager paths before profile execution', async () => {
  const messages = await launchIndex(['/runtime', '/profile', '', '/pnpm.mjs', allowlist])
  expect(messages).toContainEqual(expect.objectContaining({ type: 'fatal', message: 'desktop host: invalid launch arguments' }))
  expect(messages).not.toContainEqual(expect.objectContaining({ type: 'launch-contract' }))
})

it('honors shutdown before authentication without reading launch policy or starting the profile', async () => {
  const messages = await launchIndex(['/runtime', '/profile', '', '--dsh-host-plugin-allowlist-file=/missing-policy.json'], true)
  expect(messages).toContainEqual({ type: 'shutdown-complete' })
  expect(messages).not.toContainEqual(expect.objectContaining({ type: 'fatal' }))
  expect(messages).not.toContainEqual(expect.objectContaining({ type: 'launch-contract' }))
})
