/** Native Host epoch ownership and admission fencing for enterprise employee switches. */

import type { EnterpriseDataSpace, EnterpriseDataSpaceIdentity } from './enterprise-data-space.ts'
import {
  EnterpriseIdentityCoordinator,
  EnterpriseIdentitySwitchError,
  type EnterpriseIdentityCoordinatorOptions,
} from './enterprise-identity-coordinator.ts'
import type { EnterpriseIdentityState } from './enterprise-identity-state.ts'

/** Main-process lifecycle callbacks; the binding owns only startup promises it installs. */
export interface EnterpriseNativeIdentityBindingOptions extends EnterpriseIdentityCoordinatorOptions {
  /** Return the currently owned Host startup or switch operation. */
  getStartup(): Promise<void> | undefined
  /** Replace the main-process startup reference with the supplied operation. */
  setStartup(promise: Promise<void> | undefined): void
  /** Report whether application shutdown has started. */
  isClosing(): boolean
  /** Report a terminal switch failure; admission remains closed until this binding is disposed. */
  onFailure(error: unknown): void
}

/** The Host's immutable epoch and the data space selected before its creation. */
export interface EnterpriseNativeHostIdentity {
  readonly epoch: number
  readonly space: EnterpriseDataSpace
}

type TargetIdentity = EnterpriseDataSpaceIdentity | null

/**
 * Serializes current-Host identity events after startup and fences all renderer forwarding.
 * A failed switch can leave the old renderer alive, so failure permanently closes admission.
 */
export class EnterpriseNativeIdentityBinding {
  private readonly coordinator: EnterpriseIdentityCoordinator
  private epoch = 0
  private requestedIdentity: TargetIdentity = null
  private pending = 0
  private failed = false
  private closed = false

  constructor(private readonly options: EnterpriseNativeIdentityBindingOptions) {
    this.coordinator = new EnterpriseIdentityCoordinator(options)
  }

  /** Current employee storage selection; forwarding also requires `switching` to be false. */
  get currentSpace(): EnterpriseDataSpace { return this.coordinator.currentSpace }

  /** Whether API, WebSocket and guest admission must remain closed. */
  get switching(): boolean {
    return this.pending > 0 || this.failed || this.closed || this.options.isClosing()
  }

  /**
   * Capture a new Host's ownership before registering its identity observer.
   * @returns An increasing epoch and the selected data space for this Host.
   */
  beginHost(): EnterpriseNativeHostIdentity {
    if (this.closed || this.options.isClosing()) {
      throw new EnterpriseIdentitySwitchError('closed', 'Enterprise native identity binding is closed.')
    }
    this.epoch += 1
    this.requestedIdentity = this.currentSpace.identity
    return Object.freeze({ epoch: this.epoch, space: this.currentSpace })
  }

  /**
   * Fence and schedule a changed company/employee identity from the current Host.
   * @param epoch Epoch captured when this Host was created; stale Hosts cannot select storage.
   * @param state Validated public identity state; generations are local to each Host process.
   */
  observe(epoch: number, state: EnterpriseIdentityState): void {
    if (!this.accepts(epoch)) return
    const identity = state.status === 'signed-in'
      ? Object.freeze({ companyId: state.companyId, employeeId: state.employeeId })
      : null
    if (sameIdentity(identity, this.requestedIdentity)) return
    this.requestedIdentity = identity
    const previousStartup = this.options.getStartup()
    this.pending += 1

    const operation = Promise.resolve().then(async () => {
      await previousStartup
      if (!this.accepts(epoch)) return
      await this.coordinator.switchTo(identity)
    })
    const ownedStartup = operation.catch((error: unknown) => {
      this.failed = true
      this.reportFailure(error)
    }).finally(() => {
      this.pending -= 1
      if (this.options.getStartup() === ownedStartup) this.options.setStartup(undefined)
    })
    this.options.setStartup(ownedStartup)
  }

  /** Synchronously close admission and prevent queued or in-flight switches from spawning Hosts. */
  dispose(): void {
    this.closed = true
    this.coordinator.dispose()
  }

  private accepts(epoch: number): boolean {
    return !this.closed && !this.failed && !this.options.isClosing() && epoch === this.epoch
  }

  private reportFailure(error: unknown): void {
    try { this.options.onFailure(error) }
    catch (reportingError) {
      const failure = new AggregateError([error, reportingError], 'Enterprise identity failure reporter failed.', { cause: reportingError })
      try { console.error('[enterprise] Identity switching stopped; failure reporting also failed.', failure) }
      catch (consoleError) {
        try { process.stderr.write('[enterprise] Identity switching stopped; diagnostic reporting is unavailable.\n') }
        catch (stderrError) { /* Admission stays closed even when both diagnostic outputs are unavailable. */ }
      }
    }
  }
}

function sameIdentity(left: TargetIdentity, right: TargetIdentity): boolean {
  if (left === null || right === null) return left === right
  return left.companyId === right.companyId && left.employeeId === right.employeeId
}
