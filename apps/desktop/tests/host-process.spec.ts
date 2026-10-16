import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopHostFatalError, DesktopHostProcess, DesktopHostUncleanExitError, QUIT_INSPECTION_DEADLINE_MS } from '../src/host-process.ts'

const roots: string[] = []
const hosts: DesktopHostProcess[] = []
const ENTERPRISE_IDENTITY_ALLOWLIST = Object.freeze([{
  name: '@dsh-enterprise/harness-identity', version: '1.0.0', path: '/enterprise/harness-identity',
}])

const HTTP_HOST = `
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const server = createServer((request, response) => {
  if (request.url === '/fatal') {
    process.send({ type: 'fatal', message: 'plugin unavailable' })
    response.end('reported')
    return
  }
  if (request.url === '/crash') {
    response.end('exiting', () => {
      process.stderr.write('plugin crashed', () => process.exit(7))
    })
    return
  }
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({runtime: process.argv[2], profile: process.argv[3], cwd: process.cwd(), nodePath: process.env.NODE_PATH, registry: process.env.NPM_CONFIG_REGISTRY, nodeOptions: process.env.NODE_OPTIONS, runAsNode: process.env.ELECTRON_RUN_AS_NODE, internals: process.execArgv.includes('--expose-internals')}))
})
server.listen(0, '127.0.0.1', () => {
  process.send({ type: 'ready', url: 'http://127.0.0.1:' + server.address().port + '/?token=fixture' })
})
process.on('message', message => {
  if (message.type === 'update-tasks') {
    process.send({ type: 'update-tasks', requestId: message.requestId, active: message.action === 'lock' })
    return
  }
  if (message.type === 'quit-inspection') {
    // Ids divisible by three never answer; the others report scheduled work for odd ids.
    if (message.requestId % 3 === 0) return
    process.send({ type: 'quit-inspection', requestId: message.requestId, activeTasks: false, scheduledTasks: message.requestId % 2 === 1 })
    return
  }
  if (message.type !== 'shutdown') return
  server.close(() => {
    writeFileSync(join(process.argv[3], 'stopped'), '')
    process.send({ type: 'shutdown-complete' }, () => process.disconnect())
  })
  server.closeAllConnections()
})
`

function projectWithHost(source = HTTP_HOST): string {
  const project = mkdtempSync(join(tmpdir(), 'dsh-desktop-host-test-'))
  roots.push(project)
  const packageRoot = join(project, 'node_modules', '@deepseek-ai', 'dsh-desktop-host')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), '{"name":"@deepseek-ai/dsh-desktop-host","type":"module"}\n')
  writeFileSync(join(packageRoot, 'lib', 'index.js'), source)
  return project
}

function hostProcess(
  runtime: string, profile = runtime, onFailure?: (error: Error) => void, environment = process.env,
): DesktopHostProcess {
  const host = new DesktopHostProcess(process.execPath, runtime, profile, undefined, environment, onFailure)
  hosts.push(host)
  return host
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.stop()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop host process', () => {
  it('retains bounded child diagnostics for a failed runtime check', async () => {
    const runtime = projectWithHost(HTTP_HOST.replace("server.listen(0, '127.0.0.1', () => {",
      "process.stderr.write('x'.repeat(70000) + 'plugin load failed')\nserver.listen(0, '127.0.0.1', () => {"))
    const host = hostProcess(runtime)
    await host.start()
    await host.stop()
    expect(host.diagnostic.length).toBeLessThanOrEqual(64 * 1024)
    expect(host.diagnostic.endsWith('plugin load failed')).toBe(true)
  })

  it('passes the sealed Host plugin list to the child without using environment overrides', async () => {
    const runtime = projectWithHost(HTTP_HOST.replace('nodePath: process.env.NODE_PATH',
      "allowlist: process.argv.find(argument => argument.startsWith('--dsh-host-plugin-allowlist=')), enterpriseOrigin: process.env.DSH_ENTERPRISE_SERVICE_ORIGIN"))
    const allowed = Object.freeze(['@dsh-enterprise/harness-bundle', '@dsh-enterprise/harness-identity'].map(name => Object.freeze({
      name, version: '1.0.0', path: join(runtime, 'node_modules', name),
    })))
    const trusted = Object.freeze([...allowed])
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined,
      { ...process.env, DSH_ENTERPRISE_SERVICE_ORIGIN: 'https://attacker.example.test' },
      undefined, undefined, undefined, undefined, undefined, undefined, allowed, trusted,
      undefined, 'https://enterprise.example.test')
    hosts.push(host)
    const { url } = await host.start()
    const result = await (await fetch(url)).json() as { allowlist: string; enterpriseOrigin: string }
    expect(result.enterpriseOrigin).toBe('https://enterprise.example.test')
    expect(JSON.parse(result.allowlist.slice('--dsh-host-plugin-allowlist='.length))).toEqual({
      plugins: [...allowed], packages: [...trusted], enterpriseServiceOrigin: 'https://enterprise.example.test',
    })
    await host.stop()
  })

  it('correlates task inspections and admission changes over private IPC', async () => {
    const host = hostProcess(projectWithHost())
    await expect(host.updateTasks('inspect')).rejects.toThrow('Host is unavailable')
    await host.start()
    expect(await Promise.all([host.updateTasks('inspect'), host.updateTasks('lock'), host.updateTasks('unlock')]))
      .toEqual([false, true, false])
    await host.stop(true)
    await expect(host.updateTasks('inspect')).rejects.toThrow('Host is unavailable')
  })

  it('correlates quit inspections with task requests and fails an unanswered one at its own deadline', async () => {
    const host = hostProcess(projectWithHost())
    await expect(host.inspectQuit()).rejects.toThrow('desktop quit: Host is unavailable')
    await host.start()
    // Request ids 1 and 2: the fixture answers by id parity, so both control kinds share one id space.
    expect(await Promise.all([host.inspectQuit(), host.updateTasks('inspect')]))
      .toEqual([{ activeTasks: false, scheduledTasks: true }, false])
    const started = Date.now()
    await expect(host.inspectQuit()).rejects.toThrow('desktop quit: inspection timed out')
    expect(Date.now() - started).toBeGreaterThanOrEqual(QUIT_INSPECTION_DEADLINE_MS - 50)
    expect(await host.inspectQuit()).toEqual({ activeTasks: false, scheduledTasks: false })
  }, 15_000)

  it('serves secure credential operations requested by the Host over private IPC', async () => {
    const runtime = projectWithHost(`
      import { createServer } from 'node:http'
      const server = createServer((request, response) => {
        if (request.url !== '/secure-store') { response.end('missing'); return }
        const requests = [
          { requestId: 51, operation: 'save-active-session', session: { companyId: 'company-1', refreshToken: 'A'.repeat(43), logoutCapability: 'B'.repeat(43), employeeId: 'employee-1' } },
          { requestId: 52, operation: 'rotate-refresh', expectedRefreshToken: 'A'.repeat(43), nextRefreshToken: 'D'.repeat(43) },
          { requestId: 53, operation: 'clear-active-session' },
          { requestId: 54, operation: 'acknowledge-revocation', value: 'B'.repeat(43) },
          { requestId: 55, operation: 'queue-revocation', value: 'C'.repeat(43) },
        ]
        let index = 0
        const onMessage = message => {
          if (message.type !== 'secure-store-response' || message.requestId !== requests[index].requestId) return
          if (!message.success) { response.statusCode = 500; response.end('failed'); process.off('message', onMessage); return }
          if (requests[index].operation === 'rotate-refresh' && message.value !== true) {
            response.statusCode = 500; response.end('missing rotate value'); process.off('message', onMessage); return
          }
          index += 1
          if (index === requests.length) {
            process.off('message', onMessage)
            response.setHeader('content-type', 'application/json')
            response.end(JSON.stringify({ accepted: index }))
            return
          }
          process.send({ type: 'secure-store-request', ...requests[index] })
        }
        process.on('message', onMessage)
        process.send({ type: 'secure-store-request', ...requests[index] })
      })
      server.listen(0, '127.0.0.1', () => process.send({ type: 'ready', url: 'http://127.0.0.1:' + server.address().port }))
      process.on('message', message => {
        if (message.type === 'shutdown') server.close(() => { process.send({ type: 'shutdown-complete' }, () => process.disconnect()) })
      })
    `)
    const secureStore = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      saveActiveSession: vi.fn(async () => undefined),
      rotateRefresh: vi.fn(async () => true),
      clearActiveSession: vi.fn(async () => undefined),
      acknowledgeRevocation: vi.fn(async () => undefined),
      queueRevocation: vi.fn(async () => undefined),
    }
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env,
      undefined, undefined, undefined, undefined, secureStore, undefined, ENTERPRISE_IDENTITY_ALLOWLIST, ENTERPRISE_IDENTITY_ALLOWLIST)
    hosts.push(host)
    const { url } = await host.start()
    await expect((await fetch(new URL('/secure-store', url))).json()).resolves.toEqual({ accepted: 5 })
    expect(secureStore.saveActiveSession).toHaveBeenCalledWith({ companyId: 'company-1', refreshToken: 'A'.repeat(43), logoutCapability: 'B'.repeat(43), employeeId: 'employee-1' })
    expect(secureStore.rotateRefresh).toHaveBeenCalledWith('A'.repeat(43), 'D'.repeat(43))
    expect(secureStore.clearActiveSession).toHaveBeenCalledOnce()
    expect(secureStore.acknowledgeRevocation).toHaveBeenCalledWith('B'.repeat(43))
    expect(secureStore.queueRevocation).toHaveBeenCalledWith('C'.repeat(43))
    await host.stop(true)
  })

  it('refuses secure credential IPC from a Host without the enterprise identity allowlist', async () => {
    const runtime = projectWithHost(`
      import { createServer } from 'node:http'
      const server = createServer((request, response) => {
        const onMessage = message => {
          if (message.type !== 'secure-store-response' || message.requestId !== 81) return
          process.off('message', onMessage)
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ success: message.success, value: message.value ?? null }))
        }
        process.on('message', onMessage)
        process.send({ type: 'secure-store-request', requestId: 81, operation: 'get', key: 'refresh' })
      })
      server.listen(0, '127.0.0.1', () => process.send({ type: 'ready', url: 'http://127.0.0.1:' + server.address().port }))
      process.on('message', message => {
        if (message.type === 'shutdown') server.close(() => { process.send({ type: 'shutdown-complete' }, () => process.disconnect()) })
      })
    `)
    const secureStore = {
      get: vi.fn(async () => 'A'.repeat(43)),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      saveActiveSession: vi.fn(async () => undefined),
      rotateRefresh: vi.fn(async () => true),
      clearActiveSession: vi.fn(async () => undefined),
      acknowledgeRevocation: vi.fn(async () => undefined),
      queueRevocation: vi.fn(async () => undefined),
    }
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env,
      undefined, undefined, undefined, undefined, secureStore)
    hosts.push(host)
    const { url } = await host.start()

    await expect((await fetch(url)).json()).resolves.toEqual({ success: false, value: null })
    expect(secureStore.get).not.toHaveBeenCalled()
    await host.stop(true)
  })

  it('buffers enterprise identity before delivery is enabled and then publishes later accepted generations', async () => {
    const runtime = projectWithHost(`
      import { createServer } from 'node:http'
      process.send({ type: 'enterprise-identity-change', state: { status: 'signed-out', generation: 1, pendingRevocation: false } })
      const server = createServer((request, response) => {
        if (request.url === '/next') process.send({ type: 'enterprise-identity-change', state: { status: 'signed-in', companyId: 'company-1', employeeId: 'employee-1', generation: 2, pendingRevocation: false } })
        if (request.url === '/same-generation') process.send({ type: 'enterprise-identity-change', state: { status: 'signed-in', companyId: 'company-1', employeeId: 'employee-1', generation: 2, pendingRevocation: true } })
        if (request.url === '/old') process.send({ type: 'enterprise-identity-change', state: { status: 'signed-out', generation: 1, pendingRevocation: true } })
        response.end('sent')
      })
      server.listen(0, '127.0.0.1', () => process.send({ type: 'ready', url: 'http://127.0.0.1:' + server.address().port }))
      process.on('message', message => {
        if (message.type === 'shutdown') server.close(() => { process.send({ type: 'shutdown-complete' }, () => process.disconnect()) })
      })
    `)
    const changed = vi.fn()
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env,
      undefined, undefined, undefined, undefined, undefined, undefined,
      ENTERPRISE_IDENTITY_ALLOWLIST, ENTERPRISE_IDENTITY_ALLOWLIST, changed)
    hosts.push(host)
    const { url } = await host.start()
    expect(changed).not.toHaveBeenCalled()
    host.flushPendingEnterpriseIdentity()
    expect(changed).toHaveBeenCalledWith({ status: 'signed-out', generation: 1, pendingRevocation: false })

    await fetch(new URL('/next', url))
    await expect.poll(() => changed.mock.calls.length).toBe(2)
    expect(changed).toHaveBeenLastCalledWith({ status: 'signed-in', companyId: 'company-1', employeeId: 'employee-1', generation: 2, pendingRevocation: false })
    await fetch(new URL('/same-generation', url))
    await expect.poll(() => changed.mock.calls.length).toBe(3)
    expect(changed).toHaveBeenLastCalledWith({ status: 'signed-in', companyId: 'company-1', employeeId: 'employee-1', generation: 2, pendingRevocation: true })
    await fetch(new URL('/old', url))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(changed).toHaveBeenCalledTimes(3)
    await host.stop(true)
  })

  it('contains enterprise identity listener failures and ignores shutdown-time identity events', async () => {
    const runtime = projectWithHost(`
      import { createServer } from 'node:http'
      const server = createServer((request, response) => {
        process.send({ type: 'enterprise-identity-change', state: { status: 'signed-out', generation: 1, pendingRevocation: false } })
        response.end('sent')
      })
      server.listen(0, '127.0.0.1', () => process.send({ type: 'ready', url: 'http://127.0.0.1:' + server.address().port }))
      process.on('message', message => {
        if (message.type !== 'shutdown') return
        process.send({ type: 'enterprise-identity-change', state: { status: 'signed-in', companyId: 'company-1', employeeId: 'employee-1', generation: 2, pendingRevocation: false } })
        server.close(() => { process.send({ type: 'shutdown-complete' }, () => process.disconnect()) })
      })
    `)
    const failures: Error[] = []
    const changed = vi.fn(() => { throw new Error('coordinator failed') })
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env,
      (error) => { failures.push(error) }, undefined, undefined, undefined, undefined, undefined,
      ENTERPRISE_IDENTITY_ALLOWLIST, ENTERPRISE_IDENTITY_ALLOWLIST, changed)
    hosts.push(host)
    const { url } = await host.start()
    host.flushPendingEnterpriseIdentity()
    await fetch(url)
    await expect.poll(() => failures.length).toBe(1)
    expect(failures[0]?.message).toMatch(/enterprise identity listener/u)
    await host.stop()
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('rejects enterprise identity events from non-enterprise Host processes', async () => {
    const runtime = projectWithHost(`
      process.send({ type: 'enterprise-identity-change', state: { status: 'signed-out', generation: 0, pendingRevocation: false } })
      process.send({ type: 'ready', url: 'http://127.0.0.1:3080/' })
    `)
    const host = hostProcess(runtime)
    await expect(host.start()).rejects.toThrow(/invalid IPC event/u)
  })

  it('opens HTTPS authorization URLs through the native system-browser callback', async () => {
    const runtime = projectWithHost(`
      import { createServer } from 'node:http'
      const server = createServer((request, response) => {
        const onMessage = message => {
          if (message.type !== 'browser-open-response' || message.requestId !== 71) return
          process.off('message', onMessage)
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ success: message.success }))
        }
        process.on('message', onMessage)
        process.send({ type: 'browser-open-request', requestId: 71, url: 'https://open.work.weixin.qq.com/oauth/authorize' })
      })
      server.listen(0, '127.0.0.1', () => process.send({ type: 'ready', url: 'http://127.0.0.1:' + server.address().port }))
      process.on('message', message => {
        if (message.type === 'shutdown') server.close(() => { process.send({ type: 'shutdown-complete' }, () => process.disconnect()) })
      })
    `)
    const opened: string[] = []
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env,
      undefined, undefined, undefined, undefined, undefined, async (url) => { opened.push(url) },
      ENTERPRISE_IDENTITY_ALLOWLIST, ENTERPRISE_IDENTITY_ALLOWLIST)
    hosts.push(host)
    const { url } = await host.start()

    await expect((await fetch(new URL('/open-browser', url))).json()).resolves.toEqual({ success: true })
    expect(opened).toEqual(['https://open.work.weixin.qq.com/oauth/authorize'])
    await host.stop(true)
  })

  it('refuses browser-open IPC from a Host without the enterprise identity allowlist', async () => {
    const runtime = projectWithHost(`
      import { createServer } from 'node:http'
      const server = createServer((request, response) => {
        const onMessage = message => {
          if (message.type !== 'browser-open-response' || message.requestId !== 82) return
          process.off('message', onMessage)
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ success: message.success }))
        }
        process.on('message', onMessage)
        process.send({ type: 'browser-open-request', requestId: 82, url: 'https://open.work.weixin.qq.com/oauth/authorize' })
      })
      server.listen(0, '127.0.0.1', () => process.send({ type: 'ready', url: 'http://127.0.0.1:' + server.address().port }))
      process.on('message', message => {
        if (message.type === 'shutdown') server.close(() => { process.send({ type: 'shutdown-complete' }, () => process.disconnect()) })
      })
    `)
    const opened: string[] = []
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env,
      undefined, undefined, undefined, undefined, undefined, async (url) => { opened.push(url) })
    hosts.push(host)
    const { url } = await host.start()

    await expect((await fetch(url)).json()).resolves.toEqual({ success: false })
    expect(opened).toEqual([])
    await host.stop(true)
  })

  it.each([
    "{ type: 'secure-store-request', requestId: 61, operation: 'get', key: 'invalid-key' }",
    "{ type: 'secure-store-request', requestId: 62, operation: 'rotate-refresh', expectedRefreshToken: 'A'.repeat(42), nextRefreshToken: 'B'.repeat(43) }",
    "{ type: 'secure-store-request', requestId: 63, operation: 'rotate-refresh', expectedRefreshToken: 'A'.repeat(43), nextRefreshToken: 'B'.repeat(43), value: 'extra' }",
  ])('rejects malformed secure-store IPC events before dispatch: %s', async (event) => {
    const runtime = projectWithHost(`
      import { createServer } from 'node:http'
      const server = createServer((request, response) => {
        process.send(${event})
        response.end('sent')
      })
      server.listen(0, '127.0.0.1', () => process.send({ type: 'ready', url: 'http://127.0.0.1:' + server.address().port }))
    `)
    let reportFailure!: (error: Error) => void
    const failure = new Promise<Error>((resolve) => { reportFailure = resolve })
    const secureStore = {
      get: vi.fn(async () => null), set: vi.fn(async () => undefined), delete: vi.fn(async () => undefined),
      saveActiveSession: vi.fn(async () => undefined), rotateRefresh: vi.fn(async () => true),
      clearActiveSession: vi.fn(async () => undefined),
      acknowledgeRevocation: vi.fn(async () => undefined), queueRevocation: vi.fn(async () => undefined),
    }
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env, reportFailure,
      undefined, undefined, undefined, secureStore)
    hosts.push(host)
    const { url } = await host.start()
    await expect(fetch(new URL('/invalid', url))).rejects.toThrow()
    expect((await failure).message).toMatch(/invalid IPC event/u)
    expect(secureStore.get).not.toHaveBeenCalled()
    expect(secureStore.rotateRefresh).not.toHaveBeenCalled()
  })

  it.each([
    'process.exit(17)',
    'process.exit(0)',
  ])('refuses installation when exit lacks successful teardown acknowledgement: %s', async (exit) => {
    const host = hostProcess(projectWithHost(`
      process.send({ type: 'ready', url: 'http://127.0.0.1:3080/' })
      process.on('message', message => {
        if (message.type === 'shutdown') process.stderr.write('token=fixture-secret', () => { ${exit} })
      })
    `))
    await host.start()
    const error = await host.stop(true).then(() => undefined, (error: unknown) => error)
    expect(error).toBeInstanceOf(DesktopHostUncleanExitError)
    expect(String(error)).toContain('shutdown acknowledged false')
    expect(String(error)).toContain('graceful deadline exceeded false')
    expect(String(error)).not.toContain('fixture-secret')
    await expect(host.stop()).resolves.toBeUndefined()
  })

  it('returns the Web authentication URL and waits for graceful shutdown', async () => {
    const runtime = projectWithHost()
    const failure = vi.fn()
    const host = hostProcess(runtime, runtime, failure)
    const ready = await host.start()
    expect(new URL(ready.url).searchParams.get('token')).toBe('fixture')
    expect(await host.start()).toEqual(ready)
    expect((await fetch(ready.url)).status).toBe(200)
    await host.stop()
    expect(existsSync(join(runtime, 'stopped'))).toBe(true)
    await expect(fetch(ready.url)).rejects.toThrow()
    expect(failure).not.toHaveBeenCalled()
  })

  it('passes external dependencies and package-manager paths to the Host', async () => {
    const runtime = projectWithHost(HTTP_HOST.replace('runtime: process.argv[2]',
      'pnpm: process.argv[5], nodeBin: process.argv[6], primaryRuntime: process.argv[4], runtime: process.argv[2]'))
    const primaryRuntime = join(runtime, 'external-primary-runtime')
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env,
      undefined, primaryRuntime, { pnpm: join(runtime, 'pnpm.mjs'), nodeBin: join(runtime, 'bin') })
    hosts.push(host)
    const { url } = await host.start()
    expect(await (await fetch(url)).json()).toMatchObject({ primaryRuntime, pnpm: join(runtime, 'pnpm.mjs'), nodeBin: join(runtime, 'bin') })
  })

  it('reports a fatal event after readiness once', async () => {
    const runtime = projectWithHost()
    const failure = vi.fn()
    const host = hostProcess(runtime, runtime, failure)
    const { url } = await host.start()
    await fetch(new URL('/fatal', url))
    await expect.poll(() => failure.mock.calls.length).toBe(1)
    await host.stop()
    expect(failure).toHaveBeenCalledTimes(1)
    expect(failure).toHaveBeenCalledWith(new Error('plugin unavailable'))
  })

  it('reports a child crash after readiness with its stderr diagnostic', async () => {
    const runtime = projectWithHost()
    const failure = vi.fn()
    const host = hostProcess(runtime, runtime, failure)
    const { url } = await host.start()
    await fetch(new URL('/crash', url))
    await expect.poll(() => failure.mock.calls.length).toBe(1)
    expect(failure).toHaveBeenCalledWith(new Error('dsh desktop host exited with 7: plugin crashed'))
  })

  it('retains only recent diagnostics from a noisy child', async () => {
    const runtime = projectWithHost('process.stderr.write(\'discarded-prefix\' + \'x\'.repeat(70_000) + \'recent-failure\', () => { process.exitCode = 7; process.disconnect() })')
    const failure = await hostProcess(runtime).start().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).not.toContain('discarded-prefix')
    expect(message.endsWith('recent-failure')).toBe(true)
    expect(message.length).toBeLessThan(66_000)
  })

  it('settles teardown when the executable cannot be spawned', async () => {
    const runtime = projectWithHost()
    const host = new DesktopHostProcess(join(runtime, 'missing-node'), runtime, runtime)
    hosts.push(host)
    await expect(host.start()).rejects.toThrow()
    await host.stop()
  })

  it('loads the resource entry with a separate profile and inherits runtime and package-manager configuration', async () => {
    const runtime = projectWithHost()
    const profile = mkdtempSync(join(tmpdir(), 'desktop-external-profile-'))
    roots.push(profile)
    const host = hostProcess(runtime, profile, undefined, {
      ...process.env, NODE_OPTIONS: '--no-warnings', NODE_PATH: '/custom', NPM_CONFIG_REGISTRY: 'https://registry.example.test/',
    })
    const { url } = await host.start()
    const response = await fetch(url)
    expect(await response.json()).toEqual({ runtime, profile, cwd: realpathSync(profile), nodePath: '/custom', registry: 'https://registry.example.test/', nodeOptions: '--no-warnings', runAsNode: '1', internals: true })
  })

  it.each([
    ["process.send({ type: 'fatal', message: 'startup failed' }); process.disconnect()", 'startup failed'],
    ["process.send({ type: 'ready', url: 4 })", 'invalid IPC event'],
    ["process.send({ type: 'fatal', message: 'startup failed', diagnostic: 42 })", 'invalid IPC event'],
    ['process.exit(0)', 'host stopped'],
  ])('rejects startup when the child fails before readiness: %s', async (source, message) => {
    const host = hostProcess(projectWithHost(source))
    await expect(host.start()).rejects.toThrow(message)
  })

  it('keeps the Host\'s inspected error separate from the message it reports', async () => {
    const diagnostic = "Error: startup failed\\n    at boot (lib/index.js:3:9) {\\n  code: 'ENOENT',\\n  path: '/profile/cordis.yml'\\n}"
    const failures: Error[] = []
    const host = hostProcess(projectWithHost(
      `process.send({ type: 'fatal', message: 'startup failed', diagnostic: ${JSON.stringify(diagnostic)} }); process.disconnect()`,
    ), undefined, (error) => { failures.push(error) })
    await expect(host.start()).rejects.toThrow('startup failed')
    const [failure] = failures
    expect(failure).toBeInstanceOf(DesktopHostFatalError)
    expect((failure as DesktopHostFatalError).diagnostic).toBe(diagnostic)
    expect(Object.keys(failure!)).not.toContain('diagnostic')
  })
})

it.each([null, 'stable-account'])('carries Platform identity %s over private IPC and clears credentials on shutdown', async (userId) => {
  const runtime = projectWithHost(HTTP_HOST.replace("process.send({ type: 'ready'", "process.send({ type: 'platform-session', session: { origin: 'https://platform.deepseek.com', userId: " + JSON.stringify(userId) + ", token: 'fixture-secret', embeddedPageDist: 'feat/test' } }); process.send({ type: 'ready'"))
  const changed = vi.fn()
  const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env, undefined, undefined, undefined, changed)
  hosts.push(host)
  await host.start()
  expect(changed).toHaveBeenCalledWith({ origin: 'https://platform.deepseek.com', userId, token: 'fixture-secret', embeddedPageDist: 'feat/test' })
  await host.stop()
  expect(changed).toHaveBeenLastCalledWith(null)
})

it.each([undefined, '', 7])('rejects malformed Platform account identity %s on private IPC', async (userId) => {
  const session = { origin: 'https://platform.deepseek.com', token: 'fixture-secret', userId }
  const runtime = projectWithHost(HTTP_HOST.replace("process.send({ type: 'ready'",
    `process.send({ type: 'platform-session', session: ${JSON.stringify(session)} }); process.send({ type: 'ready'`))
  const changed = vi.fn()
  const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env, undefined, undefined, undefined, changed)
  hosts.push(host)
  await expect(host.start()).rejects.toThrow('invalid IPC event')
  expect(changed.mock.calls).toEqual([[null]])
  await host.stop()
})
