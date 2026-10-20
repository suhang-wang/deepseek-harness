// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { EnterpriseWelcomePage } from '../src/client/EnterpriseWelcomePage.tsx'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { EnterpriseLoginResult } from '../src/welcome-api.ts'

const signedOut = { status: 'signed-out' as const, generation: 0, pendingRevocation: false }
const signedIn = { status: 'signed-in' as const, companyId: 'company', employeeId: 'employee', generation: 1, pendingRevocation: false }
const attemptId = 'c1caeac9-5ea9-45b3-805e-12a2e6d08287'

function mount(language = 'zh-CN') {
  const api = {
    ...resolveDesktopLocale(language), mode: 'enterprise' as const,
    read: vi.fn(async () => signedOut as typeof signedOut | typeof signedIn),
    beginLogin: vi.fn(async () => ({ attemptId })),
    beginQrLogin: vi.fn(async () => ({ attemptId, qrUrl: 'https://open.work.weixin.qq.com/wwopen/sso/qrConnect?state=test' })),
    finishLogin: vi.fn<(_id: string) => Promise<EnterpriseLoginResult>>(async () => ({ status: 'pending' })),
  }
  render(<EnterpriseWelcomePage api={api} />)
  return api
}

afterEach(cleanup)

describe('enterprise welcome renderer', () => {
  it.each(['zh-CN', 'en'])('shows a locally rendered WeCom QR code and browser fallback in %s', async language => {
    const api = mount(language)
    const qr = await screen.findByAltText(language === 'zh-CN' ? '请使用企业微信扫码登录' : 'Scan with WeCom to sign in')
    expect(document.documentElement.lang).toBe(language)
    expect(document.querySelector('input')).toBeNull()
    expect(document.body.textContent).not.toMatch(/API Key|密钥|Skip|跳过/u)
    expect(qr.getAttribute('src')).toMatch(/^data:image\/gif;base64,/u)
    expect(document.querySelector('iframe')).toBeNull()
    expect(api.beginQrLogin).toHaveBeenCalledOnce()
    expect(api.beginLogin).not.toHaveBeenCalled()
    fireEvent.click(document.getElementById('enterprise-browser')!)
    await vi.waitFor(() => { expect(api.beginLogin).toHaveBeenCalledOnce() })
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('polls and shows readiness after a confirmed sign-in', async () => {
    const api = mount()
    await screen.findByAltText('请使用企业微信扫码登录')
    api.finishLogin.mockResolvedValueOnce({ status: 'signed-in' as const })
    expect(await screen.findByText('已登录，正在打开工作区…', {}, { timeout: 4_000 })).toBeDefined()
    expect(api.finishLogin).toHaveBeenCalledExactlyOnceWith(attemptId)
    expect(document.querySelector('#enterprise-start')).toBeNull()
  })

  it('shows retry when the public state cannot be read', async () => {
    const api = {
      ...resolveDesktopLocale('en'), mode: 'enterprise' as const,
      read: vi.fn().mockRejectedValue(new Error('private Host diagnosis')),
      beginLogin: vi.fn(async () => ({ attemptId })),
      beginQrLogin: vi.fn(async () => ({ attemptId, qrUrl: 'https://open.work.weixin.qq.com/wwopen/sso/qrConnect?state=test' })),
      finishLogin: vi.fn(async () => ({ status: 'pending' as const })),
    }
    render(<EnterpriseWelcomePage api={api} />)
    expect(await screen.findByText('The enterprise sign-in service is unavailable. Please try again.')).toBeDefined()
    expect(document.body.textContent).not.toContain('private Host diagnosis')
  })
})
