/** Electron Node-mode child lifecycle for the shared Web application. */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActiveDesktopSession, DesktopSessionSecretKey } from './keychain-session-store.ts'
import { enterpriseIdentityStatesEqual, parseEnterpriseIdentityState, type EnterpriseIdentityState } from './enterprise-identity-state.ts'
import type { PlatformSession } from '@deepseek-ai/dsh-deepseek-account'
import { desktopNodeEnvironment } from './node-environment.ts'

interface ReadyEvent {
  readonly type: 'ready'
  readonly url: string
  readonly injections?: readonly unknown[] | undefined
}

interface FatalEvent {
  readonly type: 'fatal'
  readonly message: string
  /** The Host's complete inspected error: stack, enumerable properties, cause chain. */
  readonly diagnostic?: string
}

interface PlatformSessionEvent {
  readonly type: 'platform-session'
  readonly session: PlatformSession | null
}

interface SecureStoreRequestEvent {
  readonly type: 'secure-store-request'
  readonly requestId: number
  readonly operation: 'get' | 'set' | 'delete' | 'save-active-session' | 'rotate-refresh' | 'clear-active-session' | 'acknowledge-revocation' | 'queue-revocation'
  readonly key?: DesktopSessionSecretKey
  readonly value?: string
  readonly session?: ActiveDesktopSession
  readonly expectedRefreshToken?: string
  readonly nextRefreshToken?: string
}

interface BrowserOpenRequestEvent {
  readonly type: 'browser-open-request'
  readonly requestId: number
  readonly url: string
}

interface EnterpriseIdentityChangeEvent {
  readonly type: 'enterprise-identity-change'
  readonly state: EnterpriseIdentityState
}

/** Native session storage capability supplied by Electron safeStorage. */
export interface DesktopHostSecureStore {
  get(key: DesktopSessionSecretKey): Promise<string | null>
  set(key: DesktopSessionSecretKey, value: string): Promise<void>
  delete(key: DesktopSessionSecretKey): Promise<void>
  saveActiveSession(session: ActiveDesktopSession): Promise<void>
  rotateRefresh(expectedRefreshToken: string, nextRefreshToken: string): Promise<boolean>
  clearActiveSession(): Promise<void>
  acknowledgeRevocation(capability: string): Promise<void>
  queueRevocation(capability: string): Promise<void>
}

type DesktopHostEvent = ReadyEvent | FatalEvent | PlatformSessionEvent | SecureStoreRequestEvent | BrowserOpenRequestEvent
  | EnterpriseIdentityChangeEvent | { readonly type: 'shutdown-complete' } | {
    readonly type: 'update-tasks'
    readonly requestId: number
    readonly active: boolean
    readonly error?: string
  } | {
    readonly type: 'quit-inspection'
    readonly requestId: number
    readonly activeTasks: boolean
    readonly scheduledTasks: boolean
    readonly error?: string
  }

/** Correlated answer to one shell control request. */
type DesktopHostControlResponse = Extract<DesktopHostEvent, { readonly requestId: number }>

/** What quitting now would affect, as reported by the Host. */
export interface DesktopQuitInspection {
  readonly activeTasks: boolean
  readonly scheduledTasks: boolean
}

/** Quit inspection deadline; a slower Host counts as unknown work and the shell asks before quitting. */
export const QUIT_INSPECTION_DEADLINE_MS = 2_000

const MAX_HOST_DIAGNOSTIC_CHARS = 64 * 1024
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u

function isValidSecureStoreValue(key: DesktopSessionSecretKey, value: string): boolean {
  if (key === 'employee-id' || key === 'company-id') return ID_PATTERN.test(value)
  if (key === 'revocation-queue') return false
  return TOKEN_PATTERN.test(value)
}

function isDesktopHostEvent(message: unknown): message is DesktopHostEvent {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  const candidate = message as Record<string, unknown>
  switch (candidate.type) {
    case 'shutdown-complete':
      return true
    case 'ready':
      return typeof candidate.url === 'string'
    case 'platform-session': {
      const session = candidate.session
      if (session === null) return true
      if (typeof session !== 'object' || !('origin' in session) || !('token' in session)
        || typeof session.origin !== 'string' || typeof session.token !== 'string' || session.token.length === 0) return false
      if (!('userId' in session) || (session.userId !== null
        && (typeof session.userId !== 'string' || session.userId.length === 0))) return false
      if ('embeddedPageDist' in session && typeof session.embeddedPageDist !== 'string') return false
      if ('requestHeaders' in session && (typeof session.requestHeaders !== 'object' || session.requestHeaders === null
        || Array.isArray(session.requestHeaders)
        || Object.entries(session.requestHeaders).some(([name, value]) => typeof value !== 'string'
          || name !== name.toLowerCase() || /[\r\n]/.test(value)
          || ['authorization', 'x-dsh-auth-token', 'host', 'content-length', 'transfer-encoding', 'connection', 'content-type'].includes(name)))) return false
      try {
        const url = new URL(session.origin)
        return url.origin === session.origin && !url.username && !url.password
          && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      } catch { return false }
    }
    case 'secure-store-request':
      if (!Number.isSafeInteger(candidate.requestId) || Number(candidate.requestId) <= 0) return false
      if (candidate.operation === 'get' || candidate.operation === 'delete') return ['refresh', 'logout-capability', 'employee-id', 'company-id', 'revocation-queue'].includes(String(candidate.key)) && candidate.value === undefined && candidate.session === undefined
      if (candidate.operation === 'set') return ['refresh', 'logout-capability', 'employee-id', 'company-id'].includes(String(candidate.key))
        && typeof candidate.value === 'string' && isValidSecureStoreValue(candidate.key as DesktopSessionSecretKey, candidate.value)
        && candidate.session === undefined
      if (candidate.operation === 'clear-active-session') return candidate.key === undefined && candidate.value === undefined && candidate.session === undefined
      if (candidate.operation === 'acknowledge-revocation') return candidate.key === undefined && typeof candidate.value === 'string' && TOKEN_PATTERN.test(candidate.value) && candidate.session === undefined
      if (candidate.operation === 'queue-revocation') return candidate.key === undefined && typeof candidate.value === 'string' && TOKEN_PATTERN.test(candidate.value) && candidate.session === undefined
      if (candidate.operation === 'rotate-refresh') {
        return Object.keys(candidate).every(key => ['type', 'requestId', 'operation', 'expectedRefreshToken', 'nextRefreshToken'].includes(key))
          && typeof candidate.expectedRefreshToken === 'string' && TOKEN_PATTERN.test(candidate.expectedRefreshToken)
          && typeof candidate.nextRefreshToken === 'string' && TOKEN_PATTERN.test(candidate.nextRefreshToken)
      }
      if (candidate.operation === 'save-active-session') {
        if (candidate.key !== undefined || candidate.value !== undefined || typeof candidate.session !== 'object' || candidate.session === null) return false
        const session = candidate.session as Record<string, unknown>
        return Object.keys(session).length === 4 && typeof session.refreshToken === 'string' && TOKEN_PATTERN.test(session.refreshToken)
          && typeof session.logoutCapability === 'string' && TOKEN_PATTERN.test(session.logoutCapability)
          && typeof session.employeeId === 'string' && ID_PATTERN.test(session.employeeId)
          && typeof session.companyId === 'string' && ID_PATTERN.test(session.companyId)
      }
      return false
    case 'enterprise-identity-change':
      return parseEnterpriseIdentityState(candidate.state) !== null
    case 'browser-open-request':
      if (!Number.isSafeInteger(candidate.requestId) || Number(candidate.requestId) <= 0 || typeof candidate.url !== 'string' || candidate.url.length > 2048) return false
      try {
        const url = new URL(candidate.url)
        return url.protocol === 'https:' && !url.username && !url.password
      } catch { return false }
    case 'fatal':
      return typeof candidate.message === 'string' && (candidate.diagnostic === undefined || typeof candidate.diagnostic === 'string')
    case 'update-tasks':
      return Number.isSafeInteger(candidate.requestId) && typeof candidate.active === 'boolean'
        && (candidate.error === undefined || typeof candidate.error === 'string')
    case 'quit-inspection':
      return Number.isSafeInteger(candidate.requestId) && typeof candidate.activeTasks === 'boolean'
        && typeof candidate.scheduledTasks === 'boolean' && (candidate.error === undefined || typeof candidate.error === 'string')
    default:
      return false
  }
}

async function exitsWithin(exit: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => { resolve(false) }, milliseconds)
    timer.unref()
  })
  try {
    return await Promise.race([exit.then(() => true), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Browser authentication URL reported by the running Web application. */
export interface DesktopHostReady {
  readonly url: string
  readonly injections?: readonly unknown[] | undefined
}

/** The child has exited, but task teardown did not finish successfully. */
export class DesktopHostUncleanExitError extends Error {}

/**
 * A Host failure reported over IPC before the process exited. `message` is what
 * the Host chose to show; `diagnostic` is its complete inspected error, kept
 * separately so a crash report can print it verbatim instead of a string escaped
 * inside another error's properties.
 */
export class DesktopHostFatalError extends Error {
  readonly #diagnostic: string | undefined

  /**
   * @param message - The Host's failure message.
   * @param diagnostic - The Host's inspected error, when the Host supplied one.
   */
  constructor(message: string, diagnostic: string | undefined) {
    super(message)
    this.#diagnostic = diagnostic
  }

  /** The Host's inspected error; a getter so `util.inspect` of this error does not repeat it as an escaped property. */
  get diagnostic(): string | undefined { return this.#diagnostic }
}

/** One Web backend running under the Electron executable in Node mode. */
export class DesktopHostProcess {
  private child: ChildProcess | undefined
  private allowlistDir: string | undefined
  private readyResolve!: (ready: DesktopHostReady) => void
  private readyReject!: (error: Error) => void
  private readonly readyPromise = new Promise<DesktopHostReady>((resolve, reject) => {
    this.readyResolve = resolve
    this.readyReject = reject
  })
  private exitPromise: Promise<void> | undefined
  private stderr = ''
  /** Bounded child stderr for private diagnostics; callers must redact credentials before publishing. */
  get diagnostic(): string { return this.stderr }
  private failureReported = false
  private stopping = false
  private shutdownCompleted = false
  private nextControlId = 1
  private enterpriseIdentityDeliveryReady = false
  private pendingEnterpriseIdentity: EnterpriseIdentityState | undefined
  private deliveredEnterpriseIdentity: EnterpriseIdentityState | undefined
  private readonly controlRequests = new Map<number, {
    resolve: (response: DesktopHostControlResponse) => void
    reject: (error: Error) => void
  }>()

  /**
   * @param node - Absolute Electron executable in Node mode.
   * @param runtimeDir - Immutable packages carried by the current application.
   * @param projectDir - Desktop plugin profile and child working directory.
   * @param inspectPort - Optional loopback inspector port for workspace development.
   * @param environment - Environment inherited by the Host and its plugin subprocesses.
   * @param onFailure - Receives the first unexpected child failure, including after readiness.
   * @param primaryRuntime - Optional bundled dependency payload; when supplied, missing sibling
   *   `office-skills` resources fail Host startup.
   * @param packageManager - Bundled pnpm entry and Node launcher directory, scoped to package operations.
   * @param onPlatformSession - Private credential updates for embedded Platform views.
   */
  constructor(
    private readonly node: string,
    private readonly runtimeDir: string,
    private readonly projectDir: string,
    private readonly inspectPort?: number,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly onFailure?: (error: Error) => void,
    private readonly primaryRuntime?: string,
    private readonly packageManager?: { readonly pnpm: string; readonly nodeBin: string },

    private readonly onPlatformSession?: (session: PlatformSession | null) => void,
    private readonly secureStore?: DesktopHostSecureStore,
    private readonly openExternal?: (url: string) => Promise<void>,
    private readonly allowedHostPlugins?: readonly { readonly name: string; readonly version: string; readonly path: string }[],
    private readonly trustedHostPackages?: readonly { readonly name: string; readonly version: string; readonly path: string }[],
    private readonly onEnterpriseIdentity?: (state: EnterpriseIdentityState) => void,
    private readonly enterpriseServiceOrigin?: string,
  ) {}

  /** Enables enterprise identity delivery after the native wrapper has finished its own startup bookkeeping. */
  flushPendingEnterpriseIdentity(): void {
    if (this.enterpriseIdentityDeliveryReady) return
    this.enterpriseIdentityDeliveryReady = true
    const state = this.pendingEnterpriseIdentity
    this.pendingEnterpriseIdentity = undefined
    if (state !== undefined) this.deliverEnterpriseIdentity(state)
  }

  /**
   * Start this child once and await its Web application URL.
   * @returns Ready facts supplied by the child after application startup.
   */
  async start(): Promise<DesktopHostReady> {
    if (this.child !== undefined) return this.readyPromise
    const entry = join(this.runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')
    const allowlistFile = this.writeAllowlistFile()
    let child: ChildProcess
    try {
      child = spawn(this.node, [
        '--expose-internals',
        ...(this.inspectPort === undefined ? [] : [`--inspect=127.0.0.1:${String(this.inspectPort)}`]),
        entry,
        this.runtimeDir,
        this.projectDir,
        this.primaryRuntime ?? join(this.runtimeDir, '..', 'runtime', 'primary-runtime'),
        ...this.packageManager === undefined ? [] : [this.packageManager.pnpm, this.packageManager.nodeBin],
        ...(allowlistFile === undefined ? [] : [`--dsh-host-plugin-allowlist-file=${allowlistFile}`]),
      ], {
        cwd: this.projectDir,
        env: desktopNodeEnvironment(this.node, undefined, this.enterpriseServiceOrigin === undefined ? this.environment
          : { ...this.environment, DSH_ENTERPRISE_SERVICE_ORIGIN: this.enterpriseServiceOrigin }),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
    } catch (error) {
      this.cleanupAllowlistFile()
      throw error
    }
    this.child = child
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-MAX_HOST_DIAGNOSTIC_CHARS) })
    child.stdout?.pipe(process.stdout)
    child.on('message', (message: unknown) => {
      if (!isDesktopHostEvent(message)) {
        this.fail(new Error('dsh desktop host sent an invalid IPC event'))
        child.kill('SIGTERM')
        return
      }
      if (message.type === 'ready') this.readyResolve({ url: message.url, injections: message.injections })
      else if (message.type === 'platform-session') this.onPlatformSession?.(message.session)
      else if (message.type === 'secure-store-request') void this.answerSecureStoreRequest(message)
      else if (message.type === 'browser-open-request') void this.answerBrowserOpenRequest(message)
      else if (message.type === 'enterprise-identity-change') {
        if (!this.acceptEnterpriseIdentityChange(message.state)) {
          this.fail(new Error('dsh desktop host sent an invalid IPC event'))
          child.kill('SIGTERM')
        }
      }
      else if (message.type === 'shutdown-complete') {
        if (this.stopping) this.shutdownCompleted = true
        else this.fail(new Error('dsh desktop host acknowledged an unrequested shutdown'))
      }
      else if (message.type === 'fatal') this.fail(new DesktopHostFatalError(message.message, message.diagnostic))
      else {
        const request = this.controlRequests.get(message.requestId)
        if (message.error === undefined) request?.resolve(message)
        else request?.reject(new Error(message.error))
      }
    })
    child.once('error', (error) => { this.fail(error) })
    this.exitPromise = new Promise<void>((resolve) => {
      child.once('close', (code) => {
        const suffix = this.stderr.trim() === '' ? '' : `: ${this.stderr.trim()}`
        if (code !== 0 && code !== null) this.fail(new Error(`dsh desktop host exited with ${String(code)}${suffix}`))
        else this.fail(new Error(`dsh desktop host stopped${suffix}`))
        resolve()
      })
    })
    return this.readyPromise
  }

  /**
   * Write the sealed Host policy to a private launch file. Windows caps a
   * spawned command line at 32,767 characters, and the packaged enterprise
   * allowlist is far larger.
   * @returns the launch file path, or undefined when this launch has no policy.
   */
  private writeAllowlistFile(): string | undefined {
    if (this.allowedHostPlugins === undefined) return undefined
    const directory = mkdtempSync(join(tmpdir(), 'dsh-host-allowlist-'))
    const file = join(directory, 'allowlist.json')
    try {
      writeFileSync(file, JSON.stringify({
        plugins: this.allowedHostPlugins, packages: this.trustedHostPackages,
        ...(this.enterpriseServiceOrigin === undefined ? {} : { enterpriseServiceOrigin: this.enterpriseServiceOrigin }),
      }), { mode: 0o600 })
    } catch (error) {
      rmSync(directory, { recursive: true, force: true })
      throw error
    }
    this.allowlistDir = directory
    return file
  }

  /** Remove the launch file once the Host has read it or can no longer start. */
  private cleanupAllowlistFile(): void {
    const directory = this.allowlistDir
    if (directory === undefined) return
    this.allowlistDir = undefined
    try { rmSync(directory, { recursive: true, force: true }) }
    catch { /* a stale private launch file does not affect the sealed policy */ }
  }

  /**
   * Inspect active work or lock request admission for update handoff.
   * @param action - Read-only inspection, admission lock, or recovery unlock.
   * @returns Whether live tasks would be affected. Locking drains admitted API requests before inspecting tasks;
   * an unanswered drain fails at the control-request deadline without authorizing installation.
   */
  async updateTasks(action: 'inspect' | 'lock' | 'unlock'): Promise<boolean> {
    const response = await this.control({ type: 'update-tasks', action }, 10_000, 'desktop update: task inspection timed out')
    if (response.type !== 'update-tasks') throw new Error('desktop update: Host answered with a different control response')
    return response.active
  }

  /**
   * Ask the Host what quitting now would interrupt.
   * @returns Active tasks and armed scheduled reminders; rejects when the Host is unavailable or misses
   * {@link QUIT_INSPECTION_DEADLINE_MS}, and the shell then asks before quitting.
   */
  async inspectQuit(): Promise<DesktopQuitInspection> {
    const response = await this.control({ type: 'quit-inspection' }, QUIT_INSPECTION_DEADLINE_MS, 'desktop quit: inspection timed out')
    if (response.type !== 'quit-inspection') throw new Error('desktop quit: Host answered with a different control response')
    return { activeTasks: response.activeTasks, scheduledTasks: response.scheduledTasks }
  }

  private async control(
    request: { readonly type: 'update-tasks'; readonly action: 'inspect' | 'lock' | 'unlock' } | { readonly type: 'quit-inspection' },
    deadlineMs: number, deadlineMessage: string,
  ): Promise<DesktopHostControlResponse> {
    const child = this.child
    if (child === undefined || !child.connected || this.failureReported || this.stopping) {
      throw new Error(`${request.type === 'update-tasks' ? 'desktop update' : 'desktop quit'}: Host is unavailable`)
    }
    const requestId = this.nextControlId++
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<DesktopHostControlResponse>((resolve, reject) => {
        this.controlRequests.set(requestId, { resolve, reject })
        timer = setTimeout(() => { reject(new Error(deadlineMessage)) }, deadlineMs)
        child.send({ ...request, requestId }, (error) => { if (error !== null) reject(error) })
      })
    } finally {
      clearTimeout(timer)
      this.controlRequests.delete(requestId)
    }
  }

  /**
   * Request teardown and await child exit, escalating termination when needed.
   * @param requireGraceful - Reject update handoff after forced termination or unsuccessful child exit.
   * @returns Completion of owned process teardown. DesktopHostUncleanExitError confirms exit but refuses installation;
   * other failures do not confirm exit.
   */
  async stop(requireGraceful = false): Promise<void> {
    const child = this.child
    if (child === undefined) return
    this.stopping = true
    this.onPlatformSession?.(null)
    if (child.connected) child.send({ type: 'shutdown' }, (error) => { if (error !== null) this.fail(error) })
    const exited = this.exitPromise ?? Promise.resolve()
    const graceful = await exitsWithin(exited, 10_000)
    if (!graceful) child.kill('SIGTERM')
    if (!await exitsWithin(exited, 5_000)) {
      child.kill('SIGKILL')
      if (!await exitsWithin(exited, 5_000)) {
        throw new Error('dsh desktop host did not exit after SIGKILL')
      }
    }
    this.child = undefined
    this.cleanupAllowlistFile()
    if (requireGraceful && (!graceful || child.exitCode !== 0 || !this.shutdownCompleted)) {
      // This diagnostic reaches expandable UI; arbitrary plugin stderr can contain credentials.
      throw new DesktopHostUncleanExitError(`desktop update: Host did not complete graceful task teardown (exit ${String(child.exitCode)}, signal ${String(child.signalCode)}, shutdown acknowledged ${String(this.shutdownCompleted)}, graceful deadline exceeded ${String(!graceful)})`)
    }
  }

  private acceptEnterpriseIdentityChange(state: EnterpriseIdentityState): boolean {
    if (!this.hasApprovedEnterpriseIdentityPackage()) return false
    if (this.stopping || this.failureReported) return true
    const current = this.enterpriseIdentityDeliveryReady ? this.deliveredEnterpriseIdentity : this.pendingEnterpriseIdentity
    if (current !== undefined) {
      if (state.generation < current.generation) return true
      if (state.generation === current.generation && enterpriseIdentityStatesEqual(state, current)) return true
    }
    if (this.enterpriseIdentityDeliveryReady) this.deliverEnterpriseIdentity(state)
    else this.pendingEnterpriseIdentity = state
    return true
  }

  private hasApprovedEnterpriseIdentityPackage(): boolean {
    if (this.allowedHostPlugins === undefined) return false
    return this.allowedHostPlugins.some(plugin => plugin.name === '@dsh-enterprise/harness-identity')
  }

  private deliverEnterpriseIdentity(state: EnterpriseIdentityState): void {
    if (this.stopping || this.failureReported) return
    this.deliveredEnterpriseIdentity = state
    try {
      this.onEnterpriseIdentity?.(state)
    } catch {
      this.fail(new Error('dsh desktop host enterprise identity listener failed'))
    }
  }

  private fail(error: Error): void {
    this.cleanupAllowlistFile()
    this.onPlatformSession?.(null)
    this.readyReject(error)
    for (const request of this.controlRequests.values()) request.reject(error)
    this.controlRequests.clear()
    if (!this.failureReported && !this.stopping) {
      this.failureReported = true
      try { this.onFailure?.(error) } catch (listenerError) {
        console.error('desktop host failure listener failed', listenerError)
      }
    }
  }

  private async answerSecureStoreRequest(request: SecureStoreRequestEvent): Promise<void> {
    const child = this.child
    let response: { readonly type: 'secure-store-response'; readonly requestId: number; readonly success: boolean; readonly value?: string | null | boolean } = {
      type: 'secure-store-response', requestId: request.requestId, success: false,
    }
    if (this.secureStore !== undefined && this.hasApprovedEnterpriseIdentityPackage() && !this.stopping && !this.failureReported) {
      try {
        if (request.operation === 'get' && request.key !== undefined) response = {
          type: 'secure-store-response', requestId: request.requestId, success: true,
          value: await this.secureStore.get(request.key),
        }
        else if (request.operation === 'set' && request.key !== undefined) {
          if (request.value === undefined) throw new Error('Invalid secure-store request')
          await this.secureStore.set(request.key, request.value)
          response = { type: 'secure-store-response', requestId: request.requestId, success: true }
        }
        else if (request.operation === 'delete' && request.key !== undefined) {
          await this.secureStore.delete(request.key)
          response = { type: 'secure-store-response', requestId: request.requestId, success: true }
        }
        else if (request.operation === 'save-active-session' && request.session !== undefined) {
          await this.secureStore.saveActiveSession(request.session)
          response = { type: 'secure-store-response', requestId: request.requestId, success: true }
        }
        else if (request.operation === 'rotate-refresh' && request.expectedRefreshToken !== undefined && request.nextRefreshToken !== undefined) {
          response = {
            type: 'secure-store-response', requestId: request.requestId, success: true,
            value: await this.secureStore.rotateRefresh(request.expectedRefreshToken, request.nextRefreshToken),
          }
        }
        else if (request.operation === 'clear-active-session') {
          await this.secureStore.clearActiveSession()
          response = { type: 'secure-store-response', requestId: request.requestId, success: true }
        }
        else if (request.operation === 'acknowledge-revocation' && request.value !== undefined) {
          await this.secureStore.acknowledgeRevocation(request.value)
          response = { type: 'secure-store-response', requestId: request.requestId, success: true }
        }
        else if (request.operation === 'queue-revocation' && request.value !== undefined) {
          await this.secureStore.queueRevocation(request.value)
          response = { type: 'secure-store-response', requestId: request.requestId, success: true }
        }
      } catch {
        response = { type: 'secure-store-response', requestId: request.requestId, success: false }
      }
    }
    if (child?.connected) {
      const finalResponse = this.stopping || this.failureReported
        ? { type: 'secure-store-response' as const, requestId: request.requestId, success: false }
        : response
      child.send(finalResponse, (error) => { if (error !== null) this.fail(new Error('dsh desktop host secure storage IPC failed')) })
    }
  }

  private async answerBrowserOpenRequest(request: BrowserOpenRequestEvent): Promise<void> {
    const child = this.child
    let success = false
    if (this.openExternal !== undefined && this.hasApprovedEnterpriseIdentityPackage() && !this.stopping && !this.failureReported) {
      try { await this.openExternal(request.url); success = true } catch { success = false }
    }
    if (child?.connected) child.send({
      type: 'browser-open-response', requestId: request.requestId,
      success: success && !this.stopping && !this.failureReported,
    }, (error) => { if (error !== null) this.fail(new Error('dsh desktop host browser IPC failed')) })
  }
}
