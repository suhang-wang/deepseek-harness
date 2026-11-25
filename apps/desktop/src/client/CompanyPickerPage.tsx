/** Pre-Host company selection. No credential or company URL crosses this renderer. */
import { useEffect, useState } from 'react'
import type { CompanyPickerApi, CompanyPickerCompany } from '../welcome-api.ts'

const copy = {
  'zh-CN': {
    title: '选择公司', heading: '选择公司工作区', description: '选择要打开的企业工作区。不同公司的数据相互隔离。',
    signedIn: '已登录', lastUsed: '上次使用', cancel: '取消', loading: '正在加载公司…', failed: '暂时无法加载公司列表，请重试。',
  },
  en: {
    title: 'Choose a company', heading: 'Choose a company workspace', description: 'Choose the company workspace to open. Company data stays isolated.',
    signedIn: 'Signed in', lastUsed: 'Last used', cancel: 'Cancel', loading: 'Loading companies…', failed: 'The company list is unavailable. Try again.',
  },
} as const

/**
 * Render the signed company list before any Host starts.
 * @param props.api - isolated preload API exposing only list, select and cancel.
 * @returns the company picker surface.
 */
export function CompanyPickerPage({ api }: { readonly api: CompanyPickerApi }) {
  const m = api.id === 'zh-CN' ? copy['zh-CN'] : copy.en
  const [companies, setCompanies] = useState<readonly CompanyPickerCompany[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    document.documentElement.lang = api.id
    document.title = api.productName
    void api.list().then((value) => {
      if (active) setCompanies(value)
    }).catch(() => {
      if (active) setFailed(true)
    })
    return () => { active = false }
  }, [api])

  const choose = async (companyId: string): Promise<void> => {
    if (busy !== null) return
    setBusy(companyId)
    try { await api.select(companyId) } catch { setBusy(null) }
  }

  return (
    <main className="company-picker">
      <header className="company-picker-header">
        <h1>{m.heading}</h1>
        <p>{m.description}</p>
      </header>
      {failed ? <p className="company-picker-error">{m.failed}</p> : companies === null
        ? <p className="company-picker-loading">{m.loading}</p>
        : (
          <div className="company-list">
            {companies.map((company, index) => (
              <button
                key={company.companyId}
                type="button"
                className="company-option"
                autoFocus={index === 0}
                disabled={busy !== null}
                onClick={() => { void choose(company.companyId) }}
              >
                <span className="company-option-name">{company.displayName}</span>
                <span className="company-option-meta">
                  {company.signedIn ? <span className="company-badge">{m.signedIn}</span> : null}
                  {company.lastUsed ? <span className="company-last-used">{m.lastUsed}</span> : null}
                </span>
              </button>
            ))}
          </div>
        )}
      <button type="button" className="company-cancel" disabled={busy !== null} onClick={() => { void api.cancel() }}>
        {m.cancel}
      </button>
    </main>
  )
}
