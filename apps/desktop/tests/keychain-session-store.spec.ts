import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KeychainSessionStore } from '../src/keychain-session-store.ts'

const directories: string[] = []

async function fixture(available = true) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-keychain-session-'))
  directories.push(directory)
  const safeStorage = {
    isAsyncEncryptionAvailable: vi.fn(async () => available),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(Buffer.from(value, 'utf8').map(byte => byte ^ 0x5a))),
    decryptStringAsync: vi.fn(async (value: Buffer) => ({
      shouldReEncrypt: false,
      result: Buffer.from(value.map(byte => byte ^ 0x5a)).toString('utf8'),
    })),
  }
  return { directory, safeStorage, store: new KeychainSessionStore(directory, safeStorage, 'darwin') }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('KeychainSessionStore', () => {
  it('persists only encrypted credentials with owner-only permissions', async () => {
    const { directory, store } = await fixture()
    await store.set('refresh', 'A'.repeat(43))
    await store.set('employee-id', 'employee-1')
    const filename = join(directory, 'enterprise-session.bin')
    const contents = await readFile(filename, 'utf8')
    expect(contents).not.toContain('A'.repeat(43))
    expect(contents).not.toContain('employee-1')
    expect((await stat(filename)).mode & 0o777).toBe(0o600)
    await expect(store.get('refresh')).resolves.toBe('A'.repeat(43))
    await expect(store.get('employee-id')).resolves.toBe('employee-1')
  })

  it('serializes concurrent writes and removes individual values', async () => {
    const { store } = await fixture()
    await Promise.all([
      store.set('refresh', 'B'.repeat(43)),
      store.set('logout-capability', 'C'.repeat(43)),
    ])
    await store.delete('refresh')
    await expect(store.get('refresh')).resolves.toBeNull()
    await expect(store.get('logout-capability')).resolves.toBe('C'.repeat(43))
  })

  it('atomically separates pending revocations from the active session', async () => {
    const { store } = await fixture()
    await store.saveActiveSession({ companyId: 'company-1', refreshToken: 'B'.repeat(43), logoutCapability: 'C'.repeat(43), employeeId: 'employee-1' })
    await store.clearActiveSession()
    await store.saveActiveSession({ companyId: 'company-2', refreshToken: 'D'.repeat(43), logoutCapability: 'E'.repeat(43), employeeId: 'employee-2' })

    await expect(store.get('company-id')).resolves.toBe('company-2')
    await expect(store.get('refresh')).resolves.toBe('D'.repeat(43))
    await expect(store.get('logout-capability')).resolves.toBe('E'.repeat(43))
    await expect(store.get('revocation-queue')).resolves.toBe(JSON.stringify(['C'.repeat(43)]))
    await store.acknowledgeRevocation('C'.repeat(43))
    await expect(store.get('revocation-queue')).resolves.toBeNull()
  })

  it('atomically rotates the active refresh token when the expected token still matches', async () => {
    const { store } = await fixture()
    await store.saveActiveSession({ companyId: 'company-1', refreshToken: 'A'.repeat(43), logoutCapability: 'B'.repeat(43), employeeId: 'employee-1' })

    await expect(store.rotateRefresh('A'.repeat(43), 'C'.repeat(43))).resolves.toBe(true)

    await expect(store.get('company-id')).resolves.toBe('company-1')
    await expect(store.get('refresh')).resolves.toBe('C'.repeat(43))
    await expect(store.get('logout-capability')).resolves.toBe('B'.repeat(43))
    await expect(store.get('employee-id')).resolves.toBe('employee-1')
  })

  it('refuses refresh rotation after logout has removed the active session', async () => {
    const { store } = await fixture()
    await store.saveActiveSession({ companyId: 'company-1', refreshToken: 'A'.repeat(43), logoutCapability: 'B'.repeat(43), employeeId: 'employee-1' })
    await store.clearActiveSession()

    await expect(store.rotateRefresh('A'.repeat(43), 'C'.repeat(43))).resolves.toBe(false)

    await expect(store.get('company-id')).resolves.toBeNull()
    await expect(store.get('refresh')).resolves.toBeNull()
    await expect(store.get('logout-capability')).resolves.toBeNull()
    await expect(store.get('employee-id')).resolves.toBeNull()
    await expect(store.get('revocation-queue')).resolves.toBe(JSON.stringify(['B'.repeat(43)]))
  })

  it('refuses refresh rotation when the expected token belongs to an older session', async () => {
    const { store } = await fixture()
    await store.saveActiveSession({ companyId: 'company-1', refreshToken: 'A'.repeat(43), logoutCapability: 'B'.repeat(43), employeeId: 'employee-1' })
    await store.saveActiveSession({ companyId: 'company-2', refreshToken: 'C'.repeat(43), logoutCapability: 'D'.repeat(43), employeeId: 'employee-2' })

    await expect(store.rotateRefresh('A'.repeat(43), 'E'.repeat(43))).resolves.toBe(false)

    await expect(store.get('company-id')).resolves.toBe('company-2')
    await expect(store.get('refresh')).resolves.toBe('C'.repeat(43))
    await expect(store.get('logout-capability')).resolves.toBe('D'.repeat(43))
    await expect(store.get('employee-id')).resolves.toBe('employee-2')
    await expect(store.get('revocation-queue')).resolves.toBe(JSON.stringify(['B'.repeat(43)]))
  })

  it('rejects a revocation overflow without corrupting the encrypted record', async () => {
    const { store } = await fixture()
    const queue = Array.from({ length: 100 }, (_, index) => index.toString(2).padStart(43, 'A').replaceAll('=', 'B'))
    await store.set('revocation-queue', JSON.stringify(queue))
    await store.set('logout-capability', 'Z'.repeat(43))
    await expect(store.clearActiveSession()).rejects.toThrow(/capacity/u)
    await expect(store.get('logout-capability')).resolves.toBe('Z'.repeat(43))
    await expect(store.get('revocation-queue')).resolves.toBe(JSON.stringify(queue))
  })

  it('refuses to read or overwrite data when encryption is unavailable', async () => {
    const { store, safeStorage } = await fixture(false)
    await expect(store.probeWritable()).rejects.toThrow(/Keychain encryption is unavailable/u)
    await expect(store.set('refresh', 'A'.repeat(43))).rejects.toThrow(/Keychain encryption is unavailable/u)
    expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled()
    await expect(store.get('refresh')).rejects.toThrow(/Keychain encryption is unavailable/u)
  })

  it('probes encryption and decryption without persisting a credential', async () => {
    const { directory, store, safeStorage } = await fixture()
    await store.probeWritable()
    expect(safeStorage.encryptStringAsync).toHaveBeenCalledOnce()
    expect(safeStorage.decryptStringAsync).toHaveBeenCalledOnce()
    await expect(stat(join(directory, 'enterprise-session.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(directory)).resolves.toEqual([])
  })

  it('refuses login preflight when encrypted session storage cannot be written', async () => {
    const { directory, safeStorage } = await fixture()
    const obstruction = join(directory, 'obstruction')
    await writeFile(obstruction, 'not a directory')
    const store = new KeychainSessionStore(obstruction, safeStorage, 'darwin')
    await expect(store.probeWritable()).rejects.toThrow()
    await expect(readFile(obstruction, 'utf8')).resolves.toBe('not a directory')
  })

  it('bounds a stalled Keychain encryptor and lets a later operation proceed', async () => {
    const { directory, safeStorage } = await fixture()
    const store = new KeychainSessionStore(directory, safeStorage, 'darwin', 50)
    safeStorage.encryptStringAsync.mockImplementationOnce(() => new Promise<Awaited<ReturnType<typeof safeStorage.encryptStringAsync>>>(() => {}))
    await expect(store.saveActiveSession({ companyId: 'company-1', employeeId: 'employee-1',
      refreshToken: 'A'.repeat(43), logoutCapability: 'B'.repeat(43) })).rejects.toThrow(/credentials could not be saved/u)
    await store.saveActiveSession({ companyId: 'company-1', employeeId: 'employee-1',
      refreshToken: 'C'.repeat(43), logoutCapability: 'D'.repeat(43) })
    await expect(store.get('refresh')).resolves.toBe('C'.repeat(43))
  })

  it('is unavailable outside macOS', async () => {
    const { directory, safeStorage } = await fixture()
    const store = new KeychainSessionStore(directory, safeStorage, 'linux')
    await expect(store.get('refresh')).rejects.toThrow(/macOS Keychain/u)
  })

  it('fails closed on damaged encrypted state without replacing it', async () => {
    const { directory, store } = await fixture()
    const filename = join(directory, 'enterprise-session.bin')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(filename, 'not-base64-json', { mode: 0o600 })
    await expect(store.set('refresh', 'A'.repeat(43))).rejects.toThrow(/Stored session data is unavailable/u)
    await expect(readFile(filename, 'utf8')).resolves.toBe('not-base64-json')
  })
})
