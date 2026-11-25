/** Exercise the pinned builder's uninstaller generation with Windows path limits. */
import 'app-builder-lib'
import { NsisTarget } from 'app-builder-lib/out/targets/nsis/NsisTarget.js'
import { WineVmManager } from 'app-builder-lib/out/vm/WineVm.js'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { installWindowsDirectoryInstaller } from '../scripts/windows-directory-installer.mjs'

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, rm: vi.fn(fs.rm) }
})

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(outcome: 'success' | 'missing' | 'empty' | 'sign-failure' = 'success', pathLength = 250) {
  const outDir = await mkdtemp(join(tmpdir(), 'dsh-nsis-'))
  directories.push(outDir)
  const installerPath = join(outDir, `${'a'.repeat(pathLength - outDir.length - 5)}.exe`)
  const commands = { OutFile: `"${installerPath}"` }
  const defines: Record<string, string | null> = {}
  let generatedPath = ''
  let bootstrapPath = ''
  const signed: string[] = []
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.spyOn(WineVmManager.prototype, 'exec').mockImplementation(async (file) => {
    bootstrapPath = file
    // NSIS WriteUninstaller cannot create the overlong path from the failing CI run.
    if (generatedPath.length < 260 && outcome !== 'missing') {
      await writeFile(generatedPath, outcome === 'empty' ? '' : 'MZ-uninstaller')
    }
    return ''
  })
  const target = {
    outDir,
    options: {},
    packager: {
      config: {},
      getResource: async (): Promise<string | null> => null,
      signIf: async (path: string) => {
        signed.push(path)
        if (outcome === 'sign-failure') throw new Error('signing rejected')
      },
    },
    computeFinalScript: async (script: string) => script,
    executeMakensis: async (values: { UNINSTALLER_OUT_FILE: string }, options: { OutFile: string }) => {
      generatedPath = values.UNINSTALLER_OUT_FILE
      await writeFile(options.OutFile.slice(1, -1), 'MZ-bootstrap')
    },
  }
  installWindowsDirectoryInstaller()
  const compute: unknown = Reflect.get(NsisTarget.prototype, 'computeScriptAndSignUninstaller')
  if (typeof compute !== 'function') throw new Error('Pinned NSIS uninstaller entry is missing')
  return {
    outDir, installerPath, commands, defines, signed, target,
    bootstrapPath: () => bootstrapPath,
    generatedPath: () => generatedPath,
    run: () => Promise.resolve<unknown>(Reflect.apply(compute, target, [defines, commands, installerPath, '', []])),
  }
}

it('generates and signs a short uninstaller while preserving the final installer name and commands', async () => {
  const f = await fixture()
  expect(join(f.outDir, `${basename(f.installerPath, 'exe')}__uninstaller.exe`).length).toBe(264)
  const result = await f.run()
  expect(result).toMatchObject({ isCustomScript: false })
  expect(f.commands.OutFile).toBe(`"${f.installerPath}"`)
  expect(f.defines.UNINSTALLER_OUT_FILE).toBe(f.generatedPath())
  expect(f.signed).toEqual([f.generatedPath()])
  expect(await readFile(f.generatedPath(), 'utf8')).toBe('MZ-uninstaller')
  await expect(readFile(f.bootstrapPath())).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.bootstrapPath()).not.toBe(f.installerPath)
})

it('stops when the bootstrap exits without generating an uninstaller', async () => {
  const f = await fixture('missing')
  await expect(f.run()).rejects.toThrow(/uninstaller/i)
  await expect(readFile(f.bootstrapPath())).rejects.toMatchObject({ code: 'ENOENT' })
})

it('preserves signing failure and removes temporary executables', async () => {
  const f = await fixture('sign-failure')
  await expect(f.run()).rejects.toThrow('signing rejected')
  await expect(readFile(f.bootstrapPath())).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(f.generatedPath())).rejects.toMatchObject({ code: 'ENOENT' })
})

it('preserves signing and cleanup errors while still cleaning the uninstaller', async () => {
  const f = await fixture('sign-failure')
  vi.mocked(rm).mockRejectedValueOnce(new Error('bootstrap is busy'))
  const error = await f.run().catch((failure: unknown) => failure)
  expect(error).toBeInstanceOf(AggregateError)
  if (!(error instanceof AggregateError)) throw new Error('Expected aggregated failure')
  expect(error.errors.map((failure: Error) => failure.message)).toEqual(['signing rejected', 'bootstrap is busy'])
  await expect(readFile(f.generatedPath())).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects an empty uninstaller and cleans the temporary files', async () => {
  const f = await fixture('empty')
  await expect(f.run()).rejects.toThrow('invalid uninstaller')
  await expect(readFile(f.generatedPath())).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects an overlong final installer path before compiling or executing', async () => {
  const f = await fixture('success', 260)
  await expect(f.run()).rejects.toThrow('shorter checkout path')
  expect(f.bootstrapPath()).toBe('')
  expect(f.signed).toEqual([])
})

it('preserves custom script ownership without requiring a generated uninstaller', async () => {
  const f = await fixture()
  const script = join(f.outDir, 'custom.nsi')
  await writeFile(script, '; custom installer')
  vi.spyOn(f.target.packager, 'getResource').mockResolvedValue(script)
  const result = await f.run()
  expect(result).toEqual({ script: '; custom installer', isCustomScript: true })
  expect(f.commands.OutFile).toBe(`"${f.installerPath}"`)
  expect(f.bootstrapPath()).toBe('')
  expect(f.defines).toEqual({})
})
