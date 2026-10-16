import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'
import { ENTERPRISE_WELCOME_IPC } from '../src/welcome-api.ts'

const electron = vi.hoisted(() => ({
  create: vi.fn<(options: unknown) => ReturnType<typeof createWindow>>(),
  handlers: new Map<string, (event: unknown, value?: unknown) => Promise<unknown>>(),
}))
vi.mock('electron', () => ({
  app: { getAppPath: () => '/desktop-app' },
  BrowserWindow: vi.fn(function (options: unknown) { return electron.create(options) }),
  ipcMain: {
    handle: (name: string, handler: (event: unknown, value?: unknown) => Promise<unknown>) => {
      if (electron.handlers.has(name)) throw new Error(`duplicate IPC handler: ${name}`)
      electron.handlers.set(name, handler)
    },
    removeHandler: (name: string) => electron.handlers.delete(name),
  },
}))

const { enterpriseWelcomeWindowOptions, openEnterpriseWelcomeWindow } = await import('../src/welcome-window.ts')

function createWindow() {
  return {
    webContents: {
      mainFrame: {},
      setWindowOpenHandler: vi.fn(),
      on: vi.fn<(name: string, handler: (event: { preventDefault(): void }) => void) => void>(),
    },
    loadFile: vi.fn().mockResolvedValue(undefined),
    isDestroyed: vi.fn().mockReturnValue(false),
    destroy: vi.fn(),
    show: vi.fn(),
    once: vi.fn<(name: string, callback: () => void) => void>(),
  }
}

const signedOut = { status: 'signed-out' as const, generation: 1, pendingRevocation: false }
const signedIn = { status: 'signed-in' as const, companyId: 'company', employeeId: 'employee', generation: 2, pendingRevocation: false }
const attemptId = 'c1caeac9-5ea9-45b3-805e-12a2e6d08287'

beforeEach(() => { electron.create.mockReset(); electron.handlers.clear() })

describe('enterprise welcome window', () => {
  it('uses a sandboxed local document and an enterprise-only preload mode', async () => {
    const options = enterpriseWelcomeWindowOptions('darwin', resolveDesktopLocale('zh-CN'))
    expect(options.webPreferences).toMatchObject({
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      additionalArguments: ['--dsh-welcome-locale=zh-CN', '--dsh-welcome-mode=enterprise'],
    })
    expect(options.webPreferences?.preload).toMatch(/preload-welcome\.cjs$/u)
    const window = createWindow()
    electron.create.mockReturnValue(window)
    await openEnterpriseWelcomeWindow(resolveDesktopLocale('zh-CN'), {
      read: async () => signedOut,
      beginLogin: async () => ({ attemptId }),
      beginQrLogin: async () => ({ attemptId, qrUrl: 'https://open.work.weixin.qq.com/wwopen/sso/qrConnect?state=test' }),
      finishLogin: async () => ({ status: 'pending' }),
      onSignedIn: vi.fn(),
    })
    expect(window.loadFile).toHaveBeenCalledWith(join('/desktop-app', 'renderer', 'enterprise-welcome.html'))
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.webContents.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({ action: 'deny' })
    const event = { preventDefault: vi.fn() }
    window.webContents.on.mock.calls[0]![1](event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect([...electron.handlers.keys()].sort()).toEqual(Object.values(ENTERPRISE_WELCOME_IPC).sort())
  })

  it('rejects another sender, an invalid attempt, and only enters workspace after a verified signed-in state', async () => {
    const window = createWindow()
    electron.create.mockReturnValue(window)
    const read = vi.fn().mockResolvedValueOnce(signedOut).mockResolvedValueOnce(signedIn)
    const finishLogin = vi.fn().mockResolvedValue({ status: 'signed-in' })
    const onSignedIn = vi.fn()
    await openEnterpriseWelcomeWindow(resolveDesktopLocale('en'), {
      read, beginLogin: async () => ({ attemptId }), beginQrLogin: async () => ({ attemptId, qrUrl: 'https://open.work.weixin.qq.com/wwopen/sso/qrConnect?state=test' }), finishLogin, onSignedIn,
    })
    const own = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    await expect(electron.handlers.get(ENTERPRISE_WELCOME_IPC.read)!({ ...own, senderFrame: {} })).rejects.toThrow('unowned frame')
    expect(read).not.toHaveBeenCalled()
    expect(await electron.handlers.get(ENTERPRISE_WELCOME_IPC.read)!(own)).toEqual(signedOut)
    await expect(electron.handlers.get(ENTERPRISE_WELCOME_IPC.finish)!(own, '../bad')).rejects.toThrow('invalid attempt')
    expect(finishLogin).not.toHaveBeenCalled()
    expect(await electron.handlers.get(ENTERPRISE_WELCOME_IPC.begin)!(own)).toEqual({ attemptId })
    expect(await electron.handlers.get(ENTERPRISE_WELCOME_IPC.finish)!(own, attemptId)).toEqual({ status: 'signed-in' })
    expect(finishLogin).toHaveBeenCalledExactlyOnceWith(attemptId)
    expect(onSignedIn).toHaveBeenCalledExactlyOnceWith(signedIn)
    window.once.mock.calls[0]![1]()
    expect(electron.handlers.size).toBe(0)
  })

  it('does not enter workspace if a signed-in result lacks confirmed identity', async () => {
    const window = createWindow()
    electron.create.mockReturnValue(window)
    const onSignedIn = vi.fn()
    await openEnterpriseWelcomeWindow(resolveDesktopLocale('en'), {
      read: async () => signedOut,
      beginLogin: async () => ({ attemptId }),
      beginQrLogin: async () => ({ attemptId, qrUrl: 'https://open.work.weixin.qq.com/wwopen/sso/qrConnect?state=test' }),
      finishLogin: async () => ({ status: 'signed-in' }),
      onSignedIn,
    })
    const own = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    await expect(electron.handlers.get(ENTERPRISE_WELCOME_IPC.finish)!(own, attemptId)).rejects.toThrow('identity state')
    expect(onSignedIn).not.toHaveBeenCalled()
  })

  it('enters once when a session is already signed in before the window reads state', async () => {
    const window = createWindow()
    electron.create.mockReturnValue(window)
    const onSignedIn = vi.fn()
    await openEnterpriseWelcomeWindow(resolveDesktopLocale('en'), {
      read: async () => signedIn,
      beginLogin: async () => ({ attemptId }),
      beginQrLogin: async () => ({ attemptId, qrUrl: 'https://open.work.weixin.qq.com/wwopen/sso/qrConnect?state=test' }),
      finishLogin: async () => ({ status: 'signed-in' }),
      onSignedIn,
    })
    const own = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    expect(await electron.handlers.get(ENTERPRISE_WELCOME_IPC.read)!(own)).toEqual(signedIn)
    await electron.handlers.get(ENTERPRISE_WELCOME_IPC.finish)!(own, attemptId)
    expect(onSignedIn).toHaveBeenCalledExactlyOnceWith(signedIn)
  })
})
