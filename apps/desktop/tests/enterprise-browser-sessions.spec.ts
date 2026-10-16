import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EnterpriseBrowserSessions } from '../src/enterprise-browser-sessions.ts'
import { resolveEnterpriseDataSpace } from '../src/enterprise-data-space.ts'

const userData = resolve('/tmp/dsh-enterprise-browser-sessions')
const alice = resolveEnterpriseDataSpace(userData, { companyId: 'company', employeeId: 'alice' })
const bob = resolveEnterpriseDataSpace(userData, { companyId: 'company', employeeId: 'bob' })
const bootstrap = resolveEnterpriseDataSpace(userData, null)

describe('enterprise browser sessions', () => {
  it('creates a session at the employee-owned browser-session path', () => {
    const session = { localStorage: new Map<string, string>() }
    const factory = vi.fn(() => session)
    const configure = vi.fn()
    const pool = new EnterpriseBrowserSessions({ factory, configure })

    expect(pool.forSpace(alice)).toBe(session)
    expect(factory).toHaveBeenCalledExactlyOnceWith(join(alice.home, 'browser-session'))
    expect(configure).toHaveBeenCalledExactlyOnceWith(session)
  })

  it('reuses the same employee session and configures its protocol only once', () => {
    const factory = vi.fn((path: string) => ({ path }))
    const configure = vi.fn()
    const pool = new EnterpriseBrowserSessions({ factory, configure })
    const first = pool.forSpace(alice)
    const copiedSpace = resolveEnterpriseDataSpace(userData, { companyId: 'company', employeeId: 'alice' })

    expect(pool.forSpace(copiedSpace)).toBe(first)
    expect(factory).toHaveBeenCalledOnce()
    expect(configure).toHaveBeenCalledOnce()
  })

  it('isolates employees, companies and bootstrap while restoring an employee draft on return', () => {
    const factory = vi.fn((path: string) => ({ path, localStorage: new Map<string, string>() }))
    const configure = vi.fn()
    const pool = new EnterpriseBrowserSessions({ factory, configure })
    const aliceSession = pool.forSpace(alice)
    aliceSession.localStorage.set('draft', 'alice-only')
    const bobSession = pool.forSpace(bob)
    const bootstrapSession = pool.forSpace(bootstrap)
    const otherCompanySession = pool.forSpace(resolveEnterpriseDataSpace(userData, { companyId: 'other-company', employeeId: 'alice' }))

    expect(new Set([aliceSession, bobSession, bootstrapSession, otherCompanySession]).size).toBe(4)
    expect(bobSession.localStorage.get('draft')).toBeUndefined()
    expect(bootstrapSession.localStorage.get('draft')).toBeUndefined()
    expect(otherCompanySession.localStorage.get('draft')).toBeUndefined()
    expect(pool.forSpace(alice).localStorage.get('draft')).toBe('alice-only')
    expect(factory).toHaveBeenCalledTimes(4)
    expect(configure).toHaveBeenCalledTimes(4)
  })

  it('does not cache a failed factory attempt and permits retry', () => {
    const failure = new Error('session creation failed')
    const session = { path: join(alice.home, 'browser-session') }
    const factory = vi.fn<(path: string) => typeof session>()
      .mockImplementationOnce(() => { throw failure })
      .mockReturnValue(session)
    const configure = vi.fn()
    const pool = new EnterpriseBrowserSessions({ factory, configure })

    expect(() => pool.forSpace(alice)).toThrow(failure)
    expect(configure).not.toHaveBeenCalled()
    expect(pool.forSpace(alice)).toBe(session)
    expect(pool.forSpace(alice)).toBe(session)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(configure).toHaveBeenCalledOnce()
  })

  it('does not expose or cache a session whose configuration failed', () => {
    const failure = new Error('protocol registration failed')
    const first = { configured: false }
    const second = { configured: false }
    const factory = vi.fn<(path: string) => typeof first>()
      .mockReturnValueOnce(first)
      .mockReturnValue(second)
    const configure = vi.fn<(session: typeof first) => void>()
      .mockImplementationOnce(() => { throw failure })
      .mockImplementation((session) => { session.configured = true })
    const pool = new EnterpriseBrowserSessions({ factory, configure })

    expect(() => pool.forSpace(alice)).toThrow(failure)
    expect(pool.forSpace(alice)).toBe(second)
    expect(pool.forSpace(alice)).toBe(second)
    expect(first.configured).toBe(false)
    expect(second.configured).toBe(true)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(configure).toHaveBeenCalledTimes(2)
  })

  it('does not disturb an already configured employee session after another path fails', () => {
    const failure = new Error('bob configuration failed')
    const factory = vi.fn((path: string) => ({ path }))
    const configure = vi.fn((session: { path: string }) => {
      if (session.path === join(bob.home, 'browser-session')) throw failure
    })
    const pool = new EnterpriseBrowserSessions({ factory, configure })
    const existing = pool.forSpace(alice)

    expect(() => pool.forSpace(bob)).toThrow(failure)
    expect(pool.forSpace(alice)).toBe(existing)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(configure).toHaveBeenCalledTimes(2)
  })
})
