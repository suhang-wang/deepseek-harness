import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'
import { COMPANY_PICKER_IPC } from '../src/welcome-api.ts'

const electron = vi.hoisted(() => ({
  options: [] as unknown[],
  windows: [] as FakeWindow[],
  handlers: new Map<string, (event: unknown, value?: unknown) => unknown>(),
}))

class FakeWindow extends EventEmitter {
  destroyed = false
  readonly webContents = { mainFrame: {}, setWindowOpenHandler: vi.fn(), on: vi.fn() }
  readonly loadFile = vi.fn(async () => undefined)
  readonly show = vi.fn()
  readonly close = vi.fn(() => {
    this.destroyed = true
    this.emit('closed')
  })
  isDestroyed(): boolean { return this.destroyed }
}

vi.mock('electron', () => ({
  app: { getAppPath: () => '/desktop-app' },
  BrowserWindow: vi.fn(function (options: unknown) {
    const window = new FakeWindow()
    electron.options.push(options)
    electron.windows.push(window)
    return window
  }),
  session: { fromPartition: () => ({ setProxy: vi.fn(async () => undefined) }) },
  ipcMain: {
    handle: (name: string, handler: (event: unknown, value?: unknown) => unknown) => {
      if (electron.handlers.has(name)) throw new Error(`duplicate IPC handler: ${name}`)
      electron.handlers.set(name, handler)
    },
    removeHandler: (name: string) => electron.handlers.delete(name),
  },
}))

const { openCompanyPickerWindow } = await import('../src/company-window.ts')
const companies = [
  { companyId: 'company-a', displayName: 'A 公司', signedIn: true, lastUsed: true },
  { companyId: 'company-b', displayName: 'B 公司', signedIn: false, lastUsed: false },
]

beforeEach(() => {
  electron.options.length = 0
  electron.windows.length = 0
  electron.handlers.clear()
})

describe('company picker window', () => {
  it('opens the local welcome document in company-picker mode and cancels cleanly', async () => {
    const selection = openCompanyPickerWindow(resolveDesktopLocale('zh-CN'), { list: async () => companies }, '企业工作台')
    const window = electron.windows[0]!
    expect(electron.options[0]).toMatchObject({
      title: '企业工作台',
      webPreferences: {
        nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
        additionalArguments: [
          '--dsh-welcome-locale=zh-CN', '--dsh-product-name=企业工作台', '--dsh-welcome-mode=company-picker',
        ],
      },
    })
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    await expect(electron.handlers.get(COMPANY_PICKER_IPC.list)!(event)).resolves.toEqual(companies)
    expect(window.webContents.setWindowOpenHandler).toHaveBeenCalledOnce()
    const navigation = window.webContents.on.mock.calls
      .find(([name]) => name === 'will-navigate')?.[1] as ((event: { preventDefault: () => void }) => void) | undefined
    expect(navigation).toBeDefined()
    const preventDefault = vi.fn()
    navigation!({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    electron.handlers.get(COMPANY_PICKER_IPC.cancel)!(event)
    await expect(selection).resolves.toBeUndefined()
    expect(window.close).toHaveBeenCalledOnce()
    expect(electron.handlers.size).toBe(0)
  })

  it('returns a selected company and rejects an invalid identifier', async () => {
    const selection = openCompanyPickerWindow(resolveDesktopLocale('en'), { list: async () => companies })
    const window = electron.windows[0]!
    await vi.waitFor(() => { expect(window.show).toHaveBeenCalledOnce() })
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    expect(() => electron.handlers.get(COMPANY_PICKER_IPC.select)!(event, '../escape')).toThrow(/invalid company/u)
    electron.handlers.get(COMPANY_PICKER_IPC.select)!(event, 'company-b')
    await expect(selection).resolves.toBe('company-b')
    expect(window.loadFile).toHaveBeenCalledWith(join('/desktop-app', 'renderer', 'welcome.html'))
  })
})
