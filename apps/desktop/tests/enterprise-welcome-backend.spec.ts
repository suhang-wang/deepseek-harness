import { describe, expect, it, vi } from 'vitest'
import { connectEnterpriseWelcome } from '../src/enterprise-welcome-backend.ts'

const url = 'http://127.0.0.1:19387/?token=fixture'
const id = 'a394606b-9b24-4c17-8d32-f3c29ab8f418'

function transport() {
  const requests: string[] = []
  const send = vi.fn<Parameters<typeof connectEnterpriseWelcome>[1]>(async (_input, init) => {
    if (init?.method !== 'POST') return new Response('index')
    const message = JSON.parse(init.body as string) as { rpcId: string; method: string; payload: { args: Record<string, unknown> } }
    requests.push(message.method)
    const value = message.method === 'enterprise/getIdentityState'
      ? { status: 'signed-out', generation: 0, pendingRevocation: false }
      : message.method === 'enterprise/beginLogin' ? { attemptId: id }
        : { status: 'pending' }
    return Response.json({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value } })
  })
  return { send, requests }
}

describe('native enterprise welcome backend', () => {
  it('allows the Host launch redirect to establish the Electron session cookie', async () => {
    const host = transport()
    await connectEnterpriseWelcome(url, host.send)
    expect(host.send).toHaveBeenCalledWith(url, { credentials: 'include' })
    expect(host.send.mock.calls[0]?.[1]?.redirect).toBeUndefined()
  })

  it('uses only public enterprise RPC methods and never exposes credentials', async () => {
    const host = transport()
    const backend = await connectEnterpriseWelcome(url, host.send)
    expect(await backend.read()).toEqual({ status: 'signed-out', generation: 0, pendingRevocation: false })
    expect(await backend.beginLogin()).toEqual({ attemptId: id })
    expect(await backend.finishLogin(id)).toEqual({ status: 'pending' })
    expect(host.requests).toEqual(['enterprise/getIdentityState', 'enterprise/beginLogin', 'enterprise/finishLogin'])
    for (const [input, init] of host.send.mock.calls.slice(1)) {
      expect(input).toMatch(/^http:\/\/127\.0\.0\.1:19387\/api\/enterprise\//u)
      expect(init).toMatchObject({ credentials: 'include', redirect: 'error' })
      expect(JSON.stringify(init?.body)).not.toMatch(/refresh|access_token|api-key|credentials\/set/iu)
    }
  })

  it('rejects a nonlocal Host and invalid attempt before an RPC', async () => {
    const host = transport()
    await expect(connectEnterpriseWelcome('https://example.com/', host.send)).rejects.toThrow('invalid local Host URL')
    expect(host.send).not.toHaveBeenCalled()
    const backend = await connectEnterpriseWelcome(url, host.send)
    host.send.mockClear()
    await expect(backend.finishLogin('../wrong')).rejects.toThrow('invalid login attempt')
    expect(host.send).not.toHaveBeenCalled()
  })

  it('rejects malformed public identity and mismatched RPC envelopes', async () => {
    const host = transport()
    const backend = await connectEnterpriseWelcome(url, host.send)
    host.send.mockResolvedValueOnce(Response.json({ type: 'server-response', rpcId: 'wrong', result: { ok: true } }))
    await expect(backend.read()).rejects.toThrow('Host RPC failed')
    host.send.mockImplementationOnce(async (_input, init) => {
      const { rpcId } = JSON.parse(init?.body as string) as { rpcId: string }
      return Response.json({ type: 'server-response', rpcId, result: { ok: true, value: { status: 'signed-in', token: 'forbidden' } } })
    })
    await expect(backend.read()).rejects.toThrow('invalid identity state')
  })
})
