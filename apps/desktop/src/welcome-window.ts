import type { SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
/** Native welcome window and its presentation-only renderer. */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, session, type BrowserWindowConstructorOptions, type IpcMainInvokeEvent } from 'electron'
import type { DesktopLocale } from './locale.ts'
import { ENTERPRISE_WELCOME_EVENT, ENTERPRISE_WELCOME_IPC, WELCOME_IPC, type EnterpriseWelcomeOperations, type WelcomeOperations } from './welcome-api.ts'

const ENTERPRISE_ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

function qrCallback(qrUrl: string): Readonly<{ origin: string; pathname: string; state: string; appid: string }> {
  const qr = new URL(qrUrl)
  if (qr.origin !== 'https://open.work.weixin.qq.com' || qr.pathname !== '/wwopen/sso/qrConnect') {
    throw new Error('desktop enterprise welcome: invalid QR login origin')
  }
  const callback = new URL(qr.searchParams.get('redirect_uri') ?? '')
  const state = qr.searchParams.get('state')
  const appid = qr.searchParams.get('appid')
  if (callback.protocol !== 'https:' || callback.username || callback.password || callback.search || callback.hash
    || callback.pathname !== '/api/enterprise/v1/auth/wecom/callback' || !state || !/^[A-Za-z0-9_-]{43}$/u.test(state)
    || !appid || !/^[A-Za-z0-9_-]{1,128}$/u.test(appid)) {
    throw new Error('desktop enterprise welcome: invalid QR login callback')
  }
  return { origin: callback.origin, pathname: callback.pathname, state, appid }
}

function matchingQrCallback(candidate: string, expected: ReturnType<typeof qrCallback>): boolean {
  try {
    const url = new URL(candidate)
    return url.origin === expected.origin && url.pathname === expected.pathname
      && !url.username && !url.password && !url.hash
      && url.searchParams.getAll('code').length === 1 && !!url.searchParams.get('code')
      && url.searchParams.getAll('state').length === 1 && url.searchParams.get('state') === expected.state
      && url.searchParams.getAll('appid').length === 1 && url.searchParams.get('appid') === expected.appid
      && [...url.searchParams.keys()].every(key => key === 'code' || key === 'state' || key === 'appid')
  } catch { return false }
}

/**
 * Resolve the fixed-size welcome window's native material and controls.
 * @param platform - operating system hosting Electron.
 * @param locale - shell-owned localized copy.
 * @returns sandboxed window options with a locale-only preload.
 */
export function welcomeWindowOptions(platform: NodeJS.Platform, locale: DesktopLocale): BrowserWindowConstructorOptions {
  return {
    width: 600,
    height: 700,
    useContentSize: true,
    center: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: locale.messages.welcomeTitle,
    backgroundColor: platform === 'darwin' || platform === 'win32' ? '#00000000' : '#FFFFFF',
    ...(platform === 'darwin' ? {
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 21, y: 21 },
      vibrancy: 'menu',
      visualEffectState: 'active',
    } as const : {}),
    ...(platform === 'win32' ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#00000000', symbolColor: '#0F1115', height: 42 },
      backgroundMaterial: 'acrylic',
    } as const : {}),
    webPreferences: {
      preload: fileURLToPath(new URL('./preload-welcome.cjs', import.meta.url)),
      additionalArguments: [`--dsh-welcome-locale=${locale.id}`],
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  }
}

let disposeActiveHandlers: (() => void) | undefined

/** Same local, sandboxed document with an enterprise-only preload surface. */
export function enterpriseWelcomeWindowOptions(platform: NodeJS.Platform, locale: DesktopLocale): BrowserWindowConstructorOptions {
  const options = welcomeWindowOptions(platform, locale)
  return {
    ...options,
    title: locale.id === 'zh-CN' ? 'DeepSeek Harness 企业版' : 'DeepSeek Harness Enterprise',
    webPreferences: {
      ...options.webPreferences,
      partition: 'enterprise-welcome',
      additionalArguments: [`--dsh-welcome-locale=${locale.id}`, '--dsh-welcome-mode=enterprise'],
    },
  }
}

/** Open enterprise sign-in without installing any personal-account or API-key IPC handlers. */
export async function openEnterpriseWelcomeWindow(locale: DesktopLocale, operations: EnterpriseWelcomeOperations): Promise<BrowserWindow> {
  await session.fromPartition('enterprise-welcome').setProxy({ mode: 'direct' }).catch(() => {
    /* The system proxy remains; the QR page reports its own load failure. */
  })
  const window = new BrowserWindow(enterpriseWelcomeWindowOptions(process.platform, locale))
  disposeActiveHandlers?.()
  let active = true
  let transition: Promise<void> | undefined
  let expectedQrCallback: ReturnType<typeof qrCallback> | undefined
  let callbackForwarded = false
  let confirmedForwarded = false
  const notifyConfirmed = (): void => {
    if (confirmedForwarded || window.isDestroyed()) return
    confirmedForwarded = true
    window.webContents.send(ENTERPRISE_WELCOME_EVENT.confirmed)
  }
  const enterWorkspace = (state: Awaited<ReturnType<EnterpriseWelcomeOperations['read']>>): Promise<void> => {
    if (state.status !== 'signed-in') throw new Error('desktop enterprise welcome: unconfirmed identity state')
    transition ??= Promise.resolve().then(() => operations.onSignedIn(state))
    return transition
  }
  const disposeHandlers = (): void => {
    if (!active) return
    active = false
    for (const channel of Object.values(ENTERPRISE_WELCOME_IPC)) ipcMain.removeHandler(channel)
    disposeActiveHandlers = undefined
  }
  disposeActiveHandlers = disposeHandlers
  const assertSender = (event: IpcMainInvokeEvent): void => {
    if (!active || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('desktop enterprise welcome: rejected action from an unowned frame')
    }
  }
  ipcMain.handle(ENTERPRISE_WELCOME_IPC.read, async (event) => {
    assertSender(event)
    const state = await operations.read()
    if (state.status === 'signed-in') await enterWorkspace(state)
    return state
  })
  ipcMain.handle(ENTERPRISE_WELCOME_IPC.begin, (event) => {
    assertSender(event)
    expectedQrCallback = undefined
    confirmedForwarded = false
    return operations.beginLogin()
  })
  ipcMain.handle(ENTERPRISE_WELCOME_IPC.beginQr, async (event) => {
    assertSender(event)
    expectedQrCallback = undefined
    confirmedForwarded = false
    const result = await operations.beginQrLogin()
    expectedQrCallback = qrCallback(result.qrUrl)
    callbackForwarded = false
    return result
  })
  ipcMain.handle(ENTERPRISE_WELCOME_IPC.finish, async (event, attemptId: unknown) => {
    assertSender(event)
    if (typeof attemptId !== 'string' || !ENTERPRISE_ATTEMPT_ID.test(attemptId)) {
      throw new Error('desktop enterprise welcome: invalid attempt')
    }
    const result = await operations.finishLogin(attemptId)
    if (result.status === 'signed-in') {
      await enterWorkspace(await operations.read())
    }
    return result
  })
  window.once('closed', disposeHandlers)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault()
    const expected = expectedQrCallback
    if (!active || !expected || callbackForwarded || !matchingQrCallback(event.url, expected)) return
    callbackForwarded = true
    notifyConfirmed()
    // WeCom redirects the embedded QR page through the top frame. Keep the
    // trusted local welcome page alive while completing the one-time callback.
    void fetch(event.url, { redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(10_000) })
      .then(response => { if (!response.ok) callbackForwarded = false })
      .catch(() => { callbackForwarded = false })
  })
  window.webContents.on('will-frame-navigate', (details) => {
    const expected = expectedQrCallback
    if (!active || !expected || details.isMainFrame || !matchingQrCallback(details.url, expected)) return
    notifyConfirmed()
  })
  try {
    await window.loadFile(join(app.getAppPath(), 'renderer', 'enterprise-welcome.html'))
  } catch (error) {
    disposeHandlers()
    if (!window.isDestroyed()) window.destroy()
    throw error
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Another window can replace ownership during loadFile.
  if (active && !window.isDestroyed()) window.show()
  return window
}

/**
 * Open the process's sole welcome window with desktop-owned operations.
 * Replaces IPC ownership immediately; the caller closes the previous native window.
 * @param locale - shell-owned localized copy.
 * @param operations - credential write and this-launch-only skip actions.
 * @returns the visible window; a failed load destroys it before rejecting.
 */
export async function openWelcomeWindow(locale: DesktopLocale, operations: WelcomeOperations): Promise<BrowserWindow> {
  const options = welcomeWindowOptions(process.platform, locale)
  const window = new BrowserWindow(options)
  disposeActiveHandlers?.()
  let active = true
  const disposeHandlers = (): void => {
    if (!active) return
    active = false
    for (const channel of [
      WELCOME_IPC.analyticsEnabled, WELCOME_IPC.analytics, WELCOME_IPC.takeNotice, WELCOME_IPC.saveApiKey,
      WELCOME_IPC.skip, WELCOME_IPC.start, WELCOME_IPC.cancel, WELCOME_IPC.copyLink,
    ]) {
      ipcMain.removeHandler(channel)
    }
    disposeActiveHandlers = undefined
  }
  disposeActiveHandlers = disposeHandlers
  const assertSender = (event: IpcMainInvokeEvent): void => {
    if (!active || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('desktop welcome: rejected action from an unowned frame')
    }
  }
  ipcMain.handle(WELCOME_IPC.analyticsEnabled, (event) => {
    assertSender(event)
    return operations.analyticsEnabled()
  })
  ipcMain.handle(WELCOME_IPC.analytics, async (event, eventName: unknown, attributes: unknown) => {
    assertSender(event)
    if (typeof attributes !== 'object' || attributes === null || Array.isArray(attributes)) throw new Error('desktop welcome: invalid analytics attributes')
    if (eventName === 'auth_page_click' && 'button_name' in attributes && Object.keys(attributes).length === 1
      && (attributes.button_name === 'sign_in' || attributes.button_name === 'api-key')) {
      await operations.analytics?.(eventName, { button_name: attributes.button_name })
    } else if ((eventName === 'auth_page_view' || eventName === 'api_key_save_click') && Object.keys(attributes).length === 0) {
      await operations.analytics?.(eventName, {})
    } else throw new Error('desktop welcome: invalid analytics event')
  })
  ipcMain.handle(WELCOME_IPC.takeNotice, async (event) => { assertSender(event); return operations.takeNotice() })
  ipcMain.handle(WELCOME_IPC.saveApiKey, async (event, value: unknown) => {
    assertSender(event)
    if (typeof value !== 'string' || !/^[\x21-\x7e]+$/.test(value)) return { ok: false }
    return operations.saveApiKey(value)
  })
  ipcMain.handle(WELCOME_IPC.skip, async (event) => {
    assertSender(event)
    await operations.skip()
  })
  ipcMain.handle(WELCOME_IPC.start, async (event) => { assertSender(event); return operations.startSignIn() })
  ipcMain.handle(WELCOME_IPC.cancel, async (event, id: unknown) => {
    assertSender(event)
    if (typeof id !== 'string') throw new Error('desktop welcome: invalid attempt')
    return operations.cancelSignIn(id as SignInAttemptId)
  })
  ipcMain.handle(WELCOME_IPC.copyLink, async (event, id: unknown) => {
    assertSender(event)
    if (typeof id !== 'string') throw new Error('desktop welcome: invalid attempt')
    return operations.copySignInLink(id as SignInAttemptId)
  })
  window.once('closed', disposeHandlers)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => { event.preventDefault() })
  try {
    await window.loadFile(join(app.getAppPath(), 'renderer', 'welcome.html'))
  } catch (error) {
    disposeHandlers()
    if (!window.isDestroyed()) window.destroy()
    throw error
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Another window can replace ownership during loadFile.
  if (active && !window.isDestroyed()) {
    window.show()
    void operations.analytics?.('auth_page_view', {})
  }
  return window
}
