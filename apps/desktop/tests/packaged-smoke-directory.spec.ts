/** Keep Windows runtime checks independent of the checkout's nesting depth. */
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { withPackagedSmokeApplication } from '../scripts/packaged-smoke-directory.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, cp: vi.fn(fs.cp) }
})

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-smoke-test-'))
  roots.push(root)
  const application = join(root, 'company-build', 'win-unpacked')
  await mkdir(join(application, 'resources'), { recursive: true })
  await writeFile(join(application, 'Company Harness.exe'), 'executable-bytes')
  await writeFile(join(application, 'resources', 'app.asar'), 'archive-bytes')
  await mkdir(join(application, 'resources', 'app.asar.unpacked'), { recursive: true })
  await mkdir(join(application, 'resources', 'runtime'), { recursive: true })
  await writeFile(join(application, 'resources', 'app.asar.unpacked', 'conpty.dll'), 'dll-bytes')
  await writeFile(join(application, 'resources', 'runtime', 'node.exe'), 'runtime-bytes')
  return application
}

it('checks an independent full Windows application copy and removes it after completion', async () => {
  const source = await fixture()
  let staged = ''
  await withPackagedSmokeApplication(source, async (application) => {
    staged = application
    expect(application).not.toBe(source)
    expect(await readFile(join(application, 'Company Harness.exe'), 'utf8')).toBe('executable-bytes')
    expect(await readFile(join(application, 'resources', 'app.asar'), 'utf8')).toBe('archive-bytes')
    expect(await readFile(join(application, 'resources', 'app.asar.unpacked', 'conpty.dll'), 'utf8')).toBe('dll-bytes')
    expect(await readFile(join(application, 'resources', 'runtime', 'node.exe'), 'utf8')).toBe('runtime-bytes')
    await writeFile(join(application, 'runtime-marker'), 'checked')
  }, 'win32')
  await expect(readFile(join(staged, 'Company Harness.exe'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(source, 'runtime-marker'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(source, 'Company Harness.exe'), 'utf8')).toBe('executable-bytes')
})

it('cleans a partial copy and never starts the runtime check after a copy error', async () => {
  const source = await fixture()
  let staged = ''
  vi.mocked(cp).mockImplementationOnce(async (_source, destination) => {
    if (typeof destination !== 'string') throw new Error('Expected a filesystem path')
    staged = destination
    await mkdir(destination)
    await writeFile(join(destination, 'partial'), 'partial-bytes')
    throw new Error('copy failed')
  })
  const check = vi.fn<() => Promise<void>>()
  await expect(withPackagedSmokeApplication(source, check, 'win32')).rejects.toThrow('copy failed')
  expect(check).not.toHaveBeenCalled()
  await expect(readFile(join(staged, 'partial'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('propagates a failed runtime check and cleans its temporary copy', async () => {
  const source = await fixture()
  let staged = ''
  await expect(withPackagedSmokeApplication(source, async (application) => {
    staged = application
    throw new Error('PTY failed')
  }, 'win32')).rejects.toThrow('PTY failed')
  await expect(readFile(join(staged, 'resources', 'app.asar'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps macOS checks at the original signed application location', async () => {
  const source = await fixture()
  await withPackagedSmokeApplication(source, async (application) => {
    expect(application).toBe(source)
  }, 'darwin')
})
