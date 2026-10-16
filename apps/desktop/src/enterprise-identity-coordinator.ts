/** Serial enterprise identity switching transaction for the native desktop shell. */

import {
  resolveEnterpriseDataSpace,
  type EnterpriseDataSpace,
  type EnterpriseDataSpaceIdentity,
} from './enterprise-data-space.ts'

export type EnterpriseIdentitySwitchStage =
  | 'closed'
  | 'clear'
  | 'stop'
  | 'clear-stop'
  | 'prepare'
  | 'start'
  | 'reload'

export interface EnterpriseIdentityCoordinatorOptions {
  readonly userData: string
  clear(): Promise<void>
  stop(): Promise<void>
  prepare(space: EnterpriseDataSpace): Promise<void>
  start(): Promise<void>
  reload(): Promise<void>
}

/** Stage-tagged failure so main can report ownership without branching on message text. */
export class EnterpriseIdentitySwitchError extends Error {
  constructor(readonly stage: EnterpriseIdentitySwitchStage, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'EnterpriseIdentitySwitchError'
  }
}

type TargetIdentity = EnterpriseDataSpaceIdentity | null

/** Owns one serialized data-space switch across clear, stop, prepare, start and reload. */
export class EnterpriseIdentityCoordinator {
  private readonly userData: string
  private current: EnterpriseDataSpace
  private ready = false
  private closed = false
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly options: EnterpriseIdentityCoordinatorOptions) {
    this.userData = options.userData
    this.current = resolveEnterpriseDataSpace(this.userData, null)
  }

  get currentSpace(): EnterpriseDataSpace { return this.current }

  /** Synchronously close this coordinator; in-flight switches stop at the next await boundary. */
  dispose(): void { this.closed = true }

  /** Queue one identity switch. Same ready identity is a no-op; failed targets can be retried explicitly. */
  switchTo(identity: TargetIdentity): Promise<void> {
    const requested = identity === null ? null : Object.freeze({ companyId: identity.companyId, employeeId: identity.employeeId })
    const run = this.tail.then(() => this.execute(requested))
    this.tail = run.catch(() => {})
    return run
  }

  private ensureOpen(): void {
    if (this.closed) throw new EnterpriseIdentitySwitchError('closed', 'Enterprise identity coordinator is closed.')
  }

  private async execute(identity: TargetIdentity): Promise<void> {
    this.ensureOpen()
    const target = resolveEnterpriseDataSpace(this.userData, identity)
    if (this.ready && sameIdentity(this.current.identity, target.identity)) return

    const stopFailure = await this.clearAndStop()
    if (stopFailure !== undefined) throw stopFailure
    this.ensureOpen()

    this.current = target
    this.ready = false

    await this.callStage('prepare', () => this.options.prepare(target))
    this.ensureOpen()
    await this.callStage('start', () => this.options.start())
    this.ensureOpen()
    await this.callStage('reload', () => this.options.reload())
    this.ensureOpen()
    this.ready = true
  }

  private async clearAndStop(): Promise<EnterpriseIdentitySwitchError | undefined> {
    let clearFailure: unknown
    try { await this.options.clear() } catch (error) { clearFailure = error }
    let stopFailure: unknown
    try { await this.options.stop() } catch (error) { stopFailure = error }

    if (clearFailure !== undefined && stopFailure !== undefined) {
      return new EnterpriseIdentitySwitchError(
        'clear-stop',
        'Enterprise identity switch could not clear forwarding or stop the old Host.',
        { cause: new AggregateError([clearFailure, stopFailure], 'Enterprise identity switch cleanup failed') },
      )
    }
    if (clearFailure !== undefined) {
      return new EnterpriseIdentitySwitchError('clear', 'Enterprise identity switch could not clear old forwarding state.', { cause: clearFailure })
    }
    if (stopFailure !== undefined) {
      return new EnterpriseIdentitySwitchError('stop', 'Enterprise identity switch could not stop the old Host.', { cause: stopFailure })
    }
    return undefined
  }

  private async callStage(stage: 'prepare' | 'start' | 'reload', action: () => Promise<void>): Promise<void> {
    try { await action() }
    catch (error) { throw new EnterpriseIdentitySwitchError(stage, `Enterprise identity switch failed during ${stage}.`, { cause: error }) }
  }
}

function sameIdentity(left: TargetIdentity, right: TargetIdentity): boolean {
  if (left === null || right === null) return left === right
  return left.companyId === right.companyId && left.employeeId === right.employeeId
}
