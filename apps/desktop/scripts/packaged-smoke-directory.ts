/** Stage Windows runtime checks outside deeply nested company build directories. */
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Check the full Windows app at a short private path, preserving packaged bytes.
 * Other platforms use the original application. Copy and check failures clean up
 * the temporary tree; simultaneous cleanup failure retains both errors.
 * @param application - Assembled application directory.
 * @param check - Runtime verification using the supplied application directory.
 * @param platform - Target platform; defaults to the build host.
 */
export async function withPackagedSmokeApplication(
  application: string,
  check: (application: string) => Promise<void>,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== 'win32') return check(application)
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-smoke-'))
  const staged = join(scratch, 'app')
  let failure: { error: unknown } | undefined
  try {
    await cp(application, staged, { recursive: true, dereference: true, force: false, errorOnExist: true })
    await check(staged)
  } catch (error) {
    failure = { error }
  }
  try {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch (error) {
    throw new AggregateError(failure === undefined ? [error] : [failure.error, error], 'Packaged runtime smoke cleanup failed')
  }
  if (failure !== undefined) throw failure.error
}
