import { describe, expect, it } from 'vitest'
import { en, formatDesktopMessage, resolveDesktopLocale, resolveDesktopStartupLocale, zh } from '../src/locale.ts'

describe('desktop locale dictionaries', () => {
  it('ships the same key set in English and Chinese', () => {
    expect(Object.keys(zh)).toEqual(Object.keys(en))
    expect(resolveDesktopLocale('zh-Hans-CN').messages).toEqual(zh)
    expect(resolveDesktopLocale('en-US').messages).toEqual(en)
    expect(resolveDesktopLocale('fr-FR').messages).toEqual(en)
  })

  it('brands shell copy with the packaged company name', () => {
    const english = resolveDesktopLocale('en', 'Ruqinba Harness').messages
    expect(english.aboutProduct).toBe('Ruqinba Harness')
    expect(english.startupFailed).toBe('Ruqinba Harness is unavailable')
    expect(english.quitApplication).toBe('Quit Ruqinba Harness')
    const chinese = resolveDesktopLocale('zh-CN', 'Ruqinba Harness').messages
    expect(chinese.aboutMenu).toBe('关于 Ruqinba Harness')
    expect(chinese.startupFailed).toBe('Ruqinba Harness 无法使用')
    expect(resolveDesktopStartupLocale('zh', [], 'Ruqinba Harness').messages.quitTitle).toBe('退出 Ruqinba Harness？')
  })

  it('formats named values without consuming unknown placeholders', () => {
    expect(formatDesktopMessage('{name}@{version} {missing}', { name: 'plugin', version: '1.2.3' }))
      .toBe('plugin@1.2.3 {missing}')
  })

  it('prefers an explicit supported choice, then the first supported system language', () => {
    expect(resolveDesktopStartupLocale('zh', ['en-US']).id).toBe('zh-CN')
    expect(resolveDesktopStartupLocale('EN', ['zh-CN']).id).toBe('en')
    expect(resolveDesktopStartupLocale(null, ['ja-JP', 'zh-Hant', 'en-US']).id).toBe('zh-CN')
    expect(resolveDesktopStartupLocale(null, ['en-US', 'zh-CN']).id).toBe('en')
    expect(resolveDesktopStartupLocale(null, ['ja-JP']).id).toBe('en')
    expect(resolveDesktopStartupLocale(null, []).id).toBe('en')
    expect(resolveDesktopStartupLocale('ja', ['zh-CN']).id).toBe('zh-CN')
  })

})
