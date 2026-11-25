/** Resolve OS-backed credential storage before opening one-time enterprise authorization. */
export async function beginEnterpriseLoginAfterStorageReady<T>(
  storage: { readonly probeWritable: () => Promise<void> },
  beginLogin: () => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new TypeError('Keychain readiness timeout is invalid.')
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      storage.probeWritable(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error('Keychain readiness timed out.')) }, timeoutMs)
      }),
    ])
  } catch (error) {
    if (process.env.DSH_ENTERPRISE_LOGIN_DIAGNOSTICS === '1') {
      const detail = error instanceof Error && [
        'Keychain readiness timed out.', 'Keychain operation timed out.',
        'Keychain encryption is unavailable.', 'Windows secure storage encryption is unavailable.',
        'Windows secure storage operation timed out.', 'Stored session data is unavailable.',
      ].includes(error.message) ? error.message : 'unexpected Keychain error'
      process.stderr.write(`enterprise login preflight: ${detail}\n`)
    }
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  try { return await beginLogin() }
  catch (error) {
    if (process.env.DSH_ENTERPRISE_LOGIN_DIAGNOSTICS === '1') {
      const detail = error instanceof Error && [
        'enterprise welcome: Host request failed', 'enterprise welcome: Host RPC failed',
        'enterprise welcome: invalid login attempt',
      ].includes(error.message) ? error.message : 'unexpected Host error'
      process.stderr.write(`enterprise login Host: ${detail}\n`)
    }
    throw error
  }
}
