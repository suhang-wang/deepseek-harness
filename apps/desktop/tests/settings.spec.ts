import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { readDesktopSettings, writeDesktopSettings } from '../src/settings.ts'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => { vi.restoreAllMocks() })

function fixture() {
  const userData = mkdtempSync(join(tmpdir(), 'dsh-desktop-settings-'))
  onTestFinished(() => { rmSync(userData, { recursive: true, force: true }) })
  const directory = join(userData, 'desktop')
  mkdirSync(directory)
  return { userData, path: join(directory, 'settings.json') }
}

it('creates a discoverable default file on first launch without touching other preferences', async () => {
  const { userData, path } = fixture()
  rmSync(join(userData, 'desktop'), { recursive: true })
  writeFileSync(join(userData, 'keybindings.json'), 'existing shortcuts\n')
  expect(await readDesktopSettings(userData)).toEqual({
    updates: { allowTestAuthPopupWindow: false }, enterprise: { activeCompanyId: null },
  })
  expect(readFileSync(path, 'utf8')).toBe('{\n  "updates": {\n    "allowTestAuthPopupWindow": false\n  }\n}\n')
  expect(readFileSync(join(userData, 'keybindings.json'), 'utf8')).toBe('existing shortcuts\n')
})

it.each(['{}', '{"updates": {}}', '{"other": 1, "updates": {"other": true}}'])('defaults an older document without rewriting it: %s', async (raw) => {
  const { userData, path } = fixture()
  writeFileSync(path, raw)
  expect((await readDesktopSettings(userData)).updates.allowTestAuthPopupWindow).toBe(false)
  expect(readFileSync(path, 'utf8')).toBe(raw)
})

it('loads explicit opt-in and opt-out on the next read without changing an earlier process snapshot', async () => {
  const { userData, path } = fixture()
  for (const allow of [true, false]) {
    const raw = JSON.stringify({ updates: { allowTestAuthPopupWindow: allow }, custom: 'preserve' })
    writeFileSync(path, raw)
    expect((await readDesktopSettings(userData)).updates.allowTestAuthPopupWindow).toBe(allow)
    expect(readFileSync(path, 'utf8')).toBe(raw)
  }
  const previous = await readDesktopSettings(userData)
  writeFileSync(path, '{"updates":{"allowTestAuthPopupWindow":true}}')
  expect(previous.updates.allowTestAuthPopupWindow).toBe(false)
  expect((await readDesktopSettings(userData)).updates.allowTestAuthPopupWindow).toBe(true)
})

it.each(['', '{', 'null', '[]', '{"updates":null}', '{"updates":[]}',
  '{"updates":{"allowTestAuthPopupWindow":"false"}}', '{"updates":{"allowTestAuthPopupWindow":1}}',
  '{"updates":{"allowTestAuthPopupWindow":null}}'])('reports invalid settings with their path and preserves the original: %s', async (raw) => {
  const { userData, path } = fixture()
  writeFileSync(path, raw)
  expect((await readDesktopSettings(userData)).updates.allowTestAuthPopupWindow).toBe(false)
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(path), expect.any(Error))
  expect(readFileSync(path, 'utf8')).toBe(raw)
})

it('reports filesystem errors instead of replacing unreadable settings', async () => {
  const { userData, path } = fixture()
  mkdirSync(path)
  expect((await readDesktopSettings(userData)).updates.allowTestAuthPopupWindow).toBe(false)
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(path), expect.any(Error))
  expect(fs.statSync(path).isDirectory()).toBe(true)
})

it.each(['mkdir', 'writeFile'] as const)('continues with disabled popups when %s fails', async (operation) => {
  const { userData, path } = fixture()
  const failure = Object.assign(new Error('settings creation denied'), { code: 'EACCES' })
  vi.spyOn(fsp, operation).mockRejectedValue(failure)
  expect((await readDesktopSettings(userData)).updates.allowTestAuthPopupWindow).toBe(false)
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(path), expect.objectContaining({ cause: failure }))
})

it('continues with defaults even when warning output fails', async () => {
  const { userData, path } = fixture()
  writeFileSync(path, '{')
  vi.mocked(console.warn).mockImplementation(() => { throw new Error('output unavailable') })
  expect((await readDesktopSettings(userData)).updates.allowTestAuthPopupWindow).toBe(false)
  expect(readFileSync(path, 'utf8')).toBe('{')
})

it('writes the active company atomically while preserving update channels and unknown fields', async () => {
  const { userData, path } = fixture()
  writeFileSync(path, JSON.stringify({ custom: 'keep', updates: { allowTestAuthPopupWindow: true, channel: 'stable', future: 1 },
    enterprise: { future: 2 } }))
  await writeDesktopSettings(userData, {
    updates: { allowTestAuthPopupWindow: false },
    enterprise: { activeCompanyId: 'company-b' },
  })
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
    custom: 'keep',
    updates: { allowTestAuthPopupWindow: false, channel: 'stable', future: 1 },
    enterprise: { activeCompanyId: 'company-b', future: 2 },
  })
  expect((await readDesktopSettings(userData)).enterprise.activeCompanyId).toBe('company-b')
})

it.each([null, 'company-b', 'A_1-z', 'a'.repeat(128)])('loads a persisted company selection: %s', async (activeCompanyId) => {
  const { userData, path } = fixture()
  writeFileSync(path, JSON.stringify({ enterprise: { activeCompanyId } }))
  expect((await readDesktopSettings(userData)).enterprise.activeCompanyId).toBe(activeCompanyId)
  expect(console.warn).not.toHaveBeenCalled()
})

it.each(['', '../company', 'company/a', 'a'.repeat(129), 1, false])('rejects an invalid company identifier independently of popup settings: %s', async (activeCompanyId) => {
  const { userData, path } = fixture()
  const raw = JSON.stringify({ updates: { allowTestAuthPopupWindow: true }, enterprise: { activeCompanyId } })
  writeFileSync(path, raw)
  expect(await readDesktopSettings(userData)).toEqual({
    updates: { allowTestAuthPopupWindow: true }, enterprise: { activeCompanyId: null },
  })
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(path), expect.objectContaining({ problem: { kind: 'invalid', reason: 'field', field: 'activeCompanyId' } }))
  expect(readFileSync(path, 'utf8')).toBe(raw)
})

it('retains a valid company when the popup preference is invalid', async () => {
  const { userData, path } = fixture()
  writeFileSync(path, '{"updates":{"allowTestAuthPopupWindow":"bad"},"enterprise":{"activeCompanyId":"company-b"}}')
  expect(await readDesktopSettings(userData)).toEqual({ updates: { allowTestAuthPopupWindow: false }, enterprise: { activeCompanyId: 'company-b' } })
})
