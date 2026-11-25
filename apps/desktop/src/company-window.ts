/** Pre-Host company picker window; no Host or account backend is required. */
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { DesktopLocale } from './locale.ts'
import { COMPANY_PICKER_IPC, type CompanyPickerOperations } from './welcome-api.ts'
import { welcomeWindowOptions } from './welcome-window.ts'

const COMPANY_ID = /^[A-Za-z0-9_-]{1,128}$/u

/**
 * Open the signed company picker and resolve the selected company identifier.
 * @param locale - shell-owned localized copy.
 * @param operations - read-only signed company list with session state.
 * @param productName - neutral packaged product name.
 * @returns the selected company identifier, or undefined when the window closes.
 */
export async function openCompanyPickerWindow(
  locale: DesktopLocale, operations: CompanyPickerOperations, productName = 'DeepSeek Harness',
): Promise<string | undefined> {
  const base = welcomeWindowOptions(process.platform, locale, productName)
  const window = new BrowserWindow({
    ...base,
    webPreferences: {
      ...base.webPreferences,
      additionalArguments: [
        ...(base.webPreferences?.additionalArguments ?? []),
        '--dsh-welcome-mode=company-picker',
      ],
    },
  })
  let settled = false
  let resolveSelection: (value: string | undefined) => void = () => {}
  const selected = new Promise<string | undefined>((resolve) => { resolveSelection = resolve })
  const finish = (value: string | undefined): void => {
    if (settled) return
    settled = true
    resolveSelection(value)
    if (!window.isDestroyed()) window.close()
  }
  const dispose = (): void => {
    for (const channel of Object.values(COMPANY_PICKER_IPC)) ipcMain.removeHandler(channel)
  }
  const assertSender = (event: IpcMainInvokeEvent): void => {
    if (settled || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('desktop company picker: rejected action from an unowned frame')
    }
  }
  ipcMain.handle(COMPANY_PICKER_IPC.list, (event) => {
    assertSender(event)
    return operations.list()
  })
  ipcMain.handle(COMPANY_PICKER_IPC.select, (event, companyId: unknown) => {
    assertSender(event)
    if (typeof companyId !== 'string' || !COMPANY_ID.test(companyId)) {
      throw new Error('desktop company picker: invalid company identifier')
    }
    finish(companyId)
  })
  ipcMain.handle(COMPANY_PICKER_IPC.cancel, (event) => {
    assertSender(event)
    finish(undefined)
  })
  window.once('closed', () => {
    dispose()
    if (!settled) {
      settled = true
      resolveSelection(undefined)
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => { event.preventDefault() })
  try {
    await window.loadFile(join(app.getAppPath(), 'renderer', 'welcome.html'))
  } catch (error) {
    dispose()
    if (!window.isDestroyed()) window.destroy()
    throw error
  }
  if (!window.isDestroyed()) window.show()
  return selected
}
