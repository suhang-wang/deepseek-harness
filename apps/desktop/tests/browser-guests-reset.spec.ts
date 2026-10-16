import { EventEmitter } from 'node:events'
import type { BrowserWindow, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { DesktopBrowserGuests } from '../src/browser-guests.ts'

vi.mock('electron', () => ({ app: { isPackaged: false }, session: { fromPartition: () => Object.assign(new EventEmitter(), {
  setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {},
  setDisplayMediaRequestHandler() {}, webRequest: { onBeforeRequest() {} },
}) } }))

describe('enterprise browser guest reset', () => {
  it('drains old guests and gives the same workspace a new isolated browser partition', async () => {
    const guests = new DesktopBrowserGuests(() => 'http://127.0.0.1:3080')
    const owner: WebContents = Object.assign(Object.create(EventEmitter.prototype), { isDestroyed: () => false, send() {} })
    guests.bind({ webContents: owner } as BrowserWindow, () => () => {})
    const first = guests.acquire(owner, 'shared-workspace-path')
    const guest = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      getURL: () => `about:blank#${first.lease}`,
      setWindowOpenHandler() {},
      close: vi.fn(),
    })
    owner.emit('did-attach-webview', {}, guest)
    guest.emit('dom-ready')
    let drained = false
    const reset = guests.reset().then(() => { drained = true })
    await Promise.resolve()
    expect(guest.close).toHaveBeenCalledOnce()
    expect(drained).toBe(false)
    guest.emit('destroyed')
    await reset
    const second = guests.acquire(owner, 'shared-workspace-path')
    expect(second.partition).not.toBe(first.partition)
    await guests.reset()
  })
})
