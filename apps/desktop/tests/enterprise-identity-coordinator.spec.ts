import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EnterpriseIdentityCoordinator, EnterpriseIdentitySwitchError } from '../src/enterprise-identity-coordinator.ts'

const userData = resolve('/tmp/dsh-enterprise-coordinator')
const alice = { companyId: 'company', employeeId: 'alice' }
const bob = { companyId: 'company', employeeId: 'bob' }

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}


async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function fixture() {
  const events: string[] = []
  const coordinator = new EnterpriseIdentityCoordinator({
    userData,
    clear: vi.fn(async () => { events.push('clear') }),
    stop: vi.fn(async () => { events.push('stop') }),
    prepare: vi.fn(async (space) => { events.push(`prepare:${space.identity?.employeeId ?? 'bootstrap'}`) }),
    start: vi.fn(async () => { events.push('start') }),
    reload: vi.fn(async () => { events.push('reload') }),
  })
  return { coordinator, events }
}

describe('enterprise identity coordinator', () => {
  it('starts in the bootstrap space', () => {
    const { coordinator } = fixture()

    expect(coordinator.currentSpace.identity).toBeNull()
    expect(coordinator.currentSpace.key).toBe('bootstrap')
  })

  it('switches by clearing old forwarding, stopping, preparing, starting and reloading', async () => {
    const { coordinator, events } = fixture()

    await coordinator.switchTo(alice)

    expect(events).toEqual(['clear', 'stop', 'prepare:alice', 'start', 'reload'])
    expect(coordinator.currentSpace.identity).toEqual(alice)
  })

  it('does not prepare before stop finishes', async () => {
    const stopped = deferred()
    const events: string[] = []
    const coordinator = new EnterpriseIdentityCoordinator({
      userData,
      clear: vi.fn(async () => { events.push('clear') }),
      stop: vi.fn(() => { events.push('stop'); return stopped.promise }),
      prepare: vi.fn(async () => { events.push('prepare') }),
      start: vi.fn(async () => { events.push('start') }),
      reload: vi.fn(async () => { events.push('reload') }),
    })

    const switching = coordinator.switchTo(alice)
    await flushMicrotasks()
    expect(events).toEqual(['clear', 'stop'])
    stopped.resolve()
    await switching
    expect(events).toEqual(['clear', 'stop', 'prepare', 'start', 'reload'])
  })

  it('does not start when stop fails', async () => {
    const failure = new Error('stop failed')
    const events: string[] = []
    const coordinator = new EnterpriseIdentityCoordinator({
      userData,
      clear: vi.fn(async () => { events.push('clear') }),
      stop: vi.fn(async () => { events.push('stop'); throw failure }),
      prepare: vi.fn(async () => { events.push('prepare') }),
      start: vi.fn(async () => { events.push('start') }),
      reload: vi.fn(async () => { events.push('reload') }),
    })

    await expect(coordinator.switchTo(alice)).rejects.toMatchObject({ stage: 'stop', cause: failure })
    expect(events).toEqual(['clear', 'stop'])
    expect(coordinator.currentSpace.identity).toBeNull()
  })

  it('attempts stop after clear fails and reports clear failure', async () => {
    const clearFailure = new Error('clear failed')
    const events: string[] = []
    const coordinator = new EnterpriseIdentityCoordinator({
      userData,
      clear: vi.fn(async () => { events.push('clear'); throw clearFailure }),
      stop: vi.fn(async () => { events.push('stop') }),
      prepare: vi.fn(async () => { events.push('prepare') }),
      start: vi.fn(async () => { events.push('start') }),
      reload: vi.fn(async () => { events.push('reload') }),
    })

    await expect(coordinator.switchTo(alice)).rejects.toMatchObject({ stage: 'clear', cause: clearFailure })
    expect(events).toEqual(['clear', 'stop'])
    expect(coordinator.currentSpace.identity).toBeNull()
  })

  it('attempts stop after clear fails and reports both failures', async () => {
    const clearFailure = new Error('clear failed')
    const stopFailure = new Error('stop failed')
    const coordinator = new EnterpriseIdentityCoordinator({
      userData,
      clear: vi.fn(async () => { throw clearFailure }),
      stop: vi.fn(async () => { throw stopFailure }),
      prepare: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      reload: vi.fn(async () => {}),
    })

    await expect(coordinator.switchTo(alice)).rejects.toSatisfy((error: unknown) => {
      return error instanceof EnterpriseIdentitySwitchError
        && error.stage === 'clear-stop'
        && error.cause instanceof AggregateError
        && error.cause.errors.includes(clearFailure)
        && error.cause.errors.includes(stopFailure)
    })
  })

  it('switches to bootstrap and does not restart for the same ready bootstrap identity', async () => {
    const { coordinator, events } = fixture()

    await coordinator.switchTo(null)
    await coordinator.switchTo(null)

    expect(events).toEqual(['clear', 'stop', 'prepare:bootstrap', 'start', 'reload'])
    expect(coordinator.currentSpace.identity).toBeNull()
  })

  it('switches from an employee back to bootstrap', async () => {
    const { coordinator, events } = fixture()

    await coordinator.switchTo(alice)
    await coordinator.switchTo(null)

    expect(events).toEqual([
      'clear', 'stop', 'prepare:alice', 'start', 'reload',
      'clear', 'stop', 'prepare:bootstrap', 'start', 'reload',
    ])
    expect(coordinator.currentSpace.identity).toBeNull()
  })

  it('does not restart for the same ready identity', async () => {
    const { coordinator, events } = fixture()

    await coordinator.switchTo(alice)
    await coordinator.switchTo({ ...alice })

    expect(events).toEqual(['clear', 'stop', 'prepare:alice', 'start', 'reload'])
  })

  it('serializes different identity switches', async () => {
    const firstPrepare = deferred()
    const events: string[] = []
    const coordinator = new EnterpriseIdentityCoordinator({
      userData,
      clear: vi.fn(async () => { events.push('clear') }),
      stop: vi.fn(async () => { events.push('stop') }),
      prepare: vi.fn(async (space) => {
        events.push(`prepare:${space.identity?.employeeId ?? 'bootstrap'}`)
        if (space.identity?.employeeId === 'alice') await firstPrepare.promise
      }),
      start: vi.fn(async () => { events.push('start') }),
      reload: vi.fn(async () => { events.push('reload') }),
    })

    const first = coordinator.switchTo(alice)
    const second = coordinator.switchTo(bob)
    await flushMicrotasks()
    expect(events).toEqual(['clear', 'stop', 'prepare:alice'])
    firstPrepare.resolve()
    await Promise.all([first, second])

    expect(events).toEqual([
      'clear', 'stop', 'prepare:alice', 'start', 'reload',
      'clear', 'stop', 'prepare:bob', 'start', 'reload',
    ])
    expect(coordinator.currentSpace.identity).toEqual(bob)
  })

  it('does not spawn after dispose during an await', async () => {
    const stopped = deferred()
    const events: string[] = []
    const coordinator = new EnterpriseIdentityCoordinator({
      userData,
      clear: vi.fn(async () => { events.push('clear') }),
      stop: vi.fn(() => { events.push('stop'); return stopped.promise }),
      prepare: vi.fn(async () => { events.push('prepare') }),
      start: vi.fn(async () => { events.push('start') }),
      reload: vi.fn(async () => { events.push('reload') }),
    })

    const switching = coordinator.switchTo(alice)
    await flushMicrotasks()
    coordinator.dispose()
    stopped.resolve()
    await expect(switching).rejects.toMatchObject({ stage: 'closed' })
    expect(events).toEqual(['clear', 'stop'])
    await expect(coordinator.switchTo(bob)).rejects.toMatchObject({ stage: 'closed' })
  })

  it('does not mark ready after dispose while reload is awaiting', async () => {
    const reloadStarted = deferred()
    const reloaded = deferred()
    const events: string[] = []
    const coordinator = new EnterpriseIdentityCoordinator({
      userData,
      clear: vi.fn(async () => { events.push('clear') }),
      stop: vi.fn(async () => { events.push('stop') }),
      prepare: vi.fn(async (space) => { events.push(`prepare:${space.identity?.employeeId ?? 'bootstrap'}`) }),
      start: vi.fn(async () => { events.push('start') }),
      reload: vi.fn(() => { events.push('reload'); reloadStarted.resolve(); return reloaded.promise }),
    })

    const switching = coordinator.switchTo(alice)
    await reloadStarted.promise
    expect(events).toEqual(['clear', 'stop', 'prepare:alice', 'start', 'reload'])
    coordinator.dispose()
    reloaded.resolve()
    await expect(switching).rejects.toMatchObject({ stage: 'closed' })
    await expect(coordinator.switchTo(alice)).rejects.toMatchObject({ stage: 'closed' })
  })

  it('allows retry of the same target after reload failure', async () => {
    const failure = new Error('reload failed')
    const events: string[] = []
    let attempts = 0
    const coordinator = new EnterpriseIdentityCoordinator({
      userData,
      clear: vi.fn(async () => { events.push('clear') }),
      stop: vi.fn(async () => { events.push('stop') }),
      prepare: vi.fn(async (space) => { events.push(`prepare:${space.identity?.employeeId ?? 'bootstrap'}`) }),
      start: vi.fn(async () => { events.push('start') }),
      reload: vi.fn(async () => {
        events.push('reload')
        attempts += 1
        if (attempts === 1) throw failure
      }),
    })

    await expect(coordinator.switchTo(alice)).rejects.toMatchObject({ stage: 'reload', cause: failure })
    expect(coordinator.currentSpace.identity).toEqual(alice)
    await coordinator.switchTo(alice)

    expect(events).toEqual([
      'clear', 'stop', 'prepare:alice', 'start', 'reload',
      'clear', 'stop', 'prepare:alice', 'start', 'reload',
    ])
  })

  it('allows retry of the same target after start failure', async () => {
    const failure = new Error('start failed')
    const events: string[] = []
    let attempts = 0
    const coordinator = new EnterpriseIdentityCoordinator({
      userData,
      clear: vi.fn(async () => { events.push('clear') }),
      stop: vi.fn(async () => { events.push('stop') }),
      prepare: vi.fn(async (space) => { events.push(`prepare:${space.identity?.employeeId ?? 'bootstrap'}`) }),
      start: vi.fn(async () => {
        events.push('start')
        attempts += 1
        if (attempts === 1) throw failure
      }),
      reload: vi.fn(async () => { events.push('reload') }),
    })

    await expect(coordinator.switchTo(alice)).rejects.toMatchObject({ stage: 'start', cause: failure })
    expect(coordinator.currentSpace.identity).toEqual(alice)
    await coordinator.switchTo(alice)

    expect(events).toEqual([
      'clear', 'stop', 'prepare:alice', 'start',
      'clear', 'stop', 'prepare:alice', 'start', 'reload',
    ])
  })
})
