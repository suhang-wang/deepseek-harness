// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CompanyPickerPage } from '../src/client/CompanyPickerPage.tsx'
import { resolveDesktopLocale } from '../src/locale.ts'

afterEach(cleanup)

function mount() {
  const api = {
    ...resolveDesktopLocale('zh-CN'),
    productName: '企业工作台',
    list: vi.fn(async () => [
      { companyId: 'ruqinba', displayName: '如钦巴', signedIn: true, lastUsed: true },
      { companyId: 'company-b', displayName: 'B 公司', signedIn: false, lastUsed: false },
    ]),
    select: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  }
  render(<CompanyPickerPage api={api} />)
  return api
}

describe('company picker renderer', () => {
  it('lists signed companies with session state and selects one', async () => {
    const api = mount()
    await screen.findByText('如钦巴')
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(document.title).toBe('企业工作台')
    expect(screen.getByText('已登录')).toBeDefined()
    expect(screen.getByText('上次使用')).toBeDefined()
    fireEvent.click(screen.getByText('B 公司'))
    await vi.waitFor(() => { expect(api.select).toHaveBeenCalledWith('company-b') })
  })

  it('cancels without selecting a company', async () => {
    const api = mount()
    await screen.findByText('如钦巴')
    fireEvent.click(screen.getByText('取消'))
    await vi.waitFor(() => { expect(api.cancel).toHaveBeenCalledOnce() })
    expect(api.select).not.toHaveBeenCalled()
  })
})
