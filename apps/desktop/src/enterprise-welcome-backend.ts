/** Token-free enterprise login operations for the native welcome window. */

import { randomUUID } from 'node:crypto'
import { parseEnterpriseIdentityState, type EnterpriseIdentityState } from './enterprise-identity-state.ts'

const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

export interface EnterpriseWelcomeBackend {
  read(): Promise<EnterpriseIdentityState>
  beginLogin(): Promise<{ readonly attemptId: string }>
  beginQrLogin(): Promise<{ readonly attemptId: string; readonly qrUrl: string }>
  finishLogin(attemptId: string): Promise<{ readonly status: 'signed-in' | 'pending' | 'denied' | 'expired' }>
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Authenticate through the Desktop Host's local Web endpoint and call only public identity methods.
 * The bearer and refresh tokens never enter the native welcome renderer or this API.
 */
export async function connectEnterpriseWelcome(
  authenticatedUrl: string,
  send: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<EnterpriseWelcomeBackend> {
  const url = new URL(authenticatedUrl)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) {
    throw new Error('enterprise welcome: invalid local Host URL')
  }
  // The Host launch URL first responds with 303 and a session cookie. Let the
  // Electron session follow it so subsequent RPC requests carry that cookie.
  const authenticated = await send(authenticatedUrl, { credentials: 'include' })
  await authenticated.body?.cancel()
  if (!authenticated.ok) throw new Error('enterprise welcome: Host authentication failed')

  const invoke = async (method: 'getIdentityState' | 'beginLogin' | 'beginQrLogin' | 'finishLogin', args: Record<string, unknown> = {}): Promise<unknown> => {
    const rpcId = randomUUID()
    const name = `enterprise/${method}`
    const response = await send(new URL(`/api/${name}`, url.origin).href, {
      method: 'POST', credentials: 'include', redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: name, payload: { args } }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error('enterprise welcome: Host request failed')
    const envelope: unknown = await response.json()
    if (!record(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId
      || !record(envelope.result) || envelope.result.ok !== true) {
      throw new Error('enterprise welcome: Host RPC failed')
    }
    return envelope.result.value
  }

  return Object.freeze({
    async read() {
      const state = parseEnterpriseIdentityState(await invoke('getIdentityState'))
      if (state === null) throw new Error('enterprise welcome: invalid identity state')
      return state
    },
    async beginLogin() {
      const value = await invoke('beginLogin')
      if (!record(value) || typeof value.attemptId !== 'string' || !ATTEMPT_ID.test(value.attemptId)) {
        throw new Error('enterprise welcome: invalid login attempt')
      }
      return Object.freeze({ attemptId: value.attemptId })
    },
    async beginQrLogin() {
      const value = await invoke('beginQrLogin')
      if (!record(value) || typeof value.attemptId !== 'string' || !ATTEMPT_ID.test(value.attemptId)
        || typeof value.qrUrl !== 'string') throw new Error('enterprise welcome: invalid QR login attempt')
      const qrUrl = new URL(value.qrUrl)
      if (qrUrl.origin !== 'https://open.work.weixin.qq.com' || qrUrl.pathname !== '/wwopen/sso/qrConnect'
        || qrUrl.username || qrUrl.password || qrUrl.hash) throw new Error('enterprise welcome: invalid QR login URL')
      return Object.freeze({ attemptId: value.attemptId, qrUrl: qrUrl.toString() })
    },
    async finishLogin(attemptId: string) {
      if (!ATTEMPT_ID.test(attemptId)) throw new Error('enterprise welcome: invalid login attempt')
      const value = await invoke('finishLogin', { attemptId })
      if (!record(value) || !['signed-in', 'pending', 'denied', 'expired'].includes(String(value.status))) {
        throw new Error('enterprise welcome: invalid login result')
      }
      return Object.freeze({ status: value.status as 'signed-in' | 'pending' | 'denied' | 'expired' })
    },
  })
}
