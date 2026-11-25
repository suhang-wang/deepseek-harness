import { chmodSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  loginShellCandidates, mergeLoginShellEnvironment, parseLoginShellOutput, readDesktopLoginShellEnvironment,
  resolveDesktopLoginShellConfig,
} from '../src/login-shell-environment.ts'
import { COVERAGE_TEST_TIMEOUT_ENV, coverageTestTimeoutOptions } from '../../../scripts/coverage-partitions.ts'

const account = vi.hoisted(() => ({ userInfo: vi.fn() }))
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), userInfo: account.userInfo }))

const DELIMITER = '_DSH_SHELL_ENV_DELIMITER_'
const laneTestTimeoutMs = coverageTestTimeoutOptions(process.env[COVERAGE_TEST_TIMEOUT_ENV]).testTimeout ?? 5_000
const processTestTimeoutMs = Math.max(30_000, laneTestTimeoutMs)
const config = { timeoutMs: processTestTimeoutMs }
let directory: string

const activeReads = new Set<{ abort: () => void; settled: Promise<unknown> }>()

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'dsh-login-shell-')) })
afterEach(async () => {
  vi.useRealTimers()
  for (const read of activeReads) read.abort()
  await Promise.allSettled([...activeReads].map(read => read.settled))
  activeReads.clear()
  rmSync(directory, { recursive: true, force: true })
})

/** Whether `pid` has exited; Linux can keep a killed process as a zombie until its new parent reaps it. */
function exited(pid: number): boolean {
  try {
    if (process.platform === 'linux') return /^State:\s+[ZXx]\b/m.test(readFileSync(`/proc/${pid}/status`, 'utf8'))
    process.kill(pid, 0)
    return false
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return true
    throw error
  }
}

/** A stand-in login shell: `body` plays the rc files, then the dump command runs under /bin/sh. */
function shell(name: string, body: string): string {
  const path = join(directory, name)
  writeFileSync(path, `#!/bin/sh\n[ "$1" = -ilc ] || exit 64\n${body}\nexec /bin/sh -c "$2"\n`)
  chmodSync(path, 0o755)
  return path
}

function readEnvironment(
  base: NodeJS.ProcessEnv,
  config: { timeoutMs: number },
  options: NonNullable<Parameters<typeof readDesktopLoginShellEnvironment>[2]> = {},
) {
  const controller = new AbortController()
  const signal = options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal])
  const settled = readDesktopLoginShellEnvironment(base, config, { ...options, signal })
  const entry = { abort: () => controller.abort(), settled }
  activeReads.add(entry)
  void settled.then(() => activeReads.delete(entry), () => activeReads.delete(entry))
  return settled
}

function waitForChild(pidFile: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(processTestTimeoutMs)
    const watcher = watch(dirname(pidFile), { signal }, (_event, filename) => {
      if (filename?.toString() === basename(pidFile)) read()
    })
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    function cleanup(): void {
      signal.removeEventListener('abort', onAbort)
      watcher.close()
    }
    function read(): void {
      try {
        const pid = Number(readFileSync(pidFile, 'utf8'))
        if (pid > 0) { cleanup(); resolve(pid) }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { cleanup(); reject(error) }
      }
    }
    read()
  })
}

describe('resolveDesktopLoginShellConfig', () => {
  it('defaults to ten seconds and accepts an override', () => {
    expect(resolveDesktopLoginShellConfig({})).toEqual({ timeoutMs: 10_000 })
    expect(resolveDesktopLoginShellConfig({ DSH_DESKTOP_LOGIN_SHELL_TIMEOUT_MS: '2500' })).toEqual({ timeoutMs: 2_500 })
  })

  it.each(['999', '1.5', 'soon', '2147483648'])('rejects %s', (value) => {
    expect(() => resolveDesktopLoginShellConfig({ DSH_DESKTOP_LOGIN_SHELL_TIMEOUT_MS: value }))
      .toThrow('DSH_DESKTOP_LOGIN_SHELL_TIMEOUT_MS must be an integer from 1000 through 2147483647')
  })
})

describe('loginShellCandidates', () => {
  it.each([
    ['/opt/homebrew/bin/fish', ['/opt/homebrew/bin/fish', '/bin/zsh', '/bin/bash', '/bin/sh']],
    ['/bin/bash', ['/bin/bash', '/bin/zsh', '/bin/sh']],
    ['', ['/bin/zsh', '/bin/bash', '/bin/sh']],
    [null, ['/bin/zsh', '/bin/bash', '/bin/sh']],
  ])('tries account shell %j before distinct system shells', (shell, candidates) => {
    account.userInfo.mockReturnValueOnce({ shell })
    expect(loginShellCandidates()).toEqual(candidates)
  })

  it('uses only system shells when the account record is unreadable', () => {
    account.userInfo.mockImplementationOnce(() => { throw new Error('ENOENT: no such user') })
    expect(loginShellCandidates()).toEqual(['/bin/zsh', '/bin/bash', '/bin/sh'])
  })
})

describe('parseLoginShellOutput', () => {
  it('reads only the variables between the delimiters', () => {
    const output = `motd\0${DELIMITER}\0A=1\0MULTI=x\ny=z\0=ignored\0NOEQUALS\0\0${DELIMITER}\0trailing`
    expect(parseLoginShellOutput(output)).toEqual({ A: '1', MULTI: 'x\ny=z' })
  })

  it('rejects output without both delimiters', () => {
    expect(parseLoginShellOutput('A=1\0')).toBeUndefined()
    expect(parseLoginShellOutput(`\0${DELIMITER}\0A=1\0`)).toBeUndefined()
  })
})

describe('mergeLoginShellEnvironment', () => {
  it('lets shell values win except probe-session and launcher-owned names', () => {
    const base = { PATH: '/usr/bin', HOME: '/home/user', DSH_DESKTOP_DSH_DIR: '/launcher', PWD: '/' }
    const merged = mergeLoginShellEnvironment(base, {
      PATH: '/login/bin:/usr/bin', XDG_CACHE_HOME: '/cache', PWD: '/home/user', OLDPWD: '/', SHLVL: '2', _: '/usr/bin/env',
      DISABLE_AUTO_UPDATE: 'true', ZSH_TMUX_AUTOSTARTED: 'true', ZSH_TMUX_AUTOSTART: 'false',
      DSH_DESKTOP_DSH_DIR: '/rc', DSH_HOME: '/rc-home', ELECTRON_RUN_AS_NODE: '1',
    })
    expect(merged).toEqual({ PATH: '/login/bin:/usr/bin', HOME: '/home/user', DSH_DESKTOP_DSH_DIR: '/launcher', PWD: '/', XDG_CACHE_HOME: '/cache' })
    expect(base.PATH).toBe('/usr/bin')
  })
})

describe('readDesktopLoginShellEnvironment', () => {
  it('returns the inherited environment on Windows without running a shell', async () => {
    const base = { Path: 'C:\\Windows' }
    await expect(readEnvironment(base, config, { platform: 'win32', shells: [shell('unused', 'exit 1')] }))
      .resolves.toEqual({ environment: base, failures: [] })
  })

  it('records a candidate whose path cannot be passed to spawn', async () => {
    await expect(readEnvironment({}, config, { platform: 'linux', shells: ['/bin/sh\0'] })).resolves.toEqual({
      environment: {}, failures: [{ shell: '/bin/sh\0', reason: expect.stringContaining('null bytes') as string }],
    })
  })

  it('skips every candidate when already aborted', async () => {
    const base = { PATH: '/usr/bin' }
    const signal = AbortSignal.abort()
    await expect(readEnvironment(base, config, { platform: 'darwin', shells: ['/a', '/b'], signal })).resolves
      .toEqual({ environment: base, failures: [{ shell: '/a', reason: 'aborted' }] })
  })
})

// Stand-in shells are POSIX scripts; Windows returns before spawning.
describe.skipIf(process.platform === 'win32')('readDesktopLoginShellEnvironment on POSIX', { timeout: processTestTimeoutMs + 10_000 }, () => {
  it('merges variables exported by rc files, ignoring their other output', async () => {
    const login = shell('login', [
      'echo "rc banner"',
      '[ "$DISABLE_AUTO_UPDATE" = true ] && [ "$ZSH_TMUX_AUTOSTART" = false ] || exit 65',
      'read -r answer; export ANSWER="${answer:-eof}"',
      'export PATH="/login/bin:$PATH" MULTI=\'a\nb\' STARTED_IN="$PWD"',
    ].join('\n'))
    const result = await readEnvironment({ PATH: '/usr/bin:/bin', KEPT: '1' }, config, { platform: 'darwin', shells: [login] })
    expect(result.failures).toEqual([])
    expect(result.environment).toMatchObject({ PATH: '/login/bin:/usr/bin:/bin', KEPT: '1', MULTI: 'a\nb', ANSWER: 'eof' })
    expect(result.environment.STARTED_IN).toBe(homedir())
    expect(result.environment).not.toHaveProperty('DISABLE_AUTO_UPDATE')
  })

  // Five real candidates start sequentially; the per-candidate deadline does not bound their aggregate startup.
  it('records each failing candidate and uses the next one', async () => {
    const candidates = [
      join(directory, 'missing'),
      shell('exits', 'exit 3'),
      shell('signalled', 'kill -TERM $$'),
      shell('silent', 'exit 0'),
      shell('working', 'export FROM=working'),
    ]
    const result = await readEnvironment({ PATH: '/usr/bin:/bin' }, { timeoutMs: processTestTimeoutMs }, { platform: 'linux', shells: candidates })
    expect(result.environment.FROM).toBe('working')
    expect(result.failures).toEqual([
      { shell: candidates[0], reason: expect.stringContaining('ENOENT') as string },
      { shell: candidates[1], reason: 'exit 3' },
      { shell: candidates[2], reason: 'SIGTERM' },
      { shell: candidates[3], reason: 'unparsed' },
    ])
  }, Math.max(90_000, processTestTimeoutMs * 5 + 5_000))

  it('completes at the closing delimiter while an rc-started child keeps stdout open', async () => {
    const pidFile = join(directory, 'child.pid')
    const detaching = shell('detaching', `sleep 30 & echo $! > '${pidFile}'\nexport FROM=detaching`)
    const read = readEnvironment({ PATH: '/usr/bin:/bin' }, { timeoutMs: processTestTimeoutMs }, { platform: 'darwin', shells: [detaching] })
    const child = await waitForChild(pidFile)
    onTestFinished(() => { process.kill(child, 'SIGKILL') })
    const result = await read
    expect(result.failures).toEqual([])
    expect(result.environment.FROM).toBe('detaching')
    expect(exited(child)).toBe(false)
  })

  it('ends a timed-out shell with its background children and keeps the inherited environment', async () => {
    const pidFile = join(directory, 'child.pid')
    const hanging = shell('hanging', `sleep 30 & echo $! > '${pidFile}'; wait`)
    const base = { PATH: '/usr/bin:/bin' }
    const controller = new AbortController()
    vi.useFakeTimers()
    const read = readEnvironment(base, { timeoutMs: 2_000 }, { platform: 'darwin', shells: [hanging], signal: controller.signal })
    try {
      const child = await waitForChild(pidFile)
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(read).resolves.toEqual({ environment: base, failures: [{ shell: hanging, reason: 'timeout' }] })
      vi.useRealTimers()
      await vi.waitFor(() => { expect(exited(child)).toBe(true) }, { timeout: 10_000 })
    } finally {
      controller.abort()
      await read
      vi.useRealTimers()
    }
  }, processTestTimeoutMs + 15_000)

  it('ends the running shell group on abort and skips the remaining candidates', async () => {
    const pidFile = join(directory, 'child.pid')
    const hanging = shell('hanging', `sleep 30 & echo $! > '${pidFile}'; wait`)
    const base = { PATH: '/usr/bin:/bin' }
    const controller = new AbortController()
    const read = readEnvironment(base, { timeoutMs: 30_000 }, {
      platform: 'linux', shells: [hanging, shell('unused', 'export FROM=unused')], signal: controller.signal,
    })
    try {
      const child = await waitForChild(pidFile)
      controller.abort()
      await expect(read).resolves.toEqual({ environment: base, failures: [{ shell: hanging, reason: 'aborted' }] })
      await vi.waitFor(() => { expect(exited(child)).toBe(true) }, { timeout: 10_000 })
    } finally {
      controller.abort()
      await read
    }
  }, processTestTimeoutMs + 20_000)
})
