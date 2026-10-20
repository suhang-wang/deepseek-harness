/** Enterprise-only native welcome. No personal account, credential, or skip controls. */
import { useEffect, useRef, useState } from 'react'
import type { EnterpriseWelcomeApi } from '../welcome-api.ts'

type Phase = 'loading' | 'opening' | 'pending' | 'opening-workspace' | 'denied' | 'expired' | 'ready' | 'error'

const copy = {
  'zh-CN': {
    title: 'DeepSeek Harness 企业版', heading: '使用企业微信登录',
    description: '使用企业账号访问组织管理的模型和额度。',
    start: '刷新二维码', opening: '正在准备登录二维码…', pending: '请使用企业微信扫码登录',
    pendingHint: '在手机上确认后，将自动打开工作区。', browser: '改用浏览器登录',
    browserPending: '请在浏览器完成企业微信登录，成功后将自动打开工作区。', retry: '重新登录',
    denied: '企业微信授权未完成，请重新登录。', expired: '登录已过期，请重新登录。',
    error: '暂时无法连接企业登录服务，请重试。', ready: '已登录，正在打开工作区…',
    openingWorkspace: '正在打开应用…',
  },
  en: {
    title: 'DeepSeek Harness Enterprise', heading: 'Sign in with WeCom',
    description: 'Use your company account to access managed models and allowances.',
    start: 'Refresh QR code', opening: 'Preparing your sign-in QR code…', pending: 'Scan with WeCom to sign in',
    pendingHint: 'Confirm on your phone to open your workspace automatically.', browser: 'Sign in in browser instead',
    browserPending: 'Complete WeCom sign-in in your browser. Your workspace will open automatically.', retry: 'Try signing in again',
    denied: 'WeCom authorization was not completed. Please try again.', expired: 'Sign-in expired. Please try again.',
    error: 'The enterprise sign-in service is unavailable. Please try again.', ready: 'Signed in. Opening your workspace…',
    openingWorkspace: 'Opening your workspace…',
  },
} as const

export function EnterpriseWelcomePage({ api }: { readonly api: EnterpriseWelcomeApi }) {
  const m = api.id === 'zh-CN' ? copy['zh-CN'] : copy.en
  const [phase, setPhase] = useState<Phase>('loading')
  const [qrUrl, setQrUrl] = useState<string | null>(null)
  const attempt = useRef<string | null>(null)
  const mounted = useRef(true)
  const busy = useRef(false)
  const revision = useRef(0)

  useEffect(() => {
    mounted.current = true
    document.documentElement.lang = api.id
    document.title = m.title
    const current = ++revision.current
    void api.read().then(state => {
      if (mounted.current && revision.current === current) {
        if (state.status === 'signed-in') setPhase('ready')
        else void start('qr')
      }
    }).catch(() => {
      if (mounted.current && revision.current === current) setPhase('error')
    })
    return () => { mounted.current = false; revision.current++ }
  }, [api, m.title])

  async function start(mode: 'qr' | 'browser') {
    if (busy.current) return
    busy.current = true
    attempt.current = null
    setQrUrl(null)
    const current = ++revision.current
    setPhase('opening')
    try {
      const result: { readonly attemptId: string; readonly qrUrl?: string } = mode === 'qr'
        ? await api.beginQrLogin() : await api.beginLogin()
      if (mounted.current && revision.current === current) {
        attempt.current = result.attemptId
        setQrUrl(result.qrUrl ?? null)
        setPhase('pending')
      }
    } catch {
      if (mounted.current && revision.current === current) setPhase('error')
    } finally { busy.current = false }
  }

  useEffect(() => {
    if (phase !== 'pending') return
    return api.onConfirmed(() => { setPhase('opening-workspace') })
  }, [api, phase])

  const polling = phase === 'pending' || phase === 'opening-workspace'

  useEffect(() => {
    const id = attempt.current
    if (!polling || id === null) return
    const current = revision.current
    let stopped = false
    let failures = 0
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await api.finishLogin(id)
        if (stopped || !mounted.current || revision.current !== current) return
        failures = 0
        if (result.status === 'pending') timer = setTimeout(() => { void poll() }, 2_500)
        else {
          attempt.current = null
          setQrUrl(null)
          setPhase(result.status === 'signed-in' ? 'ready' : result.status)
        }
      } catch {
        if (stopped || !mounted.current || revision.current !== current) return
        failures += 1
        if (failures < 5) { timer = setTimeout(() => { void poll() }, 2_500); return }
        setPhase('error')
      }
    }
    timer = setTimeout(() => { void poll() }, 2_500)
    return () => { stopped = true; clearTimeout(timer) }
  }, [api, polling])

  const isPending = phase === 'pending'
  const isBusy = phase === 'loading' || phase === 'opening' || phase === 'opening-workspace'
  const status = phase === 'opening' ? m.opening : phase === 'pending' ? m.pending
    : phase === 'opening-workspace' ? m.openingWorkspace
      : phase === 'denied' ? m.denied : phase === 'expired' ? m.expired : phase === 'ready' ? m.ready
        : phase === 'error' ? m.error : ''

  return <>
    <div className="titlebar" aria-hidden="true" />
    <main className="welcome enterprise-welcome" aria-labelledby="enterprise-heading">
      <img className="brand" src="assets/welcome-brand.svg" alt="DeepSeek Harness" width="472" height="40" />
      <section className="enterprise-welcome-content" aria-live="polite">
        <h1 id="enterprise-heading">{m.heading}</h1>
        <p>{phase === 'loading' ? m.description : status}</p>
        {isPending && qrUrl !== null && <div className="enterprise-login-qr-frame">
          <iframe className="enterprise-login-qr" title={m.pending} src={qrUrl}
            sandbox="allow-scripts allow-same-origin allow-forms allow-top-navigation" referrerPolicy="no-referrer" />
        </div>}
        {isPending && <p className="enterprise-welcome-hint">{qrUrl === null ? m.browserPending : m.pendingHint}</p>}
      </section>
      <div className="actions enterprise-welcome-actions">
        {(phase === 'denied' || phase === 'expired' || phase === 'error') &&
          <button id="enterprise-start" className="primary" type="button" onClick={() => { void start('qr') }}>
            {m.retry}
          </button>}
        {((isPending && qrUrl !== null) || phase === 'error') &&
          <button id="enterprise-browser" className="secondary" type="button" onClick={() => { void start('browser') }}>{m.browser}</button>}
        {isBusy && <button className="primary" type="button" disabled aria-label={status || m.opening}>{status || m.opening}</button>}
      </div>
    </main>
  </>
}
