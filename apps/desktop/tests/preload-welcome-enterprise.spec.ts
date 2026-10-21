import { afterEach, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoke: vi.fn(),
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, value: unknown) => electron.exposed.set(name, value) },
  ipcRenderer: { invoke: electron.invoke, on: vi.fn(), removeListener: vi.fn() },
}))

const originalArgs = process.argv
afterEach(() => {
  process.argv = originalArgs
  electron.exposed.clear()
  vi.resetModules()
})

it('exposes only the enterprise login bridge in enterprise mode', async () => {
  process.argv = ['electron', '--dsh-welcome-locale=zh-CN', '--dsh-welcome-mode=enterprise', '--dsh-product-name=Ruqinba Harness']
  await import('../src/preload-welcome.ts')
  expect([...electron.exposed.keys()]).toEqual(['dshEnterpriseWelcome'])
  const bridge = electron.exposed.get('dshEnterpriseWelcome') as Record<string, unknown>
  expect(Object.keys(bridge).sort()).toEqual(['beginLogin', 'beginQrLogin', 'finishLogin', 'id', 'messages', 'mode', 'onConfirmed', 'productName', 'read'].sort())
  expect(bridge.mode).toBe('enterprise')
  expect(bridge.productName).toBe('Ruqinba Harness')
  for (const name of ['saveApiKey', 'skip', 'startSignIn', 'copySignInLink', 'onAccountState']) {
    expect(bridge).not.toHaveProperty(name)
  }
})

it('keeps the personal welcome bridge unchanged without enterprise mode', async () => {
  process.argv = ['electron', '--dsh-welcome-locale=en']
  await import('../src/preload-welcome.ts')
  expect([...electron.exposed.keys()]).toEqual(['dshWelcome'])
  const bridge = electron.exposed.get('dshWelcome') as Record<string, unknown>
  expect(bridge).toHaveProperty('saveApiKey')
  expect(bridge).not.toHaveProperty('beginLogin')
})
