import { describe, expect, it, vi } from 'vitest'
import { beginEnterpriseLoginAfterStorageReady } from '../src/enterprise-login-preflight.ts'

describe('enterprise login secure-storage preflight', () => {
  it('does not create a browser attempt while Keychain readiness is pending', async () => {
    vi.useFakeTimers()
    try {
      let allowStorage!: () => void
      const storage = { probeWritable: vi.fn(() => new Promise<void>(resolve => { allowStorage = resolve })) }
      const beginLogin = vi.fn(async () => ({ attemptId: 'attempt-1' }))
      const pending = beginEnterpriseLoginAfterStorageReady(storage, beginLogin, 1_000)
      await vi.advanceTimersByTimeAsync(999)
      expect(beginLogin).not.toHaveBeenCalled()
      allowStorage()
      await expect(pending).resolves.toEqual({ attemptId: 'attempt-1' })
      expect(beginLogin).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it('times out before opening a browser or redeeming an attempt', async () => {
    vi.useFakeTimers()
    try {
      let allowStorage!: () => void
      const storage = { probeWritable: vi.fn(() => new Promise<void>(resolve => { allowStorage = resolve })) }
      const beginLogin = vi.fn(async () => ({ attemptId: 'attempt-1' }))
      const pending = beginEnterpriseLoginAfterStorageReady(storage, beginLogin, 1_000)
      const outcome = expect(pending).rejects.toThrow(/Keychain readiness timed out/u)
      await vi.advanceTimersByTimeAsync(1_000)
      await outcome
      allowStorage()
      await Promise.resolve()
      expect(beginLogin).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('fails closed when Keychain reports unavailable', async () => {
    const beginLogin = vi.fn(async () => ({ attemptId: 'attempt-1' }))
    await expect(beginEnterpriseLoginAfterStorageReady({ probeWritable: async () => { throw new Error('unavailable') } }, beginLogin))
      .rejects.toThrow('unavailable')
    expect(beginLogin).not.toHaveBeenCalled()
  })

  it('does not open a browser when Keychain encryption fails after availability succeeds', async () => {
    const beginLogin = vi.fn(async () => ({ attemptId: 'attempt-1' }))
    await expect(beginEnterpriseLoginAfterStorageReady({ probeWritable: async () => {
      throw new Error('Keychain encryption failed')
    } }, beginLogin)).rejects.toThrow('Keychain encryption failed')
    expect(beginLogin).not.toHaveBeenCalled()
  })
})
