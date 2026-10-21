// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { EnterpriseWelcomePage } from '../src/client/EnterpriseWelcomePage.tsx'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { EnterpriseLoginResult } from '../src/welcome-api.ts'

const signedOut = { status: 'signed-out' as const, generation: 0, pendingRevocation: false }
const signedIn = { status: 'signed-in' as const, companyId: 'company', employeeId: 'employee', generation: 1, pendingRevocation: false }
const attemptId = 'c1caeac9-5ea9-45b3-805e-12a2e6d08287'

function mount(language = 'zh-CN', productName = 'Ruqinba Harness') {
  let confirmed: (() => void) | undefined
  const api = {
    ...resolveDesktopLocale(language), mode: 'enterprise' as const,
    productName,
    read: vi.fn(async () => signedOut as typeof signedOut | typeof signedIn),
    beginLogin: vi.fn(async () => ({ attemptId })),
    beginQrLogin: vi.fn(async () => ({ attemptId, qrUrl: 'https://open.work.weixin.qq.com/wwopen/sso/qrConnect?state=test' })),
    finishLogin: vi.fn<(_id: string) => Promise<EnterpriseLoginResult>>(async () => ({ status: 'pending' })),
    onConfirmed: vi.fn((listener: () => void) => {
      confirmed = listener
      return () => { confirmed = undefined }
    }),
    confirm: () => { confirmed?.() },
  }
  render(<EnterpriseWelcomePage api={api} />)
  return api
}

afterEach(cleanup)

describe('enterprise welcome renderer', () => {
  it.each(['zh-CN', 'en'])('shows an embedded WeCom QR code and browser fallback in %s', async language => {
    const api = mount(language)
    const qr = await screen.findByTitle(language === 'zh-CN' ? '请使用企业微信扫码登录' : 'Scan with WeCom to sign in')
    expect(document.documentElement.lang).toBe(language)
    expect(document.title).toBe('Ruqinba Harness')
    expect(screen.getByText('Ruqinba Harness')).toBeDefined()
    expect(document.querySelector('input')).toBeNull()
    expect(document.body.textContent).not.toMatch(/API Key|密钥|Skip|跳过/u)
    expect(qr.getAttribute('src')).toContain('/wwopen/sso/qrConnect?state=test')
    expect(api.beginQrLogin).toHaveBeenCalledOnce()
    expect(api.beginLogin).not.toHaveBeenCalled()
    fireEvent.click(document.getElementById('enterprise-browser')!)
    await vi.waitFor(() => { expect(api.beginLogin).toHaveBeenCalledOnce() })
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('keeps the QR document mounted while the confirmed callback opens the workspace', async () => {
    const api = mount()
    await screen.findByTitle('请使用企业微信扫码登录')
    await vi.waitFor(() => { expect(api.onConfirmed).toHaveBeenCalledOnce() })
    act(() => { api.confirm() })
    expect(await screen.findAllByText('正在打开应用…')).not.toHaveLength(0)
    expect(document.querySelector('iframe')).not.toBeNull()
    expect(document.querySelector('.enterprise-login-qr-frame')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('reports a stalled callback instead of waiting for the attempt to expire', async () => {
    const api = mount()
    await screen.findByTitle('请使用企业微信扫码登录')
    await vi.waitFor(() => { expect(api.onConfirmed).toHaveBeenCalledOnce() })
    vi.useFakeTimers()
    try {
      act(() => { api.confirm() })
      act(() => { vi.advanceTimersByTime(90_000) })
      expect(screen.getByText('登录回调未完成，请重新登录。')).toBeDefined()
      expect(document.getElementById('enterprise-start')).not.toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('retries transient finish failures before showing the error state', async () => {
    const api = mount()
    await screen.findByTitle('请使用企业微信扫码登录')
    api.finishLogin.mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce({ status: 'signed-in' })
    expect(await screen.findByText('已登录，正在打开工作区…', {}, { timeout: 7_000 })).toBeDefined()
    expect(screen.queryByText('暂时无法连接企业登录服务，请重试。')).toBeNull()
  }, 10_000)

  it('polls and shows readiness after a confirmed sign-in', async () => {
    const api = mount()
    await screen.findByTitle('请使用企业微信扫码登录')
    api.finishLogin.mockResolvedValueOnce({ status: 'signed-in' as const })
    expect(await screen.findByText('已登录，正在打开工作区…', {}, { timeout: 4_000 })).toBeDefined()
    expect(api.finishLogin).toHaveBeenCalledExactlyOnceWith(attemptId)
    expect(document.querySelector('#enterprise-start')).toBeNull()
  })

  it('shows retry when the public state cannot be read', async () => {
    const api = {
      ...resolveDesktopLocale('en'), mode: 'enterprise' as const,
      productName: 'Ruqinba Harness',
      read: vi.fn().mockRejectedValue(new Error('private Host diagnosis')),
      beginLogin: vi.fn(async () => ({ attemptId })),
      beginQrLogin: vi.fn(async () => ({ attemptId, qrUrl: 'https://open.work.weixin.qq.com/wwopen/sso/qrConnect?state=test' })),
      finishLogin: vi.fn(async () => ({ status: 'pending' as const })),
      onConfirmed: vi.fn(() => () => {}),
    }
    render(<EnterpriseWelcomePage api={api} />)
    expect(await screen.findByText('The enterprise sign-in service is unavailable. Please try again.')).toBeDefined()
    expect(document.body.textContent).not.toContain('private Host diagnosis')
  })
})
