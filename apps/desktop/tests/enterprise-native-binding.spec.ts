import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EnterpriseNativeIdentityBinding } from '../src/enterprise-native-binding.ts'
import type { EnterpriseIdentityState } from '../src/enterprise-identity-state.ts'

const userData = resolve('/tmp/dsh-enterprise-native-binding')

function signedIn(employeeId: string, generation = 1): EnterpriseIdentityState {
  return { status: 'signed-in', companyId: 'company', employeeId, generation, pendingRevocation: false }
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

function fixture(overrides: {
  clear?: () => Promise<void>
  stop?: () => Promise<void>
  start?: () => Promise<void>
  reload?: () => Promise<void>
  onFailure?: (error: unknown) => void
} = {}) {
  const events: string[] = []
  let startup: Promise<void> | undefined
  let closing = false
  const failures: unknown[] = []
  const binding = new EnterpriseNativeIdentityBinding({
    userData,
    clear: async () => { events.push('clear'); await overrides.clear?.() },
    stop: async () => { events.push('stop'); await overrides.stop?.() },
    prepare: async (space) => { events.push(`prepare:${space.identity?.employeeId ?? 'bootstrap'}`) },
    start: async () => { events.push('start'); await overrides.start?.() },
    reload: async () => { events.push('reload'); await overrides.reload?.() },
    getStartup: () => startup,
    setStartup: (value) => { startup = value },
    isClosing: () => closing,
    onFailure: (error) => { failures.push(error); overrides.onFailure?.(error) },
  })
  return {
    binding, events, failures,
    startup: () => startup,
    setStartup: (value: Promise<void> | undefined) => { startup = value },
    close: () => { closing = true },
  }
}

describe('enterprise native identity binding', () => {
  it('owns the bootstrap data space until an employee switch', () => {
    const { binding } = fixture()
    expect(binding.currentSpace.identity).toBeNull()
    expect(binding.switching).toBe(false)
    expect(binding.beginHost()).toEqual({ epoch: 1, space: binding.currentSpace })
    expect(binding.beginHost().epoch).toBe(2)
  })

  it('fences admission immediately and waits for previous startup without awaiting itself', async () => {
    const previous = deferred()
    const f = fixture()
    f.setStartup(previous.promise)
    const { epoch } = f.binding.beginHost()

    f.binding.observe(epoch, signedIn('alice'))
    const switching = f.startup()
    expect(switching).not.toBe(previous.promise)
    expect(f.binding.switching).toBe(true)
    await Promise.resolve()
    expect(f.events).toEqual([])

    previous.resolve()
    await switching
    expect(f.events).toEqual(['clear', 'stop', 'prepare:alice', 'start', 'reload'])
    expect(f.binding.currentSpace.identity).toEqual({ companyId: 'company', employeeId: 'alice' })
    expect(f.startup()).toBeUndefined()
    expect(f.binding.switching).toBe(false)
  })

  it('ignores old Host epochs before queuing and after a startup wait', async () => {
    const previous = deferred()
    const f = fixture()
    f.setStartup(previous.promise)
    const old = f.binding.beginHost()
    f.binding.observe(old.epoch, signedIn('alice'))
    const queued = f.startup()
    const current = f.binding.beginHost()
    f.binding.observe(old.epoch, signedIn('bob'))
    expect(f.startup()).toBe(queued)
    previous.resolve()
    await queued
    expect(f.events).toEqual([])

    f.binding.observe(current.epoch, signedIn('alice'))
    await f.startup()
    expect(f.events).toEqual(['clear', 'stop', 'prepare:alice', 'start', 'reload'])
  })

  it('does not queue same-identity notifications from a newly initialized Host', async () => {
    let notifyNewHost: () => void = () => {}
    const f = fixture({ start: async () => { notifyNewHost() } })
    notifyNewHost = () => {
      const next = f.binding.beginHost()
      f.binding.observe(next.epoch, signedIn('alice', 0))
      f.binding.observe(next.epoch, signedIn('alice', 50))
    }

    f.binding.observe(f.binding.beginHost().epoch, signedIn('alice'))
    await f.startup()
    expect(f.events).toEqual(['clear', 'stop', 'prepare:alice', 'start', 'reload'])
    expect(f.startup()).toBeUndefined()
    expect(f.binding.switching).toBe(false)
  })

  it('keeps admission fenced until renderer reload has completed', async () => {
    const reloaded = deferred()
    const entered = deferred()
    const f = fixture({ reload: () => { entered.resolve(); return reloaded.promise } })
    f.binding.observe(f.binding.beginHost().epoch, signedIn('alice'))
    const operation = f.startup()
    await entered.promise
    expect(f.binding.currentSpace.identity?.employeeId).toBe('alice')
    expect(f.binding.switching).toBe(true)

    reloaded.resolve()
    await operation
    expect(f.binding.switching).toBe(false)
  })

  it.each(['stop', 'reload'] as const)('keeps admission closed after %s failure', async (stage) => {
    const failure = new Error(`${stage} failed`)
    const f = fixture({ [stage]: async () => { throw failure } })
    const host = f.binding.beginHost()
    f.binding.observe(host.epoch, signedIn('alice'))
    await f.startup()

    expect(f.failures).toEqual([expect.objectContaining({ stage, cause: failure })])
    expect(f.binding.switching).toBe(true)
    expect(f.startup()).toBeUndefined()
    const previous = [...f.events]
    f.binding.observe(host.epoch, signedIn('bob'))
    expect(f.events).toEqual(previous)
    expect(f.startup()).toBeUndefined()
    if (stage === 'stop') expect(f.events).toEqual(['clear', 'stop'])
  })

  it('does not switch after disposal while the initial Host is starting', async () => {
    const previous = deferred()
    const f = fixture()
    f.setStartup(previous.promise)
    const host = f.binding.beginHost()
    f.binding.observe(host.epoch, signedIn('alice'))
    const operation = f.startup()
    f.binding.dispose()
    previous.resolve()
    await operation

    expect(f.events).toEqual([])
    expect(f.binding.switching).toBe(true)
    expect(() => f.binding.beginHost()).toThrow()
    f.binding.observe(host.epoch, signedIn('bob'))
    expect(f.startup()).toBeUndefined()
  })

  it('does not prepare or start after disposal during old Host stop', async () => {
    const stopped = deferred()
    const entered = deferred()
    const f = fixture({ stop: () => { entered.resolve(); return stopped.promise } })
    f.binding.observe(f.binding.beginHost().epoch, signedIn('alice'))
    const operation = f.startup()
    await entered.promise
    f.binding.dispose()
    stopped.resolve()
    await operation

    expect(f.events).toEqual(['clear', 'stop'])
    expect(f.binding.switching).toBe(true)
  })

  it('serializes consecutive current-Host events and only clears its own startup promise', async () => {
    const reloadFirst = deferred()
    const entered = deferred()
    let reloads = 0
    const f = fixture({ reload: async () => {
      if (++reloads === 1) { entered.resolve(); await reloadFirst.promise }
    } })
    const host = f.binding.beginHost()
    f.binding.observe(host.epoch, signedIn('alice'))
    const first = f.startup()
    await entered.promise
    f.binding.observe(host.epoch, signedIn('bob', 2))
    const second = f.startup()
    expect(second).not.toBe(first)
    reloadFirst.resolve()
    await first
    expect(f.startup()).toBe(second)
    expect(f.binding.switching).toBe(true)
    await second

    expect(f.events).toEqual([
      'clear', 'stop', 'prepare:alice', 'start', 'reload',
      'clear', 'stop', 'prepare:bob', 'start', 'reload',
    ])
    expect(f.binding.currentSpace.identity?.employeeId).toBe('bob')
    expect(f.startup()).toBeUndefined()
    expect(f.binding.switching).toBe(false)
  })

  it('does not clear a startup promise installed by another owner', async () => {
    const reload = deferred()
    const entered = deferred()
    const external = deferred()
    const f = fixture({ reload: () => { entered.resolve(); return reload.promise } })
    f.binding.observe(f.binding.beginHost().epoch, signedIn('alice'))
    const operation = f.startup()
    await entered.promise
    f.setStartup(external.promise)
    reload.resolve()
    await operation
    expect(f.startup()).toBe(external.promise)
  })

  it('contains reporter failures with an independent diagnostic', async () => {
    const failure = new Error('stop failed')
    const reportingFailure = new Error('reporter failed')
    const fallback = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const f = fixture({ stop: async () => { throw failure }, onFailure: () => { throw reportingFailure } })
      f.binding.observe(f.binding.beginHost().epoch, signedIn('alice'))
      await expect(f.startup()).resolves.toBeUndefined()
      expect(fallback).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ cause: reportingFailure }))
      expect(f.binding.switching).toBe(true)
    } finally { fallback.mockRestore() }
  })

  it('contains failures of both reporting mechanisms while keeping admission closed', async () => {
    const fallback = vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('console unavailable') })
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => { throw new Error('stderr unavailable') })
    try {
      const f = fixture({ stop: async () => { throw new Error('stop failed') }, onFailure: () => { throw new Error('reporter failed') } })
      f.binding.observe(f.binding.beginHost().epoch, signedIn('alice'))
      await expect(f.startup()).resolves.toBeUndefined()
      expect(stderr).toHaveBeenCalledOnce()
      expect(f.binding.switching).toBe(true)
    } finally { fallback.mockRestore(); stderr.mockRestore() }
  })

  it('switches signed-out to bootstrap and distinguishes the same employee in another company', async () => {
    const f = fixture()
    const host = f.binding.beginHost()
    f.binding.observe(host.epoch, signedIn('alice'))
    await f.startup()
    const aliceHome = f.binding.currentSpace.home
    const differentCompany = { ...signedIn('alice'), companyId: 'other-company' }
    f.binding.observe(host.epoch, differentCompany)
    await f.startup()
    expect(f.binding.currentSpace.identity).toEqual({ companyId: 'other-company', employeeId: 'alice' })
    expect(f.binding.currentSpace.home).not.toBe(aliceHome)

    f.binding.observe(host.epoch, { status: 'signed-out', generation: 3, pendingRevocation: true })
    await f.startup()
    expect(f.binding.currentSpace.key).toBe('bootstrap')
    expect(f.binding.currentSpace.identity).toBeNull()
    const previous = [...f.events]
    f.binding.observe(host.epoch, { status: 'signed-out', generation: 4, pendingRevocation: false })
    expect(f.events).toEqual(previous)
    expect(f.startup()).toBeUndefined()
  })

  it('ignores observations while the app is closing and drops queued switches on close', async () => {
    const previous = deferred()
    const f = fixture()
    const host = f.binding.beginHost()
    f.setStartup(previous.promise)
    f.binding.observe(host.epoch, signedIn('alice'))
    const operation = f.startup()
    f.close()
    f.binding.observe(host.epoch, signedIn('bob'))
    expect(f.startup()).toBe(operation)
    previous.resolve()
    await operation
    expect(f.events).toEqual([])
    expect(f.binding.switching).toBe(true)
  })

  it('contains rejected initial startup and keeps dependent switching stopped', async () => {
    const previous = deferred()
    const f = fixture()
    f.setStartup(previous.promise)
    f.binding.observe(f.binding.beginHost().epoch, signedIn('alice'))
    const operation = f.startup()
    const failure = new Error('initial startup failed')
    previous.reject(failure)
    await operation

    expect(f.failures).toEqual([failure])
    expect(f.events).toEqual([])
    expect(f.binding.switching).toBe(true)
  })
})
