import type { AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
/** Localized welcome copy and write-only credential actions. */

import { contextBridge, ipcRenderer } from 'electron'
import { resolveDesktopLocale } from './locale.ts'
import { ENTERPRISE_WELCOME_EVENT, ENTERPRISE_WELCOME_IPC, WELCOME_IPC, type EnterpriseLoginResult, type EnterpriseWelcomeApi, type WelcomeApi, type WelcomeNotice, type WelcomeSaveResult } from './welcome-api.ts'
import type { EnterpriseIdentityState } from './enterprise-identity-state.ts'

const prefix = '--dsh-welcome-locale='
const locale = process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length)
if (locale === undefined) throw new Error('desktop welcome: missing window locale')
const mode = process.argv.includes('--dsh-welcome-mode=enterprise') ? 'enterprise' : 'official'
if (mode === 'enterprise') {
  const enterpriseApi: EnterpriseWelcomeApi = {
    ...resolveDesktopLocale(locale),
    mode: 'enterprise',
    read: () => ipcRenderer.invoke(ENTERPRISE_WELCOME_IPC.read) as Promise<EnterpriseIdentityState>,
    beginLogin: () => ipcRenderer.invoke(ENTERPRISE_WELCOME_IPC.begin) as Promise<{ readonly attemptId: string }>,
    beginQrLogin: () => ipcRenderer.invoke(ENTERPRISE_WELCOME_IPC.beginQr) as Promise<{ readonly attemptId: string; readonly qrUrl: string }>,
    finishLogin: (attemptId: string) => ipcRenderer.invoke(ENTERPRISE_WELCOME_IPC.finish, attemptId) as Promise<EnterpriseLoginResult>,
    onConfirmed: (listener) => {
      const receive = (): void => { listener() }
      ipcRenderer.on(ENTERPRISE_WELCOME_EVENT.confirmed, receive)
      return () => { ipcRenderer.removeListener(ENTERPRISE_WELCOME_EVENT.confirmed, receive) }
    },
  }
  contextBridge.exposeInMainWorld('dshEnterpriseWelcome', enterpriseApi)
} else {
const api: WelcomeApi = {
  ...resolveDesktopLocale(locale),
  analytics: async (eventName, attributes) => {
    if (await api.analyticsEnabled()) await ipcRenderer.invoke(WELCOME_IPC.analytics, eventName, attributes)
  },
  analyticsEnabled: () => ipcRenderer.invoke(WELCOME_IPC.analyticsEnabled) as Promise<boolean>,
  takeNotice: () => ipcRenderer.invoke(WELCOME_IPC.takeNotice) as Promise<WelcomeNotice | undefined>,
  startSignIn: () => ipcRenderer.invoke(WELCOME_IPC.start) as Promise<AccountView>,
  cancelSignIn: (id: SignInAttemptId) => ipcRenderer.invoke(WELCOME_IPC.cancel, id) as Promise<AccountView>,
  copySignInLink: (id: SignInAttemptId) => ipcRenderer.invoke(WELCOME_IPC.copyLink, id) as Promise<void>,
  onAccountState: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, state: AccountView): void =>{  listener(state) }
    ipcRenderer.on(WELCOME_IPC.state, receive)
    return () => { ipcRenderer.removeListener(WELCOME_IPC.state, receive) }
  },
  saveApiKey: (value: string) => ipcRenderer.invoke(WELCOME_IPC.saveApiKey, value) as Promise<WelcomeSaveResult>,
  skip: () => ipcRenderer.invoke(WELCOME_IPC.skip) as Promise<void>,
}
contextBridge.exposeInMainWorld('dshWelcome', api)
}
