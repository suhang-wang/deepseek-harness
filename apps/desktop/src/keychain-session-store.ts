/** Encrypted persistence for enterprise desktop identity credentials. */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

export type DesktopSessionSecretKey = 'refresh' | 'logout-capability' | 'employee-id' | 'company-id' | 'revocation-queue'

/** Electron safeStorage operations backed by macOS Keychain or Windows DPAPI. */
export interface KeychainEncryption {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(value: string): Promise<Buffer>
  decryptStringAsync(value: Buffer): Promise<{ readonly result: string; readonly shouldReEncrypt: boolean }>
}

type SessionRecords = Partial<Record<DesktopSessionSecretKey, string>>
export interface ActiveDesktopSession {
  readonly refreshToken: string
  readonly logoutCapability: string
  readonly employeeId: string
  readonly companyId: string
}
const SESSION_FILE = 'enterprise-session.bin'
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u
const KEYS = ['refresh', 'logout-capability', 'employee-id', 'company-id', 'revocation-queue'] as const
const KEYCHAIN_OPERATION_TIMEOUT_MS = 8_000

/** Stores refresh and revocation credentials encrypted by Electron safeStorage. */
export class KeychainSessionStore {
  private tail: Promise<void> = Promise.resolve()
  private readonly filename: string

  /**
   * @param userData - Electron's application-owned user-data directory.
   * @param encryption - Electron safeStorage API.
   * @param platform - runtime platform, injectable for tests.
   */
  constructor(
    userData: string,
    private readonly encryption: KeychainEncryption,
    private readonly platform = process.platform,
    private readonly operationTimeoutMs = KEYCHAIN_OPERATION_TIMEOUT_MS,
  ) {
    this.filename = join(userData, SESSION_FILE)
  }

  /** Exercise the OS-backed encryptor before redeeming a one-time browser login. */
  probeWritable(): Promise<void> {
    return this.serial(async () => {
      await this.readRecords()
      const canary = randomUUID()
      const encrypted = await this.keychainOperation(() => this.encryption.encryptStringAsync(canary))
      const temporary = `${this.filename}.${randomUUID()}.probe`
      const renamed = `${temporary}.ready`
      try {
        await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
        await writeFile(temporary, encrypted.toString('base64'), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        await rename(temporary, renamed)
        const stored = await readFile(renamed, 'utf8')
        const decrypted = await this.keychainOperation(() => this.encryption.decryptStringAsync(Buffer.from(stored, 'base64')))
        if (decrypted.result !== canary) throw new Error(this.unavailableMessage())
      } finally {
        await Promise.all([rm(temporary, { force: true }), rm(renamed, { force: true })])
      }
    })
  }

  /**
   * @param key - identity field to read.
   * @returns the stored field or null.
   * @throws when OS credential encryption or stored ciphertext is unavailable.
   */
  get(key: DesktopSessionSecretKey): Promise<string | null> {
    return this.serial(async () => (await this.readRecords())[key] ?? null)
  }

  /**
   * @param key - identity field to write.
   * @param value - validated credential or employee identifier.
   * @throws when the value is invalid or the encrypted update fails.
   */
  set(key: DesktopSessionSecretKey, value: string): Promise<void> {
    return this.serial(async () => {
      this.validateValue(key, value)
      const current = await this.readRecords()
      const next = { ...current, [key]: value }
      await this.writeRecords(next)
    })
  }

  /** @param key - identity field to remove. @throws when the encrypted record cannot be read or updated. */
  delete(key: DesktopSessionSecretKey): Promise<void> {
    return this.serial(async () => {
      const current = await this.readRecords()
      if (!(key in current)) return
      const next = Object.fromEntries(Object.entries(current).filter(([name]) => name !== key)) as SessionRecords
      if (Object.keys(next).length === 0) {
        await rm(this.filename, { force: true })
        return
      }
      await this.writeRecords(next)
    })
  }

  /** Atomically replaces active credentials while retaining pending revocations. */
  saveActiveSession(session: ActiveDesktopSession): Promise<void> {
    return this.serial(async () => {
      this.validateValue('refresh', session.refreshToken)
      this.validateValue('logout-capability', session.logoutCapability)
      this.validateValue('employee-id', session.employeeId)
      this.validateValue('company-id', session.companyId)
      const current = await this.readRecords()
      const queue = this.readQueue(current)
      if (current['logout-capability'] && current['logout-capability'] !== session.logoutCapability) queue.push(current['logout-capability'])
      const uniqueQueue = [...new Set(queue)]
      this.assertQueueCapacity(uniqueQueue)
      await this.writeRecords({ ...current, refresh: session.refreshToken, 'logout-capability': session.logoutCapability,
        'employee-id': session.employeeId, 'company-id': session.companyId,
        ...(uniqueQueue.length ? { 'revocation-queue': JSON.stringify(uniqueQueue) } : {}) })
    })
  }

  /** Atomically replaces the active refresh token only when it still matches the caller's current session. */
  rotateRefresh(expectedRefreshToken: string, nextRefreshToken: string): Promise<boolean> {
    return this.serial(async () => {
      this.validateValue('refresh', expectedRefreshToken)
      this.validateValue('refresh', nextRefreshToken)
      const current = await this.readRecords()
      if (current.refresh !== expectedRefreshToken || current['logout-capability'] === undefined
        || current['employee-id'] === undefined || current['company-id'] === undefined) return false
      await this.writeRecords({ ...current, refresh: nextRefreshToken })
      return true
    })
  }

  /** Atomically removes active credentials and queues their revocation capability. */
  clearActiveSession(): Promise<void> {
    return this.serial(async () => {
      const current = await this.readRecords()
      const queue = this.readQueue(current)
      if (current['logout-capability']) queue.push(current['logout-capability'])
      const uniqueQueue = [...new Set(queue)]
      this.assertQueueCapacity(uniqueQueue)
      const next: SessionRecords = { ...(uniqueQueue.length ? { 'revocation-queue': JSON.stringify(uniqueQueue) } : {}) }
      await this.writeRecords(next)
    })
  }

  /** Queues a redeemed session that lost its login attempt before local activation. */
  queueRevocation(capability: string): Promise<void> {
    return this.serial(async () => {
      this.validateValue('logout-capability', capability)
      const current = await this.readRecords()
      const queue = [...new Set([...this.readQueue(current), capability])]
      this.assertQueueCapacity(queue)
      await this.writeRecords({ ...current, 'revocation-queue': JSON.stringify(queue) })
    })
  }

  /** Removes a remotely acknowledged capability from the durable queue. */
  acknowledgeRevocation(capability: string): Promise<void> {
    return this.serial(async () => {
      this.validateValue('logout-capability', capability)
      const current = await this.readRecords()
      const queue = this.readQueue(current).filter(item => item !== capability)
      const next = { ...current, ...(queue.length ? { 'revocation-queue': JSON.stringify(queue) } : {}) }
      if (!queue.length) delete next['revocation-queue']
      await this.writeRecords(next)
    })
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  private async assertAvailable(): Promise<void> {
    if (this.platform !== 'darwin' && this.platform !== 'win32') {
      throw new Error('Enterprise credentials require the macOS Keychain or Windows DPAPI.')
    }
    if (!await this.keychainOperation(() => this.encryption.isAsyncEncryptionAvailable())) {
      throw new Error(this.unavailableMessage())
    }
  }

  private unavailableMessage(): string {
    return this.platform === 'win32' ? 'Windows secure storage encryption is unavailable.' : 'Keychain encryption is unavailable.'
  }

  private async keychainOperation<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { reject(new Error(this.platform === 'win32'
            ? 'Windows secure storage operation timed out.' : 'Keychain operation timed out.')) }, this.operationTimeoutMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private validateValue(key: DesktopSessionSecretKey, value: string): void {
    const valid = key === 'employee-id' || key === 'company-id' ? ID_PATTERN.test(value)
      : key === 'revocation-queue' ? this.validQueue(value) : TOKEN_PATTERN.test(value)
    if (!valid) throw new Error('Enterprise session data is invalid.')
  }

  private validQueue(value: string): boolean {
    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) && parsed.length <= 100 && parsed.every(item => typeof item === 'string' && TOKEN_PATTERN.test(item))
    } catch { return false }
  }

  private readQueue(records: SessionRecords): string[] {
    const raw = records['revocation-queue']
    if (raw === undefined) return []
    if (!this.validQueue(raw)) throw new Error('Stored session data is unavailable.')
    return JSON.parse(raw) as string[]
  }

  private assertQueueCapacity(queue: readonly string[]): void {
    if (queue.length > 100) throw new Error('Pending credential revocation capacity is exhausted.')
  }

  private async readRecords(): Promise<SessionRecords> {
    await this.assertAvailable()
    let encrypted: string
    try { encrypted = await readFile(this.filename, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw new Error('Stored session data is unavailable.')
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encrypted) || encrypted.length === 0) {
      throw new Error('Stored session data is unavailable.')
    }
    try {
      const decrypted = await this.keychainOperation(() => this.encryption.decryptStringAsync(Buffer.from(encrypted, 'base64')))
      const parsed: unknown = JSON.parse(decrypted.result)
      const records = this.parseRecords(parsed)
      if (decrypted.shouldReEncrypt) await this.writeRecords(records)
      return records
    } catch {
      throw new Error('Stored session data is unavailable.')
    }
  }

  private parseRecords(value: unknown): SessionRecords {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid')
    const entries = Object.entries(value)
    if (entries.some(([key, item]) => !KEYS.includes(key as DesktopSessionSecretKey) || typeof item !== 'string')) throw new Error('invalid')
    const records = value as SessionRecords
    for (const [key, item] of Object.entries(records)) {
      if (typeof item !== 'string') throw new Error('invalid')
      this.validateValue(key as DesktopSessionSecretKey, item)
    }
    return records
  }

  private async writeRecords(records: SessionRecords): Promise<void> {
    await this.assertAvailable()
    let encrypted: Buffer
    try { encrypted = await this.keychainOperation(() => this.encryption.encryptStringAsync(JSON.stringify(records))) }
    catch { throw new Error('Enterprise credentials could not be saved.') }
    const contents = encrypted.toString('base64')
    const directory = dirname(this.filename)
    const temporary = `${this.filename}.${randomUUID()}.tmp`
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temporary, this.filename)
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw new Error('Enterprise credentials could not be saved.')
    }
  }
}
